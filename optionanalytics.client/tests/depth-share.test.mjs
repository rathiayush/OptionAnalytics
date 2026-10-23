// The Market depth card's bid share by depth (bidShare): the book's lean near the price against through all of it
// (Dhan's 200 levels a side on NSE futures).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bidShare, findWalls } from '../src/orderFlowMath.js'

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
