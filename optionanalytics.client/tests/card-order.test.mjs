import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileCardOrder } from '../src/cardOrder.js'

const IDS = ['topStats', 'marketRead', 'spotAndEntry', 'optionPremium', 'optionFlow', 'ladder', 'futures']

test('a card added since the order was saved goes after the card before it, not at the end', () => {
  const saved = ['topStats', 'marketRead', 'spotAndEntry', 'optionPremium', 'ladder', 'futures']
  assert.deepEqual(reconcileCardOrder(saved, IDS), IDS)
})

test('the viewer\'s own arrangement is kept, the new card follows its default neighbour wherever that was moved', () => {
  const saved = ['futures', 'optionPremium', 'topStats', 'marketRead', 'spotAndEntry', 'ladder']
  assert.deepEqual(reconcileCardOrder(saved, IDS), ['futures', 'optionPremium', 'optionFlow', 'topStats', 'marketRead', 'spotAndEntry', 'ladder'])
})

test('a new first card goes on top; removed or repeated ids are dropped; nothing saved gives the default', () => {
  assert.deepEqual(reconcileCardOrder(['b', 'c'], ['a', 'b', 'c']), ['a', 'b', 'c'])
  assert.deepEqual(reconcileCardOrder(['a', 'gone', 'a', 'b'], ['a', 'b']), ['a', 'b'])
  assert.deepEqual(reconcileCardOrder(null, IDS), IDS)
})
