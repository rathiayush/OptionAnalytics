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

import { barFromBubbles, countUpTo, coveragePct, prepareTickDay, replayCut, weekdayChoices } from '../src/tickFlowMath.js'

const B0 = Date.UTC(2026, 10, 24, 3, 45, 0) // 09:15 IST
const iso = (ms) => new Date(ms).toISOString()
const bub = (sec, price, qty, buy) => ({ time: iso(B0 + sec * 1000), price, qty, buy, prints: 1 })
function day() {
  const bubbles = [bub(1, 100, 65, true), bub(20, 101, 130, true), bub(40, 100, 65, false), bub(61, 102, 65, true), bub(90, 101, 195, false), bub(130, 103, 65, true)]
  const barOf = (min) => barFromBubbles(prepareTickDay({ bubbles }).bubbles, B0 + min * 60_000, 1)
  const bars = [0, 1, 2].map(barOf).map((b) => ({ ...b, time: iso(b.ms) }))
  const quotes = [{ time: iso(B0), bid: 99.5, bidQty: 10, ask: 100, askQty: 10 }, { time: iso(B0 + 100_000), bid: 101.5, bidQty: 20, ask: 102, askQty: 20 }]
  return prepareTickDay({ meta: {}, bars, bubbles, quotes })
}

test('a minute bar built from bubbles: rows, totals, open / high / low / close', () => {
  const d = day()
  const b = barFromBubbles(d.bubbles, B0, 1)
  assert.equal(b.buy, 195)
  assert.equal(b.sell, 65)
  assert.deepEqual([b.open, b.high, b.low, b.close], [100, 101, 100, 100])
  assert.deepEqual(b.levels.map((l) => [l.price, l.buy, l.sell]), [[101, 130, 0], [100, 65, 65]])
  assert.equal(barFromBubbles(d.bubbles, B0 + 10 * 60_000, 1), null)
})

test('a replay cut shows only what had happened by the clock - finished minutes whole, the running minute from its orders so far', () => {
  const d = day()
  const at = replayCut(d, B0 + 30_000, 1) // 30 s in: the first two orders only
  assert.equal(at.bubbles.length, 2)
  assert.equal(at.bars.length, 1)
  assert.equal(at.bars[0].buy, 195)
  assert.equal(at.bars[0].sell, 0)          // the sell at 40 s has not happened yet
  assert.equal(at.lastPrice, 101)
  assert.equal(at.bid, 99.5)                // the second quote (at 100 s) is not out yet

  const later = replayCut(d, B0 + 100_000, 1) // 1:40: minute 0 is whole, minute 1 has two orders
  assert.equal(later.bars.length, 2)
  assert.equal(later.bars[0].sell, 65)
  assert.equal(later.bars[1].buy, 65)
  assert.equal(later.bars[1].sell, 195)
  assert.equal(later.bid, 101.5)
})

test('a cut at any clock equals the whole day up to it: totals match the bubbles counted directly', () => {
  const d = day()
  for (const sec of [0, 5, 59, 60, 61, 119, 125, 200]) {
    const cut = replayCut(d, B0 + sec * 1000, 1)
    const direct = d.bubbles.filter((b) => b.ms <= B0 + sec * 1000)
    assert.equal(cut.bars.reduce((a, b) => a + b.buy + b.sell, 0), direct.reduce((a, b) => a + b.qty, 0), `at ${sec}s`)
    assert.equal(cut.bubbles.length, direct.length)
  }
  assert.equal(replayCut(null, 5, 1), null)
})

test('countUpTo, the weekdays a replay can ask for, and coverage', () => {
  assert.equal(countUpTo([{ ms: 1 }, { ms: 5 }, { ms: 5 }, { ms: 9 }], 5), 3)
  assert.equal(countUpTo([], 5), 0)
  // 2026-11-24 is a Tuesday: back over the weekend.
  assert.deepEqual(weekdayChoices('2026-11-24', 5), ['2026-11-24', '2026-11-23', '2026-11-20', '2026-11-19', '2026-11-18'])
  assert.equal(weekdayChoices('2026-11-22', 2)[0], '2026-11-20') // a Sunday starts on the Friday
  assert.equal(coveragePct(95, 100), 95)
  assert.equal(coveragePct(120, 100), 100)
  assert.equal(coveragePct(5, 0), null)
})
