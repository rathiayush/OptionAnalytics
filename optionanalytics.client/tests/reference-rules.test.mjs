// #15 IB breakout skips an IB as wide as yesterday's whole range (kept - it measured better). #8's
// breakout-volume filter and #12's two-period rule were reverted to the 05 Oct 03:13 IST rules. Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, evaluateStrategies } from '../src/strategyEngine.js'
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }
function run(spot, minutes, pe = {}) {
  const sp = [], fut = [], ce = [], pes = []
  for (let m = 0; m <= minutes; m++) {
    const s = spot(m)
    sp.push({ time: iso(at(m)), open: s, high: s, low: s, close: s })
    fut.push({ time: iso(at(m)), open: s + 60, high: s + 60, low: s + 60, close: s + 60, volume: 1, openInterest: 1e7 })
    for (let k = 22300; k <= 23000; k += 50) {
      pes.push({ time: iso(at(m)), strike: k, openInterest: (pe[k] ?? (() => 1e6))(m) })
      ce.push({ time: iso(at(m)), strike: k, openInterest: 1e6 })
    }
  }
  return buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: sp, futuresBars: fut, cePoints: ce, pePoints: pes })
}
function bars(from, to, f) { const out = []; let cvd = 0; for (let m = from; m <= to; m++) { const b = { time: at(m), absorption: [], exhaustion: [], stacked: [], ...f(m) }; b.delta = b.buy - b.sell; cvd += b.delta; b.cvd = cvd; out.push(b) } return out }
const tape = (now, pct) => Array.from({ length: 50 }, (_, i) => ({ seq: i, time: now - 50000 + i * 1000, price: 1, quantity: 75, buy: ((i * 37) % 100) < pct }))
const evalAt = (now, price, bs, oi, o = {}) => evaluateStrategies({ nowMs: now, price, bars: bs, minuteBars: bs, prints: tape(now, o.buyPct ?? 75), book: { bids: [{ quantity: 600 }], asks: [{ quantity: 400 }] },
  liquidity: [], pullStack: [], sweeps: o.sweeps ?? [], icebergs: [], oi, estimated: false, lotSize: 75, bigLots: 10, profile: o.profile ?? null, includeRetired: o.includeRetired })

// #15 IB breakout: the IB's width against yesterday's range.
{
  const now = at(85) + 10000
  const oi = run((m) => 22650 + (m < 84 ? (m % 5) : 12), 85, { 22650: (m) => 3e6 + m * 20000, 22600: (m) => 3e6 + m * 20000 })
  const bs = bars(0, 84, (m) => { const p = m < 84 ? 22710 + (m % 5) : 22722; return { open: p - 1, high: p + 1, low: p - 1, close: p, buy: m === 84 ? 1500 : 500, sell: 500 } })
  const ib = (prevRange) => evalAt(now, 22722, bs, oi, { buyPct: 70, profile: prevRange ? { prevHigh: 22700 + prevRange, prevLow: 22700 } : null }).find((s) => s.id === 'ibBreakout')
  const narrow = ib(20)
  check('#15 IB (6 pts) narrow against yesterday\'s 20-pt range: fires, noted narrow, more confidence', narrow?.side === 'LONG' && /narrow/.test(narrow.checks.Profile) && narrow.confidenceParts[0].points > ib(10).confidenceParts[0].points, JSON.stringify(narrow?.checks.Profile))
  check('#15 IB as wide as yesterday\'s whole range (5 pts): skipped', !ib(5))
  check('#15 no previous day known: unchanged (fires)', ib(null)?.side === 'LONG')
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
