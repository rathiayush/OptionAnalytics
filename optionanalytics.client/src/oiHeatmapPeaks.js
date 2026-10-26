// The OI change heatmaps' (CE / PE by strike) bordered cells: in each time column, the strike with the biggest OI change -
// added or removed alike - when it is the ATM strike or one either side. ATM is the column's own: the spot as that column
// ends, not today's - so an earlier column is read against where price was then.

// The strike spacing: the smallest gap between two strikes.
export function strikeStep(strikes) {
  const sorted = [...strikes].filter(Number.isFinite).sort((a, b) => a - b)
  let step = Infinity
  for (let i = 1; i < sorted.length; i++) if (sorted[i] > sorted[i - 1]) step = Math.min(step, sorted[i] - sorted[i - 1])
  return Number.isFinite(step) ? step : null
}

// The ATM strike as a column [t, t + bucketSeconds) ends, from the 1-minute spot bars (chart seconds, ascending, each
// stamped at its start and holding its close): the last bar starting before the column's end, rounded to the step.
// Null before the first bar.
export function atmAtFromBars(bars, step) {
  return (columnTime, bucketSeconds) => {
    if (!bars?.length || !(step > 0)) return null
    const last = columnTime + bucketSeconds - 60
    let lo = 0
    let hi = bars.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (bars[mid].time <= last) { found = mid; lo = mid + 1 } else hi = mid - 1
    }
    const close = found >= 0 ? bars[found].close : null
    return Number.isFinite(close) ? Math.round(close / step) * step : null
  }
}

// columnTime -> the strikes to border in that column: the strike(s) with the column's biggest |OI change|, when they are
// all within one step of that column's ATM (atmFor(columnTime) - null leaves the column unmarked). A far strike matching
// that biggest change means the biggest is not at ATM - nothing is marked; nor in a column with no change at all.
export function atmPeakCells(perStrikeChange, columns, strikes, atmFor, step = strikeStep(strikes)) {
  const marked = new Map()
  if (!(step > 0)) return marked
  for (const t of columns) {
    let max = 0
    for (const strike of strikes) {
      const v = perStrikeChange.get(strike)?.get(t)
      if (Number.isFinite(v)) max = Math.max(max, Math.abs(v))
    }
    if (max === 0) continue
    const atm = atmFor(t)
    if (!Number.isFinite(atm)) continue
    const peaks = strikes.filter((strike) => Math.abs(perStrikeChange.get(strike)?.get(t) ?? 0) === max)
    if (peaks.every((strike) => Math.abs(strike - atm) <= step * 1.001)) marked.set(t, new Set(peaks))
  }
  return marked
}
