const DAY = 86400000
const YEAR = 365 * DAY

export function todayISO(now = new Date()) {
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

export function daysSince(iso, now = Date.now()) {
  return Math.floor((now - Date.parse(iso)) / DAY)
}

export function xirr(flows) {
  if (flows.length < 2) return null
  const t0 = Math.min(...flows.map(f => f.t))
  const npv = r => flows.reduce((sum, f) => sum + f.v / Math.pow(1 + r, (f.t - t0) / YEAR), 0)
  let lo = -0.9999
  let hi = 1
  while (npv(hi) > 0 && hi < 1e6) hi *= 2
  if (npv(lo) < 0 || npv(hi) > 0) return null
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (npv(mid) > 0) lo = mid
    else hi = mid
    if (hi - lo < 1e-9) break
  }
  return (lo + hi) / 2
}

export const XIRR_MIN_DAYS = 365

export function summarizeHolding(holding, quote, now = Date.now()) {
  const lots = holding.lots
  const qty = lots.reduce((sum, l) => sum + l.qty, 0)
  const invested = lots.reduce((sum, l) => sum + l.qty * l.price, 0)
  const firstDate = lots.map(l => l.date).sort()[0] ?? null
  const days = firstDate ? daysSince(firstDate, now) : 0
  const price = quote?.price ?? null
  const current = price == null ? null : qty * price
  const pnl = current == null ? null : current - invested
  const flows = lots.map(l => ({ t: Date.parse(l.date), v: -l.qty * l.price }))
  return {
    qty,
    invested,
    avg: qty ? invested / qty : 0,
    firstDate,
    days,
    price,
    current,
    pnl,
    pnlPct: pnl == null || !invested ? null : (pnl / invested) * 100,
    dayPnl: quote?.change == null ? null : qty * quote.change,
    dayPct: quote?.changePct ?? null,
    xirr: current != null && days >= XIRR_MIN_DAYS ? xirr([...flows, { t: now, v: current }]) : null,
    flows,
  }
}

export function summarizePortfolio(holdings, quotes, now = Date.now()) {
  const rows = holdings.map(h => ({ h, s: summarizeHolding(h, quotes.get(h.ticker), now) }))
  const priced = rows.filter(r => r.s.current != null)
  const invested = rows.reduce((sum, r) => sum + r.s.invested, 0)
  const current = rows.reduce((sum, r) => sum + (r.s.current ?? r.s.invested), 0)
  const withDay = rows.filter(r => r.s.dayPnl != null)
  const dayPnl = withDay.length ? withDay.reduce((sum, r) => sum + r.s.dayPnl, 0) : null
  const prevValue = withDay.reduce((sum, r) => sum + r.s.current - r.s.dayPnl, 0)
  const firstDate = rows.map(r => r.s.firstDate).filter(Boolean).sort()[0] ?? null
  const days = firstDate ? daysSince(firstDate, now) : 0
  const missing = rows.length - priced.length
  const pricedValue = priced.reduce((sum, r) => sum + r.s.current, 0)
  const annual =
    priced.length && !missing && days >= XIRR_MIN_DAYS
      ? xirr([...priced.flatMap(r => r.s.flows), { t: now, v: pricedValue }])
      : null
  for (const r of rows) r.s.weight = current ? ((r.s.current ?? r.s.invested) / current) * 100 : null
  return {
    rows,
    invested,
    current,
    missing,
    pnl: current - invested,
    pnlPct: invested ? ((current - invested) / invested) * 100 : null,
    dayPnl,
    dayPct: dayPnl != null && prevValue ? (dayPnl / prevValue) * 100 : null,
    firstDate,
    days,
    xirr: annual,
  }
}
