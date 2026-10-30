// Quick views - a popup for a quick scan of one card, by keyboard (Alt + a letter of the bottom row, Z X C V B N M; the
// same again or Esc closes, another letter switches) or by the "Quick view" buttons. Alt, not Ctrl: Ctrl + N is the
// browser's new window (a page cannot take it) and Ctrl + Z / X / C / V are undo / cut / copy / paste. The old Ctrl +
// Shift + 1 - 7 still open them (`digit`). The popup shows the card's own content, live with the page (replay clock or live).
export const QUICK_VIEWS = [
  { key: 'dayOi', letter: 'Z', digit: 1, label: 'Day OI', title: 'Day OI since the open' },
  { key: 'oiCharts', letter: 'X', digit: 2, label: 'OI charts', title: 'OI totals charts - CE, PE and Net' },
  { key: 'gex', letter: 'C', digit: 6, label: 'GEX', title: 'GEX - gamma exposure' },
  { key: 'straddle', letter: 'V', digit: 5, label: 'Straddle', title: 'ATM straddle' },
  { key: 'futures', letter: 'B', digit: 7, label: 'Futures', title: 'Futures - candles, OI, VWAP and the previous day\'s profile' },
  { key: 'oiHeatmap', letter: 'N', digit: 3, label: 'OI heatmap', title: 'OI change heatmap (all strikes) and the totals' },
  { key: 'premium', letter: 'M', digit: 4, label: 'Premium', title: 'Option premium - CE and PE (ATM by default)' },
]
export const QUICK_VIEW_KEYS_TEXT = `Alt + ${QUICK_VIEWS.map((v) => v.letter).join(' ')}`

/** The quick view a key press opens (Alt + Z X C V B N M; or the old Ctrl + Shift + 1 - 7, top row or numpad), else null.
 *  Alt + a letter is not taken from a box being typed in (on a Mac, Option + a letter types a character). The order
 *  ticket's B / S keys are plain letters: Alt + B is Futures, never a buy. */
export function quickViewForKey(e) {
  if (e.metaKey) return null
  if (e.altKey && !e.ctrlKey && !e.shiftKey) {
    if (isTypingField(e.target)) return null
    return QUICK_VIEWS.find((v) => e.code === `Key${v.letter}`) ?? null
  }
  if (e.ctrlKey && e.shiftKey && !e.altKey) return QUICK_VIEWS.find((v) => e.code === `Digit${v.digit}` || e.code === `Numpad${v.digit}`) ?? null
  return null
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
