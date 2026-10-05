// Strategies 4 / 5, short-covering squeeze (LONG) / long-unwinding flush (SHORT), read from the futures OR
// the options OI - and why one did not fire (input.watch). Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, evaluateStrategies, optionOiRead, optionOiStance } from '../src/strategyEngine.js'
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }
const now = at(120) + 10_000
function scenario(dir, o = {}) {
  const fut = (m) => (m < 110 ? 22760 : 22760 + dir * (m - 110) * 5)
  const atm = dir > 0 ? 22750 : 22650
  const trapped = dir > 0 ? 'ce' : 'pe'
  const ks = [0, 1, 2].map((i) => atm + dir * i * 50)
  // Written since the open (+10k a minute) until 11:05, then covered (30k a minute).
  const writers = o.writers ?? ((m) => (m <= 110 ? 2e6 + m * 10000 : 3.1e6 - (m - 110) * 30000))
  const spot = [], futures = [], cePoints = [], pePoints = []
  for (let m = 0; m <= 120; m++) {
    const f = fut(m)
    spot.push({ time: iso(at(m)), open: f - 60, high: f - 60, low: f - 60, close: f - 60 })
    futures.push({ time: iso(at(m)), open: f, high: f, low: f, close: f, volume: 1000, openInterest: (o.futOi ?? (() => 1e7))(m) })
    for (let k = 22300; k <= 23200; k += 50) {
      // o.addingWall: that trapped strike is the biggest CALL wall and is being ADDED to; its neighbours
      // cover twice as hard. o.putsUnwind: puts near the money unwound in the last 15 minutes.
      const wallCe = o.addingWall === k ? 6e6 + Math.max(0, m - 110) * 20000 : null
      const ce = trapped === 'ce' && ks.includes(k) ? wallCe ?? (o.addingWall ? (m <= 110 ? 2e6 + m * 10000 : 3.1e6 - (m - 110) * 60000) : writers(m)) : 1e6
      const pe = trapped === 'pe' && ks.includes(k) ? writers(m) : o.putsUnwind && (k === 22650 || k === 22700) ? 2e6 - Math.max(0, m - 105) * 10000 : 1e6
      cePoints.push({ time: iso(at(m)), strike: k, openInterest: ce, price: 10 })
      pePoints.push({ time: iso(at(m)), strike: k, openInterest: pe, price: 10 })
    }
  }
  const oi = buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: spot, futuresBars: futures, cePoints, pePoints })
  let cvd = 0
  const bars = []
  for (let m = 0; m < 120; m++) {
    const c = fut(m)
    const wide = o.wide && m < 115 ? 25 : 3
    const flow = m >= 118 ? (dir > 0 ? { buy: 900, sell: 400 } : { buy: 400, sell: 900 }) : { buy: 500, sell: 500 }
    const lastFlow = m === 119 && o.deltaAgainst ? { buy: flow.sell, sell: flow.buy } : flow
    const b = { time: at(m), open: c, high: c + wide, low: c - wide, close: c, ...lastFlow, absorption: [], exhaustion: [], stacked: [] }
    b.delta = b.buy - b.sell; cvd += b.delta; b.cvd = cvd
    bars.push(b)
  }
  const buyPct = o.buyPct ?? (dir > 0 ? 75 : 25)
  const prints = Array.from({ length: 50 }, (_, i) => ({ seq: i, time: now - 50_000 + i * 1000, price: 1, quantity: 75, buy: ((i * 37) % 100) < buyPct }))
  const watch = []
  const setups = evaluateStrategies({ nowMs: now, price: o.price ?? fut(120), bars, minuteBars: bars, prints, book: { bids: [{ quantity: dir > 0 ? 600 : 400 }], asks: [{ quantity: dir > 0 ? 400 : 600 }] },
    liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi, estimated: false, lotSize: 75, bigLots: 10, profile: null, watch })
  return { s: setups.find((x) => x.id === (dir > 0 ? 'squeeze' : 'flush')), all: setups, watch, oi }
}
const show = ({ s, all }) => JSON.stringify(s ? { side: s.side, entry: s.entry, stop: +s.stop.toFixed(1), target: +s.target.toFixed(1), conf: s.confidence, checks: s.checks } : all.map((x) => `${x.id}:${x.side}`))

const L = scenario(1)
check('short squeeze from the OPTIONS OI alone (futures OI flat): call writers trapped since the open, covering -> LONG', L.s?.side === 'LONG' && /trapped writers covering/.test(L.s.checks.OI) && !/futures .* with OI/.test(L.s.checks.OI), show(L))
console.log('   ', L.s?.checks.OI)
check('...2R target (the futures OI did not cover too), stop under the 5-bar swing', L.s && Math.abs((L.s.target - L.s.entry) - 2 * (L.s.entry - L.s.stop)) < 0.01 && L.s.stop < 22782)
{
  // Puts near the money unwound too: the since-open blend reads the chain as AGAINST the long (the
  // trapped call writers) - the old check dropped this squeeze; the last 15 minutes back it.
  const U = scenario(1, { putsUnwind: true })
  const read = optionOiRead(U.oi, 22750, now, 15)
  check('trapped writers + puts unwinding: the old since-open blend says AGAINST, the squeeze still fires on the last 15 min', optionOiStance(read, 1) === 'against' && U.s?.side === 'LONG' && /last 15 min/.test(U.s.checks['Options OI']), `${optionOiStance(read, 1)} ${read?.combined?.toFixed(2)} ${show(U)}`)
}
const strong = scenario(1, { futOi: (m) => (m < 110 ? 1e7 : 1e7 - (m - 110) * 3000) })
check('futures short covering too: 3R target, higher confidence', strong.s && Math.abs((strong.s.target - strong.s.entry) - 3 * (strong.s.entry - strong.s.stop)) < 0.01 && strong.s.confidenceParts[0].points > L.s.confidenceParts[0].points, show(strong))
const S = scenario(-1)
check('long-unwinding flush: put writers trapped, covering into a fall -> SHORT', S.s?.side === 'SHORT' && S.s.target < S.s.entry && /PUT/.test(S.s.checks.OI), show(S))
const W = scenario(1, { wide: true })
check('volatile bars: the stop widens to 1.2x the 1-min range and the 2R target widens with it (was dropped before)', W.s && W.s.entry - W.s.stop > 39.5 && Math.abs((W.s.target - W.s.entry) - 2 * (W.s.entry - W.s.stop)) < 0.01, show(W))
// Not firing, and why.
const weak = scenario(1, { buyPct: 52 })
const rec = weak.watch.find((w) => w.id === 'squeeze')
check('weak tape: no trade - the watch says the OI shows it and the tape is what is missing', !weak.s && rec && rec.evidence.length >= 1 && rec.missing.some((m) => /30s tape 60%/.test(m)), JSON.stringify(weak.watch))
const against = scenario(1, { deltaAgainst: true })
check('delta against on the last bar: no trade, reported', !against.s && against.watch.some((w) => w.id === 'squeeze' && w.missing.some((m) => /delta/.test(m))))
check('no covering (writers still adding): nothing, not even a watch', (() => { const r = scenario(1, { writers: (m) => 2e6 + m * 10000 }); return !r.s && !r.watch.some((w) => w.id === 'squeeze') })())
{
  const r = scenario(1, { addingWall: 22800 })
  check('the CALL wall just ahead (22800) being added to: no trade, reported', !r.s && r.watch.some((w) => w.id === 'squeeze' && w.missing.some((m) => /wall 22800 just ahead is being added to/.test(m))), JSON.stringify(r.watch))
}
check('price below VWAP: no squeeze long', !scenario(1, { price: 22700 }).s)
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
