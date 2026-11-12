import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOiTotalsRows, oiMeaning, oiTotalsDeclined, oiTotalsFlowMeaning, oiTotalsMeaning, oiTotalsTrend, withOrderFlowRows } from '../src/oiTotalsHeatmap.js'

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

// Asked for: the futures ORDER FLOW's delta and cumulative delta as rows after the OI net cumulative, per the table's
// bucket (3 min), live. The OI buckets are chart seconds (IST-shifted, as toChartTime).
const MIN = 60_000
const T915 = Date.parse('2026-10-05T03:45:00Z') // 09:15 IST
const chartSec = (ms) => Math.floor(ms / 1000) + 5.5 * 3600
const col = (minute) => chartSec(T915 + minute * MIN) // a bucket's chart time, `minute` minutes after 09:15
const flowMinutes = [
  { ms: T915, delta: 100 }, { ms: T915 + 1 * MIN, delta: -30 }, { ms: T915 + 2 * MIN, delta: 10 }, // 09:15 bucket +80
  { ms: T915 + 3 * MIN, delta: 50 }, { ms: T915 + 4 * MIN, delta: -20 },                          // 09:18 bucket +30
  { ms: T915 + 9 * MIN, delta: -40 }, { ms: T915 + 10 * MIN, delta: -10 },                        // 09:24 bucket -50 (09:21 none)
  { ms: T915 + 12 * MIN, delta: 999 },                                                             // after the clock
]
const oiTotals = () => {
  const ce = new Map([[100, new Map([[col(3), 10], [col(6), 5], [col(9), -2]])]])
  const pe = new Map([[100, new Map([[col(3), 4], [col(6), 1], [col(9), 3]])]])
  return buildOiTotalsRows(ce, pe)
}

test('order flow rows: each bucket\'s delta and the cumulative from the first minute, in the OI columns, nothing after the clock', () => {
  const totals = oiTotals()
  const out = withOrderFlowRows(totals, flowMinutes, 180, T915 + 11 * MIN + 30_000)
  assert.deepEqual(out.buckets, totals.buckets)
  assert.deepEqual([...out.rows.flowDelta.entries()], [[col(3), 30], [col(6), 0], [col(9), -50]])
  // The 09:15 bucket has no OI column (a change needs the bucket before) - its +80 still opens the cumulative.
  assert.deepEqual([...out.rows.flowCum.entries()], [[col(3), 110], [col(6), 110], [col(9), 60]])
  // The OI rows are untouched.
  for (const key of ['ceDelta', 'ceCum', 'peDelta', 'peCum', 'netDelta', 'netCum']) assert.equal(out.rows[key], totals.rows[key])
  // Buyers ahead = bullish, a selling bucket bearish; the cumulative still bullish but falling in 09:24 (weakening).
  assert.equal(oiTotalsMeaning(out.rows, 'flowDelta', col(3)), 1)
  assert.equal(oiTotalsMeaning(out.rows, 'flowDelta', col(9)), -1)
  assert.equal(oiTotalsMeaning(out.rows, 'flowCum', col(9)), 1)
  assert.equal(oiTotalsFlowMeaning(out.rows, 'flowCum', col(9)), -1)
  assert.equal(oiTotalsTrend(out.rows, 'flowCum', col(6)), 0)
  assert.equal(oiTotalsDeclined(out.rows, 'flowCum', col(9)), true)
  // The clock taken back: the 09:24 bucket's minutes are not known yet, so neither are their figures.
  const earlier = withOrderFlowRows(totals, flowMinutes, 180, T915 + 8 * MIN)
  assert.deepEqual([...earlier.rows.flowCum.entries()], [[col(3), 110], [col(6), 110], [col(9), 110]])
  assert.equal(earlier.rows.flowDelta.get(col(9)), 0)
})

test('order flow rows: no minutes, or none yet - the totals as they were; a flow starting late leaves the columns before it empty', () => {
  const totals = oiTotals()
  assert.equal(withOrderFlowRows(totals, null, 180), totals)
  assert.equal(withOrderFlowRows(totals, [], 180), totals)
  assert.equal(withOrderFlowRows(totals, flowMinutes, 180, T915 - MIN), totals)
  const late = withOrderFlowRows(totals, flowMinutes.slice(5), 180, T915 + 11 * MIN)
  assert.equal(late.rows.flowDelta.has(col(3)), false)
  assert.equal(late.rows.flowCum.has(col(6)), false)
  assert.deepEqual([...late.rows.flowCum.entries()], [[col(9), -50]])
})

test('order flow rows: estimated minutes (the server recorded the day part way) mark their bucket and every cumulative after', () => {
  const minutes = flowMinutes.map((m, i) => (i < 2 ? { ...m, estimated: true } : m))
  const out = withOrderFlowRows(oiTotals(), minutes, 180, T915 + 11 * MIN)
  assert.deepEqual([...out.estimated.flowDelta], [])                        // the 09:15 bucket has no column
  assert.deepEqual([...out.estimated.flowCum], [col(3), col(6), col(9)])     // its minutes are in every cumulative
  const mid = withOrderFlowRows(oiTotals(), flowMinutes.map((m, i) => (i === 3 ? { ...m, estimated: true } : m)), 180, T915 + 11 * MIN)
  assert.deepEqual([...mid.estimated.flowDelta], [col(3)])
})

test('order flow rows on a replayed day: at any clock, every bucket already finished reads as the whole day\'s', () => {
  const totals = oiTotals()
  const whole = withOrderFlowRows(totals, flowMinutes, 180)
  for (let m = 0; m <= 13; m++) {
    const clock = T915 + m * MIN                                         // the replay clock: the minute shown (counted whole)
    const cut = withOrderFlowRows(totals, flowMinutes, 180, clock)
    if (cut === totals) continue                                          // no column has a minute yet
    for (const t of totals.buckets) {
      if (t + 120 > chartSec(clock)) continue                             // its last minute not reached yet
      assert.equal(cut.rows.flowDelta.get(t), whole.rows.flowDelta.get(t), `delta ${t} at ${m}`)
      assert.equal(cut.rows.flowCum.get(t), whole.rows.flowCum.get(t), `cum ${t} at ${m}`)
    }
    // Nothing after the clock: the newest column's cumulative is the minutes up to the clock (its bucket's last is 09:26).
    const known = flowMinutes.filter((x) => x.ms <= clock && x.ms < T915 + 12 * MIN).reduce((a, x) => a + x.delta, 0)
    assert.equal(cut.rows.flowCum.get(col(9)), known, `newest at ${m}`)
  }
})
