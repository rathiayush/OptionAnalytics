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
