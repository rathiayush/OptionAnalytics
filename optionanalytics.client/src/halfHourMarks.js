// Where the canvas heatmaps (the liquidity heatmap, the OI change / totals heatmaps) put their time-axis labels: at each
// :00 and :30 IST in view - every hour, 2 h ... when they would be closer than MIN_GAP_PX. Chart times are IST-shifted seconds
// (toChartTime), so reading them as UTC gives IST. A label sits on the first column at or after its half hour.

const HALF_HOUR = 1800
const MIN_GAP_PX = 44
const LABEL = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })

/** "09:30" for a chart time (IST-shifted seconds). */
export const checkpointLabel = (time) => LABEL.format(new Date(time * 1000))

/**
 * The checkpoints among `times` (ascending chart times): the first time in each `stepSeconds` period (1800 = every half hour,
 * 3600 = every hour ...), periods aligned to the clock (09:00, 09:30 ...). The very first time is not one unless it falls
 * exactly on a boundary (the left edge is not a checkpoint).
 */
export function checkpoints(times, stepSeconds = HALF_HOUR) {
  const out = []
  let previous = null
  for (const t of times) {
    if (!Number.isFinite(t)) continue
    const period = Math.floor(t / stepSeconds)
    if (previous === null ? t % stepSeconds === 0 : period !== previous) out.push({ time: t, label: checkpointLabel(Math.floor(t / stepSeconds) * stepSeconds) })
    previous = period
  }
  return out
}

/** The smallest step (half hour, hour, 2 h, 3 h, 6 h, 12 h, a day) whose checkpoints are at least `minGapPx` apart, given the
 *  pixels one second takes on the chart. */
export function checkpointStep(pxPerSecond, minGapPx = MIN_GAP_PX) {
  for (const step of [1800, 3600, 7200, 10800, 21600, 43200, 86400]) if (step * pxPerSecond >= minGapPx) return step
  return 86400
}
