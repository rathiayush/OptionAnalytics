// The OI totals S/R break and 🎯 alerts while a past day is REPLAYED on the OI Replay page (stepReplayOiBreakAlerts) -
// on the replay clock, nothing after it, the same as they fired live - and the page's "Alerts" choice (oiAlertTypes.js).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  changesFromLevels, newOiBreakAlertState, newReplayOiBreakAlertState, perStrikeLevels, stepOiBreakAlerts, stepReplayOiBreakAlerts,
} from '../src/oiLevelBreaks.js'
import { ALERT_TYPES, DEFAULT_ALERT_TYPES, pickOiAlerts, reconcileAlertTypes } from '../src/oiAlertTypes.js'

// The ATM strike's CE OI = BASE + 1000 x the pattern: two swing lows, then a hard fall through them at minute 16 - the
// CE (and Net) cumulative lines break their support and the ATM ± 1 CE OI falls ~29%: a 🎯 bullish signal (the same
// day as tests/oi-level-breaks.test.mjs).
const T0 = Date.UTC(2026, 9, 23, 9, 15) / 1000
const BIG = [120, 110, 100, 80, 60, 80, 100, 120, 100, 80, 60, 80, 100, 120, 100, 80, -200, -210, -205, -200, -190]
const BREAK_AT = 16

// The day's data from its first `n` minutes - live, the page only has what has come in so far.
function dayData(n, base = 300_000, strikes = [50, 100, 150]) {
  const ceSeries = new Map(strikes.map((k) => [k, []]))
  const peSeries = new Map(strikes.map((k) => [k, []]))
  for (let i = 0; i < n; i++) {
    const t = (T0 - 19_800 + i * 60) * 1000
    for (const k of strikes) {
      ceSeries.get(k).push({ t, oi: base + (k === 100 ? 1000 * BIG[i] : 0) })
      peSeries.get(k).push({ t, oi: base })
    }
  }
  const ceLevels = perStrikeLevels(ceSeries, 60)
  const peLevels = perStrikeLevels(peSeries, 60)
  return { ce: changesFromLevels(ceLevels), pe: changesFromLevels(peLevels), ceLevels, peLevels, bucketSeconds: 60, atmStrike: 100 }
}
const FULL = dayData(BIG.length)
// The replay clock after minute i is shown: the end of that minute (a minute's point holds its close).
const clockAfter = (i) => T0 + (i + 1) * 60
const summary = ({ breaks, signals }) => [...breaks.map((b) => `${b.side.key}|${b.up ? 'up' : 'down'}`), ...signals.map((s) => `hp|${s.hp.bullish ? 'bull' : 'bear'}`)]

// Plays the replay minute by minute over `minutes` (indices of the minute shown), the WHOLE day's data loaded.
function replay(minutes, replayState = newReplayOiBreakAlertState()) {
  const out = []
  for (const i of minutes) {
    const step = stepReplayOiBreakAlerts(replayState, { ...FULL, nowSec: clockAfter(i) })
    for (const s of summary(step)) out.push(`${i}:${s}`)
  }
  return { out, replayState }
}
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, k) => from + k)

test('replayed, the break and the 🎯 fire at the minute they did live - nothing earlier', () => {
  const { out } = replay(range(0, BIG.length - 1))
  // Live: the data grows a minute at a time and the clock is the end of the last minute in.
  const live = []
  const state = newOiBreakAlertState()
  for (let i = 0; i < BIG.length; i++) {
    for (const s of summary(stepOiBreakAlerts(state, { ...dayData(i + 1), nowSec: clockAfter(i) }))) live.push(`${i}:${s}`)
  }
  assert.deepEqual(out, live)
  assert.ok(out.includes(`${BREAK_AT}:ce|down`), out.join(', '))
  assert.ok(out.includes(`${BREAK_AT}:hp|bull`), out.join(', '))
  assert.ok(out.every((x) => Number(x.split(':')[0]) >= BREAK_AT), 'nothing before the break minute is shown')
})

test('no look-ahead: at every replay minute the whole day loaded reads exactly as the day up to that minute', () => {
  const ahead = newReplayOiBreakAlertState()
  const upTo = newReplayOiBreakAlertState()
  for (let i = 0; i < BIG.length; i++) {
    const a = summary(stepReplayOiBreakAlerts(ahead, { ...FULL, nowSec: clockAfter(i) }))
    const b = summary(stepReplayOiBreakAlerts(upTo, { ...dayData(i + 1), nowSec: clockAfter(i) }))
    assert.deepEqual(a, b, `minute ${i}`)
  }
})

test('the same minute again (a re-render, a pause) announces nothing twice', () => {
  const { replayState } = replay(range(0, BREAK_AT))
  assert.deepEqual(summary(stepReplayOiBreakAlerts(replayState, { ...FULL, nowSec: clockAfter(BREAK_AT) })), [])
})

test('the slider taken back starts the watch again: played forward, the break is announced again', () => {
  const { replayState } = replay(range(0, BIG.length - 1))
  // Back to 10:25 - what is broken there (nothing yet) is only noted.
  assert.deepEqual(replay([10], replayState).out, [])
  const again = replay(range(11, BREAK_AT), replayState).out
  assert.ok(again.includes(`${BREAK_AT}:ce|down`) && again.includes(`${BREAK_AT}:hp|bull`), again.join(', '))
})

test('a jump forward announces only what is fresh at the new clock, not every break it skipped', () => {
  const { replayState } = replay(range(0, 10))
  // Straight to 4 minutes after the break: it is stale there.
  assert.deepEqual(replay([BREAK_AT + 4], replayState).out, [])
  // A replay opened (or jumped to) right at the break minute: the watch seeds there, announcing nothing.
  assert.deepEqual(replay([BREAK_AT]).out, [])
})

test('the Alerts choice: 🎯 and the CE / PE breaks by default - the Net break only when added', () => {
  assert.deepEqual(DEFAULT_ALERT_TYPES, ['hp', 'ceBreak', 'peBreak'])
  const state = newReplayOiBreakAlertState()
  replay(range(0, BREAK_AT - 1), state)
  const step = stepReplayOiBreakAlerts(state, { ...FULL, nowSec: clockAfter(BREAK_AT) })
  assert.deepEqual(step.breaks.map((b) => b.side.key).sort(), ['ce', 'net'])   // PE is flat: the Net line breaks too
  assert.deepEqual(summary(pickOiAlerts(step, DEFAULT_ALERT_TYPES)), ['ce|down', 'hp|bull'])
  assert.deepEqual(summary(pickOiAlerts(step, [...DEFAULT_ALERT_TYPES, 'netBreak'])).sort(), ['ce|down', 'hp|bull', 'net|down'])
  assert.deepEqual(summary(pickOiAlerts(step, ['hp'])), ['hp|bull'])                // "only the 🎯"
  assert.deepEqual(summary(pickOiAlerts(step, [])), [])
})

test('the saved choice: unknown alerts dropped, the page\'s order kept, an empty choice kept, nothing saved = default', () => {
  assert.deepEqual(reconcileAlertTypes(null), DEFAULT_ALERT_TYPES)
  assert.deepEqual(reconcileAlertTypes('hp'), DEFAULT_ALERT_TYPES)
  assert.deepEqual(reconcileAlertTypes(['zone', 'gone', 'hp']), ['hp', 'zone'])
  assert.deepEqual(reconcileAlertTypes([]), [])
  assert.equal(new Set(ALERT_TYPES.map((t) => t.value)).size, ALERT_TYPES.length)
})
