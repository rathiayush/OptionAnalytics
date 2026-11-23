// Fitting a lightweight-charts chart to its whole day (oiShared.jsx's useFitContentAsDataGrows, the charts' reset).

// Fits the whole series. With FEW candles - the replay's first minutes - the chart holds MIN_FIT_SLOTS candle widths and
// they stand FROM THE LEFT, the rest empty, exactly as the delta profile cards do (their MIN_SPAN; asked for - "like in
// the delta profile candles are by default adjusted and on the left side"): one candle filled the whole spot / entry
// chart. Once there are that many, all of them are fitted. Set directly from the bar count - it used to read the visible
// range back right after fitContent(), which the chart applies a frame later, so its cap missed at the start.
export const MIN_FIT_SLOTS = 30
export function fitWholeDay(chart) {
  if (!chart) return
  const timeScale = chart.timeScale()
  const range = autoFitRange(barCountOf(chart))
  if (range) timeScale.setVisibleLogicalRange(range)
  else timeScale.fitContent()
}

/** The view for `count` candles: null = fit them all (at least `slots` of them); else `slots` candle widths with the
 *  candles from the left edge. */
export function autoFitRange(count, slots = MIN_FIT_SLOTS) {
  if (!(count > 0) || count >= slots) return null
  return { from: -0.5, to: slots - 0.5 }
}

function barCountOf(chart) {
  try { return chart.panes()[0]?.getSeries()[0]?.data()?.length ?? 0 } catch { return 0 }
}

// How many minutes one bar of the chart's first series spans - the smallest step between its bars' times (chart time,
// seconds); 1 when it cannot tell (fewer than two bars, or no times).
export function barMinutesOf(chart) {
  let data = []
  try { data = chart.panes()[0]?.getSeries()[0]?.data() ?? [] } catch { return 1 }
  let step = Infinity
  for (let i = 1; i < data.length; i++) {
    const d = data[i].time - data[i - 1].time
    if (d > 0 && d < step) step = d
  }
  return Number.isFinite(step) ? Math.max(1, Math.round(step / 60)) : 1
}
