// OI Replay's dashboard: where every card SITS and how big it is, saved per browser.
//
// A free grid, 12 columns wide, the way a dashboard tool lays one out: each card is `{ i, x, y, w, h }` -
// its column, its row, and how many of each it covers - so any card can be dragged to any place and
// resized from its corner, not just reordered down a single column. react-grid-layout does the dragging,
// the collisions and the packing; this file is the model it reads and writes, and everything here is a
// plain function so the rules can be tested without a browser.
//
// h is in GRID ROWS, not pixels: a row is GRID_ROW_HEIGHT px plus the margin between rows, so a card's
// real height is rowsToPx(h). Every card therefore has a height, and one whose content is taller scrolls
// inside it - that is what a dashboard is.
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

// How tall each card starts out, in grid rows - roughly what it is worth on the page today, so the first
// sight of the dashboard looks like the page the layout replaced. A card not named here gets DEFAULT_ROWS.
const DEFAULT_ROWS = 12
const CARD_ROWS = {
  topStats: 5,
  marketRead: 13,
  entryChecklist: 12,
  dayOi: 13,
  oiHeatmap: 17,
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

/** The layout the page starts with: every card full width, stacked in `order` (the page's own card order). */
export function defaultLayout(cardIds, order = null) {
  let y = 0
  return sortByOrder(cardIds, order).map((id) => {
    const item = { i: id, x: 0, y, w: GRID_COLS, h: defaultRows(id) }
    y += item.h
    return item
  })
}

/** A saved layout reconciled with the cards the page has now: the cards it knows keep their place, a card
 *  added since goes at the bottom full width, and ids no longer on the page are dropped. */
export function reconcileGridLayout(stored, cardIds, order = null) {
  const saved = new Map((Array.isArray(stored) ? stored : [])
    .filter((it) => it && typeof it.i === 'string')
    .map((it) => [it.i, it]))
  const ids = sortByOrder(cardIds, order)
  if (!saved.size) return defaultLayout(cardIds, order)
  const out = ids.filter((id) => saved.has(id)).map((id) => gridItem(saved.get(id), id))
  let bottom = out.reduce((b, it) => Math.max(b, it.y + it.h), 0)
  for (const id of ids) {
    if (saved.has(id)) continue
    out.push({ i: id, x: 0, y: bottom, w: GRID_COLS, h: defaultRows(id) })
    bottom += defaultRows(id)
  }
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

// A chart never gets less than this, however short its card was dragged - under it there is nothing to
// read, and the card scrolls instead.
const MIN_CONTENT_HEIGHT = 90

/** The height a chart filling this card may use: the card's own height less `chromePx` (its title bar and
 *  padding). Null when the card has no grid height of its own (a narrow screen). */
export function contentHeight(rows, { chromePx = 86, rowHeight = GRID_ROW_HEIGHT, margin = GRID_MARGIN } = {}) {
  if (!Number.isFinite(rows)) return null
  return Math.max(MIN_CONTENT_HEIGHT, rowsToPx(rows, rowHeight, margin) - chromePx)
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
export const STORED_FREE_PLACEMENT = 'optionanalytics.oiReplay.freePlacement'
export const STORED_SECTIONS = 'optionanalytics.oiReplay.sections'
