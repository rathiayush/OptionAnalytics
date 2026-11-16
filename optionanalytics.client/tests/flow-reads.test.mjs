// The footprint's SCORED absorption / exhaustion (flowReads.js): each on its case, both sides, not without each part,
// the book's part, and no look-ahead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeBars } from '../src/orderFlowMath.js'
import { scoredFlowReads, swingTracker, withScoredReads } from '../src/flowReads.js'

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
  assert.match(a.text, /^Selling absorbed \(score \d+\): .*selling at 94–96.*closed 100% off the low.*price did not follow.*a new session low/)
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
  assert.match(after[0].text, /over the last 3 bars.*a retest of the session low 94/)
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
  assert.match(e[0].text, /^Buying exhausted \(score \d+\): a new session high · \d+% less volume than the last push · no buying delta behind it · little traded at the top · the busiest price did not follow · closed 75% off it/)
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
  // The marks never change after their bar; a status is the one known at the clock - decided by a bar the clock has reached.
  const asOf = (reads, lastMs) => reads.map((x) => Object.fromEntries(Object.entries(x).map(([k, marks]) => [k, marks.map((m) => {
    const known = m.statusAt != null && new Date(m.statusAt).getTime() <= lastMs
    return { ...m, status: known ? m.status : 'pending', statusAt: known ? m.statusAt : null, text: known ? m.text : m.text.replace(/ · (CONFIRMED|FAILED) .*$/, '') }
  })])))
  assert.ok(whole.some((x) => [...x.absorption, ...x.exhaustion].some((m) => m.status !== 'pending')), 'some read was decided')
  for (let k = 1; k <= bars.length; k++) {
    const lastMs = new Date(analyzed[k - 1].time).getTime()
    assert.deepEqual(scoredFlowReads(analyzed.slice(0, k), { rowSize: 1 }), asOf(whole.slice(0, k), lastMs))
  }
  const shown = withScoredReads(analyzed, whole)
  assert.deepEqual(shown.map((b) => b.absorption), whole.map((x) => x.absorption))
  assert.deepEqual(shown.map((b) => [b.cvd, b.poc, b.stacked]), analyzed.map((b) => [b.cvd, b.poc, b.stacked]))
  assert.notEqual(shown[0], analyzed[0], 'the bars the scanner and the bias read are not touched')
})

test('adaptive: yesterday\'s bars at the same time of day are the yardstick from the first bars of the day', () => {
  // Today: one quiet bar, then the absorption bar - too few of today's bars alone.
  const today = [quiet(0, 100), { ...absorbed(1) }]
  assert.deepEqual(read(today).at(-1).absorption, [], 'one bar of today is no yardstick')
  const DAY = 86_400_000
  const yesterday = (offsetMin, mid) => ({ ...quiet(0, mid), time: T0 - DAY + offsetMin * MIN })
  const prior = [0, 1, 2, 3, 4].map((m) => yesterday(m, 100))
  const r = read(today, { prior }).at(-1).absorption
  assert.equal(r.length, 1)
  assert.match(r[0].text, /a new session low/)
  // Yesterday's bars far from this time of day (the afternoon) are not this bar's yardstick.
  const afternoon = [0, 1, 2, 3, 4].map((m) => yesterday(300 + m, 100))
  assert.deepEqual(read(today, { prior: afternoon }).at(-1).absorption, [])
  // Heavier bars yesterday at this time: the same selling is no longer heavy.
  const heavy = (m) => ({ ...bar(0, 100, 101, [[98, 600, 700], [99, 1000, 1100], [100, 1400, 1300], [101, 1100, 1000], [102, 900, 900]]), time: T0 - DAY + m * MIN })
  assert.deepEqual(read(today, { prior: [0, 1, 2, 3, 4, 5, 6].map(heavy) }).at(-1).absorption, [])
})

test('adaptive: the swings follow the market\'s own range - a swing is confirmed by 1.5x today\'s usual range', () => {
  const t = swingTracker()
  const b = (high, low) => ({ high, low })
  t.add(b(105, 100), 0, 6)
  t.add(b(110, 104), 1, 6)
  assert.equal(t.levels().swingHigh, null, 'not confirmed while price keeps rising')
  t.add(b(108, 105), 2, 6)
  assert.equal(t.levels().swingHigh, null, 'a pull-back smaller than the swing size is noise')
  t.add(b(106, 103.5), 3, 6)
  assert.deepEqual(t.levels().swingHigh, { price: 110, i: 1 }, 'back 6.5 from 110: a swing high')
  // The same moves in a market twice as wide are noise.
  const wide = swingTracker()
  for (const [i, x] of [b(105, 100), b(110, 104), b(108, 105), b(106, 103.5)].entries()) wide.add(x, i, 12)
  assert.equal(wide.levels().swingHigh, null)
})

test('a new low INSIDE the structure is not a break: under the last swing low it is', () => {
  // A day that fell from 100 to 90, bounced to 97, and dips to 95: not under the swing low 90 - no fresh break.
  const path = [100, 98, 96, 94, 92, 90, 92, 94, 96, 97]
  const day = path.map((m, i) => quiet(i, m))
  const dip = bar(path.length, 95, 97, [[93, 100, 700], [94, 150, 800], [95, 120, 100], [96, 130, 90], [97, 160, 60]])
  const r = read([...day, dip]).at(-1).absorption
  assert.ok(r.every((x) => !/a new session low|under the swing low/.test(x.text)), r.map((x) => x.text).join('\n'))
  // Down to 86: the session low (88) taken out - a break.
  const flush = bar(path.length, 89, 92, [[86, 100, 900], [87, 150, 900], [88, 120, 100], [89, 130, 90], [90, 140, 80], [91, 160, 60], [92, 150, 50]])
  assert.match(read([...day, flush]).at(-1).absorption[0].text, /a new session low/)
})

test('the fight runs as long as price stays at the price: five bars at 94 - 95 all count', () => {
  const probe = (i) => bar(i, 97, 96, [[94, 60, 300], [95, 80, 300], [96, 150, 140], [97, 160, 150]])
  const hold = bar(13, 96, 98, [[94, 80, 250], [95, 100, 260], [96, 150, 100], [97, 160, 90], [98, 170, 80]])
  const r = read([...base(), probe(8), probe(9), probe(10), probe(11), probe(12), hold]).at(-1).absorption
  assert.equal(r[0].volume, 510 + 5 * 600)
  assert.match(r[0].text, /over the last 6 bars/)
  // A bar between that left the price breaks the fight: only the bars after it count.
  const away = quiet(11, 104)
  const cut = read([...base(), probe(8), probe(9), probe(10), away, probe(12), hold]).at(-1).absorption
  assert.equal(cut[0].volume, 510 + 600)
})

test('a new day starts fresh: yesterday\'s bars in the list are not today\'s structure', () => {
  const DAY = 86_400_000
  const yesterday = [90, 92, 94].map((m, i) => ({ ...quiet(i, m), time: T0 - DAY + i * MIN }))
  const bars = [...yesterday, ...base(), absorbed()]
  const r = read(bars).at(-1).absorption
  assert.equal(r.length, 1)
  assert.match(r[0].text, /a new session low/, 'under today\'s low 98, though yesterday traded lower')
})

test('confirmation: a read waits for the market - confirmed when price leaves the level, failed when it trades through it', () => {
  const bars = [...base(), absorbed()]
  assert.equal(read(bars).at(-1).absorption[0].status, 'pending', 'just printed: waiting')
  // Next bar closes above the absorption bar's high (99): confirmed, at that bar.
  const up = bar(9, 99, 100.5, [[98, 300, 100], [99, 400, 120], [100, 300, 100], [101, 200, 80]])
  const c = read([...bars, up])[8].absorption[0]
  assert.equal(c.status, 'confirmed')
  assert.equal(new Date(c.statusAt).getTime(), T0 + 9 * MIN)
  assert.match(c.text, / · CONFIRMED \d\d:\d\d \(closed past 99\)$/)
  assert.equal(c.score, read(bars).at(-1).absorption[0].score, 'the score never changes')
  // A bar that trades under the zone's low (94): failed - even if it closes back up (it swept the level).
  const sweep = bar(9, 97, 100.5, [[93, 100, 500], [94, 100, 200], [95, 200, 100], [96, 200, 100], [97, 300, 100], [98, 300, 100], [99, 300, 100], [100, 300, 100], [101, 300, 100]])
  const f = read([...bars, sweep])[8].absorption[0]
  assert.equal(f.status, 'failed')
  assert.match(f.text, /FAILED \d\d:\d\d \(traded through 94\)$/)
  // Inside the bar's range: still waiting.
  assert.equal(read([...bars, quiet(9, 97)])[8].absorption[0].status, 'pending')
  // A new day: the read is not carried over.
  const tomorrow = { ...up, time: T0 + 86_400_000 }
  assert.equal(read([...bars, tomorrow])[8].absorption[0].status, 'pending')
})

test('confirmation of exhaustion: a close under the bar\'s low confirms it, a higher high fails it', () => {
  const bars = [...base(), push(8), pause(9), fade(10)]
  const down = bar(11, 104, 101.5, [[101, 100, 300], [102, 100, 300], [103, 100, 200], [104, 80, 100]])
  assert.equal(read([...bars, down])[10].exhaustion[0].status, 'confirmed')
  const higher = bar(11, 105, 106, [[104, 200, 100], [105, 300, 100], [106, 300, 100], [107, 200, 100], [108, 100, 50]])
  const f = read([...bars, higher])[10].exhaustion[0]
  assert.equal(f.status, 'failed')
  assert.match(f.text, /a new high past 107/)
})

test('an iceberg on the absorbing side in the zone is the strongest book evidence - only one known by the bar\'s end', () => {
  const bars = [...base(), absorbed()]
  const start = T0 + 8 * MIN
  const berg = (o) => ({ id: 1, isBid: true, price: 94, startedAt: new Date(start + 5000).toISOString(), detectedAt: new Date(start + 30_000).toISOString(), endedAt: null, traded: 900, maxDisplayed: 100, refills: 6, ...o })
  const plain = read(bars).at(-1).absorption[0]
  const withBerg = read(bars, { icebergs: [berg()] }).at(-1).absorption[0]
  assert.equal(withBerg.parts.book, 1)
  assert.match(withBerg.text, /an iceberg bid at 94 \(6 refills\)/)
  assert.ok(withBerg.score > plain.score)
  // An offer iceberg, one outside the zone, one only detected after the bar, one that ended before it: none count.
  for (const o of [{ isBid: false }, { price: 99 }, { detectedAt: new Date(start + 90_000).toISOString() }, { startedAt: new Date(start - 300_000).toISOString(), detectedAt: new Date(start - 200_000).toISOString(), endedAt: new Date(start - 100_000).toISOString() }]) {
    assert.equal(read(bars, { icebergs: [berg(o)] }).at(-1).absorption[0].parts.book, null, JSON.stringify(o))
  }
})

test('a finished auction at the new high (nothing bought at the top) is the exhaustion print', () => {
  const finishedTop = bar(10, 105, 104, [[103, 60, 90], [104, 130, 150], [105, 90, 80], [106, 15, 10], [107, 0, 30]])
  const e = read([...base(), push(8), pause(9), finishedTop]).at(-1).exhaustion[0]
  assert.equal(e.parts.thin, 1)
  assert.match(e.text, /a finished auction - nothing bought at the top/)
})

test('a shown read never vanishes: no longer produced = kept, failed, faded, said so; present reads and other bars untouched', async () => {
  const { keepShownReads } = await import('../src/flowReads.js')
  const bars = [{ time: '2026-11-16T04:00:00.000Z' }, { time: '2026-11-16T04:01:00.000Z' }, { time: '2026-11-16T04:02:00.000Z' }]
  const abs = { side: 'buy', price: 100, score: 62, status: 'pending', statusAt: null, text: 'Selling absorbed (score 62)' }
  const exh = { side: 'sell', price: 110, score: 55, status: 'pending', statusAt: null, text: 'Buying exhausted (score 55)' }
  const none = () => ({ absorption: [], exhaustion: [] })
  const memory = new Map()
  // The update that shows them: bar 1 has an absorption, bar 2 an exhaustion.
  const first = keepShownReads(memory, bars, [none(), { absorption: [abs], exhaustion: [] }, { absorption: [], exhaustion: [exh] }])
  assert.equal(first[1].absorption[0], abs) // as produced
  assert.equal(first[1].absorption[0].kept, undefined)
  // The next update no longer produces either (the forming bar closed differently / the book data changed).
  const reads = [none(), none(), none()]
  const second = keepShownReads(memory, bars, reads)
  assert.equal(second[1].absorption.length, 1)
  assert.equal(second[1].absorption[0].status, 'failed')
  assert.equal(second[1].absorption[0].kept, true)
  assert.equal(second[1].absorption[0].score, 62)
  assert.match(second[1].absorption[0].text, /NO LONGER READ/)
  assert.equal(second[2].exhaustion[0].status, 'failed')
  assert.equal(second[0].absorption.length + second[0].exhaustion.length, 0) // another bar: nothing
  assert.equal(reads[1].absorption.length, 0) // the reads given are not changed
  // Idempotent: asking again gives the same, the text does not grow.
  const third = keepShownReads(memory, bars, reads)
  assert.equal(third[1].absorption[0].text, second[1].absorption[0].text)
  // A read that IS produced (again, with a changed score) is the produced one - not duplicated, not marked kept.
  const back = keepShownReads(memory, bars, [none(), { absorption: [{ ...abs, score: 70 }], exhaustion: [] }, none()])
  assert.equal(back[1].absorption.length, 1)
  assert.equal(back[1].absorption[0].score, 70)
  assert.equal(back[1].absorption[0].kept, undefined)
  // A confirmed read that vanishes keeps its confirmation; a bar no longer in the list (another timeframe) is not shown.
  const m2 = new Map()
  keepShownReads(m2, bars, [none(), { absorption: [{ ...abs, status: 'confirmed', statusAt: bars[2].time }], exhaustion: [] }, none()])
  assert.equal(keepShownReads(m2, bars, [none(), none(), none()])[1].absorption[0].status, 'confirmed')
  assert.equal(keepShownReads(m2, [bars[0]], [none()]).length, 1)
})
