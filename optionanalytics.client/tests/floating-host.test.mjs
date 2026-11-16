import test from 'node:test'
import assert from 'node:assert/strict'
import { floatingHost, floatingModeFor } from '../src/floatingHost.js'

test('the floating buttons: OI Replay draws its own, Profiles and Order Flow launch them, no other page has them', () => {
  assert.equal(floatingModeFor('/oi-replay'), 'own')
  assert.equal(floatingModeFor('/oi-replay/'), 'own')
  assert.equal(floatingModeFor('/profiles'), 'launch')
  assert.equal(floatingModeFor('/order-flow'), 'launch')
  for (const p of ['/', '/signal-backtest', '/trade-settings', '/cache', '/telegram-signals', '', null, undefined]) assert.equal(floatingModeFor(p), null, String(p))
})

test('a launch mounts the host and its action is taken once; the launchers step aside only when the host has its buttons', () => {
  floatingHost.reset()
  assert.deepEqual(floatingHost.get(), { hostOn: false, pending: null, fabsShown: false })
  let calls = 0
  const off = floatingHost.subscribe(() => { calls++ })
  floatingHost.launch({ type: 'view', key: 'gex' })
  assert.equal(floatingHost.get().hostOn, true)
  assert.deepEqual(floatingHost.get().pending, { type: 'view', key: 'gex' })
  assert.deepEqual(floatingHost.take(), { type: 'view', key: 'gex' })
  assert.equal(floatingHost.take(), null) // once
  assert.equal(floatingHost.get().pending, null)
  floatingHost.setFabsShown(true)
  assert.equal(floatingHost.get().fabsShown, true)
  const before = calls
  floatingHost.setFabsShown(true) // no change - no notification
  assert.equal(calls, before)
  floatingHost.setFabsShown(false)
  assert.equal(floatingHost.get().fabsShown, false)
  // A later tap with the host already on is carried out too.
  floatingHost.launch({ type: 'order' })
  assert.deepEqual(floatingHost.take(), { type: 'order' })
  off()
  floatingHost.reset()
})
