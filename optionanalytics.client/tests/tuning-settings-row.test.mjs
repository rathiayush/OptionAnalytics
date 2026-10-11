// A tuned setting read back from the tuning history CSV (every value a string) must apply to the scanner exactly as
// the same setting applied straight from a tuning result: Strategy performance -> Apply to live scanner.
// Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { filtersFromTuning, paramsFromSettingsRow } from '../src/strategyTuning.js'
import { SETTING_COLUMNS } from '../scanner-runner/tuneHistory.mjs'

test('a settings.csv row comes back as the params it was written from, and applies the same filters', () => {
  const params = { tradeSide: 'long', tradeFrom: 1000, tradeTo: 1400, tradeStopX: 1.25, tradeTargetX: 1.5, tradeTimeStop: 45, tradeTrail: 'off',
    tradeOiFlow: 'any', tradeDayType: 'any', optLeg: 'buy', optMoneyness: -1, optExit: 'first', optSlPct: 25, optTargetPct: 40 }
  // Written exactly as the tuning history writes it (tuneHistory.mjs SETTING_COLUMNS), then read back as strings.
  const written = Object.fromEntries(SETTING_COLUMNS.map((c) => [c.key, String(c.value({ params, which: 'fine-tuned' }) ?? '')]))
  const back = paramsFromSettingsRow(written)
  for (const [k, v] of Object.entries(params)) assert.deepEqual(back[k], v, k)
  assert.deepEqual(filtersFromTuning({}, back, { option: true }), filtersFromTuning({}, params, { option: true }))
  assert.deepEqual(paramsFromSettingsRow({ tradeSide: '', tradeFrom: '' }), {}, 'empty fields are left out')
})
