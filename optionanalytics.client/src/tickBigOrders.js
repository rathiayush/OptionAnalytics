// BIG OPTION ORDERS on the Tick Flow page - read from TrueData's live option ticks (the server's OptionBigOrderWatch: each order is a tick's
// own quantity with the side from the quote before it, the size against the touch it hit, the option's own usual, the OI change since its tick
// before). This module only reads them: the position (long build-up / short build-up / covering / unwinding) and the bias for the index
// are OI Replay's `readOf`, the sweeps and the added-up summary its `markSweeps` / `bigTradesSummary` - the same words on both pages.
import { bigTradesSummary, markSweeps, readOf } from './bigOptionTrades.js'

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

/** The orders worth showing: at least `minLots` and, when the option has a usual of its own (ratio 0 = not yet), `multiple` x it. */
export function bigEnough(orders, { minLots = TICK_ORDER_DEFAULTS.minLots, multiple = TICK_ORDER_DEFAULTS.multiple } = {}) {
  return markSweeps(orders.filter((o) => o.lots >= minLots && (o.ratio === 0 || o.ratio >= multiple)).map((o) => ({ ...o, sweep: false })))
}

/** How the order hit the book, in words: past the touch (a sweep), over the whole touch (x its size), or inside it. */
export function hitText(o) {
  if (o.through) return o.touchRatio >= 1 ? `swept · ${o.touchRatio.toFixed(1)}× the touch` : 'through the touch'
  if (o.touchRatio >= 1) return `${o.touchRatio.toFixed(1)}× the touch`
  if (o.touchRatio > 0) return `${Math.round(o.touchRatio * 100)}% of the touch`
  return '—'
}

export { bigTradesSummary }
