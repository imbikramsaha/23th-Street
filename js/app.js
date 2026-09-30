import { repo, minPassphraseLength, idleLockMinutes, refreshSeconds } from './config.js'
import * as vault from './vault.js'
import * as gh from './github.js'
import { getQuote, getQuotes, searchStocks, isMarketOpen } from './prices.js'
import { summarizeHolding, summarizePortfolio, todayISO, XIRR_MIN_DAYS } from './calc.js'
import { esc, money, signedMoney, pct, quantity, tone, clockLabel, stampLabel, dateLabel, heldFor } from './format.js'
import { icon } from './icons.js'
import { generatePassphrase } from './passphrase.js'

const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
const uid = () => crypto.randomUUID()

const REPO_URL = `https://github.com/${repo.owner}/${repo.name}`
const SESSION_KEY = '23th-street:session'

function storage(area) {
  return {
    get(k) {
      try {
        return JSON.parse(area().getItem(k))
      } catch {
        return null
      }
    },
    set(k, v) {
      try {
        area().setItem(k, JSON.stringify(v))
      } catch {}
    },
    del(k) {
      try {
        area().removeItem(k)
      } catch {}
    },
  }
}
const session = storage(() => sessionStorage)

const state = {
  remote: null,
  keyInfo: null,
  data: null,
  baseRev: 0,
  token: null,
  unsynced: false,
  sync: 'idle',
  syncError: '',
  quotes: new Map(),
  quoteErrors: new Map(),
  pricesAt: 0,
  loadingPrices: false,
  sort: { key: 'current', dir: -1 },
  gen: 0,
  askedForToken: false,
}

class ConflictError extends Error {}

function emptyPortfolio() {
  const now = new Date().toISOString()
  return { rev: 0, createdAt: now, updatedAt: now, holdings: [] }
}

function normalize(data) {
  return {
    ...data,
    rev: Number(data?.rev) || 0,
    holdings: (Array.isArray(data?.holdings) ? data.holdings : []).map(h => ({ ...h, lots: Array.isArray(h.lots) ? h.lots : [] })),
  }
}

function show(name) {
  for (const el of $$('.screen')) el.hidden = el.id !== `screen-${name}`
}

function busy(button, label) {
  button.dataset.label ??= button.textContent
  button.disabled = true
  button.textContent = label
  return () => {
    button.disabled = false
    button.textContent = button.dataset.label
  }
}

async function boot() {
  show('loading')
  $('#loading-text').textContent = 'Loading…'
  $('#loading-retry').hidden = true
  try {
    state.remote = await gh.readVault(null)
  } catch (err) {
    $('#loading-text').textContent = err.message
    $('#loading-retry').hidden = false
    return
  }
  if (!state.remote) return showSetup()

  const saved = session.get(SESSION_KEY)
  const kdf = state.remote.vault.kdf
  if (saved?.salt === kdf.salt) {
    try {
      const key = await vault.importKey(saved.key)
      const data = await vault.decrypt(key, state.remote.vault)
      return unlockWith({ key, kdf }, data)
    } catch {
      session.del(SESSION_KEY)
    }
  }
  showLock()
}

function showLock(note = '') {
  show('lock')
  $('#lock-note').textContent = note
  $('#lock-note').hidden = !note
  $('#lock-error').textContent = ''
  $('#lock-password').value = ''
  $('#lock-password').focus()
}

async function onLockSubmit(e) {
  e.preventDefault()
  const password = $('#lock-password').value
  if (!password) return
  const done = busy($('#lock-submit'), 'Unlocking…')
  $('#lock-error').textContent = ''
  try {
    try {
      state.remote = (await gh.readVault(null)) ?? state.remote
    } catch {}
    const kdf = state.remote.vault.kdf
    const key = await vault.deriveKey(password, kdf)
    let data
    try {
      data = await vault.decrypt(key, state.remote.vault)
    } catch {
      throw new Error("That passphrase isn't right.")
    }
    await unlockWith({ key, kdf }, data)
  } catch (err) {
    $('#lock-error').textContent = err.message
    $('#lock-password').select()
  } finally {
    done()
  }
}

async function unlockWith(keyInfo, data) {
  state.keyInfo = keyInfo
  state.data = normalize(data)
  state.baseRev = state.data.rev
  state.unsynced = false
  state.sync = 'idle'
  state.token = state.data.github?.token ?? null
  await enterApp()
}

async function enterApp() {
  await rememberSession()
  show('main')
  lastActivity = Date.now()
  render()
  armTimers()
  refreshPrices()
}

function lock(note) {
  state.gen++
  Object.assign(state, {
    keyInfo: null,
    data: null,
    token: null,
    unsynced: false,
    sync: 'idle',
    pricesAt: 0,
    loadingPrices: false,
    askedForToken: false,
  })
  state.quotes.clear()
  state.quoteErrors.clear()
  session.del(SESSION_KEY)
  disarmTimers()
  for (const d of $$('dialog')) {
    if (d.open) d.close()
    d.innerHTML = ''
  }
  $('#summary').innerHTML = ''
  $('#holdings').innerHTML = ''
  if (state.remote) showLock(note)
  else showSetup()
}

const setup = { phrase: null }

function showSetup() {
  show('setup')
  $('#setup-step-password').hidden = false
  $('#setup-step-token').hidden = true
  $('#setup-token-help').innerHTML = tokenHelp()
  $('#setup-pw-error').textContent = ''
  useSuggested()
}

async function useSuggested() {
  $('#setup-suggested').hidden = false
  $('#setup-own-field').hidden = true
  $('#setup-pw2-label').textContent = 'Type it once to confirm'
  $('#setup-pw2').value = ''
  $('#setup-pw-error').textContent = ''
  try {
    setup.phrase = await generatePassphrase()
    $('#setup-phrase').innerHTML = setup.phrase
      .split(' ')
      .map(w => `<span class="word">${esc(w)}</span>`)
      .join('')
    $('#setup-pw2').focus()
  } catch {
    useOwn()
    $('#setup-pw-error').textContent = "Couldn't load the word list, so choose your own passphrase."
  }
}

function useOwn() {
  setup.phrase = null
  $('#setup-suggested').hidden = true
  $('#setup-own-field').hidden = false
  $('#setup-pw2-label').textContent = 'Repeat passphrase'
  $('#setup-pw').value = ''
  $('#setup-pw2').value = ''
  $('#setup-pw-error').textContent = ''
  $('#setup-pw').focus()
}

async function onSetupPassword(e) {
  e.preventDefault()
  const error = $('#setup-pw-error')
  const again = vault.normalizePassphrase($('#setup-pw2').value)
  const phrase = setup.phrase ?? vault.normalizePassphrase($('#setup-pw').value)
  if (setup.phrase && again !== phrase) return (error.textContent = "That doesn't match the words above. Check the spelling and order.")
  if (!setup.phrase) {
    if (phrase.length < minPassphraseLength) return (error.textContent = `Use at least ${minPassphraseLength} characters. A few random words works well.`)
    if (again !== phrase) return (error.textContent = "The passphrases don't match.")
  }
  error.textContent = ''
  const done = busy($('#setup-pw-submit'), 'Securing…')
  state.keyInfo = await vault.newKeyInfo(phrase)
  state.data = emptyPortfolio()
  state.baseRev = 0
  done()
  $('#setup-step-password').hidden = true
  $('#setup-step-token').hidden = false
  $('#setup-token').focus()
}

async function onSetupToken(e) {
  e.preventDefault()
  const token = $('#setup-token').value.trim()
  const error = $('#setup-token-error')
  error.textContent = ''
  const done = busy($('#setup-token-submit'), 'Creating vault…')
  try {
    await gh.checkToken(token)
    useToken(token)
    await saveOnce()
    await enterApp()
    toast('Vault created. Add your first holding.', 'ok')
  } catch (err) {
    clearToken()
    error.textContent = err.message
  } finally {
    done()
  }
}

function onSetupSkip() {
  state.unsynced = true
  state.askedForToken = true
  enterApp()
  toast('Changes stay in this tab until you connect GitHub in Settings.')
}

async function rememberSession() {
  session.set(SESSION_KEY, { salt: state.keyInfo.kdf.salt, key: await vault.exportKey(state.keyInfo.key) })
}

function useToken(token) {
  state.token = token
  state.data.github = { token }
}

function clearToken() {
  state.token = null
  delete state.data.github
}

let saveChain = Promise.resolve()
let saveQueued = false

function persist() {
  state.data.updatedAt = new Date().toISOString()
  state.unsynced = true
  render()
  if (!state.token) {
    if (!state.askedForToken) {
      state.askedForToken = true
      openSettings('Connect GitHub to save your changes. Until then they only live in this tab.')
    }
    return
  }
  queueSave()
}

function queueSave() {
  if (saveQueued) return saveChain
  saveQueued = true
  saveChain = saveChain.then(() => {
    saveQueued = false
    return runSave()
  })
  return saveChain
}

async function runSave(rekey) {
  if (!state.token || !state.keyInfo) return
  const gen = state.gen
  state.sync = 'saving'
  renderSync()
  try {
    await saveOnce(rekey)
    if (gen !== state.gen) return
    state.sync = 'saved'
    state.unsynced = saveQueued
  } catch (err) {
    if (gen !== state.gen) return
    if (err instanceof ConflictError) {
      state.sync = 'saved'
      state.unsynced = false
      toast(err.message, 'warn', 8000)
    } else {
      state.sync = 'error'
      state.syncError = err.message
      if (!rekey) toast(err.message, 'bad', 8000)
    }
    if (rekey) throw err
  } finally {
    if (gen === state.gen) renderSync()
  }
}

async function saveOnce(rekey) {
  const remote = await gh.readVault(state.token, { fallback: false })
  if (remote) {
    let remoteData
    try {
      remoteData = normalize(await vault.decrypt(state.keyInfo.key, remote.vault))
    } catch {
      throw new Error('The vault on GitHub now uses a different passphrase. Lock, then unlock with the new one.')
    }
    if (remoteData.rev !== state.baseRev) {
      adoptRemote(remote, remoteData)
      throw new ConflictError('Your portfolio was changed on another device. The latest version is loaded, so please redo your last change.')
    }
  }
  const keyInfo = rekey ?? state.keyInfo
  const next = { ...state.data, rev: state.baseRev + 1 }
  const sealed = await vault.seal(keyInfo, next)
  const sha = await gh.writeVault(state.token, sealed)
  state.remote = { vault: sealed, sha }
  state.baseRev = next.rev
  state.data.rev = next.rev
  if (rekey) {
    state.keyInfo = rekey
    await rememberSession()
  }
}

function adoptRemote(remote, data) {
  state.remote = remote
  state.data = data
  state.token = data.github?.token ?? state.token
  state.baseRev = data.rev
  for (const d of ['#dlg-add', '#dlg-holding']) if ($(d).open) $(d).close()
  render()
  refreshPrices()
}

async function refreshPrices() {
  if (!state.data || state.loadingPrices) return
  const tickers = [...new Set(state.data.holdings.map(h => h.ticker))]
  if (!tickers.length) return renderPriceStatus()
  const gen = state.gen
  state.loadingPrices = true
  renderPriceStatus()
  await getQuotes(tickers, (ticker, quote, err) => {
    if (gen !== state.gen) return
    if (quote) {
      state.quotes.set(ticker, quote)
      state.quoteErrors.delete(ticker)
    } else {
      state.quoteErrors.set(ticker, err)
    }
  })
  if (gen !== state.gen) return
  state.loadingPrices = false
  state.pricesAt = Date.now()
  render()
  if ($('#dlg-holding').open && !$('#dlg-holding [data-editing]')) renderHolding()
}

async function priceOne(ticker) {
  const gen = state.gen
  try {
    const quote = await getQuote(ticker)
    if (gen !== state.gen) return
    state.quotes.set(ticker, quote)
    state.quoteErrors.delete(ticker)
  } catch (err) {
    if (gen === state.gen) state.quoteErrors.set(ticker, err)
  }
  if (gen === state.gen) render()
}

function render() {
  if (!state.data) return
  const p = summarizePortfolio(state.data.holdings, state.quotes)
  renderSummary(p)
  renderHoldings(p)
  renderPriceStatus()
  renderSync()
}

function stat(label, value, sub, { valueTone = '', subTone = '', cls = '' } = {}) {
  return `<div class="stat ${cls}">
    <div class="stat-label">${esc(label)}</div>
    <div class="stat-value ${valueTone}">${esc(value)}</div>
    <div class="stat-sub ${subTone}">${esc(sub)}</div>
  </div>`
}

function renderSummary(p) {
  const el = $('#summary')
  el.hidden = !p.rows.length
  if (!p.rows.length) return (el.innerHTML = '')
  const waiting = p.missing === p.rows.length
  const missingNote = p.missing && !waiting ? ` · ${p.missing} at cost, no price` : ''
  let xirrSub
  if (p.xirr != null) xirrSub = `Annualised since ${dateLabel(p.firstDate)}`
  else if (p.days < XIRR_MIN_DAYS) xirrSub = 'Shows once your first buy is a year old'
  else xirrSub = waiting || p.missing ? 'Needs a price for every holding' : '—'
  el.innerHTML = [
    stat('Current value', waiting ? '—' : money(p.current), `Invested ${money(p.invested)}${missingNote}`, { cls: 'stat-hero' }),
    stat('Total returns', waiting ? '—' : signedMoney(p.pnl), waiting ? 'Waiting for prices' : pct(p.pnlPct), {
      valueTone: waiting ? '' : tone(p.pnl),
      subTone: waiting ? '' : tone(p.pnl),
    }),
    stat("Today's change", signedMoney(p.dayPnl), p.dayPct == null ? 'Waiting for prices' : pct(p.dayPct), {
      valueTone: tone(p.dayPnl),
      subTone: tone(p.dayPnl),
    }),
    stat('XIRR', p.xirr == null ? '—' : pct(p.xirr * 100), xirrSub, { valueTone: tone(p.xirr) }),
  ].join('')
}

const COLUMNS = [
  { key: 'name', label: 'Company' },
  { key: 'qty', label: 'Qty' },
  { key: 'avg', label: 'Avg price' },
  { key: 'dayPct', label: 'LTP' },
  { key: 'invested', label: 'Invested' },
  { key: 'current', label: 'Current' },
  { key: 'pnlPct', label: 'Returns' },
  { key: 'xirr', label: 'XIRR' },
  { key: 'weight', label: 'Weight' },
]

function sortRows(rows) {
  const { key, dir } = state.sort
  const value = r => (key === 'name' ? r.h.name.toLowerCase() : key === 'current' ? (r.s.current ?? r.s.invested) : r.s[key])
  return [...rows].sort((a, b) => {
    const x = value(a)
    const y = value(b)
    if (x == null && y == null) return 0
    if (x == null) return 1
    if (y == null) return -1
    return (x < y ? -1 : x > y ? 1 : 0) * dir
  })
}

function priceCell(h, s) {
  const q = state.quotes.get(h.ticker)
  if (!q) {
    if (state.quoteErrors.has(h.ticker)) return '<span class="muted" title="Price unavailable">No price</span>'
    return '<span class="muted">…</span>'
  }
  const sub = q.stale ? `<div class="cell-sub muted" title="No trades recently">Last ${dateLabel(q.session)}</div>` : `<div class="cell-sub ${tone(s.dayPct)}">${pct(s.dayPct)}</div>`
  return `${money(s.price)}${sub}`
}

function xirrCell(s) {
  if (s.xirr != null) return pct(s.xirr * 100)
  const title = s.days < XIRR_MIN_DAYS ? 'Shows once this holding is a year old' : 'Needs a price'
  return `<span class="muted" title="${title}">—</span>`
}

function renderHoldings(p) {
  $('#holding-count').textContent = p.rows.length || ''
  const el = $('#holdings')
  if (!p.rows.length) {
    el.innerHTML = `<div class="empty">
      <div class="empty-icon">${icon('empty', 28)}</div>
      <h3>No holdings yet</h3>
      <p class="muted">Add the stocks you own with the dates and prices you bought them at. Returns are worked out from live prices.</p>
      <button class="btn btn-primary" type="button" data-action="add">${icon('plus')}Add holding</button>
    </div>`
    return
  }
  const rows = sortRows(p.rows)
  const { key, dir } = state.sort
  const head = COLUMNS.map(c => {
    const active = c.key === key
    const aria = active ? (dir > 0 ? 'ascending' : 'descending') : 'none'
    return `<th aria-sort="${aria}"><button type="button" data-sort="${c.key}" class="${active ? 'sorted' : ''}">${c.label}<span class="arrow">${active ? (dir > 0 ? '↑' : '↓') : ''}</span></button></th>`
  }).join('')
  const body = rows
    .map(
      ({ h, s }) => `<tr data-id="${esc(h.id)}" tabindex="0">
      <td><div class="co-name">${esc(h.name)}</div><div class="co-meta">${esc(h.ticker)} · ${esc(h.exchange)}</div></td>
      <td>${quantity(s.qty)}</td>
      <td>${money(s.avg)}</td>
      <td>${priceCell(h, s)}</td>
      <td>${money(s.invested)}</td>
      <td>${money(s.current)}</td>
      <td class="${tone(s.pnl)}">${signedMoney(s.pnl)}<div class="cell-sub">${pct(s.pnlPct)}</div></td>
      <td class="${tone(s.xirr)}">${xirrCell(s)}</td>
      <td>${s.weight == null ? '—' : `${s.weight.toFixed(1)}%`}</td>
    </tr>`,
    )
    .join('')
  const cards = rows
    .map(
      ({ h, s }) => `<li><button type="button" class="hcard" data-id="${esc(h.id)}">
      <span class="hcard-row"><span class="co-name">${esc(h.name)}</span><span class="hcard-value">${money(s.current ?? s.invested)}</span></span>
      <span class="hcard-row co-meta"><span>${esc(h.ticker)} · ${quantity(s.qty)} × ${money(s.avg)}</span><span class="${tone(s.pnl)}">${signedMoney(s.pnl)} (${pct(s.pnlPct)})</span></span>
      <span class="hcard-row co-meta"><span>LTP ${money(s.price)} <span class="${tone(s.dayPct)}">${pct(s.dayPct)}</span></span><span>${s.xirr == null ? '' : `XIRR <span class="${tone(s.xirr)}">${pct(s.xirr * 100)}</span>`}</span></span>
    </button></li>`,
    )
    .join('')
  el.innerHTML = `<div class="table-wrap holdings-wrap"><table class="holdings-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div><ul class="hcards">${cards}</ul>`
}

function renderPriceStatus() {
  const el = $('#price-status')
  const refresh = $('#btn-refresh')
  refresh.classList.toggle('spinning', state.loadingPrices)
  if (!state.data?.holdings.length) return (el.textContent = '')
  if (state.loadingPrices && !state.pricesAt) return (el.textContent = 'Fetching prices…')
  const quotes = [...state.quotes.values()].filter(q => !q.stale)
  const latest = quotes.reduce((best, q) => (q.time > (best?.time ?? 0) ? q : best), null)
  const parts = []
  if (isMarketOpen()) parts.push(`Market open · updated ${clockLabel(state.pricesAt)}`)
  else if (latest) parts.push(`Market closed · prices as of ${latest.intraday ? stampLabel(latest.time) : dateLabel(latest.session)}`)
  const failed = state.data.holdings.filter(h => state.quoteErrors.has(h.ticker)).length
  if (failed) parts.push(`${failed} price${failed > 1 ? 's' : ''} unavailable`)
  el.textContent = parts.join(' · ')
}

function renderSync() {
  const pill = $('#sync-pill')
  let label = 'Saved'
  let cls = 'ok'
  let title = `Encrypted and saved to ${repo.owner}/${repo.name}`
  if (state.sync === 'saving') [label, cls, title] = ['Saving…', 'busy', 'Saving to GitHub']
  else if (!state.token) [label, cls, title] = [state.unsynced ? 'Not saved' : 'Connect GitHub', state.unsynced ? 'bad' : 'idle', 'Connect GitHub in Settings to save changes']
  else if (state.sync === 'error') [label, cls, title] = ['Not saved · retry', 'bad', state.syncError]
  else if (state.unsynced) [label, cls] = ['Not saved', 'bad']
  pill.className = `sync-pill ${cls}`
  pill.title = title
  pill.innerHTML = `<span class="dot"></span>${esc(label)}`
}

const picker = { selected: null, results: [], active: -1, seq: 0, timer: 0 }

function lotRowHTML(lot = {}) {
  const today = todayISO()
  return `<div class="lot-row" data-lot>
    <label class="field lot-date"><span>Buy date</span><input type="date" name="date" max="${today}" value="${esc(lot.date ?? '')}"></label>
    <label class="field"><span>Quantity</span><input type="number" name="qty" min="0" step="any" inputmode="decimal" placeholder="0" value="${esc(lot.qty ?? '')}"></label>
    <label class="field"><span>Price per share (₹)</span><input type="number" name="price" min="0" step="any" inputmode="decimal" placeholder="0.00" value="${esc(lot.price ?? '')}"></label>
    <button type="button" class="icon-btn lot-remove" data-action="remove-lot" aria-label="Remove this purchase" title="Remove">${icon('close', 16)}</button>
  </div>`
}

function openAdd() {
  picker.selected = null
  picker.results = []
  picker.active = -1
  const dlg = $('#dlg-add')
  dlg.innerHTML = `<form class="dlg" id="add-form" novalidate>
    <div class="dlg-head">
      <div><h3>Add holding</h3><p class="muted small">Find the company, then enter each purchase.</p></div>
      <button type="button" class="icon-btn" data-action="close" aria-label="Close">${icon('close')}</button>
    </div>
    <div class="dlg-body">
      <div class="field"><span>Company</span><div id="add-company"></div></div>
      <div class="field">
        <span>Purchases</span>
        <div class="lots" id="add-lots">${lotRowHTML()}</div>
        <div class="lots-actions">
          <button type="button" class="btn btn-sm" data-action="add-lot">${icon('plus', 16)}Another purchase date</button>
        </div>
        <p class="hint">Bought on several dates? Add a row for each. If you only know your average price, enter it once with your total quantity and first buy date.</p>
      </div>
      <div class="add-total" id="add-total"></div>
      <p class="form-error" id="add-error" role="alert"></p>
    </div>
    <div class="dlg-foot">
      <button type="button" class="btn" data-action="close">Cancel</button>
      <button type="submit" class="btn btn-primary">Add holding</button>
    </div>
  </form>`
  renderPicker()
  updateAddTotal()
  dlg.showModal()
  $('#add-search')?.focus()
}

function renderPicker() {
  const el = $('#add-company')
  const sel = picker.selected
  if (sel) {
    const held = state.data.holdings.find(h => h.ticker === sel.ticker && h.exchange === sel.exchange)
    el.innerHTML = `<div class="picked">
        <div><div class="co-name">${esc(sel.name)}</div><div class="co-meta">${esc(sel.ticker)} · ${esc(sel.exchange)}</div></div>
        <button type="button" class="btn btn-sm" data-action="change-company">Change</button>
      </div>
      ${held ? '<p class="hint">You already hold this. These purchases will be added to it.</p>' : ''}`
    return
  }
  el.innerHTML = `<div class="search">
      ${icon('search', 16)}
      <input id="add-search" type="search" placeholder="Search e.g. Reliance, TCS, HDFC Bank" autocomplete="off" spellcheck="false"
        role="combobox" aria-expanded="false" aria-controls="add-results" aria-autocomplete="list">
    </div>
    <div id="add-results" class="suggest" role="listbox" hidden></div>`
}

function renderResults(status) {
  const box = $('#add-results')
  const input = $('#add-search')
  if (!box) return
  let html = ''
  if (status === 'loading') html = '<div class="suggest-note">Searching…</div>'
  else if (status === 'error') html = '<div class="suggest-note">Search is unavailable right now. Try again in a moment.</div>'
  else if (status === 'none') html = '<div class="suggest-note">No match on NSE or BSE. Try the company name or its NSE symbol.</div>'
  else
    html = picker.results
      .map(
        (r, i) => `<button type="button" role="option" class="suggest-item" data-index="${i}" aria-selected="${i === picker.active}">
        <span><span class="co-name">${esc(r.name)}</span><span class="co-meta">${esc(r.ticker)}</span></span>
        <span class="badge">${esc(r.exchange)}</span>
      </button>`,
      )
      .join('')
  box.innerHTML = html
  box.hidden = !html
  input?.setAttribute('aria-expanded', String(!box.hidden))
}

function onSearchInput(value) {
  clearTimeout(picker.timer)
  const q = value.trim()
  if (q.length < 2) {
    picker.results = []
    renderResults()
    return
  }
  picker.timer = setTimeout(async () => {
    const seq = ++picker.seq
    renderResults('loading')
    try {
      const results = (await searchStocks(q)).slice(0, 12)
      if (seq !== picker.seq) return
      picker.results = results
      picker.active = results.length ? 0 : -1
      renderResults(results.length ? undefined : 'none')
    } catch {
      if (seq === picker.seq) renderResults('error')
    }
  }, 250)
}

function pickResult(index) {
  const r = picker.results[index]
  if (!r) return
  picker.selected = r
  picker.seq++
  renderPicker()
  $('#add-lots [name=date]')?.focus()
}

function readLot(row) {
  return {
    date: $('[name=date]', row).value,
    qty: parseFloat($('[name=qty]', row).value),
    price: parseFloat($('[name=price]', row).value),
  }
}

const readLots = root => $$('[data-lot]', root).map(readLot)

function lotError(lot) {
  if (!lot.date || Number.isNaN(Date.parse(lot.date))) return 'Enter the date you bought it.'
  if (lot.date > todayISO()) return "The buy date can't be in the future."
  if (!(lot.qty > 0)) return 'Quantity must be more than zero.'
  if (!(lot.price > 0)) return 'Price must be more than zero.'
  return ''
}

function updateAddTotal() {
  const el = $('#add-total')
  if (!el) return
  const lots = readLots($('#add-lots')).filter(l => l.qty > 0 && l.price > 0)
  const qty = lots.reduce((s, l) => s + l.qty, 0)
  const invested = lots.reduce((s, l) => s + l.qty * l.price, 0)
  el.innerHTML = qty
    ? `<span>${quantity(qty)} shares</span><span>Avg ${money(invested / qty)}</span><span>Invested ${money(invested)}</span>`
    : ''
}

function onAddSubmit(e) {
  e.preventDefault()
  const error = $('#add-error')
  const sel = picker.selected
  if (!sel) return (error.textContent = 'Pick a company from the search results.')
  const lots = readLots($('#add-lots'))
  const problem = lots.map(lotError).find(Boolean)
  if (problem) return (error.textContent = problem)
  const newLots = lots.map(l => ({ id: uid(), ...l }))
  const existing = state.data.holdings.find(h => h.ticker === sel.ticker && h.exchange === sel.exchange)
  if (existing) existing.lots.push(...newLots)
  else state.data.holdings.push({ id: uid(), name: sel.name, ticker: sel.ticker, exchange: sel.exchange, lots: newLots, addedAt: new Date().toISOString() })
  $('#dlg-add').close()
  toast(existing ? `Added ${newLots.length > 1 ? 'purchases' : 'a purchase'} to ${sel.name}` : `Added ${sel.name}`, 'ok')
  persist()
  if (!state.quotes.has(sel.ticker)) priceOne(sel.ticker)
}

let openHoldingId = null
let editingLot = null

function openHolding(id) {
  openHoldingId = id
  editingLot = null
  renderHolding()
  $('#dlg-holding').showModal()
}

function kv(label, value, cls = '') {
  return `<div class="kv"><div class="kv-label">${esc(label)}</div><div class="kv-value ${cls}">${value}</div></div>`
}

function lotEditRow(lot) {
  return `<tr data-editing data-lot data-lot-id="${esc(lot.id ?? 'new')}">
    <td><input type="date" name="date" max="${todayISO()}" value="${esc(lot.date ?? '')}" aria-label="Buy date"></td>
    <td><input type="number" name="qty" min="0" step="any" inputmode="decimal" value="${esc(lot.qty ?? '')}" aria-label="Quantity"></td>
    <td><input type="number" name="price" min="0" step="any" inputmode="decimal" value="${esc(lot.price ?? '')}" aria-label="Price per share"></td>
    <td colspan="3" class="lot-edit-error form-error"></td>
    <td class="row-actions">
      <button type="button" class="icon-btn" data-action="save-lot" aria-label="Save purchase" title="Save">${icon('check', 16)}</button>
      <button type="button" class="icon-btn" data-action="cancel-lot" aria-label="Cancel" title="Cancel">${icon('close', 16)}</button>
    </td>
  </tr>`
}

function renderHolding() {
  const dlg = $('#dlg-holding')
  const h = state.data?.holdings.find(x => x.id === openHoldingId)
  if (!h) {
    if (dlg.open) dlg.close()
    return
  }
  const q = state.quotes.get(h.ticker)
  const s = summarizeHolding(h, q)
  const lots = [...h.lots].sort((a, b) => a.date.localeCompare(b.date))
  const rows = lots
    .map(l => {
      if (l.id === editingLot) return lotEditRow(l)
      const value = q ? l.qty * q.price : null
      const ret = q ? ((q.price - l.price) / l.price) * 100 : null
      return `<tr>
        <td>${dateLabel(l.date)}</td>
        <td>${quantity(l.qty)}</td>
        <td>${money(l.price)}</td>
        <td>${money(l.qty * l.price)}</td>
        <td>${money(value)}</td>
        <td class="${tone(ret)}">${pct(ret)}</td>
        <td class="row-actions">
          <button type="button" class="icon-btn" data-action="edit-lot" data-lot-id="${esc(l.id)}" aria-label="Edit purchase" title="Edit">${icon('edit', 16)}</button>
          <button type="button" class="icon-btn" data-action="delete-lot" data-lot-id="${esc(l.id)}" aria-label="Delete purchase" title="Delete">${icon('trash', 16)}</button>
        </td>
      </tr>`
    })
    .join('')
  const ltp = q ? ` · LTP ${money(q.price)} <span class="${tone(q.changePct)}">${pct(q.changePct)}</span>` : ''
  dlg.innerHTML = `<div class="dlg">
    <div class="dlg-head">
      <div><h3>${esc(h.name)}</h3><p class="co-meta">${esc(h.ticker)} · ${esc(h.exchange)}${ltp}</p></div>
      <button type="button" class="icon-btn" data-action="close" aria-label="Close">${icon('close')}</button>
    </div>
    <div class="dlg-body">
      <div class="kv-grid">
        ${kv('Quantity', quantity(s.qty))}
        ${kv('Avg price', money(s.avg))}
        ${kv('Invested', money(s.invested))}
        ${kv('Current value', money(s.current))}
        ${kv('Returns', `${signedMoney(s.pnl)} <span class="kv-sub">${pct(s.pnlPct)}</span>`, tone(s.pnl))}
        ${kv('XIRR', xirrCell(s), tone(s.xirr))}
        ${kv('First bought', dateLabel(s.firstDate))}
        ${kv('Held for', heldFor(s.firstDate))}
      </div>
      <div>
        <div class="section-head"><h4>Purchases</h4>
          <button type="button" class="btn btn-sm" data-action="new-lot" ${editingLot ? 'disabled' : ''}>${icon('plus', 16)}Add purchase</button>
        </div>
        <div class="table-wrap">
          <table class="lots-table">
            <thead><tr><th>Date</th><th>Qty</th><th>Price</th><th>Invested</th><th>Value now</th><th>Return</th><th></th></tr></thead>
            <tbody>${rows}${editingLot === 'new' ? lotEditRow({}) : ''}</tbody>
          </table>
        </div>
      </div>
    </div>
    <div class="dlg-foot dlg-foot-split">
      <button type="button" class="btn btn-danger" data-action="delete-holding">${icon('trash', 16)}Delete holding</button>
      <button type="button" class="btn" data-action="close">Done</button>
    </div>
  </div>`
  $('[data-editing] [name=date]', dlg)?.focus()
}

function saveLotEdit(row) {
  const h = state.data.holdings.find(x => x.id === openHoldingId)
  const lot = readLot(row)
  const problem = lotError(lot)
  if (problem) return ($('.lot-edit-error', row).textContent = problem)
  if (editingLot === 'new') h.lots.push({ id: uid(), ...lot })
  else Object.assign(h.lots.find(l => l.id === editingLot), lot)
  editingLot = null
  persist()
  renderHolding()
}

async function deleteLot(lotId) {
  const h = state.data.holdings.find(x => x.id === openHoldingId)
  if (h.lots.length === 1) return deleteHolding()
  const lot = h.lots.find(l => l.id === lotId)
  const ok = await confirmDialog({
    title: 'Delete this purchase?',
    body: `${quantity(lot.qty)} shares bought on ${dateLabel(lot.date)} at ${money(lot.price)}.`,
    action: 'Delete purchase',
  })
  if (!ok) return
  h.lots = h.lots.filter(l => l.id !== lotId)
  persist()
  renderHolding()
}

async function deleteHolding() {
  const h = state.data.holdings.find(x => x.id === openHoldingId)
  const ok = await confirmDialog({
    title: `Delete ${h.name}?`,
    body: `This removes the holding and all ${h.lots.length} of its purchase${h.lots.length > 1 ? 's' : ''}.`,
    action: 'Delete holding',
  })
  if (!ok) return
  state.data.holdings = state.data.holdings.filter(x => x.id !== h.id)
  $('#dlg-holding').close()
  toast(`Deleted ${h.name}`)
  persist()
}

const TOKEN_URL = `https://github.com/settings/personal-access-tokens/new?${new URLSearchParams({
  name: '23th Street vault',
  description: 'Lets the 23th Street site save your encrypted portfolio.',
  target_name: repo.owner,
  expires_in: 'none',
  contents: 'write',
})}`

function tokenHelp() {
  return `<ol class="steps">
    <li>Open <a href="${esc(TOKEN_URL)}" target="_blank" rel="noopener noreferrer">this pre-filled GitHub page</a>. The name and permission are already set.</li>
    <li>Under <b>Repository access</b>, choose <b>Only select repositories</b>, then pick <b>${esc(repo.name)}</b>. Don't choose All repositories.</li>
    <li>Click <b>Generate token</b>, copy it, and paste it below.</li>
  </ol>
  <p class="hint">You only do this once. The token is stored inside your encrypted vault, so every device can save with just your passphrase.</p>`
}

function secretInput(id, autocomplete) {
  return `<span class="pw-wrap">
    <input type="password" id="${id}" autocomplete="${autocomplete}" autocapitalize="none" spellcheck="false">
    <button type="button" class="pw-toggle" data-action="toggle-pw" aria-label="Show">${icon('eye', 18)}</button>
  </span>`
}

function openSettings(note = '') {
  const dlg = $('#dlg-settings')
  const tail = state.token ? state.token.slice(-4) : ''
  dlg.innerHTML = `<div class="dlg">
    <div class="dlg-head">
      <div><h3>Settings</h3></div>
      <button type="button" class="icon-btn" data-action="close" aria-label="Close">${icon('close')}</button>
    </div>
    <div class="dlg-body">
      ${note ? `<p class="notice">${esc(note)}</p>` : ''}
      <section class="set-block">
        <h4>GitHub connection</h4>
        ${
          state.token
            ? `<p class="muted small">Connected with a token ending in <code>…${esc(tail)}</code>. It's stored inside your encrypted vault, so every device can save once unlocked. Only replace it if you revoke it on GitHub.</p>`
            : `<p class="muted small">Not connected yet, so changes can't be saved.</p>${tokenHelp()}`
        }
        <form id="token-form" class="inline-form" novalidate>
          <label class="field grow"><span>${state.token ? 'New token' : 'Token'}</span>
            <input type="password" id="token-input" placeholder="github_pat_…" autocomplete="off" spellcheck="false"></label>
          <button type="submit" class="btn ${state.token ? '' : 'btn-primary'}" id="token-submit">${state.token ? 'Replace' : 'Connect'}</button>
        </form>
        <p class="form-error" id="token-error" role="alert"></p>
      </section>
      <section class="set-block">
        <h4>Change passphrase</h4>
        <form id="password-form" class="stack" novalidate>
          <input type="text" name="username" value="23th-street" autocomplete="username" class="sr-only" tabindex="-1" aria-hidden="true">
          <label class="field"><span>Current passphrase</span>${secretInput('pw-current', 'current-password')}</label>
          <div class="field">
            <label for="pw-new">New passphrase</label>
            ${secretInput('pw-new', 'new-password')}
            <div><button type="button" class="link small" data-action="suggest-passphrase">Suggest 6 random words</button></div>
          </div>
          <label class="field"><span>Repeat new passphrase</span>${secretInput('pw-again', 'new-password')}</label>
          <p class="form-error" id="pw-error" role="alert"></p>
          <div><button type="submit" class="btn" id="pw-submit">Change passphrase</button></div>
        </form>
      </section>
      <section class="set-block">
        <h4>How your data is kept</h4>
        <p class="muted small">Your holdings and the GitHub token are encrypted in your browser with AES-256-GCM before they're saved to
          <a href="${REPO_URL}/blob/${repo.branch}/${repo.path}" target="_blank" rel="noopener noreferrer">${esc(repo.name)}/${esc(repo.path)}</a>.
          The key comes from your passphrase through Argon2id, which makes every guess cost 64 MB of memory, and it never leaves your device.
          Anyone can see the file, but not what's in it. There's no reset: if the passphrase is lost, so is the data.</p>
      </section>
    </div>
  </div>`
  if (!dlg.open) dlg.showModal()
  if (!state.token) $('#token-input').focus()
}

async function onTokenSubmit(e) {
  e.preventDefault()
  const token = $('#token-input').value.trim()
  const error = $('#token-error')
  error.textContent = ''
  const done = busy($('#token-submit'), 'Checking…')
  try {
    await gh.checkToken(token)
    useToken(token)
    done()
    $('#dlg-settings').close()
    toast('GitHub connected. Every device can now save with your passphrase.', 'ok', 6000)
    persist()
  } catch (err) {
    done()
    error.textContent = err.message
  }
}

async function onSuggestPassphrase() {
  try {
    const phrase = await generatePassphrase()
    const input = $('#pw-new')
    input.value = phrase
    input.type = 'text'
    $('#pw-again').value = ''
    $('#pw-error').textContent = 'Write these words down, then type them into Repeat to confirm.'
    $('#pw-again').focus()
  } catch {
    $('#pw-error').textContent = "Couldn't load the word list. Try again in a moment."
  }
}

async function onPasswordSubmit(e) {
  e.preventDefault()
  const current = $('#pw-current').value
  const next = vault.normalizePassphrase($('#pw-new').value)
  const again = vault.normalizePassphrase($('#pw-again').value)
  const error = $('#pw-error')
  error.textContent = ''
  if (!state.token) return (error.textContent = 'Connect GitHub first, so the re-encrypted vault can be saved.')
  if (next.length < minPassphraseLength) return (error.textContent = `Use at least ${minPassphraseLength} characters.`)
  if (next !== again) return (error.textContent = "The new passphrases don't match.")
  const done = busy($('#pw-submit'), 'Re-encrypting…')
  try {
    const check = await vault.deriveKey(current, state.keyInfo.kdf)
    if ((await vault.exportKey(check)) !== (await vault.exportKey(state.keyInfo.key))) throw new Error('Current passphrase is wrong.')
    const rekey = await vault.newKeyInfo(next)
    const job = saveChain.then(() => runSave(rekey))
    saveChain = job.catch(() => {})
    await job
    done()
    $('#dlg-settings').close()
    toast('Passphrase changed. Use the new one on every device from now on.', 'ok', 6000)
  } catch (err) {
    done()
    error.textContent = err.message
  }
}

function confirmDialog({ title, body, action }) {
  const dlg = $('#dlg-confirm')
  dlg.innerHTML = `<form class="dlg" method="dialog">
    <div class="dlg-head"><h3>${esc(title)}</h3></div>
    <div class="dlg-body"><p class="muted">${esc(body)}</p></div>
    <div class="dlg-foot">
      <button class="btn" value="cancel">Cancel</button>
      <button class="btn btn-danger-solid" value="ok">${esc(action)}</button>
    </div>
  </form>`
  dlg.returnValue = ''
  dlg.showModal()
  $('[value=cancel]', dlg).focus()
  return new Promise(resolve => dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true }))
}

function toast(message, kind = '', ms = 4000) {
  const el = document.createElement('div')
  el.className = `toast ${kind}`
  el.textContent = message
  const box = $('#toasts')
  box.append(el)
  while (box.children.length > 2) box.firstElementChild.remove()
  setTimeout(() => {
    el.classList.add('leaving')
    setTimeout(() => el.remove(), 250)
  }, ms)
}

let timers = []
let lastActivity = Date.now()

function armTimers() {
  disarmTimers()
  timers.push(
    setInterval(() => {
      if (document.visibilityState === 'visible' && isMarketOpen()) refreshPrices()
    }, refreshSeconds * 1000),
  )
  timers.push(setInterval(checkIdle, 30000))
}

function disarmTimers() {
  timers.forEach(clearInterval)
  timers = []
}

function checkIdle() {
  if (!state.data || state.unsynced || state.sync === 'saving') return
  if (Date.now() - lastActivity > idleLockMinutes * 60000) lock(`Locked after ${idleLockMinutes} minutes without activity.`)
}

function bindEvents() {
  for (const el of $$('[data-icon]')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon))

  $('#loading-retry').addEventListener('click', boot)
  $('#lock-form').addEventListener('submit', onLockSubmit)
  $('#setup-step-password').addEventListener('submit', onSetupPassword)
  $('#setup-step-token').addEventListener('submit', onSetupToken)
  $('#setup-skip').addEventListener('click', onSetupSkip)
  $('#setup-regen').addEventListener('click', useSuggested)
  $('#setup-own').addEventListener('click', useOwn)
  $('#setup-use-suggested').addEventListener('click', useSuggested)
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-action=toggle-pw]')
    if (!btn) return
    e.preventDefault()
    const input = $('input', btn.parentElement)
    const hidden = input.type === 'password'
    input.type = hidden ? 'text' : 'password'
    btn.setAttribute('aria-label', hidden ? 'Hide' : 'Show')
    btn.innerHTML = icon(hidden ? 'eyeOff' : 'eye', 18)
    input.focus()
  })
  $('#setup-back').addEventListener('click', showSetup)

  $('#btn-add').addEventListener('click', openAdd)
  $('#btn-refresh').addEventListener('click', refreshPrices)
  $('#btn-settings').addEventListener('click', () => openSettings())
  $('#btn-lock').addEventListener('click', () => {
    if (state.unsynced && !window.confirm('You have changes that are not saved to GitHub. Lock anyway and lose them?')) return
    lock()
  })
  $('#sync-pill').addEventListener('click', () => {
    if (!state.token) openSettings()
    else if (state.sync === 'error' || state.unsynced) queueSave()
  })

  const main = $('#screen-main')
  main.addEventListener('click', e => {
    const sort = e.target.closest('[data-sort]')
    if (sort) {
      const key = sort.dataset.sort
      state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : key === 'name' ? 1 : -1 }
      return render()
    }
    if (e.target.closest('[data-action=add]')) return openAdd()
    const row = e.target.closest('[data-id]')
    if (row) openHolding(row.dataset.id)
  })
  main.addEventListener('keydown', e => {
    const row = e.target.closest('tr[data-id]')
    if (row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      openHolding(row.dataset.id)
    }
  })

  for (const dlg of $$('dialog')) {
    dlg.addEventListener('click', e => {
      if (e.target === dlg) return dlg.close()
      if (e.target.closest('[data-action=close]')) dlg.close()
    })
  }

  const add = $('#dlg-add')
  add.addEventListener('submit', onAddSubmit)
  add.addEventListener('input', e => {
    if (e.target.id === 'add-search') onSearchInput(e.target.value)
    else updateAddTotal()
  })
  add.addEventListener('keydown', e => {
    if (e.target.id !== 'add-search') return
    const n = picker.results.length
    if (e.key === 'ArrowDown' && n) picker.active = (picker.active + 1) % n
    else if (e.key === 'ArrowUp' && n) picker.active = (picker.active - 1 + n) % n
    else if (e.key === 'Enter') {
      e.preventDefault()
      return pickResult(picker.active)
    } else return
    e.preventDefault()
    renderResults()
    $(`#add-results [data-index="${picker.active}"]`)?.scrollIntoView({ block: 'nearest' })
  })
  add.addEventListener('click', e => {
    const item = e.target.closest('.suggest-item')
    if (item) return pickResult(Number(item.dataset.index))
    const action = e.target.closest('[data-action]')?.dataset.action
    if (action === 'change-company') {
      picker.selected = null
      renderPicker()
      $('#add-search').focus()
    } else if (action === 'add-lot') {
      $('#add-lots').insertAdjacentHTML('beforeend', lotRowHTML())
      $('#add-lots [data-lot]:last-child [name=date]').focus()
    } else if (action === 'remove-lot') {
      const rows = $$('#add-lots [data-lot]')
      if (rows.length > 1) e.target.closest('[data-lot]').remove()
      else for (const input of $$('input', rows[0])) input.value = ''
      updateAddTotal()
    }
  })

  const detail = $('#dlg-holding')
  detail.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]')
    if (!btn) return
    const action = btn.dataset.action
    if (action === 'edit-lot') {
      editingLot = btn.dataset.lotId
      renderHolding()
    } else if (action === 'new-lot') {
      editingLot = 'new'
      renderHolding()
    } else if (action === 'cancel-lot') {
      editingLot = null
      renderHolding()
    } else if (action === 'save-lot') saveLotEdit(btn.closest('tr'))
    else if (action === 'delete-lot') deleteLot(btn.dataset.lotId)
    else if (action === 'delete-holding') deleteHolding()
  })
  detail.addEventListener('keydown', e => {
    const row = e.target.closest('[data-editing]')
    if (!row) return
    if (e.key === 'Enter') {
      e.preventDefault()
      saveLotEdit(row)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      editingLot = null
      renderHolding()
    }
  })

  const settings = $('#dlg-settings')
  settings.addEventListener('submit', e => {
    if (e.target.id === 'token-form') onTokenSubmit(e)
    else if (e.target.id === 'password-form') onPasswordSubmit(e)
  })
  settings.addEventListener('click', e => {
    if (e.target.closest('[data-action=suggest-passphrase]')) onSuggestPassphrase()
  })

  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, () => (lastActivity = Date.now()), { passive: true, capture: true })
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !state.data) return
    checkIdle()
    if (state.data && Date.now() - state.pricesAt > refreshSeconds * 1000) refreshPrices()
  })
  window.addEventListener('beforeunload', e => {
    if (state.unsynced || state.sync === 'saving') {
      e.preventDefault()
      e.returnValue = ''
    }
  })
}

bindEvents()
boot()
