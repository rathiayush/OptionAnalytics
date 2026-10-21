import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffPositions } from '../src/paperSync.js'

// OI Replay's paper positions are kept on the server per account and day: the page sends only what changed.
const pos = (id, extra = {}) => ({ id, side: 'CE', strike: 25600, direction: 'BUY', qtyLots: 1, lotSize: 75, entryPrice: 120, status: 'OPEN', exitPrice: null, ...extra })

test('a punch is sent as a new position, an exit as that position changed', () => {
  assert.equal(diffPositions([pos('1')], [pos('1')]), null)
  assert.deepEqual(diffPositions([pos('1')], [pos('1'), pos('2')]), { upsert: [pos('2')], remove: [], clear: false })
  const closed = pos('1', { status: 'CLOSED', exitPrice: 100, exitReason: 'SL' })
  assert.deepEqual(diffPositions([pos('1'), pos('2')], [closed, pos('2')]), { upsert: [closed], remove: [], clear: false })
})

test('Clear all is a clear; nothing known yet sends every position the page has', () => {
  assert.deepEqual(diffPositions([pos('1'), pos('2')], []), { upsert: [], remove: [], clear: true })
  assert.deepEqual(diffPositions([], [pos('1')]), { upsert: [pos('1')], remove: [], clear: false })
  assert.equal(diffPositions([], []), null)
  assert.deepEqual(diffPositions([pos('1'), pos('2')], [pos('2')]), { upsert: [], remove: ['1'], clear: false })
})
