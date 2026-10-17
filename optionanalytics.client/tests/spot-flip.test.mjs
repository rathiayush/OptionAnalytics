// #101 (spotEngine.js): the since-open CE - PE lines cross on the 1-minute clock (the alert) -> within `armMin` minutes the spot's
// 3-minute EMA 7 / 21 crosses the trade's way and the entry is taken when THAT candle closes -> with the cumulative CE / PE change,
// the S / R OI near the ATM going the trade's way (writers adding on the holding side, leaving on the other) with a big net
// difference, and the strikes right round the ATM doing the same. It fires on its rules - LONG and SHORT - and not when each key
// condition is missing; nothing after the clock is read. Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PARAM_BLOCKS, SPOT_STRATEGIES, STRATEGY_BY_ID, STRATEGY_FILTERS, blocksOf, filterGroup, strategyFilters } from '../src/strategyEngine.js'
import { emaAgrees, evaluateSpotStrategies, scanSpotDay, spotBlocks } from '../src/spotEngine.js'
import { firstPerCooldown } from '../src/scanDay.js'
import { DEFAULT_VARIANT, entryDefsFor, entryPartOf, filtersFromTuning, labOverrides, labParams, paramsFromFilters } from '../src/strategyTuning.js'
import { MIN, T, TURN, crossLong, crossShort } from './spot-flip-world.mjs'

// (The day scan finds a setup on every minute it holds; the scanner's list is the first of them - the 20-minute cooldown.)
const mine = (w, filters = {}) => firstPerCooldown(scanSpotDay({ bars: w.bars, oi: w.oi, filters }).filter((s) => s.id === 'spotFlip'))
const all = (w, filters = {}) => scanSpotDay({ bars: w.bars, oi: w.oi, filters }).filter((s) => s.id === 'spotFlip')
const withF = (o) => ({ spotFlip: o })

test('#101 is the one spot strategy: the CE / PE crossover, then the spot EMA', () => {
  assert.equal(SPOT_STRATEGIES.length, 1)
  const s = STRATEGY_BY_ID.spotFlip
  assert.ok(s?.spot && s.no === 101 && !s.retired)
})

test('LONG and SHORT: the lines cross, the spot\'s 3-minute EMA crosses on the candle that just closed, everything with the trade - one entry', () => {
  for (const [make, side] of [[crossLong, 'LONG'], [crossShort, 'SHORT']]) {
    const found = mine(make())
    assert.equal(found.length, 1, side)
    const s = found[0]
    assert.equal(s.side, side)
    assert.ok(((s.t - T) / MIN) % 3 === 0, 'the entry is at the close of a 3-minute candle')
    assert.match(s.checks.Alert, /since the open the CE - PE lines crossed at \d\d:\d\d .* (puts|calls) added lead/)
    assert.match(s.checks.Trend, /3-min EMA 7 .* (over|under) EMA 21 .* crossed on the candle that just closed/)
    assert.match(s.checks.Cumulative, /since the open CE .* \/ PE /)
    assert.match(s.checks.Walls, /ATM \+\/- 2: over 10 min PE .* \/ CE .* - (support|resistance) heavier by \d+%/)
    assert.match(s.checks['Round the ATM'], /ATM \+\/- 1: PE .* \/ CE /)
    assert.ok(s.options?.buy && s.options?.sell, 'both options priced for the trade')
  }
  const long = mine(crossLong())[0]
  assert.ok(long.stop < long.entry && long.target > long.entry)
  assert.ok(Math.abs((long.target - long.entry) - 2 * (long.entry - long.stop)) < 1e-6, 'index stop 1.5 ATR, target 3 ATR')
  assert.equal(long.trailOverride, undefined, 'no trailing stop of its own')
})

test('not without each key condition', () => {
  assert.equal(mine(crossLong({ noCross: true })).length, 0, 'the spot\'s EMA never crosses up')
  assert.equal(mine(crossLong({ noFlip: true })).length, 0, 'the CE - PE lines never cross')
  assert.equal(mine(crossLong({ callsStay: true })).length, 0, 'the calls are not leaving (and the cumulative change is not with a long)')
  assert.equal(mine(crossLong({ ceHeavy: true })).length, 0, 'resistance heavier round the ATM')
  assert.equal(mine(crossLong({ smallNet: true })).length, 0, 'the puts are only a little heavier - not a big net difference')
  assert.equal(mine(crossLong({ atmCalls: true })).length, 0, 'the strikes right round the ATM are not going the trade\'s way')
  assert.equal(mine(crossLong({ lateTurn: true })).length, 0, 'the spot turns up too long after the lines crossed (armMin 30)')
})

test('configurable: how long to wait, the strikes, the net difference, the EMA candle and lengths, "already in direction"', () => {
  const f = strategyFilters('spotFlip', {})
  assert.deepEqual([f.armMin, f.emaTf, f.emaFast, f.emaSlow, f.emaMode, f.cumDelta, f.deltaMin, f.wallMin, f.nearStrikes, f.atmStrikes, f.netMinPct, f.stopAtr, f.targetAtr], [30, 3, 7, 21, 'cross', 'notAgainst', 10, 10, 2, 1, 25, 1.5, 3], 'the defaults')
  assert.equal(mine(crossLong({ lateTurn: true }), withF({ armMin: 120 })).length, 1, 'waiting longer lets the late EMA crossover through')
  assert.equal(mine(crossLong({ smallNet: true }), withF({ netMinPct: 10 })).length, 1, 'a smaller net difference asked')
  assert.equal(mine(crossLong(), withF({ netMinPct: 40 })).length, 0, 'a bigger one')
  assert.equal(mine(crossLong({ atmCalls: true }), withF({ atmStrikes: 0 })).length, 1, 'the strikes round the ATM not asked')
  assert.equal(mine(crossLong({ ceHeavy: true }), withF({ netMinPct: 0 })).length, 0, 'the net difference off still needs the puts to lead the calls')
  // Other EMA lengths read the same day: 9 / 21 crosses a candle later (the entry moves with it); a EMA that crosses before the cumulative change is with the trade does not enter.
  assert.deepEqual(mine(crossLong(), withF({ emaFast: 9 })).map((s) => (s.t - T) / MIN), [75])
  assert.equal(mine(crossLong(), withF({ emaTf: 1 })).length, 0, 'the 1-minute EMA crosses before the cumulative CE / PE change is with a long')
  // "Already in direction" counts too: a trend under way (no fresh cross on this candle) can enter on any candle close while armed.
  const fresh = all(crossLong())
  const state = all(crossLong(), withF({ emaMode: 'state' }))
  assert.ok(state.length > fresh.length, 'more candle closes qualify')
  assert.ok(state.every((s) => ((s.t - T) / MIN) % 3 === 0))
  assert.equal(strategyFilters('spotFlip', { emaTf: 4 }).emaTf, 3, 'only the listed candle sizes')
})

test('no look-ahead: what happens after the clock changes nothing', () => {
  const full = crossLong()
  const cut = crossLong({ minutes: 73 })
  const clock = T + 72 * MIN
  const at = (w) => evaluateSpotStrategies({ nowMs: clock, bars: w.bars.filter((b) => b.t + MIN <= clock), oi: w.oi }).filter((s) => s.id === 'spotFlip')
  assert.equal(at(full).length, 1)
  assert.deepEqual(at(full), at(cut))
  assert.deepEqual(firstPerCooldown(all(full)).map((s) => s.t), mine(full).map((s) => s.t))
})

test('the stop and target in ATR are configurable (the exits block)', () => {
  const base = mine(crossLong())[0]
  const wide = mine(crossLong(), withF({ stopAtr: 2.5, targetAtr: 5 }))[0]
  const stop = base.entry - base.stop
  assert.ok(Math.abs((wide.entry - wide.stop) - stop * 2.5 / 1.5) < 0.01)
  assert.ok(Math.abs((wide.target - wide.entry) - (base.target - base.entry) * 5 / 3) < 0.01)
})

test('the EMA is checked crossed on the last candle or already in direction (emaAgrees)', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i)
  assert.equal(emaAgrees(up, 3, 7, 'state', 1, 1).ok, true)
  assert.equal(emaAgrees(up, 3, 7, 'state', 1, -1).ok, false)
  assert.equal(emaAgrees(up, 3, 7, 'cross', 1, 1).ok, false, 'a long-running climb is not a cross on the last candle')
  const turn = [...Array.from({ length: 20 }, (_, i) => 120 - i), ...Array.from({ length: 6 }, (_, i) => 100 + 3 * i)]
  assert.equal(emaAgrees(turn, 3, 7, 'cross', 6, 1).ok, true)
  assert.equal(emaAgrees(up, 7, 3, 'state', 1, 1).ok, false, 'a slow length that is not slower reads nothing')
})

test('parameters: own rules + the exits block + the trade filters; the lab can change them; every one is consistent', () => {
  assert.deepEqual(blocksOf('spotFlip'), ['exits'])
  assert.deepEqual(Object.keys(PARAM_BLOCKS), ['exits'])
  const defs = STRATEGY_FILTERS.spotFlip
  assert.deepEqual([...new Set(defs.map(filterGroup))], ['Its own rules', 'Index stop-loss and target', 'How the trade is taken (every strategy)'])
  assert.deepEqual(entryDefsFor(['spotFlip']).map((d) => d.key), ['armMin', 'emaTf', 'emaFast', 'emaSlow', 'emaMode', 'cumDelta', 'deltaMin', 'wallMin', 'nearStrikes', 'atmStrikes', 'netMinPct', 'stopAtr', 'targetAtr'])
  assert.deepEqual(labParams({ emaTf: 5, emaFast: 7, netMinPct: 40 }, 'spot', ['spotFlip']), { emaTf: 5, netMinPct: 40 })
  assert.deepEqual(labOverrides({ emaFast: 7 }, 'spot', ['spotFlip']), { emaFast: 7 })
  assert.deepEqual(paramsFromFilters({ emaTf: 5, wallMin: 10 }, 'spotFlip'), { emaTf: 5 })
  const next = filtersFromTuning({ emaTf: 5, nearStrikes: 3 }, { ...DEFAULT_VARIANT, emaTf: 3, netMinPct: 40 }, { id: 'spotFlip' })
  assert.deepEqual([next.netMinPct, next.emaTf, next.nearStrikes], [40, undefined, 3])
  assert.deepEqual(entryPartOf('spotFlip', { emaTf: 5, tradeSide: 'long' }), { emaTf: 5 })
  // A block not listed is not given settings; the exits default to 1.5 / 3 ATR.
  assert.deepEqual(Object.values(spotBlocks({ blocks: [], f: { stopAtr: 9, targetAtr: 9 }, atr: 2 }).exits), [3, 6])
  for (const [id, list] of Object.entries(STRATEGY_FILTERS)) {
    assert.equal(new Set(list.map((f) => f.key)).size, list.length, `${id}: a key twice`)
    for (const f of list) {
      assert.ok(f.label && f.type, `${id}.${f.key}`)
      if (f.type === 'number') assert.ok(f.min <= f.default && f.default <= f.max && f.step > 0, `${id}.${f.key}: default in range`)
      if (f.type === 'select') assert.ok(f.options.some((o) => o.value === f.default), `${id}.${f.key}: default is an option`)
      if (f.type === 'number') assert.equal(strategyFilters(id, { [f.key]: f.max + 1000 })[f.key], f.max, `${id}.${f.key}: clamped`)
    }
  }
})

test('the server accepts every rule setting in a lab job, and the Expired Backtest shares the scanner\'s numbers', () => {
  const root = new URL('../../OptionAnalytics.Server/', import.meta.url)
  const controller = readFileSync(new URL('Controllers/StrategyTuningController.cs', root), 'utf8')
  const missing = entryDefsFor(SPOT_STRATEGIES.map((s) => s.id)).map((d) => d.key).filter((k) => !controller.includes(`"${k}"`))
  assert.deepEqual(missing, [], 'add these keys to LabParamKeys')
  const cs = readFileSync(new URL('Services/Backtesting/SpotFlipStrategy.cs', root), 'utf8')
  const num = (x) => Number(String(x).replace(/m$/, ''))
  const specs = {}
  for (const m of cs.matchAll(/new BacktestParameterSpec\("(\w+)", "[^"]*", Default: ([\w.]+), Min: ([\w.]+), Max: ([\w.]+), Step: [\w.]+/g)) specs[m[1]] = { def: num(m[2]), min: num(m[3]), max: num(m[4]) }
  let shared = 0
  for (const f of STRATEGY_FILTERS.spotFlip.filter((x) => x.type === 'number' && specs[x.key])) {
    shared++
    assert.deepEqual([specs[f.key].def, specs[f.key].min, specs[f.key].max], [f.default, f.min, f.max], `${f.key}: the Expired Backtest and the scanner agree`)
  }
  assert.ok(shared >= 8, `${shared} shared numbers checked`)
  assert.match(cs, /SignalStartTimeParameter\(\) with \{ Default = 570 \}/)
  assert.match(cs, /MaxHoldingTimeParameter\(\) with \{ Default = 330 \}/)
})

test('the cumulative CE / PE change since the open (the OI heatmap) only has to be NOT AGAINST the trade - or with it, or not asked', () => {
  // Both sides up since the open: neither with nor against a long.
  const day = () => crossLong({ bothUp: true })
  const cum = mine(day())[0]?.checks.Cumulative
  assert.match(cum, /since the open CE \+[\d.]+% \/ PE \+[\d.]+%/, 'fires by default: not against')
  assert.equal(mine(day(), withF({ cumDelta: 'with' })).length, 0, 'asked to be WITH the trade it is not')
  assert.equal(mine(day(), withF({ cumDelta: 'off' })).length, 1, 'not asked')
  assert.equal(mine(crossLong(), withF({ cumDelta: 'with' })).length, 1, 'a day with the puts clearly leading is with it too')
})

test('the whole chain over the last 10 minutes: the writers on the trade\'s side adding and the other side leaving', () => {
  assert.equal(strategyFilters('spotFlip', {}).deltaMin, 10)
  assert.equal(mine(crossLong({ farCalls: true })).length, 0, 'calls away from the ATM keep being added - the chain\'s calls are not leaving')
  assert.equal(mine(crossLong({ farCalls: true }), withF({ deltaMin: 0 })).length, 1, 'not asked: the rest of the rule still holds')
  for (const make of [crossLong, crossShort]) assert.equal(mine(make()).length, 1)
})
