import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildOiTotalsRows } from '../src/oiTotalsHeatmap.js'
import { breakMeaning, breakText, completedLevelReads, newBreakWatch, watchBreaks } from '../src/oiLevelBreaks.js'

// One strike's CE cumulative OI, one point per minute: two swing lows at 60 (a support), then a fall through it.
const T0 = Date.UTC(2026, 9, 23, 9, 15) / 1000
const CUM = [120, 110, 100, 80, 60, 80, 100, 120, 100, 80, 60, 80, 100, 120, 100, 80, 40, 20, 0]
const BREAK_AT = 16 // 80 -> 40 crosses 60

function totalsUpTo(n) {
  const ce = new Map()
  for (let i = 0; i < n; i++) ce.set(T0 + i * 60, i === 0 ? CUM[0] : CUM[i] - CUM[i - 1])
  return buildOiTotalsRows(new Map([[100, ce]]), new Map([[100, new Map()]]))
}
// All n buckets complete (the clock is at the end of the last one).
const readsUpTo = (n) => completedLevelReads(totalsUpTo(n), 60, T0 + n * 60)

test('a support break on the CE cumulative is announced once, when it happens', () => {
  const watch = newBreakWatch()
  assert.deepEqual(watchBreaks(watch, readsUpTo(BREAK_AT), 60), [])   // seeds: nothing broken yet
  // PE is flat here, so the net (CE − PE) is the same line and breaks too.
  const all = watchBreaks(watch, readsUpTo(BREAK_AT + 1), 60)
  assert.deepEqual(all.map((b) => b.side.key).sort(), ['ce', 'net'])
  const breaks = all.filter((b) => b.side.key === 'ce')
  assert.equal(breaks[0].up, false)
  assert.equal(breaks[0].time, T0 + BREAK_AT * 60)
  assert.ok(Math.abs(breaks[0].levels[0].value - 60) < 1)
  assert.equal(breakMeaning('ce', false), 1)   // calls unwinding - bullish
  assert.deepEqual(watchBreaks(watch, readsUpTo(BREAK_AT + 2), 60), [])   // not again
})

test('a break already there when the page opens is not announced', () => {
  const watch = newBreakWatch()
  assert.deepEqual(watchBreaks(watch, readsUpTo(CUM.length), 60), [])
  assert.deepEqual(watchBreaks(watch, readsUpTo(CUM.length), 60), [])
})

test('a stale break (older than the fresh buckets) is not announced', () => {
  const watch = newBreakWatch()
  watchBreaks(watch, readsUpTo(BREAK_AT), 60)
  // The page only gets data again 3 minutes after the break.
  assert.deepEqual(watchBreaks(watch, readsUpTo(BREAK_AT + 4), 60), [])
})

test('the running bucket is not read: a break inside it waits until the bucket completes', () => {
  const totals = totalsUpTo(BREAK_AT + 1)
  const watch = newBreakWatch()
  watchBreaks(watch, readsUpTo(BREAK_AT), 60)
  // The clock is 30 s into the break bucket: it is still running.
  const running = completedLevelReads(totals, 60, T0 + BREAK_AT * 60 + 30)
  assert.equal(running.last, T0 + (BREAK_AT - 1) * 60)
  assert.deepEqual(watchBreaks(watch, running, 60), [])
  assert.equal(watchBreaks(watch, completedLevelReads(totals, 60, T0 + (BREAK_AT + 1) * 60), 60).filter((b) => b.side.key === 'ce').length, 1)
})

test('the message names the index, line, level, direction and meaning', () => {
  const watch = newBreakWatch()
  watchBreaks(watch, readsUpTo(BREAK_AT), 60)
  const b = watchBreaks(watch, readsUpTo(BREAK_AT + 1), 60).find((x) => x.side.key === 'ce')
  const text = breakText('NIFTY', b, (v) => String(Math.round(v)), () => '13:39', 1)
  assert.match(text, /^NIFTY OI CE cumulative Δ broke below support 60 \(×2\) at 13:39 \(calls unwinding - bullish\) · now 40$/)
})
