import test from 'node:test'
import assert from 'node:assert/strict'
import { dashboardFlowFromSeries, withCurrentBar } from '../src/dashboardFlow.js'

const at = (iso) => new Date(iso).getTime()

test("the dashboard's series is cut to today and shaped like the page's own", () => {
  const cdv = [
    { time: '2026-10-20T09:59:00Z', ceCdv: 5, peCdv: -5 }, // yesterday (IST 15:29)
    { time: '2026-10-21T03:45:00Z', ceCdv: 1, peCdv: 2 },
    { time: '2026-10-21T03:46:00Z', ceCdv: 3, peCdv: 1 },
  ]
  const obv = { ce: [{ time: '2026-10-20T09:59:00Z', obv: 9 }, { time: '2026-10-21T03:46:00Z', obv: 4 }], pe: [{ time: '2026-10-21T03:46:00Z', obv: -2 }] }
  const flow = dashboardFlowFromSeries(cdv, obv)
  assert.deepEqual(flow.ceCdv, [{ time: at('2026-10-21T03:45:00Z'), value: 1 }, { time: at('2026-10-21T03:46:00Z'), value: 3 }])
  assert.deepEqual(flow.peCdv.map((p) => p.value), [2, 1])
  assert.deepEqual(flow.ceObv, [{ time: at('2026-10-21T03:46:00Z'), value: 4 }])
  assert.deepEqual(flow.peObv, [{ time: at('2026-10-21T03:46:00Z'), value: -2 }])
})

test('the forming minute replaces the last one or is added after it, never before', () => {
  const flow = dashboardFlowFromSeries([{ time: '2026-10-21T03:45:00Z', ceCdv: 1, peCdv: 2 }], null)
  const same = withCurrentBar(flow, { time: '2026-10-21T03:45:00Z', ceCdv: 7, peCdv: 8 })
  assert.deepEqual(same.ceCdv.map((p) => p.value), [7])
  const next = withCurrentBar(flow, { time: '2026-10-21T03:46:00Z', ceCdv: 7, peCdv: 8 })
  assert.deepEqual(next.peCdv.map((p) => p.value), [2, 8])
  const older = withCurrentBar(flow, { time: '2026-10-21T03:44:00Z', ceCdv: 7, peCdv: 8 })
  assert.deepEqual(older.ceCdv.map((p) => p.value), [1])
})
