// #115, the ADAPTIVE spot strategy (spotEngine.js): it reads the day - the opening 5-minute candles, the previous day's
// high / low, the option chain's OI since the open and at ATM +/- 2, the S/R OI balance and the walls' writers, EMA 9 / 21,
// RSI 14 and VWAP - then plays it: a TREND day BUYS the option with the move, a RANGE day SELLS the option at the wall it
// fades, a failed SWEEP of yesterday's high / low BUYS the turn. Each signal carries its own leg (setup.optLeg), honoured
// under "per strategy" unless a tuned leg or the index's own side says otherwise; at most 5 signals a day (canFire), the
// same in the live scan and the tuning. It fires on its rules - LONG and SHORT, at NIFTY, BANKNIFTY and SENSEX scale - and
// not when each key condition is missing; nothing after the clock is read. Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { SPOT_STRATEGIES, STRATEGY_BY_ID, optionPlanFor } from '../src/strategyEngine.js'
import { evaluateSpotStrategies, scanSpotDay, emaSeries, rsiSeries, vwapSeries, openingOf, prevDayOf } from '../src/spotEngine.js'
import { canFire, firable, spotScanMinutes } from '../src/scannerCore.js'
import { firstPerCooldown } from '../src/scanDay.js'
import { legFor, optionOutcome, tuneStrategy, tuningDay, evaluateSetting } from '../src/strategyTuning.js'
import { MIN, T, NIFTY, BANKNIFTY, SENSEX } from './spot-profile-world.mjs'
import { trendLong, trendShort, rangeLong, rangeShort, sweepLong, sweepShort, sweepPrev } from './spot-adaptive-world.mjs'

const done = (w, minute) => w.bars.filter((b) => b.t + MIN <= T + minute * MIN)
const at = (w, minute = 90, prevDay = null) => evaluateSpotStrategies({ nowMs: T + minute * MIN, bars: done(w, minute), oi: w.oi, prevDay })
const find = (w, side, mode, { minute = 90, prevDay = null } = {}) => at(w, minute, prevDay).find((s) => s.id === 'spotAdaptive' && s.side === side && (!mode || s.mode === mode))
const prevOf = (side, scale = NIFTY) => sweepPrev(scale, side === 'LONG')

test('#115 is the fifteenth spot strategy: adaptive, its own leg, at most 5 a day', () => {
  assert.equal(SPOT_STRATEGIES.length, 15)
  const s = STRATEGY_BY_ID.spotAdaptive
  assert.ok(s?.spot && s.no === 115 && !s.retired && s.ownLeg && s.maxPerDay === 5)
  assert.equal(SPOT_STRATEGIES.at(-1).id, 'spotAdaptive')
})

test('its three indicators: EMA (SMA-seeded), Wilder RSI, the session VWAP (time-weighted - the index has no volume)', () => {
  assert.deepEqual(emaSeries([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4])
  const up = rsiSeries(Array.from({ length: 20 }, (_, i) => 100 + i), 14)
  assert.equal(up[13], null)
  assert.equal(up[14], 100, 'only gains: 100')
  const flat = rsiSeries(Array.from({ length: 20 }, () => 100), 14)
  assert.equal(flat[19], 50)
  const v = vwapSeries([{ high: 12, low: 8, close: 10 }, { high: 22, low: 18, close: 20 }])
  assert.deepEqual(v, [10, 15])
  const op = openingOf(trendLong().bars)
  assert.equal(op.drive, 1, 'three 5-minute candles up')
  assert.equal(op.candles.length, 3)
  assert.equal(openingOf(trendLong().bars.slice(0, 10)), null, 'not before all 15 opening minutes are in')
  assert.deepEqual(prevDayOf({ profileDate: '2026-10-08', bars: [{ high: 10, low: 8, close: 9 }, { high: 12, low: 9, close: 11 }] }), { date: '2026-10-08', high: 12, low: 8, close: 11 })
  assert.equal(prevDayOf({ bars: [] }), null)
  assert.equal(prevDayOf(null), null)
})

test('TREND day: the opening drive, past the opening range, VWAP and EMA 9 over 21, writers with it - BUY the option', () => {
  for (const [make, side] of [[trendLong, 'LONG'], [trendShort, 'SHORT']]) {
    const s = find(make(), side, 'trend')
    assert.ok(s, `${side} fires`)
    assert.equal(s.optLeg, 'buy')
    assert.match(s.checks.Day, side === 'LONG' ? /TREND up/ : /TREND down/)
    assert.match(s.checks.Plan, side === 'LONG' ? /^BUY the call - pulled back to EMA 9 and resumed/ : /^BUY the put - pulled back to EMA 9 and resumed/)
    assert.match(s.checks.Indicators, side === 'LONG' ? /^spot EMA 9 .* RSI .* VWAP .*; ATM call .*its EMA 9 .* \/ 21/ : /^spot EMA 9 .* RSI .* VWAP .*; ATM put .*its EMA 9 .* \/ 21/)
    assert.match(s.checks.OI, /^total CE .* \/ PE .* \(PCR .*\); since the open CE .* PE .*ATM \+\/- 2/)
    assert.match(s.checks.Plan, /spot and the ATM (call|put) both over their EMAs/)
    const dir = side === 'LONG' ? 1 : -1
    assert.ok(dir * (s.target - s.entry) > 0 && dir * (s.entry - s.stop) > 0)
    assert.ok(Math.abs(Math.abs(s.target - s.entry) - 2 * Math.abs(s.entry - s.stop)) < 1e-6, 'target 2x the stop')
  }
})

test('TREND: not without each key condition', () => {
  for (const [make, side] of [[trendLong, 'LONG'], [trendShort, 'SHORT']]) {
    assert.ok(!find(make({ driveDown: true }), side, 'trend'), `${side}: the opening candles drove the other way`)
    assert.ok(!find(make({ noResume: true }), side, 'trend'), `${side}: the pullback did not resume`)
    assert.ok(!find(make({ noDip: true }), side, 'trend'), `${side}: no pullback - RSI exhausted, nothing to enter on`)
    assert.ok(!find(make({ oiFlat: true }), side, 'trend'), `${side}: no writers on its side since the open`)
    assert.ok(!find(make({ sidesFlat: true }), side, 'trend'), `${side}: fewer than 2 OI confirmations`)
    assert.ok(!find(make({ prem: 'flat' }), side, 'trend'), `${side}: the ATM option it would buy is not in direction (its EMAs flat)`)
  }
})

test('RANGE day: OI balanced, writers on both walls, VWAP crossed - fade the wall with RSI stretched - SELL the option, target VWAP', () => {
  for (const [make, side] of [[rangeLong, 'LONG'], [rangeShort, 'SHORT']]) {
    const s = find(make(), side, 'range')
    assert.ok(s, `${side} fires`)
    assert.equal(s.optLeg, 'sell')
    assert.match(s.checks.Day, /^RANGE/)
    assert.match(s.checks.Plan, side === 'LONG' ? /^SELL the put - faded the put wall 22450/ : /^SELL the call - faded the call wall 22550/)
    assert.match(s.checks.OI, /\(balanced\)/)
    const vwap = vwapSeries(done(make(), 90)).at(-1)
    assert.ok(Math.abs(s.target - vwap) < 1e-6, 'the target is VWAP')
  }
})

test('RANGE: not without each key condition', () => {
  for (const [make, side] of [[rangeLong, 'LONG'], [rangeShort, 'SHORT']]) {
    assert.ok(!find(make({ oneSided: true }), side, 'range'), `${side}: the OI one-sided since the open`)
    assert.ok(!find(make({ wallLeaving: true }), side, 'range'), `${side}: the wall's writers leaving`)
    assert.ok(!find(make({ noTurn: true }), side, 'range'), `${side}: no candle back off the wall`)
    assert.ok(!find(make({ trend: true }), side, 'range'), `${side}: a steady move, VWAP not crossed back and forth`)
    assert.ok(!find(make({ prem: 'flat' }), side, 'range'), `${side}: the option it would sell is not coming off its high`)
  }
})

test('SWEEP of yesterday\'s high / low: taken out for the first time, back inside, RSI turned, OI defending - BUY the turn', () => {
  for (const [make, side] of [[sweepShort, 'SHORT'], [sweepLong, 'LONG']]) {
    const s = find(make(), side, 'sweep', { prevDay: prevOf(side) })
    assert.ok(s, `${side} fires`)
    assert.equal(s.optLeg, 'buy')
    assert.match(s.checks.Day, side === 'SHORT' ? /SWEEP of yesterday's high 22530/ : /SWEEP of yesterday's low 22420/)
    assert.match(s.checks.Plan, side === 'SHORT' ? /^BUY the put - took yesterday's high out/ : /^BUY the call - took yesterday's low out/)
  }
})

test('SWEEP: not without each key condition - nor without yesterday', () => {
  for (const [make, side] of [[sweepShort, 'SHORT'], [sweepLong, 'LONG']]) {
    const prevDay = prevOf(side)
    assert.ok(!find(make(), side, 'sweep'), `${side}: no previous day - nothing to sweep`)
    assert.ok(!find(make({ noBack: true }), side, 'sweep', { prevDay }), `${side}: still beyond the level`)
    assert.ok(!find(make({ earlier: true }), side, 'sweep', { prevDay }), `${side}: not the first time today`)
    assert.ok(!find(make({ noDefence: true }), side, 'sweep', { prevDay }), `${side}: no writers defending, ATM +/- 2 not turning`)
    assert.ok(!find(make({ prem: 'flat' }), side, 'sweep', { prevDay }), `${side}: the ATM option it would buy not back over its EMA 9`)
  }
})

test('at BANKNIFTY and SENSEX scale every play fires the same way, and still not without its key conditions', () => {
  for (const scale of [BANKNIFTY, SENSEX]) {
    for (const [make, side, mode, prev] of [[trendLong, 'LONG', 'trend'], [trendShort, 'SHORT', 'trend'], [rangeLong, 'LONG', 'range'], [rangeShort, 'SHORT', 'range'], [sweepShort, 'SHORT', 'sweep', true], [sweepLong, 'LONG', 'sweep', true]]) {
      const prevDay = prev ? prevOf(side, scale) : null
      const s = find(make({ scale }), side, mode, { prevDay })
      assert.ok(s, `${mode} ${side} at ${scale.base}`)
      assert.equal(s.optLeg, mode === 'range' ? 'sell' : 'buy')
    }
    assert.ok(!find(trendLong({ scale, oiFlat: true }), 'LONG', 'trend'))
    assert.ok(!find(rangeShort({ scale, oneSided: true }), 'SHORT', 'range'))
    assert.ok(!find(sweepShort({ scale, noBack: true }), 'SHORT', 'sweep', { prevDay: prevOf('SHORT', scale) }))
  }
})

test('no look-ahead: what happens after the clock changes nothing, and the tuning\'s day scan finds the same signal', () => {
  const pick = (w) => at(w).filter((s) => s.id === 'spotAdaptive').map(({ oiCtx, ...s }) => s) // eslint-disable-line no-unused-vars
  assert.deepEqual(pick(trendLong({ after: true })), pick(trendLong()))
  for (const [make, prevDay] of [[trendLong, null], [rangeShort, null], [sweepShort, prevOf('SHORT')]]) {
    const w = make()
    const s = at(w, 90, prevDay).find((x) => x.id === 'spotAdaptive')
    const day = scanSpotDay({ bars: done(w, 90), oi: w.oi, prevDay })
    assert.ok(day.some((x) => x.id === 'spotAdaptive' && x.t === s.t && x.side === s.side && x.optLeg === s.optLeg), `${s.mode}: the tuning sees it too`)
  }
})

test('at most 5 a day: the cap counts every side, a refused setup does not count, the next day starts again', () => {
  const day = (d, m) => Date.parse(`2026-10-${d}T03:45:00Z`) + m * MIN
  const mk = (t, side = 'LONG', id = 'spotAdaptive') => ({ id, side, t })
  // Seven LONG / SHORT signals 25 minutes apart: the first 5 are taken, the 6th and 7th refused.
  const seven = Array.from({ length: 7 }, (_, i) => mk(day('09', 20 + i * 25), i % 2 ? 'SHORT' : 'LONG'))
  assert.equal(firstPerCooldown(seven).length, 5)
  // Another strategy has no cap.
  assert.equal(firstPerCooldown(seven.map((s) => ({ ...s, id: 'spotWallBreak' }))).length, 7)
  // The next day: a fresh 5.
  assert.ok(canFire(firstPerCooldown(seven), mk(day('10', 20))))
  // Two in the same minute at 4 taken: only one gets the last slot.
  const four = firstPerCooldown(seven).slice(0, 4)
  const t = day('09', 300)
  assert.equal(firable(four, [mk(t, 'LONG'), mk(t, 'SHORT')]).length, 1)
  // The cooldown still holds within the cap.
  assert.ok(!canFire([mk(day('09', 20))], mk(day('09', 30))))
})

test('the live scan and the tuning take the same signals - the cap included', () => {
  // spotScanMinutes (the server scanner / the page) against firstPerCooldown(scanSpotDay) (the tuning) on a range day.
  const w = rangeLong()
  const tuning = firstPerCooldown(scanSpotDay({ bars: w.bars, oi: w.oi }))
  const live = spotScanMinutes({ from: T, to: T + 91 * MIN, bars: w.bars, oi: w.oi }, { fired: [] })
  assert.deepEqual(live.fresh.map((s) => `${s.id}|${s.side}|${s.t}`), tuning.map((s) => `${s.id}|${s.side}|${s.t}`))
})

test('the option leg: the signal\'s own under "per strategy" - an index side or a tuned leg still wins', () => {
  const buy = { id: 'spotAdaptive', optLeg: 'buy' }
  const sell = { id: 'spotAdaptive', optLeg: 'sell' }
  assert.equal(optionPlanFor('spotAdaptive', {}, { autoPaper: 'strategy' }, null, buy).leg, 'buy')
  assert.equal(optionPlanFor('spotAdaptive', {}, { autoPaper: 'strategy' }, null, sell).leg, 'sell')
  assert.equal(optionPlanFor('spotAdaptive', {}, { autoPaper: 'sell' }, null, buy).leg, 'sell', 'the index set to Sell wins')
  assert.equal(optionPlanFor('spotAdaptive', {}, { autoPaper: 'off' }, null, buy).leg, null, 'alert only')
  assert.equal(optionPlanFor('spotAdaptive', { spotAdaptive: { tradeOptLeg: 'sell' } }, { autoPaper: 'strategy' }, null, buy).leg, 'sell', 'a tuned leg wins')
  assert.equal(optionPlanFor('spotAdaptive', {}, { autoPaper: 'strategy' }).leg, 'sell', 'no signal: as before')
  assert.equal(optionPlanFor('spotWallBreak', {}, { autoPaper: 'strategy' }, null, {}).leg, 'sell', 'a strategy without its own leg: unchanged')
  // The tuning takes it the same way.
  assert.equal(legFor({ optLeg: 'signal' }, buy), 'buy')
  assert.equal(legFor({}, sell), 'sell')
  assert.equal(legFor({ optLeg: 'sell' }, buy), 'sell')
  assert.equal(legFor({ optLeg: 'signal' }, {}), 'sell')
})

test('the tuning measures #115 with each signal\'s own leg as written - the trend day\'s option BOUGHT, the range day\'s SOLD', () => {
  for (const [make, leg] of [[trendLong, 'BUY'], [rangeLong, 'SELL']]) {
    const w = make()
    const setups = scanSpotDay({ bars: w.bars, oi: w.oi }).filter((s) => s.id === 'spotAdaptive')
    const tday = tuningDay('2026-10-09', setups, { minuteBars: w.bars, heatmap: [] }, w.oi)
    const s = setups[0]
    const o = optionOutcome(tday, s, { exitAt: s.t }, { optLeg: 'signal', optMoneyness: 0, optExit: 'index' })
    assert.equal(o?.trade.action, leg)
    // The option stage's as-written baseline is the signal's own leg; a lab setting may say 'signal' too.
    const r = tuneStrategy([tday], 'spotAdaptive', { what: 'option', minTrades: 1, simplest: false })
    assert.equal(r.baseline.params.optLeg, 'signal')
    assert.equal(evaluateSetting([tday], 'spotAdaptive', { optLeg: 'signal' }).params.optLeg, 'signal')
  }
})
