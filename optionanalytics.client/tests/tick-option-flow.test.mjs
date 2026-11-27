import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeFlowRows, optionFlowBuckets, optionFlowLines } from '../src/tickOptionFlow.js'

const MIN = 60_000
const T0 = Date.UTC(2026, 10, 25, 4, 0, 0)   // a minute start
const row = (k, symbol, type, buy, sell, open, close, lot = 65) => ({ t: T0 + k * MIN, symbol, type, strike: 25000, buy: buy * lot, sell: sell * lot, open, close, lot })

test('CDV is bought minus sold in lots, added over the side; OBV signs the volume by the premium direction', () => {
  const rows = [
    row(0, 'C1', 'CE', 10, 4, 100, 102),   // CDV +6, premium up   -> OBV +14
    row(0, 'C2', 'CE', 2, 3, 50, 49),      // CDV -1, premium down -> OBV -5
    row(0, 'P1', 'PE', 1, 8, 80, 78),      // CDV -7, premium down -> OBV -9
    row(1, 'C1', 'CE', 5, 5, 102, 102),    // CDV 0,  flat         -> OBV 0
  ]
  const b = optionFlowBuckets(rows, 1)
  assert.equal(b.length, 2)
  assert.deepEqual(b[0].ce, { cdv: 5, obv: 9 })
  assert.deepEqual(b[0].pe, { cdv: -7, obv: -9 })
  assert.deepEqual(b[1].ce, { cdv: 0, obv: 0 })
})

test('the OBV sign is the close against the option\'s PREVIOUS minute close (its own open for the first minute)', () => {
  const b = optionFlowBuckets([row(0, 'C1', 'CE', 3, 0, 100, 100), row(1, 'C1', 'CE', 4, 0, 99, 101)], 1)
  assert.equal(b[0].ce.obv, 0)          // first minute: open 100 = close 100
  assert.equal(b[1].ce.obv, 4)          // 101 against the previous close 100 (not its own open 99)
})

test('buckets of N minutes add their minutes; the lines are cumulative and net = CE - PE', () => {
  const rows = [row(0, 'C1', 'CE', 4, 0, 1, 2), row(1, 'C1', 'CE', 3, 0, 2, 3), row(2, 'C1', 'CE', 5, 1, 3, 4), row(0, 'P1', 'PE', 0, 2, 1, 0)]
  const b = optionFlowBuckets(rows, 2)
  assert.equal(b.length, 2)
  assert.equal(b[0].ce.cdv, 7)
  const l = optionFlowLines(b)
  assert.deepEqual(l.cdv.ce.map((p) => p.value), [7, 11])
  assert.deepEqual(l.cdv.pe.map((p) => p.value), [-2, -2])
  assert.deepEqual(l.cdv.net.map((p) => p.value), [9, 13])
  assert.deepEqual(l.last.cdv, { ce: 11, pe: -2, net: 13 })
})

test('a cut at a clock counts only the minutes completed by it (the whole day up to it)', () => {
  const rows = [row(0, 'C1', 'CE', 4, 0, 1, 2), row(1, 'C1', 'CE', 3, 0, 2, 3), row(2, 'C1', 'CE', 5, 1, 3, 4)]
  const cut = optionFlowBuckets(rows, 1, { upToMs: T0 + 2 * MIN })
  assert.deepEqual(cut, optionFlowBuckets(rows.slice(0, 2), 1))
})

test('merging replaces the minute the server repeats and keeps the rest', () => {
  const a = [row(0, 'C1', 'CE', 1, 0, 1, 1), row(1, 'C1', 'CE', 1, 0, 1, 1)]
  const merged = mergeFlowRows(a, [row(1, 'C1', 'CE', 9, 0, 1, 2), row(2, 'C1', 'CE', 2, 0, 2, 2)])
  assert.equal(merged.length, 3)
  assert.equal(merged[1].buy, 9 * 65)
  assert.equal(mergeFlowRows(a, []), a)
})
