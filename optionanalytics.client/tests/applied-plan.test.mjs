// The Strategy lab's "what is applied" run: which jobs it makes from the applied settings (src/appliedPlan.js).
// Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { appliedPlan } from '../src/appliedPlan.js'
import { ACTIVE_STRATEGIES, SPOT_STRATEGIES } from '../src/strategyEngine.js'

const fut = ACTIVE_STRATEGIES.slice(0, 3).map((s) => s.id)
const spot = SPOT_STRATEGIES.filter((s) => !s.retired).slice(0, 2).map((s) => s.id)

test('nothing applied (or no config) is no job at all', () => {
  assert.deepEqual(appliedPlan({ filtersByIndex: {} }), { pairs: [], leftOut: [] })
  assert.deepEqual(appliedPlan(null), { pairs: [], leftOut: [] })
  assert.deepEqual(appliedPlan({ filtersByIndex: { NIFTY: {} } }), { pairs: [], leftOut: [] })
})
