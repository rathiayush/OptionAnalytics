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

/**
 * A day's per-minute delta for a chart: the exact minutes (`bars`, each `{ time, buy, sell }`) with the estimated ones
 * before the first of them in front (`backfill` - the minutes before the server started recording a live day) -
 * `[{ ms, delta, estimated }]` in time order. A replay cut at its clock still sees only minutes up to it.
 */
export function deltaMinutes(bars, backfill) {
  const minute = (m, estimated) => ({ ms: typeof m.time === 'number' ? m.time : new Date(m.time).getTime(), delta: (m.buy ?? 0) - (m.sell ?? 0), estimated })
  const exact = (bars ?? []).map((b) => minute(b, false)).filter((m) => Number.isFinite(m.ms)).sort((a, b) => a.ms - b.ms)
  const firstMs = exact.length ? exact[0].ms : Infinity
  const prior = (backfill ?? []).map((b) => minute(b, true)).filter((m) => Number.isFinite(m.ms) && m.ms < firstMs).sort((a, b) => a.ms - b.ms)
  return [...prior, ...exact]
}
