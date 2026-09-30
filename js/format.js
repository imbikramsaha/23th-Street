const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const plain = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 4 })
const clock = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })
const stamp = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })
const day = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

const ok = v => v != null && Number.isFinite(v)
const sign = v => (v > 0 ? '+' : v < 0 ? '−' : '')

export const money = v => (ok(v) ? inr.format(v) : '—')
export const signedMoney = v => (ok(v) ? sign(v) + inr.format(Math.abs(v)) : '—')
export const pct = v => (ok(v) ? `${sign(v)}${Math.abs(v).toFixed(2)}%` : '—')
export const quantity = v => (ok(v) ? plain.format(v) : '—')
export const tone = v => (!ok(v) ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '')

export const clockLabel = ms => clock.format(ms)
export const stampLabel = ms => stamp.format(ms)
export const dateLabel = iso => (iso ? day.format(new Date(iso)) : '—')

export function heldFor(iso, now = new Date()) {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-').map(Number)
  let months = (now.getFullYear() - y) * 12 + now.getMonth() + 1 - m
  if (now.getDate() < d) months--
  if (months < 1) {
    const days = Math.max(0, Math.floor((now - new Date(y, m - 1, d)) / 86400000))
    return days === 1 ? '1 day' : `${days} days`
  }
  const years = Math.floor(months / 12)
  const rest = months % 12
  return [years && `${years} yr`, rest && `${rest} mo`].filter(Boolean).join(' ')
}

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ENTITIES[c])
