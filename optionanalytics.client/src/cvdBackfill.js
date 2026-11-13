// Delta / cumulative delta from the 09:15 open for a live day the server only started recording
// partway through (a restart, a deploy, a late start). The server sends the minutes before that as
// `backfill` - ESTIMATED from Dhan's 1-minute candles, buy / sell per minute - and this puts them in
// front of the exact bars for DISPLAY only: the delta histogram, the cumulative-delta line, the
// footprint's running total and the header. The footprint cells, the strategy scanner and analyzeBars
// never see them, so no signal changes.
//
// Only minutes before the first exact MINUTE are used (all of them precede it by construction), so a
// replay clock before the recording started shows nothing extra - no look-ahead. `firstMinuteMs` is that minute (the
// first exact minute bar's time; default the first bar's): on a 3 / 5 / 15-minute timeframe the recording can start
// part way into a candle (10:02 in the 10:00 - 10:05 one) - the estimated 10:00 and 10:01 are then counted in the
// cumulative delta (they were dropped: the delta from the open missed them) and in that candle's delta on the chart,
// which is drawn as estimated; its footprint bar keeps its own exact delta.

export function withBackfill(bars, backfill, timeframeMinutes, firstMinuteMs = null) {
  if (!bars?.length || !backfill?.length) return { bars, chartBars: bars, offset: 0, priorCount: 0 }
  const bucketMs = Math.max(1, timeframeMinutes) * 60_000
  const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())
  const firstBarMs = msOf(bars[0].time)
  const firstMs = Number.isFinite(firstMinuteMs) ? firstMinuteMs : firstBarMs
  const buckets = new Map()
  let carry = 0      // estimated minutes in the first exact bar's own candle, before its first exact minute
  let carried = false
  for (const m of backfill) {
    const ms = msOf(m.time)
    if (!(ms < firstMs)) continue
    const start = Math.floor(ms / bucketMs) * bucketMs
    const delta = (m.buy ?? 0) - (m.sell ?? 0)
    if (start >= firstBarMs) { carry += delta; carried = true; continue }
    buckets.set(start, (buckets.get(start) ?? 0) + delta)
  }
  let cvd = 0
  const prior = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([time, delta]) => {
    cvd += delta
    return { time, delta, cvd, estimated: true }
  })
  if (prior.length === 0 && !carried) return { bars, chartBars: bars, offset: 0, priorCount: 0 }
  const offset = cvd + carry
  const shifted = bars.map((b) => ({ ...b, cvd: b.cvd + offset }))
  const chartBars = [...prior, ...shifted]
  if (carried) chartBars[prior.length] = { ...shifted[0], delta: shifted[0].delta + carry, estimated: true }
  return { bars: shifted, chartBars, offset, priorCount: prior.length }
}

/**
 * The live "orderFlowDelta" push - the futures engine's latest minutes as `{ time, buy, sell }`, the one still forming
 * included - into a day's delta minutes (`deltaMinutes`'): each pushed minute replaces the same minute or extends the
 * day. `{ minutes, gap }`: gap = a minute missing between the day held and the push (pushes skipped while the page was
 * slow or away, or a reconnect) - the day must be loaded again; the minutes are then left as they were.
 */
export function mergeDeltaPush(minutes, pushed) {
  const list = minutes ?? []
  const fresh = (pushed ?? [])
    .map((m) => ({ ms: typeof m.time === 'number' ? m.time : new Date(m.time).getTime(), delta: (m.buy ?? 0) - (m.sell ?? 0), estimated: false }))
    .filter((m) => Number.isFinite(m.ms)).sort((a, b) => a.ms - b.ms)
  if (!fresh.length) return { minutes: list, gap: false }
  let lastExact = null
  for (let i = list.length - 1; i >= 0; i--) if (!list[i].estimated) { lastExact = list[i]; break }
  if (lastExact && fresh[0].ms > lastExact.ms + 60_000) return { minutes: list, gap: true }
  // Minutes after the push stay (a push already in flight when the day was loaded again is older than the day).
  const last = fresh.at(-1).ms
  return { minutes: [...list.filter((m) => m.ms < fresh[0].ms), ...fresh, ...list.filter((m) => m.ms > last)], gap: false }
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

// The normal CDF the server's estimator uses (OrderFlowEstimator.NormalCdf - Abramowitz & Stegun 7.1.26), so the two
// give the same split.
function normalCdf(x) {
  const z = Math.abs(x) / Math.SQRT2
  const t = 1 / (1 + 0.3275911 * z)
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z)
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf)
}

/**
 * A day's futures order flow ESTIMATED from its 1-minute candles ({ time, open, high, low, close, volume }) exactly as
 * the server estimates a day it did not record (OrderFlowEstimator.Build): bulk volume classification - a minute's buy
 * share Phi(change / sigma), the change its close less the close before (its own open for the first), sigma the root mean
 * square of the changes UP TO that minute (a tick, 0.05, while all are zero) - buy rounded to whole lots, sell the rest.
 * For OI Replay's replayed day when the order flow server has none for it (asked for - "if the futures cumulative delta is
 * present in replay show that as well"): the run's own futures candles. Each minute from it and those before it only.
 * Returns deltaMinutes' shape - [{ ms, delta, estimated: true }].
 */
export function estimateFlowMinutes(candles, { lotSize = 1, tick = 0.05 } = {}) {
  const bars = (candles ?? [])
    .map((c) => ({ ...c, ms: typeof c.time === 'number' ? c.time : new Date(c.time).getTime() }))
    .filter((c) => Number.isFinite(c.ms) && c.volume > 0 && c.high >= c.low && c.low > 0)
    .sort((a, b) => a.ms - b.ms)
  const lot = Math.max(1, lotSize || 1)
  let sumSquares = 0
  return bars.map((c, i) => {
    const change = c.close - (i === 0 ? c.open : bars[i - 1].close)
    sumSquares += change * change
    const rms = Math.sqrt(sumSquares / (i + 1))
    const share = normalCdf(change / (rms > 0 ? rms : Math.max(tick, 0.05)))
    const buy = Math.min(c.volume, Math.round((c.volume * share) / lot) * lot)
    return { ms: c.ms, delta: buy - (c.volume - buy), estimated: true }
  })
}
