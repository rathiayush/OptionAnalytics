// The replay price at the clock (a replayed day holds only big prints / spike minutes).
// Run: npm test (node --test) - see CLAUDE.md.
import { replayView } from '../src/orderFlowMath.js'
const MIN = 60000, T = Date.parse('2026-09-30T03:45:00Z')
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }
const minuteBars = Array.from({ length: 120 }, (_, i) => ({ time: new Date(T + i * MIN).toISOString(), open: 24200 - i, high: 24202 - i, low: 24198 - i, close: 24200 - i - 0.5, buy: 1, sell: 1, levels: [] }))
// Estimated day: "trades" only on volume-spike minutes (at the minute's close, :59).
const spikes = [10, 40].map((i) => ({ seq: i, time: new Date(T + i * MIN + 59000).toISOString(), price: minuteBars[i].close, quantity: 9999, buy: true }))
const day = { meta: { lastPrice: 999 }, minuteBars, trades: spikes, heatmap: [], icebergs: [], sweeps: [] }
for (const m of [20, 60, 100]) {
  const v = replayView(day, T + m * MIN + 10000)
  check(`estimated day at minute ${m}: price = last completed minute's close (${minuteBars[m - 1].close}), not the last spike`, v.meta.lastPrice === minuteBars[m - 1].close, String(v.meta.lastPrice))
}
const v41 = replayView(day, T + 41 * MIN + 1000)
check('right after a spike minute: its close', v41.meta.lastPrice === minuteBars[40].close, String(v41.meta.lastPrice))
// Exact day: a big print INSIDE the current (incomplete) minute is newer than the last completed close.
const exact = { ...day, trades: [{ seq: 1, time: new Date(T + 50 * MIN + 20000).toISOString(), price: 24123.5, quantity: 9999, buy: true }] }
check('exact day: a big print in the current minute wins', replayView(exact, T + 50 * MIN + 30000).meta.lastPrice === 24123.5)
check('exact day: later, the newer completed minute wins', replayView(exact, T + 55 * MIN + 30000).meta.lastPrice === minuteBars[54].close)
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
