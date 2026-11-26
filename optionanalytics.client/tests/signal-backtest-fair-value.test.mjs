// JJ SIMON'S FAIR VALUE strategy on NSE time: the fair value anchor (previous close for the 09:15 open, the 13:59 close for the
// 14:00 one), the displacement candle, the break of structure, the entry window setting and the two templates - long, mirrored
// short, and not without each part.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BACKTEST_DEFAULTS, RULE_CONDITIONS, simulateDay, timeframeView } from '../src/signalBacktest.js'
import { cleanBacktestSettings, engineSettings } from '../src/signalBacktestJob.js'
import { RULE_TEMPLATES, withTemplate } from '../src/signalTemplates.js'

const MIN = 60_000
const T915 = Date.parse('2026-10-05T09:15:00+05:30')
const cond = (id) => RULE_CONDITIONS.find((c) => c.id === id)

// A prepared day by hand: 375 minutes from 09:15; spot(i) -> { o, h, l, c } or a number; the options priced off spot.
function day({ spot, n = 375, prevClose = 25000 } = {}) {
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
  const spotBars = { o: bar((i) => sp(i).o), h: bar((i) => sp(i).h), l: bar((i) => sp(i).l), c: bar((i) => sp(i).c) }
  return {
    ok: true, date: '2026-10-05', underlying: 'NIFTY', step: 50, n, t, atm: bar((i) => Math.round(sp(i).c / 50) * 50),
    spot: spotBars, price: { ...spotBars, v: bar(() => 1000) }, prevDay: { close: prevClose },
    vwap: bar(() => 25000), oi: bar(() => ({ ce: 0, pe: 0 })), breaks: [], hp: [], priceSource: 'spot', ce: legs(false), pe: legs(true),
  }
}
const flat = (c) => ({ o: c, h: c + 1, l: c - 1, c })
// Up-drift to 25040 by minute 10 in small candles, then a strong candle at minute 12 (09:27): body 26 over a 1-point one before,
// close 25060 over the last 5 highs, no upper wick; then up to 25120.
const PUSH_UP = (i) => (i < 11 ? flat(25000 + i * 4) : i === 11 ? flat(25044) : i === 12 ? { o: 25034, h: 25060, l: 25033, c: 25060 } : i < 25 ? flat(25060 + (i - 12) * 5) : flat(25120))
const DOWN = (i) => ({ o: 50000 - PUSH_UP(i).o, h: 50000 - PUSH_UP(i).l, l: 50000 - PUSH_UP(i).h, c: 50000 - PUSH_UP(i).c })

test('fair value: the morning anchor is the previous close (or the open), the afternoon\'s the close before 14:00', () => {
  const d = day({ spot: (i) => (i < 285 ? 25000 : 25100) })           // 14:00 is minute 285
  const at = (k, value, p, win, src) => cond('fairValue').test(d, k, value, 1, p, win, src)
  d.spot.c[290] = 25100
  assert.ok(at(290, 'awayAbove', 0.3, 2) && !at(290, 'awayBelow', 0.3, 2))   // vs the 13:59 close 25000
  assert.ok(!at(290, 'awayAbove', 0.3, 1))                                   // not the morning window
  assert.ok(!at(290, 'awayAbove', 0.5, 2))                                   // 0.4% is not 0.5%
  assert.ok(!at(100, 'awayAbove', 0, 0))                                     // 10:55 - between the windows
  assert.ok(!at(300, 'awayAbove', 0, 0) === false)                           // 14:15 is inside 'both'
  // morning: previous close 24900 -> 25000 is above it; the open 25000 -> it is not.
  const m = day({ spot: () => 25000, prevClose: 24900 })
  assert.ok(cond('fairValue').test(m, 5, 'awayAbove', 1, 0.3, 1, 0) && !cond('fairValue').test(m, 5, 'awayAbove', 1, 0.3, 1, 1))
  // the first 15 minutes only (window 3): minute 10 yes, minute 30 no.
  assert.ok(cond('fairValue').test(m, 10, 'awayAbove', 1, 0.3, 3, 0) && !cond('fairValue').test(m, 30, 'awayAbove', 1, 0.3, 3, 0))
  // the look-back: stretched 3 candles ago still counts with a look-back of 4, not of 1
  const lb = day({ spot: (i) => (i === 7 ? 25080 : 25000) })
  assert.ok(!cond('fairValue').test(lb, 10, 'awayAbove', 1, 0.2, 1, 0) && cond('fairValue').test(lb, 10, 'awayAbove', 4, 0.2, 1, 0))
  // no previous session loaded: falls back to the day's open
  const none = day({ spot: (i) => 25000 + i }); delete none.prevDay
  assert.ok(!cond('fairValue').test(none, 3, 'awayAbove', 1, 0.5, 1, 0))
})

test('displacement candle and break of structure', () => {
  const d = day({ spot: PUSH_UP })
  const disp = (k, v, p = 25) => cond('displacement').test(d, k, v, 1, p)
  assert.ok(disp(12, 'bullish') && !disp(12, 'bearish') && !disp(11, 'bullish'))
  // a counter-wick over the limit fails it
  const w = day({ spot: (i) => (i === 12 ? { o: 25034, h: 25090, l: 25033, c: 25060 } : PUSH_UP(i)) })
  assert.ok(!cond('displacement').test(w, 12, 'bullish', 1, 25) && cond('displacement').test(w, 12, 'bullish', 1, 60))
  const bos = (k, v, n) => cond('structureBreak').test(d, k, v, 1, n)
  assert.ok(bos(12, 'bosUp', 5) && !bos(12, 'bosDown', 5) && !bos(3, 'bosUp', 5))
  const dn = day({ spot: DOWN })
  assert.ok(cond('displacement').test(dn, 12, 'bearish', 1, 25) && cond('structureBreak').test(dn, 12, 'bosDown', 1, 5))
})

const tpl = (id) => RULE_TEMPLATES.find((t) => t.id === id)
const engineOf = (id) => engineSettings(withTemplate(cleanBacktestSettings({ underlying: 'NIFTY', charges: false }), tpl(id)))

test('the entry window is a setting: 09:16 by default for the templates, 09:30 for the page', () => {
  assert.equal(BACKTEST_DEFAULTS.entryFrom, '09:30')
  assert.equal(cleanBacktestSettings({ entryFrom: '09:16', lastEntry: '14:55' }).entryFrom, '09:16')
  assert.equal(cleanBacktestSettings({ entryFrom: 'nine', lastEntry: '99:99' }).entryFrom, '09:30')
  assert.equal(cleanBacktestSettings({ lastEntry: '99:99' }).lastEntry, '14:45')
  const e = engineOf('fairValueContinuation')
  assert.equal(e.entryFrom, '09:16'); assert.equal(e.spotStop, 'candle'); assert.equal(e.spotRR, 1.5); assert.equal(e.timeframe, 1)
})

test('continuation: the opening push away from the previous close, a displacement + BOS candle - the call, out at 1.5R on spot', () => {
  const d = day({ spot: PUSH_UP })
  const { trades } = simulateDay(d, engineOf('fairValueContinuation'))
  assert.equal(trades.length, 1)
  assert.equal(trades[0].side, 'CE'); assert.equal(trades[0].action, 'BUY'); assert.equal(trades[0].strategy, 'rule')
  assert.equal(trades[0].entryTime, d.t[12])                                  // at the displacement candle, 09:27
  assert.match(trades[0].exitReason, /Spot/)
  assert.ok(trades[0].points > 0)
  // the mirror: the same day upside down - the put
  const m = simulateDay(day({ spot: DOWN }), engineOf('fairValueContinuation')).trades
  assert.equal(m.length, 1); assert.equal(m[0].side, 'PE'); assert.equal(m[0].strategy, 'mirror')
})

test('continuation: not without each part - no push away, no displacement, no structure break, outside the first 15 minutes', () => {
  const e = engineOf('fairValueContinuation')
  assert.equal(simulateDay(day({ spot: PUSH_UP, prevClose: 25040 }), e).trades.length, 0)     // fair value 25040: 25060 is only 0.08% away
  assert.equal(simulateDay(day({ spot: (i) => (i === 12 ? { o: 25034, h: 25090, l: 25033, c: 25060 } : PUSH_UP(i)) }), e).trades.length, 0)   // a long upper wick
  assert.equal(simulateDay(day({ spot: (i) => (i === 12 ? { o: 25059, h: 25061, l: 25058, c: 25060 } : PUSH_UP(i)) }), e).trades.length, 0)   // body no bigger than the one before
  // the same candle at 09:45 (minute 30) - the push is older than 15 minutes
  const late = (i) => (i < 29 ? flat(25040) : i === 29 ? flat(25041) : i === 30 ? { o: 25035, h: 25062, l: 25034, c: 25062 } : flat(25062 + (i - 30) * 3))
  assert.equal(simulateDay(day({ spot: late }), e).trades.length, 0)
})

test('reversion: stretched above fair value, a bearish displacement under the last 10 candles - the put (any time in the windows)', () => {
  const e = engineOf('fairValueReversion')
  assert.equal(e.entryFrom, '09:16')
  // Up to 25080 (0.32%) by minute 40, then a bearish displacement: body 40 over a 1-point one, closing under the last 10 lows.
  const spot = (i) => (i < 40 ? flat(25000 + i * 2) : i === 40 ? { o: 25082, h: 25083, l: 25040, c: 25041 } : i < 60 ? flat(25041 - (i - 40)) : flat(25010))
  const d = day({ spot })
  const { trades } = simulateDay(d, e)
  assert.equal(trades.length, 1)
  assert.equal(trades[0].side, 'PE'); assert.equal(trades[0].action, 'BUY'); assert.equal(trades[0].entryTime, d.t[40])
  // the mirror: below fair value, a bullish displacement - the call
  const down = (i) => { const s = spot(i); return { o: 50000 - s.o, h: 50000 - s.l, l: 50000 - s.h, c: 50000 - s.c } }
  const m = simulateDay(day({ spot: down }), e).trades
  assert.equal(m.length, 1); assert.equal(m[0].side, 'CE'); assert.equal(m[0].strategy, 'mirror')
  // not stretched enough (0.2%): the same shape from a smaller push
  assert.equal(simulateDay(day({ spot, prevClose: 25070 }), e).trades.length, 0)
})

test('the afternoon window: fair value = the 13:59 close, the push inside 14:00 - 14:15', () => {
  // flat 25000 to 13:59 (minute 284), push to 25040 by 14:10, displacement at 14:12 (minute 297)
  const spot = (i) => (i < 285 ? flat(25000) : i < 296 ? flat(25000 + (i - 284) * 4) : i === 296 ? flat(25044) : i === 297 ? { o: 25036, h: 25062, l: 25035, c: 25062 } : flat(25062 + (i - 297) * 4))
  const d = day({ spot, prevClose: 24000 })                                    // the previous close is far away: only the 13:59 close fits
  const { trades } = simulateDay(d, engineOf('fairValueContinuation'))
  assert.equal(trades.length, 1)
  assert.equal(trades[0].side, 'CE'); assert.equal(trades[0].entryTime, d.t[297])
})
