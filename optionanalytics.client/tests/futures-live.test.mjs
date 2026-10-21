import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeFuturesLive } from '../src/futuresLive.js'

// The run's bars (server, +05:30) and the live feed's minutes (UTC) for 10:58 - 11:00 IST.
const bar = (hhmm, o, h, l, c, v) => ({ time: `2026-10-21T${hhmm}:00+05:30`, open: o, high: h, low: l, close: c, volume: v, openInterest: 100 })
const live = (utcHhmm, o, h, l, c, v) => ({ time: `2026-10-21T${utcHhmm}:00.000Z`, open: o, high: h, low: l, close: c, volume: v, openInterest: 120 })

test('the minute the page loaded in keeps ticking: matched by time, not by its text', () => {
  const bars = [bar('10:58', 100, 101, 99, 100.5, 500), bar('10:59', 100.5, 102, 100, 101, 300)]
  const merged = mergeFuturesLive(bars, [live('05:29', 101.5, 103, 98.5, 102.5, 200)])
  assert.equal(merged.length, 2)
  // 10:59 IST = 05:29 UTC: open kept, range widened, the live close / OI, the larger volume.
  assert.deepEqual(
    { open: merged[1].open, high: merged[1].high, low: merged[1].low, close: merged[1].close, volume: merged[1].volume, oi: merged[1].openInterest },
    { open: 100.5, high: 103, low: 98.5, close: 102.5, volume: 300, oi: 120 },
  )
})

test('newer live minutes are added; one older than the bars is left to them', () => {
  const bars = [bar('10:59', 100, 101, 99, 100, 300)]
  const merged = mergeFuturesLive(bars, [live('05:28', 1, 1, 1, 1, 9), live('05:30', 100, 104, 100, 103, 50)])
  assert.deepEqual(merged.map((p) => [new Date(p.time).getTime(), p.close]), [
    [Date.parse('2026-10-21T05:29:00Z'), 100],
    [Date.parse('2026-10-21T05:30:00Z'), 103],
  ])
})

test('no bars: the live minutes alone; no live minutes: the bars in time order', () => {
  assert.equal(mergeFuturesLive([], [live('05:30', 1, 2, 1, 2, 5)]).length, 1)
  const bars = [bar('11:00', 3, 3, 3, 3, 1), bar('10:59', 2, 2, 2, 2, 1)]
  assert.deepEqual(mergeFuturesLive(bars, []).map((p) => p.close), [2, 3])
})
