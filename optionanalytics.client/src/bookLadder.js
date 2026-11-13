// The Order Flow page's "Chart and order book" card (OrderBookChartCard.jsx; asked for - "on Order Flow the liquidity
// heatmap on the futures chart, like the one I sent": the candles with the book standing beside them, lots waiting per
// 5 points, buyers / sellers, what was pulled, the nearest big buyers and sellers). Pure, so it is tested.
//
// The LADDER at the clock, in rows of `row` points (NIFTY 5, BANKNIFTY / SENSEX 10 by default):
//  - WAITING: the book now (the live push's whole book - 200 levels a side on Dhan's full depth; a replayed day the book
//    column at the clock), bids and offers added up a row;
//  - BOUGHT / SOLD: the aggressor buy / sell volume traded in the row over the last `windowMin` minutes (the footprint's
//    1-minute bars - the minutes that overlap the window, up to the clock);
//  - PULLED: resting quantity cancelled in the row over the window - from consecutive book columns, a drop at a row that
//    stayed AWAY from the touch in both (bids below both best bids, offers above both best offers), so it cannot have
//    traded - the same rule the PULL signals use (orderFlowMath.pullStackSignals) - and that the newer book still reaches
//    (a level that fell off the book's far edge as price moved is out of view, not cancelled);
//  - BIG: a row holding at least BIG_FACTOR x the median waiting row of its side; the NEAREST big buyers under the price
//    and big sellers over it, adjacent big rows read as one zone.
// Nothing after the clock is read: the book given is the one at the clock, the columns and bars are cut to it.

export const LADDER_ROWS = { NIFTY: 5, BANKNIFTY: 10, SENSEX: 10 }
export const LADDER_ROW_CHOICES = [1, 2, 5, 10, 20, 25, 50]
export const LADDER_WINDOWS = [1, 2, 5, 10, 15]
export const BIG_FACTOR = 2.5
export const ROWS_EACH = 12
const MAX_GAP_MS = 60_000
const MIN = 60_000

const round2 = (v) => Math.round(v * 100) / 100
const rowStart = (price, row) => round2(Math.floor(price / row + 1e-9) * row)
const levelOf = (l) => (Array.isArray(l) ? [l[0], l[1]] : [l?.price, l?.quantity])

/** The ladder's row: a whole number of the book columns' / bars' own rows (`columnRow`), at least one - a 5-point row
 *  of 1-point columns is exact; asked for 5 on 2-point columns it is 6. */
export function ladderRow(row, columnRow) {
  if (!(row > 0)) return columnRow > 0 ? columnRow : 1
  if (!(columnRow > 0)) return row
  return round2(Math.max(1, Math.ceil(row / columnRow - 1e-9)) * columnRow)
}

const sideMap = (levels, row) => {
  const out = new Map()
  for (const l of levels ?? []) {
    const [p, q] = levelOf(l)
    if (!(p > 0) || !(q > 0)) continue
    const k = rowStart(p, row)
    out.set(k, (out.get(k) ?? 0) + q)
  }
  return out
}

const median = (xs) => {
  const v = xs.filter((x) => x > 0).sort((a, b) => a - b)
  return v.length ? v[Math.floor((v.length - 1) / 2)] : 0
}

/** Quantity pulled a row over the window, per side: Map(rowStart -> quantity) - see the header. */
export function pulledByRow(columns, { clockMs, windowMs, row }) {
  const bids = new Map()
  const asks = new Map()
  const list = columns ?? []
  const from = clockMs - windowMs
  // The first column inside the window and the one before it (the window's baseline).
  let i = list.length - 1
  while (i > 0 && list[i - 1].t > from) i--
  const best = (levels, pick) => {
    let b = null
    for (const l of levels ?? []) { const [p, q] = levelOf(l); if (q > 0 && p > 0 && (b == null || pick(p, b))) b = p }
    return b
  }
  for (let k = Math.max(1, i); k < list.length; k++) {
    const a = list[k - 1]
    const b = list[k]
    if (b.t > clockMs || b.t <= from || b.t - a.t > MAX_GAP_MS) continue
    const aBid = best(a.bids, (p, x) => p > x)
    const bBid = best(b.bids, (p, x) => p > x)
    const aAsk = best(a.asks, (p, x) => p < x)
    const bAsk = best(b.asks, (p, x) => p < x)
    if (aBid == null || bBid == null || aAsk == null || bAsk == null) continue
    const drop = (aLevels, bLevels, away, into) => {
      const now = new Map()
      for (const l of bLevels ?? []) { const [p, q] = levelOf(l); now.set(p, (now.get(p) ?? 0) + (q > 0 ? q : 0)) }
      for (const l of aLevels ?? []) {
        const [p, q] = levelOf(l)
        if (!(q > 0) || !away(p)) continue
        const gone = q - (now.get(p) ?? 0)
        if (gone > 0) { const r = rowStart(p, row); into.set(r, (into.get(r) ?? 0) + gone) }
      }
    }
    // Away from the touch in both, and still INSIDE the newer book: the book is 200 (20, 5) levels deep, so as price
    // moves the far levels fall off its edge - gone from view, not cancelled.
    const bidCut = Math.min(aBid, bBid)
    const askCut = Math.max(aAsk, bAsk)
    const bidEdge = best(b.bids, (p, x) => p < x)
    const askEdge = best(b.asks, (p, x) => p > x)
    drop(a.bids, b.bids, (p) => p < bidCut && p >= bidEdge, bids)
    drop(a.asks, b.asks, (p) => p > askCut && p <= askEdge, asks)
  }
  return { bids, asks }
}

/** Aggressor buy / sell volume a row over the window: the 1-minute bars ({ time, levels: [{ price, buy, sell }] }) that
 *  overlap (clock - window, clock]. */
export function tradedByRow(minuteBars, { clockMs, windowMs, row }) {
  const bought = new Map()
  const sold = new Map()
  const from = clockMs - windowMs
  for (let i = (minuteBars?.length ?? 0) - 1; i >= 0; i--) {
    const bar = minuteBars[i]
    const start = typeof bar.time === 'number' ? bar.time : new Date(bar.time).getTime()
    if (start > clockMs) continue
    if (start + MIN <= from) break
    for (const l of bar.levels ?? []) {
      const r = rowStart(l.price, row)
      if (l.buy > 0) bought.set(r, (bought.get(r) ?? 0) + l.buy)
      if (l.sell > 0) sold.set(r, (sold.get(r) ?? 0) + l.sell)
    }
  }
  return { bought, sold }
}

// The nearest zone of big rows from the price outward on one side: { lo, hi (the zone's top edge), lots, rows }.
function nearestZone(rows, side, price, row) {
  const bigKey = side === 'bid' ? 'bigBid' : 'bigAsk'
  const qty = side === 'bid' ? 'bid' : 'ask'
  const ordered = side === 'bid'
    ? rows.filter((r) => r.price <= price).sort((a, b) => b.price - a.price)
    : rows.filter((r) => r.price + row > price).sort((a, b) => a.price - b.price)
  const first = ordered.findIndex((r) => r[bigKey])
  if (first < 0) return null
  const zone = [ordered[first]]
  for (let k = first + 1; k < ordered.length && ordered[k][bigKey] && Math.abs(ordered[k].price - zone.at(-1).price - (side === 'bid' ? -row : row)) < 1e-6; k++) zone.push(ordered[k])
  const lo = Math.min(...zone.map((r) => r.price))
  const hi = round2(Math.max(...zone.map((r) => r.price)) + row)
  return { lo, hi, quantity: zone.reduce((s, r) => s + r[qty], 0), rows: zone.length, distance: side === 'bid' ? round2(Math.max(0, price - hi)) : round2(Math.max(0, lo - price)) }
}

/**
 * The ladder at the clock (see the header). `book` { bids, asks } of { price, quantity } (or [price, quantity]) - the
 * book AT the clock; `columns` the heatmap's book columns ({ t, bids, asks }); `minuteBars` the footprint's 1-minute
 * bars; `row` the ladder's row (already ladderRow'd); `price` the last price; `rowsEach` rows a side the bars are scaled
 * on. Quantities stay in contracts (the card shows lots). Returns { row, price, priceRow, rows (top to bottom: { price,
 * bid, ask, bought, sold, pulledBid, pulledAsk, bigBid, bigAsk }), maxWaiting, maxTraded, buyers, sellers, bidQty,
 * askQty, pulledBidQty, pulledAskQty, boughtQty, soldQty } - the totals over the rows within `rowsEach` of the price.
 */
export function bookLadder({ book, columns, minuteBars, clockMs, row, price, windowMin = 5, rowsEach = ROWS_EACH }) {
  if (!(row > 0) || !(price > 0)) return null
  const windowMs = Math.max(1, windowMin) * MIN
  const bids = sideMap(book?.bids, row)
  const asks = sideMap(book?.asks, row)
  const pulled = clockMs != null ? pulledByRow(columns, { clockMs, windowMs, row }) : { bids: new Map(), asks: new Map() }
  const traded = clockMs != null ? tradedByRow(minuteBars, { clockMs, windowMs, row }) : { bought: new Map(), sold: new Map() }
  const priceRow = rowStart(price, row)
  const lo = round2(priceRow - rowsEach * row)
  const hi = round2(priceRow + rowsEach * row)
  const keys = new Set([...bids.keys(), ...asks.keys()])
  for (let k = 0; k <= 2 * rowsEach; k++) keys.add(round2(lo + k * row))
  for (const m of [pulled.bids, pulled.asks, traded.bought, traded.sold]) for (const k of m.keys()) if (k >= lo && k <= hi) keys.add(k)
  const bidMedian = median([...bids.values()])
  const askMedian = median([...asks.values()])
  const rows = [...keys].sort((a, b) => b - a).map((p) => {
    const bid = bids.get(p) ?? 0
    const ask = asks.get(p) ?? 0
    return {
      price: p, bid, ask, bought: traded.bought.get(p) ?? 0, sold: traded.sold.get(p) ?? 0,
      pulledBid: pulled.bids.get(p) ?? 0, pulledAsk: pulled.asks.get(p) ?? 0,
      bigBid: bidMedian > 0 && bids.size >= 3 && bid >= BIG_FACTOR * bidMedian,
      bigAsk: askMedian > 0 && asks.size >= 3 && ask >= BIG_FACTOR * askMedian,
    }
  })
  const near = rows.filter((r) => r.price >= lo && r.price <= hi)
  const sum = (key) => near.reduce((s, r) => s + r[key], 0)
  return {
    row, price, priceRow, rows, windowMin,
    maxWaiting: Math.max(0, ...near.map((r) => Math.max(r.bid, r.ask))),
    maxTraded: Math.max(0, ...near.map((r) => Math.max(r.bought, r.sold))),
    buyers: nearestZone(rows, 'bid', price, row),
    sellers: nearestZone(rows, 'ask', price, row),
    bidQty: sum('bid'), askQty: sum('ask'), pulledBidQty: sum('pulledBid'), pulledAskQty: sum('pulledAsk'),
    boughtQty: sum('bought'), soldQty: sum('sold'),
  }
}

/** The ladder row holding `price` (null outside the rows). */
export const ladderRowAt = (ladder, price) => (ladder && Number.isFinite(price) ? ladder.rows.find((r) => price >= r.price && price < r.price + ladder.row) ?? null : null)
