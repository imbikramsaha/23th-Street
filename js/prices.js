const BASE = 'https://priceapi.moneycontrol.com/techCharts/indianMarket/stock'
const DAY = 86400
const IST = 19800
const STALE_DAYS = 10

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`Price service returned ${res.status}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

async function history(symbol, resolution, days) {
  const to = Math.floor(Date.now() / 1000)
  const url = `${BASE}/history?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${to - days * DAY}&to=${to}&countback=5&currencyCode=INR`
  const body = await getJSON(url)
  if (body?.s !== 'ok' || !body.t?.length) throw new Error(body?.errmsg || 'No price data')
  return body
}

const last = list => list[list.length - 1]
const dayOf = (sec, offset = 0) => new Date((sec + offset) * 1000).toISOString().slice(0, 10)

export async function getQuote(symbol) {
  const [daily, minute] = await Promise.all([history(symbol, '1D', 20), history(symbol, '1', 6).catch(() => null)])
  let price = last(daily.c)
  let time = last(daily.t)
  let session = dayOf(time)
  let intraday = false
  if (minute && dayOf(last(minute.t), IST) >= session) {
    time = last(minute.t)
    intraday = true
    if (!(dayOf(time, IST) === session && !isMarketOpen())) price = last(minute.c)
    session = dayOf(time, IST)
  }
  let prevClose = null
  for (let i = daily.t.length - 1; i >= 0; i--) {
    if (dayOf(daily.t[i]) < session) {
      prevClose = daily.c[i]
      break
    }
  }
  const change = prevClose == null ? null : price - prevClose
  return {
    price,
    prevClose,
    change,
    changePct: prevClose ? (change / prevClose) * 100 : null,
    time: time * 1000,
    session,
    intraday,
    stale: Date.now() / 1000 - time > STALE_DAYS * DAY,
  }
}

export async function getQuotes(symbols, onResult, concurrency = 5) {
  const queue = [...symbols]
  const worker = async () => {
    while (queue.length) {
      const symbol = queue.shift()
      try {
        onResult(symbol, await getQuote(symbol), null)
      } catch (err) {
        onResult(symbol, null, err)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
}

export async function searchStocks(query) {
  const q = query.trim()
  const bySymbol = /^[A-Za-z0-9&-]{2,20}$/.test(q)
    ? getJSON(`${BASE}/symbols?symbol=${encodeURIComponent(q.toUpperCase())}`).catch(() => null)
    : Promise.resolve(null)
  const [list, symbol] = await Promise.all([getJSON(`${BASE}/search?query=${encodeURIComponent(q)}&limit=30&type=&exchange=`), bySymbol])
  const results = (Array.isArray(list) ? list : [])
    .filter(r => (r.exchange === 'NSE' || r.exchange === 'BSE') && r.ticker && r.ticker !== '0')
    .map(r => ({ name: (r.full_name || r.description || r.symbol || r.ticker).trim(), ticker: r.ticker, exchange: r.exchange }))
  if (symbol?.ticker && !results.some(r => r.ticker === symbol.ticker)) {
    const exchange = symbol['exchange-listed'] === 'BSE' ? 'BSE' : 'NSE'
    results.unshift({ name: (symbol.description || symbol.ticker).trim(), ticker: symbol.ticker, exchange })
  }
  return results
}

export function isMarketOpen(now = Date.now()) {
  const ist = new Date(now + IST * 1000)
  const day = ist.getUTCDay()
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes()
  return day >= 1 && day <= 5 && minutes >= 555 && minutes <= 930
}
