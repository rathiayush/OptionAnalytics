// OPTION DELTA PROFILES ON THE TICK FLOW PAGE (asked for - "delta profile of OI CE - PE and net CE - PE and then total net on true tick data"): the big option
// orders TrueData's ticks showed (the card's filters applied, live or up to the replay clock), laid on the NEAR FUTURES' price rows - TrueData has no index feed -
// at the futures' price of the minute each order came in. This page's OWN maths (nothing shared with OI Replay's delta profile or the Order Flow page).
//   NET (CE - PE)  = the option FLOW: a call bought / put sold is +, a call sold / put bought is -, in lots; net = calls' flow less puts' flow, so + = bullish.
//   OI (CE - PE)   = the option writer's view: the call OI added less the put OI added (lots) at the row; NEGATIVE = puts written = a floor = BULLISH.
//   TOTAL (OI - NET) = the OI's CE - PE less the flow's net scaled to the OI's size (the biggest |OI| row over the biggest |net| row); negative = bullish.
// Only orders that passed the server's big-order floor carry a reading, and an order's OI change is the change since that option's tick before - so these are
// the BIG orders' profiles, not every contract that traded. A read - no strategy, alert or order.
import { msOf } from './tickFlowMath.js'

/** The futures' price at `ms`: the close of the last 1-minute bar that started at or before it (the first bar's when it is earlier). null with no bars. */
export function priceAt(bars, ms) {
  if (!bars?.length) return null
  let lo = 0
  let hi = bars.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (msOf(bars[m].time) <= ms) lo = m + 1; else hi = m }
  return bars[Math.max(0, lo - 1)].close
}

/** The profiles by futures price row. `orders` = the page's option orders ({ t, type, side, lots, oiChange, lotSize }), `bars` = the futures' 1-minute closes,
 *  `rowSize` the row in points. Returns { rows (high to low: price, ce, pe, net, oi, total), net, oi, total, scale, count }. */
export function optionProfiles(orders, bars, rowSize) {
  const row = rowSize > 0 ? rowSize : 1
  const map = new Map()
  let count = 0
  for (const o of orders ?? []) {
    const p = priceAt(bars, o.t)
    if (p == null || !(o.lots > 0)) continue
    const price = Math.floor(p / row + 1e-9) * row
    const r = map.get(price) ?? { price, ce: 0, pe: 0, ceOi: 0, peOi: 0 }
    const flow = o.side * o.lots
    const oi = Number.isFinite(o.oiChange) ? o.oiChange / Math.max(1, o.lotSize || 1) : 0
    if (o.type === 'CE') { r.ce += flow; r.ceOi += oi } else { r.pe += flow; r.peOi += oi }
    map.set(price, r)
    count++
  }
  const rows = [...map.values()].sort((a, b) => b.price - a.price).map((r) => ({ ...r, net: r.ce - r.pe, oi: r.ceOi - r.peOi }))
  const maxOi = Math.max(0, ...rows.map((r) => Math.abs(r.oi)))
  const maxNet = Math.max(0, ...rows.map((r) => Math.abs(r.net)))
  const scale = maxNet > 0 && maxOi > 0 ? maxOi / maxNet : 1
  for (const r of rows) r.total = r.oi - r.net * scale
  const sum = (key) => rows.reduce((s, r) => s + r[key], 0)
  return { rows, net: sum('net'), oi: sum('oi'), total: sum('total'), scale, count }
}

/** Which way a profile's net reads: the flow's net and positive = bullish; the OI's and the total's negative = bullish. */
export const readOf = (key, value) => {
  if (!value) return 'neutral'
  const bullish = key === 'net' ? value > 0 : value < 0
  return bullish ? 'bullish' : 'bearish'
}

/** The futures' DELTA PROFILE of bars (the footprint's rows): per price row buy, sell, delta = buy - sell and volume, high to low, with the net. */
export function futuresDeltaRows(bars) {
  const map = new Map()
  for (const b of bars ?? []) for (const l of b.levels ?? []) {
    const r = map.get(l.price) ?? { price: l.price, buy: 0, sell: 0 }
    r.buy += l.buy; r.sell += l.sell
    map.set(l.price, r)
  }
  const rows = [...map.values()].sort((a, b) => b.price - a.price).map((r) => ({ ...r, delta: r.buy - r.sell, total: r.buy + r.sell }))
  return { rows, net: rows.reduce((s, r) => s + r.delta, 0) }
}

// ---- Option CDV / OBV profile and the cumulative lines (asked for - "option CDV / OBV profile, cumulative delta chart, OI CE - PE") -------------------------

/** The CDV and OBV profiles of the big option orders by futures price row, in lots. `side` 'net' (CE - PE, + bullish), 'ce' or 'pe' (that option's own).
 *  CDV = the AGGRESSOR delta (TrueData gives each order its side: bought at the ask +, sold at the bid -). OBV = each order's lots signed by whether the option's
 *  premium ROSE (+) or FELL (-) from its tick before (`movePct`; no move = 0), the On-Balance-Volume rule on the option's own ticks - so it needs no side. Returns
 *  { rows (high to low: price, cdv, obv), cdv, obv, count }. A put's reading is flipped in 'net' (a put bought / a put whose premium rose is bearish). */
export function cdvObvProfiles(orders, bars, rowSize, side = 'net') {
  const row = rowSize > 0 ? rowSize : 1
  const map = new Map()
  let count = 0
  for (const o of orders ?? []) {
    if (side === 'ce' && o.type !== 'CE') continue
    if (side === 'pe' && o.type !== 'PE') continue
    const p = priceAt(bars, o.t)
    if (p == null || !(o.lots > 0)) continue
    const price = Math.floor(p / row + 1e-9) * row
    const r = map.get(price) ?? { price, cdv: 0, obv: 0 }
    const dir = side === 'net' && o.type === 'PE' ? -1 : 1
    r.cdv += dir * o.side * o.lots
    r.obv += dir * Math.sign(Number.isFinite(o.movePct) ? o.movePct : 0) * o.lots
    map.set(price, r)
    count++
  }
  const rows = [...map.values()].sort((a, b) => b.price - a.price)
  return { rows, cdv: rows.reduce((s, r) => s + r.cdv, 0), obv: rows.reduce((s, r) => s + r.obv, 0), count }
}

/** The CUMULATIVE lines through the day, one point a futures minute (`bars` = { time, buy, sell } in units, `lotSize` the futures' lot): the futures' cumulative
 *  delta (lots), the option NET flow (calls' + puts' flow as in the profile, cumulative lots) and the OI (CE - PE) (call OI added less put OI added, cumulative lots;
 *  negative = puts written = bullish). Each point counts the orders up to the END of its minute. [{ ms, fut, net, oi }]. */
export function cumulativeSeries(orders, bars, lotSize) {
  const lot = Math.max(1, lotSize || 1)
  const list = [...(orders ?? [])].sort((a, b) => a.t - b.t)
  let k = 0
  let fut = 0
  let net = 0
  let oi = 0
  return (bars ?? []).map((b) => {
    const ms = msOf(b.time)
    fut += ((b.buy ?? 0) - (b.sell ?? 0)) / lot
    while (k < list.length && list[k].t < ms + 60_000) {
      const o = list[k++]
      const sign = o.type === 'CE' ? 1 : -1
      net += sign * o.side * (o.lots || 0)
      if (Number.isFinite(o.oiChange)) oi += sign * (o.oiChange / Math.max(1, o.lotSize || 1))
    }
    return { ms, fut, net, oi }
  })
}
