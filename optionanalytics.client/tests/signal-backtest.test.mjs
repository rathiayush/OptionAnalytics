// The Signal backtest (signalBacktest.js): a day's features from data up to each minute only (nothing after it), the ONE
// rule built on the page - every condition's values firing on their case and not without it, all of them together, the
// mirror - the option trade (BUY / SELL, stop before target, a gap through the stop, the time stop, the 15:10 square-off),
// the timeframe and the report.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { day as syntheticDay } from './synthetic-day.mjs'
import {
  BACKTEST_DEFAULTS, RULE_ACTIONS, RULE_CONDITIONS, TIMEFRAMES, istMinute, mirrorConditions, optionFor, prepareDay, ruleConditions, ruleSignals, ruleText,
  simulateDay, simulateRun, simulateTrade, summarize, timeframeView, tradesCsv,
} from '../src/signalBacktest.js'

const MIN = 60_000
const T915 = Date.parse('2026-10-05T09:15:00+05:30')
const cond = (id) => RULE_CONDITIONS.find((c) => c.id === id)
// Does condition `id` say `value` at minute i of `d` (window `w` candles)?
const holds = (d, id, value, i, w = 5) => cond(id).test(d, i, value, w)
const rule = (conditions, action = 'buyCE', more = {}) => ({ conditions, action, mirror: false, windowMin: 5, ...more })
const at = (list) => list.map((x) => [x.i, x.side, x.action])

// A prepared day built by hand: `n` minutes from 09:15, everything flat unless given.
function fakeDay({ n = 360, spot = () => 25000, price = null, vwap = () => 24990, oi = () => ({ ce: 0, pe: 0 }), walls = () => ({ support: null, resistance: null }),
  gex = () => null, straddle = () => null, profile = () => null, ib = null, breaks = [], hp = [], ceCum = () => NaN, peCum = () => NaN, netCum = () => NaN,
  straddleWidth = 100, legs = {} } = {}) {
  const t = Array.from({ length: n }, (_, i) => T915 + i * MIN)
  const bar = (f) => Array.from({ length: n }, (_, i) => f(i))
  const sp = (i) => (typeof spot(i) === 'number' ? { o: spot(i), h: spot(i), l: spot(i), c: spot(i) } : spot(i))
  const pr = price ?? sp
  const pack = (f) => {
    const a = new Float64Array(n * 4).fill(NaN)
    for (let i = 0; i < n; i++) { const b = f(i); if (b) { a[i * 4] = b.o; a[i * 4 + 1] = b.h; a[i * 4 + 2] = b.l; a[i * 4 + 3] = b.c } }
    return a
  }
  const side = (key) => new Map(Object.entries(legs[key] ?? {}).map(([k, f]) => [Number(k), pack(f)]))
  return {
    ok: true, date: '2026-10-05', underlying: 'NIFTY', step: 50, n, t, atm: bar((i) => Math.round(sp(i).c / 50) * 50),
    spot: { o: bar((i) => sp(i).o), h: bar((i) => sp(i).h), l: bar((i) => sp(i).l), c: bar((i) => sp(i).c) },
    price: { o: bar((i) => pr(i).o), h: bar((i) => pr(i).h), l: bar((i) => pr(i).l), c: bar((i) => pr(i).c) },
    vwap: bar(vwap), oi: bar(oi), walls: bar(walls), gex: bar(gex), straddle: bar(straddle), profile: bar(profile),
    ceCum: bar(ceCum), peCum: bar(peCum), netCum: bar(netCum),
    ib, breaks, hp, straddleWidth, priceSource: 'futures', ce: side('ce'), pe: side('pe'),
  }
}
const flat = (v) => () => ({ o: v, h: v, l: v, c: v })
// A rule that signals a few times on the synthetic day (VWAP crossings, both ways).
const ANY_DAY_RULE = { conditions: { vwap: 'crossedAbove' }, action: 'buyCE', mirror: true, windowMin: 5 }

test('a day prepared from the OI Replay run: every feature for each minute, nothing after it', () => {
  const { run } = syntheticDay()
  const full = prepareDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY' })
  assert.equal(full.ok, true)
  assert.equal(full.n, 301)
  assert.equal(full.priceSource, 'futures')
  assert.ok(full.breaks.length > 0)
  assert.ok(full.ib && full.ib.done === 59)   // 10:14
  // The same day cut at 11:45 (minute 150): every feature of minutes 0 - 150 is the same - nothing after a minute counts.
  const cut = Date.parse('2026-10-05T11:45:00+05:30')
  const keep = (list) => list.filter((p) => Date.parse(p.time) <= cut)
  const part = prepareDay({
    ...run, optionExpiry: '2026-10-06', spotCandlesOneMinute: keep(run.spotCandlesOneMinute), futuresBars: keep(run.futuresBars), cePoints: keep(run.cePoints), pePoints: keep(run.pePoints),
  }, { underlying: 'NIFTY' })
  assert.equal(part.n, 151)
  for (let i = 0; i < part.n; i++) {
    for (const k of ['oi', 'walls', 'gex', 'straddle', 'profile']) assert.deepEqual(part[k][i], full[k][i], `${k} at ${i}`)
    for (const k of ['vwap', 'ceCum', 'peCum', 'netCum', 'atm']) assert.deepEqual(part[k][i], full[k][i], `${k} at ${i}`)
  }
  assert.deepEqual(part.breaks, full.breaks.filter((b) => b.i < part.n))
  assert.deepEqual(part.hp, full.hp.filter((b) => b.i < part.n))
  assert.deepEqual(part.ib, full.ib)
  // And so are its signals and its trades' entries (the trades themselves run on to the day's end).
  const signalsOf = (d) => simulateDay(d, { lotSize: 65, rule: ANY_DAY_RULE }).signals.map((s) => [s.strategy, s.time, s.dir])
  assert.ok(signalsOf(full).length > 2)
  assert.deepEqual(signalsOf(part), signalsOf(full).filter(([, time]) => time <= cut))
})

test('a day with too little to read is not run', () => {
  assert.equal(prepareDay({ spotCandlesOneMinute: [] }).ok, false)
  const { run } = syntheticDay()
  assert.equal(prepareDay({ ...run, cePoints: [], pePoints: [], step: 0 }).ok, false)
})

test('a signal trades the call / put: BUY in its direction, or SELL the other side; in / out of the money by a strike', () => {
  assert.deepEqual(optionFor(1, 'buy', 25000, 50), { side: 'CE', strike: 25000, action: 'BUY' })
  assert.deepEqual(optionFor(-1, 'buy', 25000, 50), { side: 'PE', strike: 25000, action: 'BUY' })
  assert.deepEqual(optionFor(1, 'sell', 25000, 50), { side: 'PE', strike: 25000, action: 'SELL' })
  assert.deepEqual(optionFor(-1, 'sell', 25000, 50), { side: 'CE', strike: 25000, action: 'SELL' })
  assert.equal(optionFor(1, 'buy', 25000, 50, 1).strike, 24950)    // ITM call: below spot
  assert.equal(optionFor(-1, 'buy', 25000, 50, 1).strike, 25050)   // ITM put: above spot
  assert.equal(optionFor(1, 'buy', 25000, 50, -1).strike, 25050)   // OTM call
  assert.equal(optionFor(1, 'sell', 25000, 50, -1).strike, 24950)  // OTM put sold
})

test('the trade: entered at the signal minute\'s close, managed from the next minute - stop before target, a gap through the stop at the open', () => {
  const opts = { slPct: 20, targetPct: 40 }
  const at = (bars) => fakeDay({ n: 20, legs: { ce: { 25000: (i) => bars[i] ?? { o: 100, h: 100, l: 100, c: 100 } } } })
  const buy = { side: 'CE', strike: 25000, action: 'BUY' }
  // Minute 1 reaches both the stop (80) and the target (140): the stop first.
  let tr = simulateTrade(at({ 0: { o: 100, h: 100, l: 100, c: 100 }, 1: { o: 100, h: 150, l: 70, c: 120 } }), 0, buy, opts)
  assert.deepEqual([tr.entry, tr.exit, tr.exitReason, tr.exitIndex], [100, 80, 'Stop', 1])
  // The signal minute's own range is never read: a stop-like low IN minute 0 does nothing.
  tr = simulateTrade(at({ 0: { o: 100, h: 100, l: 50, c: 100 }, 2: { o: 100, h: 145, l: 95, c: 140 } }), 0, buy, opts)
  assert.deepEqual([tr.exit, tr.exitReason, tr.exitIndex], [140, 'Target', 2])
  // A bar opening below the stop fills at its open.
  tr = simulateTrade(at({ 3: { o: 60, h: 65, l: 55, c: 62 } }), 0, buy, opts)
  assert.deepEqual([tr.exit, tr.exitReason], [60, 'Stop (opened through it)'])
  // SOLD: the stop is above (premium rising), the target below; points are entry - exit.
  const sell = { side: 'CE', strike: 25000, action: 'SELL' }
  tr = simulateTrade(at({ 4: { o: 100, h: 110, l: 58, c: 70 } }), 0, sell, opts)
  assert.deepEqual([tr.exit, tr.exitReason, tr.points], [60, 'Target', 40])
  tr = simulateTrade(at({ 4: { o: 100, h: 125, l: 90, c: 110 } }), 0, sell, opts)
  assert.deepEqual([tr.exit, tr.exitReason, tr.points], [120, 'Stop', -20])
  // No premium at the signal minute (or within 5 before it): no trade.
  assert.equal(simulateTrade(fakeDay({ n: 20 }), 0, buy, opts), null)
})

test('the trade: the time stop and the 15:10 square-off at the bar\'s close', () => {
  const d = fakeDay({ legs: { ce: { 25000: (i) => ({ o: 100 + i, h: 100 + i, l: 100 + i, c: 100 + i }) } } })
  const buy = { side: 'CE', strike: 25000, action: 'BUY' }
  let tr = simulateTrade(d, 10, buy, { slPct: 90, targetPct: 900, timeStopMin: 15 })
  assert.deepEqual([tr.exitIndex, tr.exit, tr.exitReason], [25, 125, 'Time stop 15 min'])
  tr = simulateTrade(d, 10, buy, { slPct: 90, targetPct: 900 })
  assert.equal(istMinute(d.t[tr.exitIndex]), 15 * 60 + 10)
  assert.equal(tr.exitReason, '15:10 square-off')
  assert.equal(tr.exit, 100 + tr.exitIndex)
})


// ---- The rule's conditions ---------------------------------------------------------------------------------------------

test('every condition\'s options: an opposite from the same list, a label; the actions mirror each other', () => {
  const ids = new Set()
  for (const c of RULE_CONDITIONS) {
    assert.ok(!ids.has(c.id), c.id); ids.add(c.id)
    assert.ok(c.name && c.group && c.options.length >= 2, c.id)
    const values = c.options.map((o) => o.value)
    for (const o of c.options) {
      assert.ok(o.label, `${c.id}.${o.value}`)
      assert.ok(values.includes(o.opposite), `${c.id}.${o.value} -> ${o.opposite}`)
      assert.equal(c.options.find((x) => x.value === o.opposite).opposite, o.value, `${c.id}.${o.value} mirrors back`)
    }
  }
  for (const a of RULE_ACTIONS) assert.equal(RULE_ACTIONS.find((x) => x.value === a.opposite).opposite, a.value)
  assert.deepEqual(RULE_ACTIONS.map((a) => [a.value, a.dir, a.mode]), [['buyCE', 1, 'buy'], ['buyPE', -1, 'buy'], ['sellPE', 1, 'sell'], ['sellCE', -1, 'sell']])
})

test('OI since open: PE / CE ahead, and a crossover within the window that still holds', () => {
  const oi = (i) => (i < 50 ? { ce: 2e6, pe: 1e6 } : i < 80 ? { ce: 2e6, pe: 3e6 } : { ce: 4e6, pe: 3e6 })
  const d = fakeDay({ oi })
  assert.ok(holds(d, 'oiOpen', 'ceAhead', 40) && !holds(d, 'oiOpen', 'peAhead', 40))
  assert.ok(holds(d, 'oiOpen', 'peAhead', 60))
  assert.ok(holds(d, 'oiOpen', 'peCross', 52))      // crossed at 50, 2 minutes ago
  assert.ok(!holds(d, 'oiOpen', 'peCross', 56))     // 6 minutes ago: out of a 5-minute window
  assert.ok(holds(d, 'oiOpen', 'peCross', 56, 10))  // in a 10-minute one
  assert.ok(holds(d, 'oiOpen', 'ceCross', 81) && !holds(d, 'oiOpen', 'peCross', 81))
})

test('cumulative Δ: positive / negative, −ve → +ve, rising / falling / stable against its range, its S/R breaks', () => {
  // Net: -100 until 40, climbing 10 a minute to +200 at 70, then flat.
  const net = (i) => (i < 40 ? -100 : i < 70 ? -100 + (i - 40) * 10 : 200)
  const breaks = [{ i: 60, line: 'net', up: true, dir: -1, text: 'x' }, { i: 90, line: 'ce', up: false, dir: 1, text: 'y' }]
  const d = fakeDay({ netCum: net, breaks })
  assert.ok(holds(d, 'cumNet', 'negative', 30) && holds(d, 'cumNet', 'positive', 60))
  assert.ok(holds(d, 'cumNet', 'turnedPositive', 52))       // crossed 0 at minute 51 (-100 + 110)
  assert.ok(!holds(d, 'cumNet', 'turnedPositive', 45))      // not yet positive
  assert.ok(!holds(d, 'cumNet', 'turnedPositive', 60))      // crossed 9 minutes ago
  assert.ok(holds(d, 'cumNet', 'rising', 60) && !holds(d, 'cumNet', 'stable', 60))
  assert.ok(holds(d, 'cumNet', 'stable', 100) && !holds(d, 'cumNet', 'rising', 100))
  assert.ok(holds(fakeDay({ netCum: (i) => 500 - i * 10 }), 'cumNet', 'falling', 30))
  assert.ok(holds(d, 'cumNet', 'brokeResistance', 62) && !holds(d, 'cumNet', 'brokeSupport', 62))
  assert.ok(!holds(d, 'cumNet', 'brokeResistance', 70))     // 10 minutes on
  assert.ok(holds(d, 'cumCe', 'brokeSupport', 91) && !holds(d, 'cumNet', 'brokeSupport', 91) && !holds(d, 'cumPe', 'brokeSupport', 91))
  // Not read yet (no completed bucket): nothing holds.
  assert.ok(!holds(fakeDay(), 'cumPe', 'positive', 10) && !holds(fakeDay(), 'cumPe', 'stable', 10))
})

test('🎯 within the window; OI walls: near the support / resistance, a break that still holds', () => {
  assert.ok(holds(fakeDay({ hp: [{ i: 40, dir: 1 }] }), 'hp', 'bullish', 43))
  assert.ok(!holds(fakeDay({ hp: [{ i: 40, dir: 1 }] }), 'hp', 'bearish', 43))
  assert.ok(!holds(fakeDay({ hp: [{ i: 40, dir: 1 }] }), 'hp', 'bullish', 46))
  const walls = () => ({ support: 24900, resistance: 25100 })
  const touch = (i) => (i === 50 ? { o: 24950, h: 24960, l: 24905, c: 24950 } : flat(25000)())
  assert.ok(holds(fakeDay({ walls, spot: touch }), 'oiWalls', 'nearSupport', 52))     // 5 points off: within a quarter strike
  assert.ok(!holds(fakeDay({ walls, spot: touch }), 'oiWalls', 'nearSupport', 58))
  assert.ok(!holds(fakeDay({ walls, spot: touch }), 'oiWalls', 'nearResistance', 52))
  const through = (i) => flat(i < 60 ? 25050 : i < 70 ? 25120 : 25080)()
  assert.ok(holds(fakeDay({ walls, spot: through }), 'oiWalls', 'brokeResistance', 62))
  assert.ok(!holds(fakeDay({ walls, spot: through }), 'oiWalls', 'brokeResistance', 70))   // back under it: failed
})

test('GEX: the regime and its turn; near the put / call wall within 0.15%; a break of a wall', () => {
  const gex = (i) => ({ net: i < 50 ? 1e9 : -1e9, putWall: 24900, callWall: 25100 })
  assert.ok(holds(fakeDay({ gex }), 'gexRegime', 'long', 40) && holds(fakeDay({ gex }), 'gexRegime', 'short', 60))
  assert.ok(holds(fakeDay({ gex }), 'gexRegime', 'turnedShort', 52) && !holds(fakeDay({ gex }), 'gexRegime', 'turnedShort', 60))
  assert.ok(!holds(fakeDay(), 'gexRegime', 'long', 40))                                     // no GEX: nothing
  const near = (i) => (i === 30 ? { o: 24950, h: 24950, l: 24930, c: 24940 } : flat(25000)())   // 30 off 24900 = 0.12%
  assert.ok(holds(fakeDay({ gex, spot: near }), 'gexLevel', 'nearPutWall', 33))
  const far = (i) => (i === 30 ? { o: 24970, h: 24970, l: 24950, c: 24960 } : flat(25000)())   // 50 off = 0.2%
  assert.ok(!holds(fakeDay({ gex, spot: far }), 'gexLevel', 'nearPutWall', 33))
  const up = (i) => flat(i < 80 ? 25050 : 25130)()
  assert.ok(holds(fakeDay({ gex, spot: up }), 'gexLevel', 'brokeCallWall', 82) && !holds(fakeDay({ gex, spot: up }), 'gexLevel', 'brokePutWall', 82))
})

test('VWAP: above / below, a cross within the window that still holds; spot rising / falling / sideways', () => {
  const price = (i) => flat(i < 50 ? 24980 : i < 60 ? 25020 : 24990)()
  const d = fakeDay({ price, vwap: () => 25000 })
  assert.ok(holds(d, 'vwap', 'below', 40) && holds(d, 'vwap', 'above', 55))
  assert.ok(holds(d, 'vwap', 'crossedAbove', 53) && !holds(d, 'vwap', 'crossedAbove', 58))
  assert.ok(holds(d, 'vwap', 'crossedBelow', 61) && !holds(d, 'vwap', 'crossedAbove', 61))
  assert.ok(!holds(fakeDay({ price, vwap: () => NaN }), 'vwap', 'above', 55))
  const spot = (i) => 25000 + (i < 50 ? 0 : (i - 50) * 10)
  assert.ok(holds(fakeDay({ spot }), 'spotMove', 'sideways', 40))
  assert.ok(holds(fakeDay({ spot }), 'spotMove', 'rising', 60))     // +50 over 5 minutes = 0.2%
  assert.ok(holds(fakeDay({ spot: (i) => 25000 - i * 10 }), 'spotMove', 'falling', 60))
})

test('the straddle against its VWAP and the decay line; the profile: POC, value area, the IB after 10:15', () => {
  const straddle = (i) => ({ value: i < 50 ? 100 : 120, vwap: 110, decay: 105, forward: 25000 })
  const d = fakeDay({ straddle })
  assert.ok(holds(d, 'straddle', 'belowVwap', 40) && holds(d, 'straddle', 'belowDecay', 40))
  assert.ok(holds(d, 'straddle', 'aboveVwap', 60) && holds(d, 'straddle', 'aboveDecay', 60))
  assert.ok(holds(d, 'straddle', 'crossedAbove', 52) && !holds(d, 'straddle', 'crossedAbove', 60))
  const profile = () => ({ poc: 25000, vah: 25040, val: 24960 })
  const price = (i) => flat(i < 70 ? 25020 : 25080)()
  const p = fakeDay({ profile, price, ib: { high: 25050, low: 24950, done: 59 } })
  assert.ok(holds(p, 'poc', 'above', 40) && !holds(p, 'poc', 'below', 40))
  assert.ok(holds(p, 'valueArea', 'inside', 40) && holds(p, 'valueArea', 'aboveVah', 80))
  assert.ok(!holds(p, 'ib', 'inside', 40))                    // the IB is not done before 10:15
  assert.ok(holds(p, 'ib', 'inside', 65) && holds(p, 'ib', 'aboveHigh', 80) && !holds(p, 'ib', 'belowLow', 80))
})

test('the rule: a signal only where ALL its conditions hold - each one missing, no signal; once until it stops holding', () => {
  // OI: PE ahead from 40. Price over VWAP from 60 to 89, under after. Straddle over its VWAP from 70.
  const oi = (i) => (i < 40 ? { ce: 2e6, pe: 1e6 } : { ce: 2e6, pe: 3e6 })
  const price = (i) => flat(i >= 60 && i < 90 ? 25020 : 24980)()
  const straddle = (i) => ({ value: i < 70 ? 100 : 120, vwap: 110, decay: 90, forward: 25000 })
  const d = fakeDay({ oi, price, straddle, vwap: () => 25000 })
  const all = { oiOpen: 'peAhead', vwap: 'above', straddle: 'aboveVwap' }
  assert.deepEqual(at(ruleSignals(d, rule(all))), [[70, 'rule', 'buyCE']])
  // Each condition the other way (false at 70): no signal at 70.
  for (const [id, other] of [['oiOpen', 'ceAhead'], ['vwap', 'below'], ['straddle', 'belowVwap']]) {
    assert.ok(!ruleSignals(d, rule({ ...all, [id]: other })).some((x) => x.i === 70), `${id} ${other}`)
  }
  // Fewer conditions: earlier.
  assert.deepEqual(at(ruleSignals(d, rule({ oiOpen: 'peAhead', vwap: 'above' }))), [[60, 'rule', 'buyCE']])
  // Holding again after it stopped: a second signal.
  const twice = fakeDay({ price: (i) => flat((i >= 60 && i < 70) || i >= 100 ? 25020 : 24980)(), vwap: () => 25000 })
  assert.deepEqual(at(ruleSignals(twice, rule({ vwap: 'above' }))), [[60, 'rule', 'buyCE'], [100, 'rule', 'buyCE']])
  // Nothing picked, or no action: nothing.
  assert.deepEqual(ruleSignals(d, rule({})), [])
  assert.deepEqual(ruleSignals(d, rule({ oiOpen: 'any' })), [])
  assert.deepEqual(ruleSignals(d, rule(all, 'nope')), [])
})

test('the mirror: every condition\'s opposite trades the opposite side; a rule with no side has no mirror', () => {
  assert.deepEqual(mirrorConditions({ oiOpen: 'peAhead', vwap: 'above', gexRegime: 'short', cumCe: 'falling' }),
    { oiOpen: 'ceAhead', vwap: 'below', gexRegime: 'short', cumCe: 'rising' })
  const price = (i) => flat(i < 60 ? 25020 : 24980)()
  const oi = (i) => (i < 60 ? { ce: 1e6, pe: 2e6 } : { ce: 3e6, pe: 2e6 })
  const d = fakeDay({ oi, price, vwap: () => 25000 })
  const r = rule({ oiOpen: 'peAhead', vwap: 'above' }, 'buyCE', { mirror: true })
  assert.deepEqual(at(ruleSignals(d, r)), [[0, 'rule', 'buyCE'], [60, 'mirror', 'buyPE']])
  assert.deepEqual(at(ruleSignals(d, { ...r, action: 'sellPE' })), [[0, 'rule', 'sellPE'], [60, 'mirror', 'sellCE']])
  assert.deepEqual(at(ruleSignals(d, { ...r, mirror: false })), [[0, 'rule', 'buyCE']])
  // Only GEX short gamma: its mirror would be the same rule - left out.
  const g = fakeDay({ gex: () => ({ net: -1, putWall: null, callWall: null }) })
  assert.deepEqual(at(ruleSignals(g, rule({ gexRegime: 'short' }, 'buyCE', { mirror: true }))), [[0, 'rule', 'buyCE']])
  assert.match(ruleText({ vwap: 'above', oiOpen: 'peAhead' }, 'buyCE'), /^Buy CE when OI since open.*PE added > CE added.* AND Price vs VWAP: Price above VWAP$/)
  assert.deepEqual(ruleConditions({ vwap: 'above', bogus: 'x', oiOpen: 'any' }), [['vwap', 'above']])
})

test('a day\'s trades: entries 09:30 - 14:45, one at a time (rule and mirror together), a cooldown, at most N a day', () => {
  // Price crossing VWAP back and forth every 20 minutes: the rule (above) and its mirror (below) take turns.
  const price = (i) => flat(Math.floor(i / 20) % 2 ? 25020 : 24980)()
  const legs = { ce: { 25000: () => ({ o: 100, h: 100, l: 100, c: 100 }) }, pe: { 25000: () => ({ o: 100, h: 100, l: 100, c: 100 }) } }
  const d = fakeDay({ price, vwap: () => 25000, legs })
  const { trades, signals } = simulateDay(d, { rule: rule({ vwap: 'above' }, 'buyCE', { mirror: true }), timeStopMin: 5, cooldownMin: 10, maxTradesPerDay: 3, lotSize: 65, charges: false })
  assert.equal(trades.length, 3)
  assert.deepEqual(trades.map((t) => [t.strategy, t.side, t.action]), [['rule', 'CE', 'BUY'], ['mirror', 'PE', 'BUY'], ['rule', 'CE', 'BUY']])
  for (const tr of trades) {
    const m = istMinute(tr.entryTime)
    assert.ok(m >= 9 * 60 + 30 && m <= 14 * 60 + 45)
    assert.equal(tr.exitReason, 'Time stop 5 min')
    assert.equal(tr.net, tr.gross)
  }
  for (let k = 1; k < trades.length; k++) assert.ok(trades[k].entryTime >= trades[k - 1].exitTime + 10 * MIN)
  assert.ok(signals.some((s) => /outside/.test(s.skipped ?? '')))     // the 09:15 one
  assert.ok(signals.some((s) => /already today/.test(s.skipped ?? '')))
})

test('the synthetic day end to end: buy and sell, the call and the put; every trade exits after it enters', () => {
  const { run } = syntheticDay()
  const d = prepareDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY' })
  for (const action of ['buyCE', 'sellPE']) {
    const { trades } = simulateDay(d, { rule: { ...ANY_DAY_RULE, action }, lotSize: 65, maxTradesPerDay: 5, cooldownMin: 0, timeStopMin: 30 })
    assert.ok(trades.length > 1, action)
    for (const tr of trades) {
      assert.ok(tr.exitTime > tr.entryTime)
      assert.equal(tr.action, action === 'sellPE' ? 'SELL' : 'BUY')
      assert.equal(tr.side, tr.strategy === 'rule' ? action.slice(-2) : (action === 'buyCE' ? 'PE' : 'CE'))
      assert.ok(Math.abs(tr.gross - tr.points * 65) < 1e-6)
      assert.ok(tr.net < tr.gross)   // charges taken
    }
  }
  // The default rule runs (the page opens with it).
  assert.deepEqual(ruleConditions(BACKTEST_DEFAULTS.rule.conditions), [['oiOpen', 'peAhead'], ['vwap', 'above']])
  assert.ok(Array.isArray(simulateRun([d, { ok: false }], { lotSize: 65 }).trades))
})

test('the report: win rate, profit factor, drawdown, expectancy; the CSV', () => {
  const tr = (date, minute, net, points = net / 65) => ({ date, entryTime: T915 + minute * MIN, net, gross: net, charges: 0, points, holdMin: 10 })
  const s = summarize([tr('2026-10-05', 10, 1000), tr('2026-10-05', 40, -500), tr('2026-10-06', 10, -700), tr('2026-10-06', 50, 2000)])
  assert.equal(s.trades, 4)
  assert.equal(s.winRate, 50)
  assert.equal(s.net, 1800)
  assert.equal(s.profitFactor, 3000 / 1200)
  assert.equal(s.maxDrawdown, 1200)            // 1000 -> 500 -> -200
  assert.equal(s.expectancy, 450)
  assert.deepEqual([s.days, s.winningDays], [2, 2])   // +500 and +1300
  assert.deepEqual(summarize([]).trades, 0)
  const csv = tradesCsv([{ ...tr('2026-10-05', 30, 500), strategy: 'mirror', dir: 1, action: 'BUY', strike: 25000, side: 'CE', entry: 100, exit: 110, exitTime: T915 + 40 * MIN, exitReason: 'Target', why: '=cmd, "quoted"' }])
  const [head, row] = csv.split('\n')
  assert.match(head, /^date,rule,signal,action/)
  assert.match(row, /^2026-10-05,Mirror,bullish,BUY,25000 CE,09:45,100.00,09:55,110.00,Target/)
  assert.match(row, /"'=cmd, ""quoted"""$/)  // formula-safe and quoted
})

test('the days a backtest runs: weekdays in the range, before today, the latest 60 at most', async () => {
  const { backtestDays } = await import('../src/signalBacktest.js')
  assert.deepEqual(backtestDays('2026-10-23', '2026-10-28', '2026-10-31'), ['2026-10-23', '2026-10-26', '2026-10-27', '2026-10-28'])
  assert.deepEqual(backtestDays('2026-10-29', '2026-11-03', '2026-10-31'), ['2026-10-29', '2026-10-30'])   // today and after: not run
  assert.equal(backtestDays('2026-01-01', '2026-10-30', '2026-10-31').length, 60)
  assert.equal(backtestDays('2026-01-01', '2026-10-30', '2026-10-31').at(-1), '2026-10-30')
  assert.deepEqual(backtestDays(null, '2026-10-30', '2026-10-31'), [])
})

// ---- The timeframe ---------------------------------------------------------------------------------------------------

test('the timeframe: candles from 09:15 - OHLC from their minutes, every other feature as at their last minute', () => {
  const d = fakeDay({
    n: 70, spot: (i) => ({ o: 100 + i, h: 101 + i + (i === 7 ? 10 : 0), l: 99 + i, c: 100.5 + i }), vwap: (i) => i, oi: (i) => ({ ce: i, pe: 0 }),
    netCum: (i) => i * 2, breaks: [{ i: 7, line: 'net', up: true, dir: -1, text: 'x' }], ib: { high: 200, low: 50, done: 59 },
  })
  assert.deepEqual(TIMEFRAMES, [1, 3, 5, 15])
  assert.equal(timeframeView(d, 1), d)          // 1 minute: the day itself
  assert.equal(timeframeView(d, 7), d)          // not a timeframe offered: 1 minute
  const v = timeframeView(d, 5)
  assert.equal(v.tf, 5)
  assert.equal(v.n, 14)
  assert.deepEqual([...v.at].slice(0, 3), [4, 9, 14])        // each candle's last minute
  assert.deepEqual(v.spot.o.slice(0, 2), [100, 105])
  assert.deepEqual(v.spot.h.slice(0, 2), [105, 118])          // 09:22's spike is in the 09:20 candle
  assert.deepEqual(v.spot.l.slice(0, 2), [99, 104])
  assert.deepEqual(v.spot.c.slice(0, 2), [104.5, 109.5])
  assert.deepEqual(v.vwap.slice(0, 2), [4, 9])
  assert.deepEqual(v.oi[1], { ce: 9, pe: 0 })
  assert.deepEqual(v.netCum.slice(0, 2), [8, 18])
  assert.equal(v.t[1], d.t[9])                                 // known at the end of 09:24
  assert.deepEqual(v.breaks, [{ i: 1, line: 'net', up: true, dir: -1, text: 'x' }])    // in the candle it happened in, known at its close
  assert.equal(v.ib.done, 11)                                  // the 10:10 candle ends the IB
  assert.equal(timeframeView(d, 5), v)                         // worked out once
})

test('the timeframe: the rule reads completed candles - a 2-minute blip over VWAP is no 5-minute close over it; the trade enters at the candle\'s last minute', () => {
  // VWAP 100; price under it, over it at 09:56 - 09:57 only (a blip), under again, then over it for good from 10:25.
  const px = (i) => (i === 41 || i === 42 || i >= 70 ? 101 : 99)
  const d = fakeDay({ n: 120, spot: (i) => px(i), vwap: () => 100, legs: { ce: { 100: flat(50) }, pe: { 100: flat(50) } } })
  const r = rule({ vwap: 'above' })
  assert.deepEqual(at(ruleSignals(d, r)), [[41, 'rule', 'buyCE'], [70, 'rule', 'buyCE']])
  assert.deepEqual(at(ruleSignals(timeframeView(d, 5), r)), [[14, 'rule', 'buyCE']])   // the 10:25 candle closed over it
  const { trades, signals } = simulateDay(d, { rule: r, timeframe: 5, lotSize: 65 })
  assert.equal(signals.length, 1)
  assert.equal(trades.length, 1)
  assert.equal(trades[0].entryTime, d.t[74])                   // 10:29 - the 10:25 candle's last minute, its close
  assert.equal(istMinute(trades[0].entryTime), 10 * 60 + 29)
  assert.equal(simulateDay(d, { rule: r, lotSize: 65 }).signals.length, 2)   // 1 minute: the blip too
})

test('the timeframe: the rule\'s window is minutes - 15 minutes is 3 five-minute candles, 1 fifteen-minute one', () => {
  const d = fakeDay({ n: 120, price: (i) => flat(i < 50 ? 24980 : 25020)(), vwap: () => 25000 })
  const r = (windowMin) => ({ conditions: { vwap: 'crossedAbove' }, action: 'buyCE', windowMin })
  // Crossed at 09:65 = minute 50 (the 10:05 candle). On 5 minutes with a 15-minute window it holds over 3 candles.
  const v5 = timeframeView(d, 5)
  const held = (v, w) => Array.from({ length: v.n }, (_, k) => cond('vwap').test(v, k, 'crossedAbove', w)).filter(Boolean).length
  assert.equal(held(v5, 3), 3)
  assert.equal(held(timeframeView(d, 15), 1), 1)
  assert.equal(held(d, 15), 15)
  assert.deepEqual(at(ruleSignals(v5, r(15))), [[10, 'rule', 'buyCE']])
})

test('the timeframe on a real day: the OI totals\' breaks on its own buckets, and nothing after a candle\'s close', () => {
  const { run } = syntheticDay()
  const full = prepareDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY' })
  for (const tf of [3, 5, 15]) {
    // A bucket's break is known at the end of the bucket - the last minute of the timeframe's candle.
    for (const b of full.oiTf[tf].breaks) assert.equal((istMinute(full.t[b.i]) - (9 * 60 + 15)) % tf, tf - 1, `${tf} min break at ${b.i}`)
  }
  assert.ok(full.oiTf[5].breaks.length > 0)
  // The day cut at 11:44 (a candle's end on every timeframe): its candles are the full day's, and so are their signals.
  const cut = Date.parse('2026-10-05T11:44:00+05:30')
  const keep = (list) => list.filter((p) => Date.parse(p.time) <= cut)
  const part = prepareDay({
    ...run, optionExpiry: '2026-10-06', spotCandlesOneMinute: keep(run.spotCandlesOneMinute), futuresBars: keep(run.futuresBars), cePoints: keep(run.cePoints), pePoints: keep(run.pePoints),
  }, { underlying: 'NIFTY' })
  // A rule of many conditions, so most features are read.
  const wide = { conditions: { vwap: 'crossedAbove', cumNet: 'falling', gexRegime: 'long', straddle: 'aboveVwap' }, action: 'buyCE', mirror: true, windowMin: 15 }
  for (const tf of [3, 5, 15]) {
    const pv = timeframeView(part, tf)
    const fv = timeframeView(full, tf)
    assert.equal(pv.n, 150 / tf)
    for (let k = 0; k < pv.n; k++) {
      for (const key of ['oi', 'walls', 'gex', 'straddle', 'profile', 'vwap', 'ceCum', 'peCum', 'netCum', 'atm', 't', 'at']) assert.deepEqual(pv[key][k], fv[key][k], `${tf} min ${key} at ${k}`)
      for (const key of ['spot', 'price']) for (const f of ['o', 'h', 'l', 'c']) assert.equal(pv[key][f][k], fv[key][f][k], `${tf} min ${key}.${f} at ${k}`)
    }
    assert.deepEqual(pv.breaks, fv.breaks.filter((b) => b.i < pv.n))
    assert.deepEqual(pv.hp, fv.hp.filter((b) => b.i < pv.n))
    for (const r of [ANY_DAY_RULE, wide]) {
      const signalsOf = (d) => simulateDay(d, { lotSize: 65, timeframe: tf, rule: r }).signals.map((x) => [x.strategy, x.time, x.dir])
      assert.deepEqual(signalsOf(part), signalsOf(full).filter(([, time]) => time <= cut), `${tf} min signals`)
    }
  }
  // Longer candles, fewer signals.
  const count = (tf) => simulateDay(full, { lotSize: 65, timeframe: tf, rule: ANY_DAY_RULE }).signals.length
  assert.ok(count(15) < count(1), `${count(15)} < ${count(1)}`)
})
