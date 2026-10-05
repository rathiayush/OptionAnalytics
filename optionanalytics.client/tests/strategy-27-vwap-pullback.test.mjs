// Strategy 27, VWAP pullback (trend continuation) with OI + heatmap confirmation: LONG and SHORT, and not
// when a key condition is missing. Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, evaluateStrategies, STRATEGIES, strategyStats, topFifteen, vwapOf } from '../src/strategyEngine.js'
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
const NOW = at(85) + 10_000 // 10:40
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }

function scenario(d, o = {}) {
  const mir = (p) => (d > 0 ? p : 2 * 22750 - p)
  // A trend: up 1.5 a minute to 10:29 on full volume, then a light pullback toward VWAP.
  const raw = (m) => (o.flat ? 22750 + ((m % 4) - 2) : m < 75 ? 22700 + m * 1.5 : 22812 - (m - 75) * 5)
  const bars = []
  let cvd = 0
  for (let m = 0; m < 85; m++) {
    const c = mir(raw(m))
    const heavy = m < 75
    const b = { time: at(m), open: c, high: c + 2, low: c - 2, close: c, buy: heavy ? 500 : 60, sell: heavy ? 500 : 60, absorption: [], exhaustion: [], stacked: [], levels: [] }
    bars.push(b)
  }
  // The pullback tags VWAP on the last bars, the last one turning back with the trend.
  const vwap = vwapOf(bars, at(84))
  for (let m = 82; m < 85; m++) {
    const b = bars[m]
    const c = vwap + d * (o.brokeThrough && m === 83 ? -30 : m === 84 ? 4 : 1)
    Object.assign(b, { open: c, close: c, high: Math.max(c, vwap) + 1, low: Math.min(c, vwap) - 1 })
    if (m === 84) { b.buy = d > 0 ? 90 : 40; b.sell = d > 0 ? 40 : 90 }
  }
  for (const b of bars) { b.delta = b.buy - b.sell; cvd += b.delta; b.cvd = cvd }
  const price = bars[84].close
  // Heatmap: a bid wall (offer wall for a short) resting at VWAP for the last 10 minutes.
  const wallRow = Math.round(vwap) - d
  const columns = []
  for (let t = NOW - 10 * MIN; t <= NOW; t += 30_000) {
    const side = []
    const other = []
    for (let k = 1; k <= 15; k++) {
      const p = Math.round(price) - d * k
      side.push([p, !o.noWall && (p === wallRow || p === wallRow - d) ? 1200 : 100])
      other.push([Math.round(price) + d * k, 100])
    }
    columns.push(d > 0 ? { t, bids: side, asks: other } : { t, bids: other, asks: side })
  }
  // OI: the trade's side written across the chain (puts for a long), futures OI building with price.
  const spot = [], futures = [], cePoints = [], pePoints = []
  for (let m = 0; m <= 85; m++) {
    const f = m < 85 ? bars[m].close : price
    spot.push({ time: iso(at(m)), open: f - 60, high: f - 60, low: f - 60, close: f - 60 })
    futures.push({ time: iso(at(m)), open: f, high: f, low: f, close: f, volume: 1000, openInterest: o.oiFalling ? 1e7 - m * 3000 : 1e7 + m * 3000 })
    for (let k = 22300; k <= 23200; k += 50) {
      const written = o.noWriters ? 1e6 : 1e6 + m * 8000
      pePoints.push({ time: iso(at(m)), strike: k, openInterest: d > 0 ? written : 1e6, price: 10 })
      cePoints.push({ time: iso(at(m)), strike: k, openInterest: d > 0 ? 1e6 : written, price: 10 })
    }
  }
  const oi = buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: spot, futuresBars: futures, cePoints, pePoints })
  const buyPct = d > 0 ? 70 : 30
  const prints = Array.from({ length: 50 }, (_, i) => ({ seq: i, time: NOW - 50_000 + i * 1000, price: 1, quantity: 75, buy: ((i * 37) % 100) < buyPct }))
  const setups = evaluateStrategies({ includeRetired: true,  nowMs: NOW, price, bars, minuteBars: bars, prints, book: { bids: [{ quantity: d > 0 ? 600 : 400 }], asks: [{ quantity: d > 0 ? 400 : 600 }] },
    liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi, estimated: !!o.estimated, lotSize: 75, bigLots: 10, profile: null, heatmap: columns, rowSize: 1 })
  return { s: setups.find((x) => x.id === 'vwapPullback'), all: setups, vwap }
}
const show = ({ s, all }) => JSON.stringify(s ? { side: s.side, entry: s.entry, stop: +s.stop.toFixed(1), target: +s.target.toFixed(1), checks: s.checks } : all.map((x) => `${x.id}:${x.side}`))

check('30 strategies, #27 is the VWAP pullback (back in the line-up)', STRATEGIES.length === 30 && STRATEGIES.find((x) => x.no === 27)?.id === 'vwapPullback' && !STRATEGIES.find((x) => x.no === 27).retired)
const L = scenario(1)
check('LONG: trend above a rising VWAP, the pullback tags it and turns, writers + futures back it, a bid wall at VWAP', L.s?.side === 'LONG' && L.s.stop < L.s.entry && L.s.target > L.s.entry && /bid wall/.test(L.s.checks['Liquidity map']) && /writers back it/.test(L.s.checks.OI), show(L))
console.log('   ', L.s?.checks.VWAP, '|', L.s?.checks['Liquidity map'], '|', L.s?.checks.Plan)
check('...target toward the day\'s high, 2-3R', L.s && L.s.target - L.s.entry >= 2 * (L.s.entry - L.s.stop) - 0.01 && L.s.target - L.s.entry <= 3 * (L.s.entry - L.s.stop) + 0.01)
const S = scenario(-1)
check('SHORT: the mirror under a falling VWAP, an offer wall at VWAP, call writers', S.s?.side === 'SHORT' && S.s.stop > S.s.entry && S.s.target < S.s.entry && /offer wall/.test(S.s.checks['Liquidity map']), show(S))
check('not without the heatmap wall at VWAP', !scenario(1, { noWall: true }).s)
check('not without OI behind it (writers neutral, futures OI falling)', !scenario(1, { noWriters: true, oiFalling: true }).s)
check('not after a close through VWAP (the pullback broke it)', !scenario(1, { brokeThrough: true }).s)
check('not on a flat day (VWAP not sloping, no trend)', !scenario(1, { flat: true }).s)
check('not on an estimated day (no heatmap)', !scenario(1, { estimated: true }).s)
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
