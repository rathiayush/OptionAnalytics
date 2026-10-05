// Rules updated to their references: #8 opening-range breakout needs breakout-bar volume, #15 IB breakout
// skips an IB as wide as yesterday's whole range, #12 (retired) is the canonical 80% rule - two 30-minute
// periods accepted inside the value area. Run: npm test (node --test) - see CLAUDE.md.
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

// #8 Opening OI bias + ORB: the breakout bar's volume decides.
{
  const now = at(26) + 10_000
  const oi = run((m) => (m <= 15 ? 22650 + (m % 3) : 22660 + (m - 15) * 2), 26, { 22600: (m) => 3e6 + m * 30000, 22650: (m) => 3e6 + m * 30000 })
  const mk = (breakBuy) => bars(0, 25, (m) => { const p = m < 15 ? 22710 + (m % 3) : (m < 25 ? 22711 : 22716); return { open: p - 1, high: p + 1, low: p - 2, close: p, buy: m === 25 ? breakBuy : 500, sell: 500 } })
  const sweeps = [{ id: 2, buy: true, startedAt: iso(now - 20000), endedAt: iso(now - 19000), fromPrice: 1, toPrice: 2, quantity: 900, prints: 3, levels: 3 }]
  const loud = evalAt(now, 22716, mk(1500), oi, { sweeps }).find((s) => s.id === 'openingBias')
  check('#8 ORB: a close beyond the range on 2x the opening bars\' volume fires LONG, volume noted', loud?.side === 'LONG' && /2\.0x the opening bars' volume/.test(loud.checks.Footprint), JSON.stringify(loud?.checks))
  check('#8 ORB: target 2-3R (1.5x the range, at least 2R)', loud && (loud.target - loud.entry) >= 2 * (loud.entry - loud.stop) - 0.01 && (loud.target - loud.entry) <= 3 * (loud.entry - loud.stop) + 0.01)
  check('#8 ORB: the same break on ordinary volume (1.1x) does not fire', !evalAt(now, 22716, mk(600), oi, { sweeps }).some((s) => s.id === 'openingBias'))
}
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
// #12 (retired) the 80% rule: opened below the value area, two 30-minute periods accepted inside.
{
  const tpoPrev = { val: 22720, vah: 22800, poc: 22760 }
  const path = (enterAt) => (m) => (m < enterAt ? 22705 : 22730 + (m % 15))
  const mk = (enterAt) => bars(0, 91, (m) => { const p = path(enterAt)(m); return { open: m === 0 ? 22700 : p, high: p + 2, low: p - 2, close: p, buy: m >= 62 ? 700 : 500, sell: 500 } })
  const ctx = (enterAt) => run((m) => path(enterAt)(m) - 60, 120)
  const at80 = (enterAt, now) => evalAt(now, 22745, mk(enterAt).filter((b) => b.time + MIN <= now), ctx(enterAt), { buyPct: 70, includeRetired: true, profile: { tpoPrev, vp: { poc: 22760, vah: 22800, val: 22720, hvn: [], lvn: [] } } }).find((s) => s.id === 'tpo80')
  const s = at80(20, at(92) + 10000)
  check('#12 80% rule: two periods (09:45-10:15, 10:15-10:45) accepted inside -> LONG to the VAH at 10:47', s?.side === 'LONG' && Math.abs(s.target - 22800) < 0.01 && /two 30-minute periods/.test(s.checks.Profile), JSON.stringify(s?.checks ?? null))
  check('#12 only one period accepted (entered the value area at 10:00) -> no', !at80(45, at(92) + 10000))
  check('#12 not 20 minutes after the second period (stale)', !at80(20, at(110) + 10000))
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
