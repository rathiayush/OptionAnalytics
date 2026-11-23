// The Spot structure page live and at a replay clock (structureLive.js): the session buckets the server builds its
// timeframes on, the live forming minute folded into each timeframe's last candle, and a replay's chart = the chart built
// from the minutes known at its clock - for every timeframe and every minute of the day.
import test from 'node:test'
import assert from 'node:assert/strict'
import { addLiveMinute, bucketStart, candleEnd, candlesAsOf, candlesAtClock, foldMinutes, sessionStartOf } from '../src/structureLive.js'

const MIN = 60_000
const at = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+05:30`)
const TFS = [1, 3, 5, 15, 60, 240, 1440]

// A day of 1-minute bars 09:15 - 15:29 IST, a seeded walk.
function dayMinutes(day, start = 25000, seed = 7) {
  let x = seed
  const rnd = () => { x = (x * 16807) % 2147483647; return x / 2147483647 }
  const out = []
  let p = start
  for (let m = 0; m < 375; m++) {
    const o = p
    p = Math.round((p + (rnd() - 0.5) * 20) * 100) / 100
    out.push({ time: at(day, '09:15') + m * MIN, open: o, high: Math.max(o, p) + Math.round(rnd() * 500) / 100, low: Math.min(o, p) - Math.round(rnd() * 500) / 100, close: p, volume: 100 + m })
  }
  return out
}

// SpotStructureService.Aggregate, as the server does it: buckets from 09:15 IST, each stamped with its start.
function aggregate(minutes, tf) {
  const buckets = new Map()
  for (const c of [...minutes].sort((a, b) => a.time - b.time)) {
    const b = bucketStart(c.time, tf)
    if (b == null) continue
    const old = buckets.get(b)
    buckets.set(b, old ? { ...old, high: Math.max(old.high, c.high), low: Math.min(old.low, c.low), close: c.close } : { time: b, open: c.open, high: c.high, low: c.low, close: c.close })
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time)
}
const ohlc = (list) => list.map(({ time, open, high, low, close }) => ({ time, open, high, low, close }))

test('the session buckets: from 09:15 IST, a 4-hour candle 09:15 / 13:15, a day the session; none outside it', () => {
  const d = '2026-11-20'
  assert.equal(sessionStartOf(at(d, '14:07')), at(d, '09:15'))
  assert.equal(sessionStartOf(at(d, '00:10')), at(d, '09:15'))
  assert.equal(bucketStart(at(d, '09:15'), 60), at(d, '09:15'))
  assert.equal(bucketStart(at(d, '10:14'), 60), at(d, '09:15'))
  assert.equal(bucketStart(at(d, '10:15'), 60), at(d, '10:15'))
  assert.equal(bucketStart(at(d, '15:29'), 60), at(d, '15:15'))
  assert.equal(bucketStart(at(d, '13:14'), 240), at(d, '09:15'))
  assert.equal(bucketStart(at(d, '13:15'), 240), at(d, '13:15'))
  assert.equal(bucketStart(at(d, '15:29'), 240), at(d, '13:15'))
  assert.equal(bucketStart(at(d, '12:00'), 1440), at(d, '09:15'))
  assert.equal(bucketStart(at(d, '09:22'), 5), at(d, '09:20'))
  assert.equal(bucketStart(at(d, '09:17'), 3), at(d, '09:15'))
  assert.equal(bucketStart(at(d, '09:18'), 3), at(d, '09:18'))
  assert.equal(bucketStart(at(d, '09:14'), 5), null)
  assert.equal(bucketStart(at(d, '15:30'), 5), null)
  assert.equal(bucketStart(NaN, 5), null)
})

test('a candle is complete at its span\'s end, cut at 15:30 (the last hour, the afternoon 4 hours, the day)', () => {
  const d = '2026-11-20'
  assert.equal(candleEnd(at(d, '10:15'), 60), at(d, '11:15'))
  assert.equal(candleEnd(at(d, '15:15'), 60), at(d, '15:30'))
  assert.equal(candleEnd(at(d, '13:15'), 240), at(d, '15:30'))
  assert.equal(candleEnd(at(d, '09:15'), 1440), at(d, '15:30'))
  const candles = aggregate(dayMinutes(d), 240)
  assert.equal(candlesAsOf(candles, 240, at(d, '15:29')).length, 1)
  assert.equal(candlesAsOf(candles, 240, at(d, '15:30')).length, 2)
  assert.equal(candlesAsOf(candles, 240, null), candles)
})

test('LIVE: the day\'s minutes folded into the days before = the server\'s candles of all of them, every timeframe', () => {
  const before = [...dayMinutes('2026-11-18', 25000, 3), ...dayMinutes('2026-11-19', 25100, 5)]
  const today = dayMinutes('2026-11-20', 25050, 11)
  for (const tf of TFS) {
    assert.deepEqual(ohlc(foldMinutes(aggregate(before, tf), today, tf)), ohlc(aggregate([...before, ...today], tf)), `tf ${tf}`)
  }
})

test('LIVE: the forming minute pushed tick by tick, folded each time over the server\'s candles of part of the day, ends where the server does', () => {
  const before = dayMinutes('2026-11-19', 25100, 5)
  const today = dayMinutes('2026-11-20', 25050, 11).slice(0, 200)
  for (const tf of [5, 60, 240]) {
    const loaded = aggregate([...before, ...today.slice(0, 120)], tf)  // the page's last read: up to 11:14
    let live = []
    let shown = loaded
    for (const m of today.slice(118)) {                               // pushes from 11:13 (two minutes the read already had)
      // the forming minute grows: open, then each tick widens it until its close
      for (const step of [{ ...m, high: m.open, low: m.open, close: m.open }, { ...m, close: (m.open + m.close) / 2, high: Math.max(m.open, (m.open + m.close) / 2), low: Math.min(m.open, (m.open + m.close) / 2) }, m]) {
        live = addLiveMinute(live, { ...step, time: new Date(step.time).toISOString() })
        shown = foldMinutes(loaded, live, tf)
      }
    }
    assert.deepEqual(ohlc(shown), ohlc(aggregate([...before, ...today], tf)), `tf ${tf}`)
    assert.equal(shown.at(-1).forming, true)
  }
})

test('a minute older than the last candle, or outside the session, changes nothing; nothing is changed in place', () => {
  const d = '2026-11-20'
  const candles = aggregate(dayMinutes(d).slice(0, 60), 15)
  const copy = JSON.parse(JSON.stringify(candles))
  const out = foldMinutes(candles, [
    { time: at(d, '09:20'), open: 1, high: 99999, low: 1, close: 1 },
    { time: at(d, '15:35'), open: 1, high: 99999, low: 1, close: 1 },
    { time: at(d, '08:59'), open: 1, high: 99999, low: 1, close: 1 },
  ], 15)
  assert.deepEqual(ohlc(out), ohlc(copy))
  assert.deepEqual(candles, copy)
  assert.equal(foldMinutes(candles, [], 15), candles)
})

test('REPLAY: at any clock the chart = the candles built from the minutes completed by then - every timeframe, every minute', () => {
  const before = [...dayMinutes('2026-11-18', 25000, 3), ...dayMinutes('2026-11-19', 25100, 5)]
  const day = dayMinutes('2026-11-20', 25050, 11)
  const after = dayMinutes('2026-11-23', 25200, 13)
  for (const tf of TFS) {
    const whole = aggregate([...before, ...day, ...after], tf)          // the window the page loads runs past the day
    for (let k = 0; k <= 375; k += tf >= 60 ? 7 : 1) {
      const clock = at('2026-11-20', '09:15') + k * MIN                 // the end of the newest minute shown
      const known = [...before, ...day.filter((m) => m.time + MIN <= clock)]
      assert.deepEqual(ohlc(candlesAtClock(whole, tf, clock, day)), ohlc(aggregate(known, tf)), `tf ${tf} at minute ${k}`)
    }
  }
})

test('REPLAY: without the day\'s minutes, only the completed candles; no clock = all', () => {
  const day = dayMinutes('2026-11-20')
  const whole = aggregate(day, 60)
  const clock = at('2026-11-20', '11:40')
  assert.deepEqual(candlesAtClock(whole, 60, clock, []).map((c) => c.time), [at('2026-11-20', '09:15'), at('2026-11-20', '10:15')])
  assert.equal(candlesAtClock(whole, 60, null, day), whole)
})

test('the live minutes kept: a minute replaced as it grows, in time order, a late older one put in place, an earlier day ignored, a new day starts again', () => {
  const d = '2026-11-20'
  let list = []
  list = addLiveMinute(list, { time: new Date(at(d, '10:00')).toISOString(), open: 1, high: 2, low: 1, close: 2 })
  list = addLiveMinute(list, { time: new Date(at(d, '10:00') + 30_000).toISOString(), open: 1, high: 3, low: 1, close: 3 })
  assert.deepEqual(list, [{ time: at(d, '10:00'), open: 1, high: 3, low: 1, close: 3 }])
  list = addLiveMinute(list, { time: at(d, '10:02'), open: 3, high: 4, low: 3, close: 4 })
  list = addLiveMinute(list, { time: at(d, '10:01'), open: 3, high: 3, low: 2, close: 3 })
  assert.deepEqual(list.map((m) => m.time), [at(d, '10:00'), at(d, '10:01'), at(d, '10:02')])
  assert.equal(addLiveMinute(list, { time: at('2026-11-19', '15:00'), open: 1, high: 1, low: 1, close: 1 }), list)
  assert.equal(addLiveMinute(list, { time: 'not a time', close: 1 }), list)
  const next = addLiveMinute(list, { time: at('2026-11-23', '09:15'), open: 5, high: 5, low: 5, close: 5 })
  assert.deepEqual(next.map((m) => m.time), [at('2026-11-23', '09:15')])
  let many = []
  for (let m = 0; m < 400; m++) many = addLiveMinute(many, { time: at(d, '09:15') + m * MIN, open: 1, high: 1, low: 1, close: 1 }, 50)
  assert.equal(many.length, 50)
  assert.equal(many.at(-1).time, at(d, '09:15') + 399 * MIN)
})
