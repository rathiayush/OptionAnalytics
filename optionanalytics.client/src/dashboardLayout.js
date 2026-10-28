// OI Replay's dashboard layout: how wide and how tall each card is laid out, saved per browser.
//
// A card's place on the page is three separate things, each saved on its own:
//   - WHICH cards are shown  - the page's "Sections shown" (SECTION_OPTIONS);
//   - the ORDER they come in - useCardOrder / cardOrder.js (drag a card's ⠿ handle);
//   - how WIDE and how TALL - this file: `{ span, h }` a card, dragged by its bottom-right grip.
//
// Width is in twelfths of the page (span 12 = the whole width, 6 = half, 4 = a third), so cards tile
// into rows the way the page always laid them out. Height is in pixels, or null = as tall as the card
// wants to be (how every card behaved before this).
//
// NARROW SCREENS NEVER USE IT: under WIDE_LAYOUT_PX every card is full width and its own height, so a
// phone keeps the single column it has always had - a layout dragged out on a monitor cannot leave a
// phone with a 200 px sliver of a chart.

export const LAYOUT_COLUMNS = 12
// A card narrower than a quarter of the page is unreadable (its title alone wraps to three lines).
export const MIN_SPAN = 3
export const MIN_CARD_HEIGHT = 180
export const MAX_CARD_HEIGHT = 2000
// Under this the page is one column - see the note above.
export const WIDE_LAYOUT_PX = 1100
// What a card is worth when the layout has nothing for it: the full width, its own height.
export const DEFAULT_ENTRY = { span: LAYOUT_COLUMNS, h: null }

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const spanOf = (v) => (Number.isFinite(v) ? clamp(Math.round(v), MIN_SPAN, LAYOUT_COLUMNS) : LAYOUT_COLUMNS)
const heightOf = (v) => (Number.isFinite(v) ? clamp(Math.round(v), MIN_CARD_HEIGHT, MAX_CARD_HEIGHT) : null)

/** One saved entry read back safely: anything missing or out of range falls back to the default. */
export function layoutEntry(stored) {
  if (!stored || typeof stored !== 'object') return { ...DEFAULT_ENTRY }
  return { span: spanOf(stored.span), h: heightOf(stored.h) }
}

/** A saved layout reconciled with the cards the page has now: every current card gets an entry (a card
 *  added since it was saved gets the default), and ids no longer on the page are dropped. */
export function reconcileLayout(stored, cardIds) {
  const out = {}
  for (const id of cardIds ?? []) out[id] = layoutEntry(stored?.[id])
  return out
}

/** Whether a layout is still all defaults - nothing to reset. */
export function isDefaultLayout(layout) {
  return Object.values(layout ?? {}).every((e) => e.span === LAYOUT_COLUMNS && e.h == null)
}

/** The span a horizontal drag of `dx` px lands on, from `startSpan` in a row `containerPx` wide. */
export function spanFromDrag(startSpan, dx, containerPx) {
  if (!(containerPx > 0)) return spanOf(startSpan)
  return spanOf(startSpan + (dx / containerPx) * LAYOUT_COLUMNS)
}

/** The height a vertical drag of `dy` px lands on, from `startHeight` (null = the card's own height,
 *  so the drag starts from whatever it is laid out at, `measuredHeight`). */
export function heightFromDrag(startHeight, dy, measuredHeight) {
  const from = startHeight ?? measuredHeight
  if (!Number.isFinite(from)) return null
  return heightOf(from + dy)
}

/** Every card the same width, `columns` of them a row - the layout's one-click presets. Heights are kept. */
export function presetLayout(cardIds, columns, stored = null) {
  const span = spanOf(LAYOUT_COLUMNS / clamp(columns, 1, 4))
  const out = {}
  for (const id of cardIds ?? []) out[id] = { span, h: layoutEntry(stored?.[id]).h }
  return out
}

/** One card's place in the page's flex row: its width (a fraction of the row, or the whole of it on a
 *  narrow screen), its height, and where it comes in the order. */
export function cardStyle(entry, { wide = true, order = 0 } = {}) {
  const { span, h } = layoutEntry(entry)
  const width = wide ? `${(span / LAYOUT_COLUMNS) * 100}%` : '100%'
  return {
    order,
    // The gap between cards comes out of each one's own width (border-box), so a row of 12 twelfths
    // still fits - a flex-basis of exactly 50% twice over would wrap the second card to its own row.
    flex: `0 0 ${width}`,
    maxWidth: width,
    boxSizing: 'border-box',
    ...(wide && h != null ? { height: h } : null),
  }
}

// A chart never gets less than this, however short its card was dragged - under it there is nothing to read,
// and the card scrolls instead.
const MIN_CONTENT_HEIGHT = 90

/** The height the card's own content may use, for a chart that should fill its card rather than keep a
 *  fixed height: the card's height less `chromePx` (its title bar and padding), or `fallback`. */
export function contentHeight(entry, { wide = true, chromePx = 86, fallback = null } = {}) {
  const { h } = layoutEntry(entry)
  if (!wide || h == null) return fallback
  return Math.max(MIN_CONTENT_HEIGHT, h - chromePx)
}

// Where the page keeps its dashboard in this browser.
export const STORED_LAYOUT = 'optionanalytics.oiReplay.layout'
export const STORED_COMPACT = 'optionanalytics.oiReplay.compact'
export const STORED_QUICK_FAB = 'optionanalytics.oiReplay.quickFabOn'
