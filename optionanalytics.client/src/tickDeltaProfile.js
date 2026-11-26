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

const floorRow = (p, row) => Math.floor(p / row + 1e-9) * row

/** The profiles by futures price row of one or SEVERAL sessions (the day and the sessions before it): `sessions` = [{ orders, bars }] - `orders` the page's option
 *  orders ({ t, type, side, lots, oiChange, lotSize }), `bars` that session's futures 1-minute closes - added up row by row. `rowSize` in points. Returns
 *  { rows (high to low: price, vol, ce, pe, ceOi, peOi, net, oi, total), net, oi, total, scale, count }. `vol` = the big orders' lots traded at the row. */
export function optionProfilesOf(sessions, rowSize) {
  const row = rowSize > 0 ? rowSize : 1
  const map = new Map()
  let count = 0
  for (const { orders, bars } of sessions ?? []) {
    for (const o of orders ?? []) {
      const p = priceAt(bars, o.t)
      if (p == null || !(o.lots > 0)) continue
      const price = floorRow(p, row)
      const r = map.get(price) ?? { price, vol: 0, ce: 0, pe: 0, ceOi: 0, peOi: 0 }
      const flow = o.side * o.lots
      const oi = Number.isFinite(o.oiChange) ? o.oiChange / Math.max(1, o.lotSize || 1) : 0
      r.vol += o.lots
      if (o.type === 'CE') { r.ce += flow; r.ceOi += oi } else { r.pe += flow; r.peOi += oi }
      map.set(price, r)
      count++
    }
  }
  const rows = [...map.values()].sort((a, b) => b.price - a.price).map((r) => ({ ...r, net: r.ce - r.pe, oi: r.ceOi - r.peOi }))
  const maxOi = Math.max(0, ...rows.map((r) => Math.abs(r.oi)))
  const maxNet = Math.max(0, ...rows.map((r) => Math.abs(r.net)))
  const scale = maxNet > 0 && maxOi > 0 ? maxOi / maxNet : 1
  for (const r of rows) r.total = r.oi - r.net * scale
  const sum = (key) => rows.reduce((s, r) => s + r[key], 0)
  return { rows, net: sum('net'), oi: sum('oi'), total: sum('total'), scale, count }
}

/** One session's profiles (the first form of the card). */
export const optionProfiles = (orders, bars, rowSize) => optionProfilesOf([{ orders, bars }], rowSize)

/** Which way a profile's net reads: the flow's net and positive = bullish; the OI's and the total's negative = bullish. */
export const readOf = (key, value) => {
  if (!value) return 'neutral'
  const bullish = key === 'net' ? value > 0 : value < 0
  return bullish ? 'bullish' : 'bearish'
}

/** The futures' DELTA PROFILE of bars (the footprint's rows), one row size: per price row buy, sell, delta = buy - sell and volume, high to low, with the net.
 *  `sessions` = [{ bars, lotSize }] (the day and the sessions before it); levels are in units, the rows come back in LOTS. Rows are regrouped to `rowSize`
 *  points (floor), so a day recorded at a finer row regroups exactly. */
export function futuresRowsOf(sessions, rowSize) {
  const row = rowSize > 0 ? rowSize : 1
  const map = new Map()
  for (const { bars, lotSize } of sessions ?? []) {
    const lot = Math.max(1, lotSize || 1)
    for (const b of bars ?? []) for (const l of b.levels ?? []) {
      const price = floorRow(l.price, row)
      const r = map.get(price) ?? { price, buy: 0, sell: 0 }
      r.buy += l.buy / lot; r.sell += l.sell / lot
      map.set(price, r)
    }
  }
  const rows = [...map.values()].sort((a, b) => b.price - a.price).map((r) => ({ ...r, delta: r.buy - r.sell, vol: r.buy + r.sell }))
  return { rows, net: rows.reduce((s, r) => s + r.delta, 0), count: rows.length }
}

/** The CDV and OBV profiles of the big option orders by futures price row, in lots, of one or several sessions (`sessions` = [{ orders, bars }]). `side` 'net'
 *  (CE - PE, + bullish), 'ce' or 'pe' (that option's own). CDV = the AGGRESSOR delta (TrueData gives each order its side: bought at the ask +, sold at the bid -).
 *  OBV = each order's lots signed by whether the option's premium ROSE (+) or FELL (-) from its tick before (`movePct`; no move = 0), the On-Balance-Volume rule
 *  on the option's own ticks - so it needs no side. Returns { rows (high to low: price, vol, cdv, obv), cdv, obv, count }. A put's reading is flipped in 'net'
 *  (a put bought / a put whose premium rose is bearish). */
export function cdvObvProfilesOf(sessions, rowSize, side = 'net') {
  const row = rowSize > 0 ? rowSize : 1
  const map = new Map()
  let count = 0
  for (const { orders, bars } of sessions ?? []) {
    for (const o of orders ?? []) {
      if (side === 'ce' && o.type !== 'CE') continue
      if (side === 'pe' && o.type !== 'PE') continue
      const p = priceAt(bars, o.t)
      if (p == null || !(o.lots > 0)) continue
      const price = floorRow(p, row)
      const r = map.get(price) ?? { price, vol: 0, cdv: 0, obv: 0 }
      const dir = side === 'net' && o.type === 'PE' ? -1 : 1
      r.vol += o.lots
      r.cdv += dir * o.side * o.lots
      r.obv += dir * Math.sign(Number.isFinite(o.movePct) ? o.movePct : 0) * o.lots
      map.set(price, r)
      count++
    }
  }
  const rows = [...map.values()].sort((a, b) => b.price - a.price)
  return { rows, cdv: rows.reduce((s, r) => s + r.cdv, 0), obv: rows.reduce((s, r) => s + r.obv, 0), count }
}
export const cdvObvProfiles = (orders, bars, rowSize, side = 'net') => cdvObvProfilesOf([{ orders, bars }], rowSize, side)

/** The volume profile's POC, VAH and VAL from rows (high to low) carrying `vol`: the busiest row, and the rows around it holding `share` (70%) of the volume. */
export function profileLevels(rows, share = 0.7) {
  const list = (rows ?? []).filter((r) => r.vol > 0)
  if (!list.length) return { poc: null, vah: null, val: null }
  let pocIdx = 0
  list.forEach((r, i) => { if (r.vol > list[pocIdx].vol) pocIdx = i })
  const total = list.reduce((s, r) => s + r.vol, 0)
  let hi = pocIdx
  let lo = pocIdx
  let have = list[pocIdx].vol
  while (have < share * total && (hi > 0 || lo < list.length - 1)) {
    const up = hi > 0 ? list[hi - 1].vol : -1
    const down = lo < list.length - 1 ? list[lo + 1].vol : -1
    if (up >= down) { hi--; have += up } else { lo++; have += down }
  }
  return { poc: list[pocIdx].price, vah: list[hi].price, val: list[lo].price }
}

/** The STANDOUT rows of a delta column: the biggest buying row (B1), the second (B2), the biggest selling (S1) and second (S2), by |value| - buying is value > 0,
 *  or value < 0 when `bullishNegative` (the OI's CE - PE). { b1, b2, s1, s2 } as prices (null when there is none). */
export function standouts(rows, key, bullishNegative = false) {
  const sign = bullishNegative ? -1 : 1
  const buys = rows.filter((r) => r[key] * sign > 0).sort((a, b) => b[key] * sign - a[key] * sign)
  const sells = rows.filter((r) => r[key] * sign < 0).sort((a, b) => a[key] * sign - b[key] * sign)
  return { b1: buys[0]?.price ?? null, b2: buys[1]?.price ?? null, s1: sells[0]?.price ?? null, s2: sells[1]?.price ?? null }
}

/** The futures' DELTA PROFILE of bars (the footprint's rows, in units - the footprint chart's own column): per price row buy, sell, delta = buy - sell and volume, high to low, with the net. */
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
