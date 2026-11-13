import test from 'node:test'
import assert from 'node:assert/strict'
import { GEX_SPOT_KEYS, gexLevelSeries, levelsAround, spotCandles, wallRange } from '../src/gexSpot.js'

// OI Replay's "GEX levels on spot" card (asked for - "on OI Replay show the GEX levels with the spot chart"): the levels
// drawn through the day as each stood at that candle - read at the candle's last minute, never a later one.

const IST = 19800
const DAY = Date.parse('2026-11-13T03:45:00Z') // 09:15 IST
const chart = (ms) => Math.floor(ms / 1000) + IST
const toMs = (s) => (s - IST) * 1000
const MIN = 60_000

// 30 one-minute spot bars from 09:15, rising a point a minute.
const bars = Array.from({ length: 30 }, (_, i) => ({ time: chart(DAY + i * MIN), open: 25000 + i, high: 25001 + i, low: 24999 + i, close: 25000.5 + i }))
// A GEX minute for each: the call wall steps up at 09:27, the put wall is missing until 09:20, the net turns negative at 09:35.
const gex = bars.map((b, i) => ({
  time: DAY + i * MIN, spot: b.close, net: i < 20 ? 5e9 : -3e9,
  callWall: i < 12 ? 25100 : 25200, putWall: i < 5 ? null : 24900, maxGamma: 25000, flip: 24950 + i,
}))

test('candles of the timeframe from the 1-minute bars', () => {
  const five = spotCandles(bars, 5)
  assert.equal(five.length, 6)
  assert.deepEqual(five[0], { time: bars[0].time, open: 25000, high: 25005, low: 24999, close: 25004.5 })
  assert.equal(spotCandles(bars, 1).length, 30)
})

test('each candle reads the GEX minute at its LAST minute - the walls step, a missing level breaks the line', () => {
  const candles = spotCandles(bars, 5)
  const s = gexLevelSeries(gex, candles, 5, { toMs })
  // Candle 0 = 09:15-09:19: its last minute is 09:19 (i = 4) - the put wall did not exist yet.
  assert.deepEqual(s.lines.putWall[0], { time: candles[0].time })
  assert.equal(s.lines.putWall[1].value, 24900)
  // The call wall moved at i = 12 (09:27): candle 2 (09:25-09:29, last minute i = 14) already shows it.
  assert.deepEqual(s.lines.callWall.map((p) => p.value), [25100, 25100, 25200, 25200, 25200, 25200])
  assert.deepEqual(s.lines.flip.map((p) => p.value), [24954, 24959, 24964, 24969, 24974, 24979])
  assert.deepEqual(s.regime.map((p) => p.net > 0), [true, true, true, true, false, false])
  assert.equal(s.at[5], gex[29])
  for (const k of GEX_SPOT_KEYS) assert.equal(s.lines[k].length, candles.length)
})

test('nothing after the clock: a cut part way = the whole day for the candles finished, the forming one at the clock', () => {
  const whole = gexLevelSeries(gex, spotCandles(bars, 5), 5, { toMs })
  for (let cut = 1; cut <= 30; cut++) {
    const clock = DAY + (cut - 1) * MIN
    const shown = spotCandles(bars.slice(0, cut), 5)
    const part = gexLevelSeries(gex.filter((m) => m.time <= clock), shown, 5, { toMs, asOfMs: clock })
    const done = Math.floor(cut / 5)
    for (let i = 0; i < done; i++) for (const k of GEX_SPOT_KEYS) assert.deepEqual(part.lines[k][i], whole.lines[k][i], `cut ${cut} candle ${i} ${k}`)
    // The candle still forming reads the clock's minute, not its own last one (which has not come).
    if (cut % 5) assert.equal(part.at.at(-1), gex[cut - 1])
    // Even with the whole day's GEX given, the clock holds it back.
    const held = gexLevelSeries(gex, shown, 5, { toMs, asOfMs: clock })
    assert.deepEqual(held.at, part.at)
  }
})

test('no GEX before the first minute: whitespace, no regime', () => {
  const late = gex.slice(10)
  const s = gexLevelSeries(late, spotCandles(bars, 5), 5, { toMs })
  assert.equal(s.at[0], null)
  assert.deepEqual(s.lines.callWall[0], { time: bars[0].time })
  assert.equal(s.regime[0].time, bars[10].time, 'the strip starts with the first candle that has a GEX minute')
})

test('the levels around spot, nearest first, and the range the walls fence in', () => {
  const m = { spot: 25060, callWall: 25200, putWall: 24900, maxGamma: 25050, flip: null, net: 1 }
  assert.deepEqual(levelsAround(m).map((l) => [l.key, l.distance]), [['maxGamma', -10], ['callWall', 140], ['putWall', -160]])
  assert.equal(wallRange(m), 'inside')
  assert.equal(wallRange({ ...m, spot: 25210 }), 'above')
  assert.equal(wallRange({ ...m, spot: 24890 }), 'below')
  assert.equal(wallRange({ ...m, putWall: null }), null)
  assert.deepEqual(levelsAround(null), [])
})
