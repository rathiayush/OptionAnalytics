// The delta profiles' standout rows (deltaRanks.js): the 1st / 2nd biggest buying and selling rows, each its own colour.
import test from 'node:test'
import assert from 'node:assert/strict'
import { deltaRanks, RANK_COLORS, RANK_TAGS } from '../src/deltaRanks.js'

const rows = [
  { price: 100, delta: 50 }, { price: 105, delta: 80 }, { price: 110, delta: 20 },
  { price: 115, delta: -30 }, { price: 120, delta: -90 }, { price: 125, delta: -60 }, { price: 130, delta: 0 },
]

test('the two biggest buying and the two biggest selling rows, by size', () => {
  const r = deltaRanks(rows)
  assert.deepEqual([...r.entries()].sort((a, b) => a[0] - b[0]), [[100, 'buy2'], [105, 'buy1'], [120, 'sell1'], [125, 'sell2']])
})

test('the option OI\'s CE − PE: negative is bullish, so it ranks as buying', () => {
  const r = deltaRanks(rows, true)
  assert.equal(r.get(120), 'buy1')
  assert.equal(r.get(125), 'buy2')
  assert.equal(r.get(105), 'sell1')
  assert.equal(r.get(100), 'sell2')
})

test('one row a side, none, zeros and junk; equal sizes keep the higher price first', () => {
  assert.deepEqual([...deltaRanks([{ price: 1, delta: 5 }]).entries()], [[1, 'buy1']])
  assert.equal(deltaRanks([]).size, 0)
  assert.equal(deltaRanks(null).size, 0)
  assert.equal(deltaRanks([{ price: 1, delta: 0 }, { price: 2, delta: NaN }, null]).size, 0)
  const tie = deltaRanks([{ price: 10, delta: 7 }, { price: 20, delta: 7 }])
  assert.equal(tie.get(20), 'buy1')
  assert.equal(tie.get(10), 'buy2')
})

test('four distinct colours and tags', () => {
  assert.equal(new Set(Object.values(RANK_COLORS)).size, 4)
  assert.deepEqual(RANK_TAGS, { buy1: 'B1', buy2: 'B2', sell1: 'S1', sell2: 'S2' })
})
