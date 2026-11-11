// The FUTURES ORDER FLOW the Signal backtest reads (asked for - "add futures delta and cumulative delta and liquidity
// heatmap indicator in signal backtest as well"): the Order Flow page's own day (`/api/order-flow/{u}/day/{date}`) laid on
// the backtest day's minutes, each from what was known at the END of that minute -
//   delta  - each minute's aggressor buy - sell volume of the near futures (the footprint's Δ), and its volume;
//   cvd    - the cumulative delta: the running sum from the session's first minute (the Order Flow page's CVD);
//   the futures' own 1-minute OHLC (the heatmap's prices are the futures', not spot's - the basis apart);
//   liq    - the LIQUIDITY HEATMAP read as the Order Flow page reads it (`liquidityMap` - the walls that STAYED in the
//            book over the last 10 minutes, the thin zones, the book's lean near the price and its read now: absorption /
//            exhaustion at a wall, a wall broken or pulled, a vacuum, a drift), from the snapshots and completed minutes up
//            to the minute's end only.
// Where the day comes from: a day the server RECORDED live is exact (footprint and book); a day it did not is ESTIMATED
// from Dhan's 1-minute candles (bulk volume classification - no book, so no heatmap reads); a day recorded part way has
// the minutes before estimated (`backfill`). `estimated` counts the estimated minutes of the day; `book` says whether
// there was a heatmap at all. `tests/signal-backtest-flow.test.mjs`.

import { liquidityMap } from './orderFlowMath.js'
import { FETCH_ROWS } from './profileZones.js'

const MIN = 60_000
const IST_MS = 330 * MIN
const DAY = 24 * 60 * MIN
const inSession = (ms) => { const m = Math.floor((((ms + IST_MS) % DAY) + DAY) % DAY / MIN); return m >= 9 * 60 + 15 && m <= 15 * 60 + 29 }
const msOf = (v) => (typeof v === 'number' ? v : new Date(v).getTime())
const minuteOf = (ms) => Math.floor(ms / MIN) * MIN

/** How many heatmap snapshots a day is asked in when the rule reads the book: ~one every 30 s of a recorded day (the
 *  server samples the book every 2 s, ~11 000 a session) - the liquidity map's 10-minute window then holds ~20. */
export const FLOW_HEATMAP_COLUMNS = 750
/** What a rule needs of the order flow: nothing, the delta (every day has it - estimated where not recorded), or the book too. */
export const FLOW_NONE = 0
export const FLOW_DELTA = 1
export const FLOW_BOOK = 2

/** The Order Flow day asked for the backtest: no prints; with the book, the footprint and heatmap in the Order Flow page's
 *  default rows (NIFTY 1, BANKNIFTY / SENSEX 5 points - the liquidity map's rows), else one row a bar (the delta only). */
export function orderFlowUrl(u, date, need = FLOW_DELTA) {
  const book = need >= FLOW_BOOK
  return `/api/order-flow/${u}/day/${date}?rowSize=${book ? FETCH_ROWS[u] ?? 1 : 1000}&minTradeLots=100000&heatmapColumns=${book ? FLOW_HEATMAP_COLUMNS : 50}`
}

// The liquidity map's read now, as a code the conditions name (the side it is bullish / bearish for in its name).
function readCode(now) {
  if (!now?.state) return null
  const atSupport = now.level?.kind === 'support'
  switch (now.state) {
    case 'absorption': return now.level ? (atSupport ? 'absorbBid' : 'absorbAsk') : null
    case 'exhaustion': return now.level ? (atSupport ? 'exhaustBid' : 'exhaustAsk') : null
    case 'break': return now.level ? (atSupport ? 'breakBid' : 'breakAsk') : null
    case 'pulled': return now.level ? (atSupport ? 'pulledBid' : 'pulledAsk') : null
    case 'vacuum': return now.bullish == null ? null : now.bullish ? 'vacuumUp' : 'vacuumDown'
    case 'between': return now.bullish == null ? null : now.bullish ? 'driftUp' : 'driftDown'
    default: return null
  }
}
const wallOf = (w) => (w ? { price: w.price, low: w.low, high: w.high, size: w.size, lots: w.lots, trend: w.trend, strength: w.strength, ratio: w.recentRatio } : null)

/**
 * The order flow at each of the day's minutes `t` (ms, session minutes, oldest first) from the Order Flow day `body`:
 * { source ('live' recorded / 'estimated' / 'truedata'), lotSize, rowSize, book (a heatmap was there), estimated (minutes
 * estimated), delta, vol, cvd, fo, fh, fl, fc (Float64Arrays, NaN where the minute has none - the cvd carries on), est
 * (Uint8Array - the minute estimated), liq (the liquidity map's read at each minute's end, or null), codes (its read's
 * code a minute, as a Set - a timeframe's candle holds all its minutes') }. `asOfMs` - nothing
 * after it is read (the live scan's clock); every minute is read from data up to its own end either way.
 */
export function orderFlowMinutes(body, t, { asOfMs = null, book = true } = {}) {
  const n = t.length
  const lotSize = body?.meta?.lotSize > 0 ? body.meta.lotSize : 1
  const rowSize = body?.rowSize > 0 ? body.rowSize : 1
  const known = (ms) => Number.isFinite(ms) && (asOfMs == null || ms + MIN <= asOfMs)
  const estimatedDay = body?.source === 'estimated'
  // Each minute's bar - the recorded / rebuilt ones, then the estimated minutes before the recording began.
  const minutes = new Map()
  const bars = []
  for (const b of body?.bars ?? []) {
    const ms = minuteOf(msOf(b.time))
    if (!known(ms)) continue
    const bar = { time: ms, buy: b.buy ?? 0, sell: b.sell ?? 0, o: b.open, h: b.high, l: b.low, c: b.close, levels: b.levels ?? [], est: estimatedDay }
    minutes.set(ms, bar)
    if (!estimatedDay) bars.push(bar)
  }
  for (const b of body?.backfill ?? []) {
    const ms = minuteOf(msOf(b.time))
    if (known(ms) && !minutes.has(ms)) minutes.set(ms, { time: ms, buy: b.buy ?? 0, sell: b.sell ?? 0, est: true })
  }
  // The cumulative delta runs from the session's first minute - every minute of it the order flow has, spot's or not.
  const ordered = [...minutes.values()].filter((m) => inSession(m.time)).sort((a, b) => a.time - b.time)
  bars.sort((a, b) => a.time - b.time)

  const delta = new Float64Array(n).fill(NaN), vol = new Float64Array(n).fill(NaN), cvd = new Float64Array(n).fill(NaN)
  const fo = new Float64Array(n).fill(NaN), fh = new Float64Array(n).fill(NaN), fl = new Float64Array(n).fill(NaN), fc = new Float64Array(n).fill(NaN)
  const est = new Uint8Array(n)
  let k = 0, sum = 0, any = false, estimated = 0
  for (let i = 0; i < n; i++) {
    while (k < ordered.length && ordered[k].time <= t[i]) { sum += ordered[k].buy - ordered[k].sell; any = true; k++ }
    if (any) cvd[i] = sum
    const m = minutes.get(t[i])
    if (!m) continue
    delta[i] = m.buy - m.sell
    vol[i] = m.buy + m.sell
    if (m.est) { est[i] = 1; estimated++ }
    if (m.c > 0) { fo[i] = m.o; fh[i] = m.h; fl[i] = m.l; fc[i] = m.c }
  }

  // The liquidity heatmap, read at each minute's end on the snapshots of its last 10 minutes (and the 3 minutes completed
  // before it) - the Order Flow page's liquidity map. Only a recorded day has a book.
  const columns = book && !estimatedDay
    ? (body?.heatmap ?? []).map((c) => ({ t: msOf(c.time), bids: c.bids ?? [], asks: c.asks ?? [] }))
      .filter((c) => Number.isFinite(c.t) && (asOfMs == null || c.t <= asOfMs)).sort((a, b) => a.t - b.t)
    : []
  const liq = new Array(n).fill(null)
  if (columns.length) {
    const windowMs = 10 * MIN
    let lo = 0, hi = 0, j = 0
    for (let i = 0; i < n; i++) {
      if (!(fc[i] > 0)) continue
      const end = t[i] + MIN
      while (hi < columns.length && columns[hi].t <= end) hi++
      while (lo < hi && columns[lo].t < end - windowMs) lo++
      while (j < bars.length && bars[j].time + MIN <= end) j++
      if (hi - lo < 5) continue
      const map = liquidityMap({
        columns: columns.slice(lo, hi), rowSize, lotSize, price: fc[i], nowMs: end,
        minuteBars: bars.slice(Math.max(0, j - 3), j).map((b) => ({ time: b.time, buy: b.buy, sell: b.sell, levels: b.levels })),
      })
      if (!map) continue
      const thin = (side) => {
        const zones = map.zones.filter((z) => z.kind === 'low' && z.side === side)
        return zones.length ? Math.min(...zones.map((z) => Math.abs(z.distance))) : null
      }
      liq[i] = {
        code: readCode(map.now), state: map.now?.state ?? null, text: map.now?.text ?? '', lean: map.lean,
        sup: wallOf(map.support[0]), res: wallOf(map.resistance[0]), thinUp: thin('ask'), thinDown: thin('bid'),
      }
    }
  }
  return {
    source: body?.source ?? 'live', lotSize, rowSize, book: liq.some(Boolean), estimated,
    delta, vol, cvd, fo, fh, fl, fc, est, liq, codes: liq.map((x) => new Set(x?.code ? [x.code] : [])),
  }
}

/** The order flow on a timeframe's candles (`first` / `last` - each candle's first and last minute): a candle's delta and
 *  volume its minutes' sum, its CVD and liquidity read its last minute's, the futures' OHLC from its minutes; `codes` -
 *  every read a minute of the candle had (a read inside the candle is known at its close). */
export function flowView(flow, first, last) {
  if (!flow || flow.missing) return flow
  const m = first.length
  const sumOf = (src) => {
    const out = new Float64Array(m).fill(NaN)
    for (let k = 0; k < m; k++) {
      let s = 0, seen = false
      for (let i = first[k]; i <= last[k]; i++) if (Number.isFinite(src[i])) { s += src[i]; seen = true }
      if (seen) out[k] = s
    }
    return out
  }
  const fo = new Float64Array(m).fill(NaN), fh = new Float64Array(m).fill(NaN), fl = new Float64Array(m).fill(NaN), fc = new Float64Array(m).fill(NaN)
  const est = new Uint8Array(m)
  const codes = []
  for (let k = 0; k < m; k++) {
    let hi = -Infinity, lo = Infinity
    const seen = new Set()
    for (let i = first[k]; i <= last[k]; i++) {
      if (flow.fc[i] > 0) {
        if (!Number.isFinite(fo[k])) fo[k] = flow.fo[i]
        hi = Math.max(hi, flow.fh[i]); lo = Math.min(lo, flow.fl[i]); fc[k] = flow.fc[i]
      }
      if (flow.est[i]) est[k] = 1
      if (flow.liq[i]?.code) seen.add(flow.liq[i].code)
    }
    if (Number.isFinite(fc[k])) { fh[k] = hi; fl[k] = lo }
    codes.push(seen)
  }
  return {
    ...flow, delta: sumOf(flow.delta), vol: sumOf(flow.vol), cvd: Float64Array.from(last, (i) => flow.cvd[i]),
    fo, fh, fl, fc, est, liq: Array.from(last, (i) => flow.liq[i]), codes,
  }
}
