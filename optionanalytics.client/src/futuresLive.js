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

// The live feed's "futuresTicks" folded into their own current MINUTE (OI Replay and the Profiles page). A tick's dayVolume is Dhan's CUMULATIVE day
// volume, so a minute's volume is its rise since the minute began: dayVolumeOpen is the cumulative
// figure at the minute's start (the previous live minute's last one, else the minute's first tick -
// which misses only the part of that first minute before the page started listening). Without
// dayVolume (an older server) volume stays null, which futuresVolumeSoFar's own sum treats as 0.
export function mergeLiveFuturesTicks(prev, ticks) {
  if (ticks.length === 0) return prev
  const next = prev.slice()
  const ordered = [...ticks].sort((a, b) => new Date(a.time) - new Date(b.time))
  for (const tick of ordered) {
    const bucketIso = new Date(Math.floor(new Date(tick.time).getTime() / 60_000) * 60_000).toISOString()
    const high = Number.isFinite(tick.high) ? tick.high : tick.price
    const low = Number.isFinite(tick.low) ? tick.low : tick.price
    const last = next[next.length - 1]
    const dayVolume = tick.dayVolume > 0 ? tick.dayVolume : null
    if (last && last.time === bucketIso) {
      const volume = dayVolume != null && last.dayVolumeOpen != null ? Math.max(0, dayVolume - last.dayVolumeOpen) : last.volume
      next[next.length - 1] = { ...last, high: Math.max(last.high, high), low: Math.min(last.low, low), close: tick.price, openInterest: tick.openInterest, volume, dayVolume: dayVolume ?? last.dayVolume }
    } else if (!last || bucketIso > last.time) {
      const dayVolumeOpen = dayVolume == null ? null : last?.dayVolume ?? dayVolume
      next.push({
        time: bucketIso, open: Number.isFinite(tick.open) ? tick.open : tick.price, high, low, close: tick.price, openInterest: tick.openInterest,
        volume: dayVolume != null ? Math.max(0, dayVolume - dayVolumeOpen) : null, dayVolume, dayVolumeOpen,
      })
    }
  }
  return next
}

/**
 * The futures OI at each candle's CLOSE - the moment its close price is from: its last minute's bar, or the latest one up
 * to `asOfMs` (the clock) in the forming candle. Read at the candle's first minute instead (as the chart's OI line and
 * regime markers did), the OI lagged the price by the candle's length less a minute - 4 minutes on a 5-minute chart.
 * `points`: the futures' 1-minute bars (ascending, stamped at the minute's start); `candleStartsMs`: each candle's start;
 * `minutes`: the candles' size. Returns each candle's OI, or null where there is none yet.
 */
export function oiAtCandleCloses(points, candleStartsMs, minutes, asOfMs = null) {
  const span = (Math.max(1, Math.round(minutes)) - 1) * 60_000
  let next = 0
  let oi = null
  return candleStartsMs.map((start) => {
    const at = Math.min(start + span, asOfMs ?? Infinity)
    while (next < (points?.length ?? 0) && msOf(points[next]) <= at) {
      if (points[next].openInterest != null) oi = points[next].openInterest
      next++
    }
    return oi
  })
}
