// Automatic support / resistance on a running-total line (the OI totals' cumulative Δ - CE, PE or net - in the
// totals charts popup).
//
// A swing high is a point that is the highest of the `pivotBars` points on each side and that the line then fell
// away from by at least `minSwingPct` of its range before going higher (a swing low the same, upside down): the line
// was turned back there. Swings within `tolerancePct` of the range of each other are one level - the more swings, the
// more often it held. A level under the line's latest value is support, over it resistance, so a resistance the line
// has since gone through is support now: `brokenAt` is when it went through (the last crossing), `brokeUp` which way.
// A swing needs points after it, so only the line as drawn - up to the replay clock - is used: nothing ahead of the
// clock can mark a level.

export function lineLevels(points, { pivotBars = 3, minSwingPct = 0.08, tolerancePct = 0.03, perSide = 3 } = {}) {
  const line = (points ?? []).filter((p) => Number.isFinite(p?.value))
  const values = line.map((p) => p.value)
  const now = values.at(-1) ?? null
  const none = { now, levels: [], support: null, resistance: null }
  const n = values.length
  if (n < 2 * pivotBars + 1) return none
  let hi = -Infinity
  let lo = Infinity
  for (const v of values) { if (v > hi) hi = v; if (v < lo) lo = v }
  const range = hi - lo
  if (!(range > 0)) return none
  const minSwing = range * minSwingPct

  const swings = []
  for (let i = pivotBars; i < n - pivotBars; i++) {
    const v = values[i]
    let isHigh = true
    let isLow = true
    for (let j = i - pivotBars; j <= i + pivotBars && (isHigh || isLow); j++) {
      if (j === i) continue
      // A flat top / bottom counts once, at its first point.
      if (j < i ? values[j] >= v : values[j] > v) isHigh = false
      if (j < i ? values[j] <= v : values[j] < v) isLow = false
    }
    if (!isHigh && !isLow) continue
    // How far the line went the other way after it, until it passed it (or the end of what is drawn).
    let away = 0
    for (let j = i + 1; j < n; j++) {
      if (isHigh ? values[j] > v : values[j] < v) break
      away = Math.max(away, isHigh ? v - values[j] : values[j] - v)
    }
    if (away >= minSwing) swings.push({ value: v, time: line[i].time, index: i, kind: isHigh ? 'high' : 'low' })
  }

  // Swings close together are one level, at their average.
  const tolerance = range * tolerancePct
  const clusters = []
  for (const swing of [...swings].sort((a, b) => a.value - b.value)) {
    const last = clusters.at(-1)
    if (last && swing.value - last.value <= tolerance) {
      last.swings.push(swing)
      last.value = last.swings.reduce((s, w) => s + w.value, 0) / last.swings.length
    } else {
      clusters.push({ value: swing.value, swings: [swing] })
    }
  }

  const all = clusters.map((c) => {
    const highs = c.swings.filter((w) => w.kind === 'high').length
    const role = c.value > now ? 'resistance' : 'support'
    // Formed by highs (a resistance) and the line is above it now - or by lows and below it: it was gone through.
    const formedAs = highs * 2 >= c.swings.length ? 'resistance' : 'support'
    const lastIndex = Math.max(...c.swings.map((w) => w.index))
    let brokenAt = null
    if (formedAs !== role) {
      for (let i = n - 1; i > lastIndex; i--) {
        if ((values[i] - c.value) * (values[i - 1] - c.value) <= 0 && values[i] !== c.value) { brokenAt = line[i].time; break }
      }
    }
    return {
      value: c.value, touches: c.swings.length, highs, lows: c.swings.length - highs, role, formedAs,
      firstTime: Math.min(...c.swings.map((w) => w.time)), lastTime: line[lastIndex].time,
      brokenAt, brokeUp: brokenAt != null ? role === 'support' : null,
    }
  })
  // Per side: the most-held levels first, then the nearest.
  const side = (role) => all
    .filter((l) => l.role === role)
    .sort((a, b) => b.touches - a.touches || Math.abs(a.value - now) - Math.abs(b.value - now))
    .slice(0, perSide)
  const levels = [...side('resistance'), ...side('support')].sort((a, b) => b.value - a.value)
  const nearest = (role) => levels.filter((l) => l.role === role).sort((a, b) => Math.abs(a.value - now) - Math.abs(b.value - now))[0] ?? null
  return { now, levels, support: nearest('support'), resistance: nearest('resistance') }
}
