import test from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeLine } from '../src/chartLine.js'
import { dashboardFlowFromSeries } from '../src/dashboardFlow.js'

test('a line handed to the chart is in time order, one point per time (the later one), finite values only', () => {
  const points = [{ time: 3, value: 30 }, { time: 1, value: 10 }, { time: 2, value: 20 }, { time: 2, value: 21 }, { time: 4, value: NaN }, { time: 5, value: null }, null]
  assert.deepEqual(sanitizeLine(points), [{ time: 1, value: 10 }, { time: 2, value: 21 }, { time: 3, value: 30 }])
  assert.deepEqual(sanitizeLine(undefined), [])
})

test("the dashboard's CDV series with a repeated and an out-of-order minute comes out clean", () => {
  const cdv = [
    { time: '2026-10-21T03:46:00Z', ceCdv: 3, peCdv: 1 },
    { time: '2026-10-21T03:45:00Z', ceCdv: 1, peCdv: 2 }, // out of order (a backfill joined in front)
    { time: '2026-10-21T03:46:00Z', ceCdv: 4, peCdv: 0 }, // the same minute again
  ]
  const flow = dashboardFlowFromSeries(cdv, null)
  assert.deepEqual(flow.ceCdv.map((p) => p.value), [1, 4])
  assert.ok(flow.ceCdv[0].time < flow.ceCdv[1].time)
})
