// The Strategy lab's "what is applied" run: which jobs it makes from the applied settings (src/appliedPlan.js).
// Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { appliedPlan } from '../src/appliedPlan.js'
import { ACTIVE_STRATEGIES, SPOT_STRATEGIES } from '../src/strategyEngine.js'

const fut = ACTIVE_STRATEGIES.slice(0, 3).map((s) => s.id)
const spot = SPOT_STRATEGIES.filter((s) => !s.retired).slice(0, 2).map((s) => s.id)

test('one job per index and kind, with the strategies applied on that index only', () => {
  const cfg = { filtersByIndex: {
    NIFTY: { [fut[1]]: { _appliedAt: 1 }, [fut[0]]: { tradeSide: 'long' }, [spot[0]]: { _appliedAt: 1 } },
    SENSEX: { [spot[1]]: { tradeSide: 'long' } },
  } }
  const { pairs, leftOut } = appliedPlan(cfg)
  assert.deepEqual(pairs.map((p) => `${p.u}|${p.kind}`), ['NIFTY|futures', 'NIFTY|spot', 'SENSEX|spot'], 'nothing applied on BANKNIFTY: no job there')
  assert.deepEqual(pairs[0].ids, [fut[0], fut[1]].sort((a, b) => ACTIVE_STRATEGIES.find((s) => s.id === a).no - ACTIVE_STRATEGIES.find((s) => s.id === b).no))
  assert.deepEqual(pairs[1].ids, [spot[0]])
  assert.deepEqual(pairs[2].ids, [spot[1]])
  assert.deepEqual(leftOut, [])
})

test('a strategy retired or unknown since it was applied is listed, never run - and never fails the rest', () => {
  const cfg = { filtersByIndex: { BANKNIFTY: { lvnRun: { _appliedAt: 1 }, nope: { _appliedAt: 1 }, [fut[0]]: { _appliedAt: 1 } } } }
  const { pairs, leftOut } = appliedPlan(cfg)
  assert.deepEqual(pairs.map((p) => ({ u: p.u, ids: p.ids })), [{ u: 'BANKNIFTY', ids: [fut[0]] }])
  assert.deepEqual(leftOut, [{ u: 'BANKNIFTY', id: 'lvnRun', reason: 'retired' }, { u: 'BANKNIFTY', id: 'nope', reason: 'no such strategy' }])
})

test('nothing applied (or no config) is no job at all', () => {
  assert.deepEqual(appliedPlan({ filtersByIndex: {} }), { pairs: [], leftOut: [] })
  assert.deepEqual(appliedPlan(null), { pairs: [], leftOut: [] })
  assert.deepEqual(appliedPlan({ filtersByIndex: { NIFTY: {} } }), { pairs: [], leftOut: [] })
})

test('the last tuning run as jobs: each strategy its own best setting, tested on the days BEFORE the run', async () => {
  const { tunedPlan } = await import('../src/appliedPlan.js')
  const toParams = (p) => ({ ...p, marked: true })
  const runs = {
    'NIFTY|futures': { ok: true, runId: 'NIFTY-futures-20261016', finishedUtc: '2026-10-16T10:00:00Z', what: 'both',
      days: [{ date: '2026-10-15' }, { date: '2026-08-03' }, { date: '2026-09-01' }],
      results: [{ id: fut[1], best: { params: { tradeSide: 'long' } }, recommend: true }, { id: fut[0], best: { params: { tradeTargetX: 2 } }, recommend: false }, { id: fut[2], best: null }, { id: 'lvnRun', best: { params: {} } }] },
    'SENSEX|spot': { ok: true, days: [{ date: '2026-10-01' }], results: [{ id: spot[0], best: { params: { optLeg: 'buy' } }, recommend: true }] },
    'BANKNIFTY|futures': { ok: true, what: 'check', days: [{ date: '2026-10-01' }], results: [] },
  }
  const { pairs, leftOut } = tunedPlan(runs, toParams)
  assert.deepEqual(pairs.map((p) => p.key), ['NIFTY|futures', 'SENSEX|spot'], 'a run with no setting found (a re-check) is no job')
  const n = pairs[0]
  assert.equal(n.ids.length, 2, 'only the strategies the run found a setting for')
  assert.deepEqual(n.paramsById[fut[1]], { tradeSide: 'long', marked: true }, 'each its own setting, as lab params')
  assert.deepEqual(n.recommend, { [fut[1]]: true, [fut[0]]: false })
  // The run covered 3 Aug - 15 Oct (74 days): the test is the 74 days before 3 Aug, ending 2 Aug.
  assert.deepEqual({ from: n.testFrom, to: n.testTo }, { from: '2026-05-21', to: '2026-08-02' })
  assert.deepEqual(n.run, { runId: 'NIFTY-futures-20261016', finishedUtc: '2026-10-16T10:00:00Z', first: '2026-08-03', last: '2026-10-15', days: 3, what: 'both' })
  assert.deepEqual({ from: pairs[1].testFrom, to: pairs[1].testTo }, { from: '2026-09-30', to: '2026-09-30' }, 'a one-day run: the day before it')
  assert.deepEqual(leftOut, [{ u: 'NIFTY', id: 'lvnRun', reason: 'retired' }])
  assert.deepEqual(tunedPlan({}, toParams), { pairs: [], leftOut: [] })
})
