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
