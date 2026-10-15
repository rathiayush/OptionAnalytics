// The spot + options strategies (spotEngine.js): each fires on its rules - LONG and SHORT - and does NOT fire when each
// key condition is missing; nothing after the clock is read; the tuning measures exactly what the scan fires; and they
// stay out of the futures scanner's strategy list. Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ACTIVE_STRATEGIES, SPOT_STRATEGIES, STRATEGIES, buildOiContext, simulateOutcome, strategyFilters } from '../src/strategyEngine.js'
import { evaluateSpotStrategies, scanSpotDay, sideScore, spotBarsOf } from '../src/spotEngine.js'
import { DEFAULT_VARIANT, dayTrades, tuneStrategy, tuningDay } from '../src/strategyTuning.js'

const MIN = 60_000
const T = Date.parse('2026-10-09T03:45:00Z') // 09:15 IST
const iso = (m) => new Date(T + m * MIN).toISOString()
const STRIKES = [22300, 22350, 22400, 22450, 22500, 22550, 22600, 22650, 22700]
const ramp = (m) => Math.max(0, m - 74) // the last 15 minutes before the clock at minute 90

/** A day: `closes(m)` -> a spot candle; `ce(k, m)` / `pe(k, m)` -> OI. Returns the OI context and the spot bars. */
function world({ candle, ce, pe, minutes = 91 }) {
  const spot = Array.from({ length: minutes }, (_, m) => ({ time: iso(m), ...candle(m) }))
  const points = (f) => spot.flatMap((_, m) => STRIKES.map((k) => ({ time: iso(m), strike: k, openInterest: Math.round(f(k, m)), price: 60 })))
  const run = { success: true, date: '2026-10-09', step: 50, cePoints: points(ce), pePoints: points(pe), futuresBars: [], spotCandlesOneMinute: spot }
  return { oi: buildOiContext(run, null, { live: false }), bars: spotBarsOf(spot), run }
}
const at = (w, minute, filters = {}) => {
  const nowMs = T + minute * MIN
  return evaluateSpotStrategies({ nowMs, bars: w.bars.filter((b) => b.t + MIN <= nowMs), oi: w.oi, filters })
}
const ids = (list) => list.map((s) => `${s.id}:${s.side}`)

// OI worlds. Bullish drift: CE OI falls and PE OI rises, since the open and in the last 15 minutes.
const BASE_CE = (k) => (k === 22550 ? 6e6 : 2e6) // the call wall
const BASE_PE = (k) => (k === 22450 ? 6e6 : 2e6) // the put wall
const drift = (m, d, rampSign) => (1 + d * 0.00015 * m) * (1 + rampSign * 0.0004 * ramp(m))
const bull = { ce: (k, m) => BASE_CE(k) * drift(m, -1, -1), pe: (k, m) => BASE_PE(k) * drift(m, 1, 1) }
const bear = { ce: (k, m) => BASE_CE(k) * drift(m, 1, 1), pe: (k, m) => BASE_PE(k) * drift(m, -1, -1) }
const flat = { ce: (k) => BASE_CE(k), pe: (k) => BASE_PE(k) }

const c = (open, close, pad = 3) => ({ open, close, high: Math.max(open, close) + pad, low: Math.min(open, close) - pad })
// Quiet minutes around `level`, then the last finished minute (89) as given.
const around = (level, last) => (m) => (m < 89 ? c(level + ((m % 4) - 1.5), level + (((m + 1) % 4) - 1.5)) : last)

test('the spot strategies are not in the futures scanner\'s list, and every one has the trade filters', () => {
  assert.equal(STRATEGIES.length, 37)
  // 22 running: #11, #13, #14 and #34 - #37 are retired with the previous session's volume profile
  // (tests/no-volume-profile.test.mjs), along with the earlier retirements.
  assert.equal(ACTIVE_STRATEGIES.length, 22)
  for (const s of SPOT_STRATEGIES) {
    assert.ok(!ACTIVE_STRATEGIES.some((a) => a.id === s.id))
    assert.equal(strategyFilters(s.id, {}).tradeSide, 'both')
    assert.ok('tradeOiFlow' in strategyFilters(s.id, {}))
  }
})

test('spot sides: PE rising and CE falling back a long, the mirror a short', () => {
  assert.equal(sideScore(1, -0.01, 0.01), 2)
  assert.equal(sideScore(-1, -0.01, 0.01), -2)
  assert.equal(sideScore(-1, 0.01, -0.01), 2)
  assert.equal(sideScore(1, 0, 0.01), 1)
  assert.equal(sideScore(1, 0.01, 0.01), 0)
  assert.equal(sideScore(1, null, 0.01), null)
})

test('#101 wall break: closes through the wall it was under, the wall\'s writers leaving, the sides not against', () => {
  // LONG: the call wall 22550; the minute before closed at 22546 (under), the last at 22556 (through).
  const long = (o = {}) => world({ candle: around(22545, c(22546, 22556)), ...bull, ...o })
  assert.ok(ids(at(long(), 90)).includes('spotWallBreak:LONG'))
  const s = at(long(), 90).find((x) => x.id === 'spotWallBreak')
  assert.equal(s.entry, 22556)
  assert.ok(s.stop < s.entry && s.target > s.entry && s.options?.buy && s.options?.sell)
  assert.ok(!ids(at(long({ candle: around(22545, c(22545, 22548)) }), 90)).includes('spotWallBreak:LONG'), 'not through the wall yet')
  assert.ok(!ids(at(long({ candle: (m) => (m < 88 ? c(22545, 22546) : m === 88 ? c(22546, 22553) : c(22553, 22558)) }), 90)).includes('spotWallBreak:LONG'), 'it was already above the wall')
  assert.ok(!ids(at(long({ ce: (k, m) => (k === 22550 ? 6e6 : bull.ce(k, m)) }), 90)).includes('spotWallBreak:LONG'), 'the wall\'s OI is not shrinking')
  assert.ok(!ids(at(long({ ...bear }), 90)).includes('spotWallBreak:LONG'), 'the two sides are against it')
  // SHORT: the put wall 22450; under it the last close.
  const short = (o = {}) => world({ candle: around(22455, c(22454, 22444)), ...bear, ...o })
  assert.ok(ids(at(short(), 90)).includes('spotWallBreak:SHORT'))
  assert.ok(!ids(at(short({ candle: around(22455, c(22455, 22452)) }), 90)).includes('spotWallBreak:SHORT'))
  assert.ok(!ids(at(short({ pe: (k, m) => (k === 22450 ? 6e6 : bear.pe(k, m)) }), 90)).includes('spotWallBreak:SHORT'), 'the put wall is not shrinking')
  assert.ok(!ids(at(short({ ...bull }), 90)).includes('spotWallBreak:SHORT'))
})

test('#102 wall holds: a rejection candle at the wall the trade leans on, that wall\'s OI growing', () => {
  // LONG: the put wall 22450 growing; the last minute dips to it and closes back up, a bullish candle.
  const long = (o = {}) => world({ candle: around(22470, c(22452, 22459, 2)), ...bull, ...o })
  assert.ok(ids(at(long(), 90)).includes('spotWallHold:LONG'))
  assert.ok(!ids(at(long({ candle: around(22470, c(22459, 22452, 2)) }), 90)).includes('spotWallHold:LONG'), 'a bearish candle is no rejection')
  assert.ok(!ids(at(long({ candle: around(22470, c(22482, 22489, 2)) }), 90)).includes('spotWallHold:LONG'), 'it never touched the wall')
  assert.ok(!ids(at(long({ pe: (k, m) => (k === 22450 ? 6e6 : bull.pe(k, m)) }), 90)).includes('spotWallHold:LONG'), 'the wall\'s OI is not growing')
  assert.ok(!ids(at(long({ ...bear }), 90)).includes('spotWallHold:LONG'), 'the sides are against it')
  // SHORT: the call wall 22550 growing; the last minute pokes up to it and closes back down.
  const short = (o = {}) => world({ candle: around(22530, c(22548, 22541, 2)), ...bear, ...o })
  assert.ok(ids(at(short(), 90)).includes('spotWallHold:SHORT'))
  assert.ok(!ids(at(short({ candle: around(22530, c(22541, 22548, 2)) }), 90)).includes('spotWallHold:SHORT'))
  assert.ok(!ids(at(short({ ce: (k, m) => (k === 22550 ? 6e6 : bear.ce(k, m)) }), 90)).includes('spotWallHold:SHORT'))
  assert.ok(!ids(at(short({ ...bull }), 90)).includes('spotWallHold:SHORT'))
})

test('#103 CE / PE sides: both sides now and since the open back a breakout of the last 10 minutes', () => {
  const long = (o = {}) => world({ candle: around(22500, c(22502, 22509, 1)), ...bull, ...o })
  assert.ok(ids(at(long(), 90)).includes('spotSides:LONG'))
  assert.ok(!ids(at(long({ candle: around(22500, c(22500, 22501, 1)) }), 90)).includes('spotSides:LONG'), 'no breakout of the last 10 minutes')
  assert.ok(!ids(at(long({ ce: (k) => BASE_CE(k) * (1 - 0.00015 * 89) }), 90)).includes('spotSides:LONG'), 'CE flat in the last 15 minutes: only one side moving')
  assert.ok(!ids(at(long({ ce: (k, m) => BASE_CE(k) * (1 + 0.0004 * ramp(m) * -1), pe: (k, m) => BASE_PE(k) * (1 + 0.0004 * ramp(m)) }), 90)).includes('spotSides:LONG'), 'nothing since the open')
  assert.ok(!ids(at(long({ ...bear }), 90)).includes('spotSides:LONG'))
  const short = (o = {}) => world({ candle: around(22500, c(22498, 22491, 1)), ...bear, ...o })
  assert.ok(ids(at(short(), 90)).includes('spotSides:SHORT'))
  assert.ok(!ids(at(short({ candle: around(22500, c(22500, 22499, 1)) }), 90)).includes('spotSides:SHORT'))
  assert.ok(!ids(at(short({ ...bull }), 90)).includes('spotSides:SHORT'))
})

// A trending day: up 1.6 a minute for 100 minutes, then back 1.0 a minute to the day's average.
const trendUp = (m) => {
  const close = (x) => (x <= 100 ? 22400 + 1.6 * x : 22560 - (x - 100))
  return c(close(m), close(m + 1), 2)
}
const trendDown = (m) => {
  const close = (x) => (x <= 100 ? 22600 - 1.6 * x : 22440 + (x - 100))
  return c(close(m), close(m + 1), 2)
}
test('#104 pullback to the day\'s average on a trending day, with a candle turning back with the trend', () => {
  const minute = 164 // the last finished minute 163; 11:59 IST
  const long = (o = {}) => world({ candle: trendUp, minutes: 165, ...bull, ...o })
  const w = long()
  const fired = (world2, m = minute) => ids(at(world2, m)).includes('spotAvgPullback:LONG')
  // The day trends up; the last candle (minute 163: 22497 -> 22496 on the way down) - make it a turn up instead.
  const turn = (extra = {}) => world({ candle: (m) => (m === 163 ? c(22495, 22501, 1) : trendUp(m)), minutes: 165, ...bull, ...extra })
  assert.ok(fired(turn()), 'fires on a trending day at the average')
  assert.ok(!fired(w), 'the last candle is still falling: no turn')
  assert.ok(!fired(turn({ ...bear })), 'the sides are against it')
  assert.ok(!fired(world({ candle: (m) => (m === 163 ? c(22520, 22526, 1) : trendUp(m)), minutes: 165, ...bull })), 'not back at the average yet')
  // A choppy day (no trend): the same pullback does not count.
  const chop = (m) => { const x = 22500 + 40 * Math.sin(m / 9); const y = 22500 + 40 * Math.sin((m + 1) / 9); return c(x, y, 2) }
  assert.ok(!ids(at(world({ candle: chop, minutes: 165, ...bull }), minute)).includes('spotAvgPullback:LONG'))
  // SHORT mirror on a trending-down day.
  const turnDown = (extra = {}) => world({ candle: (m) => (m === 163 ? c(22505, 22499, 1) : trendDown(m)), minutes: 165, ...bear, ...extra })
  assert.ok(ids(at(turnDown(), minute)).includes('spotAvgPullback:SHORT'))
  assert.ok(!ids(at(turnDown({ ...bull }), minute)).includes('spotAvgPullback:SHORT'))
  assert.ok(!ids(at(world({ candle: trendDown, minutes: 165, ...bear }), minute)).includes('spotAvgPullback:SHORT'), 'the last candle is still rising')
})

test('no look-ahead: the setups at a clock are the same with everything after it removed', () => {
  const w = world({ candle: around(22545, c(22546, 22556)), ...bull, minutes: 120 })
  const now = at(w, 90)
  assert.ok(now.length > 0)
  const cutMs = T + 90 * MIN
  const cut = {
    ...w.oi,
    ce: new Map([...w.oi.ce].map(([k, v]) => [k, v.filter((p) => p.t <= cutMs)])), pe: new Map([...w.oi.pe].map(([k, v]) => [k, v.filter((p) => p.t <= cutMs)])),
    spot: w.oi.spot.filter((p) => p.t <= cutMs), futures: [],
  }
  const again = evaluateSpotStrategies({ nowMs: cutMs, bars: w.bars.filter((b) => b.t + MIN <= cutMs), oi: cut })
  assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(now)))
  // A setup is never dated before its own clock and uses the last FINISHED minute's close as the entry.
  for (const s of now) { assert.equal(s.t, cutMs); assert.equal(s.entry, 22556) }
})

test('the trade filters apply: sides, and the OI filters read the OI recorded on the setup', () => {
  const w = world({ candle: around(22545, c(22546, 22556)), ...bull })
  assert.ok(at(w, 90).some((s) => s.id === 'spotWallBreak'))
  assert.ok(!at(w, 90, { spotWallBreak: { tradeSide: 'short' } }).some((s) => s.id === 'spotWallBreak'))
  assert.ok(at(w, 90, { spotWallBreak: { tradeSide: 'long', tradeSideOi: 'both' } }).some((s) => s.id === 'spotWallBreak'), 'CE falling and PE rising: both sides with a long')
  assert.ok(!at(w, 90, { spotWallBreak: { tradeSideOi: 'both', tradeOiWindow: 1 } }).some((s) => s.id === 'spotWallBreak'), 'on 1 minute CE and PE are flat in this world: the sides are not both with it')
  const s = at(w, 90).find((x) => x.id === 'spotWallBreak')
  for (const k of ['flow', 'cum', 'ceD', 'peD', 'ceC', 'peC', 'resChg', 'supChg', 'dayType', 'support', 'resistance', 'spot', 'resistanceAhead', 'supportAhead']) assert.ok(k in s.oiCtx, k)
  assert.equal(s.oiCtx.futOiPct, null, 'no futures in this mode')
  for (const m of [1, 3, 5]) assert.ok('flow' in s.oiCtx.byWindow[m])
})

test('the tuning measures exactly what the spot scan fires', () => {
  const w = world({ candle: around(22545, c(22546, 22556)), ...bull, minutes: 200 })
  const setups = scanSpotDay({ bars: w.bars, oi: w.oi })
  assert.ok(setups.length > 0, 'something fires over the day')
  const day = tuningDay('2026-10-09', setups, { minuteBars: w.bars, heatmap: [] }, w.oi)
  for (const id of [...new Set(setups.map((s) => s.id))]) {
    const scanned = scanSpotDay({ bars: w.bars, oi: w.oi, filters: { [id]: { ...DEFAULT_VARIANT } } }).filter((s) => s.id === id)
    assert.deepEqual(scanned.map((s) => s.t), setups.filter((s) => s.id === id).map((s) => s.t))
    const rs = dayTrades(day, id, DEFAULT_VARIANT, null)
    assert.ok(rs.every(Number.isFinite))
    // The first trade, replayed on the spot bars on its own.
    const first = setups.find((s) => s.id === id)
    assert.equal(simulateOutcome({ ...first, trail: null }, day.minuteBars, day.endMs, true).r, rs[0])
  }
  const r = tuneStrategy([day, day, day, day, day, day], 'spotWallBreak', { what: 'oi', minTrades: 1, underlying: 'NIFTY' })
  assert.equal(r.id, 'spotWallBreak')
  assert.equal(r.baseline.points.n >= 0, true)
})
