// The Market depth card's bid share by depth (bidShare): the book's lean near the price against through all of it
// (Dhan's 200 levels a side on NSE futures); the heatmap's price range (heatmapPriceRange) keeps the whole latest book.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bidShare, findWalls, heatmapPriceRange } from '../src/orderFlowMath.js'

const side = (n, qty, from, step) => Array.from({ length: n }, (_, i) => ({ price: from + i * step, quantity: typeof qty === 'function' ? qty(i) : qty, orders: 1 }))

test('bidShare: the top N levels of each side, or all of them', () => {
  // Bids heavy near the price, offers heavy deeper down the book.
  const book = { bids: side(200, (i) => (i < 20 ? 300 : 100), 25599.9, -0.1), asks: side(200, (i) => (i < 20 ? 100 : 300), 25600.1, 0.1) }
  assert.equal(bidShare(book, 20), 0.75)
  assert.equal(bidShare(book), 0.3) // all 200: (20*300 + 180*100) / (that + 20*100 + 180*300) = 24000 / 80000
  assert.equal(bidShare(book, 50), (20 * 300 + 30 * 100) / (20 * 300 + 30 * 100 + 20 * 100 + 30 * 300))
  assert.equal(bidShare({ bids: [], asks: [] }), null)
  assert.equal(bidShare(null), null)
  // Heatmap-style [price, quantity] rows too.
  assert.equal(bidShare({ bids: [[100, 3]], asks: [[101, 1]] }), 0.75)
})

test('walls are found through the whole 200-level book, not only the first 50 levels', () => {
  const bids = side(200, 100, 25599.9, -0.1)
  bids[120] = { ...bids[120], quantity: 5000 } // a wall 12 points under the price
  const book = { bids, asks: side(200, 100, 25600.1, 0.1) }
  assert.ok(findWalls(book).bids.has(bids[120].price))
  assert.ok(!findWalls({ bids: bids.slice(0, 50), asks: book.asks.slice(0, 50) }).bids.has(bids[120].price))
})

// A heatmap column: n rows a side of `step` around `mid`, [price, quantity].
const column = (mid, n, step) => ({
  bids: Array.from({ length: n }, (_, i) => [mid - (i + 1) * step, 100]),
  asks: Array.from({ length: n }, (_, i) => [mid + (i + 1) * step, 100]),
})

test('heatmap: the latest 200-level book is shown whole, not cut to 160 rows', () => {
  // 200 rows a side in 0.5-point rows: 25500 to 25700, 400 rows - over the old 160-row cap.
  const range = heatmapPriceRange([column(25600, 200, 0.5)], 0.5, 25600)
  assert.deepEqual(range, { hi: 25700, lo: 25500 })
})

test('heatmap: a trending day still centres on the latest price, with its whole book in view', () => {
  // Earlier columns 300 points lower, the latest book 20 rows a side: about 160 rows around the latest mid.
  const visible = [column(25300, 20, 0.5), column(25450, 20, 0.5), column(25600, 20, 0.5)]
  assert.deepEqual(heatmapPriceRange(visible, 0.5, 25600), { hi: 25610, lo: 25560 })
  // The same day with a 200-level latest book: the window widens to hold all of it.
  const deep = [column(25300, 20, 0.5), column(25600, 200, 0.5)]
  assert.deepEqual(heatmapPriceRange(deep, 0.5, 25600), { hi: 25700, lo: 25500 })
  // A narrow day is shown whole, as before.
  assert.deepEqual(heatmapPriceRange([column(25600, 10, 0.5)], 0.5, 25600), { hi: 25605, lo: 25595 })
  assert.equal(heatmapPriceRange([{ bids: [], asks: [] }], 0.5, null), null)
})
