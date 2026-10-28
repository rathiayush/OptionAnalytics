// The charts' auto-fit caps a candle at 8 px per minute it spans - a 15-minute chart's day fills the width instead of
// being crushed into a sliver at the right edge (the cap used to be a flat 8 px a candle).
import test from 'node:test'
import assert from 'node:assert/strict'
import { barMinutesOf, fitWholeDay } from '../src/chartFit.js'

// A stand-in for a lightweight-charts chart: one series of `bars` bars `minutes` apart, a time axis `width` px wide.
function fakeChart(bars, minutes, width) {
  const data = Array.from({ length: bars }, (_, i) => ({ time: 1_760_000_000 + i * minutes * 60 }))
  const calls = []
  const timeScale = {
    fitContent: () => calls.push('fit'),
    getVisibleLogicalRange: () => ({ from: 0, to: bars - 1 }),
    width: () => width,
    applyOptions: (o) => calls.push(o),
    scrollToRealTime: () => calls.push('scroll'),
  }
  return { calls, chart: { timeScale: () => timeScale, panes: () => [{ getSeries: () => [{ data: () => data }] }] } }
}

test('bar minutes from the series itself', () => {
  assert.equal(barMinutesOf(fakeChart(10, 1, 1000).chart), 1)
  assert.equal(barMinutesOf(fakeChart(10, 15, 1000).chart), 15)
  assert.equal(barMinutesOf(fakeChart(1, 15, 1000).chart), 1)   // cannot tell from one bar
  assert.equal(barMinutesOf({ panes: () => { throw new Error('gone') } }), 1)
})

test('a full 15-minute day fills a wide chart - no cap', () => {
  const { chart, calls } = fakeChart(25, 15, 1500)   // 60 px a candle, under 8 x 15 = 120
  fitWholeDay(chart)
  assert.deepEqual(calls, ['fit'])
})

test('a few 1-minute candles early in the day are still capped at 8 px', () => {
  const { chart, calls } = fakeChart(20, 1, 1500)   // 75 px a candle, over 8
  fitWholeDay(chart)
  assert.deepEqual(calls, ['fit', { barSpacing: 8 }, 'scroll'])
})

test('two 15-minute candles at the open are capped at 120 px', () => {
  const { chart, calls } = fakeChart(2, 15, 1500)
  fitWholeDay(chart)
  assert.deepEqual(calls, ['fit', { barSpacing: 120 }, 'scroll'])
})
