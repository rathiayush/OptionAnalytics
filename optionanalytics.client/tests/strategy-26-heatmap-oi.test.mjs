// Strategy 26, OI + liquidity heatmap confluence: HOLD (absorption at a heatmap wall where the option
// writers of that side are adding) and BREAK (the wall eaten while those writers cover), LONG and SHORT,
// and not when a key condition is missing. Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, evaluateStrategies, STRATEGIES, strategyStats, topFifteen } from '../src/strategyEngine.js'
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
const NOW = at(85) + 10_000 // 10:40
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }

// Mirror helper: d = +1 builds the long-side picture (a bid wall under the price), d = -1 its mirror
// around 22750 (an offer wall over it).
function scenario(d, o = {}) {
  const mir = (p) => (d > 0 ? p : 2 * 22750 - p)
  const price = mir(22748)
  const basis = d > 0 ? 45 : 55 // the wall (futures 22745 / 22755) = strike 22700 + basis
  // Heatmap: 10 min of snapshots every 30 s - 100 a row, a 2-row wall (1000 each) next to the price.
  const columns = []
  for (let t = NOW - 10 * MIN; t <= NOW; t += 30_000) {
    const scale = o.wallFades && t >= NOW - 2 * MIN ? 0.2 : 1
    const near = []
    const far = []
    for (let k = 1; k <= 15; k++) {
      const p = mir(22750 - k) // the wall's side
      near.push([p, p === mir(22745) || p === mir(22746) ? 1000 * scale : 100])
      far.push([mir(22750 + k), 100])
    }
    columns.push(d > 0 ? { t, bids: near, asks: far } : { t, bids: far, asks: near })
  }
  // Bars: flat, the last three hitting the wall (into it) - the last bar's delta turning with the trade.
  const fut = (m) => (o.futDrift ? mir(22760) - d * Math.max(0, m - 70) * 0.8 : price)
  const bars = []
  let cvd = 0
  for (let m = 0; m < 85; m++) {
    const c = fut(m)
    const hitting = m >= 82
    const wallRow = mir(22746)
    const intoWall = o.noFlowInto ? 20 : 800
    const levels = hitting ? [{ price: wallRow, buy: d > 0 ? 100 : intoWall, sell: d > 0 ? intoWall : 100 }] : []
    const turn = m === 84 ? (o.breakFlow ? -d : d) : -d
    const b = { time: at(m), open: c, high: c + 2, low: c - 2, close: c, buy: turn > 0 ? 900 : 600, sell: turn > 0 ? 600 : 900, levels, absorption: [], exhaustion: [], stacked: [] }
    b.delta = b.buy - b.sell; cvd += b.delta; b.cvd = cvd
    bars.push(b)
  }
  const side = d > 0 ? 'pe' : 'ce'
  const writers = o.writers ?? ((m) => 5e6 + m * 20000)
  const spot = [], futures = [], cePoints = [], pePoints = []
  for (let m = 0; m <= 85; m++) {
    const f = fut(m)
    spot.push({ time: iso(at(m)), open: f - basis, high: f - basis, low: f - basis, close: f - basis })
    futures.push({ time: iso(at(m)), open: f, high: f, low: f, close: f, volume: 1000, openInterest: (o.futOi ?? (() => 1e7))(m) })
    for (let k = 22300; k <= 23200; k += 50) {
      const mine = k === 22700 ? (o.noOptionWall ? 1e6 : writers(m)) : (k === (d > 0 ? 22850 : 22550) ? 4e6 : 1e6) // + the opposite wall 145-205 pts away
      const pt = (oi) => ({ time: iso(at(m)), strike: k, openInterest: oi, price: 10 })
      if (side === 'pe') { pePoints.push(pt(k === 22700 ? mine : 1e6)); cePoints.push(pt(k === 22850 ? 4e6 : 1e6)) } else { cePoints.push(pt(k === 22700 ? mine : 1e6)); pePoints.push(pt(k === 22550 ? 4e6 : 1e6)) }
    }
  }
  const oi = buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: spot, futuresBars: futures, cePoints, pePoints })
  const buyPct = o.buyPct ?? (o.breakFlow ? (d > 0 ? 30 : 70) : (d > 0 ? 70 : 30))
  const prints = Array.from({ length: 50 }, (_, i) => ({ seq: i, time: NOW - 50_000 + i * 1000, price: 1, quantity: 75, buy: ((i * 37) % 100) < buyPct }))
  const bookBids = o.breakFlow ? (d > 0 ? 400 : 600) : (d > 0 ? 600 : 400)
  const setups = evaluateStrategies({ includeRetired: true,  nowMs: NOW, price, bars, minuteBars: bars, prints, book: { bids: [{ quantity: bookBids }], asks: [{ quantity: 1000 - bookBids }] },
    liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi, estimated: !!o.estimated, lotSize: 75, bigLots: 10, profile: null,
    heatmap: o.noHeatmap ? null : columns, rowSize: 1 })
  return { s: setups.find((x) => x.id === 'heatmapOi'), all: setups, columns, bars, price }
}
const show = ({ s, all }) => JSON.stringify(s ? { side: s.side, entry: s.entry, stop: +s.stop.toFixed(1), target: +s.target.toFixed(1), checks: s.checks } : all.map((x) => `${x.id}:${x.side}`))

check('28 strategies, #26 is the heatmap + OI confluence (retired since the 05 Oct revert)', STRATEGIES.length === 28 && STRATEGIES.find((x) => x.no === 26)?.id === 'heatmapOi' && STRATEGIES.find((x) => x.no === 26).retired)
const L = scenario(1)
check('HOLD long: absorption at the bid wall + PUT 22700 writers adding there -> LONG, stop under the wall, target the CALL wall', L.s?.side === 'LONG' && L.s.stop < 22745 && L.s.target > L.s.entry && /ABSORPTION/.test(L.s.checks['Liquidity map']) && /PUT 22700/.test(L.s.checks.OI) && /adding/.test(L.s.checks.OI), show(L))
console.log('   ', L.s?.checks['Liquidity map'], '|', L.s?.checks.OI, '|', L.s?.checks.Plan)
const S = scenario(-1)
check('HOLD short: absorption at the offer wall + CALL 22700 writers adding -> SHORT', S.s?.side === 'SHORT' && S.s.stop > S.s.entry && S.s.target < S.s.entry && /CALL 22700/.test(S.s.checks.OI), show(S))
check('...not without an option wall there', !scenario(1, { noOptionWall: true }).s)
check('...not while those writers are covering (hold needs them adding)', !scenario(1, { writers: (m) => 6e6 - m * 20000 }).s)
check('...not into a futures short build-up (price down, OI up)', !scenario(1, { futDrift: true, futOi: (m) => 1e7 + Math.max(0, m - 70) * 3000 }).s)
check('...not without aggression into the wall (no absorption read)', !scenario(1, { noFlowInto: true }).s)
check('...not on an estimated day, nor without the heatmap', !scenario(1, { estimated: true }).s && !scenario(1, { noHeatmap: true }).s)
// BREAK: the bid wall eaten while the PUT writers cover, futures falling -> SHORT through it.
const B = scenario(1, { wallFades: true, writers: (m) => 6e6 - m * 20000, futDrift: true, breakFlow: true })
check('BREAK: the bid wall eaten, PUT 22700 writers covering, futures falling -> SHORT', B.s?.side === 'SHORT' && /BREAK/.test(B.s.checks['Liquidity map']) && /covering/.test(B.s.checks.OI), show(B))
check('...not when the writers are adding (a break needs them covering)', !scenario(1, { wallFades: true, futDrift: true, breakFlow: true }).s)
const BU = scenario(-1, { wallFades: true, writers: (m) => 6e6 - m * 20000, futDrift: true, breakFlow: true })
check('BREAK up: the offer wall eaten, CALL writers covering, futures rising -> LONG', BU.s?.side === 'LONG' && /BREAK/.test(BU.s.checks['Liquidity map']), show(BU))
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
