// Sudden OI walls (suddenOi.findSuddenWalls): heavy writing at a strike within 5 minutes, far faster than
// before - flagged on every strike of the band, PUTs as support and CALLs as resistance.
// Run: npm test (node --test) - see CLAUDE.md.
import { findSuddenWalls, suddenWallText } from '../src/suddenOi.js'
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }
const MIN = 60_000
const NOW = 100 * MIN
// series[side][strike] = (minute) => OI
const run = (series, o = {}) => findSuddenWalls({
  strikes: [22400, 22450, 22500, 22550, 22600, 22650, 22700, 22750, 22800, 23400],
  oiAt: (side, k, t) => (series[side]?.[k] ?? (() => 1e6))(Math.floor(t / MIN)), ms: NOW, spot: 22640, step: 50, ...o,
})
const jump = (base, from, perMin) => (m) => base + Math.max(0, m - from) * perMin
{
  const w = run({ PE: { 22600: jump(3e6, 95, 40000) }, CE: { 22750: jump(2e6, 96, 30000) } })
  check('a sudden PUT (support) and a sudden CALL (resistance), biggest add first', w.length === 2 && w[0].side === 'PE' && w[0].strike === 22600 && w[0].kind === 'support' && w[1].side === 'CE' && w[1].kind === 'resistance', JSON.stringify(w))
  check('add, % and "nothing written before" read', Math.abs(w[0].add - 200000) < 1 && Math.abs(w[0].pct - 200000 / 3e6) < 1e-9 && w[0].paceX === null && /PUT 22600 \+2\.0L in 5m \(\+6\.7%, nothing written before\)/.test(suddenWallText(w[0])), suddenWallText(w[0]))
}
check('a steady build at the same pace for the last 35 minutes is not sudden', run({ PE: { 22600: jump(3e6, 60, 40000) } }).length === 0)
check('a small add (1% in 5 min) is not a wall', run({ PE: { 22600: jump(3e6, 95, 6000) } }).length === 0)
check('a strike outside the band (23400, 15+ strikes away) is not read', run({ CE: { 23400: jump(3e6, 95, 60000) } }).length === 0)
check('a tiny far strike: 3% of almost nothing is not a wall (under 2% of the band\'s biggest)', run({ PE: { 22600: () => 5e7, 22450: jump(4e5, 95, 4000) } }).length === 0)
{
  const w = run({ PE: { 22600: (m) => (m < 65 ? 3e6 : m < 95 ? 3e6 + (m - 65) * 2000 : 3.06e6 + (m - 95) * 40000) } })
  check('3x+ faster than its pace before: sudden, with the pace multiple', w.length === 1 && w[0].paceX > 3, JSON.stringify(w))
}
check('only what is known by the clock is read', run({ PE: { 22600: jump(3e6, 101, 400000) } }).length === 0)
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
