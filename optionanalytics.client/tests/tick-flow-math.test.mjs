import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateTickBars, barStats, bubbleRadius, bubbleScaleMax, cumulativeDelta, diagonalImbalances, fmtQty, axisTicks } from '../src/tickFlowMath.js'

const T = Date.UTC(2026, 10, 24, 4, 0, 0)
const bar = (min, o, h, l, c, levels) => ({
  time: new Date(T + min * 60_000).toISOString(), open: o, high: h, low: l, close: c,
  buy: levels.reduce((a, x) => a + x[1], 0), sell: levels.reduce((a, x) => a + x[2], 0), prints: 3,
  levels: levels.map(([price, buy, sell]) => ({ price, buy, sell })),
})

test('minute bars become a bigger bar with the levels added up price by price', () => {
  const out = aggregateTickBars([bar(0, 100, 102, 99, 101, [[102, 5, 1], [100, 2, 3]]), bar(1, 101, 103, 100, 102, [[103, 4, 0], [100, 1, 1]]), bar(5, 102, 102, 102, 102, [[102, 1, 1]])], 5)
  assert.equal(out.length, 2)
  const first = out[0]
  assert.deepEqual([first.open, first.high, first.low, first.close], [100, 103, 99, 102])
  assert.deepEqual(first.levels.map((l) => [l.price, l.buy, l.sell]), [[103, 4, 0], [102, 5, 1], [100, 3, 4]])
  assert.equal(first.buy, 12)
  assert.equal(first.sell, 5)
})

test('delta, total, POC and the running delta', () => {
  const b = bar(0, 100, 102, 99, 101, [[102, 5, 1], [101, 9, 9], [100, 2, 3]])
  assert.deepEqual(barStats(b), { delta: (5 + 9 + 2) - (1 + 9 + 3), total: 29, poc: 101 })
  assert.deepEqual(cumulativeDelta([b, bar(1, 1, 1, 1, 1, [[1, 1, 4]])]), [3, 0])
})

test('diagonal imbalances: buyers against the sellers one row below, sellers against the buyers one row above', () => {
  // high -> low
  const levels = [
    { price: 103, buy: 30, sell: 1 }, // 30 buys vs 8 sells one row below (102): 30 >= 3 x 8 -> BUY imbalance
    { price: 102, buy: 1, sell: 8 },
    { price: 101, buy: 2, sell: 2 },
    { price: 100, buy: 0, sell: 9 },  // 9 sells vs 2 buys one row above (101): 9 >= 3 x 2 -> SELL imbalance
  ]
  const r = diagonalImbalances(levels, 3, 1)
  assert.deepEqual([...r.buy], [103])
  assert.deepEqual([...r.sell], [100])
  // A higher ratio drops the weaker one; a minimum quantity drops small rows.
  assert.deepEqual([...diagonalImbalances(levels, 5, 1).sell], [])
  assert.deepEqual([...diagonalImbalances(levels, 3, 10).buy], [103])
  assert.deepEqual([...diagonalImbalances(levels, 3, 40).buy], [])
  // The top row has no row above and the bottom none below.
  assert.deepEqual([...diagonalImbalances([{ price: 1, buy: 50, sell: 50 }], 3, 1).buy], [])
})

test('a bubble: area follows the order size, never under the minimum or over the maximum radius', () => {
  assert.equal(bubbleRadius(0, 100), 3)
  assert.equal(bubbleRadius(100, 100), 34)
  assert.equal(bubbleRadius(10_000, 100), 34)
  const small = bubbleRadius(10, 1000)
  const big = bubbleRadius(1000, 1000)
  assert.ok(small < big)
  // Area ~ quantity (above the minimum radius): 4x the quantity = 2x the (radius - rMin).
  assert.ok(Math.abs((bubbleRadius(400, 1600) - 3) / (bubbleRadius(100, 1600) - 3) - 2) < 1e-9)
})

test('the biggest bubble is the 99th percentile - one giant print does not shrink the rest to dots', () => {
  const qs = Array.from({ length: 200 }, (_, i) => ({ qty: 10 + (i % 10) }))
  qs.push({ qty: 100_000 })
  assert.ok(bubbleScaleMax(qs) < 100)
  assert.equal(bubbleScaleMax([]), 1)
})

test('lots, units and axis ticks', () => {
  assert.equal(fmtQty(650, 65, true), '10')
  assert.equal(fmtQty(97, 65, true), '1.5')
  assert.equal(fmtQty(650, 65, false), '650')
  assert.equal(fmtQty(65 * 25_000, 65, true), '25.0K')
  assert.deepEqual(axisTicks(24990, 25010, 4), [24990, 24995, 25000, 25005, 25010])
})
