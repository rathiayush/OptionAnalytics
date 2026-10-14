import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOiTotalsRows, oiMeaning, oiTotalsDeclined, oiTotalsFlowMeaning, oiTotalsMeaning, oiTotalsTrend } from '../src/oiTotalsHeatmap.js'

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

test('declined: a negative delta, and a cumulative that fell from the bucket before (even while positive)', () => {
  const ce = m({ 100: { 60: 10, 120: -4, 180: 0 } })
  const pe = m({ 100: { 60: 2, 120: 8, 180: 1 } })
  const { rows } = buildOiTotalsRows(ce, pe)
  // CE: +10, -4 (cum 10 -> 6, still positive but falling), 0
  assert.equal(oiTotalsDeclined(rows, 'ceDelta', 60), false)
  assert.equal(oiTotalsDeclined(rows, 'ceDelta', 120), true)
  assert.equal(rows.ceCum.get(120), 6)
  assert.equal(oiTotalsDeclined(rows, 'ceCum', 120), true)
  assert.equal(oiTotalsDeclined(rows, 'ceCum', 180), false)
  // PE only rose
  for (const t of [60, 120, 180]) assert.equal(oiTotalsDeclined(rows, 'peCum', t), false)
  // Net: +8, -12 (cum 8 -> -4), -1 (cum -4 -> -5)
  assert.equal(oiTotalsDeclined(rows, 'netDelta', 60), false)
  assert.equal(oiTotalsDeclined(rows, 'netDelta', 120), true)
  assert.equal(oiTotalsDeclined(rows, 'netCum', 180), true)
  assert.deepEqual([60, 120, 180].map((t) => oiTotalsTrend(rows, 'ceCum', t)), [1, -1, 0])
  assert.deepEqual([60, 120, 180].map((t) => oiTotalsTrend(rows, 'netCum', t)), [1, -1, -1])
})

test('empty input gives no buckets', () => {
  assert.deepEqual(buildOiTotalsRows(new Map(), new Map()).buckets, [])
})

test('market meaning: PE added / CE removed bullish, CE added / PE removed bearish, net negative bullish', () => {
  assert.equal(oiMeaning('peDelta', 5), 1, 'PE rose: green')
  assert.equal(oiMeaning('peDelta', -5), -1, 'PE fell: red')
  assert.equal(oiMeaning('ceDelta', 5), -1, 'CE rose: red')
  assert.equal(oiMeaning('ceDelta', -5), 1, 'CE fell: green')
  assert.equal(oiMeaning('netCum', -871e5), 1, 'net negative: PE writers dominate - green')
  assert.equal(oiMeaning('netCum', 10e5), -1, 'net positive: CE writers dominate - red')
  assert.equal(oiMeaning('peCum', 0), 0)
  assert.equal(oiMeaning('ceDelta', null), 0)

  // The screenshot's 10:57: PE -6.12L in the bucket while PE cumulative is still +821L and net cumulative -812L.
  const ce = m({ 100: { 60: 9e5, 120: 4.54e5 } })
  const pe = m({ 100: { 60: 827.34e5, 120: -6.12e5 } })
  const { rows } = buildOiTotalsRows(ce, pe)
  assert.equal(oiTotalsMeaning(rows, 'peDelta', 120), -1, 'PE removed: bearish bucket')
  assert.equal(oiTotalsMeaning(rows, 'peCum', 120), 1, 'PE still ahead on the day: bullish')
  assert.equal(oiTotalsFlowMeaning(rows, 'peCum', 120), -1, '... but it fell in that bucket')
  assert.equal(oiTotalsMeaning(rows, 'ceCum', 120), -1, 'CE added on the day: bearish')
  assert.equal(oiTotalsMeaning(rows, 'netCum', 120), 1, 'net cumulative negative: bullish')
  assert.equal(oiTotalsMeaning(rows, 'netDelta', 120), -1, 'net rose in the bucket (CE +4.54L, PE -6.12L): bearish')
  assert.equal(oiTotalsFlowMeaning(rows, 'netCum', 120), -1)
  assert.equal(oiTotalsFlowMeaning(rows, 'netDelta', 60), 1)
})
