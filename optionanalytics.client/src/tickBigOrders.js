// BIG OPTION ORDERS on the Tick Flow page - read from TrueData's live option ticks (the server's OptionBigOrderWatch: each order is a tick's
// own quantity with the side from the quote before it, the size against the touch it hit, the option's own usual, the OI change since its tick
// before). This module only reads them: the position (long build-up / short build-up / covering / unwinding) and the bias for the index
// are OI Replay's `readOf`, the sweeps and the added-up summary its `markSweeps` / `bigTradesSummary` - the same words on both pages.
import { bigTradesSummary, markSweeps, readOf, deltaLots, isLikelyHedge, itmSteps } from './tickReads.js'

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

/** A whole past day's events as orders, oldest first, sweeps marked - none dropped (the live list keeps the newest MAX_KEPT). */
export function ordersOfDay(events) {
  return markSweeps((events ?? []).map(toOrder).sort((a, b) => a.t - b.t || a.seq - b.seq))
}

/** The orders up to the replay clock (the second holding it counts). */
export const ordersUpTo = (orders, clockMs) => (clockMs == null ? orders : orders.filter((o) => o.t <= clockMs + 999))

/** The orders worth showing: at least `minLots` - or, when `minQty` is given, that many UNITS (the quantity the user defines) - and, when the option has
 *  a usual of its own (ratio 0 = not yet), `multiple` x it (`multiple` 0 = no such test: the size alone decides). */
export function bigEnough(orders, { minLots = TICK_ORDER_DEFAULTS.minLots, minQty = null, multiple = TICK_ORDER_DEFAULTS.multiple } = {}) {
  const big = (o) => (minQty != null ? o.qty >= minQty : o.lots >= minLots) && (multiple <= 0 || o.ratio === 0 || o.ratio >= multiple)
  return markSweeps(orders.filter(big).map((o) => ({ ...o, sweep: false })))
}

/** A size as the user reads it: lots ("80 L") or the quantity itself ("5,200"). */
export const sizeText = (o, unit) => (unit === 'qty' ? Math.round(o.qty).toLocaleString('en-IN') : `${Math.round(o.lots).toLocaleString('en-IN')} L`)

/** How the order hit the book, in words: past the touch (a sweep), over the whole touch (x its size), or inside it. */
export function hitText(o) {
  if (o.through) return o.touchRatio >= 1 ? `swept · ${o.touchRatio.toFixed(1)}× the touch` : 'through the touch'
  if (o.touchRatio >= 1) return `${o.touchRatio.toFixed(1)}× the touch`
  if (o.touchRatio > 0) return `${Math.round(o.touchRatio * 100)}% of the touch`
  return '—'
}

export { bigTradesSummary, deltaLots, isLikelyHedge, itmSteps }
