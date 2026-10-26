// The loaded day's futures 1-minute bars joined with the live feed's minutes (OiReplayPage's mergeLiveFuturesTicks):
// minutes are matched by their time, not their text - the server's bars carry +05:30 and the live minutes UTC, so a
// text match missed the minute the page loaded in and that candle stayed frozen until the next one began.

import { inMarketSession } from './marketSession.js'

const msOf = (p) => new Date(p.time).getTime()

/**
 * `bars` (the run's, any order) with each live minute: one the bars already hold is the same minute seen again later -
 * its open stays, high / low widen, close / OI are the live ones and the volume is the larger of the two (each saw only
 * part of that minute); a newer one is added. A live minute older than the bars' last is the bars' to say.
 */
export function mergeFuturesLive(bars, live) {
  // Market hours only (marketSession.js): no futures minute after the 15:30 close or before 09:15.
  const merged = [...bars].filter((p) => Number.isFinite(msOf(p)) && inMarketSession(msOf(p))).sort((a, b) => msOf(a) - msOf(b))
  for (const point of live ?? []) {
    const ms = msOf(point)
    if (!Number.isFinite(ms) || !inMarketSession(ms)) continue
    const last = merged.at(-1)
    const lastMs = last ? msOf(last) : null
    if (last && lastMs === ms) {
      merged[merged.length - 1] = {
        ...point,
        time: last.time,
        open: last.open,
        high: Math.max(last.high, point.high),
        low: Math.min(last.low, point.low),
        volume: Math.max(last.volume ?? 0, point.volume ?? 0),
      }
    } else if (!last || ms > lastMs) {
      merged.push(point)
    }
  }
  return merged
}
