import { repo } from './config.js'
import { FORMAT } from './vault.js'

const API = `https://api.github.com/repos/${repo.owner}/${repo.name}`
const RAW = `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.branch}/${repo.path}`
const FULL_NAME = `${repo.owner}/${repo.name}`

export class GitHubError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function headers(token, extra) {
  return {
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  }
}

async function request(url, options) {
  try {
    return await fetch(url, { cache: 'no-store', ...options })
  } catch {
    throw new GitHubError(0, "Couldn't reach GitHub. Check your connection and try again.")
  }
}

async function failure(res, doing) {
  let detail = ''
  try {
    detail = (await res.json()).message ?? ''
  } catch {}
  const limited = res.status === 429 || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')
  const message = limited
    ? 'GitHub rate limit reached. Wait a few minutes and try again.'
    : res.status === 401
      ? 'GitHub rejected the token. It may be mistyped or expired.'
      : res.status === 403
        ? `This token can't ${doing}. It needs Contents: Read and write on ${FULL_NAME}.`
        : res.status === 404
          ? `This token can't see ${FULL_NAME}. Check its repository access.`
          : `GitHub error ${res.status}${detail ? `: ${detail}` : ''}`
  return new GitHubError(res.status, message)
}

function parseVault(text) {
  const vault = JSON.parse(text)
  if (vault?.format !== FORMAT || !vault.kdf || !vault.ct) throw new GitHubError(0, 'The vault file on GitHub is not in a format this site understands.')
  return vault
}

async function readRaw() {
  const res = await request(`${RAW}?t=${Date.now()}`)
  if (res.status === 404) return null
  if (!res.ok) throw new GitHubError(res.status, "Couldn't load your vault from GitHub. Try again in a minute.")
  return { vault: parseVault(await res.text()), sha: null }
}

export async function readVault(token, { fallback = true } = {}) {
  let res
  try {
    res = await request(`${API}/contents/${repo.path}?ref=${repo.branch}`, { headers: headers(token) })
  } catch (err) {
    if (fallback) return readRaw()
    throw err
  }
  if (res.status === 404) return null
  if (res.ok) {
    const body = await res.json()
    return { vault: parseVault(atob(body.content.replace(/\s/g, ''))), sha: body.sha }
  }
  if (fallback && !token) return readRaw()
  throw await failure(res, 'read the vault')
}

async function send(token, method, path, body) {
  const res = await request(`${API}${path}`, {
    method,
    headers: headers(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  })
  if (!res.ok) throw await failure(res, 'save the vault')
  return res.json()
}

export async function writeVault(token, vault) {
  const content = JSON.stringify(vault, null, 2) + '\n'
  const tree = await send(token, 'POST', '/git/trees', { tree: [{ path: repo.path, mode: '100644', type: 'blob', content }] })
  const commit = await send(token, 'POST', '/git/commits', { message: 'Update', tree: tree.sha, parents: [] })
  await send(token, 'PATCH', `/git/refs/heads/${repo.branch}`, { sha: commit.sha, force: true })
  return commit.sha
}

export async function checkToken(token) {
  if (!/^(github_pat_|ghp_)\w{20,}$/.test(token)) {
    throw new GitHubError(0, "That doesn't look like a GitHub token. Fine-grained tokens start with github_pat_.")
  }
  const res = await request(API, { headers: headers(token) })
  if (!res.ok) throw await failure(res, 'access the repository')
  const info = await res.json()
  if (info.permissions && !info.permissions.push) {
    throw new GitHubError(403, `This token can't write to ${FULL_NAME}. It needs Contents: Read and write.`)
  }
}
