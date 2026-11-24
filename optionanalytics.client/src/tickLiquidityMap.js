// OPTION LIQUIDITY MAP on the Tick Flow page (asked for - "add it on order flow tick because it was related to TrueData"): the strikes up the side, time along
// the bottom, and in every strike-and-bucket cell the MONEY of the big option orders TrueData's ticks showed there, in FOUR colours - one per kind
// (`kindOf` in tickReads.js): CALLS BOUGHT and PUTS WRITTEN are the bullish pair (cool: green, blue), PUTS BOUGHT and CALLS WRITTEN the bearish pair
// (warm: red, orange). A cell takes the colour of the kind with most money in it, as deep as its total against the 95th percentile of the cells in view;
// the futures price (TrueData's near future - the index itself is not on this feed) runs across it. Only orders up to the replay clock are passed in, so a
// cut at any clock = the whole day's up to it. A read - it feeds no strategy or alert.
import { kindOf } from './tickReads.js'

export const TLM_COLORS = { ceBought: '#26a69a', peWritten: '#42a5f5', peBought: '#ef5350', ceWritten: '#ff9800' }
export const TLM_LABELS = { ceBought: 'Calls bought (bullish)', peWritten: 'Puts written (bullish)', peBought: 'Puts bought (bearish)', ceWritten: 'Calls written (bearish)' }
export const TLM_KINDS = ['ceBought', 'peWritten', 'peBought', 'ceWritten']
const PERCENTILE = 0.95

/** Strikes OUT of the money (positive = out; negative = in the money): a call above the ATM, a put below it. `atmDistance` = (strike - ATM) / step. */
export const otmSteps = (o) => (o.type === 'CE' ? o.atmDistance : -o.atmDistance)

/** A HEDGE POSITION on the map (asked for - "deep out of the money will be hedge position"): an order `steps` or more strikes out of the money - the
 *  cheap protection / tail options. */
export const isHedgePosition = (o, steps) => steps > 0 && otmSteps(o) >= steps

/** The map's own filters: `hedgeOnly` keeps ONLY the hedge positions (>= `hedgeSteps` strikes OTM), `side` 'buy' / 'sell' keeps the buyers / the sellers
 *  of the option (the order's BUY / SELL), 'both' all. */
export function filterMapOrders(orders, { hedgeOnly = false, hedgeSteps = 5, side = 'both' } = {}) {
  return (orders ?? []).filter((o) => (!hedgeOnly || isHedgePosition(o, hedgeSteps)) && (side === 'both' || (side === 'buy' ? o.side > 0 : o.side < 0)))
}

/** The strike step of a set of strikes (smallest gap), 50 when there is one. */
export function strikeGap(strikes) {
  const s = [...new Set(strikes)].sort((a, b) => a - b)
  let gap = Infinity
  for (let i = 1; i < s.length; i++) gap = Math.min(gap, s[i] - s[i - 1])
  return Number.isFinite(gap) && gap > 0 ? gap : 50
}

/**
 * The grid. `orders` - { t (ms), strike, type, read, value, lots }; `bucketMs`; `priceBars` - { time (ms), close } 1-minute bars; `maxColumns` keeps the newest.
 * Returns { rows (every strike from the highest to the lowest at the step), columns (bucket starts, oldest first), cells: Map(`${strike}|${t}`) -> { total,
 * kind, ceBought, peWritten, peBought, ceWritten, count }, scale, price: [{ t, price }] }.
 */
export function tickLiquidityGrid({ orders, bucketMs, priceBars = [], maxColumns = Infinity, step = 0 }) {
  const usable = (orders ?? []).filter((o) => kindOf(o) && Number.isFinite(o.t) && Number.isFinite(o.strike))
  if (!usable.length) return { rows: [], columns: [], cells: new Map(), scale: 0, price: [] }
  const gap = step > 0 ? step : strikeGap(usable.map((o) => o.strike))
  const lo = Math.min(...usable.map((o) => o.strike))
  const hi = Math.max(...usable.map((o) => o.strike))
  const rows = []
  for (let k = hi; k >= lo - 1e-9; k -= gap) rows.push(Math.round(k * 100) / 100)
  const bucket = (t) => Math.floor(t / bucketMs) * bucketMs
  const prices = (priceBars ?? []).filter((b) => Number.isFinite(b.time) && Number.isFinite(b.close))
  const first = Math.min(bucket(usable[0].t), prices.length ? bucket(prices[0].time) : Infinity, ...usable.map((o) => bucket(o.t)))
  const last = Math.max(...usable.map((o) => bucket(o.t)), prices.length ? bucket(prices.at(-1).time) : -Infinity)
  let columns = []
  for (let t = first; t <= last; t += bucketMs) columns.push(t)
  if (columns.length > maxColumns) columns = columns.slice(columns.length - maxColumns)
  const from = columns[0]
  const cells = new Map()
  for (const o of usable) {
    const t = bucket(o.t)
    if (t < from) continue
    const key = `${o.strike}|${t}`
    let c = cells.get(key)
    if (!c) cells.set(key, c = { total: 0, kind: null, ceBought: 0, peWritten: 0, peBought: 0, ceWritten: 0, count: 0 })
    c[kindOf(o)] += o.value
    c.total += o.value
    c.count++
  }
  const totals = []
  for (const c of cells.values()) {
    c.kind = TLM_KINDS.reduce((best, k) => (c[k] > c[best] ? k : best), TLM_KINDS[0])
    totals.push(c.total)
  }
  totals.sort((a, b) => a - b)
  const scale = totals.length ? totals[Math.min(totals.length - 1, Math.floor(totals.length * PERCENTILE))] : 0
  return { rows, columns, cells, scale, price: prices.filter((b) => b.time >= from).map((b) => ({ t: b.time, price: b.close })) }
}

/** 0 - 1 depth of a cell's money against the scale (a gentle curve so small cells still show). */
export function tickLiquidityDepth(total, scale) {
  return !(total > 0) || !(scale > 0) ? 0 : Math.min(1, total / scale) ** 0.7
}

/** The price's row position on the strike rows (0 = the top row's centre), or null outside them - the OI map's rule. */
export function priceRowPosition(price, rows) {
  if (!rows.length || !Number.isFinite(price)) return null
  const top = rows[0]
  const bottom = rows[rows.length - 1]
  const step = rows.length > 1 ? (top - bottom) / (rows.length - 1) : 1
  if (price > top + step / 2 || price < bottom - step / 2) return null
  return (top - price) / step
}
