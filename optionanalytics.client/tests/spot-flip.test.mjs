// #101, the CE / PE flip (spotEngine.js): when the whole chain's CE - PE change since the open flips sign on the 1-minute
// clock - puts added overtake calls (a long), or the reverse - AND the spot's 3-minute EMA 7 / 21 agrees, the CE / PE change
// over the last few minutes (configurable) is with the trade, and the support / resistance OI round the ATM (+/- 2 strikes,
// configurable) sits with it: a signal with an index stop and target (BUY / SELL per the index's setting). It fires on its
// rules - LONG and SHORT - and not when each key condition is missing; nothing after the clock is read; the day scan finds it
// too. Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SPOT_STRATEGIES, STRATEGY_BY_ID, STRATEGY_FILTERS, strategyFilters, trailedStop, applyTradeFilter } from '../src/strategyEngine.js'
import { evaluateSpotStrategies, scanSpotDay } from '../src/spotEngine.js'
import { firstPerCooldown } from '../src/scanDay.js'
import { MIN, T, flipLong, flipShort } from './spot-flip-world.mjs'

const mine = (w, filters = {}) => scanSpotDay({ bars: w.bars, oi: w.oi, filters }).filter((s) => s.id === 'spotFlip')

test('#101 is the one spot strategy: the CE / PE flip', () => {
  assert.equal(SPOT_STRATEGIES.length, 1)
  const s = STRATEGY_BY_ID.spotFlip
  assert.ok(s?.spot && s.no === 101 && !s.retired)
})

test('LONG: since-open CE - PE flips to puts, 3-min EMA 7 over 21, CE / PE change with it, support heavier at ATM +/- 2 - once, at the flip', () => {
  const found = mine(flipLong())
  assert.equal(found.length, 1)
  const s = found[0]
  assert.equal(s.side, 'LONG')
  assert.ok(s.stop < s.entry && s.target > s.entry, 'an index stop under and target over the entry')
  assert.ok(Math.abs((s.target - s.entry) - 2 * (s.entry - s.stop)) < 1e-6, 'target 2x the stop')
  assert.match(s.checks.OI, /flipped \+.*% -> -.*puts added now lead.*last 10 min CE .* \/ PE \+/)
  assert.match(s.checks.Walls, /ATM \+\/- 2 strikes: PE .*L vs CE .*L - support heavier/)
  assert.match(s.checks.Trend, /3-min EMA 7 .* over EMA 21/)
  assert.ok(s.options?.buy && s.options?.sell, 'both options priced for the trade')
})

test('SHORT: the mirror - calls added overtake puts, EMA 7 under 21, calls changing with it, resistance heavier', () => {
  const found = mine(flipShort())
  assert.equal(found.length, 1)
  const s = found[0]
  assert.equal(s.side, 'SHORT')
  assert.ok(s.stop > s.entry && s.target < s.entry)
  assert.match(s.checks.OI, /calls added now lead/)
  assert.match(s.checks.Walls, /resistance heavier/)
  assert.match(s.checks.Trend, /under EMA 21/)
})

test('not without each key condition', () => {
  for (const make of [flipLong, flipShort]) {
    assert.equal(mine(make({ noTrend: true })).length, 0, 'the 3-minute EMAs do not agree')
    assert.equal(mine(make({ peStall: true })).length, 0, 'no flip: the side being added stalls, the since-open lean never changes')
    assert.equal(mine(make({ bothShed: true })).length, 0, 'it flips, but the last minutes\' CE / PE change is not with the trade (both sides shedding)')
    assert.equal(mine(make({ ceHeavy: true })).length, 0, 'the OI round the ATM sits on the other side')
  }
})

test('the flip is read on the 1-minute clock: a later flip fires later, and only on the minute it happens', () => {
  const early = mine(flipLong())[0]
  const late = mine(flipLong({ slow: true }))[0]
  assert.ok(late.t > early.t, 'the slower build flips later')
  assert.equal((late.t - T) % MIN, 0)
})

test('configurable: the CE / PE window (3 - 15 minutes) and the strikes round the ATM (1 - 5)', () => {
  assert.deepEqual(STRATEGY_FILTERS.spotFlip.filter((f) => ['deltaMin', 'nearStrikes'].includes(f.key)).map((f) => [f.key, f.default]), [['deltaMin', 10], ['nearStrikes', 2]])
  assert.deepEqual(strategyFilters('spotFlip', {}).deltaMin, 10, 'the default is the rule as written')
  assert.equal(strategyFilters('spotFlip', { deltaMin: 99 }).deltaMin, 15)
  assert.equal(strategyFilters('spotFlip', { nearStrikes: 0 }).nearStrikes, 1)
  for (const f of [{ deltaMin: 5 }, { deltaMin: 3 }, { nearStrikes: 1 }, { nearStrikes: 3 }]) assert.equal(mine(flipLong(), { spotFlip: f }).length, 1, JSON.stringify(f))
  // The window decides what counts as "with the trade": over 15 minutes both sides' change round the flip still reads with it.
  assert.ok(!mine(flipLong({ ceHeavy: true }), { spotFlip: { nearStrikes: 1 } }).length, 'one strike in, the calls still outweigh the puts')
})

test('no look-ahead: what happens after the clock changes nothing, and the tuning\'s day scan and the live look agree', () => {
  const full = flipLong()
  const cut = flipLong({ minutes: 73 })
  const clock = T + 72 * MIN
  const at = (w) => evaluateSpotStrategies({ nowMs: clock, bars: w.bars.filter((b) => b.t + MIN <= clock), oi: w.oi }).filter((s) => s.id === 'spotFlip')
  assert.equal(at(full).length, 1)
  assert.deepEqual(at(full), at(cut))
  assert.deepEqual(firstPerCooldown(mine(full)).map((s) => s.t), mine(full).map((s) => s.t))
})

test('a trailing stop of its own: after 10 index points in profit it stays 10 behind - configurable, 0 = none', () => {
  // (A setup trades with `trail` - the live scan puts its own trailOverride there (withOwnTrail), the tuning the same.)
  const withTrail = (x) => ({ ...x, trail: x.trailOverride })
  const [s0] = mine(flipLong())
  const s = withTrail(s0)
  assert.deepEqual(s.trailOverride, { unit: 'pts', startPts: 10, gapPts: 10 })
  assert.match(s.checks.Trail, /trailing stop after 10 pts, 10 pts behind/)
  // The stop stays where it was until the trade is 10 points up, then follows 10 behind the best price - never loosened.
  assert.equal(trailedStop(s, s.entry + 9), s.stop)
  assert.ok(Math.abs(trailedStop(s, s.entry + 10) - s.entry) < 1e-9, 'at +10 the stop reaches the entry')
  assert.ok(Math.abs(trailedStop(s, s.entry + 25) - (s.entry + 15)) < 1e-9)
  const short = withTrail(mine(flipShort())[0])
  assert.ok(Math.abs(trailedStop(short, short.entry - 25) - (short.entry - 15)) < 1e-9, 'the short trails the other way')
  const wide = mine(flipLong(), { spotFlip: { trailStartPts: 6, trailGapPts: 4 } })[0]
  assert.deepEqual(wide.trailOverride, { unit: 'pts', startPts: 6, gapPts: 4 })
  assert.equal(mine(flipLong(), { spotFlip: { trailStartPts: 0 } })[0].trailOverride, null, '0 = no trailing stop')
  // A tuned trailing stop (the tradeTrail filter) overrides it, as for every strategy.
  assert.equal(applyTradeFilter(s, { tradeTrail: 'off' }).trailOverride, null)
})

test('configurable timeframes: the EMA candle (1 - 15 min), the EMA lengths, and how far back the flip may be', () => {
  const f = (o) => strategyFilters('spotFlip', o)
  assert.deepEqual([f({}).emaTf, f({}).emaFast, f({}).emaSlow, f({}).flipTf], [3, 7, 21, 1], 'the defaults are the rule as written')
  assert.equal(f({ emaTf: 4 }).emaTf, 3, 'only the listed candle sizes')
  // A different candle size and length still read the same climb (5-minute candles need shorter EMAs to be ready by the flip); a flip allowed a few minutes back fires earlier minutes' flips on later minutes too.
  for (const o of [{ emaTf: 1 }, { emaTf: 5, emaFast: 3, emaSlow: 7 }, { emaFast: 5, emaSlow: 15 }]) assert.equal(mine(flipLong(), { spotFlip: o }).length, 1, JSON.stringify(o))
  assert.equal(mine(flipLong(), { spotFlip: { emaFast: 30, emaSlow: 20 } }).length, 0, 'a slow EMA that is not slower than the fast one reads nothing')
  assert.equal(mine(flipLong(), { spotFlip: { emaTf: 15 } }).length, 0, 'on 15-minute candles there are not enough candles for a 21 EMA by then')
  const early = mine(flipLong())[0]
  const wider = mine(flipLong(), { spotFlip: { flipTf: 5 } })
  assert.ok(wider.length >= 1 && wider[0].t === early.t, 'a wider window still fires at the flip')
  assert.ok(wider.every((s) => s.t >= early.t && s.t < early.t + 5 * MIN), 'and for the minutes just after it')
})
