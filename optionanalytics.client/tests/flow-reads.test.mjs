// The footprint's SCORED absorption / exhaustion (flowReads.js): each on its case, both sides, not without each part,
// the book's part, and no look-ahead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeBars } from '../src/orderFlowMath.js'
import { scoredFlowReads, withScoredReads } from '../src/flowReads.js'

const MIN = 60_000
const T0 = Date.parse('2026-11-13T09:15:00+05:30')
// A footprint bar from its rows [[price, buy, sell], ...] (1-point rows).
const bar = (i, open, close, rows) => {
  const levels = rows.map(([price, buy, sell]) => ({ price, buy, sell }))
  const buy = levels.reduce((s, l) => s + l.buy, 0), sell = levels.reduce((s, l) => s + l.sell, 0)
  const prices = levels.map((l) => l.price)
  return { time: T0 + i * MIN, open, close, high: Math.max(...prices), low: Math.min(...prices), buy, sell, delta: buy - sell, volume: buy + sell, trades: 10, levels }
}
// A quiet, balanced bar around `mid`: ~1,000 traded, 500 a side.
const quiet = (i, mid) => bar(i, mid, mid + 1, [[mid - 2, 60, 70], [mid - 1, 100, 110], [mid, 140, 130], [mid + 1, 110, 100], [mid + 2, 90, 90]])
const base = () => Array.from({ length: 8 }, (_, i) => quiet(i, 100))
const read = (bars, options = {}) => scoredFlowReads(analyzeBars(bars, { rowSize: 1 }), { rowSize: 1, ...options })
const mirror = (bars) => bars.map((b) => bar((b.time - T0) / MIN, 200 - b.open, 200 - b.close, b.levels.map((l) => [200 - l.price, l.sell, l.buy])))

// Sellers hammer a new low (94 - 95) and the bar closes back at 99.
const absorbed = (i = 8) => bar(i, 98, 99, [[94, 100, 700], [95, 150, 800], [96, 120, 100], [97, 130, 90], [98, 140, 80], [99, 160, 60]])

test('absorption: heavy selling at a new low that closed back above it - scored, with why; the mirror at a high', () => {
  const bars = [...base(), absorbed()]
  const r = read(bars).at(-1)
  assert.equal(r.absorption.length, 1)
  const a = r.absorption[0]
  assert.equal(a.side, 'buy')
  assert.equal(a.price, 94)
  assert.deepEqual([a.low, a.high], [94, 95])
  assert.equal(a.volume, 1500)
  assert.ok(a.score >= 70, `a clean case scores high: ${a.score}`)
  assert.equal(a.parts.effort, 1)
  assert.equal(a.parts.efficiency, 1, 'sellers ahead on the bar, yet it closed up')
  assert.equal(a.parts.book, null, 'no book given: that part is not read')
  assert.match(a.text, /^Selling absorbed \(score \d+\): .*selling at 94–96.*closed 100% off the low.*price did not follow.*a new 10-bar low/)
  assert.deepEqual(read(bars).slice(0, -1).flatMap((x) => [...x.absorption, ...x.exhaustion]), [], 'quiet bars read nothing')
  // The mirror: buying absorbed at a new high.
  const m = read(mirror(bars)).at(-1).absorption
  assert.equal(m.length, 1)
  assert.deepEqual([m[0].side, m[0].price, m[0].score], ['sell', 106, a.score])
  assert.match(m[0].text, /^Buying absorbed/)
})

test('absorption is not read without each part: light selling, a close at the low, buyers heavier there', () => {
  const light = bar(8, 98, 99, [[94, 100, 120], [95, 150, 130], [96, 120, 100], [97, 130, 90], [98, 140, 80], [99, 160, 60]])
  assert.deepEqual(read([...base(), light]).at(-1).absorption, [], 'no heavy selling at the low')
  const closedLow = bar(8, 98, 95, [[94, 100, 700], [95, 150, 800], [96, 120, 100], [97, 130, 90], [98, 140, 80], [99, 160, 60]])
  assert.deepEqual(read([...base(), closedLow]).at(-1).absorption, [], 'it closed in the zone - the selling won')
  const bought = bar(8, 98, 99, [[94, 900, 700], [95, 900, 800], [96, 120, 100], [97, 130, 90], [98, 140, 80], [99, 160, 60]])
  assert.deepEqual(read([...base(), bought]).at(-1).absorption.filter((x) => x.side === 'buy'), [], 'buyers were the heavier side there')
  // Fewer than three bars before it: nothing to call typical.
  assert.deepEqual(read([quiet(0, 100), quiet(1, 100), absorbed(2)]).at(-1).absorption, [])
})

test('absorption over several bars: selling at the same prices in the bars before counts as the same fight', () => {
  // Two bars sell into 94 - 95 and close weak; the third sells there again, lighter, and closes back up.
  const probe = (i) => bar(i, 97, 96, [[94, 60, 400], [95, 80, 450], [96, 150, 140], [97, 160, 150]])
  const hold = bar(10, 96, 98, [[94, 80, 250], [95, 100, 260], [96, 150, 100], [97, 160, 90], [98, 170, 80]])
  const alone = read([...base(), { ...hold, time: T0 + 8 * MIN }]).at(-1).absorption
  const after = read([...base(), probe(8), probe(9), hold]).at(-1).absorption
  assert.equal(after.length, 1)
  assert.equal(after[0].volume, 510 + 850 + 850)
  assert.match(after[0].text, /over the last bars.*a retest of the 10-bar low/)
  assert.equal(after[0].parts.context, 0.5)
  assert.ok(alone[0].volume === 510 && alone[0].parts.effort < after[0].parts.effort, 'the fight so far is the bigger effort')
})

test('the book: bids that showed little, took more and still stand score over bids that were eaten', () => {
  const bars = [...base(), absorbed()]
  const start = T0 + 8 * MIN
  const col = (sec, q) => ({ t: start + sec * 1000, bids: [[94, q], [95, q]], asks: [[100, 200]] })
  const none = read(bars).at(-1).absorption[0]
  // 300 shown at the zone all through the bar, 1,500 traded into it: refilled.
  const held = read(bars, { columns: [col(2, 150), col(20, 150), col(50, 150)] }).at(-1).absorption[0]
  assert.equal(held.parts.book, 1)
  assert.match(held.text, /the bids there held \/ refilled/)
  // 6,000 shown, 1,500 traded, nothing left at the end: the bids were pulled or eaten.
  const eaten = read(bars, { columns: [col(2, 3000), col(20, 1000), col(50, 0)] }).at(-1).absorption[0]
  assert.equal(eaten.parts.book, 0.125)
  assert.ok(held.score > none.score && none.score > eaten.score)
  // Columns of another minute are not this bar's.
  assert.equal(read(bars, { columns: [{ ...col(0, 150), t: start - 5000 }] }).at(-1).absorption[0].parts.book, null)
})

test('a level given at the extreme adds to the context', () => {
  const bars = [...base(), absorbed()]
  const plain = read(bars).at(-1).absorption[0]
  const atLevel = read(bars, { levels: [{ price: 93, label: 'VWAP' }] }).at(-1).absorption[0]
  assert.ok(atLevel.parts.context > plain.parts.context)
  assert.match(atLevel.text, /at VWAP/)
  assert.equal(read(bars, { levels: [{ price: 80, label: 'far' }] }).at(-1).absorption[0].parts.context, plain.parts.context)
  // A level that moves is given bar by bar: only the bar's own counts.
  const perBar = read(bars, { levels: (i) => (i === bars.length - 1 ? [{ price: 94, label: 'VWAP' }] : [{ price: 80, label: 'VWAP' }]) }).at(-1).absorption[0]
  assert.equal(perBar.parts.context, atLevel.parts.context)
})

// A strong push to a new high, a pause, then a weaker new high that closes back off it.
const push = (i) => bar(i, 101, 105, [[101, 300, 100], [102, 400, 120], [103, 500, 150], [104, 450, 130], [105, 350, 100]])
const pause = (i) => quiet(i, 103)
const fade = (i) => bar(i, 105, 104, [[103, 60, 90], [104, 130, 150], [105, 90, 80], [106, 15, 10], [107, 5, 5]])

test('exhaustion: a new high on less volume and delta than the last push, thin at the top, closed off it; the mirror at a low', () => {
  const bars = [...base(), push(8), pause(9), fade(10)]
  const all = read(bars)
  assert.deepEqual(all[8].exhaustion, [], 'the strong push itself is not exhausted')
  const e = all.at(-1).exhaustion
  assert.equal(e.length, 1)
  assert.equal(e[0].side, 'sell')
  assert.equal(e[0].price, 107)
  assert.ok(e[0].score >= 70, `score ${e[0].score}`)
  assert.ok(e[0].parts.volume > 0.7 && e[0].parts.delta === 1 && e[0].parts.thin > 0.8 && e[0].parts.value >= 0.6)
  assert.match(e[0].text, /^Buying exhausted \(score \d+\): a new 10-bar high · \d+% less volume than the last push · no buying delta behind it · little traded at the top · the busiest price did not follow · closed 75% off it/)
  const m = read(mirror(bars)).at(-1).exhaustion
  assert.deepEqual([m.length, m[0].side, m[0].price, m[0].score], [1, 'buy', 93, e[0].score])
  assert.match(m[0].text, /^Selling exhausted/)
})

test('exhaustion is not read without each part: no new high, a close at the high, a push stronger than the last', () => {
  const inside = bar(10, 104, 103, [[102, 60, 90], [103, 130, 150], [104, 90, 80], [105, 15, 10]])
  assert.deepEqual(read([...base(), push(8), pause(9), inside]).at(-1).exhaustion, [], 'not a new high')
  const closedHigh = bar(10, 105, 107, [[103, 60, 90], [104, 130, 150], [105, 90, 80], [106, 15, 10], [107, 5, 5]])
  assert.deepEqual(read([...base(), push(8), pause(9), closedHigh]).at(-1).exhaustion, [], 'it closed at the high')
  const stronger = bar(10, 104, 105, [[104, 500, 150], [105, 700, 200], [106, 900, 250], [107, 800, 200]])
  assert.deepEqual(read([...base(), push(8), pause(9), stronger]).at(-1).exhaustion, [], 'more volume, more delta, busy at the top')
})

test('the minimum score: a mark is drawn only from it; an estimated day and thin bars read nothing', () => {
  const bars = [...base(), absorbed()]
  const score = read(bars).at(-1).absorption[0].score
  assert.equal(read(bars, { minScore: score }).at(-1).absorption.length, 1)
  assert.equal(read(bars, { minScore: score + 1 }).at(-1).absorption.length, 0)
  // Bars with no rows (an estimated day's are a spread - the page does not pass them here) read nothing and do not fail.
  const noRows = bars.map((b) => ({ ...b, levels: [] }))
  assert.deepEqual(scoredFlowReads(noRows, { rowSize: 1 }).flatMap((x) => [...x.absorption, ...x.exhaustion]), [])
  assert.deepEqual(scoredFlowReads(null, { rowSize: 1 }), [])
})

test('no look-ahead: a bar\'s read is the same whatever comes after it; the bars keep everything else', () => {
  const bars = [...base(), absorbed(8), quiet(9, 98), push(10), pause(11), fade(12), quiet(13, 104)]
  const analyzed = analyzeBars(bars, { rowSize: 1 })
  const whole = scoredFlowReads(analyzed, { rowSize: 1 })
  assert.ok(whole.some((x) => x.absorption.length) && whole.some((x) => x.exhaustion.length))
  for (let k = 1; k <= bars.length; k++) assert.deepEqual(scoredFlowReads(analyzed.slice(0, k), { rowSize: 1 }), whole.slice(0, k))
  const shown = withScoredReads(analyzed, whole)
  assert.deepEqual(shown.map((b) => b.absorption), whole.map((x) => x.absorption))
  assert.deepEqual(shown.map((b) => [b.cvd, b.poc, b.stacked]), analyzed.map((b) => [b.cvd, b.poc, b.stacked]))
  assert.notEqual(shown[0], analyzed[0], 'the bars the scanner and the bias read are not touched')
})
