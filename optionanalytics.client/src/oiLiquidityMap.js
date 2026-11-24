// OI LIQUIDITY MAP (asked for - "a liquidity map type of component which will also show spot price and PE and CE, choose 4 colors"):
// the strikes up the side, the time along the bottom, and in every strike-and-bucket cell what the CALL and the PUT side did to their
// open interest - a Bookmap-style picture of WHERE option money is being added or pulled, with the spot price drawn across it.
// Four colours, two sides: CALL OI ADDED = red (writers building resistance), CALL OI CUT = orange (resistance unwinding), PUT OI ADDED
// = green (writers building support), PUT OI CUT = blue (support unwinding). A cell is split: the call half on the left, the put half
// on the right, each as deep as its change against the 95th percentile of the changes in view. Every cell is the OI change inside its
// bucket read from the readings up to its end (the page's own `buildOiChangeMatrix`), so a cut at any clock equals the whole day's up to it.
// A read - it feeds no strategy or alert.

export const LIQ_COLORS = { ceAdd: '#ef5350', ceCut: '#ff9800', peAdd: '#26a69a', peCut: '#42a5f5' }
export const LIQ_PERCENTILE = 0.95

/** The colour key of one side's change: call / put x added / cut, or null for no change. */
export function liquidityKind(isCall, change) {
  if (!Number.isFinite(change) || change === 0) return null
  return `${isCall ? 'ce' : 'pe'}${change > 0 ? 'Add' : 'Cut'}`
}

/** The |change| that maps to full colour: the 95th percentile of every non-zero change on the grid. */
export function liquidityScale(cells) {
  const mags = []
  for (const c of cells) {
    if (Number.isFinite(c.ce) && c.ce !== 0) mags.push(Math.abs(c.ce))
    if (Number.isFinite(c.pe) && c.pe !== 0) mags.push(Math.abs(c.pe))
  }
  if (!mags.length) return 0
  mags.sort((a, b) => a - b)
  return mags[Math.min(mags.length - 1, Math.floor(mags.length * LIQ_PERCENTILE))]
}

/** 0 - 1 depth of a change against the scale (a gentle curve so faint changes still show). */
export function liquidityDepth(change, scale) {
  if (!Number.isFinite(change) || change === 0 || !(scale > 0)) return 0
  return Math.min(1, Math.abs(change) / scale) ** 0.7
}

/**
 * The grid: `strikes` (the band, any order) x the buckets either matrix touched, oldest first. `ceMatrix` / `peMatrix` are
 * { buckets, perStrikeChange: Map(strike -> Map(bucketTime -> change)) } (chart seconds). `spotBars` are 1-minute { time, close }
 * (chart seconds). `maxColumns` keeps the newest buckets. Returns { rows (strikes high to low), columns, cells: Map(`${strike}|${t}`
 * -> { ce, pe }), scale, spot: [{ t, price }] (only bars inside the columns' span) }.
 */
export function liquidityGrid({ ceMatrix, peMatrix, strikes, bucketSeconds, spotBars = [], maxColumns = Infinity }) {
  const rows = [...new Set(strikes)].sort((a, b) => b - a)
  const set = new Set([...(ceMatrix?.buckets ?? []), ...(peMatrix?.buckets ?? [])])
  let columns = [...set].sort((a, b) => a - b)
  if (columns.length > maxColumns) columns = columns.slice(columns.length - maxColumns)
  const cells = new Map()
  const list = []
  for (const strike of rows) {
    const ce = ceMatrix?.perStrikeChange?.get(strike)
    const pe = peMatrix?.perStrikeChange?.get(strike)
    for (const t of columns) {
      const c = { ce: ce?.get(t) ?? 0, pe: pe?.get(t) ?? 0 }
      if (c.ce !== 0 || c.pe !== 0) { cells.set(`${strike}|${t}`, c); list.push(c) }
    }
  }
  const from = columns[0]
  const to = columns.length ? columns[columns.length - 1] + bucketSeconds : null
  const spot = from == null ? [] : (spotBars ?? []).filter((b) => b.time >= from && b.time < to && Number.isFinite(b.close)).map((b) => ({ t: b.time, price: b.close }))
  return { rows, columns, cells, scale: liquidityScale(list), spot }
}

/** Where a price sits on the strike rows (0 = the top row's centre, 1 = the next ...), by linear steps between strikes; null outside them. */
export function spotRowPosition(price, rows) {
  if (!rows.length || !Number.isFinite(price)) return null
  const top = rows[0]
  const bottom = rows[rows.length - 1]
  const step = rows.length > 1 ? (top - bottom) / (rows.length - 1) : 1
  if (price > top + step / 2 || price < bottom - step / 2) return null
  return (top - price) / step
}
