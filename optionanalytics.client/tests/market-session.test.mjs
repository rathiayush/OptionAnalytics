// Charts show the F&O session only - 09:15 to 15:30 IST (marketSession.js): no minute after the close or before the
// open reaches them, whatever sent it (Dhan re-sends snapshots after the close).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inMarketSession } from '../src/marketSession.js'
import { mergeFuturesLive } from '../src/futuresLive.js'

const ist = (hhmm) => `2026-10-26T${hhmm}:00+05:30`

test('the session is 09:15 to 15:30 IST - 15:29 is the last minute', () => {
  assert.equal(inMarketSession(ist('09:14')), false)
  assert.equal(inMarketSession(ist('09:15')), true)
  assert.equal(inMarketSession(ist('15:29')), true)
  assert.equal(inMarketSession(ist('15:30')), false)
  assert.equal(inMarketSession(ist('16:57')), false)
  assert.equal(inMarketSession(Date.parse('2026-10-26T04:00:00Z')), true)    // 09:30 IST as UTC ms
  assert.equal(inMarketSession('not a time'), false)
})

test('the futures chart keeps no minute after the close, from the run or the live feed', () => {
  const bar = (hhmm, close) => ({ time: ist(hhmm), open: close, high: close, low: close, close, volume: 1 })
  const merged = mergeFuturesLive([bar('15:28', 100), bar('15:29', 101), bar('15:31', 101)], [bar('15:45', 101), bar('16:57', 101)])
  assert.deepEqual(merged.map((b) => b.time), [ist('15:28'), ist('15:29')])
})
