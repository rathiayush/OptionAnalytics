// OI Replay's VWAP ± 2σ bands (chartVwap.js): the session's volume-weighted deviation of the typical price about the
// VWAP, restarting each IST day - from the candles' own volume, or the server's VWAP / deviation series on the candles.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chartVwapBands, joinVwapSd, sessionVwapFromBars, sessionVwapSdFromBars, vwapBandLines } from '../src/chartVwap.js'

const DAY = 86400
const T0 = 20000 * DAY + 9 * 3600 + 15 * 60
const bar = (m, tp, volume, day = 0) => ({ time: T0 + day * DAY + m * 60, high: tp + 1, low: tp - 1, close: tp, volume })

test('the deviation is the volume-weighted spread of the typical price, worked out by hand; VWAP the same as the line', () => {
  const bars = [bar(0, 100, 100), bar(1, 102, 200), bar(2, 101, 0), bar(0, 108, 50, 1)]
  const sd = sessionVwapSdFromBars(bars)
  assert.deepEqual(sd.map((p) => p.vwap), sessionVwapFromBars(bars).map((p) => p.value))
  assert.equal(sd[0].sd, 0)
  // mean 101.333, E[tp^2] = (100*10000 + 200*10404) / 300 -> var 0.8889, sd 0.9428
  assert.ok(Math.abs(sd[1].sd - 0.94281) < 1e-4, String(sd[1].sd))
  assert.equal(sd[2].sd, sd[1].sd, 'no volume: unchanged')
  assert.equal(sd[3].sd, 0, 'a new day starts again')
  const { upper, lower } = vwapBandLines(sd)
  assert.ok(Math.abs(upper[1].value - (sd[1].vwap + 2 * sd[1].sd)) < 1e-9)
  assert.ok(Math.abs(lower[1].value - (sd[1].vwap - 2 * sd[1].sd)) < 1e-9)
  assert.equal(sessionVwapSdFromBars([{ time: T0, high: 1, low: 1, close: 1 }]), null)
})

test('no volume on the candles: the server\'s VWAP and deviation, aligned to the candles (a 5-minute candle takes its last minute)', () => {
  const candles = [0, 5].map((m) => ({ time: T0 + m * 60, open: 100, high: 101, low: 99, close: 100 }))
  const vwap = Array.from({ length: 10 }, (_, m) => ({ time: T0 + m * 60, value: 100 + m }))
  const sd = Array.from({ length: 10 }, (_, m) => ({ time: T0 + m * 60, value: m }))
  const { upper, lower } = chartVwapBands(candles, vwap, sd)
  assert.deepEqual(upper.map((p) => p.time), candles.map((c) => c.time))
  assert.deepEqual(upper.map((p) => p.value), [104 + 8, 109 + 18])
  assert.deepEqual(lower.map((p) => p.value), [104 - 8, 109 - 18])
  // No deviation for a point: no band there.
  assert.equal(joinVwapSd(vwap, sd.slice(0, 3)).length, 3)
  assert.deepEqual(chartVwapBands([], vwap, sd), { upper: [], lower: [] })
  assert.deepEqual(chartVwapBands(candles, vwap, []), { upper: [], lower: [] })
})

test('a cut part way = the whole day up to it (each point from the bars before it)', () => {
  const bars = Array.from({ length: 30 }, (_, m) => bar(m, 100 + Math.sin(m) * 5, 100 + m * 7))
  const whole = sessionVwapSdFromBars(bars)
  for (const cut of [1, 10, 29]) assert.deepEqual(sessionVwapSdFromBars(bars.slice(0, cut)), whole.slice(0, cut))
})
