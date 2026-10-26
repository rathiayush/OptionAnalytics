import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readoutPlacement } from '../src/readoutPlacement.js'

test('desktop: beside the pointer on the roomier side, never wider than that room', () => {
  assert.deepEqual(readoutPlacement(300, 200, 1600, 900), { left: 314, width: 'max-content', maxWidth: 1278, top: 214 })
  // Right half: anchored by its right edge to the left of the pointer - it can not run off the left edge.
  assert.deepEqual(readoutPlacement(1500, 200, 1600, 900), { right: 114, width: 'max-content', maxWidth: 1478, top: 214 })
})

test('near the bottom it opens above the pointer', () => {
  assert.deepEqual(readoutPlacement(300, 850, 1600, 900), { left: 314, width: 'max-content', maxWidth: 1278, bottom: 64 })
})

test('a phone: no side has the room - it spans the screen and wraps', () => {
  assert.deepEqual(readoutPlacement(200, 300, 390, 844), { left: 8, right: 8, top: 314 })
  assert.deepEqual(readoutPlacement(380, 300, 390, 844), { right: 24, width: 'max-content', maxWidth: 358, top: 314 })
})
