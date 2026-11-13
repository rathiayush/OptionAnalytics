import test from 'node:test'
import assert from 'node:assert/strict'
import { withBackfill } from '../src/cvdBackfill.js'

const MIN = 60_000
const t0 = Date.UTC(2026, 9, 8, 3, 45) // 09:15 IST
const bar = (i, delta, cvd) => ({ time: t0 + i * MIN, delta, cvd })
const fill = (i, buy, sell) => ({ time: new Date(t0 + i * MIN).toISOString(), buy, sell })

test('prior minutes lead the chart and shift the running cumulative delta', () => {
  const bars = [bar(3, 10, 10), bar(4, -4, 6)]
  const r = withBackfill(bars, [fill(0, 50, 20), fill(1, 10, 30), fill(2, 5, 5)], 1)
  assert.equal(r.offset, 10) // +30, -20, 0
  assert.deepEqual(r.chartBars.map((b) => b.cvd), [30, 10, 10, 20, 16])
  assert.deepEqual(r.bars.map((b) => b.cvd), [20, 16])
  assert.equal(r.priorCount, 3)
})

test('backfill minutes are bucketed to the timeframe and never reach the first exact bar', () => {
  const bars = [bar(5, 1, 1)]
  const r = withBackfill(bars, [fill(0, 10, 0), fill(4, 0, 4), fill(5, 99, 0)], 5)
  assert.equal(r.priorCount, 1) // minutes 0..4 are one 5-min bucket; minute 5 is the first bar's own bucket
  assert.equal(r.offset, 6)
  assert.equal(r.bars[0].cvd, 7)
})

test('nothing to add leaves the bars alone', () => {
  const bars = [bar(0, 1, 1)]
  assert.equal(withBackfill(bars, [], 1).bars, bars)
  assert.equal(withBackfill([], [fill(0, 1, 0)], 1).offset, 0)
})

// OI Replay's futures delta pane: the minutes before a restart come from the estimate, the rest from the recording.
test('deltaMinutes puts the estimated minutes before the first recorded one in front, marked', async () => {
  const { deltaMinutes } = await import('../src/cvdBackfill.js')
  const t = (hhmm) => `2026-10-21T${hhmm}:00+05:30`
  const recorded = [{ time: t('13:29'), buy: 900, sell: 400 }, { time: t('13:28'), buy: 100, sell: 300 }]
  const backfill = [{ time: t('09:15'), buy: 50, sell: 20 }, { time: t('13:27'), buy: 10, sell: 40 }, { time: t('13:28'), buy: 999, sell: 0 }]
  const minutes = deltaMinutes(recorded, backfill)
  assert.deepEqual(minutes.map((m) => [new Date(m.ms).toISOString().slice(11, 16), m.delta, m.estimated]), [
    ['03:45', 30, true], ['07:57', -30, true], ['07:58', -200, false], ['07:59', 500, false],
  ])
  assert.deepEqual(deltaMinutes([], backfill).map((m) => m.estimated), [true, true, true])
  assert.deepEqual(deltaMinutes(recorded, null).map((m) => m.delta), [-200, 500])
})

// A 5-minute timeframe whose recording started part way into a candle (10:02 in 10:00 - 10:05 here: minute 2 of the
// bucket starting at minute 0): the estimated minutes 0 and 1 are before the first exact minute - counted in the
// cumulative delta from the open and in that candle's delta on the chart (drawn as estimated), not dropped.
test('estimated minutes in the first recorded candle, before its first recorded minute, still count', () => {
  const first = bar(0, 7, 7) // the 5-minute candle starting at minute 0 holds the exact minutes 2 - 4 (delta 7)
  const r = withBackfill([first, bar(5, -2, 5)], [fill(0, 10, 0), fill(1, 0, 4), fill(2, 99, 0)], 5, t0 + 2 * MIN)
  assert.equal(r.offset, 6)                                   // +10 - 4; minute 2 is recorded - its estimate is not used
  assert.deepEqual(r.bars.map((b) => [b.delta, b.cvd]), [[7, 13], [-2, 11]])   // the footprint keeps its own exact delta
  assert.deepEqual(r.chartBars.map((b) => [b.delta, b.cvd, Boolean(b.estimated)]), [[13, 13, true], [-2, 11, false]])
  assert.equal(r.priorCount, 0)
  // Without the first exact minute it reads as before (the candle's start).
  assert.equal(withBackfill([first], [fill(0, 10, 0), fill(1, 0, 4)], 5).offset, 0)
})

// OI Replay's futures delta panes, live: the "orderFlowDelta" push merged as the minutes trade.
test('mergeDeltaPush replaces the forming minute, adds the next, and asks for a reload when a minute was missed', async () => {
  const { mergeDeltaPush } = await import('../src/cvdBackfill.js')
  const iso = (i) => new Date(t0 + i * MIN).toISOString()
  const held = [{ ms: t0, delta: 30, estimated: true }, { ms: t0 + MIN, delta: 5, estimated: false }, { ms: t0 + 2 * MIN, delta: -3, estimated: false }]
  // Minute 2 still forming (now -8), minute 3 new.
  const next = mergeDeltaPush(held, [{ time: iso(2), buy: 2, sell: 10 }, { time: iso(3), buy: 6, sell: 1 }])
  assert.equal(next.gap, false)
  assert.deepEqual(next.minutes.map((m) => [(m.ms - t0) / MIN, m.delta, m.estimated]), [[0, 30, true], [1, 5, false], [2, -8, false], [3, 5, false]])
  // The push starts at minute 4 while the page holds up to minute 2: minute 3 was missed - load the day again.
  const missed = mergeDeltaPush(held, [{ time: iso(4), buy: 1, sell: 0 }, { time: iso(5), buy: 1, sell: 0 }])
  assert.equal(missed.gap, true)
  assert.equal(missed.minutes, held)
  // A push older than a day just loaded leaves the later minutes alone.
  const stale = mergeDeltaPush(next.minutes, [{ time: iso(1), buy: 9, sell: 0 }])
  assert.deepEqual(stale.minutes.map((m) => [(m.ms - t0) / MIN, m.delta]), [[0, 30], [1, 9], [2, -8], [3, 5]])
  // Nothing pushed, or nothing held yet: no change, no reload.
  assert.deepEqual(mergeDeltaPush(held, []), { minutes: held, gap: false })
  assert.deepEqual(mergeDeltaPush([], [{ time: iso(0), buy: 1, sell: 0 }]).minutes.map((m) => m.delta), [1])
})

// The footprint's "Delta per row" column: each row's buy - sell, shaded against the bar's largest.
test('rowDeltas: each row is buy minus sell; the largest in size shades the rest', async () => {
  const { rowDeltas } = await import('../src/orderFlowMath.js')
  const { byPrice, maxAbs } = rowDeltas([{ price: 101, buy: 5700, sell: 2600 }, { price: 100.5, buy: 0, sell: 4500 }, { price: 100, buy: 325, sell: 520 }])
  assert.deepEqual([...byPrice], [[101, 3100], [100.5, -4500], [100, -195]])
  assert.equal(maxAbs, 4500)
  assert.equal(rowDeltas([{ price: 1, buy: 10, sell: 10 }]).maxAbs, 1)   // all flat: no division by zero
  assert.equal(rowDeltas(null).byPrice.size, 0)
})

test('a replayed day with no order flow from the server: the run\'s futures candles estimated the server\'s way', async () => {
  const { estimateFlowMinutes } = await import('../src/cvdBackfill.js')
  const T = Date.parse('2026-11-13T03:45:00Z')
  const c = (i, open, close, volume) => ({ time: new Date(T + i * 60_000).toISOString(), open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close, volume })
  const candles = [c(0, 100, 102, 1000), c(1, 102, 102, 500), c(2, 102, 99, 2000), c(3, 99, 99, 0), c(4, 99, 100, 750)]
  const m = estimateFlowMinutes(candles, { lotSize: 50 })
  // The zero-volume minute is left out (as the server does); every minute marked estimated.
  assert.equal(m.length, 4)
  assert.ok(m.every((x) => x.estimated))
  // Minute 0: change +2 over sigma 2 -> Phi(1) = 0.8413 -> buy round(841.3 / 50) x 50 = 850, sell 150 -> +700.
  assert.equal(m[0].delta, 700)
  // Minute 1: flat -> half and half: buy round(250 / 50) x 50 = 250 -> 0.
  assert.equal(m[1].delta, 0)
  // Minute 2: -3 over sigma sqrt((4 + 0 + 9) / 3) = 2.0817 -> Phi(-1.441) = 0.0748 -> buy 150, sell 1850 -> -1700.
  assert.equal(m[2].delta, -1700)
  // Each minute from it and those before only: the day cut part way gives the same minutes.
  for (let k = 1; k <= candles.length; k++) {
    const part = estimateFlowMinutes(candles.slice(0, k), { lotSize: 50 })
    assert.deepEqual(part, m.slice(0, part.length))
  }
  assert.deepEqual(estimateFlowMinutes([]), [])
})
