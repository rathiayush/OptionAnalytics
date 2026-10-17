// #101, the CE / PE flip (spotEngine.js): when the whole chain's CE - PE change since the open flips sign on the 1-minute
// clock - puts added overtake calls (a long), or the reverse - AND the spot's 3-minute EMA 7 / 21 agrees, the CE / PE change
// over the last few minutes (configurable) is with the trade, and the support / resistance OI round the ATM (+/- 2 strikes,
// configurable) sits with it: a signal with an index stop and target (BUY / SELL per the index's setting). It fires on its
// rules - LONG and SHORT - and not when each key condition is missing; nothing after the clock is read; the day scan finds it
// too. Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { PARAM_BLOCKS, SPOT_STRATEGIES, STRATEGY_BY_ID, STRATEGY_FILTERS, applyTradeFilter, blocksOf, filterGroup, strategyFilters, trailedStop } from '../src/strategyEngine.js'
import { emaAgrees, evaluateSpotStrategies, scanSpotDay, spotBlocks } from '../src/spotEngine.js'
import { firstPerCooldown } from '../src/scanDay.js'
import { DEFAULT_VARIANT, entryDefsFor, entryPartOf, filtersFromTuning, labOverrides, labParams, paramsFromFilters } from '../src/strategyTuning.js'
import { CLIMB, MIN, T, crossLong, crossShort, flipLong, flipShort } from './spot-flip-world.mjs'

// The defaults are now the crossover trigger; most scenarios below are the flip trigger's, so they are read with the flip rule
// as it was (EMA already in direction, no ATM option EMAs) under whatever a test sets.
const FLIP_RULE = { trigger: 'flip', emaMode: 'state', optEmaMode: 'off', optEmaLegs: 'traded', crossBars: 3 }
const mine = (w, filters = {}) => scanSpotDay({ bars: w.bars, oi: w.oi, filters: { ...filters, spotFlip: { ...FLIP_RULE, ...(filters.spotFlip ?? {}) } } }).filter((s) => s.id === 'spotFlip')
// (A fresh cross stays fresh for `crossBars` candles, so the day scan finds it on each of those minutes: the scanner's list is the first of them - the 20-minute cooldown.)
const byDefault = (w, filters = {}) => firstPerCooldown(scanSpotDay({ bars: w.bars, oi: w.oi, filters }).filter((s) => s.id === 'spotFlip'))

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
  const at = (w) => evaluateSpotStrategies({ nowMs: clock, bars: w.bars.filter((b) => b.t + MIN <= clock), oi: w.oi, filters: { spotFlip: FLIP_RULE } }).filter((s) => s.id === 'spotFlip')
  assert.equal(at(full).length, 1)
  assert.deepEqual(at(full), at(cut))
  assert.deepEqual(firstPerCooldown(mine(full)).map((s) => s.t), mine(full).map((s) => s.t))
})

test('a trailing stop of its own: per index (NIFTY 10 / BANKNIFTY 20 / SENSEX 30 points), dynamic (x ATR) or none', () => {
  // (A setup trades with `trail` - the live scan puts its own trailOverride there (withOwnTrail), the tuning the same.)
  const withTrail = (x) => ({ ...x, trail: x.trailOverride })
  const day = (filters, underlying = 'NIFTY', make = flipLong) => scanSpotDay({ bars: make().bars, oi: make().oi, filters: { spotFlip: { ...FLIP_RULE, ...filters } }, underlying }).filter((x) => x.id === 'spotFlip')[0]
  const s = withTrail(day({}))
  assert.deepEqual(s.trailOverride, { unit: 'pts', startPts: 10, gapPts: 10 })
  assert.match(s.checks.Trail, /NIFTY trailing stop after 10 pts, 10 pts behind/)
  // The stop stays where it was until the trade is 10 points up, then follows 10 behind the best price - never loosened.
  assert.equal(trailedStop(s, s.entry + 9), s.stop)
  assert.ok(Math.abs(trailedStop(s, s.entry + 10) - s.entry) < 1e-9, 'at +10 the stop reaches the entry')
  assert.ok(Math.abs(trailedStop(s, s.entry + 25) - (s.entry + 15)) < 1e-9)
  const short = withTrail(day({}, 'NIFTY', flipShort))
  assert.ok(Math.abs(trailedStop(short, short.entry - 25) - (short.entry - 15)) < 1e-9, 'the short trails the other way')
  // Each index has its own, each configurable.
  assert.deepEqual(day({}, 'BANKNIFTY').trailOverride, { unit: 'pts', startPts: 20, gapPts: 20 })
  assert.deepEqual(day({}, 'SENSEX').trailOverride, { unit: 'pts', startPts: 30, gapPts: 30 })
  assert.deepEqual(day({ trailStartBANKNIFTY: 40, trailGapBANKNIFTY: 15 }, 'BANKNIFTY').trailOverride, { unit: 'pts', startPts: 40, gapPts: 15 })
  assert.deepEqual(day({ trailStartBANKNIFTY: 40 }, 'NIFTY').trailOverride, { unit: 'pts', startPts: 10, gapPts: 10 }, 'another index\'s setting does not touch this one')
  assert.deepEqual(day({}, null).trailOverride, { unit: 'pts', startPts: 10, gapPts: 10 }, 'no index named: NIFTY\'s')
  // Dynamic: a multiple of the ATR at the signal.
  const dyn = day({ trailMode: 'atr', trailStartAtr: 2, trailGapAtr: 1 })
  const atr = (dyn.entry - dyn.stop) / 1.5
  assert.ok(Math.abs(dyn.trailOverride.startPts - 2 * atr) < 0.01 && Math.abs(dyn.trailOverride.gapPts - atr) < 0.01)
  assert.match(dyn.checks.Trail, /\(2 ATR\).*\(1 ATR\)/)
  assert.equal(day({ trailMode: 'off' }).trailOverride, null, 'none')
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

test('the EMA can be already in direction, a fresh crossover, or not asked (emaAgrees)', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i)
  assert.equal(emaAgrees(up, 3, 7, 'state', 3, 1).ok, true, 'a steady climb is in direction')
  assert.equal(emaAgrees(up, 3, 7, 'state', 3, -1).ok, false, 'and not for a fall')
  assert.equal(emaAgrees(up, 3, 7, 'cross', 3, 1).ok, false, 'but it crossed long ago')
  const turn = [...Array.from({ length: 20 }, (_, i) => 120 - i), ...Array.from({ length: 6 }, (_, i) => 100 + 3 * i)]
  assert.equal(emaAgrees(turn, 3, 7, 'cross', 6, 1).ok, true, 'a turn up crosses within a few candles')
  assert.equal(emaAgrees(up, 3, 7, 'off', 3, -1).ok, true, 'not asked: always fine')
  assert.equal(emaAgrees(up, 7, 3, 'state', 3, 1).ok, false, 'a slow length that is not slower reads nothing')
})

test('the spot EMA is configurable: not asked lets a flat spot through; a fresh crossover is not a long-running trend', () => {
  assert.equal(mine(flipLong({ noTrend: true })).length, 0)
  assert.equal(mine(flipLong({ noTrend: true }), { spotFlip: { emaMode: 'off' } }).length, 1, 'EMA not asked')
  assert.equal(mine(flipLong(), { spotFlip: { emaMode: 'cross', crossBars: 1 } }).length, 0, 'the climb crossed long before the flip')
})

test('VWAP: the spot on the trade\'s side of the day\'s VWAP (long above, short below), off by default', () => {
  assert.equal(strategyFilters('spotFlip', {}).vwapMode, 'off')
  assert.equal(mine(flipLong(), { spotFlip: { vwapMode: 'with' } }).length, 1, 'a climbing spot is over its VWAP')
  assert.equal(mine(flipShort(), { spotFlip: { vwapMode: 'with' } }).length, 1, 'a falling spot is under it')
})

test('the ATM CE / PE EMAs are configurable (aligned already is fine by default)', () => {
  const f = strategyFilters('spotFlip', {})
  assert.deepEqual([f.optEmaMode, f.optEmaLegs, f.optEmaFast, f.optEmaSlow, f.crossBars, f.emaMode, f.trigger, f.minLeadPct], ['state', 'both', 7, 21, 2, 'cross', 'cross', 0.3])
  // Whatever the fixture's premiums say, asking for the ATM EMAs can only remove signals, never add them.
  for (const o of [{ optEmaMode: 'state' }, { optEmaMode: 'cross' }, { optEmaMode: 'state', optEmaLegs: 'both' }]) {
    assert.ok(mine(flipLong(), { spotFlip: o }).length <= mine(flipLong()).length, JSON.stringify(o))
  }
})

test('the Strategy lab can change #101\'s own rules (timeframes, EMAs, VWAP, ATM option EMAs), not only the trade settings', () => {
  const keys = entryDefsFor(['spotFlip']).map((d) => d.key)
  for (const k of ['flipTf', 'emaTf', 'emaMode', 'crossBars', 'emaFast', 'emaSlow', 'vwapMode', 'optEmaMode', 'optEmaLegs', 'optEmaFast', 'optEmaSlow', 'deltaMin', 'nearStrikes', 'trailMode']) assert.ok(keys.includes(k), k)
  assert.ok(!keys.includes('tradeSide'), 'the trade filters are not its own rules')
  // Sent to the job: only what differs from as written (and every key set, as changes on top of several strategies' starts).
  assert.deepEqual(labParams({ emaTf: 5, emaFast: 7, vwapMode: 'with' }, 'spot', ['spotFlip']), { emaTf: 5, vwapMode: 'with' })
  assert.deepEqual(labOverrides({ emaFast: 7 }, 'spot', ['spotFlip']), { emaFast: 7 })
  assert.deepEqual(labParams({ emaTf: 5 }, 'spot', []), {}, 'a key of a strategy not picked is not sent')
  // What is applied reads back, and applying a lab setting writes the rules (and removes one set back to its default).
  assert.deepEqual(paramsFromFilters({ emaTf: 5, deltaMin: 10 }, 'spotFlip'), { emaTf: 5 })
  const next = filtersFromTuning({ emaTf: 5, nearStrikes: 3 }, { ...DEFAULT_VARIANT, emaTf: 3, vwapMode: 'with' }, { id: 'spotFlip' })
  assert.equal(next.vwapMode, 'with')
  assert.equal(next.emaTf, undefined, 'back at its default = removed')
  assert.equal(next.nearStrikes, 3, 'a rule the lab setting does not mention stays')
  assert.deepEqual(entryPartOf('spotFlip', { emaTf: 5, tradeSide: 'long' }), { emaTf: 5 })
})

test('trailing in R (x the stop distance), the stop and target in ATR, and the EMAs warmed up from the previous day', () => {
  const f = strategyFilters('spotFlip', {})
  assert.deepEqual([f.stopAtr, f.targetAtr, f.trailStartR, f.trailGapR, f.emaWarm], [1.5, 3, 1, 1, false], 'the defaults are the rule as written')
  const base = mine(flipLong())[0]
  const r = mine(flipLong(), { spotFlip: { trailMode: 'r', trailStartR: 0.5, trailGapR: 1 } })[0]
  const stop = base.entry - base.stop
  assert.ok(Math.abs(r.trailOverride.startPts - 0.5 * stop) < 0.01 && Math.abs(r.trailOverride.gapPts - stop) < 0.01, 'trailing 0.5R after, 1R behind')
  assert.match(r.checks.Trail, /\(0\.5R\).*\(1R\)/)
  const wide = mine(flipLong(), { spotFlip: { stopAtr: 2.5, targetAtr: 5 } })[0]
  assert.ok(Math.abs((wide.entry - wide.stop) - stop * 2.5 / 1.5) < 0.01 && Math.abs((wide.target - wide.entry) - 2 * (base.target - base.entry) * 5 / 6) < 0.01)
  // EMA 80 on 3-minute candles is never ready in one session; the previous day's candles in front make it ready at the open.
  const slow = { emaFast: 7, emaSlow: 80 }
  assert.equal(mine(flipLong(), { spotFlip: slow }).length, 0)
  const prevDay = { date: '2025-01-01', high: 22400, low: 22000, close: 22399, closes: Array.from({ length: 375 }, (_, i) => 22000 + i) }
  const w = scanSpotDay({ ...flipLong(), filters: { spotFlip: { ...FLIP_RULE, ...slow, emaWarm: true } }, prevDay }).filter((s) => s.id === 'spotFlip')
  assert.equal(w.length, 1, 'ready with the previous day in front')
})

test('predefined parameter blocks: a strategy lists the blocks it has; its filters are its own rules + those blocks + the trade filters', () => {
  assert.deepEqual(blocksOf('spotFlip'), ['ema', 'vwap', 'optEma', 'exits', 'trail'])
  const defs = STRATEGY_FILTERS.spotFlip
  const groups = [...new Set(defs.map(filterGroup))]
  assert.deepEqual(groups, ['Its own rules', 'Spot EMA', 'VWAP', 'ATM option EMAs (CE / PE)', 'Index stop-loss and target', 'Trailing stop', 'How the trade is taken (every strategy)'])
  for (const [b, { filters }] of Object.entries(PARAM_BLOCKS)) for (const f of filters) assert.ok(defs.find((d) => d.key === f.key && d.block === b), `${b}: ${f.key}`)
  // A block not listed is neither asked nor given settings: with none, the strategy only needs its own rule.
  const pass = spotBlocks({ blocks: [], f: { emaMode: 'state', vwapMode: 'with', optEmaMode: 'state' }, bars: [], oi: { step: 50 }, nowMs: 0, minute: 570, spotNow: 100, atr: 2 })
  assert.equal(pass.confirm(1).ok, true, 'no blocks = nothing asked')
  assert.deepEqual([pass.exits.stopPts, pass.exits.targetPts, pass.exits.trail], [3, 6, null], 'and the default 1.5 / 3 ATR, no trailing stop')
})

test('the server accepts every own rule and block setting in a lab job (StrategyTuningController LabParamKeys)', async () => {
  const { readFileSync } = await import('node:fs')
  const cs = readFileSync(new URL('../../OptionAnalytics.Server/Controllers/StrategyTuningController.cs', import.meta.url), 'utf8')
  const missing = entryDefsFor(SPOT_STRATEGIES.map((s) => s.id)).map((d) => d.key).filter((k) => !cs.includes(`"${k}"`))
  assert.deepEqual(missing, [], 'add these keys to LabParamKeys')
})

test('the crossover trigger (default): a FRESH spot EMA crossover with the OI behind it - once, at the cross', () => {
  const f = strategyFilters('spotFlip', {})
  assert.deepEqual([f.trigger, f.emaMode, f.optEmaMode, f.optEmaLegs, f.minLeadPct], ['cross', 'cross', 'state', 'both', 0.3], 'the defaults')
  for (const [make, side] of [[crossLong, 'LONG'], [crossShort, 'SHORT']]) {
    const found = byDefault(make())
    assert.equal(found.length, 1, side)
    const s = found[0]
    assert.equal(s.side, side)
    const minutes = (s.t - T) / MIN
    assert.ok(minutes >= CLIMB && minutes <= CLIMB + 20, `at the cross - minute ${minutes}`)
    assert.match(s.checks.OI, /since the open CE - PE .*% of the chain \((puts|calls) added lead\)/)
    assert.match(s.checks.Trend, /EMA 7 .* (over|under) EMA 21 .*crossed within 2 candles/)
    assert.match(s.checks['ATM option EMA'], /and the (PE|CE) under/)
    assert.match(s.checks.Walls, /heavier/)
  }
})

test('the crossover trigger: not without a fresh cross, the OI behind it (sideways), walls, or the ATM CE / PE lined up', () => {
  assert.equal(byDefault(crossLong({ sideways: true })).length, 0, 'a sideways OI market - the since-open CE - PE has no lean')
  assert.equal(byDefault(crossLong({ ceLead: true })).length, 0, 'the OI leans against a long')
  assert.equal(byDefault(crossLong({ ceHeavy: true })).length, 0, 'resistance heavier round the ATM')
  assert.equal(byDefault(crossLong({ optFlat: true })).length, 0, 'the ATM CE / PE EMAs do not line up')
  assert.equal(byDefault(crossLong({ optFlat: true }), { spotFlip: { optEmaMode: 'off' } }).length, 1, 'with the ATM EMAs not asked it is the cross, OI and walls')
  // A trend long under way is not fresh: the flip day's spot climbs from the open, the EMAs crossed long before the OI came.
  assert.equal(byDefault(flipLong({ slow: true })).length, 0)
  // Looser: the lean needed can be lowered to nothing; sideways OI then lets the cross through.
  assert.equal(byDefault(crossLong({ sideways: true }), { spotFlip: { minLeadPct: 0 } }).length, 0, 'still needs the since-open lean to be on the trade\'s side and the last minutes\' change with it')
})

test('the ATM CE / PE may already be aligned (state) - a fresh crossover there is optional; the spot\'s must be fresh', () => {
  assert.equal(byDefault(crossLong(), { spotFlip: { optEmaMode: 'state', optEmaLegs: 'traded' } }).length, 1)
  assert.equal(byDefault(crossLong(), { spotFlip: { optEmaMode: 'cross' } }).length, 0, 'asked to cross afresh too, the options had lined up before the spot did - not fresh any more')
  assert.equal(byDefault(crossLong(), { spotFlip: { optEmaMode: 'cross', crossBars: 20 } }).length >= 1, true, 'with a long enough window it counts')
  // Asking "already in direction" for the spot with the crossover trigger still asks a fresh cross.
  assert.equal(byDefault(crossLong(), { spotFlip: { emaMode: 'state' } }).length, 1)
  const trend = byDefault(flipLong(), { spotFlip: { emaMode: 'state' } })
  assert.equal(trend.length, 0, 'a climb that began at the open never crosses afresh later')
})

test('every parameter is consistent: keys unique, defaults inside their range / options, the Expired Backtest\'s numbers the same as the scanner\'s', async () => {
  const { readFileSync } = await import('node:fs')
  for (const [id, defs] of Object.entries(STRATEGY_FILTERS)) {
    assert.equal(new Set(defs.map((f) => f.key)).size, defs.length, `${id}: a key twice`)
    for (const f of defs) {
      assert.ok(f.label && f.type, `${id}.${f.key}: label and type`)
      if (f.type === 'number') assert.ok(f.min <= f.default && f.default <= f.max && f.step > 0, `${id}.${f.key}: default ${f.default} in ${f.min}..${f.max}`)
      if (f.type === 'select') assert.ok(f.options.some((o) => o.value === f.default), `${id}.${f.key}: the default is one of the options`)
      if (f.type === 'switch') assert.equal(typeof f.default, 'boolean', `${id}.${f.key}`)
      // A value the dialogs can set reads back unchanged (clamped numbers, listed choices).
      const low = strategyFilters(id, { [f.key]: f.type === 'number' ? f.min : f.type === 'select' ? f.options.at(-1).value : !f.default })[f.key]
      assert.equal(low, f.type === 'number' ? f.min : f.type === 'select' ? f.options.at(-1).value : !f.default, `${id}.${f.key}: round trip`)
      if (f.type === 'number') assert.equal(strategyFilters(id, { [f.key]: f.max + 1000 })[f.key], f.max, `${id}.${f.key}: clamped to its max`)
    }
  }
  // The Expired Backtest's SpotFlipStrategy.cs: every number it shares with the scanner has the same default and range.
  const cs = readFileSync(new URL('../../OptionAnalytics.Server/Services/Backtesting/SpotFlipStrategy.cs', import.meta.url), 'utf8')
  const num = (x) => Number(String(x).replace(/m$/, ''))
  const specs = {}
  for (const m of cs.matchAll(/new BacktestParameterSpec\("(\w+)", "[^"]*", Default: ([\w.]+), Min: ([\w.]+), Max: ([\w.]+), Step: [\w.]+/g)) specs[m[1]] = { def: num(m[2]), min: num(m[3]), max: num(m[4]) }
  let shared = 0
  for (const f of STRATEGY_FILTERS.spotFlip.filter((x) => x.type === 'number' && specs[x.key])) {
    shared++
    assert.deepEqual([specs[f.key].def, specs[f.key].min, specs[f.key].max], [f.default, f.min, f.max], `${f.key}: the Expired Backtest and the scanner agree`)
  }
  assert.ok(shared >= 14, `${shared} shared numbers checked`)
  // Its entry window and time stop are the scanner's (09:30 - 14:45, 330 minutes).
  assert.match(cs, /SignalStartTimeParameter\(\) with \{ Default = 570 \}/)
  assert.match(cs, /Default: 885/)
  assert.match(cs, /MaxHoldingTimeParameter\(\) with \{ Default = 330 \}/)
})
