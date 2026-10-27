// Every open paper position on the trade panel is squared off at 15:15 IST of its day - like a broker's intraday
// square-off (a live super order is INTRADAY) - at that minute's price. A "No SL" one (the panel's No SL box) has no
// stop-loss / target, so that is its only exit; one with levels is closed by them first (paperStops.js).

const IST_MS = 330 * 60_000
const DAY_MS = 24 * 60 * 60_000
const SQUARE_OFF_MIN = 15 * 60 + 15

/** 15:15 IST of the IST day `ms` falls in (epoch ms). */
export function paperSquareOffMs(ms) {
  return Math.floor((ms + IST_MS) / DAY_MS) * DAY_MS - IST_MS + SQUARE_OFF_MIN * 60_000
}

/**
 * The square-off of an open position once the clock `atMs` reaches 15:15 of its entry day: `{ kind: 'dayEnd', fillPrice }` -
 * the price of the last point of `series` (the option's points, ascending, `{ time, price }`) at or before 15:15, else its
 * last known price, else its entry - or null (closed, or before 15:15).
 */
export function squareOffExit(position, atMs, series) {
  if (position?.status !== 'OPEN' || position.entryTime == null || atMs == null) return null
  const squareOff = paperSquareOffMs(position.entryTime)
  if (atMs < squareOff) return null
  let price = null
  for (const p of series ?? []) {
    const t = typeof p.time === 'number' ? p.time : new Date(p.time).getTime()
    if (t > squareOff) break
    if (p.price != null) price = p.price
  }
  return { kind: 'dayEnd', fillPrice: price ?? position.lastPrice ?? position.entryPrice }
}

/** The same for an open No SL position only (null for any other). */
export function dayEndExit(position, atMs, series) {
  return position?.noStop ? squareOffExit(position, atMs, series) : null
}

/** The reason a paper exit shows, from the kind of hit. */
export const paperExitReason = (kind) => (kind === 'sl' ? 'SL' : kind === 'trail' ? 'Trailing SL' : kind === 'dayEnd' ? 'Day end' : 'Target')
