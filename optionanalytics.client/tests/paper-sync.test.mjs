import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyChange, diffPositions, rebasePositions } from '../src/paperSync.js'

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

test('applyChange applies a diff: clear, removes, then upserts (replaced in place or added)', () => {
  const list = [pos('1'), pos('2')]
  assert.deepEqual(applyChange(list, null), list)
  assert.deepEqual(applyChange(list, diffPositions(list, [pos('2'), pos('3')])), [pos('2'), pos('3')])
  const closed = pos('1', { status: 'CLOSED', exitPrice: 90 })
  assert.deepEqual(applyChange(list, { upsert: [closed], remove: [], clear: false }), [closed, pos('2')])
  assert.deepEqual(applyChange(list, { upsert: [], remove: [], clear: true }), [])
})

test('a server answer never undoes a change the page made since, nor drops another browser\'s', () => {
  // A punched (sent); B punched while A was on its way; the answer holds A only - B stays on the page (and is sent next).
  assert.deepEqual(rebasePositions([pos('A')], [pos('A')], [pos('A'), pos('B')]), [pos('A'), pos('B')])
  // Another browser punched X meanwhile: both X and the page's own B are kept - X is not sent back as a removal.
  const page = rebasePositions([pos('A'), pos('X')], [pos('A')], [pos('A'), pos('B')])
  assert.deepEqual(page, [pos('A'), pos('X'), pos('B')])
  assert.deepEqual(diffPositions([pos('A'), pos('X')], page), { upsert: [pos('B')], remove: [], clear: false })
  // Another browser's SL closed A while this page left it alone: the page takes the close.
  const closed = pos('A', { status: 'CLOSED', exitPrice: 95, exitReason: 'SL' })
  assert.deepEqual(rebasePositions([closed], [pos('A')], [pos('A')]), [closed])
  // Clear all made on this page meanwhile wins.
  assert.deepEqual(rebasePositions([pos('A'), pos('X')], [pos('A')], []), [])
  // Nothing changed here: the server's copy as it is (the first answer of the day included).
  assert.deepEqual(rebasePositions([pos('A'), pos('X')], [pos('Z')], [pos('Z')]), [pos('A'), pos('X')])
})
