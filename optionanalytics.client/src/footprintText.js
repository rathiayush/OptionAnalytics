// How the footprint's rows are WRITTEN (asked for - on narrow bars, most of all with "Delta per row" on, the numbers ran
// into each other: "if the area is too small show delta only"). One choice for every bar on screen, so the chart reads
// the same across it:
//   'full'  - sell x buy (and the row delta, with "Delta per row" on) at the largest font, from the rows' own size down to
//             FOOTPRINT_MIN_TEXT, at which the WIDEST of each on screen fits its cell (the delta column widening from its
//             usual 30% when its number needs it and the cells can spare it);
//   'delta' - with "Delta per row" on and the full set fitting at no size: the row delta alone, across the whole width of
//             the cells (the sell / buy cells give way - the imbalances keep an edge mark, the hover still has every figure);
//   'none'  - colours alone (still too narrow, or rows too thin for text) - never numbers over each other; a bar too narrow
//             for the two cells AND the delta column shows the delta's colours alone across it (they ran into the next bar).
// Text widths are measured once at 10 px (the widest sell / buy / delta string on screen, the bold weight) and scale with
// the font. The geometry is FootprintChart's (OrderFlowCharts.jsx): the cells start 15 px into the bar and end 4 px before
// its edge. A footprint whose text fits as it always did is drawn exactly as before.

export const FOOTPRINT_MIN_TEXT = 8
const CELLS_INSET = 19       // 15 px of candle before the cells, 4 px after them
const CELL_PAD = 5           // sell right-aligned 4 px in / buy left-aligned 3 px in, and a pixel or two clear
const DELTA_PAD = 4
const DELTA_ONLY_PAD = 8     // room for the imbalance edge marks either side

/** The row delta column's usual width beside the cells: about 30% of them, 28 - 52 px. */
export function rowDeltaWidth(colWidth) {
  return Math.max(28, Math.min(52, Math.round((colWidth - CELLS_INSET) * 0.3)))
}

/**
 * The way the rows are written, and the cells for it: { mode: 'full' | 'delta' | 'none', size (the sell / buy font, px),
 * deltaSize (the delta's), deltaOnly (the sell / buy cells give way to the delta), cellW (each of the sell and buy cells;
 * 0 when they give way), deltaW (the delta column) }.
 * `colWidth` - a bar's width; `rowDelta` - the delta column on; `size` / `deltaSize` - the largest fonts the rows' height
 * allows; `sell10` / `buy10` / `delta10` - the widest strings on screen at 10 px; `showText` - rows tall enough for text.
 */
export function footprintTextLayout({ colWidth, rowDelta = false, size = 12, deltaSize = 11, sell10 = 0, buy10 = 0, delta10 = 0, showText = true }) {
  const avail = colWidth - CELLS_INSET
  const usualDelta = rowDelta ? rowDeltaWidth(colWidth) : 0
  const wholeDelta = { deltaOnly: true, cellW: 0, deltaW: Math.max(8, avail) }
  const none = rowDelta && 16 + usualDelta > avail
    ? { mode: 'none', size: 0, deltaSize: 0, ...wholeDelta }
    : { mode: 'none', size: 0, deltaSize: 0, deltaOnly: false, cellW: Math.max(8, (avail - usualDelta) / 2), deltaW: usualDelta }
  if (!showText || !(avail > 0)) return none
  const at = (w10, px) => (w10 * px) / 10
  for (let px = Math.floor(size); px >= FOOTPRINT_MIN_TEXT; px--) {
    const dpx = Math.min(px, deltaSize)
    const cellNeed = Math.max(at(sell10, px), at(buy10, px)) + CELL_PAD
    const deltaNeed = rowDelta ? at(delta10, dpx) + DELTA_PAD : 0
    if (2 * cellNeed + deltaNeed > avail) continue
    const deltaW = rowDelta ? Math.min(avail - 2 * cellNeed, Math.max(usualDelta, deltaNeed)) : 0
    return { mode: 'full', size: px, deltaSize: rowDelta ? dpx : 0, deltaOnly: false, cellW: Math.max(8, (avail - deltaW) / 2), deltaW }
  }
  if (!rowDelta) return none
  for (let px = Math.floor(deltaSize); px >= FOOTPRINT_MIN_TEXT; px--) {
    if (at(delta10, px) + DELTA_ONLY_PAD <= avail) return { mode: 'delta', size: 0, deltaSize: px, ...wholeDelta }
  }
  return none
}
