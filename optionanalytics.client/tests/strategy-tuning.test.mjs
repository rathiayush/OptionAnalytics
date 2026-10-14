// Strategy tuning (strategyTuning.js) and the trade filters it tunes (TRADE_FILTERS / applyTradeFilter):
// the defaults change nothing; each filter does what it says; the tuning measures exactly what the scanner
// would fire with a setting; and it only recommends what also wins on days it did not choose on.
// Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyTradeFilter, optionPlanFor, strategyFilters, simulateOutcome } from '../src/strategyEngine.js'
import { scanDaySetups, firstPerCooldown, withDayOutcomes } from '../src/scanDay.js'
import { DEFAULT_VARIANT, OI_GRID, OPTION_DEFAULT, dayTrades, outcomeKey, tradeDetails, scoreR, splitDays, tuneStrategy, walkForward, withWalkForward, rankStrategies, filtersFromTuning, variants, tuningDay, variantText } from '../src/strategyTuning.js'
import { day } from './synthetic-day.mjs'

const MIN = 60_000
const T915 = Date.parse('2026-10-09T03:45:00Z')
const at = (m) => T915 + m * MIN
const setup = (over = {}) => ({ id: 'wallBreak', side: 'LONG', t: at(60), entry: 100, stop: 90, target: 120, timeStopMs: at(80), checks: {}, ...over })

test('trade filters: the defaults change nothing', () => {
  const s = setup()
  assert.equal(applyTradeFilter(s, strategyFilters('wallBreak', {})), s)
})

test('trade filters: sides and the entry window drop what they exclude, and loosening lets it back', () => {
  const long = setup()
  const short = setup({ side: 'SHORT', stop: 110, target: 80 })
  const f = (o) => strategyFilters('wallBreak', o)
  assert.equal(applyTradeFilter(short, f({ tradeSide: 'long' })), null)
  assert.ok(applyTradeFilter(long, f({ tradeSide: 'long' })))
  assert.equal(applyTradeFilter(long, f({ tradeSide: 'short' })), null)
  assert.ok(applyTradeFilter(short, f({ tradeSide: 'both' })))
  // at(60) = 10:15 IST
  assert.equal(applyTradeFilter(long, f({ tradeFrom: 1030 })), null)
  assert.equal(applyTradeFilter(long, f({ tradeTo: 1000 })), null)
  assert.ok(applyTradeFilter(long, f({ tradeFrom: 1015, tradeTo: 1015 })))
})

test('trade filters: stop / target scaled from the entry, a time stop, a trailing stop of its own', () => {
  const f = (o) => strategyFilters('wallBreak', o)
  const s = applyTradeFilter(setup(), f({ tradeStopX: 1.5, tradeTargetX: 2, tradeTimeStop: 30, tradeTrail: '1/1' }))
  assert.equal(s.stop, 85)
  assert.equal(s.target, 140)
  assert.equal(s.timeStopMs, at(90))
  assert.deepEqual(s.trailOverride, { startR: 1, gapR: 1 })
  assert.match(s.checks.Trade, /stop x1.5/)
  const sh = applyTradeFilter(setup({ side: 'SHORT', stop: 110, target: 80 }), f({ tradeStopX: 0.5, tradeTrail: 'off' }))
  assert.equal(sh.stop, 105)
  assert.equal(sh.trailOverride, null)
  // A time stop never runs past the 15:10 square-off.
  const late = applyTradeFilter(setup({ t: at(5 * 60 + 25) }), f({ tradeTimeStop: 120 }))
  assert.equal(late.timeStopMs, at(5 * 60 + 25) + 30 * MIN) // 14:40 + 30 min = 15:10
})

// The synthetic day as a replay day.
const syn = day()
// A balanced book every minute (the DOM read needs one).
const heatmap = syn.path.map((p, m) => ({ t: syn.at(m) + 30_000, bids: [[p - 1, 500]], asks: [[p + 1, 500]] }))
const replayDay = { meta: { lotSize: 75, lastPrice: syn.path.at(-1) }, minuteBars: syn.minuteBars, trades: [], icebergs: [], heatmap, sweeps: [], source: 'live' }
const base = { day: replayDay, prints: syn.prints, oi: syn.oi, profile: null, rowSize: 1, lotSize: 75, largeLots: 10, estimated: false }

test('the tuning measures exactly what the scanner fires with a setting', async () => {
  const all = await scanDaySetups({ ...base, filters: {}, keepAll: true })
  const ids = [...new Set(all.map((s) => s.id))]
  assert.ok(ids.length >= 1, 'something fires on the synthetic day')
  // The scanner's own list = first per cooldown of every minute's setups.
  const listed = await scanDaySetups({ ...base, filters: {} })
  assert.deepEqual(listed.map((s) => `${s.id}:${s.side}:${s.t}`), firstPerCooldown(all).map((s) => `${s.id}:${s.side}:${s.t}`))
  const tday = tuningDay('2026-10-05', all, replayDay)
  for (const id of ids) {
    for (const v of [DEFAULT_VARIANT, { ...DEFAULT_VARIANT, tradeSide: 'long', tradeStopX: 1.5, tradeTrail: 'off' }, { ...DEFAULT_VARIANT, tradeFrom: 1100, tradeTargetX: 2, tradeTimeStop: 30 }]) {
      const scanned = await scanDaySetups({ ...base, filters: { [id]: v }, trail: null })
      const scannerR = withDayOutcomes(scanned.filter((s) => s.id === id), replayDay).map((s) => s.outcome.r)
      assert.deepEqual(dayTrades(tday, id, v, null), scannerR, `${id} ${variantText(v)}`)
    }
  }
})

test('scores: total, average, win rate, profit factor, drawdown and the cautious score', () => {
  const s = scoreR([2, -1, -1, 2, -1])
  assert.equal(s.n, 5)
  assert.equal(s.total, 1)
  assert.equal(s.avg, 0.2)
  assert.equal(s.winRate, 0.4)
  assert.ok(Math.abs(s.pf - 4 / 3) < 1e-9)
  assert.equal(s.maxDD, 2)
  assert.ok(s.score < s.avg)
  assert.equal(scoreR([]).n, 0)
})

test('days split in time: the first 70% choose, the last 30% check; under 5 days no check', () => {
  const days = ['2026-10-07', '2026-10-01', '2026-10-02', '2026-10-06', '2026-10-05', '2026-10-08', '2026-10-03', '2026-10-09', '2026-10-04', '2026-10-10'].map((date) => ({ date }))
  const { train, test } = splitDays(days)
  assert.deepEqual(train.map((d) => d.date), ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'])
  assert.deepEqual(test.map((d) => d.date), ['2026-10-08', '2026-10-09', '2026-10-10'])
  assert.equal(splitDays(days.slice(0, 4)).test.length, 0)
})

// Fake days: LONGs at 10:15 win (+2R), SHORTs at 13:15 lose - one of each a day.
const bar = (m, o, h, l, c) => ({ time: new Date(at(m)).toISOString(), open: o, high: h, low: l, close: c })
function fakeDay(date, { longWins = true, shortWins = false } = {}) {
  const bars = []
  for (let m = 0; m <= 330; m++) bars.push(bar(m, 100, 100.5, 99.5, 100))
  // 10:16 onward: up to 121 (long target 120) or down to 89 (long stop 90).
  bars[61] = longWins ? bar(61, 100, 121, 99.5, 120.5) : bar(61, 100, 100.5, 89, 89.5)
  // 13:16: the short (entry 100, stop 110, target 80).
  bars[241] = shortWins ? bar(241, 100, 100.5, 79, 80) : bar(241, 100, 111, 99.5, 110.5)
  const setups = [
    setup({ t: at(60), entry: 100, stop: 90, target: 120, timeStopMs: at(120) }),
    setup({ side: 'SHORT', t: at(240), entry: 100, stop: 110, target: 80, timeStopMs: at(300) }),
  ]
  return { date, setups, minuteBars: bars, endMs: at(331) }
}

test('tuning picks what wins on the train days and recommends it only when it also wins on the test days', () => {
  const days = Array.from({ length: 12 }, (_, i) => fakeDay(`2026-09-${String(10 + i).padStart(2, '0')}`))
  const grid = { tradeSide: ['both', 'long', 'short'], window: [[930, 1445], [930, 1230]], tradeStopX: [1], tradeTargetX: [1], tradeTimeStop: [0], tradeTrail: ['scanner'] }
  const r = tuneStrategy(days, 'wallBreak', { grid, minTrades: 4 })
  assert.equal(r.tried, 6)
  assert.equal(r.baseline.train.avg, 0.5) // +2 and -1 each day
  assert.notEqual(r.best.params.tradeSide, 'short')
  assert.ok(r.best.params.tradeSide === 'long' || r.best.params.tradeTo === 1230, variantText(r.best.params))
  assert.equal(r.best.train.avg, 2)
  assert.equal(r.recommend, true, r.reason)
  // The same choice on test days where the longs lose and the shorts win: not recommended.
  const flipped = [...days.slice(0, 8), ...Array.from({ length: 4 }, (_, i) => fakeDay(`2026-09-${30 - i}`, { longWins: false, shortWins: true }))]
  const r2 = tuneStrategy(flipped, 'wallBreak', { grid, minTrades: 4 })
  assert.equal(r2.recommend, false)
  assert.match(r2.reason, /lost on the test days|did not beat/)
  // Too few days to check.
  assert.equal(tuneStrategy(days.slice(0, 4), 'wallBreak', { grid, minTrades: 2 }).recommend, false)
})

test('tuning chooses month by month: the months it won are reported, and too few trades a month is not chosen', () => {
  const dates = []
  for (const [m, n] of [['06', 8], ['07', 8], ['08', 8], ['09', 10]]) for (let i = 0; i < n; i++) dates.push(`2026-${m}-${String(3 + i).padStart(2, '0')}`)
  const days = dates.map((d) => fakeDay(d))
  const grid = { tradeSide: ['both', 'long', 'short'], window: [[930, 1445]], tradeStopX: [1], tradeTargetX: [1], tradeTimeStop: [0], tradeTrail: ['scanner'] }
  const r = tuneStrategy(days, 'wallBreak', { grid, minTrades: 4, minPerMonth: 4 })
  assert.equal(r.best.params.tradeSide, 'long')
  assert.equal(r.best.train.periods, 3, 'June, July, August (+ September\'s first days)')
  assert.equal(r.best.train.periodsWon, 3)
  assert.equal(r.selection.periods, 3)
  assert.equal(r.recommend, true, r.reason)
  assert.match(r.reason, /made money in 3 of the 3 months/)
  // 45 trades a month asked (both sides take 2 a day, 42 a month): none qualifies - the best with fewer is shown, never recommended.
  const rare = tuneStrategy(days, 'wallBreak', { grid, minTrades: 4, minPerMonth: 45 })
  assert.equal(rare.belowMin, true)
  assert.equal(rare.recommend, false)
  assert.match(rare.reason, /45\+ times a month/)
})

test('walk-forward: chosen again before each later block and traded on it - a setting that holds passes, one that fitted the past does not', () => {
  const dates = []
  for (const [m, n] of [['06', 15], ['07', 15], ['08', 15]]) for (let i = 0; i < n; i++) dates.push(`2026-${m}-${String(1 + i).padStart(2, '0')}`)
  const grid = { tradeSide: ['both', 'long', 'short'], window: [[930, 1445]], tradeStopX: [1], tradeTargetX: [1], tradeTimeStop: [0], tradeTrail: ['scanner'] }
  const opts = { grid, minTrades: 4, minPerMonth: 0 }
  const steady = dates.map((d) => fakeDay(d))
  const wf = walkForward(steady, 'wallBreak', opts, { folds: 3 })
  assert.equal(wf.count, 3)
  assert.equal(wf.folds.reduce((a, f) => a + f.days.length, 0), 45 - Math.floor(45 * 0.5))
  assert.equal(wf.foldsWon, 3)
  assert.equal(wf.passed, true, wf.reason)
  assert.ok(wf.avg > wf.baseAvg, `${wf.avg} > ${wf.baseAvg}`)
  assert.ok(wf.folds.every((f) => f.params.tradeSide === 'long' && f.changed))
  // The longs win for the first 22 days (the first training window), then lose (the shorts win): the setting chosen on the past fails on the blocks.
  const flipped = dates.map((d, i) => (i < 22 ? fakeDay(d) : fakeDay(d, { longWins: false, shortWins: true })))
  const bad = walkForward(flipped, 'wallBreak', opts, { folds: 3 })
  assert.equal(bad.passed, false)
  assert.ok(bad.foldsWon < 3)
  // withWalkForward: the failing one is no longer recommended, the reason says why; with 0 folds nothing changes.
  const tuned = { best: { params: {} }, recommend: true, reason: 'looked good' }
  assert.equal(withWalkForward(tuned, flipped, 'wallBreak', opts, 0), tuned)
  const gated = withWalkForward(tuneStrategy(flipped, 'wallBreak', opts), flipped, 'wallBreak', opts, 3)
  assert.equal(gated.recommend, false)
  assert.ok(gated.walkForward)
  const kept = withWalkForward(tuneStrategy(steady, 'wallBreak', opts), steady, 'wallBreak', opts, 3)
  assert.equal(kept.recommend, true, kept.reason)
  assert.match(kept.reason, /walk-forward/)
  // Too few days: no walk-forward (and the result is left as it was).
  assert.equal(walkForward(steady.slice(0, 20), 'wallBreak', opts), null)
})

test('ranking, the grid size, and the filters to save', () => {
  const days = Array.from({ length: 6 }, (_, i) => fakeDay(`2026-09-1${i}`))
  const ranked = rankStrategies(days, { minTrades: 4, ids: ['wallBreak', 'trap'] })
  assert.equal(ranked[0].id, 'wallBreak')
  assert.equal(ranked[1].n, 0)
  assert.equal([...variants()].length, 7200)
  assert.deepEqual(filtersFromTuning({ closesBeyond: 3, tradeStopX: 2 }, { ...DEFAULT_VARIANT, tradeSide: 'long' }), { closesBeyond: 3, tradeSide: 'long' })
  // simulateOutcome on a fake day: the long hits its target.
  assert.equal(simulateOutcome(days[0].setups[0], days[0].minuteBars, days[0].endMs, true).r, 2)
})

test('the result lists every tuned input with what each of its values did, and each trade its SL / target', () => {
  const days = Array.from({ length: 12 }, (_, i) => fakeDay(`2026-09-${String(10 + i).padStart(2, '0')}`))
  const grid = { tradeSide: ['both', 'long', 'short'], window: [[930, 1445], [930, 1230]], tradeStopX: [1, 1.5], tradeTargetX: [1], tradeTimeStop: [0], tradeTrail: ['scanner'] }
  const r = tuneStrategy(days, 'wallBreak', { grid, minTrades: 4 })
  assert.deepEqual(r.factors.map((f) => f.key), Object.keys(grid), 'every input tuned is reported')
  const side = r.factors.find((f) => f.key === 'tradeSide')
  assert.deepEqual(side.values.map((x) => x.value), ['both', 'long', 'short'])
  assert.equal(side.chosen, r.best.params.tradeSide)
  assert.equal(side.values.find((x) => x.value === 'long').best.avg, 2, 'long only: +2R a trade')
  assert.equal(side.values.find((x) => x.value === 'short').best.avg, 0, 'short only: at best 0R (stop x1.5 rides out the loss) - tried and shown, not chosen')
  assert.ok(side.values.every((x) => x.tried > 0))
  assert.equal(r.factors.find((f) => f.key === 'window').chosen, `${r.best.params.tradeFrom}-${r.best.params.tradeTo}`)
  // Each trade: its stop-loss and target as traded, their points, why it closed.
  const t = r.best.trades[0]
  assert.equal(t.slPts, Math.abs(t.entry - t.stop))
  assert.equal(t.targetPts, Math.abs(t.target - t.entry))
  assert.ok(['target', 'stop-loss', 'trailing SL', 'time stop', 'square-off 15:10'].includes(t.exitReason), t.exitReason)
  if (r.best.params.tradeStopX === 1.5) assert.equal(t.slPts, 15)
})

test('the OI stage reports every ticked OI input - an input that stays at Any was still tried at each value', () => {
  const days = Array.from({ length: 8 }, (_, i) => tuningDay(`2026-09-1${i}`, [], replayDay, syn.oi))
  const r = tuneStrategy(days, 'wallBreak', { what: 'oi', oiKeys: ['tradeOiFlow', 'tradeDayType'], minTrades: 2 })
  assert.deepEqual(r.factors.map((f) => f.key), ['tradeOiFlow', 'tradeDayType'], 'only the ticked inputs, all of them')
  for (const f of r.factors) assert.deepEqual(f.values.map((x) => x.value), OI_GRID[f.key])
  const both = tuneStrategy(days, 'wallBreak', { what: 'both', oiKeys: ['tradeOiFlow'], minTrades: 2 })
  assert.ok(both.factors.some((f) => f.key === 'tradeOiFlow') && both.factors.some((f) => f.key === 'tradeStopX'), 'OI, then trade: both stages reported')
})

test('the outcome cache: what a taken trade does depends only on its stop / target / time stop / trailing stop', () => {
  // The sides, the entry window and the OI confirmation decide WHICH setups are taken, never what a taken one then
  // does - which is why one answer can be shared by the combinations that differ only in those (see outcomeKey).
  const v = (o) => ({ ...DEFAULT_VARIANT, ...o })
  const same = [v({ tradeSide: 'long' }), v({ tradeSide: 'short' }), v({ tradeFrom: 1100, tradeTo: 1230 }), v({ tradeOiFlow: 'with', tradeDayType: 'trend', tradeWallRoom: 'oneR' })]
  assert.equal(new Set(same.map((x) => outcomeKey(x, null))).size, 1, 'sides / window / OI do not change the outcome')
  const differ = [v({ tradeStopX: 1.5 }), v({ tradeTargetX: 2 }), v({ tradeTimeStop: 30 }), v({ tradeTrail: '1/1' })]
  assert.equal(new Set([...differ, same[0]].map((x) => outcomeKey(x, null))).size, 5, 'each of the four does')
  assert.notEqual(outcomeKey(same[0], null), outcomeKey(same[0], { startR: 1, gapR: 1 }), 'the scanner\'s own trailing stop too')

  // And in practice: a setup taken by two combinations that differ only in the sides ends exactly the same way.
  const days = Array.from({ length: 6 }, (_, i) => fakeDay(`2026-09-1${i}`))
  const both = tradeDetails(days, 'wallBreak', v({}), null, 'NIFTY')
  const longOnly = tradeDetails(days, 'wallBreak', v({ tradeSide: 'long' }), null, 'NIFTY')
  const key = (t) => `${t.date}-${t.t}`
  for (const t of longOnly) {
    const twin = both.find((x) => key(x) === key(t))
    assert.deepEqual([twin.exit, twin.points, twin.r, twin.exitReason], [t.exit, t.points, t.r, t.exitReason], key(t))
  }
  assert.ok(longOnly.length && longOnly.length < both.length)
})

test('Apply to the scanner: the whole setting goes across, options included, and it replaces the last one', () => {
  const v = (o) => ({ ...DEFAULT_VARIANT, ...OPTION_DEFAULT, ...o })
  // A strategy's own entry rules are never touched; the trade filters are set or removed, so nothing of a previous
  // apply is left behind.
  const entryRules = { closesBeyond: 3 }
  const tuned = filtersFromTuning(entryRules, v({ tradeSide: 'long', tradeStopX: 0.75, tradeOiFlow: 'with' }))
  assert.deepEqual(tuned, { closesBeyond: 3, tradeSide: 'long', tradeStopX: 0.75, tradeOiFlow: 'with' })
  assert.deepEqual(filtersFromTuning(tuned, v({ tradeSide: 'short' })), { closesBeyond: 3, tradeSide: 'short' }, 'a new apply replaces the old one')

  // The option part only when the OPTION was tuned - otherwise a trade-only run would pin the strategy to the option
  // defaults ("sell ATM") the trader never chose.
  assert.equal(filtersFromTuning({}, v({ optLeg: 'buy' })).tradeOptLeg, undefined)
  const opt = filtersFromTuning({}, v({ optLeg: 'buy', optMoneyness: -1, optExit: 'first', optSlPct: 25, optTargetPct: 50 }), { option: true })
  assert.deepEqual(opt, { tradeOptLeg: 'buy', tradeOptMoneyness: -1, tradeOptExit: 'first', tradeOptSlPct: 25, tradeOptTargetPct: 50 })
  // Out with the index trade: the option's own SL / target are not used, so they are not applied either - and its exit
  // says so, so the index's option points are not added to it.
  assert.deepEqual(filtersFromTuning({}, v({ optLeg: 'sell', optExit: 'index', optSlPct: 25 }), { option: true }), { tradeOptLeg: 'sell', tradeOptMoneyness: 0, tradeOptExit: 'index' })

  // And what the scanner then does with it. WHO DECIDES: a side chosen where the trading happens (the Order Flow
  // page's Buy / Sell) is the last word; 'strategy' - what the server scanner runs on, with nobody there to choose -
  // hands it to the strategy's own tuned setting.
  // The option leaves the trade by the STRATEGY's own exit, held to the index's max rules (paperMaxSl / paperMaxTarget) -
  // never the manual SL / target (paperSl / paperTarget).
  const chose = (autoPaper) => ({ autoPaper, moneyness: 0, paperSl: 20, paperTarget: 30, paperMaxSl: 80, paperMaxTarget: 120 })
  const plain = optionPlanFor('wallBreak', {}, chose('sell'), 100)
  assert.deepEqual([plain.leg, plain.moneyness, plain.exit, plain.slPts, plain.targetPts, plain.fromStrategy], ['sell', 0, 'index', 80, 120, false])
  const mine = optionPlanFor('wallBreak', { wallBreak: opt }, chose('strategy'), 100)
  assert.deepEqual([mine.leg, mine.moneyness, mine.slPts, mine.targetPts, mine.fromStrategy], ['buy', -1, 25, 50, true])
  // A % SL / target is of the premium actually paid, so a bigger premium means more points - up to the max.
  assert.equal(optionPlanFor('wallBreak', { wallBreak: opt }, chose('strategy'), 200).slPts, 50)
  assert.equal(optionPlanFor('wallBreak', { wallBreak: opt }, chose('strategy'), 400).slPts, 80, 'held to the Max SL')
  // The trader's own choice overrides the tuned side, and says that it did.
  const overridden = optionPlanFor('wallBreak', { wallBreak: opt }, chose('sell'), 100)
  assert.equal(overridden.leg, 'sell')
  assert.equal(overridden.overrode, true)
  assert.equal(optionPlanFor('wallBreak', { wallBreak: opt }, chose('buy'), 100).overrode, false, 'agreeing is not overriding')
  // Off is off, whatever a strategy says.
  assert.equal(optionPlanFor('wallBreak', { wallBreak: opt }, chose('off'), 100).leg, null)
  // Nonsense saved by hand is ignored rather than traded on.
  assert.equal(optionPlanFor('wallBreak', { wallBreak: { tradeOptLeg: 'nonsense', tradeOptMoneyness: 99 } }, chose('strategy'), 100).leg, 'sell')
})

test('the Strategy lab measures a setting exactly as the tuning counts it (index R, points, the option its own way)', async () => {
  const { evaluateSetting, paramsFromFilters, optionRun } = await import('../src/strategyTuning.js')
  const all = await scanDaySetups({ ...base, filters: {}, keepAll: true })
  const days = [tuningDay('2026-10-09', all, replayDay, syn.oi)]
  const ids = [...new Set(all.map((s) => s.id))]
  assert.ok(ids.length > 0)
  for (const id of ids) {
    for (const params of [{}, { tradeSide: 'long' }, { tradeStopX: 1.5, tradeTargetX: 2 }, { tradeTrail: 'off', tradeTimeStop: 30 }]) {
      const variant = { ...DEFAULT_VARIANT, ...params }
      const lab = evaluateSetting(days, id, params)
      const rs = days.flatMap((d) => dayTrades(d, id, variant, null))
      assert.deepEqual(lab.r, scoreR(rs), `${id} ${JSON.stringify(params)}: the tuning's own R`)
      assert.equal(lab.trades.length, rs.length)
      assert.deepEqual(lab.params, params, 'only what differs from as written')
    }
    const opt = { optLeg: 'sell', optMoneyness: 0, optExit: 'first', optSlPct: 30, optTargetPct: 40 }
    const lab = evaluateSetting(days, id, opt)
    assert.deepEqual(lab.option.trades.map((t) => t.opt.points), optionRun(days, id, { ...DEFAULT_VARIANT, ...OPTION_DEFAULT, ...opt }, null), `${id}: the tuning's own option points`)
    assert.equal(evaluateSetting(days, id, {}).option, null, 'no option leg chosen: none measured')
  }
  // An applied setting read back to the lab's parameters (and through filtersFromTuning again: the same filters).
  const params = { tradeSide: 'short', tradeStopX: 1.5, optLeg: 'buy', optMoneyness: -1, optExit: 'indexSl', optSlPct: 30 }
  const filters = filtersFromTuning({}, { ...DEFAULT_VARIANT, ...OPTION_DEFAULT, ...params }, { option: true })
  assert.deepEqual(paramsFromFilters(filters), params)
  assert.deepEqual(filtersFromTuning({}, { ...DEFAULT_VARIANT, ...OPTION_DEFAULT, ...paramsFromFilters(filters) }, { option: true }), filters)
  assert.deepEqual(paramsFromFilters({ tradeOptLeg: 'sell', tradeOptSlPct: 20, tradeOptTargetPct: 35 }), { optLeg: 'sell', optMoneyness: 0, optExit: 'first', optSlPct: 20, optTargetPct: 35 })
  assert.deepEqual(paramsFromFilters({ minRatio: 3, _tuned: 'x', _lots: 2 }), {}, 'entry filters and our own keys are not tuned settings')
})

test('a lab setting: only what differs from as written, no futures / order-flow input for spot, the option part as its exit uses it', async () => {
  const { labParams, labEditableKeys } = await import('../src/strategyTuning.js')
  assert.ok(labEditableKeys('futures').includes('tradeFutOi') && labEditableKeys('futures').includes('tradeTape'))
  assert.ok(!labEditableKeys('spot').includes('tradeFutOi') && !labEditableKeys('spot').includes('tradeTape') && labEditableKeys('spot').includes('tradeSideOi'))
  assert.ok(!labEditableKeys('futures').some((k) => k.startsWith('opt')))
  assert.deepEqual(labParams({ tradeSide: 'both', tradeStopX: 1.5, tradeFrom: 930 }, 'futures'), { tradeStopX: 1.5 }, 'defaults left out')
  assert.deepEqual(labParams({ tradeFutOi: 'buildUp', tradeTape: 'with', tradeSideOi: 'withBoth' }, 'spot'), { tradeSideOi: 'withBoth' }, 'spot has no futures / order flow')
  assert.deepEqual(labParams({ optLeg: 'buy', optMoneyness: -1, optExit: 'index', optSlPct: 30, optTargetPct: 50 }, 'futures'), { optLeg: 'buy', optMoneyness: -1, optExit: 'index' })
  assert.deepEqual(labParams({ optLeg: 'sell', optExit: 'indexSl', optSlPct: 25, optTargetPct: 50 }, 'futures'), { optLeg: 'sell', optMoneyness: 0, optExit: 'indexSl', optSlPct: 25 })
  assert.deepEqual(labParams({ optLeg: 'sell', optExit: 'first' }, 'futures'), { optLeg: 'sell', optMoneyness: 0, optExit: 'first', optSlPct: 20, optTargetPct: 30 })
  assert.deepEqual(labParams({ optMoneyness: 2, optExit: 'first' }, 'futures'), {}, 'no option leg: no option part')
})

test('points summaries added up: the index points and each option leg, captured / lost / net / trades - every strategy together', async () => {
  const { sumPoints, pointsSummary } = await import('../src/strategyTuning.js')
  const a = pointsSummary([{ points: 10, buy: { points: 6 }, sell: { points: -6 } }, { points: -4, buy: { points: -3 }, sell: { points: 3 } }])
  const b = pointsSummary([{ points: 8, buy: { points: 5 }, sell: { points: -5 } }, { points: 2 }])
  const all = sumPoints([a, b, null])
  assert.deepEqual({ n: all.n, total: all.total, captured: all.captured, lost: all.lost, wins: all.wins, losses: all.losses }, { n: 4, total: 16, captured: 20, lost: -4, wins: 3, losses: 1 })
  assert.equal(all.avg, 4)
  assert.deepEqual({ n: all.buy.n, total: all.buy.total, captured: all.buy.captured, lost: all.buy.lost }, { n: 3, total: 8, captured: 11, lost: -3 }, 'a trade without the option\'s premiums is not counted for it')
  assert.deepEqual({ n: all.sell.n, total: all.sell.total, wins: all.sell.wins, losses: all.sell.losses }, { n: 3, total: -8, wins: 1, losses: 2 })
  assert.deepEqual(sumPoints([]).buy, { n: 0, total: 0, avg: null, captured: 0, lost: 0, wins: 0, losses: 0 })
})

test('the lab changes for several strategies at once: every key set (a default too), the option part, or the option taken off', async () => {
  const { labOverrides } = await import('../src/strategyTuning.js')
  // A key set back to its default is still a change - a strategy's starting point may have another.
  assert.deepEqual(labOverrides({ tradeSide: 'both', tradeStopX: 1.5 }, 'futures'), { tradeSide: 'both', tradeStopX: 1.5 })
  assert.deepEqual(labOverrides({}, 'futures'), {}, 'nothing set: each as its starting point')
  assert.deepEqual(labOverrides({ tradeTape: 'with', tradeSideOi: 'withBoth' }, 'spot'), { tradeSideOi: 'withBoth' }, 'spot has no order flow')
  assert.deepEqual(labOverrides({ optLeg: 'sell', optExit: 'indexSl', optSlPct: 25, optTargetPct: 50 }, 'futures'), { optLeg: 'sell', optMoneyness: 0, optExit: 'indexSl', optSlPct: 25 })
  assert.deepEqual(labOverrides({ optLeg: 'none', optSlPct: 25 }, 'futures'), { optLeg: 'none' }, 'the option taken off')
})
