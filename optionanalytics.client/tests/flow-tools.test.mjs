// The Order Flow page's positioning, book pressure and liquidity added / pulled and order flow imbalance reads (flowTools.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  bookPressure, bucketFlow, emaLine, liquidityFlow, liquidityRead, positioningCandles, positioningOf, positioningRead, positioningSummary, pressureRead, ofiAgreement, ofiCandles, ofiRead, ofiSeries, ofiStep,
} from '../src/flowTools.js'

const MIN = 60_000
const T0 = Date.parse('2026-11-13T09:15:00+05:30')
const bar = (i, buy, sell, close = 100 + i, extra = {}) => ({ time: new Date(T0 + i * MIN).toISOString(), open: close - 1, high: close + 1, low: close - 2, close, buy, sell, ...extra })

test('the four reads: the aggressor with the OI change; a small delta is balanced; no OI change is no read', () => {
  assert.equal(positioningOf(500, 1000, 200), 'newLongs')
  assert.equal(positioningOf(500, 1000, -200), 'shortCovering')
  assert.equal(positioningOf(-500, 1000, 200), 'newShorts')
  assert.equal(positioningOf(-500, 1000, -200), 'longLiquidation')
  assert.equal(positioningOf(40, 1000, 200), 'balanced', 'a delta under 5% of the volume')
  assert.equal(positioningOf(500, 1000, 0), 'none')
  assert.equal(positioningOf(500, 1000, null), 'none')
  assert.equal(positioningOf(0, 0, 200), 'none')
})

test('positioning candles: delta from the minutes, OI change from the candle before\'s end to its own', () => {
  // 1-minute bars 09:15 - 09:20; live OI readings stamped at their minute (lag 0).
  const bars = [bar(0, 900, 100), bar(1, 800, 200), bar(2, 100, 900), bar(3, 200, 800), bar(4, 500, 500), bar(5, 900, 100)]
  const oi = [1000, 1100, 1250, 1200, 1150, 1150, 1100].map((v, i) => ({ t: T0 + (i - 1) * MIN, oi: v }))   // from 09:14
  const one = positioningCandles(bars, oi, { minutes: 1 })
  assert.deepEqual(one.map((c) => c.dOi), [100, 150, -50, -50, 0, -50])
  assert.deepEqual(one.map((c) => c.kind), ['newLongs', 'newLongs', 'longLiquidation', 'longLiquidation', 'balanced', 'shortCovering'])
  assert.deepEqual(one.map((c) => c.delta), [800, 600, -800, -600, 0, 800])
  // 3-minute candles (09:15, 09:18): the OI at each candle's end less the one before's.
  const three = positioningCandles(bars, oi, { minutes: 3 })
  assert.equal(three.length, 2)
  assert.deepEqual(three.map((c) => [c.delta, c.dOi, c.kind]), [[600, 200, 'newLongs'], [200, -100, 'shortCovering']])
  assert.equal(three[0].high, 103)
  assert.equal(three[0].close, 102)
  // No reading before the first candle: its own first reading is the base.
  const late = positioningCandles(bars, oi.slice(1), { minutes: 1 })
  assert.equal(late[0].dOi, 0)
  assert.equal(late[1].dOi, 150)
  // No OI at all: no read, the delta still there.
  assert.deepEqual(positioningCandles(bars, [], { minutes: 1 }).map((c) => c.kind), ['none', 'none', 'none', 'none', 'balanced', 'none'])
  assert.deepEqual(positioningCandles([], oi), [])
})

test('positioning on a replayed day: a reading is known a minute after its minute - nothing after the clock is read', () => {
  const bars = [bar(0, 900, 100), bar(1, 800, 200), bar(2, 100, 900)]
  // Replay: each reading stamped at its minute's END (lag one minute).
  const oi = [1000, 1100, 1250, 1200].map((v, i) => ({ t: T0 + i * MIN, oi: v }))   // of 09:14 ... 09:17
  const whole = positioningCandles(bars, oi, { minutes: 1, lag: MIN })
  assert.deepEqual(whole.map((c) => c.dOi), [100, 150, -50])
  // The clock at 09:17:00 has the 09:16 minute's reading (stamped 09:17) but a clock at 09:16:30 not yet.
  const cut = positioningCandles(bars.slice(0, 2), oi, { minutes: 1, lag: MIN, clockMs: T0 + 2 * MIN })
  assert.deepEqual(cut, whole.slice(0, 2), 'a cut at the clock = the whole day up to it')
  const early = positioningCandles(bars.slice(0, 2), oi, { minutes: 1, lag: MIN, clockMs: T0 + 1.5 * MIN })
  assert.equal(early[1].dOi, null, 'the 09:16 reading is not known yet')
  assert.equal(early[1].kind, 'none')
})

test('the summary adds each read\'s delta; the read says fresh or closing', () => {
  const c = (kind, delta, dOi = 10) => ({ kind, delta, dOi })
  const s = positioningSummary([c('newLongs', 800), c('newLongs', 600), c('shortCovering', -0 + 300), c('newShorts', -200), c('balanced', 10)])
  assert.equal(s.by.newLongs.delta, 1400)
  assert.equal(s.by.newLongs.candles, 2)
  assert.equal(s.net, 1200)
  assert.equal(s.closing, 300)
  assert.equal(s.lead, 'newLongs')
  assert.match(positioningRead(s).text, /FRESH LONGS \(82%/)
  assert.equal(positioningRead(s).tone, 1)
  const cover = positioningSummary([c('shortCovering', 900), c('newLongs', 100)])
  assert.match(positioningRead(cover).text, /SHORT COVERING \(90%\)/)
  const sell = positioningSummary([c('longLiquidation', -900), c('newShorts', -100)])
  assert.match(positioningRead(sell).text, /LONG LIQUIDATION \(90%\)/)
  assert.ok(positioningRead(sell).tone < 0)
  // The other side nearly as large: said, and no lean either way.
  const both = positioningSummary([c('newLongs', 500), c('newShorts', -400)])
  assert.match(positioningRead(both).text, /FRESH LONGS.*selling is nearly as large, mostly fresh shorts - two-sided/)
  assert.equal(positioningRead(both).tone, 0)
  // The last N candles only.
  assert.equal(positioningSummary([c('newLongs', 800), c('newShorts', -500)], 1).lead, 'newShorts')
  assert.equal(positioningRead(positioningSummary([])).tone, 0)
})

// A book column in 1-point rows: bids from `bid` down, offers from `ask` up, each a quantity by its distance.
const column = (sec, bid, ask, bidQty, askQty) => ({
  t: T0 + sec * 1000,
  bids: bidQty.map((q, d) => [bid - d, q]),
  asks: askQty.map((q, d) => [ask + d, q]),
})
const flat = (n, q) => Array.from({ length: n }, () => q)

test('book pressure: bids against offers near the touch, the nearer rows weighing more', () => {
  assert.equal(bookPressure(column(0, 100, 101, flat(12, 50), flat(12, 50)), 1), 0)
  assert.equal(bookPressure(column(0, 100, 101, flat(12, 50), []), 1), null, 'one side only: no read')
  // Twice the bids: (2 - 1) / (2 + 1).
  assert.ok(Math.abs(bookPressure(column(0, 100, 101, flat(12, 100), flat(12, 50)), 1) - 100 / 3) < 1e-9)
  // The same extra size at the touch weighs more than far out.
  const near = bookPressure(column(0, 100, 101, [500, ...flat(11, 50)], flat(12, 50)), 1)
  const far = bookPressure(column(0, 100, 101, [...flat(9, 50), 500, 50, 50], flat(12, 50)), 1)
  assert.ok(near > far && far > 0)
  // Beyond the band (10 rows) nothing counts.
  assert.equal(bookPressure(column(0, 100, 101, [...flat(10, 50), 5000], flat(12, 50)), 1), 0)
  // A crossed book says nothing.
  assert.equal(bookPressure(column(0, 101, 100, flat(5, 50), flat(5, 50)), 1), null)
})

test('added and pulled: only rows away from the touch in both columns - a level traded at the touch is not pulled', () => {
  const a = column(0, 100, 101, flat(12, 50), flat(12, 50))
  // 2 s later: the best bid traded down to 20 (not a pull), 30 pulled 3 rows under it, 40 added 5 rows under; offers: 25 pulled 2 over.
  const bids = flat(12, 50); bids[0] = 20; bids[3] = 20; bids[5] = 90
  const asks = flat(12, 50); asks[2] = 25
  const b = column(2, 100, 101, bids, asks)
  const flow = liquidityFlow([a, b], { rowSize: 1 })
  assert.equal(flow.length, 2)
  assert.deepEqual([flow[0].cumBid, flow[0].cumAsk], [0, 0])
  assert.deepEqual([flow[1].bidAdded, flow[1].bidPulled, flow[1].askAdded, flow[1].askPulled], [40, 30, 0, 25])
  assert.deepEqual([flow[1].cumBid, flow[1].cumAsk], [10, -25])
  assert.equal(flow[1].mid, 100.5)
  // The best bid stepped DOWN a row (the old best traded out): the row it left is not counted as pulled.
  const c = column(4, 99, 101, bids.slice(1), asks)
  const stepped = liquidityFlow([b, c], { rowSize: 1 })
  assert.deepEqual([stepped[1].bidAdded, stepped[1].bidPulled], [0, 0])
})

test('a level leaving the book\'s far edge is not pulled; a gap or a column with no book adds nothing; the totals run on', () => {
  const a = column(0, 100, 101, flat(8, 50), flat(8, 50))
  // The book window moved up two rows: the two lowest bids are out of view, not cancelled.
  const b = column(2, 100, 101, flat(6, 50), flat(8, 50))
  assert.deepEqual([liquidityFlow([a, b], { rowSize: 1 })[1].bidPulled], [0])
  // A two-minute gap (a restart): nothing read across it.
  const late = column(200, 100, 101, flat(8, 10), flat(8, 10))
  const flow = liquidityFlow([a, b, late, column(202, 100, 101, flat(8, 30), flat(8, 10))], { rowSize: 1 })
  assert.deepEqual([flow[2].bidPulled, flow[2].askPulled], [0, 0])
  assert.equal(flow[3].bidAdded, 20 * 7)
  assert.equal(flow[3].cumBid, 140)
  // A column with one side only is left out, the read going on from the one before.
  const oneSide = { t: T0 + 1000, bids: [[100, 50]], asks: [] }
  assert.equal(liquidityFlow([a, oneSide, b], { rowSize: 1 }).length, 2)
})

test('no look-ahead: the flow up to a clock is the same worked out from the columns up to it only', () => {
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const cols = Array.from({ length: 60 }, (_, i) => {
    const bid = 100 + Math.round(rnd() * 4)
    return column(i * 2, bid, bid + 1, Array.from({ length: 14 }, () => 20 + Math.round(rnd() * 80)), Array.from({ length: 14 }, () => 20 + Math.round(rnd() * 80)))
  })
  const whole = liquidityFlow(cols, { rowSize: 1 })
  for (const k of [1, 17, 40]) {
    assert.deepEqual(liquidityFlow(cols.slice(0, k), { rowSize: 1 }), whole.slice(0, k))
    assert.deepEqual(liquidityFlow(cols, { rowSize: 1, clockMs: cols[k - 1].t }), whole.slice(0, k))
  }
  // Worked out again (the per-column cache) it is the same.
  assert.deepEqual(liquidityFlow(cols, { rowSize: 1 }), whole)
  // Another band off the same columns (the two cards) does not disturb it, and counts further out.
  const wide = liquidityFlow(cols, { rowSize: 1, bandRows: 13 })
  assert.deepEqual(liquidityFlow(cols, { rowSize: 1 }), whole)
  assert.deepEqual(wide.map((p) => p.pressure), whole.map((p) => p.pressure), 'the pressure keeps its own band')
  assert.ok(wide.at(-1).bidAdded + wide.at(-1).bidPulled >= whole.at(-1).bidAdded + whole.at(-1).bidPulled)
})

test('buckets keep the last totals and the average pressure; the EMA reads only what came before', () => {
  const points = [
    { t: T0 + 1000, mid: 100, pressure: 10, bidAdded: 5, bidPulled: 0, askAdded: 0, askPulled: 2, cumBid: 5, cumAsk: -2 },
    { t: T0 + 6000, mid: 101, pressure: 30, bidAdded: 1, bidPulled: 4, askAdded: 0, askPulled: 0, cumBid: 2, cumAsk: -2 },
    { t: T0 + 12_000, mid: 102, pressure: null, bidAdded: 0, bidPulled: 0, askAdded: 7, askPulled: 0, cumBid: 2, cumAsk: 5 },
  ]
  const b = bucketFlow(points, 10)
  assert.deepEqual(b.map((x) => [x.t, x.mid, x.pressure, x.cumBid, x.cumAsk, x.bidAdded, x.bidPulled]), [[T0, 101, 20, 2, -2, 6, 4], [T0 + 10_000, 102, 0, 2, 5, 0, 0]])
  assert.deepEqual(emaLine([10, 10, 40], 3), [10, 10, 25])
  assert.deepEqual(emaLine([1, 2, 3], 1), [1, 2, 3])
  assert.deepEqual(emaLine([1, 2, 3, 9], 3).slice(0, 3), emaLine([1, 2, 3], 3))
})

const flowPoint = (sec, mid, pressure, ev = {}) => ({ t: T0 + sec * 1000, mid, pressure, bidAdded: 0, bidPulled: 0, askAdded: 0, askPulled: 0, cumBid: 0, cumAsk: 0, ...ev })

test('the pressure read: the book\'s lean, and a move the book does not back', () => {
  const series = (mids, pressure) => mids.map((m, i) => flowPoint(i * 10, m, pressure))
  const rise = Array.from({ length: 31 }, (_, i) => 24000 + i)          // +30 pts over 5 min
  assert.equal(pressureRead(series(rise, -40)).kind, 'bidThin')
  assert.equal(pressureRead(series(rise, -40)).tone, -1)
  assert.equal(pressureRead(series(rise, 40)).kind, 'bid')
  assert.equal(pressureRead(series(rise.map((m) => 48000 - m), 40)).kind, 'askThin')
  assert.equal(pressureRead(series(rise.map(() => 24000), -40)).kind, 'ask')
  assert.equal(pressureRead(series(rise, 5)).kind, 'even')
  // A move under 0.05% of the price is not a move.
  assert.equal(pressureRead(series(rise.map((m) => 24000 + (m - 24000) / 10), -40)).kind, 'ask')
  assert.equal(pressureRead([]), null)
  assert.equal(pressureRead([flowPoint(0, 24000, null)]), null)
})

test('the liquidity read: which side is adding or pulling over the window - not what happened before it', () => {
  const quiet = Array.from({ length: 31 }, (_, i) => flowPoint(i * 10, 24000 + i))
  assert.equal(liquidityRead(quiet).kind, 'quiet')
  const with_ = (ev, at = 20) => quiet.map((p, i) => (i === at ? { ...p, ...ev } : p))
  assert.equal(liquidityRead(with_({ askPulled: 500 })).kind, 'askPull')
  assert.equal(liquidityRead(with_({ askPulled: 500 })).tone, 1)
  assert.match(liquidityRead(with_({ askPulled: 500 })).text, /can run/)
  assert.equal(liquidityRead(with_({ askAdded: 500 })).kind, 'askStack')
  assert.equal(liquidityRead(with_({ bidAdded: 500 })).kind, 'bidStack')
  assert.equal(liquidityRead(with_({ bidPulled: 500 })).kind, 'bidPull')
  // Added and pulled about the same on a side: no net.
  assert.equal(liquidityRead(with_({ bidAdded: 500, bidPulled: 480 })).kind, 'quiet')
  // Outside the 5-minute window (the first point is exactly 5 min back): not counted.
  assert.equal(liquidityRead(with_({ bidPulled: 500 }, 0)).kind, 'quiet')
  assert.equal(liquidityRead([]), null)
})

// A book with its best bid / offer and the size there (and a level behind each, which OFI never reads).
const book = (sec, bid, bidQ, ask, askQ) => ({ t: T0 + sec * 1000, bids: [[bid - 1, 999], [bid, bidQ]], asks: [[ask, askQ], [ask + 1, 999]] })
const parsed = (bid, bidQ, ask, askQ) => ({ bid, bidQ, ask, askQ })

test('OFI step - Cont, Kukanov & Stoikov: each case at the best bid and offer', () => {
  const a = parsed(100, 50, 101, 40)
  assert.equal(ofiStep(a, parsed(100, 70, 101, 40)), 20, 'bids join at the best bid: +20')
  assert.equal(ofiStep(a, parsed(100, 30, 101, 40)), -20, 'bid hit / cancelled: −20')
  assert.equal(ofiStep(a, parsed(100, 50, 101, 10)), 30, 'offer taken: +30')
  assert.equal(ofiStep(a, parsed(100, 50, 101, 90)), -50, 'offers join: −50')
  assert.equal(ofiStep(a, parsed(101, 25, 102, 40)), 25 + 40, 'bid steps up (its new size) and the offer is cleared (its old size)')
  assert.equal(ofiStep(a, parsed(99, 60, 100, 35)), -50 - 35, 'bid cleared (its old size) and offer steps down (its new size)')
  assert.equal(ofiStep(a, a), 0, 'nothing changed')
})

test('OFI series: from the best rows only, 0 across a gap / a one-sided book, running total; no look-ahead', () => {
  const cols = [book(0, 100, 50, 101, 40), book(2, 100, 70, 101, 40), book(4, 100, 70, 101, 10), book(200, 100, 10, 101, 10),
    { t: T0 + 202_000, bids: [[100, 5]], asks: [] }, book(204, 100, 30, 101, 10), book(206, 101, 30, 102, 10)]
  const s = ofiSeries(cols, { rowSize: 1 })
  assert.deepEqual(s.map((p) => p.ofi), [0, 20, 30, 0, 0, 30 + 10])
  assert.deepEqual(s.map((p) => p.cum), [0, 20, 50, 50, 50, 90])
  assert.equal(s[0].mid, 100.5)
  for (let k = 1; k <= cols.length; k++) {
    const cut = ofiSeries(cols.slice(0, k), { rowSize: 1 })
    assert.deepEqual(cut, s.slice(0, cut.length))
    assert.deepEqual(ofiSeries(cols, { rowSize: 1, clockMs: cols[k - 1].t }), cut)
  }
  // Rows: two prices in one row are one level.
  const rows = ofiSeries([{ t: T0, bids: [[99.5, 10], [100, 20]], asks: [[101, 5]] }, { t: T0 + 2000, bids: [[99.5, 10], [100, 30]], asks: [[101, 5]] }], { rowSize: 1 })
  assert.equal(rows[1].ofi, 10)
})

test('OFI candles: a candle\'s OFI is its points\' sum, OHLC of the mid, the move from the candle before\'s close', () => {
  const pts = [
    { t: T0, mid: 100, ofi: 0, cum: 0 }, { t: T0 + 30_000, mid: 102, ofi: 5, cum: 5 },
    { t: T0 + MIN, mid: 101, ofi: -3, cum: 2 }, { t: T0 + MIN + 30_000, mid: 99, ofi: -4, cum: -2 },
  ]
  const c = ofiCandles(pts, 1)
  assert.deepEqual(c.map((x) => [x.ofi, x.open, x.high, x.low, x.close, x.move, x.cum]), [[5, 100, 102, 100, 102, 2, 5], [-7, 101, 101, 99, 99, -3, -2]])
  assert.deepEqual(ofiCandles(pts, 5).map((x) => x.ofi), [-2])
  assert.equal(ofiCandles(pts, 5)[0].time, T0, '09:15 starts a 5-minute candle')
})

test('agreement is measured: same candle and the next, only candles with both an OFI and a move', () => {
  const c = [{ ofi: 5, move: 2 }, { ofi: -5, move: -1 }, { ofi: 5, move: -1 }, { ofi: 0, move: 3 }, { ofi: 4, move: 0 }]
  const a = ofiAgreement(c)
  assert.equal(a.n, 3)
  assert.ok(Math.abs(a.together - 2 / 3) < 1e-9)
  // next: 5 -> -1 (no), -5 -> -1 (yes), 5 -> 3 (yes); 0 and the last have none.
  assert.equal(a.m, 3)
  assert.ok(Math.abs(a.next - 2 / 3) < 1e-9)
  assert.deepEqual(ofiAgreement([]), { together: null, n: 0, next: null, m: 0 })
})

test('the OFI read: flow with the price, flow absorbed, nothing either way - both sides', () => {
  const candle = (ofi, close, move) => ({ ofi, close, move })
  const up = [candle(100, 24010, 10), candle(80, 24020, 10)]
  assert.equal(ofiRead(up).kind, 'buy')
  assert.equal(ofiRead(up).tone, 1)
  assert.equal(ofiRead(up.map((c) => ({ ...c, ofi: -c.ofi, close: 48000 - c.close, move: -c.move }))).kind, 'sell')
  assert.equal(ofiRead([candle(100, 24000, 0), candle(80, 24000, 0)]).kind, 'absorbedUp')
  assert.equal(ofiRead([candle(-100, 24000, 0), candle(-80, 24000, 0)]).kind, 'absorbedDown')
  assert.equal(ofiRead([candle(100, 24010, 10), candle(-90, 24020, 10)]).kind, 'even')
  assert.equal(ofiRead(up).move, 20)
  // Only the last N candles count.
  assert.equal(ofiRead([candle(-1000, 23990, -10), ...up], { last: 2 }).kind, 'buy')
  assert.equal(ofiRead([]), null)
})
