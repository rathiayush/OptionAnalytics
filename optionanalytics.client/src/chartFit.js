// Fitting a lightweight-charts chart to its whole day (oiShared.jsx's useFitContentAsDataGrows, the charts' reset).

// Auto-fit never zooms in further than this many pixels per MINUTE of a candle (8 px a 1-minute candle, 120 px a
// 15-minute one): with only a few bars early in the day, fitting them all made every candle huge and the viewer had
// to squeeze the chart by hand. Past that, the newest candles are shown at this width instead. Per minute, not per
// candle: a flat 8 px crushed a 15-minute chart's whole day (25 candles) into a sliver at the right edge.
const MAX_AUTO_BAR_SPACING = 8

// Fits the whole series, capped at MAX_AUTO_BAR_SPACING per minute of a candle (see its comment).
export function fitWholeDay(chart) {
  if (!chart) return
  const timeScale = chart.timeScale()
  timeScale.fitContent()
  const range = timeScale.getVisibleLogicalRange()
  const width = timeScale.width()
  if (!range || width <= 0) return
  const maxSpacing = MAX_AUTO_BAR_SPACING * barMinutesOf(chart)
  if (width / Math.max(1, range.to - range.from) > maxSpacing) {
    timeScale.applyOptions({ barSpacing: maxSpacing })
    timeScale.scrollToRealTime()
  }
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
