// The Order Flow page's positioning and order flow imbalance reads (flowTools.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ofiAgreement, ofiCandles, ofiRead, ofiSeries, ofiStep, positioningCandles, positioningOf, positioningRead, positioningSummary,
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
