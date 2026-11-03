// The footprint's finished / unfinished auction at each bar's high and low (orderFlowMath's auctionOf, read by
// analyzeBars), and the unfinished extremes' revisits (unfinishedRevisits) - the dotted lines on the footprint.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeBars, auctionOf, unfinishedRevisits } from '../src/orderFlowMath.js'

const row = (price, sell, buy) => ({ price, sell, buy })

test('a finished high has no selling at the top row, a finished low no buying at the bottom one; both sides = unfinished', () => {
  // 0 x 126 at the high, 38 x 0 at the low: both finished.
  assert.deepEqual(auctionOf([row(100, 38, 0), row(101, 20, 30), row(102, 0, 126)]), { high: { kind: 'finished', price: 102 }, low: { kind: 'finished', price: 100 } })
  // 33 x 45 at the low and 12 x 9 at the high: both unfinished.
  assert.deepEqual(auctionOf([row(100, 33, 45), row(101, 20, 30), row(102, 12, 9)]), { high: { kind: 'unfinished', price: 102 }, low: { kind: 'unfinished', price: 100 } })
  // Only sellers at the high (40 x 0) / only buyers at the low (0 x 40): neither - the other side alone traded there.
  assert.deepEqual(auctionOf([row(100, 0, 40), row(102, 40, 0)]), { high: null, low: null })
  assert.deepEqual(auctionOf([]), { high: null, low: null })
})

test('analyzeBars marks each exact bar; an estimated day (rows spread from candles) has none', () => {
  const bar = (t, levels) => ({ time: t, open: 100, high: Math.max(...levels.map((l) => l.price)), low: Math.min(...levels.map((l) => l.price)), close: 101, buy: levels.reduce((a, l) => a + l.buy, 0), sell: levels.reduce((a, l) => a + l.sell, 0), delta: levels.reduce((a, l) => a + l.buy - l.sell, 0), levels })
  const bars = [bar(0, [row(102, 0, 126), row(101, 20, 30), row(100, 33, 45)])]
  const [exact] = analyzeBars(bars, { rowSize: 1, minVolume: 1 })
  assert.deepEqual(exact.auction, { high: { kind: 'finished', price: 102 }, low: { kind: 'unfinished', price: 100 } })
  const [estimated] = analyzeBars(bars, { rowSize: 1, minVolume: 1, estimated: true })
  assert.equal(estimated.auction, undefined)
})

test('an unfinished extreme stays open until a later bar trades back into its row', () => {
  const bars = [
    { high: 102, low: 100, auction: { high: { kind: 'unfinished', price: 102 }, low: { kind: 'unfinished', price: 100 } } },
    { high: 101.5, low: 101.2, auction: { high: null, low: null } },          // touches neither row (102 - 103, 100 - 101)
    { high: 102.2, low: 101, auction: { high: { kind: 'finished', price: 102 }, low: null } },   // back up into 102
  ]
  const r = unfinishedRevisits(bars, 1)
  assert.deepEqual(r.get(0), { high: { price: 102, until: 2 }, low: { price: 100, until: null } })   // 100 never revisited yet
  assert.equal(r.has(1), false)
  assert.equal(r.has(2), false)   // a finished extreme draws no line
  // A later bar reaching into the low row (below 101 with 1-point rows) revisits it.
  assert.equal(unfinishedRevisits([...bars, { high: 101, low: 100.6, auction: {} }], 1).get(0).low.until, 3)
})
