import './vendor/argon2.min.js'

export const FORMAT = '23th-street-vault'

const KDF = { name: 'argon2id', memory: 65536, iterations: 3, parallelism: 1 }
const PAD_TO = 1024

const enc = new TextEncoder()
const dec = new TextDecoder()

export function toB64(bytes) {
  let s = ''
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b)
  return btoa(s)
}

export function fromB64(str) {
  return Uint8Array.from(atob(str), c => c.charCodeAt(0))
}

export const normalizePassphrase = text => text.trim().replace(/\s+/g, ' ')

export async function deriveKey(passphrase, kdf) {
  if (kdf.name !== 'argon2id') throw new Error('This vault uses an unknown key format.')
  const raw = await globalThis.hashwasm.argon2id({
    password: normalizePassphrase(passphrase),
    salt: fromB64(kdf.salt),
    parallelism: kdf.parallelism,
    iterations: kdf.iterations,
    memorySize: kdf.memory,
    hashLength: 32,
    outputType: 'binary',
  })
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt'])
}

export async function newKeyInfo(passphrase) {
  const kdf = { ...KDF, salt: toB64(crypto.getRandomValues(new Uint8Array(16))) }
  return { key: await deriveKey(passphrase, kdf), kdf }
}

export async function encrypt(key, value, pad = 0) {
  let bytes = enc.encode(JSON.stringify(value))
  if (pad) {
    const out = new Uint8Array(Math.ceil((bytes.length + 1) / pad) * pad).fill(32)
    out.set(bytes)
    bytes = out
  }
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes)
  return { iv: toB64(iv), ct: toB64(ct) }
}

export async function decrypt(key, { iv, ct }) {
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, key, fromB64(ct))
  return JSON.parse(dec.decode(bytes))
}

export async function seal(keyInfo, data) {
  const { iv, ct } = await encrypt(keyInfo.key, data, PAD_TO)
  return { format: FORMAT, version: 2, kdf: keyInfo.kdf, cipher: 'AES-256-GCM', iv, ct }
}

export async function exportKey(key) {
  return toB64(await crypto.subtle.exportKey('raw', key))
}

export function importKey(raw) {
  return crypto.subtle.importKey('raw', fromB64(raw), 'AES-GCM', true, ['encrypt', 'decrypt'])
}
