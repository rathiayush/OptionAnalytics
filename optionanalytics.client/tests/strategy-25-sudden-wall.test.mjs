// Strategy 25, sudden OI wall + DOM imbalance: fires LONG (put wall) and SHORT (call wall), and not when
// any key condition is missing. Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, evaluateStrategies, STRATEGIES, strategyStats, topFifteen } from '../src/strategyEngine.js'
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }
function oiCtx({ fut, minutes, ce = {}, pe = {} }) {
  const spot = [], futures = [], cePoints = [], pePoints = []
  for (let m = 0; m <= minutes; m++) {
    const f = fut(m)
    spot.push({ time: iso(at(m)), open: f - 60, high: f - 60, low: f - 60, close: f - 60 })
    futures.push({ time: iso(at(m)), open: f, high: f, low: f, close: f, volume: 1000, openInterest: 1e7 })
    for (let k = 22300; k <= 23200; k += 50) {
      pePoints.push({ time: iso(at(m)), strike: k, openInterest: Math.round((pe[k] ?? (() => 1e6))(m)), price: 10 })
      cePoints.push({ time: iso(at(m)), strike: k, openInterest: Math.round((ce[k] ?? (() => 1e6))(m)), price: 10 })
    }
  }
  return buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: spot, futuresBars: futures, cePoints, pePoints })
}
function mkBars(n, f) {
  const out = []; let cvd = 0
  for (let m = 0; m < n; m++) {
    const x = f(m)
    const b = { time: at(m), open: x.c, high: x.c + 3, low: x.c - 3, close: x.c, buy: x.buy ?? 500, sell: x.sell ?? 500, absorption: x.absorption ?? [], exhaustion: [], stacked: [] }
    b.delta = b.buy - b.sell; cvd += b.delta; b.cvd = cvd
    out.push(b)
  }
  return out
}
const tapeWith = (now, buyPct) => Array.from({ length: 50 }, (_, i) => ({ seq: i, time: now - 50_000 + i * 1000, price: 1, quantity: 75, buy: ((i * 37) % 100) < buyPct }))
const now = at(120) + 10_000
const flat = (v) => () => v
// A sudden wall: flat until 11:10, then +40k a minute (6.7% of 3M in 5 minutes).
const sudden = (m) => (m <= 115 ? 3e6 : 3e6 + (m - 115) * 40000)
function scenario(dir, o = {}) {
  const level = o.level ?? 22760 // futures; index = futures - 60
  const fut = () => level
  const wallMap = dir > 0 ? 'pe' : 'ce'
  const otherMap = dir > 0 ? 'ce' : 'pe'
  const opts = { ce: {}, pe: {} }
  opts[wallMap][22700] = o.wall ?? sudden
  opts[otherMap][22700 + dir * 150] = flat(4e6) // the opposite wall, 150 pts away
  if (o.straddle) opts[otherMap][22700] = sudden
  if (o.biggerWall) opts[wallMap][22700 - dir * 50] = flat(8e6)
  const ctx = oiCtx({ minutes: 120, fut, ...opts })
  const flow = dir > 0 ? { buy: 700, sell: 400 } : { buy: 400, sell: 700 }
  const bars = mkBars(120, (m) => ({ c: level, ...(m >= 118 ? flow : {}), absorption: m === 119 && o.absorbed ? [{ side: dir > 0 ? 'sell' : 'buy', price: level }] : [] }))
  const bids = o.bids ?? (dir > 0 ? 650 : 350)
  const setups = evaluateStrategies({ includeRetired: true,  nowMs: now, price: level, bars, minuteBars: bars, prints: o.estimated ? null : tapeWith(now, dir > 0 ? 60 : 40),
    book: { bids: [{ quantity: bids }], asks: [{ quantity: 1000 - bids }] }, liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi: ctx, estimated: !!o.estimated, lotSize: 75, bigLots: 10, profile: null })
  return { s: setups.find((x) => x.id === 'suddenWall'), all: setups }
}
const show = ({ s, all }) => JSON.stringify(s ? { side: s.side, entry: s.entry, stop: +s.stop.toFixed(1), target: +s.target.toFixed(1), conf: s.confidence, checks: s.checks } : all.map((x) => `${x.id}:${x.side}`))

check('#25 is the sudden OI wall + DOM imbalance', STRATEGIES.find((s) => s.no === 25)?.id === 'suddenWall')
const L = scenario(1)
check('sudden PUT wall at the price + bids leaning: LONG, stop under the wall, target toward the call wall', L.s?.side === 'LONG' && L.s.stop < 22760 && L.s.target > 22760 && L.s.target < 22910 && /PUT 22700/.test(L.s.checks.OI) && /bids 65%/.test(L.s.checks.DOM), show(L))
console.log('   ', show(L).slice(0, 700))
const S = scenario(-1)
check('sudden CALL wall at the price + asks leaning: SHORT', S.s?.side === 'SHORT' && S.s.stop > 22760 && S.s.target < 22760 && /CALL 22700/.test(S.s.checks.OI) && /asks 65%/.test(S.s.checks.DOM), show(S))
check('not a steady build (same add, at the same pace for the last hour)', !scenario(1, { wall: (m) => (m < 60 ? 3e6 : 3e6 + (m - 60) * 40000) }).s)
check('not a small add (1% in 5 min)', !scenario(1, { wall: (m) => (m <= 115 ? 3e6 : 3e6 + (m - 115) * 6000) }).s)
check('not without the book leaning (bids 52%)', !scenario(1, { bids: 520 }).s)
check('not with the book leaning against (bids 35%)', !scenario(1, { bids: 350 }).s)
check('not when calls are written as hard at the money (a straddle)', !scenario(1, { straddle: true }).s)
check('not when it is not the wall (a much bigger put strike next to it)', !scenario(1, { biggerWall: true }).s)
check('not when price is far above the wall (index 100 pts over it)', !scenario(1, { level: 22860 }).s)
check('not when the buying is absorbed', !scenario(1, { absorbed: true }).s)
check('not on an estimated day (no book)', !scenario(1, { estimated: true }).s)
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
