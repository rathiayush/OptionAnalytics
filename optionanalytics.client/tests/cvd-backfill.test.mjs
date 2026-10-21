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
