// The Tick Flow page shows only while the server has TrueData on (`trueData` in /api/auth/me) - its menu entry and its route.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FEATURE_PATHS, featureOn } from '../src/featurePaths.js'

test('the Tick Flow page needs the server\'s TrueData switch; every other page is always on', () => {
  assert.equal(FEATURE_PATHS['/tick-flow'], 'trueData')
  assert.equal(featureOn({ trueData: true }, '/tick-flow'), true)
  assert.equal(featureOn({ trueData: false }, '/tick-flow'), false)
  assert.equal(featureOn({}, '/tick-flow'), false)
  assert.equal(featureOn(null, '/tick-flow'), false)
  assert.equal(featureOn(null, '/order-flow'), true)
  assert.equal(featureOn({ trueData: false }, '/oi-replay'), true)
})
