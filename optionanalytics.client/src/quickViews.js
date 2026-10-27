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
]

/** The quick view a key press opens (Ctrl + Shift + 1 - 6, top row or numpad), else null. */
export function quickViewForKey(e) {
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return null
  return QUICK_VIEWS.find((v) => e.code === `Digit${v.digit}` || e.code === `Numpad${v.digit}`) ?? null
}
