// The Signal backtest's spot-candle INDICATORS (signalBacktest.js): RSI, the EMA crossover, price vs an EMA, the pivot
// points and the CPR of the previous session - the maths, each condition firing on its case and not without it (both
// ways), the mirror (RSI's level from the other end, a pivot on the other side), the timeframe's candles, the previous
// session's warm-up and NO LOOK-AHEAD (a day cut part way reads the same up to the cut).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { day as syntheticDay } from './synthetic-day.mjs'
import {
  RULE_CONDITIONS, cleanLine, emaCrossHolds, emaOver, emaPriceHolds, emaSeries, lineText, mirrorIsSame, mirrorLines, pivotLevels, premiumCandles, premiumEma, premiumRsi, prepareDay, previousDayBars,
  ruleSignals, rsiOver, rsiSeries, simulateDay, timeframeView,
} from '../src/signalBacktest.js'
import { backtestReport, dayOutcome, engineSettings } from '../src/signalBacktestJob.js'

const MIN = 60_000
const T915 = Date.parse('2026-10-05T09:15:00+05:30')
const PREV915 = Date.parse('2026-10-03T09:15:00+05:30')
const cond = (id) => RULE_CONDITIONS.find((c) => c.id === id)
const option = (id, value) => cond(id).options.find((o) => o.value === value)
// Condition `id` says `value` at candle i (window w; its numbers, else the option's defaults)?
const holds = (d, id, value, i, { w = 5, p, p2, p3 } = {}) => {
  const o = option(id, value)
  return cond(id).test(d, i, value, w, p ?? o.param?.default ?? 0, p2 ?? o.param2?.default, p3 ?? o.param3?.default)
}

// A prepared day built by hand: `n` minutes from 09:15, spot from `spot(i)` (a number = a flat bar).
function fakeDay({ n = 360, spot = () => 25000, prevDay = null, pivots = undefined } = {}) {
  const t = Array.from({ length: n }, (_, i) => T915 + i * MIN)
  const bar = (i) => (typeof spot(i) === 'number' ? { o: spot(i), h: spot(i), l: spot(i), c: spot(i) } : spot(i))
  const col = (k) => Array.from({ length: n }, (_, i) => bar(i)[k])
  const ohlc = { o: col('o'), h: col('h'), l: col('l'), c: col('c') }
  return {
    ok: true, date: '2026-10-05', underlying: 'NIFTY', step: 50, n, t, atm: ohlc.c.map((c) => Math.round(c / 50) * 50), spot: ohlc, price: ohlc,
    vwap: ohlc.c.map(() => NaN), spotVwap: ohlc.c.map(() => NaN), oi: t.map(() => ({ ce: 0, pe: 0 })), tot: t.map(() => ({ ce: 4e7, pe: 4e7 })),
    walls: t.map(() => ({})), gex: t.map(() => null), straddle: t.map(() => null), ceCum: t.map(() => NaN), peCum: t.map(() => NaN), netCum: t.map(() => NaN),
    breaks: [], hp: [], ib: null, prevVp: null, prevDay, pivots: pivots === undefined ? pivotLevels(prevDay) : pivots, ce: new Map(), pe: new Map(),
  }
}
// The previous session (Saturday 3 Oct here is just "a day before"): `n` minutes of closes `close(i)`.
const prevSession = (close, n = 375) => {
  const t = Array.from({ length: n }, (_, i) => PREV915 + i * MIN)
  const c = t.map((_, i) => close(i))
  return { date: '2026-10-03', high: Math.max(...c), low: Math.min(...c), close: c.at(-1), t, c }
}

test('EMA and RSI: started at the simple average of the first values, then smoothed (TradingView\'s ta.ema / ta.rsi)', () => {
  // EMA 3 of 1..5: the average of 1, 2, 3 = 2 at the third value, then alpha 0.5.
  assert.deepEqual([...emaOver([1, 2, 3, 4, 5], 3)].map((v) => (Number.isNaN(v) ? null : v)), [null, null, 2, 3, 4])
  // RSI 2 of 1, 2, 1, 2: changes +1, -1 -> average gain 0.5, loss 0.5 = 50; then +1: gain 0.75, loss 0.25 -> RS 3 = 75.
  const r = rsiOver([1, 2, 1, 2], 2)
  assert.ok(Number.isNaN(r[0]) && Number.isNaN(r[1]))
  assert.equal(r[2], 50)
  assert.equal(r[3], 75)
  assert.equal(rsiOver([1, 2, 3, 4, 5], 3)[4], 100)           // only gains
  assert.equal(rsiOver([5, 4, 3, 2, 1], 3)[4], 0)             // only losses
  assert.equal(rsiOver([3, 3, 3, 3, 3], 3)[4], 50)            // no change at all: neither side
  // A constant series' EMA is the constant.
  assert.ok([...emaOver(Array(30).fill(100), 9)].slice(8).every((v) => Math.abs(v - 100) < 1e-9))
})

test('the indicators run on the timeframe\'s spot candles, on from the previous session\'s, and read nothing after a candle', () => {
  const wave = (i) => 25000 + 60 * Math.sin(i / 17) + i * 0.3
  const d = fakeDay({ spot: wave })
  // 1-minute: EMA 20 from the 20th candle, RSI 14 from the 15th.
  const e = emaSeries(d, 20), r = rsiSeries(d, 14)
  assert.ok(Number.isNaN(e[18]) && Number.isFinite(e[19]))
  assert.ok(Number.isNaN(r[13]) && Number.isFinite(r[14]))
  // 5-minute candles: the series is over the candles' closes (each candle's last minute).
  const v5 = timeframeView(d, 5)
  const closes5 = Array.from({ length: v5.n }, (_, k) => d.spot.c[Math.min(d.n - 1, k * 5 + 4)])
  assert.deepEqual([...emaSeries(v5, 9)], [...emaOver(closes5, 9)])
  // No look-ahead: the same day cut at 11:45 has the same values up to the cut.
  const cut = fakeDay({ n: 151, spot: wave })
  for (const [a, b] of [[emaSeries(cut, 20), e], [rsiSeries(cut, 14), r], [emaSeries(timeframeView(cut, 5), 9), emaSeries(v5, 9)]]) {
    for (let k = 0; k < a.length - 1; k++) assert.ok(Object.is(a[k], b[k]) || Math.abs(a[k] - b[k]) < 1e-9, `at ${k}`)
  }
  // With the previous session loaded the indicators run on from it: defined from the day's first candle - and the
  // previous session's candles are bucketed on the same timeframe.
  const warmed = fakeDay({ spot: wave, prevDay: prevSession((i) => 24900 + (i % 40)) })
  assert.ok(Number.isFinite(emaSeries(warmed, 20)[0]) && Number.isFinite(rsiSeries(warmed, 14)[0]))
  const prev5 = Array.from({ length: 75 }, (_, k) => warmed.prevDay.c[k * 5 + 4])
  const expected = emaOver([...prev5, ...closes5], 9).subarray(75)
  assert.deepEqual([...emaSeries(timeframeView(warmed, 5), 9)], [...expected])
})

test('RSI: above / below the level, crossed it in the look-back - and its mirror reads the level from the other end', () => {
  // Falling for 60 minutes, then rising: RSI low, then crossing up through 50 and on over 60.
  const vee = (i) => (i < 60 ? 25300 - i * 5 : 25000 + (i - 60) * 5)
  const d = fakeDay({ spot: vee })
  const r = rsiSeries(d, 14)
  const up = r.findIndex((v, k) => k > 60 && v > 50)
  assert.ok(up > 60 && up < 75, `RSI crossed 50 at ${up}`)
  assert.ok(holds(d, 'rsi', 'below', 50) && !holds(d, 'rsi', 'above', 50))
  assert.ok(holds(d, 'rsi', 'crossedAbove', up) && holds(d, 'rsi', 'crossedAbove', up + 4))
  assert.ok(!holds(d, 'rsi', 'crossedAbove', up - 1) && !holds(d, 'rsi', 'crossedAbove', up + 5))       // before it; out of a 5-candle window
  assert.ok(holds(d, 'rsi', 'crossedAbove', up + 8, { w: 10 }))
  assert.ok(holds(d, 'rsi', 'above', 120) && !holds(d, 'rsi', 'below', 120))
  assert.ok(!holds(d, 'rsi', 'above', 120, { p: 99 }))                                                     // its level
  // A shorter period reacts sooner.
  assert.ok(rsiSeries(d, 5).findIndex((v, k) => k > 60 && v > 50) < up)
  // The mirror: above 60 <-> below 40, crossed above 30 <-> crossed below 70 - the period kept.
  assert.deepEqual(mirrorLines([cleanLine({ id: 'rsi', value: 'above', param: 60, param2: 9 })]).map((l) => [l.value, l.param, l.param2]), [['below', 40, 9]])
  assert.deepEqual(mirrorLines([cleanLine({ id: 'rsi', value: 'crossedAbove', param: 30, windowMin: 10 })]).map((l) => [l.value, l.param, l.windowMin]), [['crossedBelow', 70, 10]])
  assert.equal(mirrorIsSame([cleanLine({ id: 'rsi', value: 'above', param: 50 })]), false)
  assert.match(lineText(cleanLine({ id: 'rsi', value: 'above', param: 60, param2: 14 })), /^RSI \(spot candles\): Above the level level 60, period 14$/)
  // A rule on it signals where RSI crosses up - its reading in the signal's words.
  const sig = ruleSignals(d, { lines: [{ id: 'rsi', value: 'crossedAbove', param: 50, param2: 14 }], action: 'buyCE', mirror: false })
  assert.equal(sig[0].i, up)
  assert.match(sig[0].why, /RSI\(14\) 5\d\.\d/)
})

test('EMA crossover and price vs EMA: over / under, crossed in the look-back and still there, by ≥ % of the EMA', () => {
  const vee = (i) => (i < 60 ? 25300 - i * 5 : 25000 + (i - 60) * 5)
  const d = fakeDay({ spot: vee })
  const fast = emaSeries(d, 9), slow = emaSeries(d, 21)
  const cross = fast.findIndex((v, k) => k > 60 && v > slow[k])
  assert.ok(cross > 60 && cross < 90, `crossed at ${cross}`)
  assert.ok(holds(d, 'emaCross', 'fastBelow', 50) && !holds(d, 'emaCross', 'fastAbove', 50))
  assert.ok(holds(d, 'emaCross', 'crossedUp', cross) && !holds(d, 'emaCross', 'crossedUp', cross - 1) && !holds(d, 'emaCross', 'crossedUp', cross + 5))
  assert.ok(holds(d, 'emaCross', 'fastAbove', 200) && !holds(d, 'emaCross', 'crossedDown', 200, { w: 300 }))
  // By ≥ %: the gap now in % of the slow EMA - just after the cross it is tiny.
  const gapPct = ((fast[cross] - slow[cross]) / slow[cross]) * 100
  assert.ok(holds(d, 'emaCross', 'crossedUp', cross, { p: gapPct * 0.9 }) && !holds(d, 'emaCross', 'crossedUp', cross, { p: gapPct * 1.1 }))
  // Its own periods: 5 / 13 cross sooner than 9 / 21.
  const sooner = emaSeries(d, 5).findIndex((v, k) => k > 60 && v > emaSeries(d, 13)[k])
  assert.ok(sooner < cross && holds(d, 'emaCross', 'crossedUp', sooner, { p2: 5, p3: 13 }) && !holds(d, 'emaCross', 'crossedUp', sooner))
  // The bearish crossover on the mirror image of the day.
  const hat = fakeDay({ spot: (i) => 50000 - vee(i) })
  assert.ok(holds(hat, 'emaCross', 'crossedDown', cross) && !holds(hat, 'emaCross', 'crossedUp', cross))
  // Price vs EMA 20.
  const e20 = emaSeries(d, 20)
  const over = d.spot.c.findIndex((c, k) => k > 60 && c > e20[k])
  assert.ok(holds(d, 'emaPrice', 'crossedAbove', over) && !holds(d, 'emaPrice', 'crossedAbove', over - 1))
  assert.ok(holds(d, 'emaPrice', 'below', 50) && holds(d, 'emaPrice', 'above', 200) && !holds(d, 'emaPrice', 'below', 200))
  assert.ok(holds(d, 'emaPrice', 'above', 200, { p: 0.1 }) && !holds(d, 'emaPrice', 'above', 200, { p: 1 }))
  // The line: its periods kept and in its words; the mirror swaps the side, keeps the periods.
  const line = cleanLine({ id: 'emaCross', value: 'crossedUp', param2: 5, param3: 13, windowMin: 3 })
  assert.deepEqual([line.param, line.param2, line.param3], [0, 5, 13])
  assert.deepEqual(cleanLine({ id: 'emaCross', value: 'crossedUp', param2: 1, param3: 900 }).param2, 2)
  assert.deepEqual(cleanLine({ id: 'emaCross', value: 'crossedUp', param3: 900 }).param3, 200)
  assert.match(lineText(line), /^EMA crossover \(spot candles\): Fast crossed above the slow \(bullish crossover\), fast 5, slow 13 \(last 3 min\)$/)
  assert.deepEqual(mirrorLines([line]).map((l) => [l.value, l.param2, l.param3]), [['crossedDown', 5, 13]])
})

test('pivot points and the CPR from the previous session\'s high / low / close', () => {
  const x = pivotLevels({ date: '2026-10-03', high: 110, low: 90, close: 105 })
  const near = (a, b) => Math.abs(a - b) < 1e-9
  assert.ok(near(x.p, 305 / 3) && near(x.r1, 2 * x.p - 90) && near(x.s1, 2 * x.p - 110) && near(x.r2, x.p + 20) && near(x.s2, x.p - 20))
  assert.ok(near(x.r3, 110 + 2 * (x.p - 90)) && near(x.s3, 90 - 2 * (110 - x.p)))
  assert.ok(near(x.bc, 100) && near(x.tc, 2 * x.p - 100) && x.tc > x.bc && near(x.widthPct, ((x.tc - x.bc) / x.p) * 100))
  // A close under the middle puts 2P - BC under BC: TC is still the higher one.
  const y = pivotLevels({ high: 110, low: 90, close: 92 })
  assert.ok(y.tc >= y.bc && near(y.tc, 100))
  assert.equal(pivotLevels(null), null)
  assert.equal(pivotLevels({ high: 90, low: 110, close: 100 }), null)
  // From the previous-day profile's own bars: its session minutes only, of its own day, before the day run.
  const bar = (iso, h, l, c) => ({ time: iso, open: c, high: h, low: l, close: c, volume: 0 })
  const profile = {
    success: true, profileDate: '2026-10-02',
    bars: [
      bar('2026-10-02T03:44:00Z', 999, 1, 500),          // 09:14 IST - before the session
      bar('2026-10-02T03:45:00Z', 25100, 24990, 25050),  // 09:15
      bar('2026-10-02T06:00:00Z', 25210, 25000, 25200),  // 11:30
      bar('2026-10-02T09:59:00Z', 25160, 25080, 25120),  // 15:29
      bar('2026-10-02T10:00:00Z', 26000, 20000, 21000),  // 15:30 - after it
    ],
  }
  const prev = previousDayBars(profile, '2026-10-05')
  assert.deepEqual([prev.date, prev.high, prev.low, prev.close, prev.c.length], ['2026-10-02', 25210, 24990, 25120, 3])
  assert.equal(previousDayBars(profile, '2026-10-02'), null)           // not a day before
  assert.equal(previousDayBars({ success: false, bars: [] }, '2026-10-05'), null)
  // prepareDay keeps them: the day's pivots, and the indicators run on from that session.
  const { run } = syntheticDay()
  const day = prepareDay(run, { underlying: 'NIFTY', prevProfile: profile })
  assert.equal(day.prevDay.date, '2026-10-02')
  assert.ok(near(day.pivots.p, (25210 + 24990 + 25120) / 3))
  assert.equal(prepareDay(run, { underlying: 'NIFTY' }).pivots, null)
  // The spot's own VWAP is kept for the chart (none in the synthetic run) - the rule's VWAP is the futures' there.
  assert.equal(day.spotVwap.length, day.n)
})

test('the pivot conditions: price v a level (crossed, held, near) and the CPR - the mirror on the other side', () => {
  const prevDay = prevSession((i) => 25000 + (i < 200 ? i : 400 - i))     // high 25199, low ~24826, close 24826
  const piv = pivotLevels(prevDay)
  // Spot under R1 until 50, then over it.
  const d = fakeDay({ spot: (i) => (i < 50 ? piv.r1 - 20 : piv.r1 + 30), prevDay })
  assert.ok(holds(d, 'pivotR1', 'below', 40) && holds(d, 'pivotR1', 'above', 52) && !holds(d, 'pivotR1', 'above', 40))
  assert.ok(holds(d, 'pivotR1', 'crossedAbove', 52) && !holds(d, 'pivotR1', 'crossedAbove', 60))
  assert.ok(holds(d, 'pivotP', 'above', 52) && holds(d, 'pivotS1', 'above', 52) && !holds(d, 'pivotR2', 'above', 52))
  // Without the previous session no pivot holds.
  const none = fakeDay({ spot: (i) => (i < 50 ? 24000 : 26000), pivots: null })
  for (const id of ['pivotP', 'pivotR1', 'pivotS1', 'cpr']) for (const o of cond(id).options) assert.ok(!holds(none, id, o.value, 52), `${id} ${o.value}`)
  // The mirror: R1 crossed above <-> S1 crossed below (P stays P).
  assert.deepEqual(mirrorLines([cleanLine({ id: 'pivotR1', value: 'crossedAbove', param: 0.1 })]).map((l) => [l.id, l.value, l.param]), [['pivotS1', 'crossedBelow', 0.1]])
  assert.deepEqual(mirrorLines([cleanLine({ id: 'pivotP', value: 'above' })]).map((l) => [l.id, l.value]), [['pivotP', 'below']])
  assert.equal(mirrorIsSame([cleanLine({ id: 'pivotR1', value: 'near' })]), false)
  // CPR: under it, inside, over it; through TC in the look-back; narrow / wide by its width.
  const c = fakeDay({ spot: (i) => (i < 30 ? piv.bc - 10 : i < 60 ? (piv.bc + piv.tc) / 2 : piv.tc + 25), prevDay })
  assert.ok(holds(c, 'cpr', 'below', 20) && holds(c, 'cpr', 'inside', 40) && holds(c, 'cpr', 'above', 70) && !holds(c, 'cpr', 'inside', 70))
  assert.ok(holds(c, 'cpr', 'crossedAbove', 62) && !holds(c, 'cpr', 'crossedAbove', 80) && !holds(c, 'cpr', 'crossedBelow', 62))
  assert.ok(holds(c, 'cpr', 'narrow', 0, { p: piv.widthPct + 0.01 }) && !holds(c, 'cpr', 'narrow', 0, { p: piv.widthPct - 0.01 }))
  assert.ok(holds(c, 'cpr', 'wide', 0, { p: piv.widthPct - 0.01 }) && !holds(c, 'cpr', 'wide', 0, { p: piv.widthPct + 0.01 }))
  // A narrow CPR has no side: alone it has no mirror.
  assert.equal(mirrorIsSame([cleanLine({ id: 'cpr', value: 'narrow' })]), true)
})

test('the report says which days ran without the previous session (no pivots) when the rule reads them', () => {
  const rule = { tree: { op: 'and', not: false, items: [{ line: { id: 'pivotR1', value: 'above' } }] }, action: 'buyCE', mirror: false }
  const engine = engineSettings({ underlying: 'NIFTY', rule, timeframe: 1 })
  const prevDay = prevSession(() => 25000)
  const outcomes = [dayOutcome('2026-10-05', fakeDay({ prevDay }), engine), dayOutcome('2026-10-06', { ...fakeDay({ pivots: null }), date: '2026-10-06' }, engine)]
  assert.deepEqual(backtestReport(outcomes, engine).noPivots, ['2026-10-06'])
  // A rule that does not read them lists none; an outcome kept before the pivots (no `pivots` field) is not listed.
  const other = engineSettings({ underlying: 'NIFTY', rule: { ...rule, tree: { op: 'and', not: false, items: [{ line: { id: 'rsi', value: 'above' } }] } } })
  assert.deepEqual(backtestReport(outcomes, other).noPivots, [])
  const { pivots: _gone, ...old } = outcomes[1]
  assert.deepEqual(backtestReport([outcomes[0], old], engine).noPivots, [])
  // And a day trades on them: spot over R1 from the open - a signal when entries open.
  const legs = new Map([[25050, new Float64Array(360 * 4).fill(100)]])
  const d = { ...fakeDay({ spot: () => pivotLevels(prevDay).r1 + 50, prevDay }), ce: legs, pe: legs }
  d.atm = d.atm.map(() => 25050)
  const { trades } = simulateDay(d, { ...engine, charges: false })
  assert.equal(trades.length > 0, true)
})

// The options' legs for fakeDay: { [strike]: (i) => price | null } per side, a flat bar at the price, `vol(i)` its volume.
function withLegs(d, { ce = {}, pe = {}, vol = () => 100 } = {}) {
  const pack = (f) => { const a = new Float64Array(d.n * 4).fill(NaN); for (let i = 0; i < d.n; i++) { const p = f(i); if (p != null) a.fill(p, i * 4, i * 4 + 4) } return a }
  const vols = (f) => Float64Array.from({ length: d.n }, (_, i) => (f(i) != null ? vol(i) : 0))
  const side = (legs) => new Map(Object.entries(legs).map(([k, f]) => [Number(k), pack(f)]))
  const sideVol = (legs) => new Map(Object.entries(legs).map(([k, f]) => [Number(k), vols(f)]))
  return { ...d, ce: side(ce), pe: side(pe), ceVol: sideVol(ce), peVol: sideVol(pe) }
}

test('an option\'s premium on its own chart: its candles, its own VWAP from the open, NaN before its first bar', () => {
  // The 25000 CE from minute 3 (none before), 100 then +1 a minute; volume 100, but 300 from minute 10.
  const d = withLegs(fakeDay({ n: 30 }), { ce: { 25000: (i) => (i < 3 ? null : 100 + i) } , vol: (i) => (i >= 10 ? 300 : 100) })
  const one = premiumCandles(d, 'ce', 25000)
  assert.ok(Number.isNaN(one.c[2]) && one.c[3] === 103 && one.c[29] === 129)
  // VWAP at minute 4: (103 x 100 + 104 x 100) / 200 = 103.5; at 10: (sum 103..109 x 100 + 110 x 300) / 1000.
  assert.equal(one.vwap[4], 103.5)
  const sum = [103, 104, 105, 106, 107, 108, 109].reduce((a, x) => a + x * 100, 0) + 110 * 300
  assert.ok(Math.abs(one.vwap[10] - sum / 1000) < 1e-9)
  // 5-minute candles: OHLC of the minutes, volume summed; the VWAP at each candle's last minute.
  const v5 = premiumCandles(timeframeView(d, 5), 'ce', 25000)
  assert.deepEqual([v5.o[0], v5.h[0], v5.l[0], v5.c[0], v5.v[0]], [103, 104, 103, 104, 200])
  assert.deepEqual([v5.o[2], v5.c[2], v5.v[2]], [110, 114, 1500])
  assert.equal(v5.vwap[2], one.vwap[14])
  // A strike with no bars: nothing; a gap carries the last close.
  assert.ok(Number.isNaN(premiumCandles(d, 'pe', 25000).c[10]))
  const gap = withLegs(fakeDay({ n: 30 }), { ce: { 25000: (i) => (i >= 10 && i < 20 ? null : 100 + i) } })
  assert.equal(premiumCandles(gap, 'ce', 25000).c[15], 109)
  // EMA / RSI from its first bar on.
  assert.ok(Number.isNaN(premiumEma(d, 'ce', 25000, 3)[4]) && premiumEma(d, 'ce', 25000, 3)[5] === 104)
  assert.equal(premiumRsi(d, 'ce', 25000, 3)[6], 100)
})

test('the ATM CE / PE premium conditions: vs its VWAP, vs an EMA, an EMA crossover, RSI - the ATM strike\'s own chart, both sides', () => {
  // Spot at 25000 (ATM 25000). The CE falls to 80 by minute 40, then rises; the PE the other way.
  const ce = (i) => (i < 40 ? 120 - i : 80 + (i - 40) * 1.5)
  const pe = (i) => (i < 40 ? 80 + i : 120 - (i - 40) * 1.5)
  const d = withLegs(fakeDay({ n: 120 }), { ce: { 25000: ce }, pe: { 25000: pe } })
  const c = premiumCandles(d, 'ce', 25000)
  const over = c.c.findIndex((x, k) => k > 40 && x > c.vwap[k])
  assert.ok(over > 40 && over < 80, `CE over its VWAP at ${over}`)
  assert.ok(holds(d, 'cePremVwap', 'below', 30) && !holds(d, 'cePremVwap', 'above', 30))
  assert.ok(holds(d, 'cePremVwap', 'crossedAbove', over) && !holds(d, 'cePremVwap', 'crossedAbove', over - 1) && !holds(d, 'cePremVwap', 'crossedAbove', over + 5))
  assert.ok(holds(d, 'cePremVwap', 'above', 110) && holds(d, 'pePremVwap', 'below', 110))
  // By ≥ % of the VWAP.
  const pct = ((c.c[110] - c.vwap[110]) / c.vwap[110]) * 100
  assert.ok(holds(d, 'cePremVwap', 'above', 110, { p: pct - 0.5 }) && !holds(d, 'cePremVwap', 'above', 110, { p: pct + 0.5 }))
  // EMA crossover of the premium (5 / 13) and premium vs EMA 20.
  const f = premiumEma(d, 'ce', 25000, 5), sl = premiumEma(d, 'ce', 25000, 13)
  const cross = f.findIndex((x, k) => k > 40 && x > sl[k])
  assert.ok(holds(d, 'cePremEmaCross', 'crossedUp', cross, { p2: 5, p3: 13 }) && !holds(d, 'cePremEmaCross', 'crossedUp', cross - 1, { p2: 5, p3: 13 }))
  assert.ok(holds(d, 'pePremEmaCross', 'crossedDown', cross, { p2: 5, p3: 13 }))
  assert.ok(holds(d, 'cePremEma', 'above', 110) && !holds(d, 'cePremEma', 'below', 110) && holds(d, 'cePremEma', 'below', 35))
  // RSI of the premium.
  assert.ok(holds(d, 'cePremRsi', 'above', 110) && holds(d, 'pePremRsi', 'below', 110) && !holds(d, 'cePremRsi', 'below', 110))
  // Only the ATM strike's chart: spot moved to 25100 - the 25100 CE (none loaded) is read, not the 25000.
  const moved = { ...d, atm: d.atm.map((x, i) => (i >= 100 ? 25100 : x)) }
  assert.ok(!holds(moved, 'cePremVwap', 'above', 110) && holds(moved, 'cePremVwap', 'above', 90))
  // The mirror: the other side's same condition, its value and numbers kept.
  const line = cleanLine({ id: 'cePremEmaCross', value: 'crossedUp', param: 1, param2: 5, param3: 13, windowMin: 10 })
  assert.deepEqual(mirrorLines([line]).map((l) => [l.id, l.value, l.param, l.param2, l.param3, l.windowMin]), [['pePremEmaCross', 'crossedUp', 1, 5, 13, 10]])
  assert.deepEqual(mirrorLines([cleanLine({ id: 'pePremRsi', value: 'above', param: 60 })]).map((l) => [l.id, l.value, l.param]), [['cePremRsi', 'above', 60]])
  assert.equal(mirrorIsSame([line]), false)
  assert.match(lineText(cleanLine({ id: 'cePremVwap', value: 'crossedAbove', param: 2 })), /^ATM CE premium: vs its VWAP: Crossed above its VWAP by ≥ 2% \(last 5 min\)$/)
  // A rule on it: buy the call when the CE premium crosses over its VWAP; the mirror buys the put on the PE's.
  const sig = ruleSignals(d, { lines: [{ id: 'cePremVwap', value: 'crossedAbove', param: 0 }], action: 'buyCE', mirror: true })
  assert.deepEqual(sig.map((x) => [x.i, x.side]).filter(([, side]) => side === 'rule'), [[over, 'rule']])
  assert.match(sig.find((x) => x.side === 'rule').why, /25000 CE \d+\.\d · its VWAP \d+\.\d/)
  // No look-ahead: the day cut at minute 70 reads the same up to it.
  const cut = withLegs(fakeDay({ n: 71 }), { ce: { 25000: ce }, pe: { 25000: pe } })
  for (const key of ['c', 'vwap']) for (let k = 0; k <= 70; k++) assert.ok(Object.is(premiumCandles(cut, 'ce', 25000)[key][k], c[key][k]), `${key} ${k}`)
  for (let k = 0; k <= 70; k++) assert.ok(Object.is(premiumEma(cut, 'ce', 25000, 5)[k], f[k]))
})

test('a run\'s day keeps each strike\'s volume (the premium VWAP) from the OI Replay run', () => {
  const { run } = syntheticDay()
  const withVol = { ...run, cePoints: run.cePoints.map((p, k) => ({ ...p, volume: 50 + (k % 7) })) }
  const day = prepareDay(withVol, { underlying: 'NIFTY' })
  const strike = day.atm[100]
  const vols = day.ceVol.get(strike)
  assert.ok(vols.length === day.n && vols.every((v) => v >= 50))
  assert.ok(Number.isFinite(premiumCandles(day, 'ce', strike).vwap[100]))
  // Without volume (the synthetic PE): no VWAP - its VWAP conditions never hold.
  assert.ok(Number.isNaN(premiumCandles(day, 'pe', strike).vwap[100]))
  assert.equal(holds(day, 'pePremVwap', 'above', 100) || holds(day, 'pePremVwap', 'below', 100), false)
})

test('EMA at the candle\'s close: closed above / below, the close crossing, a candle crossing it, a whole candle clear of it', () => {
  // Candles by hand against an EMA at 100: [open, high, low, close].
  const make = (rows) => ({ o: rows.map((r) => r[0]), h: rows.map((r) => r[1]), l: rows.map((r) => r[2]), c: rows.map((r) => r[3]) })
  const e = Float64Array.from({ length: 6 }, () => 100)
  const bars = make([[95, 97, 94, 96], [96, 98, 95, 97], [98, 104, 97, 103], [103, 106, 102, 105], [105, 108, 101.5, 107], [107, 109, 99, 98]])
  //                 0 under          1 under          2 opened under, closed over   3 whole over  4 whole over   5 closed back under
  const at = (i, v, w = 5, p = 0) => emaPriceHolds(bars, e, i, v, w, p)
  assert.ok(at(2, 'above') && at(2, 'crossedAbove') && at(2, 'candleCrossUp') && !at(2, 'wholeAbove'))
  assert.ok(at(3, 'wholeAbove') && at(4, 'wholeAbove') && at(4, 'candleCrossUp'))         // the crossing candle 2 in the window, still over
  assert.ok(!at(4, 'candleCrossUp', 2))                                                   // not in a 2-candle window
  assert.ok(!at(5, 'candleCrossUp') && !at(5, 'above') && at(5, 'below'))                 // closed back under: no
  assert.ok(at(5, 'candleCrossDown') && at(5, 'crossedBelow'))                            // 5 opened over and closed under
  assert.ok(at(1, 'wholeBelow') && !at(2, 'wholeBelow'))
  // By ≥ %: the close 3% over now; a whole candle by its low (101.5 = 1.5%).
  assert.ok(at(2, 'candleCrossUp', 5, 3) && !at(2, 'candleCrossUp', 5, 3.5))
  assert.ok(at(4, 'wholeAbove', 5, 1.5) && !at(4, 'wholeAbove', 5, 1.6))
})

test('the EMA crossover at the candle\'s close: the crossover with the close beyond BOTH EMAs, a close beyond both', () => {
  const make = (c) => ({ o: c, h: c, l: c, c })
  const fast = Float64Array.from([98, 99, 101, 102, 103])
  const slow = Float64Array.from([100, 100, 100, 100.5, 101])
  //  the fast crosses the slow at 2; closes: 2 over both, 3 between them (under the fast), 4 over both
  const bars = make([97, 99, 102, 101, 104])
  const at = (i, v, w = 5, p = 0) => emaCrossHolds(bars, fast, slow, i, v, w, p)
  assert.ok(at(2, 'crossedUp') && at(2, 'crossedUpClose') && at(2, 'closeAboveBoth'))
  assert.ok(at(3, 'crossedUp') && !at(3, 'crossedUpClose') && !at(3, 'closeAboveBoth'))    // closed under the fast
  assert.ok(at(4, 'crossedUpClose') && !at(4, 'crossedUpClose', 2))                         // the cross out of a 2-candle window
  assert.ok(at(0, 'closeBelowBoth') && !at(0, 'crossedDownClose') && at(4, 'fastAbove'))
  // By ≥ %: a close beyond both by its % of the nearer EMA (104 over 103 = 0.97%).
  assert.ok(at(4, 'closeAboveBoth', 5, 0.9) && !at(4, 'closeAboveBoth', 5, 1))
  // The bearish mirror image.
  const neg = (a) => Float64Array.from(a, (x) => 200 - x)
  const down = make([...bars.c].map((x) => 200 - x))
  assert.ok(emaCrossHolds(down, neg(fast), neg(slow), 2, 'crossedDownClose', 5, 0) && !emaCrossHolds(down, neg(fast), neg(slow), 3, 'crossedDownClose', 5, 0))
  assert.ok(emaCrossHolds(down, neg(fast), neg(slow), 4, 'closeBelowBoth', 5, 0))
})

test('the candle-close EMA options on the conditions - spot\'s and the ATM premium\'s - and their mirrors', () => {
  // Candles opening at the previous close: falling 5 a minute for 60 minutes, then rising 5.
  const vee = (i) => (i < 60 ? 25300 - i * 5 : 25000 + (i - 60) * 5)
  const bar = (f) => (i) => { const c = f(i), o = i ? f(i - 1) : c; return { o, h: Math.max(o, c) + 1, l: Math.min(o, c) - 1, c } }
  const d = fakeDay({ spot: bar(vee) })
  const e = emaSeries(d, 20)
  const up = d.spot.c.findIndex((c, k) => k > 60 && c > e[k])
  assert.ok(d.spot.o[up] < e[up], 'the candle that crossed opened under the EMA')
  // Every candle that opened under the EMA (its value at that candle's close) and closed over it - the EMA rising too, the
  // next candle can be one as well: the last of them in the window, and the close over the EMA now.
  const crossing = (k) => d.spot.o[k] < e[k] && d.spot.c[k] > e[k]
  let last = up
  while (crossing(last + 1)) last++
  assert.ok(holds(d, 'emaPrice', 'candleCrossUp', up) && !holds(d, 'emaPrice', 'candleCrossUp', up - 1))
  assert.ok(holds(d, 'emaPrice', 'candleCrossUp', last + 4) && !holds(d, 'emaPrice', 'candleCrossUp', last + 5))
  const whole = d.spot.l.findIndex((l, k) => k > 60 && l > e[k])
  assert.ok(whole >= up && holds(d, 'emaPrice', 'wholeAbove', whole) && !holds(d, 'emaPrice', 'wholeAbove', whole - 1) && holds(d, 'emaPrice', 'wholeBelow', 40))
  // The bearish side on the mirror image of the day.
  const hat = fakeDay({ spot: bar((i) => 50000 - vee(i)) })
  assert.ok(holds(hat, 'emaPrice', 'candleCrossDown', up) && !holds(hat, 'emaPrice', 'candleCrossUp', up))
  // The crossover with the close beyond both, and a close beyond both.
  const fast = emaSeries(d, 9), slow = emaSeries(d, 21)
  const cross = fast.findIndex((x, k) => k > 60 && x > slow[k])
  assert.equal(holds(d, 'emaCross', 'crossedUpClose', cross), d.spot.c[cross] > Math.max(fast[cross], slow[cross]))
  assert.ok(holds(d, 'emaCross', 'closeAboveBoth', 200) && holds(d, 'emaCross', 'closeBelowBoth', 50) && holds(hat, 'emaCross', 'closeBelowBoth', 200))
  // Mirrors: spot's to the other side; a premium's to the other option's same reading.
  assert.deepEqual(mirrorLines([cleanLine({ id: 'emaPrice', value: 'candleCrossUp', param: 0.1, param2: 50 })]).map((l) => [l.id, l.value, l.param, l.param2]), [['emaPrice', 'candleCrossDown', 0.1, 50]])
  assert.deepEqual(mirrorLines([cleanLine({ id: 'emaCross', value: 'crossedUpClose', param2: 9, param3: 21 })]).map((l) => [l.value]), [['crossedDownClose']])
  assert.deepEqual(mirrorLines([cleanLine({ id: 'cePremEma', value: 'wholeAbove', param2: 20 })]).map((l) => [l.id, l.value]), [['pePremEma', 'wholeAbove']])
  assert.deepEqual(mirrorLines([cleanLine({ id: 'cePremEmaCross', value: 'crossedUpClose' })]).map((l) => [l.id, l.value]), [['pePremEmaCross', 'crossedUpClose']])
  assert.match(lineText(cleanLine({ id: 'emaPrice', value: 'candleCrossUp', param2: 50, windowMin: 3 })), /^Price vs EMA \(spot candles\): A candle crossed up through the EMA \(opened below, closed above\), EMA 50 \(last 3 min\)$/)
  // The ATM premium: a CE that falls then rises, on candles opening at the previous close.
  const prem = (i) => (i < 40 ? 120 - i : 80 + (i - 40) * 1.5)
  const pd = withLegs(fakeDay({ n: 120 }), { ce: { 25000: prem } })
  // withLegs makes flat bars: give the CE its open at the previous close.
  const packed = pd.ce.get(25000)
  for (let i = 1; i < pd.n; i++) { const o = prem(i - 1), c = prem(i); packed[i * 4] = o; packed[i * 4 + 1] = Math.max(o, c); packed[i * 4 + 2] = Math.min(o, c) }
  const pe20 = premiumEma(pd, 'ce', 25000, 20), pc = premiumCandles(pd, 'ce', 25000)
  const pUp = pc.c.findIndex((c, k) => k > 40 && c > pe20[k])
  assert.ok(holds(pd, 'cePremEma', 'candleCrossUp', pUp) && !holds(pd, 'cePremEma', 'candleCrossUp', pUp - 1))
  assert.ok(holds(pd, 'cePremEmaCross', 'closeAboveBoth', 110) && !holds(pd, 'cePremEmaCross', 'closeBelowBoth', 110))
})
