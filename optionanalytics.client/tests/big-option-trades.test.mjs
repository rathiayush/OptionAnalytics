// Big option trades (bigOptionTrades.js): a big MINUTE at a strike in ATM ± N, read with the bar and the OI, added up across the strikes -
// each case on its own, not without each part, the sweep, and NO LOOK-AHEAD (a cut at any clock = the whole day's up to it).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BIG_DEFAULTS, bigOptionTrades, bigTradesSummary, kindOf, readOf } from '../src/bigOptionTrades.js'

const T0 = Date.parse('2026-10-05T04:00:00Z')   // 09:30 IST
const MIN = 60_000
const iso = (i) => new Date(T0 + i * MIN).toISOString()
const LOT = 65

// A quiet strike: 2 lots a minute for `n` minutes at 100, then whatever `tail` says. Each tail bar: { i, price, volume, oi, high, low }.
function strike(strikeValue, n, tail = [], oi0 = 1000) {
  const pts = []
  for (let i = 0; i < n; i++) pts.push({ time: iso(i), strike: strikeValue, price: 100, open: 100, high: 101, low: 99, volume: 2 * LOT, oi: oi0 })
  for (const t of tail) pts.push({ time: iso(t.i), strike: strikeValue, open: 100, high: t.high ?? t.price, low: t.low ?? 99, volume: t.volume, oi: t.oi ?? oi0, price: t.price })
  return pts
}
const spot = (price = 25000, n = 40) => Array.from({ length: n }, (_, i) => ({ time: new Date(T0 + i * MIN).toISOString(), open: price, high: price, low: price, close: price }))
const opts = { lotSize: LOT, step: 50 }

test('a minute many times the strike\'s own typical volume, in lots, is a big trade - and not without each part', () => {
  const big = [{ i: 10, price: 120, high: 120, low: 100, volume: 40 * LOT, oi: 1500 }]
  const e = bigOptionTrades(strike(25000, 10, big), [], spot(), opts)
  assert.equal(e.length, 1)
  assert.equal(e[0].type, 'CE')
  assert.ok(Math.abs(e[0].lots - 40) < 1e-9 && Math.abs(e[0].ratio - 20) < 1e-9)
  assert.ok(Math.abs(e[0].value - 120 * 40 * LOT) < 1e-6)
  // Not 4x its usual: 6 lots against 2.
  assert.equal(bigOptionTrades(strike(25000, 10, [{ i: 10, price: 120, high: 120, low: 100, volume: 6 * LOT }]), [], spot(), opts).length, 0)
  // 4x but under the lot floor (a thin strike's 8 lots vs 2 - the floor is 20).
  assert.equal(bigOptionTrades(strike(25000, 10, [{ i: 10, price: 120, high: 120, low: 100, volume: 8 * LOT }]), [], spot(), opts).length, 0)
  // No baseline yet (fewer than minHistory bars before it).
  assert.equal(bigOptionTrades(strike(25000, 3, [{ i: 3, price: 120, high: 120, low: 100, volume: 40 * LOT }]), [], spot(), opts).length, 0)
})

test('only strikes within ATM ± N of THAT minute\'s ATM count', () => {
  const big = [{ i: 10, price: 120, high: 120, low: 100, volume: 40 * LOT }]
  const at = (k) => bigOptionTrades(strike(k, 10, big), [], spot(25000), { ...opts, strikesEach: 10 }).length
  assert.equal(at(25000 + 10 * 50), 1)      // the edge: ATM + 10 steps
  assert.equal(at(25000 + 11 * 50), 0)      // one past it
  assert.equal(at(25000 - 10 * 50), 1)
  assert.equal(bigOptionTrades(strike(25000 + 3 * 50, 10, big), [], spot(25000), { ...opts, strikesEach: 2 }).length, 0)   // a narrower window
  // The window follows the minute's own spot: the same strike is ATM when spot is there.
  assert.equal(bigOptionTrades(strike(25600, 10, big), [], spot(25600), opts).length, 1)
})

test('the read: who pushed (the close in the range, the move) and what OI did - and the index bias of each', () => {
  assert.deepEqual(readOf(true, 1, 500), { read: 'long build-up', bias: 1 })        // call bought, OI up: bullish
  assert.deepEqual(readOf(true, -1, 500), { read: 'short build-up', bias: -1 })     // call written: bearish
  assert.deepEqual(readOf(true, 1, -500), { read: 'short covering', bias: 0.5 })
  assert.deepEqual(readOf(true, -1, -500), { read: 'long unwinding', bias: -0.5 })
  assert.deepEqual(readOf(false, 1, 500), { read: 'long build-up', bias: -1 })      // put bought: bearish
  assert.deepEqual(readOf(false, -1, 500), { read: 'short build-up', bias: 1 })     // put written: bullish
  assert.deepEqual(readOf(false, 1, -500), { read: 'short covering', bias: -0.5 })
  assert.deepEqual(readOf(false, -1, -500), { read: 'long unwinding', bias: 0.5 })
  assert.deepEqual(readOf(true, 1, null), { read: 'bought', bias: 0.5 })            // no OI reading
  assert.deepEqual(readOf(true, 0, 500), { read: 'unclear', bias: 0 })

  // On bars: a call closing at its high with OI up; the same minute closing at its low with OI up.
  const up = bigOptionTrades(strike(25000, 10, [{ i: 10, price: 125, high: 125, low: 100, volume: 40 * LOT, oi: 1800 }]), [], spot(), opts)[0]
  assert.equal(up.read, 'long build-up'); assert.equal(up.side, 1); assert.equal(up.oiChange, 800)
  const down = bigOptionTrades(strike(25000, 10, [{ i: 10, price: 80, high: 100, low: 80, volume: 40 * LOT, oi: 1800 }]), [], spot(), opts)[0]
  assert.equal(down.read, 'short build-up'); assert.equal(down.side, -1)
  // A put closing at its high with OI up is a put BOUGHT - bearish.
  const put = bigOptionTrades([], strike(25000, 10, [{ i: 10, price: 125, high: 125, low: 100, volume: 40 * LOT, oi: 1800 }]), spot(), opts)[0]
  assert.equal(put.type, 'PE'); assert.equal(put.bias, -1)
})

test('a SWEEP is the same type and direction at several strikes within a few minutes', () => {
  const big = (i) => [{ i, price: 125, high: 125, low: 100, volume: 40 * LOT, oi: 1800 }]
  const ce = [...strike(25000, 10, big(10)), ...strike(25050, 10, big(11)), ...strike(25100, 10, big(12))]
  const e = bigOptionTrades(ce, [], spot(), opts)
  assert.equal(e.length, 3)
  assert.ok(e.every((x) => x.sweep))
  // Two strikes only, or too far apart in time, or opposite directions: none.
  assert.ok(bigOptionTrades([...strike(25000, 10, big(10)), ...strike(25050, 10, big(11))], [], spot(), opts).every((x) => !x.sweep))
  assert.ok(bigOptionTrades([...strike(25000, 10, big(10)), ...strike(25050, 10, big(11)), ...strike(25100, 10, big(20))], [], spot(), opts).every((x) => !x.sweep))
  const mixed = bigOptionTrades([...strike(25000, 10, big(10)), ...strike(25050, 10, big(11)), ...strike(25100, 10, [{ i: 12, price: 80, high: 100, low: 80, volume: 40 * LOT, oi: 1800 }])], [], spot(), opts)
  assert.ok(mixed.every((x) => !x.sweep))
})

test('the summary adds the strikes up by kind, with a net lean, over the last N minutes only', () => {
  const callBuy = (i) => [{ i, price: 125, high: 125, low: 100, volume: 40 * LOT, oi: 1800 }]
  const putBuy = (i) => [{ i, price: 125, high: 125, low: 100, volume: 25 * LOT, oi: 1800 }]
  const ce = [...strike(25000, 10, callBuy(10)), ...strike(25050, 10, callBuy(11))]
  const pe = strike(25000, 10, putBuy(12))
  const events = bigOptionTrades(ce, pe, spot(), opts)
  const s = bigTradesSummary(events, T0 + 20 * MIN, 15)
  assert.equal(s.count, 3)
  assert.equal(s.kinds.ceBought.count, 2)
  assert.equal(s.kinds.peBought.count, 1)
  assert.ok(Math.abs(s.kinds.ceBought.value - 2 * 125 * 40 * LOT) < 1e-6)
  assert.equal(s.lean, 'bullish')                   // calls bought (2 x 40 lots) over the puts bought (25 lots)
  assert.ok(s.net > 0.25 && s.net < 1)
  assert.equal(s.biggest.type, 'CE')
  // The last 5 minutes only: the call buys at 10 and 11 are out.
  const late = bigTradesSummary(events, T0 + 20 * MIN, 5)
  assert.equal(late.count, 0); assert.equal(late.lean, 'none')
  assert.equal(kindOf({ read: 'unclear', type: 'CE' }), null)
  assert.equal(kindOf({ read: 'short build-up', type: 'PE' }), 'peWritten')
})

test('NO LOOK-AHEAD: the events at a clock equal the whole day\'s up to it, with a later spike in the data', () => {
  const big = (i, v) => [{ i, price: 125, high: 125, low: 100, volume: v * LOT, oi: 1800 }]
  const pts = [...strike(25000, 10, [...big(10, 40), ...big(20, 90)]), ...strike(25050, 10, big(15, 50))]
  const whole = bigOptionTrades(pts, [], spot(), opts)
  for (const at of [10, 12, 15, 19, 20]) {
    const cut = bigOptionTrades(pts, [], spot(), { ...opts, asOfMs: T0 + at * MIN })
    assert.deepEqual(cut, whole.filter((e) => e.t <= T0 + at * MIN).map((e) => ({ ...e, sweep: cut.find((c) => c.t === e.t && c.strike === e.strike)?.sweep })), `at ${at}`)
  }
  // The typical volume is the strike's EARLIER bars: a huge later bar does not change an earlier verdict.
  const without = bigOptionTrades(strike(25000, 10, big(10, 40)), [], spot(), opts)
  assert.equal(whole.find((e) => e.t === T0 + 10 * MIN).ratio, without[0].ratio)
  // Live: the forming (newest) minute is left out.
  const live = bigOptionTrades(strike(25000, 10, big(10, 40)), [], spot(), { ...opts, dropForming: true })
  assert.equal(live.length, 0)
  assert.equal(BIG_DEFAULTS.strikesEach, 10)
})
