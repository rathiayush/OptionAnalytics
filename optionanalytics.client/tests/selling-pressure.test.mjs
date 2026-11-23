// Pressure at the lows / highs (sellingPressure.js): normalised selling pressure of the push into each swing low, the
// price response, and BUYING INTEREST when a later low comes on weaker selling and the earlier low is claimed back - the
// mirror at the highs; no look-ahead.
import test from 'node:test'
import assert from 'node:assert/strict'
import { legInto, pressureCandles, pressureRead, pressureSwings } from '../src/sellingPressure.js'

const T0 = Date.parse('2026-11-20T09:15:00+05:30')
const MIN = 60_000
// 1-minute bars from a list of [low, high, close, buy, sell] (open = the previous close).
function bars(rows) {
  let prev = rows[0][2]
  return rows.map(([low, high, close, buy, sell], i) => {
    const b = { time: T0 + i * MIN, open: prev, high, low, close, buy, sell }
    prev = close
    return b
  })
}
// Leg 1 down to 100 on heavy selling (70 / 30), a bounce to 110, leg 2 down to 98 on LIGHTER selling (55 / 45), then
// closes back over 100 and on over the bounce high.
const DAY = [
  [114, 116, 115, 50, 50], [111, 115, 112, 30, 70], [107, 112, 108, 30, 70], [103, 108, 104, 30, 70], [100, 104, 101, 30, 70],
  [101, 105, 104, 60, 40], [103, 108, 107, 60, 40], [106, 110, 109, 60, 40], [105, 109, 106, 50, 50],
  [102, 106, 103, 45, 55], [99, 103, 100, 45, 55], [98, 101, 99, 45, 55],
  [99, 102, 101, 60, 40], [100, 104, 103, 60, 40], [102, 108, 107, 70, 30], [106, 112, 111, 70, 30], [110, 113, 112, 60, 40],
]

test('the candles: buckets of the timeframe, only the completed ones at a clock', () => {
  const b = bars(DAY)
  assert.equal(pressureCandles(b, 1).length, DAY.length)
  const five = pressureCandles(b, 5)
  assert.equal(five[0].sell, 70 + 70 + 70 + 70 + 50 - 50 + 50) // 9:15 - 9:19: sells 50,70,70,70,70
  assert.deepEqual(five.map((c) => c.time), [T0, T0 + 5 * MIN, T0 + 10 * MIN, T0 + 15 * MIN])
  assert.equal(pressureCandles(b, 5, T0 + 12 * MIN).length, 2) // the 09:25 candle is still forming
})

test('swing lows / highs are known only pivot candles later; the leg into a low = its selling share and its fall', () => {
  const c = pressureCandles(bars(DAY), 1)
  const lows = pressureSwings(c, 2).filter((s) => s.kind === 'low')
  assert.deepEqual(lows.map((s) => [s.index, s.price, s.knownAt]), [[4, 100, 6], [11, 98, 13]])
  const leg1 = legInto(c, lows[0])
  assert.equal(leg1.from, 0)
  assert.ok(Math.abs(leg1.pressure - 330 / 500) < 1e-12)     // sells 50+70*4 of 500
  assert.equal(leg1.move, 16)                                 // 116 -> 100
  const leg2 = legInto(c, lows[1], lows[0].index)
  assert.equal(leg2.from, 7)                                  // the bounce high 110
  assert.ok(Math.abs(leg2.pressure - (40 + 50 + 55 * 3) / 500) < 1e-12)
  assert.equal(leg2.move, 12)
})

test('BUYING INTEREST: the later low on weaker selling, the earlier low claimed back - dated when both are known; confirmed over the bounce high', () => {
  const c = pressureCandles(bars(DAY), 1)
  const { signals } = pressureRead(c, { pivot: 2 })
  assert.equal(signals.length, 1)
  const s = signals[0]
  assert.equal(s.kind, 'buying')
  assert.equal(s.level, 100)
  assert.equal(s.at, 13)               // the low is known at 13; 12 closed back over 100 first
  assert.ok(s.drop > 0.1)
  assert.equal(s.pivotLevel, 110)
  assert.equal(s.status, 'confirmed')
  assert.equal(s.statusAt, 15)         // the first close over 110
  assert.match(s.text, /^BUYING INTEREST/)
})

test('not without each part: selling as strong, the earlier low not claimed back, a higher low far above', () => {
  const strong = DAY.map((r, i) => (i >= 8 && i <= 11 ? [r[0], r[1], r[2], 30, 70] : r))
  assert.equal(pressureRead(pressureCandles(bars(strong), 1), { pivot: 2 }).signals.length, 0)
  const stuck = DAY.map((r, i) => (i >= 12 ? [97.5, 99.8, 99.5, 60, 40] : r)).map((r, i) => (i === 12 ? [98.5, 99.8, 99.5, 60, 40] : r))
  assert.equal(pressureRead(pressureCandles(bars(stuck), 1), { pivot: 2 }).signals.filter((s) => s.kind === 'buying').length, 0)
  const higher = DAY.map((r, i) => (i >= 9 ? [r[0] + 5, r[1] + 5, r[2] + 5, r[3], r[4]] : r))
  assert.equal(pressureRead(pressureCandles(bars(higher), 1), { pivot: 2 }).signals.filter((s) => s.kind === 'buying').length, 0)
})

test('SELLING INTEREST is the mirror at the highs; a FAILED read once price trades under the later low', () => {
  const flip = DAY.map(([l, h, c, b, s]) => [200 - h, 200 - l, 200 - c, s, b])
  const { signals } = pressureRead(pressureCandles(bars(flip), 1), { pivot: 2 })
  assert.equal(signals.length, 1)
  assert.equal(signals[0].kind, 'selling')
  assert.equal(signals[0].level, 100)
  assert.equal(signals[0].status, 'confirmed')
  const fails = DAY.slice(0, 14).concat([[96, 101, 97, 30, 70], [95, 98, 96, 30, 70]])
  const f = pressureRead(pressureCandles(bars(fails), 1), { pivot: 2 }).signals[0]
  assert.equal(f.status, 'failed')
  assert.equal(f.statusAt, 14)
})

test('no look-ahead: a cut at any clock = the whole day read up to it', () => {
  const b = bars(DAY)
  const whole = pressureRead(pressureCandles(b, 1), { pivot: 2 })
  for (let k = 0; k <= DAY.length; k++) {
    const clock = T0 + k * MIN
    const part = pressureRead(pressureCandles(b, 1, clock), { pivot: 2 })
    const known = whole.signals.filter((s) => s.at < k).map((s) => [s.kind, s.at, s.level])
    assert.deepEqual(part.signals.map((s) => [s.kind, s.at, s.level]), known, `clock ${k}`)
  }
})
