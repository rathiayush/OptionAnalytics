// A "No SL" paper position (the trade panel's No SL box) has no stop-loss / target: it stays open until it is exited,
// and is squared off at 15:15 IST of its day - like a broker's intraday square-off - at that minute's price.

const IST_MS = 330 * 60_000
const DAY_MS = 24 * 60 * 60_000
const SQUARE_OFF_MIN = 15 * 60 + 15

/** 15:15 IST of the IST day `ms` falls in (epoch ms). */
export function paperSquareOffMs(ms) {
  return Math.floor((ms + IST_MS) / DAY_MS) * DAY_MS - IST_MS + SQUARE_OFF_MIN * 60_000
}

/**
 * The square-off of an open No SL position once the clock `atMs` reaches 15:15 of its entry day: `{ kind: 'dayEnd',
 * fillPrice, at }` (at = 15:15) - the price of the last point of `series` (the option's points, ascending, `{ time, price }`) at or
 * before 15:15, else its last known price, else its entry - or null (not a No SL position, closed, or before 15:15).
 */
export function dayEndExit(position, atMs, series) {
  if (!position?.noStop || position.status !== 'OPEN' || position.entryTime == null || atMs == null) return null
  const squareOff = paperSquareOffMs(position.entryTime)
  if (atMs < squareOff) return null
  let price = null
  for (const p of series ?? []) {
    const t = typeof p.time === 'number' ? p.time : new Date(p.time).getTime()
    if (t > squareOff) break
    if (p.price != null) price = p.price
  }
  return { kind: 'dayEnd', fillPrice: price ?? position.lastPrice ?? position.entryPrice, at: squareOff }
}

/** The reason a paper exit shows, from the kind of hit. */
export const paperExitReason = (kind) => (kind === 'sl' ? 'SL' : kind === 'trail' ? 'Trailing SL' : kind === 'dayEnd' ? 'Day end' : 'Target')

/** When an auto exit happened, for its exitTime: the minute it hit in (`hitAt`) when that is an earlier bar - a replay, or a
 *  page opened after it - else the clock: live, the second it was seen. */
export function paperExitTime(hitAt, clockMs) {
  if (clockMs == null) return hitAt ?? null
  return hitAt != null && clockMs - hitAt >= 60_000 ? hitAt : clockMs
}
