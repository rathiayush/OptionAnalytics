// Quick views - a popup for a quick scan of one card, by keyboard (Ctrl + Shift + the digit; the same again or Esc
// closes, another digit switches) or by the "Quick view" buttons. Ctrl + Shift, not Ctrl alone: the browser keeps
// Ctrl + 1 - 8 for its own tabs. The popup shows the card's own content, live with the page (replay clock or live).
export const QUICK_VIEWS = [
  { key: 'dayOi', digit: 1, label: 'Day OI', title: 'Day OI since the open' },
  { key: 'oiCharts', digit: 2, label: 'OI charts', title: 'OI totals charts - CE, PE and Net' },
  { key: 'oiHeatmap', digit: 3, label: 'OI heatmap', title: 'OI change heatmap (all strikes) and the totals' },
  { key: 'premium', digit: 4, label: 'Premium', title: 'Option premium - CE and PE (ATM by default)' },
  { key: 'straddle', digit: 5, label: 'Straddle', title: 'ATM straddle' },
  { key: 'gex', digit: 6, label: 'GEX', title: 'GEX - gamma exposure' },
  { key: 'futures', digit: 7, label: 'Futures', title: 'Futures - candles, OI, VWAP and the previous day\'s profile' },
  { key: 'dex', digit: 8, label: 'DEX', title: 'DEX - delta exposure' },
]

/** The quick view a key press opens (Ctrl + Shift + 1 - 8, top row or numpad), else null. */
export function quickViewForKey(e) {
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return null
  return QUICK_VIEWS.find((v) => e.code === `Digit${v.digit}` || e.code === `Numpad${v.digit}`) ?? null
}

// Whether a key pressed in `el` types into it - then a LETTER shortcut (the order ticket's B / S) is not taken from it. A
// checkbox, a radio (antd's Segmented - Numbers / Heatmap, Total OI / Since open), a switch and a dropdown you cannot type
// in (antd marks its input read-only) only HOLD the focus after a click; they used to count as "typing", so after
// ticking VWAP or picking a timeframe B / S did nothing until a click somewhere else.
const NOT_TYPED_IN = new Set(['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'])
export function isTypingField(el) {
  if (!el) return false
  if (el.isContentEditable) return true
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  if (el.tagName !== 'INPUT') return false
  return !el.readOnly && !NOT_TYPED_IN.has(String(el.type || 'text').toLowerCase())
}

// On a phone there is no keyboard: a small round button (QuickViewFab.jsx), dragged anywhere on the screen, whose tap
// opens the quick views as small icons. Sizes in px.
export const FAB_SIZE = 40
export const FAB_ITEM_SIZE = 34
export const FAB_GAP = 8
const FAB_MARGIN = 8
const FAB_DRAG_PX = 6

/** Where the button sits: `pos` ({ x, y } - its top-left) kept inside the screen (`viewport` { width, height }). */
export function placeFab(pos, viewport) {
  const maxX = Math.max(FAB_MARGIN, viewport.width - FAB_SIZE - FAB_MARGIN)
  const maxY = Math.max(FAB_MARGIN, viewport.height - FAB_SIZE - FAB_MARGIN)
  const x = Number.isFinite(pos?.x) ? pos.x : maxX
  const y = Number.isFinite(pos?.y) ? pos.y : maxY
  return { x: Math.min(maxX, Math.max(FAB_MARGIN, x)), y: Math.min(maxY, Math.max(FAB_MARGIN, y)) }
}

/** Its first place: bottom right, clear of a phone browser's bottom bar. */
export const fabDefault = (viewport) => ({ x: viewport.width - FAB_SIZE - 16, y: viewport.height - FAB_SIZE - 96 })

/** A press that moved this far is a drag (it moves the button), else a tap (it opens / closes the icons). */
export const isFabDrag = (dx, dy) => Math.hypot(dx, dy) >= FAB_DRAG_PX

/** Which way `count` icons open from the button at `pos`: up when they fit above it (or there is more room above). */
export function fabOpensUp(pos, count, viewport) {
  const need = count * (FAB_ITEM_SIZE + FAB_GAP)
  const above = pos.y
  const below = viewport.height - pos.y - FAB_SIZE
  return above >= need || above > below
}
