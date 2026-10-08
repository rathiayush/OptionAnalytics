import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOiTotalsRows } from '../src/oiTotalsHeatmap.js'

const m = (o) => new Map(Object.entries(o).map(([k, v]) => [Number(k), new Map(Object.entries(v).map(([t, x]) => [Number(t), x]))]))

test('sums strikes per bucket, accumulates, and nets CE - PE', () => {
  const ce = m({ 100: { 60: 10, 120: -4 }, 150: { 60: 5, 120: 1 } })
  const pe = m({ 100: { 60: 2, 120: 8 }, 150: { 120: -3 } })
  const { buckets, rows } = buildOiTotalsRows(ce, pe)
  assert.deepEqual(buckets, [60, 120])
  assert.deepEqual([...rows.ceDelta.values()], [15, -3])
  assert.deepEqual([...rows.ceCum.values()], [15, 12])
  assert.deepEqual([...rows.peDelta.values()], [2, 5])
  assert.deepEqual([...rows.peCum.values()], [2, 7])
  assert.deepEqual([...rows.netDelta.values()], [13, -8])
  assert.deepEqual([...rows.netCum.values()], [13, 5])
})

test('a bucket only one side has counts as zero for the other', () => {
  const { buckets, rows } = buildOiTotalsRows(m({ 100: { 60: 7 } }), m({ 100: { 120: 3 } }))
  assert.deepEqual(buckets, [60, 120])
  assert.equal(rows.peDelta.get(60), 0)
  assert.equal(rows.ceCum.get(120), 7)
  assert.equal(rows.netCum.get(120), 4)
})

test('empty input gives no buckets', () => {
  assert.deepEqual(buildOiTotalsRows(new Map(), new Map()).buckets, [])
})
