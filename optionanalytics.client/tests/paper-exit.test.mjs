import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dayEndExit, paperExitReason, paperExitTime, paperSquareOffMs } from '../src/paperExit.js'

// The trade panel's "No SL" paper position: no stop-loss / target, squared off at 15:15 of its day.
const ist = (hhmm) => Date.parse(`2026-10-22T${hhmm}:00+05:30`)
const series = ['15:13', '15:14', '15:15', '15:16'].map((t, i) => ({ time: new Date(ist(t)).toISOString(), price: 100 + i }))
const position = { id: 'p', noStop: true, status: 'OPEN', entryTime: ist('10:05'), entryPrice: 90, lastPrice: 95 }

test('a No SL position stays open until 15:15, then is squared off at that minute', () => {
  assert.equal(paperSquareOffMs(ist('10:05')), ist('15:15'))
  assert.equal(dayEndExit(position, ist('15:14'), series), null)
  assert.deepEqual(dayEndExit(position, ist('15:15'), series), { kind: 'dayEnd', fillPrice: 102, at: ist('15:15') })
  assert.deepEqual(dayEndExit(position, ist('15:29'), series), { kind: 'dayEnd', fillPrice: 102, at: ist('15:15') }) // a later look still takes 15:15's, at 15:15
  assert.deepEqual(dayEndExit(position, ist('15:20'), []), { kind: 'dayEnd', fillPrice: 95, at: ist('15:15') })    // no prices: its last known
  assert.equal(paperExitReason('dayEnd'), 'Day end')
})

test('only open No SL positions are squared off this way', () => {
  assert.equal(dayEndExit({ ...position, noStop: false }, ist('15:20'), series), null)
  assert.equal(dayEndExit({ ...position, status: 'CLOSED' }, ist('15:20'), series), null)
  assert.equal(dayEndExit(position, null, series), null)
})

test('an auto exit is timed at the second it was seen live, else at the earlier minute it hit in', () => {
  const at = ist('10:15')
  assert.equal(paperExitTime(at, at + 32_000), at + 32_000)      // live, in the minute it hit: 10:15:32
  assert.equal(paperExitTime(at, ist('10:40')), at)               // seen later (a page opened after it): 10:15:00
  assert.equal(paperExitTime(at, at), at)                         // a replay at that minute
  assert.equal(paperExitTime(null, at + 5_000), at + 5_000)       // no minute of its own: the clock
  assert.equal(paperExitTime(at, null), at)
})
