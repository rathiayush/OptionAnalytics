// The liquidity heatmap's layout rules (DepthHeatmap in OrderFlowCharts.jsx draws with them) - pure, so they are tested:
//
//  - columnSpans: each book column placed at its TIME, as wide as until the next one. The columns are not evenly spaced
//    (the day loaded from the server is ~900 samples of the whole morning - one every ~12 s - and the live feed adds one
//    every 2 s), and they used to be drawn one width each: the live part came out stretched against the time axis, and the
//    prints, signals, icebergs and VWAP - drawn by time - drifted off the cells they were about. A stretch with NO book (a
//    server restart, the depth feed reconnecting - a column with no levels, or a jump in time far past the spacing around
//    it) is a GAP: drawn as "no book", the price line broken across it - it was a black stripe the price line ran over.
//  - placeLabels: the STACK / PULL / SWEEP ... pills placed strongest first, never over one already placed (above the
//    anchor, else below it); the ones with no room become a small dot - they piled up into an unreadable stack.
//  - restingSince: how long the side under the pointer has held at least half its size at that price - a wall that has
//    rested 20 minutes is not one flashed a second ago (a spoof).

/** Columns with no levels on either side: no book recorded at that moment. */
export const isEmptyColumn = (c) => !(c?.bids?.length) && !(c?.asks?.length)

const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor((s.length - 1) / 2)]
}

/** A jump of more than this many times the spacing around it - and at least GAP_MIN_MS - is a gap, not a column. */
export const GAP_FACTOR = 5
export const GAP_MIN_MS = 30_000

/**
 * Where each column sits in time: [{ start, end, empty }] (ms) - from its own time to the next column's, or, when that
 * is a gap, to its time plus the spacing around it - and the GAPS: [{ start, end }], every stretch with no book (a jump
 * past max(GAP_FACTOR x the median of the ~20 intervals around it, GAP_MIN_MS), or a run of empty columns). `endMs` - the
 * time the last column runs to (the spacing before it).
 */
export function columnSpans(columns) {
  const n = columns?.length ?? 0
  if (!n) return { spans: [], gaps: [], startMs: null, endMs: null }
  const intervals = []
  for (let i = 1; i < n; i++) intervals.push(columns[i].t - columns[i - 1].t)
  const localSpacing = (i) => {
    // the median of the ~20 intervals around interval i (between columns i and i + 1), itself left out - a jump is
    // judged against its neighbours, never against itself; with no neighbour, the interval itself
    const around = []
    for (let k = Math.max(0, i - 10); k < Math.min(intervals.length, i + 11); k++) if (k !== i && intervals[k] > 0) around.push(intervals[k])
    return median(around) || intervals[i] || 2000
  }
  const spans = []
  const gaps = []
  for (let i = 0; i < n; i++) {
    const t = columns[i].t
    const spacing = localSpacing(Math.min(i, intervals.length - 1))
    let end
    if (i < n - 1) {
      const d = intervals[i]
      if (d > Math.max(GAP_FACTOR * spacing, GAP_MIN_MS)) {
        end = t + spacing
        gaps.push({ start: end, end: columns[i + 1].t })
      } else end = columns[i + 1].t
    } else end = t + spacing
    const empty = isEmptyColumn(columns[i])
    spans.push({ start: t, end, empty })
    if (empty) gaps.push({ start: t, end })
  }
  // Touching gaps (a run of empty columns, an empty column beside a jump) read as one.
  gaps.sort((a, b) => a.start - b.start)
  const merged = []
  for (const g of gaps) {
    const last = merged.at(-1)
    if (last && g.start <= last.end + 1) last.end = Math.max(last.end, g.end)
    else merged.push({ ...g })
  }
  return { spans, gaps: merged, startMs: spans[0].start, endMs: spans[n - 1].end }
}

/** The index of the column whose span holds time t (null outside them all, or in a gap). */
export function columnAt(spans, t) {
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (t < spans[mid].start) hi = mid - 1
    else if (t >= spans[mid].end) lo = mid + 1
    else return spans[mid].empty ? null : mid
  }
  return null
}

/** The gap holding time t, or null. */
export const gapAt = (gaps, t) => gaps.find((g) => t >= g.start && t < g.end) ?? null

const overlaps = (a, b, pad) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad

/**
 * The pills placed without covering each other: `items` [{ x, y, w, priority, ... }] (the anchor and the pill's width),
 * strongest first (priority, then the later x); each goes ABOVE its anchor (y - 20), else BELOW it (y + 6), kept inside
 * the plot (width x height), unless it would cover a pill already placed - then it is a DOT at its anchor. Returns the
 * items with { pill: { x, y, w, h } } or { dot: true }, in the order given.
 */
export function placeLabels(items, { width, height, h = 14, pad = 2 } = {}) {
  const order = items.map((it, i) => i).sort((a, b) => (items[b].priority ?? 0) - (items[a].priority ?? 0) || items[b].x - items[a].x)
  const placed = []
  const out = items.map((it) => ({ ...it }))
  for (const i of order) {
    const it = items[i]
    const px = Math.min(width - it.w - 1, Math.max(1, it.x - it.w / 2))
    const tries = [it.y - 20, it.y + 6].map((y) => ({ x: px, y: Math.max(1, Math.min(height - h - 1, y)), w: it.w, h }))
    const spot = tries.find((r) => !placed.some((p) => overlaps(r, p, pad)))
    if (spot) { placed.push(spot); out[i].pill = spot } else out[i].dot = true
  }
  return out
}

/**
 * Since when the side `side` ('bid' / 'ask') at `price` has held at least `fraction` of its size at column `index`, the
 * columns walked back without a break: { since (ms), quantity } - null when there is nothing resting there. A column with
 * less (or none), an empty column (no book) or a gap in time ends the walk.
 */
export function restingSince(columns, index, side, price, { fraction = 0.5, spans = null } = {}) {
  const key = side === 'ask' ? 'asks' : 'bids'
  const at = (c) => c?.[key]?.find((l) => l[0] === price)?.[1] ?? 0
  const now = at(columns[index])
  if (!(now > 0)) return null
  const floor = now * fraction
  let since = columns[index].t
  for (let i = index - 1; i >= 0; i--) {
    if (isEmptyColumn(columns[i])) break
    if (spans && spans[i] && spans[i].end < columns[i + 1].t) break   // a gap between them
    if (at(columns[i]) < floor) break
    since = columns[i].t
  }
  return { since, quantity: now }
}
