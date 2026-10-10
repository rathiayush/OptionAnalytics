// Strategy 24, the trapped-OI squeeze: short squeeze (long) and long squeeze (short), and when it must not fire.
// Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, evaluateStrategies, STRATEGIES, strategyStats, topFifteen } from '../src/strategyEngine.js'
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }
function oiCtx({ fut, minutes, futOi, ce = {}, pe = {} }) {
  const spot = [], futures = [], cePoints = [], pePoints = []
  for (let m = 0; m <= minutes; m++) {
    const f = fut(m)
    spot.push({ time: iso(at(m)), open: f - 60, high: f - 60, low: f - 60, close: f - 60 })
    futures.push({ time: iso(at(m)), open: f, high: f, low: f, close: f, volume: 1000, openInterest: futOi(m) })
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
    const b = { time: at(m), open: x.o ?? x.c, high: x.h ?? x.c + 3, low: x.l ?? x.c - 3, close: x.c, buy: x.buy ?? 500, sell: x.sell ?? 500, absorption: x.absorption ?? [], exhaustion: x.exhaustion ?? [], stacked: x.stacked ?? [] }
    b.delta = b.buy - b.sell; cvd += b.delta; b.cvd = cvd
    out.push(b)
  }
  return out
}
const tapeWith = (now, buyPct) => Array.from({ length: 50 }, (_, i) => ({ seq: i, time: now - 50_000 + i * 1000, price: 1, quantity: 75, buy: ((i * 37) % 100) < buyPct }))
const book = (bids) => ({ bids: [{ quantity: bids }], asks: [{ quantity: 1000 - bids }] })
const now = at(120) + 10_000
// dir +1: shorts built 10:00-11:00 (price down 60, OI +0.9%), now covering: price back up, OI coming off.
// dir -1: the mirror - longs built, now unwinding.
const futPath = (dir) => (m) => (m < 45 ? 22760 + ((m % 4) - 2) * dir : m <= 105 ? 22760 - dir * (m - 45) : 22760 - dir * 60 + dir * (m - 105) * 4)
const oiBuilt = (m) => (m < 45 ? 1e7 : m <= 105 ? 1e7 + (m - 45) * 1500 : 1.009e7 - (m - 105) * 2000)
const covering = (m) => (m < 110 ? 3e6 : 3e6 - (m - 110) * 20000)
const steady = (m) => 2e6 + m * 1000
function scenario(dir, o = {}) {
  const fut = futPath(dir)
  const trapped = dir > 0 ? 'ce' : 'pe'
  const atm = 22700
  const opts = { ce: {}, pe: {} }
  opts[trapped][atm] = o.writers ?? covering; opts[trapped][atm + dir * 50] = o.writers ?? covering
  const other = dir > 0 ? 'pe' : 'ce'
  opts[other][atm] = steady; opts[other][atm - dir * 50] = steady
  const ctx = oiCtx({ minutes: 120, fut, futOi: o.futOi ?? oiBuilt, ...opts })
  const bars = mkBars(120, (m) => {
    const c = fut(m)
    if (m < 118) return { c }
    const flow = dir > 0 ? { buy: 900, sell: 400 } : { buy: 400, sell: 900 }
    return { c, ...flow, stacked: m === 118 ? [{ side: dir > 0 ? 'buy' : 'sell', low: c - 3, high: c + 1, rows: 3 }] : [], absorption: m === 119 && o.absorbed ? [{ side: dir > 0 ? 'sell' : 'buy', price: c }] : [] }
  })
  const setups = evaluateStrategies({ nowMs: now, price: fut(120), bars, minuteBars: bars, prints: tapeWith(now, o.buyPct ?? (dir > 0 ? 75 : 25)), book: book(dir > 0 ? 600 : 400), liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi: ctx, estimated: false, lotSize: 75, bigLots: 10, profile: null })
  return { s: setups.find((x) => x.id === 'oiSqueeze'), all: setups }
}
const show = ({ s, all }) => JSON.stringify(s ? { side: s.side, entry: s.entry, stop: +s.stop.toFixed(1), target: +s.target.toFixed(1), conf: s.confidence, checks: s.checks } : all.map((x) => `${x.id}:${x.side}`))

check('33 strategies, #24 is the OI squeeze', STRATEGIES.length === 33 && STRATEGIES.find((s) => s.no === 24)?.id === 'oiSqueeze')
const L = scenario(1)
check('short squeeze -> LONG: shorts built, now covering, calls covering at ATM, forced buying', L.s?.side === 'LONG' && L.s.stop < L.s.entry && L.s.target > L.s.entry && /shorts in/.test(L.s.checks.OI) && /short covering/.test(L.s.checks.Squeeze), show(L))
console.log('   ', show(L).slice(0, 900))
const S = scenario(-1)
check('long squeeze -> SHORT: longs built, now unwinding, puts covering at ATM, forced selling', S.s?.side === 'SHORT' && S.s.stop > S.s.entry && S.s.target < S.s.entry && /longs in/.test(S.s.checks.OI) && /long unwinding/.test(S.s.checks.Squeeze), show(S))
check('not without the build-up first (OI flat, then falling)', !scenario(1, { futOi: (m) => (m <= 105 ? 1e7 : 1e7 - (m - 105) * 2000) }).s)
check('not when the build-up is already all covered (no fuel left)', !scenario(1, { futOi: (m) => (m < 45 ? 1e7 : m <= 105 ? 1e7 + (m - 45) * 1500 : 1.009e7 - (m - 105) * 8000) }).s)
check('not while the call writers are still adding at the money', !scenario(1, { writers: (m) => 3e6 + m * 5000 }).s)
check('not when the buying is being absorbed', !scenario(1, { absorbed: true }).s)
check('not on a weak tape (55% buying)', !scenario(1, { buyPct: 55 }).s)
const t = topFifteen(strategyStats([]))
check('alerted by default: the OI squeeze is in the unmeasured top 15', t.ids.includes('oiSqueeze') && t.ids.length === 15, t.ids.join())
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
