// The page alerts' switches (alertSwitches.js) - kept under the removed strategy scanner's key, a missing one on.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ALERT_SWITCHES_KEY, alertSwitches, readAlertSwitches } from '../src/alertSwitches.js'

const store = new Map()
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }

test('nothing saved = every switch on', () => {
  store.clear()
  assert.deepEqual(readAlertSwitches(), {})
  assert.deepEqual(alertSwitches(), { alerts: true, sound: true, voice: true, telegram: true })
})

test('what the scanner card saved still holds; a broken save reads as none', () => {
  store.set(ALERT_SWITCHES_KEY, JSON.stringify({ voice: false, telegram: false, pick: 'top15' }))
  assert.deepEqual(alertSwitches(), { alerts: true, sound: true, voice: false, telegram: false })
  store.set(ALERT_SWITCHES_KEY, '{not json')
  assert.deepEqual(readAlertSwitches(), {})
  store.set(ALERT_SWITCHES_KEY, '5')
  assert.deepEqual(readAlertSwitches(), {})
})
