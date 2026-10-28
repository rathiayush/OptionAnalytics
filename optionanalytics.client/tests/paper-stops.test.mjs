import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_LEVEL_LOG, paperExitHit, paperLevelLog, paperLevelsNow, paperStopTargetHit, punchLevelLog, withPaperLevelChange } from '../src/paperStops.js'

// The OI Replay trade panel's paper positions: their own SL / target / trailing stop, level changes, the 15:15 square-off.
const ist = (hhmm, sec = 0) => Date.parse(`2026-10-22T${hhmm}:${String(sec).padStart(2, '0')}+05:30`)
// A replayed day's 1-minute bar: stamped at the minute's start, holding its close.
const bar = (hhmm, close, low = close, high = close) => ({ time: new Date(ist(hhmm)).toISOString(), price: close, low, high })
// A live point: the running minute's latest tick (`ms` / `time` = that tick), the minute's range so far.
const tick = (hhmm, sec, price, low = price, high = price) => ({ time: new Date(ist(hhmm, sec)).toISOString(), ms: ist(hhmm, sec), price, low, high })
const levels = (sl, target, trailStart = 0, trailGap = 0) => ({ sl, target, trailStart, trailGap })
const position = (over = {}) => ({
  id: 'p1', underlying: 'NIFTY', side: 'CE', strike: 25000, direction: 'BUY', status: 'OPEN',
  entryPrice: 100, entryTime: ist('10:05'), levelLog: punchLevelLog(levels(20, 30), ist('10:05')), ...over,
})

test('replay: judged from the bar after the entry bar, on its high / low; the stop first when a bar touches both', () => {
  const series = [bar('10:05', 100, 70, 140), bar('10:06', 95, 85, 110), bar('10:07', 90, 79, 131)]
  // The 10:05 bar is the entry's own (its close is the entry) - its range never counts.
  assert.equal(paperStopTargetHit(series.slice(0, 2), position(), { asOfMs: ist('10:06') }), null)
  assert.deepEqual(paperStopTargetHit(series, position(), { asOfMs: ist('10:07') }), { kind: 'sl', fillPrice: 80, at: ist('10:07') })
  // Nothing after the replay clock is seen.
  assert.equal(paperStopTargetHit(series, position(), { asOfMs: ist('10:06') }), null)
  const up = [bar('10:05', 100), bar('10:06', 120, 99, 131)]
  assert.deepEqual(paperStopTargetHit(up, position(), { asOfMs: ist('10:06') }), { kind: 'target', fillPrice: 130, at: ist('10:06') })
  // SELL: the stop above, the target below.
  const sell = position({ direction: 'SELL' })
  assert.deepEqual(paperStopTargetHit([bar('10:05', 100), bar('10:06', 110, 95, 121)], sell, { asOfMs: ist('10:06') }), { kind: 'sl', fillPrice: 120, at: ist('10:06') })
  assert.deepEqual(paperStopTargetHit([bar('10:05', 100), bar('10:06', 80, 69, 101)], sell, { asOfMs: ist('10:06') }), { kind: 'target', fillPrice: 70, at: ist('10:06') })
})

test('live: a dip in the entry minute BEFORE the entry is not a stop - only the price after it counts in that minute', () => {
  // Bought at 10:05:30 at 100; the minute had already dipped to 75 at 10:05:10 (the running bar's low).
  const p = position({ entryTime: ist('10:05', 30), levelLog: punchLevelLog(levels(20, 30), ist('10:05', 30)) })
  assert.equal(paperStopTargetHit([tick('10:05', 45, 99, 75, 104)], p), null, 'the pre-entry low (75) does not stop it')
  assert.equal(paperStopTargetHit([tick('10:05', 45, 99, 99, 135)], p), null, 'nor a pre-entry high reach the target')
  // A later tick of the same minute through the stop does.
  assert.deepEqual(paperStopTargetHit([tick('10:05', 55, 79, 75, 104)], p), { kind: 'sl', fillPrice: 80, at: ist('10:05', 55) })
  // The next minute is all after the entry: its whole range counts.
  assert.deepEqual(paperStopTargetHit([tick('10:05', 59, 95, 75, 104), tick('10:06', 20, 92, 79.5, 96)], p), { kind: 'sl', fillPrice: 80, at: ist('10:06', 20) })
})

test("each position keeps its own levels - the ticket's, not the panel's (the fallback is only for older positions)", () => {
  const series = [bar('10:05', 100), bar('10:06', 82, 78, 100)]
  const ticket = position({ levelLog: punchLevelLog(levels(35, 30), ist('10:05')) })
  assert.equal(paperStopTargetHit(series, ticket, { asOfMs: ist('10:06'), fallback: levels(20, 30) }), null, 'its own 35-pt stop holds')
  const old = position({ levelLog: undefined })
  assert.deepEqual(paperStopTargetHit(series, old, { asOfMs: ist('10:06'), fallback: levels(20, 30) }), { kind: 'sl', fillPrice: 80, at: ist('10:06') })
  assert.equal(paperStopTargetHit(series, old, { asOfMs: ist('10:06'), fallback: null }), null, 'no levels at all: nothing to hit')
  assert.deepEqual(paperLevelsNow(ticket), { t: ist('10:05'), sl: 35, target: 30, trailStart: 0, trailGap: 0 })
  assert.equal(paperLevelsNow(position({ noStop: true, levelLog: undefined })), null)
})

test('punchLevelLog: No SL keeps no levels, No trailing (or no gap) no trailing', () => {
  assert.equal(punchLevelLog({ ...levels(20, 30), noStop: true }, ist('10:05')), null)
  assert.deepEqual(punchLevelLog({ ...levels(20, 30, 10, 5), noTrail: true }, ist('10:05')), [{ t: ist('10:05'), ...levels(20, 30) }])
  assert.deepEqual(punchLevelLog(levels(20, 30, 10, 5), ist('10:05')), [{ t: ist('10:05'), ...levels(20, 30, 10, 5) }])
  assert.deepEqual(punchLevelLog(levels(20, 30, 10, 0), ist('10:05')), [{ t: ist('10:05'), ...levels(20, 30) }])
})

test('a change applies from the minute it is made - never to the bars already passed (replay)', () => {
  // 10:07 dipped to 86; the SL is tightened to 10 (stop 90) while the replay shows 10:08 (close 95).
  const series = [bar('10:05', 100), bar('10:06', 98, 96, 101), bar('10:07', 92, 86, 99), bar('10:08', 95, 89, 97), bar('10:09', 93, 89.5, 96)]
  const [changed] = withPaperLevelChange([position()], 'NIFTY', { sl: 10 }, ist('10:08'))
  assert.equal(changed.levelLog.length, 2)
  assert.deepEqual(changed.levelLog[1], { t: ist('10:08'), ...levels(10, 30) })
  // Up to 10:08: the 10:07 dip (86) is not judged with the new stop, nor the 10:08 bar's low (89, partly before the change).
  assert.equal(paperStopTargetHit(series, changed, { asOfMs: ist('10:08') }), null)
  // 10:09's whole range is after it: 89.5 <= 90.
  assert.deepEqual(paperStopTargetHit(series, changed, { asOfMs: ist('10:09') }), { kind: 'sl', fillPrice: 90, at: ist('10:09') })
  // Without the change the old 20-pt stop (80) holds.
  assert.equal(paperStopTargetHit(series, position(), { asOfMs: ist('10:09') }), null)
  // A stop set through the price shown (the 10:08 close, 95) closes it at once, at the level.
  const [through] = withPaperLevelChange([position()], 'NIFTY', { sl: 4 }, ist('10:08'))
  assert.deepEqual(paperStopTargetHit(series, through, { asOfMs: ist('10:08') }), { kind: 'sl', fillPrice: 96, at: ist('10:08') })
  // Widened instead: the trade survives a dip the old stop would have caught.
  const deep = [bar('10:05', 100), bar('10:06', 98), bar('10:07', 90, 75, 99)]
  const [wide] = withPaperLevelChange([position()], 'NIFTY', { sl: 30 }, ist('10:06'))
  assert.equal(paperStopTargetHit(deep, wide, { asOfMs: ist('10:07') }), null)
  assert.deepEqual(paperStopTargetHit(deep, position(), { asOfMs: ist('10:07') }), { kind: 'sl', fillPrice: 80, at: ist('10:07') })
})

test('live: a change mid-minute is judged on the prices after it in that minute', () => {
  const p = position({ entryTime: ist('10:02', 10), levelLog: punchLevelLog(levels(20, 30), ist('10:02', 10)) })
  const [changed] = withPaperLevelChange([p], 'NIFTY', { sl: 10 }, ist('10:07', 30))
  // The running 10:07 minute had dipped to 88 at 10:07:05, before the change; now 93.
  assert.equal(paperStopTargetHit([tick('10:06', 59, 95, 92, 97), tick('10:07', 40, 93, 88, 96)], changed), null)
  assert.deepEqual(paperStopTargetHit([tick('10:06', 59, 95, 92, 97), tick('10:07', 50, 89.5, 88, 96)], changed), { kind: 'sl', fillPrice: 90, at: ist('10:07', 50) })
})

test('the trailing stop only tightens: widening the trail or switching it off keeps what it earned', () => {
  const p = position({ levelLog: punchLevelLog(levels(20, 0, 0, 5), ist('10:05')) })
  // Up to 130 (stop 125 by 10:09), then back to 121.
  const series = [bar('10:05', 100), bar('10:06', 110, 100, 110), bar('10:07', 120, 110, 120), bar('10:08', 130, 120, 130), bar('10:09', 128, 127, 129), bar('10:10', 122, 121, 128)]
  assert.deepEqual(paperStopTargetHit(series, p, { asOfMs: ist('10:10') }), { kind: 'trail', fillPrice: 125, at: ist('10:10') })
  for (const patch of [{ trailGap: 20 }, { trailGap: 0 }]) {
    const [changed] = withPaperLevelChange([p], 'NIFTY', patch, ist('10:09'))
    assert.deepEqual(paperStopTargetHit(series, changed, { asOfMs: ist('10:10') }), { kind: 'trail', fillPrice: 125, at: ist('10:10') }, JSON.stringify(patch))
  }
  // A No trailing position never trails, whatever the panel's trail.
  const noTrail = position({ noTrail: true, levelLog: punchLevelLog(levels(20, 0), ist('10:05')) })
  const [still] = withPaperLevelChange([noTrail], 'NIFTY', { trailGap: 5 }, ist('10:06'))
  assert.equal(still, noTrail, 'nothing to change')
  assert.equal(paperStopTargetHit(series, still, { asOfMs: ist('10:10') }), null)
})

test('a change reaches only the OPEN positions of its own index that have levels', () => {
  const nifty = position()
  const bank = position({ id: 'b', underlying: 'BANKNIFTY', levelLog: punchLevelLog(levels(50, 75), ist('10:05')) })
  const closed = position({ id: 'c', status: 'CLOSED' })
  const noStop = position({ id: 'n', noStop: true, levelLog: undefined })
  const list = [nifty, bank, closed, noStop]
  const next = withPaperLevelChange(list, 'NIFTY', { target: 40 }, ist('10:10'))
  assert.deepEqual(next[0].levelLog.at(-1), { t: ist('10:10'), ...levels(20, 40) })
  assert.equal(next[1], bank, "another index's position keeps its own levels")
  assert.equal(next[2], closed)
  assert.equal(next[3], noStop)
  // The same levels again: no change at all.
  assert.equal(withPaperLevelChange(next, 'NIFTY', { target: 40 }, ist('10:11')), next)
  assert.equal(withPaperLevelChange(list, 'NIFTY', {}, ist('10:11')), list)
})

test('a later change in the same minute replaces the earlier one; one after the clock (a replay played back) is dropped', () => {
  let [p] = withPaperLevelChange([position()], 'NIFTY', { sl: 2 }, ist('10:08', 5))
  ;[p] = withPaperLevelChange([p], 'NIFTY', { sl: 25 }, ist('10:08', 40))
  assert.deepEqual(p.levelLog.map((c) => c.sl), [20, 25])
  ;[p] = withPaperLevelChange([p], 'NIFTY', { sl: 15 }, ist('10:12'))
  ;[p] = withPaperLevelChange([p], 'NIFTY', { sl: 18 }, ist('10:09'))
  assert.deepEqual(p.levelLog.map((c) => [c.t, c.sl]), [[ist('10:05'), 20], [ist('10:08', 40), 25], [ist('10:09'), 18]])
  // A change dated before the entry (a replay behind it) takes effect from the entry.
  const [early] = withPaperLevelChange([position()], 'NIFTY', { sl: 12 }, ist('10:00'))
  assert.deepEqual(early.levelLog.map((c) => [c.t, c.sl]), [[ist('10:05'), 20], [ist('10:05'), 12]])
  assert.deepEqual(paperLevelLog(early).at(-1), { t: ist('10:05'), ...levels(12, 30) })
})

test('a long log is folded into a checkpoint that judges the rest exactly as the whole log would', () => {
  // A trader raising a trailing stop by hand every minute on a rising premium.
  const series = [bar('10:05', 100)]
  for (let m = 1; m <= MAX_LEVEL_LOG + 6; m++) series.push(bar(`10:${String(5 + m).padStart(2, '0')}`, 100 + m, 100 + m - 0.5, 100 + m + 0.5))
  const seriesOf = () => series
  let folded = position({ levelLog: punchLevelLog(levels(20, 0, 0, 3), ist('10:05')) })
  let whole = folded
  for (let m = 1; m <= MAX_LEVEL_LOG + 4; m++) {
    const at = ist(`10:${String(5 + m).padStart(2, '0')}`)
    const patch = { sl: m % 2 ? 19 : 20 }
    ;[folded] = withPaperLevelChange([folded], 'NIFTY', patch, at, { seriesOf })
    whole = { ...whole, levelLog: [...whole.levelLog, { t: at, ...levels(patch.sl, 0, 0, 3) }] }
  }
  assert.ok(folded.checkpoint && folded.levelLog.length <= MAX_LEVEL_LOG, `folded: ${folded.levelLog.length} entries, checkpoint ${JSON.stringify(folded.checkpoint)}`)
  assert.ok(JSON.stringify(folded).length < 4096, `small enough for the server: ${JSON.stringify(folded).length} bytes`)
  // Then the premium falls back: both stop at the same earned trail, at the same bar.
  const fall = [...series, bar('10:40', 126, 120, 133), bar('10:41', 110, 105, 121)]
  const a = paperStopTargetHit(fall, folded, { asOfMs: ist('10:41') })
  const b = paperStopTargetHit(fall, whole, { asOfMs: ist('10:41') })
  assert.ok(a && a.kind === 'trail', JSON.stringify(a))
  assert.deepEqual(a, b)
})

test('a No SL position is squared off at 15:15; one with levels keeps its stop / target', () => {
  const late = [bar('15:12', 100), bar('15:13', 101), bar('15:14', 99), bar('15:15', 98), bar('15:16', 60, 50, 99)]
  const p = position({ entryTime: ist('15:12'), levelLog: punchLevelLog(levels(20, 30), ist('15:12')) })
  assert.equal(paperExitHit(late, p, { asOfMs: ist('15:15') }), null)
  assert.deepEqual(paperExitHit(late, p, { asOfMs: ist('15:16') }), { kind: 'sl', fillPrice: 80, at: ist('15:16') })
  const noStop = position({ noStop: true, levelLog: undefined, entryTime: ist('15:12') })
  assert.equal(paperExitHit(late, noStop, { asOfMs: ist('15:14') }), null)
  assert.deepEqual(paperExitHit(late, noStop, { asOfMs: ist('15:15') }), { kind: 'dayEnd', fillPrice: 98, at: ist('15:15') })
  // Live / another chain: the clock is given apart from the points.
  assert.deepEqual(paperExitHit(late.slice(0, 3), noStop, { asOfMs: null, clockMs: ist('15:15', 20) }), { kind: 'dayEnd', fillPrice: 99, at: ist('15:15') })
  assert.equal(paperExitHit(late, { ...p, status: 'CLOSED' }, { asOfMs: ist('15:20') }), null)
})
