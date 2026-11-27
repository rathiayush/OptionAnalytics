// THE VWAP + 9 EMA STRATEGY (asked for - "3 min, VWAP 9 EMA strategy, wick through: enter when the candle wicks through VWAP,
// exit when candles break through the EMA, and the opposite for puts"): the "Candle wicks through VWAP" condition, the
// "exit when a candle closes through the EMA" setting (`exitEma`) and the template - long, its mirror short, and not
// without each part.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BACKTEST_DEFAULTS, RULE_CONDITIONS, simulateDay, timeframeView } from '../src/signalBacktest.js'
import { cleanBacktestSettings, engineSettings, reportHead } from '../src/signalBacktestJob.js'
import { RULE_TEMPLATES, withTemplate } from '../src/signalTemplates.js'

const MIN = 60_000
const T915 = Date.parse('2026-10-05T09:15:00+05:30')
const cond = (id) => RULE_CONDITIONS.find((c) => c.id === id)

// A prepared day by hand (375 minutes from 09:15, VWAP flat at 25000): spot(i) -> a price or { o, h, l, c }; the options
// priced off it (a call 100 + half spot's move over 25000, a put the mirror).
function day(spot, n = 375) {
  const t = Array.from({ length: n }, (_, i) => T915 + i * MIN)
  const sp = (i) => { const s = spot(i); return typeof s === 'number' ? { o: s, h: s, l: s, c: s } : s }
  const bar = (f) => Array.from({ length: n }, (_, i) => f(i))
  const legs = (put) => {
    const m = new Map()
    for (let k = 24500; k <= 25600; k += 50) {
      const a = new Float64Array(n * 4)
      for (let i = 0; i < n; i++) {
        const s = sp(i), p = (x) => Math.max(1, 100 + (put ? -1 : 1) * (x - 25000) * 0.5)
        a[i * 4] = p(s.o); a[i * 4 + 1] = put ? p(s.l) : p(s.h); a[i * 4 + 2] = put ? p(s.h) : p(s.l); a[i * 4 + 3] = p(s.c)
      }
      m.set(k, a)
    }
    return m
  }
  const ohlc = () => ({ o: bar((i) => sp(i).o), h: bar((i) => sp(i).h), l: bar((i) => sp(i).l), c: bar((i) => sp(i).c) })
  return {
    ok: true, date: '2026-10-05', underlying: 'NIFTY', step: 50, n, t, atm: bar((i) => Math.round(sp(i).c / 50) * 50),
    spot: ohlc(), price: { ...ohlc(), v: bar(() => 1000) }, vwap: bar(() => 25000), oi: bar(() => ({ ce: 0, pe: 0 })),
    breaks: [], hp: [], prevVp: null, priceSource: 'futures', ce: legs(false), pe: legs(true),
  }
}
// UP: over VWAP all morning (25010, so the 9 EMA is above VWAP); the 3-minute candle of minutes 60 - 62 wicks down to 24995
// (under VWAP) and closes back at 25012 - over VWAP and over the 9 EMA; it holds 25012 until minute 90, then drops to 24980:
// the candle of minutes 90 - 92 closes under the EMA.
const UP = (i) => (i < 60 ? 25010 : i === 60 ? { o: 25005, h: 25010, l: 24995, c: 25005 } : i < 62 ? 25005 : i === 62 ? { o: 25005, h: 25012, l: 25005, c: 25012 } : i < 90 ? 25012 : 24980)
// DOWN, the mirror: under VWAP all morning (24990, the EMA below VWAP); the candle of 60 - 62 wicks up to 25005 and closes
// back at 24988 - under VWAP and the EMA; holds until minute 90, then 25020: that candle closes over the EMA.
const DOWN = (i) => (i < 60 ? 24990 : i === 60 ? { o: 24995, h: 25005, l: 24990, c: 24992 } : i < 62 ? 24992 : i === 62 ? { o: 24992, h: 24992, l: 24988, c: 24988 } : i < 90 ? 24988 : 25020)
const template = RULE_TEMPLATES.find((t) => t.id === 'vwapEmaWick')
const ENGINE = engineSettings(withTemplate(cleanBacktestSettings({ underlying: 'NIFTY', charges: false }), template))
const run = (d, over = {}) => simulateDay(d, { ...ENGINE, ...over })

test('the condition: low <= VWAP < close (up), high >= VWAP > close (down), in the look-back, by >= %', () => {
  const up = timeframeView(day(UP), 3)
  const w = cond('vwapWick')
  const k = 20                                                     // the candle of minutes 60 - 62
  assert.ok(w.test(up, k, 'wickUp', 1, 0) && !w.test(up, k, 'wickDown', 1, 0))
  assert.ok(!w.test(up, k + 1, 'wickUp', 1, 0) && w.test(up, k + 1, 'wickUp', 2, 0))    // a look-back of 2 candles still sees it
  assert.ok(w.test(up, k, 'wickUp', 1, 0.03) && !w.test(up, k, 'wickUp', 1, 0.05))      // 25010 is 0.04% over VWAP
  assert.ok(!w.test(up, k - 1, 'wickUp', 1, 0))                                           // 24990: under VWAP, no wick through it
  const down = timeframeView(day(DOWN), 3)
  assert.ok(w.test(down, k, 'wickDown', 1, 0) && !w.test(down, k, 'wickUp', 1, 0))
  assert.equal(w.options.find((o) => o.value === 'wickUp').opposite, 'wickDown')
})

test('the template: buy the call at the wick candle\'s close, out when a 3-minute candle closes under the 9 EMA', () => {
  const out = run(day(UP))
  assert.equal(out.trades.length, 1)
  const t = out.trades[0]
  assert.equal(t.side, 'CE'); assert.equal(t.action, 'BUY')
  assert.equal(t.entryTime, T915 + 62 * MIN)
  assert.match(t.exitReason, /^Spot closed under the 9 EMA \(3m candle\)/)
  assert.equal(t.exitTime, T915 + 92 * MIN)                          // the closing candle's last minute
  assert.equal(t.exit, 100 + (24980 - 25000) * 0.5)
})

test('the mirror: the wick above VWAP rejected - the put, out when a candle closes OVER the EMA', () => {
  const out = run(day(DOWN))
  assert.equal(out.trades.length, 1)
  assert.equal(out.trades[0].side, 'PE')
  assert.equal(out.trades[0].entryTime, T915 + 62 * MIN)
  assert.match(out.trades[0].exitReason, /^Spot closed over the 9 EMA/)
  assert.equal(out.trades[0].exitTime, T915 + 92 * MIN)
})

test('not without each part: the exit is off at 0 (square-off), and no entry unless the candle closes over the EMA', () => {
  const off = run(day(UP), { exitEma: 0 })
  assert.equal(off.trades.length, 1)
  assert.match(off.trades[0].exitReason, /square-off/)
  // The same wick but the candle closes UNDER the 9 EMA (the market was far higher before): no signal.
  const high = (i) => (i < 60 ? 25100 : i === 60 ? { o: 25098, h: 25098, l: 24995, c: 25001 } : i < 62 ? 25001 : { o: 25001, h: 25003, l: 25001, c: 25002 })
  assert.equal(run(day(high)).trades.length, 0)
  // No wick through VWAP at all: spot sits over it.
  assert.equal(run(day(() => 25020)).trades.length, 0)
})

test('the exit EMA gives a bearish trade\'s mirror in the traded direction only; a stop in the same candle still comes first', () => {
  const out = run(day(UP), { slPct: 1 })                            // a 1% stop = 1 point: hit on the 24980 drop's first minute (a gap - the open)
  assert.equal(out.trades.length, 1)
  assert.match(out.trades[0].exitReason, /^Stop/)
  assert.equal(out.trades[0].exitTime, T915 + 90 * MIN)
})

test('the setting: held to a period of 2 - 200 (else off), shown in the report, the template sets it, the default is off', () => {
  assert.equal(BACKTEST_DEFAULTS.exitEma, 0)
  assert.equal(cleanBacktestSettings({ exitEma: 9 }).exitEma, 9)
  assert.equal(cleanBacktestSettings({ exitEma: 1 }).exitEma, 0)
  assert.equal(cleanBacktestSettings({ exitEma: 999 }).exitEma, 200)
  assert.equal(cleanBacktestSettings({ exitEma: 'x' }).exitEma, 0)
  assert.match(reportHead(cleanBacktestSettings({ exitEma: 9, from: '2026-10-01', to: '2026-10-05' }), 3), /exit when a candle closes through the 9 EMA/)
  assert.equal(withTemplate(cleanBacktestSettings({}), template).exitEma, 9)
  assert.equal(withTemplate(cleanBacktestSettings({ exitEma: 9 }), RULE_TEMPLATES.find((t) => t.exitEma == null && !t.settings.exitEma)).exitEma, 0)   // another template: off
  assert.equal(template.settings.timeframe, 3)
})

test('EMA vs VWAP: the 9 EMA over / under / crossed VWAP', () => {
  // Spot 24980 for 60 minutes (EMA under VWAP 25000), then 25020: the 9 EMA of 3-minute closes crosses VWAP a few candles later.
  const up = (i) => (i < 60 ? 24980 : 25020)
  const v = timeframeView(day(up), 3)
  const c = cond('emaVwap')
  const at = (k, value, w = 1) => c.test(v, k, value, w, 0, 9)
  assert.ok(at(19, 'below') && !at(19, 'above') && !at(19, 'crossedAbove', 3))
  // The first closes at 25020 are 3-minute candle 20; the EMA (alpha 0.2) passes 25000 at the 2nd - 3rd candle after.
  const cross = [20, 21, 22, 23, 24].find((k) => at(k, 'above'))
  assert.ok(cross != null && at(cross, 'crossedAbove', 1) && !at(cross, 'crossedBelow', 3))
  assert.ok(at(cross + 3, 'above') && !at(cross + 3, 'crossedAbove', 1) && at(cross + 3, 'crossedAbove', 5))
  assert.equal(c.options.find((o) => o.value === 'crossedAbove').opposite, 'crossedBelow')
})

test('the wick template needs the trend first: the same wick with the 9 EMA UNDER VWAP is not taken', () => {
  const against = (i) => (i < 60 ? 24980 : i === 60 ? { o: 24998, h: 25008, l: 24995, c: 25005 } : i < 62 ? 25005 : i === 62 ? { o: 25005, h: 25012, l: 25005, c: 25012 } : 25012)
  assert.equal(run(day(against)).trades.length, 0)             // wick + close over VWAP and the EMA, but the EMA is still under VWAP
  assert.equal(run(day(UP)).trades.length, 1)
})

// ---- the same strategy on the OPTION'S OWN premium chart ------------------------------------------------------------------
// The calls' premium: 100 + half spot's move over 25000 - so it follows spot - with volume at every strike (the premium's VWAP needs it).
function withVolume(d) {
  d.ceVol = new Map(); d.peVol = new Map()
  for (const k of d.ce.keys()) { d.ceVol.set(k, new Float64Array(d.n).fill(100)); d.peVol.set(k, new Float64Array(d.n).fill(100)) }
  return d
}
// The call's premium over its VWAP (a morning at 105, VWAP ~105); a 3-minute candle wicks to 99 (under VWAP) and closes 106 (over VWAP and
// the 9 EMA); it holds 106, then at minute 90 falls to 90: the candle of 90 - 92 closes under the premium's EMA.
const PUP = (i) => (i < 60 ? 25010 : i === 60 ? { o: 25010, h: 25012, l: 24998, c: 25010 } : i < 62 ? 25010 : i === 62 ? { o: 25010, h: 25012, l: 25010, c: 25012 } : i < 90 ? 25012 : 24980)
const optionT = RULE_TEMPLATES.find((t) => t.id === 'vwapEmaWickOption')
const OE = engineSettings(withTemplate(cleanBacktestSettings({ underlying: 'NIFTY', charges: false }), optionT))

test('the premium conditions: its low / high through its own VWAP, its EMA over / under it, the mirror the other side\'s same one', () => {
  const v = timeframeView(withVolume(day(PUP)), 3)
  const wick = cond('cePremVwapWick'), ev = cond('cePremEmaVwap')
  assert.ok(wick.test(v, 20, 'wickUp', 1, 0) && !wick.test(v, 19, 'wickUp', 1, 0) && !wick.test(v, 20, 'wickDown', 1, 0))
  assert.ok(ev.test(v, 20, 'above', 1, 0, 9) && !ev.test(v, 20, 'below', 1, 0, 9))
  assert.equal(wick.mirror, 'pePremVwapWick'); assert.equal(ev.mirror, 'pePremEmaVwap')
  assert.ok(!wick.test(timeframeView(day(PUP), 3), 20, 'wickUp', 1, 0))          // no volume = no VWAP = never true
})

test('the option template: the call bought on its own wick, out when ITS premium candle closes under ITS 9 EMA', () => {
  assert.equal(OE.exitEmaOn, 'premium'); assert.equal(OE.exitEma, 9)
  const out = simulateDay(withVolume(day(PUP)), OE)
  assert.equal(out.trades.length, 1)
  const t = out.trades[0]
  assert.equal(t.side, 'CE')
  assert.equal(t.entryTime, T915 + 62 * MIN)
  assert.match(t.exitReason, /^Premium closed under the 9 EMA/)
  assert.equal(t.exitTime, T915 + 92 * MIN)
})

test('the exit on the option reads the OPTION: spot closing under its EMA does not exit a trade set to read the premium', () => {
  const d = withVolume(day(PUP))
  const spotExit = simulateDay(d, { ...OE, exitEmaOn: 'spot' })
  assert.match(spotExit.trades[0].exitReason, /^Spot closed under the 9 EMA/)
  assert.equal(cleanBacktestSettings({ exitEmaOn: 'bogus' }).exitEmaOn, 'spot')
  assert.equal(cleanBacktestSettings({ exitEmaOn: 'premium' }).exitEmaOn, 'premium')
  assert.match(reportHead(cleanBacktestSettings({ exitEma: 9, exitEmaOn: 'premium', from: '2026-10-01', to: '2026-10-05' }), 3), /exit when a premium candle closes through the 9 EMA/)
})
