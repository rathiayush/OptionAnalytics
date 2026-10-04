// Strategy 16, the weak OI wall second-retest break.
// Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, evaluateStrategies, STRATEGIES } from '../src/strategyEngine.js'
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${x}`); if (!c) fails++ }
check('24 strategies, #16 is the weak wall', STRATEGIES.length === 24 && STRATEGIES.find((s) => s.no === 16)?.id === 'weakWall')

const NOW_M = 85
function oiRun({ levelOi = (m) => (m < 70 ? 4.6e6 : 4.6e6 - (m - 70) * 40000), neighbour = 3e6, futuresUp = true } = {}) {
  const sp = [], fut = [], ce = [], pe = []
  for (let m = 0; m <= NOW_M + 5; m++) {
    const s = 22630 + (m >= 70 ? (m - 70) * 0.5 : 0)
    sp.push({ time: iso(at(m)), open: s, high: s, low: s, close: s })
    fut.push({ time: iso(at(m)), open: s + 60, high: s + 60, low: s + 60, close: s + 60 + (futuresUp ? 0 : -(m >= 70 ? (m - 70) * 1.2 : 0)), volume: 1, openInterest: 1e7 + m * 4000 })
    for (let k = 22400; k <= 22900; k += 50) {
      const ceOi = k === 22800 ? 10e6 : k === 22650 ? levelOi(m) : (k === 22600 || k === 22700) ? neighbour : 1e6
      ce.push({ time: iso(at(m)), strike: k, openInterest: ceOi, price: 50 })
      pe.push({ time: iso(at(m)), strike: k, openInterest: k === 22550 ? 6e6 : 1e6, price: 50 })
    }
  }
  return buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: sp, futuresBars: fut, cePoints: ce, pePoints: pe })
}
// Futures bars: first test of 22710 (=22650 + basis 60) around m 40, away, back now at m 85.
function futBars({ secondTest = true } = {}) {
  const out = []; let cvd = 0
  for (let m = 0; m <= NOW_M - 1; m++) {
    let p = 22680
    if (m >= 38 && m <= 42) p = 22705          // 1st test
    if (m > 42 && m < 75) p = 22660           // away
    if (m >= 75) p = secondTest ? 22690 + (m - 75) * 1.6 : 22660
    const b = { time: at(m), open: p - 1, high: p + 2, low: p - 2, close: p, buy: m === NOW_M - 1 ? 1500 : 600, sell: 500, absorption: [], exhaustion: [], stacked: [] }
    b.delta = b.buy - b.sell; cvd += b.delta; b.cvd = cvd
    out.push(b)
  }
  return out
}
const tape = (now, pct) => Array.from({ length: 60 }, (_, i) => ({ seq: i, time: now - 59000 + i * 1000, price: 1, quantity: 75, buy: ((i * 37) % 100) < pct }))
const run = (oi, bars) => {
  const now = at(NOW_M) + 10000
  const price = bars.at(-1).close
  return evaluateStrategies({ nowMs: now, price, bars, minuteBars: bars, prints: tape(now, 70), book: { bids: [{ quantity: 600 }], asks: [{ quantity: 400 }] }, liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi, estimated: false, lotSize: 75, bigLots: 10, profile: null })
}
let s = run(oiRun(), futBars()).find((x) => x.id === 'weakWall')
check('fires LONG on the 2nd test of a weak, covered secondary CALL wall', s?.side === 'LONG' && s.target > s.entry && s.stop < s.entry, JSON.stringify(s ? { entry: s.entry, stop: s.stop, target: s.target, conf: s.confidence, checks: s.checks } : null))
check('not on the first test', !run(oiRun(), futBars({ secondTest: false })).some((x) => x.id === 'weakWall'))
check('not when the wall stands out (OI far above its neighbours)', !run(oiRun({ neighbour: 1e6 }), futBars()).some((x) => x.id === 'weakWall'))
check('not when writers are adding to it', !run(oiRun({ levelOi: (m) => 4e6 + m * 20000 }), futBars()).some((x) => x.id === 'weakWall'))
check('not without futures confirmation (futures falling)', !run(oiRun({ futuresUp: false }), futBars()).some((x) => x.id === 'weakWall'))
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
