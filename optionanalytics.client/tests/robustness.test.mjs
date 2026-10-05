// Random whole days through every strategy: nothing throws, every setup has its stop and target on the right sides.
// Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, evaluateStrategies, STRATEGIES } from '../src/strategyEngine.js'
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
let seed = 1
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646 }
const counts = Object.fromEntries(STRATEGIES.map((s) => [s.id, 0]))
let bad = 0, total = 0, errors = 0, held = 0
const t0 = Date.now()
for (let day = 1; day <= 24; day++) {
  seed = day * 7919
  const estimated = day % 3 === 0
  const regime = day % 4 // 0 trend up, 1 trend down, 2/3 range
  const N = 375
  const bars = []
  let p = 22760, cvd = 0
  for (let m = 0; m < N; m++) {
    const drift = regime === 0 ? 0.25 : regime === 1 ? -0.25 : -0.02 * (p - 22760)
    const o = p
    p = p + drift + (rnd() - 0.5) * 12
    const c = Math.round(p * 20) / 20
    const h = Math.max(o, c) + rnd() * 6, l = Math.min(o, c) - rnd() * 6
    const buy = Math.round(400 + rnd() * 600 + (c > o ? 200 : 0)), sell = Math.round(400 + rnd() * 600 + (c < o ? 200 : 0))
    cvd += buy - sell
    const r = rnd()
    bars.push({ time: at(m), open: o, high: h, low: l, close: c, buy, sell, delta: buy - sell, cvd,
      stacked: r < 0.08 ? [{ side: c > o ? 'buy' : 'sell', low: c - 4, high: c + 2, rows: 3 }] : [],
      absorption: r > 0.93 ? [{ side: c > o ? 'buy' : 'sell', price: c }] : [],
      exhaustion: r > 0.88 && r < 0.93 ? [{ side: c > o ? 'buy' : 'sell', price: c }] : [] })
  }
  // OI: per strike random walks with a bias by regime.
  const spot = [], fut = [], ce = [], pe = []
  const oiState = new Map()
  for (let m = 0; m < N; m++) {
    const f = bars[m].close
    spot.push({ time: iso(at(m)), open: f - 60, high: f - 60, low: f - 60, close: f - 60 })
    fut.push({ time: iso(at(m)), open: f, high: f, low: f, close: f, volume: 1000, openInterest: 1e7 + m * (regime < 2 ? 3000 : 0) + Math.round((rnd() - 0.5) * 20000) })
    for (let k = 22300; k <= 23200; k += 50) {
      const key = k
      const st = oiState.get(key) ?? { ce: 1e6 + rnd() * 4e6, pe: 1e6 + rnd() * 4e6 }
      st.ce = Math.max(1e5, st.ce + (rnd() - (regime === 1 ? 0.35 : 0.5)) * 30000)
      st.pe = Math.max(1e5, st.pe + (rnd() - (regime === 0 ? 0.35 : 0.5)) * 30000)
      oiState.set(key, st)
      ce.push({ time: iso(at(m)), strike: k, openInterest: Math.round(st.ce), price: 50 + rnd() * 50 })
      pe.push({ time: iso(at(m)), strike: k, openInterest: Math.round(st.pe), price: 50 + rnd() * 50 })
    }
  }
  const oi = buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: spot, futuresBars: fut, cePoints: ce, pePoints: pe })
  const prints = []
  if (!estimated) for (let m = 0; m < N; m++) for (let i = 0; i < 20; i++) prints.push({ seq: prints.length, time: at(m) + i * 3000, price: bars[m].close, quantity: rnd() < 0.03 ? 1500 : 75, buy: rnd() < bars[m].buy / (bars[m].buy + bars[m].sell) })
  const profile = day % 2 ? { vp: { poc: 22760, vah: 22800, val: 22720, hvn: [22740, 22790], lvn: [22770] }, tpoPrev: { poc: 22760, vah: 22800, val: 22720 }, prevHigh: 22830, prevLow: 22690 } : null
  for (let m = 15; m < N - 20; m++) {
    const nowMs = at(m) + 10_000
    const done = bars.slice(0, m)
    const upTo = prints.filter((x) => x.time <= nowMs)
    try {
      const setups = evaluateStrategies({ nowMs, price: bars[m].open, bars: done, minuteBars: bars.slice(0, m + 1), prints: estimated ? null : upTo, book: { bids: [{ quantity: 400 + rnd() * 200 }], asks: [{ quantity: 400 + rnd() * 200 }] },
        liquidity: [], pullStack: [], sweeps: rnd() < 0.05 ? [{ buy: rnd() < 0.5, endedAt: iso(nowMs - 20000) }] : [], icebergs: [], oi, estimated, lotSize: 75, bigLots: 10, profile })
      for (const s of setups) {
        total++
        counts[s.id]++
        const dir = s.side === 'LONG' ? 1 : -1
        const ok = [s.entry, s.stop, s.target, s.confidence, s.timeStopMs].every(Number.isFinite) && dir * (s.entry - s.stop) > 0 && dir * (s.target - s.entry) > 0 && s.confidence >= 40 && s.confidence <= 92
          // the confidence is its parts (clamped 40-92), graded, and shown first in the checks
          && s.confidence === Math.round(Math.max(40, Math.min(92, s.confidenceParts.reduce((a, x) => a + x.points, 0)))) && ['High', 'Medium', 'Low'].includes(s.grade) && Object.keys(s.checks)[0] === 'Confidence'
          && (!s.coolOff || (s.coolOff.run > 0 && /cool off/.test(s.checks.Pace)))
        if (s.coolOff) held++
        if (!ok) { bad++; if (bad < 5) console.log('BAD', JSON.stringify(s).slice(0, 400)) }
      }
    } catch (err) { errors++; if (errors < 5) console.log('ERROR day', day, 'm', m, err.stack.split('\n').slice(0, 3).join(' | ')) }
  }
}
console.log(`evaluations ok in ${Date.now() - t0} ms; setups ${total} (${held} waiting for a cool-off), invalid ${bad}, exceptions ${errors}`)
console.log(Object.entries(counts).map(([k, v]) => `${k}:${v}`).join('  '))
process.exitCode = bad || errors ? 1 : 0
