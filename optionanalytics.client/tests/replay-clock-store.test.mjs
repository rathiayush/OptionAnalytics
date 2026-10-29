import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LAST_CLOCK_KEY, LAST_CLOCK_MAX_AGE_MS, lastClockRecord, readLastClock } from '../src/replayClockStore.js'
import { isPreferenceKey } from '../src/prefsSync.js'

const NOW = Date.parse('2026-10-29T06:00:00Z')

test('OI Replay\'s last clock is kept and read back as it was', () => {
  const state = { underlying: 'BANKNIFTY', date: '2026-10-28', loadingDate: null, failedDate: null, ms: Date.parse('2026-10-28T06:36:00Z'), live: false, playing: true }
  const back = readLastClock(lastClockRecord(state, NOW), NOW + 5 * 60_000)
  assert.deepEqual(back, { ...state, savedAt: NOW })
  // A day still loading, and live, come back too.
  assert.equal(readLastClock(lastClockRecord({ underlying: 'NIFTY', loadingDate: '2026-10-27' }, NOW), NOW).loadingDate, '2026-10-27')
  const live = readLastClock(lastClockRecord({ underlying: 'SENSEX', live: true }, NOW), NOW)
  assert.equal(live.live, true)
  assert.equal(live.ms, null)
})

test('a stale, future-dated or broken record is not taken up', () => {
  const record = lastClockRecord({ underlying: 'NIFTY', date: '2026-10-28', ms: NOW - 86_400_000 }, NOW)
  assert.notEqual(readLastClock(record, NOW + LAST_CLOCK_MAX_AGE_MS), null)
  assert.equal(readLastClock(record, NOW + LAST_CLOCK_MAX_AGE_MS + 1), null)  // too old: the page's own choice
  assert.equal(readLastClock(record, NOW - 5 * 60_000), null)                 // saved "later" than now
  assert.equal(readLastClock('{not json', NOW), null)
  assert.equal(readLastClock(JSON.stringify({ date: '2026-10-28', savedAt: NOW }), NOW), null) // no index
  assert.equal(readLastClock(null, NOW), null)
  assert.equal(lastClockRecord({ date: '2026-10-28' }, NOW), null)            // nothing to keep without an index
  // OI Replay just opened, no day yet: nothing kept - the day it was last left on stays.
  assert.equal(lastClockRecord({ underlying: 'NIFTY', date: null, live: false }, NOW), null)
})

test('the kept clock stays in this browser - it changes every replay step', () => {
  assert.equal(isPreferenceKey(LAST_CLOCK_KEY), false)
})
