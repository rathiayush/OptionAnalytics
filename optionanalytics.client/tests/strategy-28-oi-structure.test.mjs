// Strategy 28, OI structure: purely option OI read minute by minute - the heavier wall below (above), the
// money leaning the same way, and the writers adding on that side every minute. Fires on its rules
// (LONG and SHORT) and not when any of them is missing.
// Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, evaluateStrategies, STRATEGIES, strategyStats, topFifteen } from '../src/strategyEngine.js'
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }

const ATM = 22700
const BASIS = 60
const minutes = 120
const now = at(minutes) + 10_000

// The long picture, strike by strike (CE / PE OI as a function of the minute). A SHORT is the mirror:
// strikes reflected around the ATM, calls and puts swapped.
function longBook(o = {}) {
  const ce = {}
  const pe = {}
  const writing = o.writing ?? ((m) => (m <= 100 ? 0 : (m - 100) * 15000))
  pe[ATM - 50] = (m) => (o.putWall ?? 6e6) + writing(m)                 // the support wall, written into
  pe[ATM] = (m) => 3e6 + writing(m)
  pe[ATM + 50] = () => 3e6
  ce[ATM - 50] = () => 2e6
  ce[ATM] = (m) => 2e6 + (o.callWritingAtm?.(m) ?? 0)
  ce[ATM + 50] = () => o.atmCalls ?? 2e6
  ce[ATM + (o.callWallAt ?? 200)] = () => o.callWall ?? 4e6             // the resistance wall
  return { ce, pe }
}
function ctxFor(dir, o = {}) {
  const book = longBook(o)
  const value = (side, k, m) => {
    // Long: as written. Short: the long book's other side at the mirrored strike.
    const src = dir > 0 ? book[side] : book[side === 'ce' ? 'pe' : 'ce']
    const key = dir > 0 ? k : 2 * ATM - k
    return (src[key] ?? (() => 1e6))(m)
  }
  const spot = [], futures = [], cePoints = [], pePoints = []
  for (let m = 0; m <= minutes; m++) {
    const f = ATM + BASIS + (o.spotShift ?? 0) * dir + ((m % 3) - 1)
    spot.push({ time: iso(at(m)), open: f - BASIS, high: f - BASIS, low: f - BASIS, close: f - BASIS })
    futures.push({ time: iso(at(m)), open: f, high: f, low: f, close: f, volume: 1000, openInterest: 1e7 })
    for (let k = 22300; k <= 23100; k += 50) {
      cePoints.push({ time: iso(at(m)), strike: k, openInterest: Math.round(value('ce', k, m)), price: 50 })
      pePoints.push({ time: iso(at(m)), strike: k, openInterest: Math.round(value('pe', k, m)), price: 50 })
    }
  }
  return buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: spot, futuresBars: futures, cePoints, pePoints })
}
function bars(dir, o) {
  const out = []
  let cvd = 0
  for (let m = 0; m < minutes; m++) {
    const c = ATM + BASIS + (o.spotShift ?? 0) * dir + ((m % 3) - 1)
    const b = { time: at(m), open: c, high: c + 3, low: c - 3, close: c, buy: 500, sell: 500, absorption: [], exhaustion: [], stacked: [] }
    b.delta = 0; cvd += 0; b.cvd = cvd
    out.push(b)
  }
  return out
}
function scenario(dir, o = {}) {
  const oi = ctxFor(dir, o)
  const b = bars(dir, o)
  const price = b.at(-1).close
  // No tape, book or heatmap lean either way: the strategy is OI only.
  const setups = evaluateStrategies({ includeRetired: true,  nowMs: now, price, bars: b, minuteBars: b, prints: [], book: null, liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi, estimated: true, lotSize: 75, bigLots: 10, profile: null })
  return { s: setups.find((x) => x.id === 'oiStructure'), all: setups }
}
const show = ({ s, all }) => JSON.stringify(s ? { side: s.side, entry: s.entry, stop: +s.stop.toFixed(1), target: +s.target.toFixed(1), conf: s.confidence, checks: s.checks } : all.map((x) => `${x.id}:${x.side}`))

check('30 strategies, #28 is OI structure', STRATEGIES.length === 30 && STRATEGIES.find((s) => s.no === 28)?.id === 'oiStructure')

const L = scenario(1)
check('LONG: put wall 1.5x the call wall, puts lead at the money, put writing every minute', L.s?.side === 'LONG'
  && L.s.stop < L.s.entry && L.s.target > L.s.entry && /PUT wall 22650/.test(L.s.checks.OI) && /5\/5 minutes/.test(L.s.checks.Writing), show(L))
console.log('   ', show(L).slice(0, 700))
check('LONG: stop under the put wall (in futures terms), target at the call wall', L.s && L.s.stop < 22650 + BASIS && L.s.target <= 22900 + BASIS, show(L))

const S = scenario(-1)
check('SHORT (the mirror): call wall heavier, calls lead at the money, call writing every minute', S.s?.side === 'SHORT'
  && S.s.stop > S.s.entry && S.s.target < S.s.entry && /CALL wall 22750/.test(S.s.checks.OI), show(S))

check('not when the walls are even (the floor no heavier than the ceiling)', !scenario(1, { putWall: 4e6 }).s)
check('not when the money does not lean the trade\'s way (calls = puts at ATM ±1)', !scenario(1, { atmCalls: 6e6 }).s)
check('not when the writing has stopped (no put writing in the last minute)', !scenario(1, { writing: (m) => (m <= 100 ? 0 : (Math.min(m, 118) - 100) * 15000) }).s)
check('not when the writing is only a burst (2 of the last 5 minutes)', !scenario(1, { writing: (m) => (m <= 117 ? 0 : (m - 117) * 40000) }).s)
check('not when calls are being written at the money against it', !scenario(1, { callWritingAtm: (m) => (m <= 116 ? 0 : (m - 116) * 30000) }).s)
check('not with no room to the other wall (call wall right above)', !scenario(1, { callWallAt: 50 }).s)
check('not once the index is below its own put wall', !scenario(1, { spotShift: -80 }).s)

console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
