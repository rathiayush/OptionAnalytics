// The Signal backtest (signalBacktest.js): a day's features from data up to each minute only (nothing after it), the ONE
// rule built on the page - every condition's values firing on their case and not without it, all of them together, the
// mirror - the option trade (BUY / SELL, stop before target, a gap through the stop, the time stop, the 15:10 square-off),
// the timeframe and the report.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { day as syntheticDay } from './synthetic-day.mjs'
import {
  BACKTEST_DEFAULTS, DEFAULT_WINDOW, dayLevel, MAX_GROUP_DEPTH, MAX_LOGIC_LENGTH, RULE_ACTIONS, RULE_CONDITIONS, TIMEFRAMES, cleanLine, cleanTree, evalLogic, istMinute, lineText, logicText,
  logicWithoutLine, mirrorIsSame, mirrorLines, normalizeRule, optionFor, parseLogic, prepareDay, ruleFromTree, ruleLogic, ruleSignals, ruleText, setConnectorAt, treeFromLogic, treeFromRule, mixedLogicReadings,
  simulateDay, simulateRun, simulateTrade, summarize, timeframeView, tradesCsv,
} from '../src/signalBacktest.js'
import { tradeCharges } from '../src/tradeCharges.js'

const MIN = 60_000
const T915 = Date.parse('2026-10-05T09:15:00+05:30')
const cond = (id) => RULE_CONDITIONS.find((c) => c.id === id)
// Does condition `id` say `value` at minute i of `d` (window `w` candles)?
// Does condition `id` say `value` at minute i of `d` (window `w` candles; `p` its number, else the option's default)?
const holds = (d, id, value, i, w = 5, p = cond(id).options.find((o) => o.value === value).param?.default ?? 0) => cond(id).test(d, i, value, w, p)
// A rule of AND-ed conditions { id: value } (the earlier form - read by normalizeRule) or of lines.
const rule = (conditions, action = 'buyCE', more = {}) => ({ conditions, action, mirror: false, windowMin: 5, ...more })
const lines = (list, action = 'buyCE', more = {}) => ({ lines: list, action, mirror: false, ...more })
const at = (list) => list.map((x) => [x.i, x.side, x.action])

// A prepared day built by hand: `n` minutes from 09:15, everything flat unless given.
function fakeDay({ n = 360, spot = () => 25000, price = null, vwap = () => 24990, oi = () => ({ ce: 0, pe: 0 }), walls = () => ({ support: null, resistance: null }),
  gex = () => null, straddle = () => null, ib = null, breaks = [], hp = [], ceCum = () => NaN, peCum = () => NaN, netCum = () => NaN,
  straddleWidth = 100, legs = {}, prevVp = null, tot = () => ({ ce: 4e7, pe: 4e7 }) } = {}) {
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
    vwap: bar(vwap), oi: bar(oi), tot: bar(tot), walls: bar(walls), gex: bar(gex), straddle: bar(straddle),
    ceCum: bar(ceCum), peCum: bar(peCum), netCum: bar(netCum),
    ib, breaks, hp, straddleWidth, prevVp, priceSource: 'futures', ce: side('ce'), pe: side('pe'),
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
    for (const k of ['oi', 'tot', 'walls', 'gex', 'straddle']) assert.deepEqual(part[k][i], full[k][i], `${k} at ${i}`)
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

test('the trade: SL / target in points or %, 0 = none; the trailing stop - behind the best premium, after each bar, only tighter', () => {
  const at = (bars) => fakeDay({ n: 30, legs: { ce: { 25000: (i) => bars[i] ?? null } } })
  const buy = { side: 'CE', strike: 25000, action: 'BUY' }
  const sell = { side: 'CE', strike: 25000, action: 'SELL' }
  const bar = (o, h, l, c) => ({ o, h, l, c })
  // Points: entry 100, SL 15 pts (85), target 25 pts (125).
  let tr = simulateTrade(at({ 0: bar(100, 100, 100, 100), 2: bar(100, 110, 84, 90) }), 0, buy, { slPct: 15, targetPct: 25, levelUnit: 'pts' })
  assert.deepEqual([tr.exit, tr.exitReason], [85, 'Stop'])
  tr = simulateTrade(at({ 0: bar(100, 100, 100, 100), 2: bar(100, 126, 95, 120) }), 0, buy, { slPct: 15, targetPct: 25, levelUnit: 'pts' })
  assert.deepEqual([tr.exit, tr.exitReason], [125, 'Target'])
  // 0 = none: no stop, no target - out at the square-off.
  tr = simulateTrade(at({ 0: bar(100, 100, 100, 100), 2: bar(100, 300, 1, 100) }), 0, buy, { slPct: 0, targetPct: 0, levelUnit: 'pts' })
  assert.equal(tr.exitReason, 'Day end')
  // The trail (gap 10 points, from the entry): 100 -> a high of 130 -> trail 120; the next bar's low 118 takes it at 120.
  const run = { 0: bar(100, 100, 100, 100), 1: bar(100, 112, 99, 110), 2: bar(110, 130, 108, 128), 3: bar(127, 129, 118, 119) }
  tr = simulateTrade(at(run), 0, buy, { slPct: 0, targetPct: 0, levelUnit: 'pts', trailGap: 10 })
  assert.deepEqual([tr.exit, tr.exitReason, tr.exitIndex, tr.points], [120, 'Trailing stop', 3, 20])
  // The bar that makes the high is judged with the trail it had before it: bar 2's low 108 is over the 102 from bar 1.
  // A wider SL never loosens it: the tighter of the two is the stop.
  tr = simulateTrade(at(run), 0, buy, { slPct: 30, targetPct: 0, levelUnit: 'pts', trailGap: 10 })
  assert.deepEqual([tr.exit, tr.exitReason], [120, 'Trailing stop'])
  // Only tightens: a lower high later keeps the 120.
  const fade = { ...run, 3: bar(127, 127, 121, 122), 4: bar(122, 125, 119, 120) }
  tr = simulateTrade(at(fade), 0, buy, { slPct: 0, targetPct: 0, levelUnit: 'pts', trailGap: 10 })
  assert.deepEqual([tr.exit, tr.exitIndex], [120, 4])
  // Start after +20 profit: bar 1's high (112) does not start it; bar 2's (130) does.
  tr = simulateTrade(at({ ...run, 2: bar(110, 115, 101, 104), 3: bar(104, 106, 100, 101) }), 0, buy, { slPct: 0, targetPct: 0, levelUnit: 'pts', trailGap: 10, trailStart: 20 })
  assert.equal(tr.exitReason, 'Day end')                                      // never 20 up: no trail (102 would have taken it)
  tr = simulateTrade(at(run), 0, buy, { slPct: 0, targetPct: 0, levelUnit: 'pts', trailGap: 10, trailStart: 20 })
  assert.deepEqual([tr.exit, tr.exitReason], [120, 'Trailing stop'])
  // A gap through the trail fills at the open.
  tr = simulateTrade(at({ ...run, 3: bar(115, 116, 110, 112) }), 0, buy, { slPct: 0, targetPct: 0, levelUnit: 'pts', trailGap: 10 })
  assert.deepEqual([tr.exit, tr.exitReason], [115, 'Trailing stop (opened through it)'])
  // In %: a 10% gap on a 100 entry is 10 points - the same trade.
  tr = simulateTrade(at(run), 0, buy, { slPct: 0, targetPct: 0, levelUnit: 'pct', trailGap: 10 })
  assert.deepEqual([tr.exit, tr.exitReason], [120, 'Trailing stop'])
  // SOLD: the trail above the lowest premium - 100 -> a low of 70 -> trail 80; a high of 82 takes it at 80.
  const down = { 0: bar(100, 100, 100, 100), 1: bar(100, 101, 88, 90), 2: bar(90, 92, 70, 72), 3: bar(73, 82, 71, 81) }
  tr = simulateTrade(at(down), 0, sell, { slPct: 0, targetPct: 0, levelUnit: 'pts', trailGap: 10 })
  assert.deepEqual([tr.exit, tr.exitReason, tr.points], [80, 'Trailing stop', 20])
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

test('Total OI: total CE / PE OI increased / decreased / flat by a % over the window; CE vs PE - which is above, one crossing the other', () => {
  // Total CE OI 4 cr flat until 40, then +1% a minute for 10 minutes (to 4.4 cr), then flat. Total PE OI 4 cr all day.
  const ceAt = (i) => 4e7 * (i < 40 ? 1 : i < 50 ? 1 + (i - 40) * 0.01 : 1.1)
  const d = fakeDay({ tot: (i) => ({ ce: ceAt(i), pe: 4e7 }) })
  assert.ok(holds(d, 'totalCe', 'flat', 30) && !holds(d, 'totalCe', 'rising', 30))
  assert.ok(holds(d, 'totalCe', 'rising', 45) && !holds(d, 'totalCe', 'falling', 45))            // +5% over 5 minutes
  assert.ok(holds(d, 'totalCe', 'rising', 45, 5, 4) && !holds(d, 'totalCe', 'rising', 45, 5, 6))  // by ≥ 4% yes, 6% no
  assert.ok(holds(d, 'totalCe', 'flat', 60) && holds(d, 'totalCe', 'rising', 52, 15))             // 15-minute window still sees it
  assert.ok(holds(fakeDay({ tot: (i) => ({ ce: 4e7, pe: 4e7 * (1 - i * 0.002) }) }), 'totalPe', 'falling', 40))
  assert.ok(!holds(fakeDay({ tot: () => ({ ce: 0, pe: 0 }) }), 'totalCe', 'flat', 40))           // no OI read: nothing
  assert.match(cond('totalCe').options.find((o) => o.value === 'rising').label, /^Increased/)
  assert.match(cond('totalPe').options.find((o) => o.value === 'falling').label, /^Decreased/)
  // CE vs PE - the Total OI chart's two lines. PE 4.2 cr all day; CE 4 cr, 4.4 cr from 40 (CE crosses above PE), 4 cr from
  // 70 (PE crosses back above CE).
  const x = fakeDay({ tot: (i) => ({ ce: i >= 40 && i < 70 ? 4.4e7 : 4e7, pe: 4.2e7 }) })
  assert.ok(holds(x, 'totalOi', 'peAbove', 30) && !holds(x, 'totalOi', 'ceAbove', 30))
  assert.ok(holds(x, 'totalOi', 'ceAbove', 50) && !holds(x, 'totalOi', 'peAbove', 50))
  assert.ok(holds(x, 'totalOi', 'ceCross', 42) && !holds(x, 'totalOi', 'peCross', 42))    // crossed at 40, 2 minutes ago
  assert.ok(!holds(x, 'totalOi', 'ceCross', 46))                                            // 6 minutes ago: out of a 5-minute window
  assert.ok(holds(x, 'totalOi', 'ceCross', 46, 10))                                         // in a 10-minute one
  assert.ok(holds(x, 'totalOi', 'peCross', 72) && !holds(x, 'totalOi', 'ceCross', 72))
  assert.ok(!holds(x, 'totalOi', 'peCross', 30))                                            // above all along: no cross
  // "by ≥ %" - the line ahead by at least that % of the other (like OI since open's lead). Until 40 PE 4.2 cr over CE 4 cr
  // = 5%; from 40 CE 4.4 cr over PE 4.2 cr = 4.76%; a cross counts only with that lead now too.
  assert.ok(holds(x, 'totalOi', 'peAbove', 30, 5, 5) && !holds(x, 'totalOi', 'peAbove', 30, 5, 5.5))
  assert.ok(holds(x, 'totalOi', 'ceAbove', 50, 5, 4.5) && !holds(x, 'totalOi', 'ceAbove', 50, 5, 5))
  assert.ok(holds(x, 'totalOi', 'ceCross', 42, 5, 4.5) && !holds(x, 'totalOi', 'ceCross', 42, 5, 5))
  assert.ok(holds(x, 'totalOi', 'peCross', 72, 5, 5) && !holds(x, 'totalOi', 'peCross', 72, 5, 6))
  assert.equal(cond('totalOi').options.find((o) => o.value === 'peAbove').param.default, 0)        // 0 = any lead, as before
  assert.match(cond('totalOi').show(x, 50), /CE \+4\.8%/)
  assert.match(lineText({ id: 'totalOi', value: 'peAbove', param: 5 }), /PE above CE .*by ≥ 5%$/)
  assert.deepEqual(mirrorLines([cleanLine({ id: 'totalOi', value: 'peCross', param: 3, windowMin: 10 })]).map((l) => [l.value, l.param, l.windowMin]), [['ceCross', 3, 10]])
  assert.equal(cleanLine({ id: 'totalOi', value: 'peAbove' }).param, 0)                             // a line saved before: any lead
  // A cross that did not hold is not one: CE above PE for 2 minutes only (40 - 41).
  const poke = fakeDay({ tot: (i) => ({ ce: i === 40 || i === 41 ? 4.4e7 : 4e7, pe: 4.2e7 }) })
  assert.ok(holds(poke, 'totalOi', 'ceCross', 41) && !holds(poke, 'totalOi', 'ceCross', 43) && holds(poke, 'totalOi', 'peCross', 43))
  // No OI read: neither side.
  const none = fakeDay({ tot: () => ({ ce: 0, pe: 0 }) })
  assert.ok(!holds(none, 'totalOi', 'peAbove', 40) && !holds(none, 'totalOi', 'ceAbove', 40))
  // In a rule, with its mirror: PE crossed above CE -> buy the call; CE crossed above PE -> buy the put.
  assert.deepEqual(at(ruleSignals(x, lines([{ id: 'totalOi', value: 'peCross' }], 'buyCE', { mirror: true }))), [[40, 'mirror', 'buyPE'], [70, 'rule', 'buyCE']])
  // And total PE OI increased -> buy the call; decreased -> buy the put.
  const pe = (i) => 4e7 * (i < 40 ? 1 : i < 50 ? 1 + (i - 40) * 0.01 : i < 80 ? 1.1 : 1.1 - (i - 80) * 0.01)
  const r = fakeDay({ tot: (i) => ({ ce: 4e7, pe: pe(i) }) })
  assert.deepEqual(at(ruleSignals(r, rule({ totalPe: 'rising' }, 'buyCE', { mirror: true }))), [[41, 'rule', 'buyCE'], [81, 'mirror', 'buyPE']])
  assert.match(lineText({ id: 'totalOi', value: 'peCross', windowMin: 10 }), /^Total OI: CE vs PE.*PE crossed above CE.*10 min/)
  // The PCR condition was removed: a line saved with it is dropped, the rest of the rule kept.
  assert.ok(!RULE_CONDITIONS.some((c) => c.id === 'totalPcr'))
  assert.deepEqual(normalizeRule(lines([{ id: 'totalPcr', value: 'above', param: 0.9 }, { id: 'vwap', value: 'above' }])).lines.map((l) => l.id), ['vwap'])
})

test('Total OI on a prepared day: the chain-wide totals OI Replay shows - OI since open is them less the open\'s', () => {
  const { run } = syntheticDay()
  const d = prepareDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY' })
  for (const i of [0, 30, 120, 250]) {
    assert.equal(d.tot[i].ce - d.tot[0].ce, d.oi[i].ce)
    assert.equal(d.tot[i].pe - d.tot[0].pe, d.oi[i].pe)
  }
  assert.ok(d.tot[0].ce > 0 && d.tot[0].pe > 0)
  assert.deepEqual(timeframeView(d, 5).tot[1], d.tot[9])         // a 5-minute candle: the totals at its last minute
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

test('the straddle against its VWAP and the decay line; the IB after 10:15', () => {
  const straddle = (i) => ({ value: i < 50 ? 100 : 120, vwap: 110, decay: 105, forward: 25000 })
  const d = fakeDay({ straddle })
  assert.ok(holds(d, 'straddle', 'belowVwap', 40) && holds(d, 'straddle', 'belowDecay', 40))
  assert.ok(holds(d, 'straddle', 'aboveVwap', 60) && holds(d, 'straddle', 'aboveDecay', 60))
  assert.ok(holds(d, 'straddle', 'crossedAbove', 52) && !holds(d, 'straddle', 'crossedAbove', 60))
  const price = (i) => flat(i < 70 ? 25020 : 25080)()
  const p = fakeDay({ price, ib: { high: 25050, low: 24950, done: 59 } })
  assert.ok(!holds(p, 'ib', 'inside', 40))                    // the IB is not done before 10:15
  assert.ok(holds(p, 'ib', 'inside', 65) && holds(p, 'ib', 'aboveHigh', 80) && !holds(p, 'ib', 'belowLow', 80))
})

test('the previous day\'s volume profile levels, on spot: above / below, crossed, touched and held, near, its value area', () => {
  const prevVp = { date: '2026-10-02', poc: 24900, vah: 25100, val: 24800, hvn: 25000, lvn: 24950 }
  // Spot under the HVN, through it at 60, a dip back to it at 70 that closes above (held), then on up.
  const spot = (i) => (i < 60 ? flat(24980)() : i === 70 ? { o: 25020, h: 25025, l: 25004, c: 25018 } : flat(25030)())
  const d = fakeDay({ spot, prevVp })
  assert.ok(holds(d, 'prevHvn', 'below', 50) && holds(d, 'prevHvn', 'above', 65))
  assert.ok(holds(d, 'prevHvn', 'crossedAbove', 62) && !holds(d, 'prevHvn', 'crossedAbove', 68))   // 8 minutes on: out of a 5-minute window
  assert.ok(holds(d, 'prevHvn', 'crossedAbove', 68, 10))                                             // in a 10-minute one
  assert.ok(holds(d, 'prevHvn', 'heldAbove', 72))                                                    // low 25004 within 0.05% of 25000, closed above
  assert.ok(!holds(d, 'prevHvn', 'heldAbove', 66))                                                   // nothing touched it yet
  assert.ok(holds(d, 'prevHvn', 'near', 72) && !holds(d, 'prevHvn', 'near', 80))
  assert.ok(holds(d, 'prevHvn', 'above', 65, 5, 0.1) && !holds(d, 'prevHvn', 'above', 65, 5, 0.2))  // 30 over 25000 = 0.12%
  assert.ok(holds(d, 'prevLvn', 'above', 40) && holds(d, 'prevPoc', 'above', 40) && holds(d, 'prevVah', 'below', 40) && holds(d, 'prevVal', 'above', 40))
  assert.ok(holds(d, 'valueArea', 'inside', 40) && !holds(d, 'valueArea', 'aboveVah', 40))
  assert.ok(holds(fakeDay({ spot: () => 25150, prevVp }), 'valueArea', 'aboveVah', 40) && holds(fakeDay({ spot: () => 24700, prevVp }), 'valueArea', 'belowVal', 40))
  // Resistance held: a poke up to the HVN that closes back under it.
  const reject = fakeDay({ spot: (i) => (i === 40 ? { o: 24985, h: 25003, l: 24980, c: 24985 } : flat(24970)()), prevVp })
  assert.ok(holds(reject, 'prevHvn', 'heldBelow', 42) && !holds(reject, 'prevHvn', 'heldAbove', 42))
  // No previous day's profile (or no HVN in it): nothing holds.
  assert.ok(!holds(fakeDay({ spot }), 'prevLvn', 'above', 52) && !holds(fakeDay({ spot }), 'valueArea', 'inside', 52))
  assert.ok(!holds(fakeDay({ spot, prevVp: { ...prevVp, hvn: null } }), 'prevHvn', 'above', 65))
  // In a rule, with its mirror: crossed above the previous day's LVN -> buy the call; crossed below it -> buy the put.
  const both = fakeDay({ spot: (i) => (i < 50 ? 24940 : i < 100 ? 24960 : 24940), prevVp })
  assert.deepEqual(at(ruleSignals(both, rule({ prevLvn: 'crossedAbove' }, 'buyCE', { mirror: true }))), [[50, 'rule', 'buyCE'], [100, 'mirror', 'buyPE']])
  // A line saved while the levels were today's developing ones reads as the previous day's same level.
  assert.deepEqual(cleanLine({ id: 'vpHvn', value: 'crossedAbove', windowMin: 10 }), { id: 'prevHvn', value: 'crossedAbove', join: 'and', param: 0, windowMin: 10 })
  assert.deepEqual(normalizeRule(rule({ poc: 'above', vpLvn: 'near' })).lines.map((l) => [l.id, l.value]), [['prevPoc', 'above'], ['prevLvn', 'near']])
})

test('the previous day\'s profile on a prepared day: its first HVN / LVN, only a day before the one replayed', () => {
  const { run } = syntheticDay()
  const prev = { success: true, profileDate: '2026-10-03', poc: 22650, vah: 22700, val: 22600, hvn: [22680, 22620], lvn: [22640] }
  const d = prepareDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY', prevProfile: prev })
  assert.deepEqual(d.prevVp, { date: '2026-10-03', poc: 22650, vah: 22700, val: 22600, hvn: 22680, lvn: 22640 })
  assert.equal(prepareDay(run, { underlying: 'NIFTY' }).prevVp, null)
  assert.equal(prepareDay(run, { underlying: 'NIFTY', prevProfile: { ...prev, success: false } }).prevVp, null)
  assert.equal(prepareDay(run, { underlying: 'NIFTY', prevProfile: { ...prev, profileDate: '2026-10-05' } }).prevVp, null)   // not before the day
  assert.deepEqual(prepareDay(run, { underlying: 'NIFTY', prevProfile: { ...prev, hvn: [], lvn: null } }).prevVp.hvn, null)
  // Every timeframe reads the same fixed levels.
  assert.deepEqual(timeframeView(d, 5).prevVp, d.prevVp)
  // No developing profile any more: the levels are the previous day's only.
  assert.equal(d.profile, undefined)
  assert.ok(!RULE_CONDITIONS.some((c) => /developing/i.test(c.name)))
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
  const four = normalizeRule(rule({ oiOpen: 'peAhead', vwap: 'above', gexRegime: 'short', cumCe: 'falling' })).lines
  assert.deepEqual(mirrorLines(four).map((l) => [l.id, l.value]), [['oiOpen', 'ceAhead'], ['cumCe', 'rising'], ['gexRegime', 'short'], ['vwap', 'below']])
  assert.equal(mirrorIsSame(four), false)
  assert.equal(mirrorIsSame(normalizeRule(rule({ gexRegime: 'short', straddle: 'aboveVwap' })).lines), true)
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
  assert.match(ruleText(normalizeRule(rule({ vwap: 'above', oiOpen: 'peAhead' })).lines, 'buyCE'), /^Buy CE when OI since open.*PE added > CE added.* AND Price vs VWAP: Price above VWAP$/)
  assert.deepEqual(normalizeRule(rule({ vwap: 'above', bogus: 'x', oiOpen: 'any' })).lines.map((l) => [l.id, l.value]), [['vwap', 'above']])
})

test('the numbers: VWAP / POC / straddle "by ≥ %", the OI lead, near "within %", spot\'s move and the cumulative line\'s tolerance', () => {
  // Price 0.08% over VWAP: above by ≥ 0 yes, by ≥ 0.05% yes, by ≥ 0.1% no.
  const d = fakeDay({ price: () => flat(25020)(), vwap: () => 25000 })
  assert.ok(holds(d, 'vwap', 'above', 40, 5, 0) && holds(d, 'vwap', 'above', 40, 5, 0.05) && !holds(d, 'vwap', 'above', 40, 5, 0.1))
  // OI: PE 3L vs CE 2L added = a 20% lead.
  const oi = fakeDay({ oi: () => ({ ce: 2e5, pe: 3e5 }) })
  assert.ok(holds(oi, 'oiOpen', 'peAhead', 40, 5, 15) && !holds(oi, 'oiOpen', 'peAhead', 40, 5, 25))
  // Near the OI support: 20 points over 24900 is 0.08% - within 0.1%, not within the default 0.05%.
  const walls = () => ({ support: 24900, resistance: 25100 })
  const dip = fakeDay({ walls, spot: (i) => (i === 50 ? { o: 24950, h: 24950, l: 24920, c: 24940 } : flat(25000)()) })
  assert.ok(!holds(dip, 'oiWalls', 'nearSupport', 51) && holds(dip, 'oiWalls', 'nearSupport', 51, 5, 0.1))
  // Spot up 0.2% over 5 minutes: rising by 0.1% yes, by 0.3% no; sideways under 0.3% yes.
  const up = fakeDay({ spot: (i) => 25000 + (i >= 50 ? (i - 50) * 10 : 0) })
  assert.ok(holds(up, 'spotMove', 'rising', 60, 5, 0.1) && !holds(up, 'spotMove', 'rising', 60, 5, 0.3) && holds(up, 'spotMove', 'sideways', 60, 5, 0.3))
  // The net line up 50 over 5 minutes on a range of 400 (12.5%): rising at a 10% tolerance, stable at 20%.
  const net = fakeDay({ netCum: (i) => (i < 40 ? -200 + i * 10 : i < 60 ? 200 : 200 + (i - 60) * 10) })
  assert.ok(holds(net, 'cumNet', 'rising', 65, 5, 10) && holds(net, 'cumNet', 'stable', 65, 5, 20))
  // The straddle 5% over its VWAP: by ≥ 3% yes, by ≥ 6% no.
  const st = fakeDay({ straddle: () => ({ value: 105, vwap: 100, decay: 90, forward: 25000 }) })
  assert.ok(holds(st, 'straddle', 'aboveVwap', 40, 5, 3) && !holds(st, 'straddle', 'aboveVwap', 40, 5, 6))
})

test('AND / OR: AND binds tighter - (A AND B) OR C; each line its own window; the words show the brackets', () => {
  // A: price over VWAP from 60. B: PE ahead from 80. C: a bullish 🎯 at 30.
  const d = fakeDay({ price: (i) => flat(i >= 60 ? 25020 : 24980)(), vwap: () => 25000, oi: (i) => (i >= 80 ? { ce: 1e5, pe: 3e5 } : { ce: 3e5, pe: 1e5 }), hp: [{ i: 30, dir: 1 }] })
  const A = { id: 'vwap', value: 'above' }
  const B = { id: 'oiOpen', value: 'peAhead' }
  const C = { id: 'hp', value: 'bullish', windowMin: 5 }
  assert.deepEqual(at(ruleSignals(d, lines([A, { ...B, join: 'and' }]))), [[80, 'rule', 'buyCE']])
  assert.deepEqual(at(ruleSignals(d, lines([A, { ...B, join: 'or' }]))), [[60, 'rule', 'buyCE']])
  // (A AND B) OR C: the 🎯 alone at 30 (true 30 - 34), then A AND B at 80.
  assert.deepEqual(at(ruleSignals(d, lines([A, { ...B, join: 'and' }, { ...C, join: 'or' }]))), [[30, 'rule', 'buyCE'], [80, 'rule', 'buyCE']])
  // (Read as A AND (B OR C) it would have signalled at 80 only.) A line's own window: C over 30 minutes holds 30 - 59,
  // and C OR A runs on into A from 60 - one stretch, one signal.
  const long = lines([{ ...C, windowMin: 30 }, { ...A, join: 'or' }])
  assert.deepEqual(at(ruleSignals(d, long)), [[30, 'rule', 'buyCE']])   // C 30 - 59, A from 60: one unbroken stretch
  assert.equal(ruleText(normalizeRule(lines([A, { ...B, join: 'and' }, { ...C, join: 'or' }])).lines, 'buyCE'),
    'Buy CE when (Price vs VWAP: Price above VWAP AND OI since open (chain-wide): PE added > CE added (put writing ahead)) OR 🎯 High probability: Bullish 🎯 (last 5 min)')
  // The mirror keeps the joins and numbers, flips the values.
  const m = mirrorLines(normalizeRule(lines([{ ...A, param: 0.1 }, { ...C, join: 'or', windowMin: 10 }])).lines)
  assert.deepEqual(m, [{ id: 'vwap', value: 'below', join: 'and', param: 0.1 }, { id: 'hp', value: 'bearish', join: 'or', windowMin: 10 }])
  // The same indicator twice: near the OI support OR broke above the resistance.
  const r = normalizeRule(lines([{ id: 'oiWalls', value: 'nearSupport' }, { id: 'oiWalls', value: 'brokeResistance', join: 'or' }]))
  assert.equal(r.lines.length, 2)
})

test('logic: the lines by number with AND / OR / NOT and brackets, any nesting - NOT, then AND, then OR', () => {
  const truth = (t) => (no) => t[no - 1]
  const holds = (text, t) => { const p = parseLogic(text, t.length); assert.ok(p.ok, p.error); return evalLogic(p.tree, truth(t)) }
  // The example asked: (1 and 2) or (3 and (4 and 5)).
  assert.equal(holds('(1 and 2) or ( 3 and (4 and 5))', [true, true, false, false, false]), true)
  assert.equal(holds('(1 and 2) or ( 3 and (4 and 5))', [true, false, true, true, true]), true)
  assert.equal(holds('(1 and 2) or ( 3 and (4 and 5))', [true, false, true, true, false]), false)
  // What the lines' own AND / OR cannot say: (1 OR 2) AND (3 OR 4).
  assert.equal(holds('(1 OR 2) AND (3 OR 4)', [false, true, true, false]), true)
  assert.equal(holds('(1 OR 2) AND (3 OR 4)', [true, true, false, false]), false)
  // Precedence without brackets, NOT, and the symbols.
  assert.equal(holds('1 or 2 and 3', [true, false, false]), true)            // 1 OR (2 AND 3)
  assert.equal(holds('(1 or 2) and 3', [true, false, false]), false)
  assert.equal(holds('NOT 1 AND 2', [false, true]), true)
  assert.equal(holds('not (1 or 2)', [false, false]), true)
  assert.equal(holds('1 & (2 | !3)', [true, false, false]), true)
  // In words: AND inside OR bracketed; the lines used.
  const p = parseLogic('(1 and 2) or ( 3 and (4 and 5))', 5)
  assert.equal(logicText(p.tree), '(1 AND 2) OR (3 AND 4 AND 5)')
  assert.deepEqual([...p.used].sort(), [1, 2, 3, 4, 5])
  assert.equal(logicText(parseLogic('(1 or 2) and not (3 or 4)', 4).tree), '(1 OR 2) AND NOT (3 OR 4)')
  // What does not read, said in words.
  assert.match(parseLogic('(1 and 2', 3).error, /"\)" is missing/)
  assert.match(parseLogic('1 and 7', 3).error, /no line 7/)
  assert.match(parseLogic('1 2', 3).error, /AND \/ OR is missing/)
  assert.match(parseLogic('1 and', 3).error, /ends too early/)
  assert.match(parseLogic('1 xor 2', 3).error, /cannot read/)
  assert.match(parseLogic('1 and )', 3).error, /should be/)
})

test('logic in a rule: it combines the lines (the mirror by the same logic); bad logic signals nothing; removing a line renumbers it', () => {
  // 1: price over VWAP from 60. 2: PE ahead from 80. 3: a bullish 🎯 at 30. 4: the straddle over its VWAP from 100.
  const d = fakeDay({
    price: (i) => flat(i >= 60 ? 25020 : 24980)(), vwap: () => 25000, oi: (i) => (i >= 80 ? { ce: 1e5, pe: 3e5 } : { ce: 3e5, pe: 1e5 }),
    hp: [{ i: 30, dir: 1 }], straddle: (i) => ({ value: i >= 100 ? 120 : 100, vwap: 110, decay: 90, forward: 25000 }),
  })
  const four = [{ id: 'vwap', value: 'above' }, { id: 'oiOpen', value: 'peAhead' }, { id: 'hp', value: 'bullish', windowMin: 5 }, { id: 'straddle', value: 'aboveVwap' }]
  // (1 OR 3) AND (2 OR 4): from 80 (1 and 2).
  assert.deepEqual(at(ruleSignals(d, lines(four, 'buyCE', { logic: '(1 OR 3) AND (2 OR 4)' }))), [[80, 'rule', 'buyCE']])
  // 3 OR (1 AND 4): the 🎯 at 30 (30 - 34), then 1 AND 4 from 100.
  assert.deepEqual(at(ruleSignals(d, lines(four, 'buyCE', { logic: '3 OR (1 AND 4)' }))), [[30, 'rule', 'buyCE'], [100, 'rule', 'buyCE']])
  // The logic overrides the lines' own AND / OR: the same lines all joined by OR, logic 1 AND 2.
  const ors = four.map((l) => ({ ...l, join: 'or' }))
  assert.deepEqual(at(ruleSignals(d, lines(ors, 'buyCE', { logic: '1 and 2' }))), [[80, 'rule', 'buyCE']])
  // Logic that does not read: nothing (never a guess).
  assert.deepEqual(ruleSignals(d, lines(four, 'buyCE', { logic: '(1 and 2' })), [])
  assert.deepEqual(ruleSignals(d, lines(four, 'buyCE', { logic: '1 and 9' })), [])
  assert.equal(ruleLogic({ lines: four, logic: '  ' }), null)
  assert.ok(ruleLogic({ lines: four, logic: '(1' }).error)
  // The mirror: the same logic on the flipped lines - price under VWAP AND CE ahead -> buy the put.
  const flip = fakeDay({ price: (i) => flat(i >= 60 ? 24980 : 25020)(), vwap: () => 25000, oi: (i) => (i >= 80 ? { ce: 3e5, pe: 1e5 } : { ce: 1e5, pe: 3e5 }) })
  assert.deepEqual(at(ruleSignals(flip, lines(four.slice(0, 2), 'buyCE', { logic: '1 and 2', mirror: true }))), [[0, 'rule', 'buyCE'], [80, 'mirror', 'buyPE']])
  // Kept on the rule as typed; in words with each line by number.
  assert.equal(normalizeRule(lines(four, 'buyCE', { logic: '(1 or 3) and 2' })).logic, '(1 or 3) and 2')
  assert.equal(normalizeRule(lines(four, 'buyCE')).logic, '')
  assert.match(ruleText(normalizeRule(lines(four, 'buyCE')).lines, 'buyCE', '(1 or 3) and 2'), /^Buy CE when \(Price vs VWAP: Price above VWAP OR 🎯 High probability: Bullish 🎯 \(last 5 min\)\) AND OI since open/)
  // Removing a line: it leaves the logic with its AND / OR, the lines after it renumbered.
  assert.equal(logicWithoutLine('(1 and 2) or (3 and (4 and 5))', 5, 3), '(1 AND 2) OR (3 AND 4)')
  assert.equal(logicWithoutLine('(1 and 2) or 3', 3, 1), '1 OR 2')
  assert.equal(logicWithoutLine('not 2 and 1', 2, 2), '1')
  assert.equal(logicWithoutLine('1', 1, 1), '')
  assert.equal(logicWithoutLine('(1 and', 3, 1), '(1 and')   // does not read: left as typed
})

test('every comparison takes a "by ≥ %" - the crossings and turns too; 0 (the default) changes nothing', () => {
  // Only what has nothing to measure is without one: a 🎯 (an event) and "inside".
  const without = RULE_CONDITIONS.flatMap((c) => c.options.filter((o) => !o.param).map((o) => `${c.id}:${o.value}`))
  assert.deepEqual(without, ['hp:bullish', 'hp:bearish', 'ib:inside', 'valueArea:inside'])
  const step = (i) => (i < 50 ? 24980 : 25100)                     // spot / price: under 25000 until 50, then 0.4% over it
  // OI since open crossed - with the lead now (PE 130 v CE 100 = 30 / 230 = 13%).
  const oi = fakeDay({ oi: (i) => (i < 50 ? { ce: 100, pe: 90 } : { ce: 100, pe: 130 }) })
  assert.ok(holds(oi, 'oiOpen', 'peCross', 52, 5, 0) && holds(oi, 'oiOpen', 'peCross', 52, 5, 12) && !holds(oi, 'oiOpen', 'peCross', 52, 5, 14))
  // A cumulative line: -100 until 50, then +20, +60 from 60 - past 0 by % of its range so far.
  const net = fakeDay({ netCum: (i) => (i < 50 ? -100 : i < 60 ? 20 : 60), breaks: [{ i: 50, line: 'net', up: true, level: 10 }] })
  assert.ok(holds(net, 'cumNet', 'turnedPositive', 52, 5, 0) && holds(net, 'cumNet', 'turnedPositive', 52, 5, 15) && !holds(net, 'cumNet', 'turnedPositive', 52, 5, 20))   // 20 / 120 = 16.7%
  assert.ok(holds(net, 'cumNet', 'positive', 62, 5, 35) && !holds(net, 'cumNet', 'positive', 62, 5, 40))                                                                 // 60 / 160 = 37.5%
  assert.ok(holds(net, 'cumNet', 'negative', 30, 5, 0) && !holds(net, 'cumNet', 'negative', 30, 5, 1))                                                                   // no range yet: 0%
  // ... and past the level it broke (10): 10 / 120 = 8.3% at 52.
  assert.ok(holds(net, 'cumNet', 'brokeResistance', 52, 5, 0) && holds(net, 'cumNet', 'brokeResistance', 52, 5, 8) && !holds(net, 'cumNet', 'brokeResistance', 52, 5, 9))
  // The OI walls and GEX walls broken - by % of the wall, now.
  const walls = fakeDay({ spot: step, walls: () => ({ support: 24800, resistance: 25000 }), gex: (i) => ({ net: i < 50 ? -100 : 50, callWall: 25000, putWall: 24800 }) })
  assert.ok(holds(walls, 'oiWalls', 'brokeResistance', 52, 5, 0.35) && !holds(walls, 'oiWalls', 'brokeResistance', 52, 5, 0.45))
  assert.ok(holds(walls, 'gexLevel', 'brokeCallWall', 52, 5, 0.35) && !holds(walls, 'gexLevel', 'brokeCallWall', 52, 5, 0.45))
  // The GEX regime: net -100 then +50 - past 0 by 50 / 150 = 33%.
  assert.ok(holds(walls, 'gexRegime', 'turnedLong', 52, 5, 30) && !holds(walls, 'gexRegime', 'turnedLong', 52, 5, 35))
  assert.ok(holds(walls, 'gexRegime', 'long', 52, 5, 30) && !holds(walls, 'gexRegime', 'long', 52, 5, 35) && holds(walls, 'gexRegime', 'short', 30, 5, 0))
  // VWAP crossed - and over it by the % now.
  const vw = fakeDay({ spot: step, vwap: () => 25000 })
  assert.ok(holds(vw, 'vwap', 'crossedAbove', 52, 5, 0.35) && !holds(vw, 'vwap', 'crossedAbove', 52, 5, 0.45))
  // The straddle: crossed its VWAP (104 v 100 = 4%), over the decay-only line (110 v 100 = 10%).
  const st = fakeDay({ straddle: (i) => ({ value: i < 50 ? 95 : 104, vwap: 100, decay: i < 50 ? 100 : 94.5 }) })
  assert.ok(holds(st, 'straddle', 'crossedAbove', 52, 5, 3.5) && !holds(st, 'straddle', 'crossedAbove', 52, 5, 4.5))
  assert.ok(holds(st, 'straddle', 'aboveDecay', 52, 5, 10) && !holds(st, 'straddle', 'aboveDecay', 52, 5, 10.5))     // 104 v 94.5 = 10.05%
  // The Initial Balance, the previous day's levels and value area - by % of the level.
  const lv = fakeDay({ spot: step, ib: { high: 25000, low: 24900, done: 40 }, prevVp: { date: '2026-10-02', poc: 25000, vah: 25000, val: 24900, hvn: null, lvn: null } })
  assert.ok(holds(lv, 'ib', 'aboveHigh', 52, 5, 0.35) && !holds(lv, 'ib', 'aboveHigh', 52, 5, 0.45))
  assert.ok(holds(lv, 'prevPoc', 'crossedAbove', 52, 5, 0.35) && !holds(lv, 'prevPoc', 'crossedAbove', 52, 5, 0.45))
  assert.ok(holds(lv, 'valueArea', 'aboveVah', 52, 5, 0.35) && !holds(lv, 'valueArea', 'aboveVah', 52, 5, 0.45))
  // Every new one starts at 0 - a rule saved before reads as it did - and the mirror keeps the number.
  for (const [id, value] of [['oiOpen', 'peCross'], ['cumNet', 'turnedPositive'], ['cumNet', 'brokeSupport'], ['oiWalls', 'brokeResistance'], ['gexRegime', 'long'], ['vwap', 'crossedAbove'], ['straddle', 'belowDecay'], ['ib', 'belowLow'], ['prevLvn', 'crossedBelow'], ['valueArea', 'belowVal']]) {
    assert.equal(cleanLine({ id, value }).param, 0, `${id} ${value}`)
  }
  assert.deepEqual(mirrorLines([cleanLine({ id: 'oiOpen', value: 'peCross', param: 10 })]).map((l) => [l.value, l.param]), [['ceCross', 10]])
  assert.match(lineText({ id: 'cumNet', value: 'turnedNegative', param: 20, windowMin: 10 }), /Turned \+ve → −ve by ≥ 20% \(last 10 min\)$/)
})

test('cumulative Δ divergence: price moved >= A % over the look-back but the line followed by less than B % of its range', () => {
  // Spot 25,000 until 30, then down to 24,900 by 60 (-0.4%) and back up to 25,100 by 100 (+0.8% from 60).
  const spot = (i) => (i < 30 ? 25000 : i < 60 ? 25000 - (i - 30) * (100 / 30) : i < 100 ? 24900 + (i - 60) * 5 : 25100)
  // The PE line (moves WITH price when OI confirms): -100 .. +100 early (its range 200), then as given from 30.
  const day = (pe) => fakeDay({ spot, peCum: (i) => (i < 10 ? -100 + i * 20 : i < 30 ? 100 : pe(i)), ceCum: (i) => (i < 10 ? -100 + i * 20 : i < 30 ? 100 : 100 + (100 - pe(i))) })
  const bull = (d, i, w, a, b) => holds(d, 'cumPe', 'divBull', i, w, a, b)
  const holds = (d, id, value, i, w, a, b) => cond(id).test(d, i, value, w, a, b)
  // PE held at 100 while price fell 0.4% over 30 minutes (30 -> 60): bullish divergence.
  const held = day(() => 100)
  assert.ok(bull(held, 60, 30, 0.3, 10))
  assert.ok(!bull(held, 60, 30, 0.5, 10))                 // price fell only 0.4%: not by 0.5%
  assert.ok(!bull(held, 25, 20, 0.3, 10))                 // price did not fall
  // PE fell with price - 60 of its range 200 = 30% - it followed: no divergence at 10%, one at 40%.
  const followed = day((i) => (i <= 60 ? 100 - (i - 30) * 2 : 40))
  assert.ok(!bull(followed, 60, 30, 0.3, 10) && bull(followed, 60, 30, 0.3, 40))
  // PE fell a little (10 of 200 = 5%) - "only some % decreased, not much": divergence at 10%.
  assert.ok(bull(day((i) => (i <= 60 ? 100 - (i - 30) / 3 : 90)), 60, 30, 0.3, 10))
  // PE rose while price fell (put writing into the fall): a divergence too.
  assert.ok(bull(day((i) => (i <= 60 ? 100 + (i - 30) : 130)), 60, 30, 0.3, 10))
  // Bearish: price rose 0.8% (60 -> 100) with PE held - and PE rising with it (confirming) is none.
  assert.ok(holds(held, 'cumPe', 'divBear', 100, 40, 0.5, 10))
  assert.ok(!holds(day((i) => (i <= 60 ? 100 : i < 100 ? 100 + (i - 60) * 3 : 220)), 'cumPe', 'divBear', 100, 40, 0.5, 10))
  // CE moves AGAINST price when OI confirms (calls written into a fall): CE rising with the fall is no divergence,
  // CE held is one.
  assert.ok(!holds(followed, 'cumCe', 'divBull', 60, 30, 0.3, 10))      // CE rose 60 while price fell
  assert.ok(holds(held, 'cumCe', 'divBull', 60, 30, 0.3, 10))
  // Net (CE - PE) is read like CE.
  const net = fakeDay({ spot, netCum: (i) => (i < 10 ? -100 + i * 20 : 100) })
  assert.ok(holds(net, 'cumNet', 'divBull', 60, 30, 0.3, 10))
  // In a rule: the page's look-back in minutes, both numbers kept, the mirror the bearish one with the same numbers.
  const line = cleanLine({ id: 'cumPe', value: 'divBull', windowMin: 30, param: 0.3, param2: 10 })
  assert.deepEqual(line, { id: 'cumPe', value: 'divBull', join: 'and', param: 0.3, param2: 10, windowMin: 30 })
  assert.deepEqual(cleanLine({ id: 'cumPe', value: 'divBull' }), { id: 'cumPe', value: 'divBull', join: 'and', param: 0.2, param2: 10, windowMin: DEFAULT_WINDOW })
  assert.equal(cleanLine({ id: 'cumPe', value: 'divBull', param2: 500 }).param2, 100)
  assert.deepEqual(mirrorLines([line]).map((l) => [l.value, l.param, l.param2, l.windowMin]), [['divBear', 0.3, 10, 30]])
  assert.match(lineText(line), /^PE cumulative Δ: Bullish divergence: price fell, the line did not follow price ≥ 0\.3%, followed < 10% of range \(last 30 min\)$/)
  const signals = ruleSignals(held, lines([line], 'buyCE'))
  assert.equal(signals[0].side, 'rule')
  assert.ok(signals[0].i > 30 && signals[0].i <= 60)
})

test('logic typed in the box redraws the builder: every condition once, AND before OR, brackets as written; what cannot be read says why', () => {
  const L = (value) => ({ line: { id: 'vwap', value, join: 'and', param: 0 } })
  const five = { op: 'or', not: false, items: [L('above'), L('below'), L('crossedAbove'), L('crossedBelow'), L('nearAbove')].map((x, k) => (k === 4 ? { line: { id: 'prevPoc', value: 'above', join: 'and', param: 0 } } : x)) }
  const values = (t) => ruleFromTree(t).lines.map((l) => `${l.id}:${l.value}`)
  const apply = (text) => treeFromLogic(five, text)
  // The user's example: (1 AND 2) OR (3 AND (4 AND 5)).
  const a = apply('(1 AND 2) OR (3 AND (4 AND 5))')
  assert.equal(a.ok, true)
  assert.equal(ruleFromTree(a.tree).logic, '(1 AND 2) OR (3 AND 4 AND 5)')     // the same rule (4 AND 5 inside an AND)
  assert.deepEqual(values(a.tree), values(five))                              // every condition kept as it was
  assert.equal(a.tree.items[1].group.items.length, 3)
  // Words in any case, & |.
  assert.equal(ruleFromTree(apply('(1 and 2) | (3 & 4 & 5)').tree).logic, '(1 AND 2) OR (3 AND 4 AND 5)')
  assert.equal(ruleFromTree(apply('1 OR (2 AND 3) OR 4 OR 5').tree).logic, '1 OR (2 AND 3) OR 4 OR 5')
  // AND and OR side by side with no brackets: not read either way on its own - the two readings are offered (asked
  // about: "1 OR 2 OR (3 AND 4) is not the same as 1 OR 2 OR 3 AND (4)").
  const user = treeFromLogic({ op: 'or', not: false, items: [L('above'), L('below'), L('crossedAbove'), L('crossedBelow')] }, '1 OR 2 OR 3 and (4)')
  assert.equal(user.ok, false)
  assert.match(user.error, /AND and OR side by side - which goes first/)
  assert.deepEqual(user.choices, ['(1 OR 2 OR 3) AND 4', '1 OR 2 OR (3 AND 4)'])
  for (const c of user.choices) assert.equal(ruleFromTree(treeFromLogic({ op: 'or', not: false, items: [L('above'), L('below'), L('crossedAbove'), L('crossedBelow')] }, c).tree).logic, c)
  assert.deepEqual(apply('1 and 2 | 3 & 4 & 5').choices, ['1 AND (2 OR 3) AND 4 AND 5', '(1 AND 2) OR (3 AND 4 AND 5)'])
  assert.deepEqual(apply('1 OR 2 AND 3 OR 4 OR 5').choices, ['(1 OR 2) AND (3 OR 4 OR 5)', '1 OR (2 AND 3) OR 4 OR 5'])
  assert.deepEqual(apply('NOT 1 OR 2 AND 3 OR 4 OR 5').choices, [])                    // not a plain line of numbers: brackets asked for
  assert.match(apply('(1 OR 2) AND 3 OR 4 OR 5').error, /side by side/)                 // mixed at the top level, even with brackets inside
  assert.equal(mixedLogicReadings('(1 OR 2 OR 3) AND 4'), null)                         // every bracket level one kind: fine
  assert.equal(mixedLogicReadings('1 OR 2 OR (3 AND (4 OR 5))'), null)
  // NOT and deeper brackets.
  assert.equal(ruleFromTree(apply('NOT (1 OR 2) AND (3 OR (4 AND 5))').tree).logic, 'NOT (1 OR 2) AND (3 OR (4 AND 5))')
  // Numbered again in the order written: "3 OR ..." makes the old 3 condition 1.
  const moved = apply('3 OR (1 AND 2) OR 4 OR 5')
  assert.equal(ruleFromTree(moved.tree).logic, '1 OR (2 AND 3) OR 4 OR 5')
  assert.deepEqual(values(moved.tree), ['vwap:crossedAbove', 'vwap:above', 'vwap:below', 'vwap:crossedBelow', 'prevPoc:above'])
  // Through the rule as the page keeps it.
  assert.equal(normalizeRule({ tree: a.tree, action: 'buyCE', mirror: true }).logic, '(1 AND 2) OR (3 AND 4 AND 5)')
  // Nothing dropped, nothing copied, nothing made up.
  assert.match(apply('(1 AND 2) OR 3').error, /conditions 4, 5 are not in it/)
  assert.match(apply('1 OR 2 OR 3 OR 4').error, /condition 5 is not in it/)
  assert.match(apply('1 OR 1 OR 2 OR 3 OR 4 OR 5').error, /1 written more than once/)
  assert.match(apply('1 OR 2 OR 3 OR 4 OR 6').error, /there is no line 6/)
  assert.match(apply('(1 AND 2 OR 3 OR 4 OR 5').error, /"\)" is missing/)
  assert.match(apply('1 AND AND 2 OR 3 OR 4 OR 5').error, /"AND" where a line number/)
  assert.match(apply('').error, /type the logic/)
  assert.match(apply('x'.repeat(MAX_LOGIC_LENGTH + 1)).error, /at most/)
  assert.match(treeFromLogic({ op: 'and', not: false, items: [] }, '1').error, /add a condition first/)
  // Brackets deeper than a group can go.
  assert.match(apply('1 AND (2 OR (3 AND (4 OR (5 AND (1 OR 2)))))').error, /more than once/)
  const two = { op: 'and', not: false, items: [L('above'), L('below')] }
  assert.equal(treeFromLogic(two, '((((1 AND 2))))').ok, true)                         // brackets that change nothing are fine
  // Groups 5 inside each other are allowed (as + Group allows); a 6th level is refused - not cut off.
  const eight = { op: 'and', not: false, items: Array.from({ length: 8 }, () => L('above')) }
  const fiveDeep = treeFromLogic(eight, '1 AND (2 OR (3 AND (4 OR (5 AND (6 OR 7))))) AND 8')
  assert.equal(fiveDeep.ok, true)
  assert.equal(ruleFromTree(fiveDeep.tree).lines.length, 8)                                         // nothing dropped
  assert.match(treeFromLogic(eight, '1 AND (2 OR (3 AND (4 OR (5 AND (6 OR (7 AND 8))))))').error, new RegExp(`at most ${MAX_GROUP_DEPTH} inside each other`))
})

test('a tapped AND / OR changes only that one: AND-ed conditions get their own box, the numbers never move, tapping back undoes it', () => {
  const L = (value) => ({ line: { id: 'vwap', value, join: 'and', param: 0 } })
  const four = { op: 'or', not: false, items: [L('above'), L('below'), L('crossedAbove'), L('crossedBelow')] }
  const logic = (t) => ruleFromTree(t).logic
  const values = (t) => ruleFromTree(t).lines.map((l) => l.value)
  // ANY of 1 - 4 (the user's rule): only 1 - 2 made AND.
  const a = setConnectorAt(four, [], 1, 'and')
  assert.equal(logic(a), '(1 AND 2) OR 3 OR 4')
  assert.deepEqual(values(a), values(four))                                  // the conditions themselves untouched, in order
  assert.equal(a.items[0].group.op, 'and')
  // Then the one between (1 AND 2) and 3: it joins that box.
  const b = setConnectorAt(a, [], 1, 'and')
  assert.equal(logic(b), '(1 AND 2 AND 3) OR 4')
  // Inside the box, 1 - 2 back to OR: 1 leaves it, the rest stays AND-ed.
  const c = setConnectorAt(b, [0], 1, 'or')
  assert.equal(logic(c), '1 OR (2 AND 3) OR 4')
  // And 2 - 3 back to OR: the box is gone - as at the start.
  assert.deepEqual(setConnectorAt(c, [1], 1, 'or'), four)
  // From ALL of them: one made OR cuts it in two.
  const all = { ...four, op: 'and' }
  assert.equal(logic(setConnectorAt(all, [], 2, 'or')), '(1 AND 2) OR (3 AND 4)')
  assert.equal(logic(setConnectorAt(all, [], 3, 'or')), '(1 AND 2 AND 3) OR 4')
  // A NOT stays on its group.
  assert.equal(logic(setConnectorAt({ ...all, not: true }, [], 1, 'or')), 'NOT (1 OR (2 AND 3 AND 4))')
  // Two items: just the group's op.
  assert.deepEqual(setConnectorAt({ op: 'or', not: false, items: [L('above'), L('below')] }, [], 1, 'and'), { op: 'and', not: false, items: [L('above'), L('below')] })
  // Nothing to change / out of range: the same tree.
  assert.equal(setConnectorAt(four, [], 1, 'or'), four)
  assert.equal(setConnectorAt(four, [], 0, 'and'), four)
  assert.equal(setConnectorAt(four, [], 4, 'and'), four)
  // At the deepest level a group can have, a change that would need another box is not made.
  let deep = four
  for (let k = 0; k < MAX_GROUP_DEPTH; k++) deep = { op: k % 2 ? 'or' : 'and', not: false, items: [L('above'), { group: deep }] }
  const path = Array.from({ length: MAX_GROUP_DEPTH }, () => 1)
  assert.equal(setConnectorAt(deep, path, 1, 'and'), deep)
  // The rule the engine reads has the same brackets.
  const r = normalizeRule({ tree: a, action: 'buyCE', mirror: false })
  assert.equal(r.logic, '(1 AND 2) OR 3 OR 4')
})

test('the builder\'s tree: groups (Match ALL / ANY, NOT) of conditions and groups - the lines and the logic worked out from it', () => {
  const c = (id, value, more = {}) => ({ line: { id, value, ...more } })
  const all = (...items) => ({ group: { op: 'and', not: false, items } })
  const any = (...items) => ({ group: { op: 'or', not: false, items } })
  // (1 AND 2) OR (3 AND (4 AND 5)): ANY of [ALL of 1, 2 - ALL of 3, ALL of 4, 5].
  const tree = any(all(c('oiOpen', 'peAhead'), c('vwap', 'above')), all(c('prevLvn', 'crossedAbove'), all(c('gexRegime', 'short'), c('straddle', 'aboveVwap')))).group
  const r = ruleFromTree(tree)
  assert.equal(r.logic, '(1 AND 2) OR (3 AND (4 AND 5))')
  assert.deepEqual(r.lines.map((l) => l.id), ['oiOpen', 'vwap', 'prevLvn', 'gexRegime', 'straddle'])   // numbered in the tree's order
  // NOT on a group, a group of one (no brackets), empty groups left out.
  const t2 = all(any(c('vwap', 'above'), c('oiOpen', 'peAhead')), { group: { op: 'or', not: true, items: [c('gexRegime', 'short'), c('straddle', 'aboveVwap')] } },
    { group: { op: 'and', not: false, items: [] } }, any(c('ib', 'aboveHigh'))).group
  assert.equal(ruleFromTree(t2).logic, '(1 OR 2) AND NOT (3 OR 4) AND 5')
  assert.equal(ruleFromTree({ op: 'and', not: true, items: [c('vwap', 'above')] }).logic, 'NOT 1')
  assert.deepEqual(ruleFromTree({ op: 'or', items: [] }), { lines: [], logic: '' })
  // Made whole: unknown conditions dropped, ops held to and / or, no deeper than MAX_GROUP_DEPTH.
  const messy = cleanTree({ op: 'xor', items: [c('nope', 'x'), c('vwap', 'above', { param: 99 }), { group: { op: 'or', items: [c('vwap', 'sideways')] } }, 'junk'] })
  assert.deepEqual(messy, { op: 'and', not: false, items: [{ line: { id: 'vwap', value: 'above', join: 'and', param: 5 } }, { group: { op: 'or', not: false, items: [] } }] })
  let deep = { op: 'and', items: [c('vwap', 'above')] }
  for (let k = 0; k < MAX_GROUP_DEPTH + 3; k++) deep = { op: 'and', items: [{ group: deep }] }
  let depth = 0
  for (let g = cleanTree(deep); g.items[0]?.group; g = g.items[0].group) depth++
  assert.equal(depth, MAX_GROUP_DEPTH)
  // A rule with a tree: the engine reads the lines + logic it gives - (1 OR 2) AND (3 OR 4), the lines' own AND / OR ignored.
  const d = fakeDay({
    price: (i) => flat(i >= 60 ? 25020 : 24980)(), vwap: () => 25000, oi: (i) => (i >= 80 ? { ce: 1e5, pe: 3e5 } : { ce: 3e5, pe: 1e5 }),
    hp: [{ i: 30, dir: 1 }], straddle: (i) => ({ value: i >= 100 ? 120 : 100, vwap: 110, decay: 90, forward: 25000 }),
  })
  const built = { tree: all(any(c('vwap', 'above'), c('hp', 'bullish', { windowMin: 5 })), any(c('oiOpen', 'peAhead'), c('straddle', 'aboveVwap'))).group, action: 'buyCE', mirror: false }
  assert.deepEqual(at(ruleSignals(d, built)), [[80, 'rule', 'buyCE']])
  assert.equal(normalizeRule(built).logic, '(1 OR 2) AND (3 OR 4)')
  // A rule saved before the builder: its tree from the lines' AND / OR, or from the typed logic.
  const L = (id, value, join = 'and') => ({ id, value, join })
  const fromJoins = treeFromRule({ lines: [L('vwap', 'above'), L('oiOpen', 'peAhead'), L('hp', 'bullish', 'or'), L('straddle', 'aboveVwap')] })
  assert.equal(ruleFromTree(fromJoins).logic, '(1 AND 2) OR (3 AND 4)')
  const fromLogic = treeFromRule({ lines: [L('vwap', 'above'), L('oiOpen', 'peAhead'), L('hp', 'bullish'), L('straddle', 'aboveVwap')], logic: 'not (1 or 3) and 2' })
  assert.equal(ruleFromTree(fromLogic).logic, 'NOT (1 OR 2) AND 3')
  assert.deepEqual(ruleFromTree(fromLogic).lines.map((l) => l.id), ['vwap', 'hp', 'oiOpen'])
  // The same rule either way: the saved lines + logic, and its tree, signal alike.
  const saved = lines([L('vwap', 'above'), L('hp', 'bullish'), L('oiOpen', 'peAhead'), L('straddle', 'aboveVwap')], 'buyCE', { logic: '(1 or 2) and (3 or 4)' })
  assert.deepEqual(at(ruleSignals(d, saved)), at(ruleSignals(d, { tree: normalizeRule(saved).tree, action: 'buyCE' })))
  // The default rule (a tree): PE ahead AND price over VWAP.
  assert.equal(normalizeRule(BACKTEST_DEFAULTS.rule).logic, '1 AND 2')
})

test('a line made whole: its number held to its range, the default when none, a window offered; the earlier { conditions } form read', () => {
  assert.deepEqual(cleanLine({ id: 'vwap', value: 'above', param: 99 }), { id: 'vwap', value: 'above', join: 'and', param: 5 })
  assert.deepEqual(cleanLine({ id: 'vwap', value: 'above' }), { id: 'vwap', value: 'above', join: 'and', param: 0 })
  assert.deepEqual(cleanLine({ id: 'gexLevel', value: 'nearPutWall', windowMin: 7, join: 'or' }), { id: 'gexLevel', value: 'nearPutWall', join: 'or', param: 0.15, windowMin: DEFAULT_WINDOW })
  assert.deepEqual(cleanLine({ id: 'valueArea', value: 'inside', param: 3, windowMin: 10 }), { id: 'valueArea', value: 'inside', join: 'and' })
  assert.equal(cleanLine({ id: 'vwap', value: 'sideways' }), null)
  assert.equal(cleanLine({ id: 'nope', value: 'above' }), null)
  const { tree: oldTree, ...old } = normalizeRule({ conditions: { vwap: 'crossedAbove', oiOpen: 'peAhead' }, windowMin: 10, action: 'sellPE', mirror: false })
  assert.deepEqual(old, { lines: [{ id: 'oiOpen', value: 'peAhead', join: 'and', param: 0 }, { id: 'vwap', value: 'crossedAbove', join: 'and', param: 0, windowMin: 10 }], action: 'sellPE', mirror: false, logic: '' })
  assert.deepEqual(oldTree.items.map((it) => it.line.id), ['oiOpen', 'vwap'])   // its tree: ALL of the two
  assert.deepEqual(normalizeRule(null), normalizeRule(BACKTEST_DEFAULTS.rule))
  assert.equal(normalizeRule({ lines: [], action: 'buyPE' }).lines.length, 0)       // all cleared: stays cleared
  assert.match(lineText({ id: 'gexLevel', value: 'nearCallWall', param: 0.2, windowMin: 15 }), /^GEX walls: Near the call wall \(resistance\) within 0.2% \(last 15 min\)$/)
  // Every option with a number has a default inside its range.
  for (const c of RULE_CONDITIONS) for (const o of c.options) if (o.param) assert.ok(o.param.default >= o.param.min && o.param.default <= o.param.max, `${c.id}.${o.value}`)
})

test('a day\'s trades: entries 09:30 - 14:45, one at a time (rule and mirror together), a cooldown, at most N a day', () => {
  // Price crossing VWAP back and forth every 20 minutes: the rule (above) and its mirror (below) take turns.
  const price = (i) => flat(Math.floor(i / 20) % 2 ? 25020 : 24980)()
  const legs = { ce: { 25000: () => ({ o: 100, h: 100, l: 100, c: 100 }) }, pe: { 25000: () => ({ o: 100, h: 100, l: 100, c: 100 }) } }
  const d = fakeDay({ price, vwap: () => 25000, legs })
  const { trades, signals } = simulateDay(d, { rule: rule({ vwap: 'above' }, 'buyCE', { mirror: true }), timeStopMin: 5, cooldownMin: 10, maxTradesPerDay: 3, lotSize: 65, charges: false })
  assert.equal(trades.length, 3)
  // The mirror (price under VWAP since 09:15) already holds when entries open: its trade is at 09:30; the rule's 09:35 signal
  // falls in the cooldown after it, then the mirror at 09:55 and the rule at 10:15.
  assert.deepEqual(trades.map((t) => [t.strategy, t.side, t.action]), [['mirror', 'PE', 'BUY'], ['mirror', 'PE', 'BUY'], ['rule', 'CE', 'BUY']])
  assert.equal(istMinute(trades[0].entryTime), 9 * 60 + 30)
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

test('a rule already true when entries open (09:30) signals then - a condition true from the open is not lost', () => {
  // Total PE OI above total CE OI all day: "PE above CE" holds from 09:15. It used to signal only at 09:15 (outside the
  // window) - never traded.
  const legs = { ce: { 25000: () => ({ o: 100, h: 100, l: 100, c: 100 }) }, pe: { 25000: () => ({ o: 100, h: 100, l: 100, c: 100 }) } }
  const d = fakeDay({ legs, tot: () => ({ ce: 4e7, pe: 4.4e7 }) })
  const peAbove = lines([{ id: 'totalOi', value: 'peAbove' }], 'buyCE')
  assert.deepEqual(at(ruleSignals(d, peAbove)), [[0, 'rule', 'buyCE']])                       // alone: once, when it became true
  assert.deepEqual(at(ruleSignals(d, peAbove, { openAt: 15 })), [[0, 'rule', 'buyCE'], [15, 'rule', 'buyCE']])
  const { trades, signals } = simulateDay(d, { rule: peAbove, lotSize: 65, timeStopMin: 5 })
  assert.equal(trades.length, 1)
  assert.equal(istMinute(trades[0].entryTime), 9 * 60 + 30)
  assert.match(signals[0].skipped, /outside/)
  // On a 5-minute timeframe: the first candle closing in the window (09:30 - 09:34, known at 09:34).
  const five = simulateDay(d, { rule: peAbove, lotSize: 65, timeStopMin: 5, timeframe: 5 })
  assert.equal(istMinute(five.trades[0].entryTime), 9 * 60 + 34)
  // A rule that only becomes true later is unchanged: once, when it does.
  const later = fakeDay({ legs, tot: (i) => ({ ce: 4e7, pe: i >= 100 ? 4.4e7 : 3.6e7 }) })
  assert.deepEqual(simulateDay(later, { rule: peAbove, lotSize: 65, timeStopMin: 5 }).trades.map((t) => istMinute(t.entryTime)), [9 * 60 + 15 + 100])
})

test('on the options\' expiry day the Expiry day setting overrides the rule\'s buy / sell - the direction kept; other days as the rule', () => {
  // Spot under VWAP until 60 (bearish - the mirror), over it 60 - 119 (bullish - the rule), under it again from 120.
  const legs = { ce: { 25000: flat(100) }, pe: { 25000: flat(100) } }
  const day = (isExpiry) => ({ ...fakeDay({ legs, spot: (i) => (i >= 60 && i < 120 ? 25000 : 24980) }), isExpiry })
  const base = { lotSize: 65, timeStopMin: 5, maxTradesPerDay: 5, cooldownMin: 0 }
  const trades = (d, rule, expiryDay) => simulateDay(d, { ...base, rule, expiryDay }).trades
  const what = (list) => list.map((t) => [t.strategy, t.action, t.side, t.overridden])
  const buy = lines([{ id: 'vwap', value: 'above' }], 'buyCE', { mirror: true })
  const asRule = trades(day(false), buy, 'rule')
  assert.deepEqual(what(asRule), [['mirror', 'BUY', 'PE', false], ['rule', 'BUY', 'CE', false], ['mirror', 'BUY', 'PE', false]])
  // Not an expiry day: the setting changes nothing.
  assert.deepEqual(trades(day(false), buy, 'sell'), asRule)
  // The expiry day, "As the rule": the same trades, marked as the expiry day's.
  const onExpiry = trades(day(true), buy, 'rule')
  assert.deepEqual(what(onExpiry), what(asRule))
  assert.ok(onExpiry.every((t) => t.expiryDay))
  // The expiry day, "Sell options": every signal SELLS - bullish sells the put, bearish the call - at the same minutes.
  const sold = trades(day(true), buy, 'sell')
  assert.deepEqual(what(sold), [['mirror', 'SELL', 'CE', true], ['rule', 'SELL', 'PE', true], ['mirror', 'SELL', 'CE', true]])
  assert.deepEqual(sold.map((t) => t.entryTime), asRule.map((t) => t.entryTime))
  assert.match(sold[1].why, /^Expiry day - selling instead · Buy CE: /)
  assert.deepEqual(sold.map((t) => t.dir), asRule.map((t) => t.dir))
  // A SELL rule with "Buy options" on the expiry day buys: bullish the call, bearish the put; "Sell options" leaves it.
  const sell = lines([{ id: 'vwap', value: 'above' }], 'sellPE', { mirror: true })
  assert.deepEqual(what(trades(day(true), sell, 'buy')), [['mirror', 'BUY', 'PE', true], ['rule', 'BUY', 'CE', true], ['mirror', 'BUY', 'PE', true]])
  assert.deepEqual(what(trades(day(true), sell, 'sell')), [['mirror', 'SELL', 'CE', false], ['rule', 'SELL', 'PE', false], ['mirror', 'SELL', 'CE', false]])
  // An unknown choice is "as the rule".
  assert.deepEqual(what(trades(day(true), buy, 'maybe')), what(asRule))
  // The CSV says which trades were the expiry day's and overridden.
  const csv = tradesCsv(sold).split('\n')
  assert.match(csv[0], /,net,expiry day,why$/)
  assert.match(csv[1], /,yes - overridden,/)
  // The prepared day knows its expiry: the run's optionExpiry (the options loaded) - before the open.
  const { run } = syntheticDay()
  assert.deepEqual([prepareDay({ ...run, optionExpiry: '2026-10-05' }).isExpiry, prepareDay({ ...run, optionExpiry: '2026-10-05' }).expiry], [true, '2026-10-05'])
  assert.equal(prepareDay({ ...run, optionExpiry: '2026-10-06' }).isExpiry, false)
  assert.deepEqual([prepareDay({ ...run, optionExpiry: null }).isExpiry, prepareDay({ ...run, optionExpiry: null }).expiry], [false, null])
})

test('P&L is net of the charges: STT 0.15% of the sell side\'s premium and ₹20 on each order (buy and sell) by default; set on the page; off = gross', () => {
  // A bought call: in at 100, out at the 120 target - 2 lots of 65. Gross 20 x 130 = 2,600.
  const legs = { ce: { 25000: (i) => (i < 20 ? flat(100)() : { o: 100, h: 125, l: 100, c: 120 }) }, pe: { 25000: flat(100) } }
  const d = fakeDay({ legs, spot: (i) => (i < 15 ? 24980 : 25000), vwap: () => 24990 })
  const buy = lines([{ id: 'vwap', value: 'crossedAbove' }], 'buyCE')
  const run = (more) => simulateDay(d, { rule: buy, lotSize: 65, lots: 2, slPct: 0, targetPct: 20, maxTradesPerDay: 1, ...more }).trades[0]
  const t = run({})
  assert.equal(t.action, 'BUY')
  assert.equal(t.gross, 2600)
  // STT on the sell leg - the exit at 120: 0.15% x 120 x 130 = 23.40; brokerage 2 x 20; nothing else.
  assert.ok(Math.abs(t.charges - (0.0015 * 120 * 130 + 40)) < 1e-9)
  assert.ok(Math.abs(t.net - (2600 - 63.4)) < 1e-9)
  // Set on the page: other rates; off: the gross.
  const set = run({ sttPct: 0.1, brokeragePerOrder: 10, otherPerTrade: 7 })
  assert.ok(Math.abs(set.charges - (0.001 * 120 * 130 + 20 + 7)) < 1e-9)
  assert.equal(run({ charges: false }).net, 2600)
  assert.equal(run({ charges: false }).charges, 0)
  // A SOLD option pays its STT on the entry (its sell leg).
  const sold = simulateDay(d, { rule: lines([{ id: 'vwap', value: 'crossedAbove' }], 'sellPE'), lotSize: 65, lots: 1, slPct: 0, targetPct: 0, timeStopMin: 2, maxTradesPerDay: 1 }).trades[0]
  assert.equal(sold.action, 'SELL')
  assert.ok(Math.abs(sold.charges - (0.0015 * sold.entry * 65 + 40)) < 1e-9)
  // The report adds them up: net = gross - charges.
  const s = summarize([t, set])
  assert.ok(Math.abs(s.net - (s.gross - s.charges)) < 1e-9)
})

test('the day\'s max loss / max profit: the premium where the day\'s net reaches it (charges in) - one more stop and target of the trade', () => {
  const buy = { side: 'CE', strike: 25000, action: 'BUY' }
  const sell = { side: 'CE', strike: 25000, action: 'SELL' }
  // Exact, charges included: out at the level, the day's net (the trades before + this one, net) is the limit.
  const rates = { sttPct: 0.15, brokeragePerOrder: 20, otherPerTrade: 0 }
  const net = (option, exit) => tradeCharges({ action: option.action, premium: 100, current: exit, lots: 1, lotSize: 65 }, rates).net
  for (const option of [buy, sell]) for (const realized of [0, -300, 250]) for (const amount of [-500, 1000]) {
    const level = dayLevel(option, 100, amount, { realized, qty: 65, stt: 0.15, flat: 40 })
    assert.ok(Math.abs(realized + net(option, level) - amount) < 1e-6, `${option.action} ${realized} ${amount}`)
  }
  // No charges: plain points - ₹650 on 65 is 10 points; a sold option's loss is above its entry.
  assert.equal(dayLevel(buy, 100, -650, { qty: 65 }), 90)
  assert.equal(dayLevel(sell, 100, -650, { qty: 65 }), 110)
  const at = (bars) => fakeDay({ n: 20, legs: { ce: { 25000: (i) => bars[i] ?? { o: 100, h: 100, l: 100, c: 100 } } } })
  const day = { maxLoss: 650, maxProfit: 1300, qty: 65 }     // -10 / +20 points
  const dip = at({ 3: { o: 100, h: 101, l: 85, c: 88 } })
  const pop = at({ 3: { o: 100, h: 125, l: 99, c: 120 } })
  const what = (tr) => [tr.exit, tr.exitReason, tr.exitIndex]
  // A stop: the day's max loss when it is the tighter, else the trade's own stop.
  assert.deepEqual(what(simulateTrade(dip, 0, buy, { slPct: 20, targetPct: 0, day })), [90, 'Day max loss', 3])
  assert.deepEqual(what(simulateTrade(dip, 0, buy, { slPct: 5, targetPct: 0, day })), [95, 'Stop', 3])
  // A target: the day's max profit when it is the nearer, else the trade's own target.
  assert.deepEqual(what(simulateTrade(pop, 0, buy, { slPct: 0, targetPct: 0, day })), [120, 'Day max profit', 3])
  assert.deepEqual(what(simulateTrade(pop, 0, buy, { slPct: 0, targetPct: 10, day })), [110, 'Target', 3])
  // A bar opening through it fills at its open.
  assert.deepEqual(what(simulateTrade(at({ 3: { o: 80, h: 82, l: 78, c: 80 } }), 0, buy, { slPct: 0, targetPct: 0, day })), [80, 'Day max loss (opened through it)', 3])
  // The trades closed earlier in the day count: ₹390 already lost leaves 4 points.
  assert.deepEqual(what(simulateTrade(dip, 0, buy, { slPct: 0, targetPct: 0, day: { ...day, realized: -390 } })), [96, 'Day max loss', 3])
  // SOLD: the loss is above the entry, the profit below.
  assert.deepEqual(what(simulateTrade(at({ 3: { o: 100, h: 115, l: 99, c: 112 } }), 0, sell, { slPct: 0, targetPct: 0, day })), [110, 'Day max loss', 3])
  assert.deepEqual(what(simulateTrade(at({ 3: { o: 100, h: 101, l: 75, c: 78 } }), 0, sell, { slPct: 0, targetPct: 0, day })), [80, 'Day max profit', 3])
  // 0 = off.
  assert.equal(simulateTrade(dip, 0, buy, { slPct: 0, targetPct: 0, day: { maxLoss: 0, maxProfit: 0, qty: 65 } }).exitReason, 'Day end')
  assert.equal(simulateTrade(dip, 0, buy, { slPct: 0, targetPct: 0 }).exitReason, 'Day end')
})

test('the day\'s limits over a day: reached - the open trade out at it, no trade after it; 0 = off, the trades as before', () => {
  // Price crossing VWAP every 20 minutes (the rule and its mirror take turns); every premium sliding 0.2 a minute - each
  // trade loses 1 point (₹65 a lot of 65) in its 5 minutes.
  const p = (i) => 200 - 0.2 * i
  const fall = (i) => ({ o: p(i), h: p(i), l: p(i) - 0.2, c: p(i) - 0.2 })
  const price = (i) => flat(Math.floor(i / 20) % 2 ? 25020 : 24980)()
  const d = fakeDay({ price, vwap: () => 25000, legs: { ce: { 25000: fall }, pe: { 25000: fall } } })
  const base = { rule: lines([{ id: 'vwap', value: 'above' }], 'buyCE', { mirror: true }), lotSize: 65, timeStopMin: 5, cooldownMin: 10, maxTradesPerDay: 10 }
  const run = (more) => simulateDay(d, { ...base, ...more })
  const total = (r) => r.trades.reduce((a, t) => a + t.net, 0)
  // Off (the default, or 0): ten trades, nothing stops the day.
  const off = run({})
  assert.equal(off.trades.length, 10)
  assert.equal(off.dayLimit, null)
  assert.deepEqual(run({ maxDayLoss: 0, maxDayProfit: 0 }), off)
  assert.ok(off.trades.every((t) => t.exitReason === 'Time stop 5 min'))
  // Max loss ₹400, no charges: six trades of -₹65, the seventh out at the level - the day ends at exactly -₹400.
  const gross = run({ maxDayLoss: 400, charges: false })
  assert.equal(gross.trades.length, 7)
  assert.equal(gross.trades.at(-1).exitReason, 'Day max loss')
  assert.ok(Math.abs(total(gross) + 400) < 1e-6)
  assert.equal(gross.dayLimit, 'loss')
  const after = gross.signals.filter((x) => x.time > gross.trades.at(-1).exitTime && /^the day's max loss reached$/.test(x.skipped ?? ''))
  assert.ok(after.length > 0)
  assert.ok(!gross.signals.some((x) => x.time > gross.trades.at(-1).exitTime && x.taken))
  // With the charges (~₹124 a trade, ~₹58 of it charges): -₹450 is reached inside the fourth trade, at the level, net.
  const net = run({ maxDayLoss: 450 })
  assert.equal(net.trades.length, 4)
  assert.equal(net.trades.at(-1).exitReason, 'Day max loss')
  assert.ok(Math.abs(total(net) + 450) < 1e-6)
  // -₹400: after three (-₹371) there is no room left for a trade's own charges - the day ends there, no trade that can
  // only lose past the limit.
  const noRoom = run({ maxDayLoss: 400 })
  assert.equal(noRoom.trades.length, 3)
  assert.equal(noRoom.dayLimit, 'loss')
  assert.ok(total(noRoom) > -400)
  assert.ok(noRoom.signals.some((x) => /no room for this trade's charges/.test(x.skipped ?? '')))
  // A trade's own stop that leaves the day above its limit does not end the day.
  assert.equal(run({ maxDayLoss: 2000 }).trades.length, 10)
  // Max profit: premiums rising 0.2 a minute - ₹65 a trade; ₹150 is reached inside the third, at the level.
  const q = (i) => 100 + 0.2 * i
  const rise = (i) => ({ o: q(i), h: q(i) + 0.2, l: q(i), c: q(i) + 0.2 })
  const up = fakeDay({ price, vwap: () => 25000, legs: { ce: { 25000: rise }, pe: { 25000: rise } } })
  const won = simulateDay(up, { ...base, maxDayProfit: 150, charges: false })
  assert.equal(won.trades.length, 3)
  assert.equal(won.trades.at(-1).exitReason, 'Day max profit')
  assert.ok(Math.abs(total(won) - 150) < 1e-6)
  assert.equal(won.dayLimit, 'profit')
  assert.ok(won.signals.some((x) => /^the day's max profit reached$/.test(x.skipped ?? '')))
  // Both set: whichever comes first.
  assert.equal(simulateDay(up, { ...base, maxDayLoss: 100, maxDayProfit: 150, charges: false }).dayLimit, 'profit')
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
  assert.deepEqual(normalizeRule(BACKTEST_DEFAULTS.rule).lines.map((l) => [l.id, l.value, l.join]), [['oiOpen', 'peAhead', 'and'], ['vwap', 'above', 'and']])
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
      for (const key of ['oi', 'tot', 'walls', 'gex', 'straddle', 'vwap', 'ceCum', 'peCum', 'netCum', 'atm', 't', 'at']) assert.deepEqual(pv[key][k], fv[key][k], `${tf} min ${key} at ${k}`)
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
