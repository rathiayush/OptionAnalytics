// Delta / cumulative delta from the 09:15 open for a live day the server only started recording
// partway through (a restart, a deploy, a late start). The server sends the minutes before that as
// `backfill` - ESTIMATED from Dhan's 1-minute candles, buy / sell per minute - and this puts them in
// front of the exact bars for DISPLAY only: the delta histogram, the cumulative-delta line, the
// footprint's running total and the header. The footprint cells, the strategy scanner and analyzeBars
// never see them, so no signal changes.
//
// Only minutes before the first exact bar are used (all of them precede it by construction), so a
// replay clock before the recording started shows nothing extra - no look-ahead.

export function withBackfill(bars, backfill, timeframeMinutes) {
  if (!bars?.length || !backfill?.length) return { bars, chartBars: bars, offset: 0, priorCount: 0 }
  const bucketMs = Math.max(1, timeframeMinutes) * 60_000
  const firstMs = bars[0].time
  const buckets = new Map()
  for (const m of backfill) {
    const ms = typeof m.time === 'number' ? m.time : new Date(m.time).getTime()
    const start = Math.floor(ms / bucketMs) * bucketMs
    if (start >= firstMs) continue
    buckets.set(start, (buckets.get(start) ?? 0) + (m.buy - m.sell))
  }
  let cvd = 0
  const prior = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([time, delta]) => {
    cvd += delta
    return { time, delta, cvd, estimated: true }
  })
  if (prior.length === 0) return { bars, chartBars: bars, offset: 0, priorCount: 0 }
  const shifted = bars.map((b) => ({ ...b, cvd: b.cvd + cvd }))
  return { bars: shifted, chartBars: [...prior, ...shifted], offset: cvd, priorCount: prior.length }
}
