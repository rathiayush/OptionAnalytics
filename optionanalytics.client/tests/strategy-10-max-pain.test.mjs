// Strategy 10, the expiry-day max-pain pull: fires only while the writers defend max pain (its straddle
// still being written) and nothing is written against the pull in the way.
// Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, evaluateStrategies } from '../src/strategyEngine.js'
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }

const minutes = 255 // 13:30 IST
const now = at(minutes) + 10_000
function scenario(o = {}) {
  const straddle = o.straddle ?? ((m) => 2e7 + m * 20000)
  const pathCalls = o.pathCalls ?? (() => 1e6)
  const spot = [], futures = [], cePoints = [], pePoints = []
  for (let m = 0; m <= minutes; m++) {
    const f = 22760 + (m % 2)
    spot.push({ time: iso(at(m)), open: f - 60, high: f - 60, low: f - 60, close: f - 60 })
    futures.push({ time: iso(at(m)), open: f, high: f, low: f, close: f, volume: 1000, openInterest: 1e7 })
    for (let k = 22300; k <= 23200; k += 50) {
      const ce = k === 22800 ? straddle(m) : k === 22750 ? pathCalls(m) : 1e6
      const pe = k === 22800 ? straddle(m) : 1e6
      cePoints.push({ time: iso(at(m)), strike: k, openInterest: Math.round(ce), price: 20 })
      pePoints.push({ time: iso(at(m)), strike: k, openInterest: Math.round(pe), price: 20 })
    }
  }
  const oi = buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: spot, futuresBars: futures, cePoints, pePoints }, '2026-10-05')
  const bars = []
  let cvd = 0
  for (let m = 0; m < minutes; m++) {
    const c = 22760 + (m % 2)
    const b = { time: at(m), open: c, high: c + 3, low: c - 3, close: c, buy: 700, sell: 300, absorption: [], exhaustion: [], stacked: [] }
    b.delta = b.buy - b.sell; cvd += b.delta; b.cvd = cvd
    bars.push(b)
  }
  const setups = evaluateStrategies({ nowMs: now, price: bars.at(-1).close, bars, minuteBars: bars, prints: [], book: null, liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi, estimated: true, lotSize: 75, bigLots: 10, profile: null })
  return setups.find((x) => x.id === 'maxPain')
}

const s = scenario()
check('expiry day, max pain 22800 above the index, its straddle still written -> LONG toward it', s?.side === 'LONG' && s.target > s.entry && /straddle still being written/.test(s.checks.OI), JSON.stringify(s?.checks ?? null))
check('not when the max-pain straddle is no longer being written', !scenario({ straddle: () => 2e7 }))
check('not when calls in the way are being written against the pull', !scenario({ pathCalls: (m) => (m < 225 ? 1e6 : 1e6 + (m - 225) * 1000) }))
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
