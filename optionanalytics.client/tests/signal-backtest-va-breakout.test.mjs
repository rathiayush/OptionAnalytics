// The VALUE AREA LOW-VOLUME BREAKOUT (asked for - "Direction, Area, Trigger": the previous session's VAH / VAL, a 15-minute
// candle closing outside it on low volume, entry at its close, stop at the breakout candle's low, a fixed 1:2 target): the
// value area's breakout options, the candle volume and "close vs the candle before" conditions, the SPOT stop / target and the
// template - long, its mirror short, and not without each part.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BACKTEST_DEFAULTS, RULE_CONDITIONS, simulateDay, spotLevelsAt, timeframeView } from '../src/signalBacktest.js'
import { cleanBacktestSettings, engineSettings, reportHead } from '../src/signalBacktestJob.js'
import { RULE_TEMPLATES, withTemplate } from '../src/signalTemplates.js'

const MIN = 60_000
const T915 = Date.parse('2026-10-05T09:15:00+05:30')
const cond = (id) => RULE_CONDITIONS.find((c) => c.id === id)
const PREV_VP = { vah: 25050, val: 24950, poc: 25000 }

// A prepared day by hand: 375 minutes from 09:15; spot(i) -> { o, h, l, c } (or a number); vol(i) the price series' volume;
// the calls / puts priced off spot at every strike (a call 100 + half spot's move over 25000, a put the mirror).
function day({ spot, vol = () => 1000, n = 375 } = {}) {
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
  return {
    ok: true, date: '2026-10-05', underlying: 'NIFTY', step: 50, n, t, atm: bar((i) => Math.round(sp(i).c / 50) * 50),
    spot: { o: bar((i) => sp(i).o), h: bar((i) => sp(i).h), l: bar((i) => sp(i).l), c: bar((i) => sp(i).c) },
    price: { o: bar((i) => sp(i).o), h: bar((i) => sp(i).h), l: bar((i) => sp(i).l), c: bar((i) => sp(i).c), v: bar(vol) },
    vwap: bar(() => 25000), oi: bar(() => ({ ce: 0, pe: 0 })), breaks: [], hp: [], prevVp: PREV_VP, priceSource: 'futures', ce: legs(false), pe: legs(true),
  }
}
// The breakout: inside the value area (25000) until the 10:45 candle (minutes 90 - 104), which runs from 25010 to close at
// 25060 (low 25010); its volume 500 a minute against 1000 before - then `after(i)` from minute 105.
const BREAK = (after) => (i) => (i < 90 ? 25000 : i < 105 ? { o: 25010, h: 25065, l: 25010, c: i === 104 ? 25060 : 25030 } : after(i))
const lowVol = (i) => (i >= 90 && i < 105 ? 500 : 1000)
const template = RULE_TEMPLATES.find((t) => t.id === 'vaLowVolBreakout')
const ENGINE = engineSettings(withTemplate(cleanBacktestSettings({ underlying: 'NIFTY', charges: false }), template))
const run = (d) => simulateDay(d, ENGINE)

test('the conditions: a close out of the value area, low / high candle volume, a close past the candle before', () => {
  const v = timeframeView(day({ spot: BREAK(() => 25060), vol: lowVol }), 15)
  const at = (id, value, k, w = 1, p, p2) => cond(id).test(v, k, value, w, p ?? cond(id).options.find((o) => o.value === value).param?.default ?? 0, p2 ?? cond(id).options.find((o) => o.value === value).param2?.default)
  assert.ok(at('valueArea', 'crossedAboveVah', 6) && !at('valueArea', 'crossedAboveVah', 5) && !at('valueArea', 'crossedBelowVal', 6))
  assert.ok(at('valueArea', 'crossedAboveVah', 6, 1, 0.03) && !at('valueArea', 'crossedAboveVah', 6, 1, 0.05))    // by >= % of the VAH
  assert.ok(at('candleBreak', 'aboveHigh', 6) && !at('candleBreak', 'aboveHigh', 5) && !at('candleBreak', 'belowLow', 6))
  // Volume: 7 500 against 15 000 a candle before = 0.5x.
  assert.ok(at('candleVol', 'low', 6, 1, 0.51) && !at('candleVol', 'low', 6, 1, 0.5) && !at('candleVol', 'high', 6, 1, 1) && at('candleVol', 'high', 6, 1, 0.5))
  assert.ok(!at('candleVol', 'low', 2))                                                       // fewer than 3 candles before
  assert.ok(at('candleVol', 'low', 6, 1, 0.51, 3))                                              // over the last 3 only
})

test('the template: a long at the breakout candle\'s close, out at the spot target 1:2', () => {
  // After the break spot climbs 2 points a minute: risk 25060 - 25010 = 50, target 25160 - reached at minute 155.
  const out = run(day({ spot: BREAK((i) => 25060 + (i - 104) * 2), vol: lowVol }))
  assert.equal(out.trades.length, 1)
  const t = out.trades[0]
  assert.equal(t.side, 'CE')
  assert.equal(t.strike, 25050)
  assert.equal(t.entryTime, T915 + 104 * MIN)
  assert.match(t.exitReason, /^Spot target \(25160\.00\)/)
  assert.equal(t.exitTime, T915 + 154 * MIN)                                                   // 25060 + 50 x 2 = 25160 at minute 154
})

test('the spot stop at the breakout candle\'s low - and a gap through it fills at the option\'s open', () => {
  const out = run(day({ spot: BREAK((i) => (i < 110 ? 25060 : 25005)), vol: lowVol }))
  assert.equal(out.trades.length, 1)
  assert.match(out.trades[0].exitReason, /^Spot stop \(25010\.00 - the signal candle's low\)/)
  assert.equal(out.trades[0].exitTime, T915 + 110 * MIN)
  assert.equal(out.trades[0].exit, 100 + 5 * 0.5)                                              // spot opened through: the option's open
})

test('not without each part: high volume, no close past the candle before', () => {
  assert.equal(run(day({ spot: BREAK(() => 25060) })).trades.length, 0)                        // the break on the usual volume
  const noBreak = (i) => (i < 75 ? 25000 : i < 90 ? { o: 25000, h: 25080, l: 25000, c: 25040 } : BREAK(() => 25060)(i))
  assert.equal(run(day({ spot: noBreak, vol: lowVol })).trades.length, 0)                     // the candle before's high 25080 not passed
})

test('the mirror: a close below the VAL on low volume - the put, stopped at the candle\'s high', () => {
  const down = (i) => (i < 90 ? 25000 : i < 105 ? { o: 24990, h: 24990, l: 24935, c: i === 104 ? 24940 : 24970 } : 24940 - (i - 104) * 2)
  const out = run(day({ spot: down, vol: lowVol }))
  assert.equal(out.trades.length, 1)
  assert.equal(out.trades[0].side, 'PE')
  assert.match(out.trades[0].exitReason, /^Spot target \(24840\.00\)/)                          // risk 24990 - 24940 = 50
})

test('the spot levels: none off or with no risk; the settings held; the report says so', () => {
  const d = day({ spot: BREAK(() => 25060), vol: lowVol })
  const s = { spotStop: 'candle', spotRR: 2 }
  assert.deepEqual(spotLevelsAt(d, T915 + 90 * MIN, T915 + 104 * MIN, 1, 104, s), { stop: 25010, target: 25160 })
  assert.deepEqual(spotLevelsAt(d, T915 + 90 * MIN, T915 + 104 * MIN, 1, 104, { spotStop: 'candle', spotRR: 0 }), { stop: 25010, target: null })
  assert.equal(spotLevelsAt(d, T915 + 90 * MIN, T915 + 104 * MIN, 1, 104, { spotStop: '' }), null)
  assert.deepEqual(spotLevelsAt(d, T915 + 90 * MIN, T915 + 104 * MIN, -1, 104, s), { stop: 25065, target: 25050 })   // bearish: the high, risk 5
  assert.equal(spotLevelsAt(d, T915, T915 + 10 * MIN, 1, 10, s), null)                        // a flat candle closed at its low: no risk
  assert.equal(BACKTEST_DEFAULTS.spotStop, '')
  assert.equal(cleanBacktestSettings({ spotStop: 'bogus', spotRR: 99 }).spotStop, '')
  assert.equal(cleanBacktestSettings({ spotStop: 'candle', spotRR: 99 }).spotRR, 10)
  assert.match(reportHead(cleanBacktestSettings({ spotStop: 'candle', spotRR: 2, from: '2026-10-01', to: '2026-10-05' }), 3), /spot stop at the signal candle · spot target 1:2/)
})

test('SPOT volume: "Volume of: Index" reads the index\'s own volume, the default the futures\'', () => {
  // The futures' volume is high on the breakout candle, the index's low: only the index reading calls it low.
  const base = day({ spot: BREAK(() => 25060), vol: () => 1000 })
  const idx = (i) => (i >= 90 && i < 105 ? 500 : 1000)
  base.spot.v = Array.from({ length: base.n }, (_, i) => idx(i))
  const v = timeframeView(base, 15)
  const low = cond('candleVol')
  assert.ok(!low.test(v, 6, 'low', 1, 1, 20, 0))              // futures: 1x average - not under it
  assert.ok(low.test(v, 6, 'low', 1, 0.51, 20, 1))            // index: 0.5x
  assert.ok(!low.test(v, 6, 'low', 1, 0.5, 20, 1))
  const spotT = RULE_TEMPLATES.find((t) => t.id === 'vaLowVolBreakoutSpot')
  const e = engineSettings(withTemplate(cleanBacktestSettings({ underlying: 'NIFTY', charges: false }), spotT))
  const d = day({ spot: BREAK(() => 25060), vol: () => 1000 }); d.spot.v = base.spot.v
  assert.equal(simulateDay(d, e).trades.length, 1)             // taken on the index's low volume
  assert.equal(simulateDay(day({ spot: BREAK(() => 25060), vol: lowVol }), e).trades.length, 0)   // futures low, no index volume: none
})

test('a day with no volume on the source the rule reads is NAMED in the report (it never gives a signal there)', async () => {
  const { backtestReport, dayOutcome } = await import('../src/signalBacktestJob.js')
  const spotT = RULE_TEMPLATES.find((t) => t.id === 'vaLowVolBreakoutSpot')
  const futT = RULE_TEMPLATES.find((t) => t.id === 'vaLowVolBreakout')
  const eSpot = engineSettings(withTemplate(cleanBacktestSettings({ underlying: 'NIFTY', charges: false }), spotT))
  const eFut = engineSettings(withTemplate(cleanBacktestSettings({ underlying: 'NIFTY', charges: false }), futT))
  const d = day({ spot: BREAK(() => 25060), vol: lowVol })
  d.hasSpotVolume = false; d.hasPriceVolume = true                       // the index sent no volume that day
  const spotReport = backtestReport([dayOutcome(d.date, d, eSpot)], eSpot)
  assert.deepEqual(spotReport.noVolume, [{ date: d.date, source: 'index' }])
  assert.deepEqual(backtestReport([dayOutcome(d.date, d, eFut)], eFut).noVolume, [])      // the futures' volume is there
  d.hasSpotVolume = true
  assert.deepEqual(backtestReport([dayOutcome(d.date, d, eSpot)], eSpot).noVolume, [])
})
