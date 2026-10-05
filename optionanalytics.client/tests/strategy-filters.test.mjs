// Per-strategy filters (STRATEGY_FILTERS / strategyFilters): the defaults ARE the strategy's rules, the
// trader's overrides are clamped to their range, and anything malformed falls back to the default.
// Run: npm test (node --test) - see CLAUDE.md.
import { STRATEGY_FILTERS, STRATEGY_BY_ID, strategyFilters, changedFilters } from '../src/strategyEngine.js'
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }

check('filters exist for #15 IB breakout and #29 VWAP + OI, each for a known strategy', !!STRATEGY_FILTERS.ibBreakout && !!STRATEGY_FILTERS.vwapOi && Object.keys(STRATEGY_FILTERS).every((id) => STRATEGY_BY_ID[id]))
check('every filter is well formed (number: min <= default <= max, step > 0; switch: boolean default)', Object.values(STRATEGY_FILTERS).flat().every((f) => f.key && f.label
  && (f.type === 'switch' ? typeof f.default === 'boolean' : f.type === 'number' && f.min <= f.default && f.default <= f.max && f.step > 0)))
check('nothing set: the defaults (the rules as tested)', JSON.stringify(strategyFilters('ibBreakout')) === JSON.stringify(Object.fromEntries(STRATEGY_FILTERS.ibBreakout.map((f) => [f.key, f.default]))))
const v = strategyFilters('ibBreakout', { closesBeyond: 9, breakVolumeX: -1, firstBreakOnly: 'no', minWriting: NaN, junk: 5 })
check('out-of-range numbers are clamped, wrong types / NaN fall back, unknown keys are dropped', v.closesBeyond === 5 && v.breakVolumeX === 0 && v.firstBreakOnly === true && v.minWriting === 0.15 && !('junk' in v), JSON.stringify(v))
check('a strategy with no filters gets none', JSON.stringify(strategyFilters('wallBreak', { x: 1 })) === '{}')
check('changedFilters lists only what differs from the default', changedFilters('vwapOi', { needWriters: false, targetR: 2 }).map((f) => f.key).join() === 'needWriters' && changedFilters('vwapOi', {}).length === 0)
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
