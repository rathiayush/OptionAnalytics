// OI Replay's dashboard: where every card SITS and how big it is, saved per browser.
//
// A free grid, 12 columns wide, the way a dashboard tool lays one out: each card is `{ i, x, y, w, h }` -
// its column, its row, and how many of each it covers - so any card can be dragged to any place and
// resized from its corner, not just reordered down a single column. react-grid-layout does the dragging,
// the collisions and the packing; this file is the model it reads and writes, and everything here is a
// plain function so the rules can be tested without a browser.
//
// h is in GRID ROWS, not pixels: a row is GRID_ROW_HEIGHT px plus the margin between rows, so a card's
// real height is rowsToPx(h). A card nobody has sized is exactly as tall as its content (fitLayoutHeights -
// nothing to scroll); one whose corner was dragged keeps that height and scrolls inside it if it must.
//
// NARROW SCREENS NEVER USE IT: under WIDE_LAYOUT_PX the page stacks the cards full width at their own
// height, exactly as it always has. A layout dragged out on a monitor cannot leave a phone with a sliver
// of a chart.

export const GRID_COLS = 12
export const GRID_ROW_HEIGHT = 30
export const GRID_MARGIN = 16
// A card narrower than a quarter of the page is unreadable (its title alone wraps to three lines), and one
// under MIN_H rows has no room for anything but its own title bar.
export const MIN_W = 3
export const MIN_H = 4
// Under this the page is one column - see the note above.
export const WIDE_LAYOUT_PX = 1100

/** A card's height in pixels: `rows` rows, with the margin between them. */
export const rowsToPx = (rows, rowHeight = GRID_ROW_HEIGHT, margin = GRID_MARGIN) =>
  Math.max(1, rows) * rowHeight + (Math.max(1, rows) - 1) * margin

/** The nearest whole number of rows to `px` - how a pixel height a card wants becomes a grid height. */
export const pxToRows = (px, rowHeight = GRID_ROW_HEIGHT, margin = GRID_MARGIN) =>
  Math.max(MIN_H, Math.round((px + margin) / (rowHeight + margin)))

/** The fewest rows that hold `px` whole - a card fitted to its content is never a few pixels short of it
 *  (the card clips what it does not hold, so the nearest row could cut off its last line). */
export const rowsToHold = (px, rowHeight = GRID_ROW_HEIGHT, margin = GRID_MARGIN) =>
  Math.max(MIN_H, Math.ceil((px + margin) / (rowHeight + margin)))

// How tall each card starts out, in grid rows - roughly what it is worth on the page today, so the first
// sight of the dashboard looks like the page the layout replaced. A card not named here gets DEFAULT_ROWS.
const DEFAULT_ROWS = 12
const CARD_ROWS = {
  topStats: 5,
  marketRead: 13,
  entryChecklist: 12,
  dayOi: 13,
  oiHeatmap: 13,
  oiTotals: 9,
  spotAndEntry: 23,
  optionPremium: 14,
  optionFlow: 14,
  straddle: 19,
  gex: 19,
  ladder: 16,
  liquidityMap: 14,
  futures: 21,
}
export const defaultRows = (id) => CARD_ROWS[id] ?? DEFAULT_ROWS

// How WIDE each card starts out, in grid columns. The page used to open with every card full width,
// which looked exactly like the page before the grid existed and gave no hint that anything could be
// moved - and with w = 12 there is nowhere sideways for a card to go, so dragging one did nothing
// visible. The cards that earn the full width (the charts, the heatmap, the two-column checklist) keep
// it; the reads sit beside each other.
const DEFAULT_SPAN = 6
const CARD_SPAN = {
  topStats: 12,
  entryChecklist: 12,
  oiHeatmap: 12,
  oiTotals: 12,
  spotAndEntry: 12,
  futures: 12,
}
export const defaultSpan = (id) => Math.min(GRID_COLS, Math.max(MIN_W, CARD_SPAN[id] ?? DEFAULT_SPAN))

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const int = (v, fallback) => (Number.isFinite(v) ? Math.round(v) : fallback)

/** One item read back safely, clamped into the grid: anything missing falls back to a full-width card. */
export function gridItem(stored, id, y = 0) {
  const w = clamp(int(stored?.w, GRID_COLS), MIN_W, GRID_COLS)
  return {
    i: id,
    x: clamp(int(stored?.x, 0), 0, GRID_COLS - w),
    y: Math.max(0, int(stored?.y, y)),
    w,
    h: Math.max(MIN_H, int(stored?.h, defaultRows(id))),
  }
}

function sortByOrder(cardIds, order) {
  const ids = [...(cardIds ?? [])]
  if (!Array.isArray(order) || !order.length) return ids
  const at = (id) => (order.indexOf(id) < 0 ? Number.MAX_SAFE_INTEGER : order.indexOf(id))
  return ids.sort((a, b) => at(a) - at(b))
}

/** The layout the page starts with: each card at its own default width (defaultSpan), laid out left to
 *  right in `order` (the page's own card order) and wrapped to a new row when the next one no longer
 *  fits - a dashboard rather than a column. A row starts below the tallest card of the row above. */
export function defaultLayout(cardIds, order = null) {
  const out = []
  let y = 0
  let x = 0
  let rowRows = 0
  for (const id of sortByOrder(cardIds, order)) {
    const w = defaultSpan(id)
    if (x + w > GRID_COLS) { y += rowRows; x = 0; rowRows = 0 }
    const h = defaultRows(id)
    out.push({ i: id, x, y, w, h })
    x += w
    rowRows = Math.max(rowRows, h)
  }
  return out
}

/** Whether `layout` is a plain one-column stack - every card full width, so nothing was ever actually
 *  arranged sideways. The dashboard first shipped with exactly this as its default, and the page wrote
 *  it straight back to storage on the first render, so it is also what someone who never touched the
 *  layout has saved (see the page's own one-time migration). */
export function isStackedLayout(layout, cardIds) {
  if (!Array.isArray(layout) || !layout.length || layout.length !== (cardIds?.length ?? -1)) return false
  const ids = new Set(cardIds)
  return layout.every((it) => it && ids.has(it.i) && it.x === 0 && it.w === GRID_COLS)
}

/** A saved layout reconciled with the cards the page has now: the cards it knows keep their place, ids no
 *  longer on the page are dropped, and a card added since goes RIGHT UNDER the card before it in the page's
 *  order (at its column, its own default width), everything from there down moving down to make room - a card
 *  split out of another (the OI totals out of the heatmap) lands where its content used to be, not at the
 *  bottom of the page. With none of the cards before it saved, it goes at the bottom, full width. */
export function reconcileGridLayout(stored, cardIds, order = null) {
  const saved = new Map((Array.isArray(stored) ? stored : [])
    .filter((it) => it && typeof it.i === 'string')
    .map((it) => [it.i, it]))
  const ids = sortByOrder(cardIds, order)
  if (!saved.size) return defaultLayout(cardIds, order)
  let out = ids.filter((id) => saved.has(id)).map((id) => gridItem(saved.get(id), id))
  ids.forEach((id, n) => {
    if (saved.has(id)) return
    const h = defaultRows(id)
    const before = ids.slice(0, n).reverse().map((other) => out.find((it) => it.i === other)).find(Boolean)
    if (!before) {
      out.push({ i: id, x: 0, y: out.reduce((b, it) => Math.max(b, it.y + it.h), 0), w: GRID_COLS, h })
      return
    }
    const w = defaultSpan(id)
    const y = before.y + before.h
    out = out.map((it) => (it.y >= y ? { ...it, y: it.y + h } : it))
    out.push({ i: id, x: Math.min(before.x, GRID_COLS - w), y, w, h })
  })
  // Back into the page's own order, so the DOM order (and so the tab order) still reads sensibly.
  const byId = new Map(out.map((it) => [it.i, it]))
  return ids.map((id) => byId.get(id))
}

/** Whether a layout is still the one the page starts with - nothing to reset. */
export function isDefaultLayout(layout, cardIds, order = null) {
  const base = defaultLayout(cardIds, order)
  if (!Array.isArray(layout) || layout.length !== base.length) return false
  const byId = new Map(layout.map((it) => [it.i, it]))
  return base.every((b) => {
    const it = byId.get(b.i)
    return Boolean(it) && it.x === b.x && it.y === b.y && it.w === b.w && it.h === b.h
  })
}

/** Whether a layout is still ARRANGED as the page starts - every card in its default column and width, and in
 *  its default order down each column - whatever heights the cards have. isDefaultLayout compares heights too,
 *  and a card nobody sized follows its content (fitLayoutHeights), so that never matches once a card has been
 *  measured; this is the "anything to reset?" question the page actually asks. Packing a column upwards
 *  never reorders it, so the order down a column survives the heights changing. `shown`: only these cards
 *  count - the grid saves just the cards on the page, so a hidden one always comes back elsewhere. */
export function isDefaultArrangement(layout, cardIds, order = null, shown = null) {
  if (!Array.isArray(layout)) return false
  const showing = shown ? new Set(shown) : null
  const base = defaultLayout(cardIds, order).filter((b) => !showing || showing.has(b.i))
  const byId = new Map(layout.map((it) => [it?.i, it]))
  if (!base.every((b) => byId.has(b.i))) return false
  if (!base.every((b) => byId.get(b.i)?.x === b.x && byId.get(b.i)?.w === b.w)) return false
  const lanes = (items) => {
    const out = new Map()
    for (const it of [...items].sort((a, b) => a.y - b.y)) out.set(it.x, [...(out.get(it.x) ?? []), it.i])
    return out
  }
  const want = lanes(base)
  const have = lanes(base.map((b) => byId.get(b.i)))
  return [...want].every(([x, ids]) => (have.get(x) ?? []).join('|') === ids.join('|'))
}

/** Every card the same width, `columns` of them a row, left to right in the page's order - the one-click
 *  presets. Each card keeps the height it has; a row starts below the tallest card of the row above. */
export function presetLayout(cardIds, columns, { order = null, layout = null } = {}) {
  const cols = clamp(Math.round(columns) || 1, 1, 4)
  const w = Math.max(MIN_W, Math.floor(GRID_COLS / cols))
  const heights = new Map((layout ?? []).map((it) => [it.i, it.h]))
  const ids = sortByOrder(cardIds, order)
  const rowsOf = (id) => heights.get(id) ?? defaultRows(id)
  const out = []
  let y = 0
  for (let at = 0; at < ids.length; at += cols) {
    const row = ids.slice(at, at + cols)
    row.forEach((id, n) => out.push({ i: id, x: n * w, y, w, h: rowsOf(id) }))
    y += Math.max(...row.map(rowsOf))
  }
  const byId = new Map(out.map((it) => [it.i, it]))
  return ids.map((id) => byId.get(id))
}

/** The layout with every card that the trader has NOT resized by hand set to exactly the height its own
 *  content needs - `measured` is each card's measured content height in pixels (DashboardCard reports
 *  it), `sized` the ids that have been dragged to a height of their own and so keep it.
 *
 *  This is what stops a dashboard full of scrollbars: a card is either its content's own height (nothing
 *  to scroll) or a height the trader chose (scrolls, because they asked for it to be that size). There is
 *  no feedback loop between the two - a card being measured hands its charts no height at all, so they
 *  stand at their own and the measurement settles (see DashboardCard).
 *
 *  Returns the SAME array when nothing changed, so re-measuring the same page costs no render. */
export function fitLayoutHeights(layout, measured, sized = null) {
  if (!Array.isArray(layout) || !measured?.size) return layout
  let changed = false
  const out = layout.map((it) => {
    if (sized?.has(it.i)) return it
    const px = measured.get(it.i)
    if (!Number.isFinite(px) || px <= 0) return it
    const h = rowsToHold(px)
    if (h === it.h) return it
    changed = true
    return { ...it, h }
  })
  return changed ? out : layout
}

// ---- A sized card's content follows its size ----
//
// A card the trader has sized keeps that height, and its content is fitted INTO it: every chart (and every table /
// heatmap box) in it takes its own height x ONE scale for the card, worked out so that the content is exactly the
// card's height - charts taller in a taller card, shorter in a shorter one, nothing to scroll. One scale for all, not
// a sum of chart heights: charts stacked, side by side, or both - the content's height is the same straight line in
// the scale either way (height = the rest + scale x the charts along its tallest column), so the scale is found by
// measuring - the secant method: the first step guesses the charts are one above the other, every later one uses the
// slope the last two measurements gave. Two or three steps; a few more where a chart stops at its smallest.
export const FIT_SCALE_MIN = 0.25
export const FIT_SCALE_MAX = 4
// Aim this far under the card's height (a scrollbar appears at the first pixel over it) and stop this close to it.
const FIT_SLACK = 2
const FIT_TOLERANCE = 3
// At most this many steps for one card size - one that keeps missing (its content changing as it is measured) stops.
const FIT_MAX_STEPS = 8

/** The next fit scale for a sized card. `state` (what the last call returned, null at first); `scale` the scale its
 *  content was measured at; `content` its content's height (px), `box` the card body's height and `width` its width;
 *  `charts` the sum of the fitted elements' own heights (the first step's slope). Returns { scale, state }: the same
 *  scale when the content already fits (or nothing in it scales). A new card size or width starts the steps afresh. */
export function nextFitScale(state, { scale, content, box, width, charts }) {
  let { prev = null, size = null, steps = 0 } = state ?? {}
  if (!size || Math.abs(size.box - box) > 1 || Math.abs(size.width - width) > 1) { prev = null; steps = 0; size = { box, width } }
  const target = box - FIT_SLACK
  const here = { scale, content }
  if (Math.abs(content - target) <= FIT_TOLERANCE) return { scale, state: { prev: here, size, steps: 0 } }
  if (steps >= FIT_MAX_STEPS) return { scale, state: { prev, size, steps } }
  const slope = prev && Math.abs(scale - prev.scale) > 1e-4 ? (content - prev.content) / (scale - prev.scale) : charts
  if (!(slope > 1)) return { scale, state: { prev: here, size, steps: steps + 1 } }
  const next = Math.round(clamp(scale + (target - content) / slope, FIT_SCALE_MIN, FIT_SCALE_MAX) * 1000) / 1000
  return { scale: next, state: { prev: here, size, steps: steps + 1 } }
}

// Cards split out of another since a trader's "Sections shown" was saved: the new card -> the card it came out of.
// The OI totals (CE / PE / Net cumulative Δ and their S/R break alerts) were part of the OI change heatmap card.
export const SECTION_SPLITS = { oiTotals: 'oiHeatmap' }

/** A saved choice of cards with each card split out since added wherever the card it came out of is shown (right
 *  after it) - it holds what that card used to, so someone who showed the heatmap keeps seeing the totals (and their
 *  alerts keep running). The page does this ONCE (SECTIONS_VERSION), so hiding the new card afterwards sticks. */
export function withSplitSections(stored, splits = SECTION_SPLITS) {
  if (!Array.isArray(stored)) return stored
  const out = [...stored]
  for (const [card, from] of Object.entries(splits)) {
    if (out.includes(card) || !out.includes(from)) continue
    out.splice(out.indexOf(from) + 1, 0, card)
  }
  return out
}

/** The cards to show, reconciled with the ones the page has now: anything saved that no longer exists is
 *  dropped, and nothing saved at all means `fallback` (the page's own default set). */
export function reconcileSections(stored, allValues, fallback) {
  if (!Array.isArray(stored)) return [...fallback]
  const known = new Set(allValues)
  const out = stored.filter((v, i) => known.has(v) && stored.indexOf(v) === i)
  // An empty page is never what someone meant to save - it would look broken with no way back but "Show all".
  return out.length ? out : [...fallback]
}

// Where the page keeps its dashboard in this browser.
export const STORED_LAYOUT = 'optionanalytics.oiReplay.gridLayout'
export const STORED_COMPACT = 'optionanalytics.oiReplay.compact'
export const STORED_QUICK_FAB = 'optionanalytics.oiReplay.quickFabOn'
// The page's controls card folded to its one row of day / index / Load day (the rest behind "More").
export const STORED_CONTROLS_COLLAPSED = 'optionanalytics.oiReplay.controlsCollapsed'
export const STORED_FREE_PLACEMENT = 'optionanalytics.oiReplay.freePlacement'
// The Day OI card's day read and its lookback table, open or folded to one line.
export const STORED_DAY_READ_OPEN = 'optionanalytics.oiReplay.dayOi.readOpen'
export const STORED_LOOKBACK_OPEN = 'optionanalytics.oiReplay.dayOi.lookbackOpen'
export const STORED_SECTIONS = 'optionanalytics.oiReplay.sections'
// The cards given a height of their own by dragging their corner - everything else follows its content.
export const STORED_SIZED = 'optionanalytics.oiReplay.sizedCards'
// Bumped when the DEFAULT layout changes in a way a saved one should pick up - see the page's migration.
export const STORED_LAYOUT_VERSION = 'optionanalytics.oiReplay.gridLayoutVersion'
export const LAYOUT_VERSION = '2'
// Bumped when a card is split out of another (SECTION_SPLITS) - see the page's migration.
export const STORED_SECTIONS_VERSION = 'optionanalytics.oiReplay.sectionsVersion'
export const SECTIONS_VERSION = '2'
