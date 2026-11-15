// Trailing stop-loss for an OPTION trade, in premium points - the paper trades on the OI Replay panel
// and the strategy scanner (the server applies the same rule to a live super order's stop-loss leg,
// LiveTradingService.TrailStop). Once the trade is `start` points in profit, its stop follows the best
// premium `gap` points behind; it only ever tightens and never loosens the fixed stop. BUY: profit
// when the premium rises (stop below it). SELL: profit when it falls (stop above it).

/** The trailing stop level for the best premium so far, or null (off, or not `start` in profit yet).
 *  start 0 with a gap = trail from the entry. */
export function optionTrailLevel(action, entry, best, start, gap) {
  if (!(gap > 0) || !(entry > 0) || !(best > 0)) return null
  const sell = action === 'SELL'
  const profit = sell ? entry - best : best - entry
  if (profit < (start > 0 ? start : 0)) return null
  return sell ? best + gap : best - gap
}

/** The tighter of the fixed stop and the trailing one (BUY: the higher, SELL: the lower). */
export function tighterStop(action, fixed, trailed) {
  if (trailed == null) return fixed
  if (fixed == null) return trailed
  return action === 'SELL' ? Math.min(fixed, trailed) : Math.max(fixed, trailed)
}

/** The fill of an option stop-loss `stop` hit in a bar: the stop itself - unless the bar OPENED through it (a gap: its
 *  open, the premium never traded at the stop) or, with no open known, its whole range is past it (the nearest price it
 *  traded - a BUY's high, a SELL's low). Filled at the stop, a gap's loss looked smaller than it was. */
export function gapFill(action, stop, open, high, low) {
  const known = (v) => Number.isFinite(v) && v > 0
  if (action === 'SELL') return Math.max(stop, known(open) ? open : known(low) ? low : stop)
  return Math.min(stop, known(open) ? open : known(high) ? high : stop)
}
