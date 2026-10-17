// #101 (spotEngine.js): TWO things only - the since-open CE - PE lines cross on the 1-minute clock (the alert), then within `armMin`
// minutes the spot's 3-minute EMA 7 / 21 crosses the SAME way and the entry is taken when that candle closes. It fires on both -
// LONG and SHORT - and not when either is missing; nothing after the clock is read. Run: npm test (node --test) - see CLAUDE.md.
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
    assert.match(s.checks.Trend, /3-min EMA 7 .* (over|under) EMA 21 .* - crossed at \d\d:\d\d/)
    assert.deepEqual(Object.keys(s.checks), ['Alert', 'Trend'], 'nothing else is asked')
    assert.ok(s.options?.buy && s.options?.sell, 'both options priced for the trade')
  }
  const long = mine(crossLong())[0]
  assert.ok(long.stop < long.entry && long.target > long.entry)
  assert.ok(Math.abs((long.target - long.entry) - 2 * (long.entry - long.stop)) < 1e-6, 'index stop 1.5 ATR, target 3 ATR')
  assert.equal(long.trailOverride, undefined, 'no trailing stop of its own')
})

test('not without either: the lines crossing, the spot EMA crossing the same way', () => {
  assert.equal(mine(crossLong({ noCross: true })).length, 0, 'the spot\'s EMA never crosses up')
  assert.equal(mine(crossLong({ noFlip: true, callsStay: true })).length, 0, 'the CE - PE lines never cross (puts not added, calls only stop being added)')
  assert.equal(mine(crossLong({ lateTurn: true })).length, 0, 'the spot turns up too long after the lines crossed (armMin 10)')
  // The OI behind a trade is not asked any more: calls staying, heavy calls, a small net difference, calls round the ATM do not stop it.
  for (const o of [{ callsStay: true }, { ceHeavy: true }, { smallNet: true }, { atmCalls: true }, { bothUp: true }, { farCalls: true }]) assert.equal(mine(crossLong(o)).length, 1, JSON.stringify(o))
})

test('configurable: how long to wait, the EMA candle and lengths, "already in direction"', () => {
  const f = strategyFilters('spotFlip', {})
  assert.deepEqual([f.armMin, f.emaTf, f.emaFast, f.emaSlow, f.emaMode, f.stopAtr, f.targetAtr], [10, 3, 7, 21, 'cross', 1.5, 3], 'the defaults')
  assert.equal(mine(crossLong({ lateTurn: true }), withF({ armMin: 120 })).length, 1, 'waiting longer lets the late EMA crossover through')
  assert.deepEqual(mine(crossLong(), withF({ emaFast: 9, armMin: 15 })).map((s) => (s.t - T) / MIN), [75], 'a 9 / 21 EMA crosses a candle later (11 minutes after the lines) - the entry moves with it, and armMin 10 is too short for it')
  // "Already in direction" counts too: a trend under way (no fresh cross on this candle) can enter on any candle close while armed.
  const fresh = all(crossLong(), withF({ armMin: 30 }))
  const state = all(crossLong(), withF({ emaMode: 'state', armMin: 30 }))
  assert.ok(state.length > fresh.length, 'more candle closes qualify')
  assert.ok(state.every((s) => ((s.t - T) / MIN) % 3 === 0))
  assert.equal(strategyFilters('spotFlip', { emaTf: 4 }).emaTf, 3, 'only the listed candle sizes')
})

test('either order: the EMA crossover can come first and the lines cross a few minutes later - the entry is when the later one completes', () => {
  const small = { emaFast: 3, emaSlow: 7 } // (a 21 EMA is not ready before the lines cross on this day)
  const lines = (w) => mine(w, withF({ ...small, armMin: 15 }))
  for (const make of [crossLong, crossShort]) {
    const found = lines(make({ emaFirst: true }))
    assert.equal(found.length, 1)
    const minutes = (found[0].t - T) / MIN
    assert.equal(minutes, 65, 'the minute the lines cross (the EMA crossed 13 minutes earlier at 10:06)')
    assert.match(found[0].checks.Trend, /crossed at 10:06/)
    assert.match(found[0].checks.Alert, /crossed at 10:19/)
  }
  assert.equal(mine(crossLong({ emaFirst: true }), withF({ ...small, armMin: 10 })).length, 0, 'the two crossovers are 13 minutes apart - too far for 10')
  assert.equal(mine(crossLong({ emaFirst: true }), withF({ ...small, armMin: 30 })).length, 1)
  // The EMA turning back before the lines cross takes the trade away: it has to still be that way when the later one completes.
  assert.equal(mine(crossLong({ emaFirst: true, noCross: true }), withF({ ...small, armMin: 30 })).length, 0)
  // And the other order is unchanged: lines first, the EMA candle closing later (within armMin).
  assert.equal(mine(crossLong()).length, 1)
  assert.equal(mine(crossLong({ lateTurn: true }), withF({ armMin: 10 })).length, 0)
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
  assert.deepEqual(entryDefsFor(['spotFlip']).map((d) => d.key), ['armMin', 'emaTf', 'emaFast', 'emaSlow', 'emaMode', 'stopAtr', 'targetAtr'])
  assert.deepEqual(labParams({ emaTf: 5, emaFast: 7, armMin: 45 }, 'spot', ['spotFlip']), { emaTf: 5, armMin: 45 })
  assert.deepEqual(labOverrides({ emaFast: 7 }, 'spot', ['spotFlip']), { emaFast: 7 })
  assert.deepEqual(paramsFromFilters({ emaTf: 5, armMin: 10 }, 'spotFlip'), { emaTf: 5 })
  const next = filtersFromTuning({ emaTf: 5, nearStrikes: 3 }, { ...DEFAULT_VARIANT, emaTf: 3, armMin: 45 }, { id: 'spotFlip' })
  assert.deepEqual([next.armMin, next.emaTf, next.nearStrikes], [45, undefined, 3])
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
  assert.ok(shared >= 5, `${shared} shared numbers checked`)
  assert.match(cs, /SignalStartTimeParameter\(\) with \{ Default = 570 \}/)
  assert.match(cs, /MaxHoldingTimeParameter\(\) with \{ Default = 330 \}/)
})

