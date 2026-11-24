// BIG OPTION ORDERS on the Tick Flow page - read from TrueData's live option ticks (the server's OptionBigOrderWatch: each order is a tick's
// own quantity with the side from the quote before it, the size against the touch it hit, the option's own usual, the OI change since its tick
// before). This module only reads them: the position (long build-up / short build-up / covering / unwinding) and the bias for the index
// are OI Replay's `readOf`, the sweeps and the added-up summary its `markSweeps` / `bigTradesSummary` - the same words on both pages.
import { bigTradesSummary, markSweeps, readOf } from './bigOptionTrades.js'
// The chart's time is the IST wall clock written as seconds (shared.jsx's toChartTime - not imported: this module stays plain JS for the tests).
const IST_OFFSET_SECONDS = 19800
const toChartTime = (ms) => Math.floor(ms / 1000) + IST_OFFSET_SECONDS

export const TICK_ORDER_DEFAULTS = { minLots: 30, multiple: 3, lookback: 15 }
export const MAX_KEPT = 2000

/** A server event as the page reads it. */
export function toOrder(e) {
  const side = e.buy ? 1 : -1
  const { read, bias } = readOf(e.type === 'CE', side, e.oiChange)
  return {
    seq: e.seq, t: Date.parse(e.time), strike: e.strike, type: e.type, symbol: e.symbol, qty: e.qty, lots: e.lots, price: e.price,
    value: e.value, ratio: e.ratio, touchRatio: e.touchRatio, through: e.through, bundled: e.bundled, oiChange: e.oiChange,
    movePct: e.movePct, atmDistance: e.atmDistance, lotSize: e.lotSize || 1, side, read, bias, sweep: false,
  }
}

/** Orders kept so far plus the new ones from the server (by sequence, newest MAX_KEPT), sweeps marked again over the lot. */
export function addOrders(kept, incoming) {
  if (!incoming?.length) return kept
  const last = kept.length ? kept[kept.length - 1].seq : 0
  const fresh = incoming.filter((e) => e.seq > last).map(toOrder)
  if (!fresh.length) return kept
  const all = [...kept, ...fresh]
  return markSweeps(all.length > MAX_KEPT ? all.slice(all.length - MAX_KEPT) : all)
}

/** The orders worth showing: at least `minLots` - or, when `minQty` is given, that many UNITS (the quantity the user defines) - and, when the option has
 *  a usual of its own (ratio 0 = not yet), `multiple` x it (`multiple` 0 = no such test: the size alone decides). */
export function bigEnough(orders, { minLots = TICK_ORDER_DEFAULTS.minLots, minQty = null, multiple = TICK_ORDER_DEFAULTS.multiple } = {}) {
  const big = (o) => (minQty != null ? o.qty >= minQty : o.lots >= minLots) && (multiple <= 0 || o.ratio === 0 || o.ratio >= multiple)
  return markSweeps(orders.filter(big).map((o) => ({ ...o, sweep: false })))
}

/** A size as the user reads it: lots ("80 L") or the quantity itself ("5,200"). */
export const sizeText = (o, unit) => (unit === 'qty' ? Math.round(o.qty).toLocaleString('en-IN') : `${Math.round(o.lots).toLocaleString('en-IN')} L`)

const MARK_COLORS = { bull: '#26a69a', bear: '#ef5350', flat: '#8c8c8c' }

/**
 * Markers for a SPOT chart (lightweight-charts series markers): the big orders at the candle each fell in, one marker a candle and direction. A
 * bullish order (call bought / put written ...) is a green arrow under the candle, a bearish one a red arrow over it, an order with no direction
 * (no OI reading and no side to read) a grey dot. One order says "CE 25000 B 80 L" (B bought / S sold at the touch); several in a candle say
 * how many and how much; a sweep carries a "⚡". `chartMinutes` = the chart's candle; `unit` 'lots' | 'qty'. Sorted by time, as the chart needs.
 */
export function orderMarkers(orders, chartMinutes, unit = 'lots') {
  const size = Math.max(1, chartMinutes) * 60
  const groups = new Map()
  for (const o of orders ?? []) {
    const time = Math.floor(toChartTime(o.t) / size) * size
    const dir = o.bias > 0 ? 'bull' : o.bias < 0 ? 'bear' : 'flat'
    const key = `${time}|${dir}`
    let g = groups.get(key)
    if (!g) groups.set(key, g = { time, dir, list: [] })
    g.list.push(o)
  }
  return [...groups.values()].map(({ time, dir, list }) => {
    const sweep = list.some((o) => o.sweep) ? '⚡' : ''
    const total = list.reduce((a, o) => a + (unit === 'qty' ? o.qty : o.lots), 0)
    const amount = unit === 'qty' ? Math.round(total).toLocaleString('en-IN') : `${Math.round(total).toLocaleString('en-IN')} L`
    const text = list.length === 1
      ? `${sweep}${list[0].type} ${list[0].strike} ${list[0].side > 0 ? 'B' : 'S'} ${sizeText(list[0], unit)}`
      : `${sweep}${list.length}× ${amount}`
    return {
      time, text, color: MARK_COLORS[dir],
      position: dir === 'bull' ? 'belowBar' : dir === 'bear' ? 'aboveBar' : 'inBar',
      shape: dir === 'bull' ? 'arrowUp' : dir === 'bear' ? 'arrowDown' : 'circle',
    }
  }).sort((a, b) => a.time - b.time)
}

/** How the order hit the book, in words: past the touch (a sweep), over the whole touch (x its size), or inside it. */
export function hitText(o) {
  if (o.through) return o.touchRatio >= 1 ? `swept · ${o.touchRatio.toFixed(1)}× the touch` : 'through the touch'
  if (o.touchRatio >= 1) return `${o.touchRatio.toFixed(1)}× the touch`
  if (o.touchRatio > 0) return `${Math.round(o.touchRatio * 100)}% of the touch`
  return '—'
}

export { bigTradesSummary }
