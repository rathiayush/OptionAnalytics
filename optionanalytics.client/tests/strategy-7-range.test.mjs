// Strategy 7, the range between two growing walls (a fade of each edge back toward the middle).
// Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, evaluateStrategies, STRATEGIES, ACTIVE_STRATEGIES } from '../src/strategyEngine.js'
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${x}`); if (!c) fails++ }
check('#7 is the range fade, active, in the range group', STRATEGIES.find((s) => s.no === 7)?.id === 'range' && ACTIVE_STRATEGIES.some((s) => s.id === 'range' && s.group === 'range'))

// The day: the PUT wall 22600 (support) and the CALL wall 22800 (resistance) both being written all morning,
// the index parked by one edge, the futures (index + 60) going nowhere. 10:55 (minute 100).
const NOW_M = 100
function rangeCase(dir, o = {}) {
  const spotAt = o.spot ?? (dir > 0 ? 22612 : 22788)
  const grow = (on) => (m) => 5e6 + (on ? m * 20000 : 0)
  const pe22600 = grow(o.supportGrowing ?? true)
  const ce22800 = grow(o.resistanceGrowing ?? true)
  const drift = (m) => (o.futuresMove && m >= 70 ? (m - 70) * 1.7 : 0) // ~0.22% in 30 min
  const sp = [], fut = [], ce = [], pe = []
  for (let m = 0; m <= NOW_M + 10; m++) {
    sp.push({ time: iso(at(m)), open: spotAt, high: spotAt, low: spotAt, close: spotAt })
    const f = spotAt + 60 + drift(m)
    fut.push({ time: iso(at(m)), open: f, high: f, low: f, close: f, volume: 1, openInterest: 1e7 })
    for (let k = 22300; k <= 23000; k += 50) {
      pe.push({ time: iso(at(m)), strike: k, openInterest: k === 22600 ? pe22600(m) : 1e6, price: 20 })
      ce.push({ time: iso(at(m)), strike: k, openInterest: k === 22800 ? ce22800(m) : 1e6, price: 20 })
    }
  }
  const oi = buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: sp, futuresBars: fut, cePoints: ce, pePoints: pe })
  const bars = []
  let cvd = 0
  for (let m = 0; m < NOW_M; m++) {
    const p = spotAt + 60 + drift(m)
    const b = { time: at(m), open: p, high: p + 2, low: p - 2, close: p, buy: 500, sell: 500, absorption: [], exhaustion: [], stacked: [] }
    b.delta = b.buy - b.sell; cvd += b.delta; b.cvd = cvd
    bars.push(b)
  }
  // The edge holds: absorption of the fade's side in the last bar.
  if (o.footprint !== false) bars.at(-1).absorption = [{ side: dir > 0 ? 'buy' : 'sell', price: bars.at(-1).close }]
  const nowMs = o.nowMs ?? at(NOW_M) + 10_000
  const tape = Array.from({ length: 60 }, (_, i) => ({ seq: i, time: nowMs - 59_000 + i * 1000, price: 1, quantity: 75, buy: i % 2 === 0 }))
  const withUs = { bids: [{ quantity: 600 }], asks: [{ quantity: 400 }] }
  const against = { bids: [{ quantity: 400 }], asks: [{ quantity: 600 }] }
  const book = o.domAgainst ? (dir > 0 ? against : withUs) : (dir > 0 ? withUs : against)
  const visible = bars.filter((b) => b.time + MIN <= nowMs)
  const setups = evaluateStrategies({ nowMs, price: visible.at(-1).close, bars: visible, minuteBars: visible, prints: tape, book, liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi, estimated: false, lotSize: 75, bigLots: 10, profile: null })
  return { s: setups.find((x) => x.id === 'range'), setups }
}
const show = (r) => JSON.stringify(r.s ? { side: r.s.side, entry: r.s.entry, stop: r.s.stop, target: r.s.target, OI: r.s.checks.OI } : r.setups.map((x) => x.id))

const L = rangeCase(1)
check('fires LONG at the growing PUT wall, target toward the middle', L.s?.side === 'LONG' && L.s.stop < L.s.entry && L.s.target > L.s.entry && /both walls growing/.test(L.s.checks.OI), show(L))
const S = rangeCase(-1)
check('fires SHORT at the growing CALL wall, target toward the middle', S.s?.side === 'SHORT' && S.s.stop > S.s.entry && S.s.target < S.s.entry, show(S))
for (const dir of [1, -1]) {
  const side = dir > 0 ? 'LONG' : 'SHORT'
  check(`${side}: not when the PUT wall is not growing`, !rangeCase(dir, { supportGrowing: false }).s)
  check(`${side}: not when the CALL wall is not growing`, !rangeCase(dir, { resistanceGrowing: false }).s)
  check(`${side}: not when the futures moved 0.15%+ in 30 minutes (not a range)`, !rangeCase(dir, { futuresMove: true }).s)
  check(`${side}: not away from the edge (over 0.12%)`, !rangeCase(dir, { spot: dir > 0 ? 22660 : 22740 }).s)
  check(`${side}: not without exhaustion / absorption at the edge`, !rangeCase(dir, { footprint: false }).s)
  check(`${side}: not when the book is against it`, !rangeCase(dir, { domAgainst: true }).s)
  check(`${side}: not before 10:30`, !rangeCase(dir, { nowMs: at(70) + 10_000 }).s)
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
