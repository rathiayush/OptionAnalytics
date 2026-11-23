// The charts' auto-fit (chartFit.js): few candles at 30 candle widths from the left, then all of them fitted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { autoFitRange, barMinutesOf, fitWholeDay } from '../src/chartFit.js'

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
    setVisibleLogicalRange: (r) => calls.push(r),
  }
  return { calls, chart: { timeScale: () => timeScale, panes: () => [{ getSeries: () => [{ data: () => data }] }] } }
}

test('bar minutes from the series itself', () => {
  assert.equal(barMinutesOf(fakeChart(10, 1, 1000).chart), 1)
  assert.equal(barMinutesOf(fakeChart(10, 15, 1000).chart), 15)
  assert.equal(barMinutesOf(fakeChart(1, 15, 1000).chart), 1)   // cannot tell from one bar
  assert.equal(barMinutesOf({ panes: () => { throw new Error('gone') } }), 1)
})

test('a full 15-minute day (25 candles) and more: fit them all', () => {
  const { chart, calls } = fakeChart(30, 15, 1500)
  fitWholeDay(chart)
  assert.deepEqual(calls, ['fit'])
})

test('few candles stand at 30 candle widths FROM THE LEFT, whatever the timeframe (the delta profile cards\' rule)', () => {
  for (const [bars, minutes] of [[1, 3], [2, 15], [20, 1]]) {
    const { chart, calls } = fakeChart(bars, minutes, 1500)
    fitWholeDay(chart)
    assert.deepEqual(calls, [{ from: -0.5, to: 29.5 }], `${bars} x ${minutes}m`)
  }
  assert.deepEqual(autoFitRange(29), { from: -0.5, to: 29.5 })
  assert.equal(autoFitRange(30), null)
  assert.equal(autoFitRange(0), null)
  const { chart, calls } = fakeChart(0, 1, 1000)
  fitWholeDay(chart)
  assert.deepEqual(calls, ['fit'])
})
