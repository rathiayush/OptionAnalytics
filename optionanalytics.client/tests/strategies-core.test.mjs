// Strategies 1-10: setups fire on their rules, outcomes, stats and the top 5.
// Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, evaluateStrategies as evaluate, simulateOutcome, strategyStats, topFive, ACTIVE_STRATEGIES, STRATEGIES } from '../src/strategyEngine.js'
// Retired strategies still get exercised by these scenarios (includeRetired).
const evaluateStrategies = (input) => evaluate({ ...input, includeRetired: true })
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN // minutes after 09:15 IST
const iso = (ms) => new Date(ms).toISOString()
let fails = 0
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${extra}`); if (!cond) fails++ }

function run({ spotPath, futOi, pe = {}, ce = {}, minutes = 130 }) {
  const spot = [], fut = [], cePoints = [], pePoints = []
  for (let m = 0; m <= minutes; m++) {
    const s = spotPath(m)
    spot.push({ time: iso(at(m)), open: s, high: s, low: s, close: s })
    fut.push({ time: iso(at(m)), open: s + 60, high: s + 60, low: s + 60, close: s + 60, volume: 1000, openInterest: futOi(m) })
    for (let k = 22300; k <= 23000; k += 50) {
      pePoints.push({ time: iso(at(m)), strike: k, openInterest: (pe[k] ?? (() => 1_000_000))(m), price: 10 })
      cePoints.push({ time: iso(at(m)), strike: k, openInterest: (ce[k] ?? (() => 1_000_000))(m), price: 10 })
    }
  }
  return { success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: spot, futuresBars: fut, cePoints, pePoints }
}
function bars(fromM, toM, f) {
  const out = []
  let cvd = 0
  for (let m = fromM; m <= toM; m++) {
    const b = { time: at(m), absorption: [], exhaustion: [], stacked: [], ...f(m) }
    b.delta = b.buy - b.sell; cvd += b.delta; b.cvd = cvd
    out.push(b)
  }
  return out
}
const tapeWith = (nowMs, buyPct) => Array.from({ length: 50 }, (_, i) => ({ seq: i, time: nowMs - 50_000 + i * 1000, price: 1, quantity: 75, buy: ((i * 37) % 100) < buyPct }))

// A. OI wall defence LONG at 10:55: spot drifts down to just above the 22600 put wall, put OI rising.
{
  const now = at(100) + 30_000
  const r = run({ spotPath: (m) => 22700 - Math.min(95, m), futOi: () => 1e7, pe: { 22600: (m) => 5e6 + m * 20000 }, ce: { 22800: (m) => 4e6 + m * 5000 } })
  const oi = buildOiContext(r)
  const bs = bars(0, 99, (m) => ({ open: 22760 - Math.min(95, m), high: 22762 - Math.min(95, m), low: 22758 - Math.min(95, m), close: 22760 - Math.min(95, m), buy: m >= 98 ? 900 : 500, sell: 600 }))
  bs[bs.length - 1].absorption = [{ side: 'buy', price: 22665 }]
  const setups = evaluateStrategies({ nowMs: now, price: 22665, bars: bs, minuteBars: bs, prints: tapeWith(now, 70), book: { bids: [{ quantity: 600 }], asks: [{ quantity: 400 }] }, liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi, estimated: false, lotSize: 75, bigLots: 10 })
  const s = setups.find((x) => x.id === 'wallDefence')
  check('wall defence long fires at the put wall', s?.side === 'LONG', JSON.stringify(s?.checks ?? setups.map((x) => x.id)))
  if (!s) process.exit(1)
  // Outcome: price rallies 0.3% next minutes -> win.
  const after = [...bs, ...bars(101, 140, (m) => ({ open: 22665 + (m - 100) * 3, high: 22668 + (m - 100) * 3, low: 22663 + (m - 100) * 3, close: 22666 + (m - 100) * 3, buy: 600, sell: 400 }))]
  const o = simulateOutcome(s, after, at(141))
  check('its outcome is a win at the target', o.status === 'win' && o.r > 1.4, JSON.stringify(o))
  // Same picture but put OI FALLING -> no wall defence.
  const r2 = run({ spotPath: (m) => 22700 - Math.min(95, m), futOi: () => 1e7, pe: { 22600: (m) => 5e6 - m * 20000 }, ce: { 22800: (m) => 4e6 + m * 5000 } })
  const none = evaluateStrategies({ nowMs: now, price: 22665, bars: bs, minuteBars: bs, prints: tapeWith(now, 70), book: { bids: [{ quantity: 600 }], asks: [{ quantity: 400 }] }, liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi: buildOiContext(r2), estimated: false, lotSize: 75, bigLots: 10 })
  check('no wall defence when the wall OI is falling', !none.some((x) => x.id === 'wallDefence'))
  // DOM strongly against (offers 70%) -> no trade.
  const against = evaluateStrategies({ nowMs: now, price: 22665, bars: bs, minuteBars: bs, prints: tapeWith(now, 70), book: { bids: [{ quantity: 300 }], asks: [{ quantity: 700 }] }, liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi, estimated: false, lotSize: 75, bigLots: 10 })
  check('no trade when the DOM is against it', !against.some((x) => x.id === 'wallDefence'))
}

// A2. Options OI on every strategy: heavy CALL writing near ATM blocks the same long; put writing adds confidence.
{
  const now = at(100) + 30_000
  const bs = bars(0, 99, (m) => ({ open: 22760 - Math.min(95, m), high: 22762 - Math.min(95, m), low: 22758 - Math.min(95, m), close: 22760 - Math.min(95, m), buy: m >= 98 ? 900 : 500, sell: 600 }))
  bs[bs.length - 1].absorption = [{ side: 'buy', price: 22665 }]
  const base = { nowMs: now, price: 22665, bars: bs, minuteBars: bs, prints: tapeWith(now, 70), book: { bids: [{ quantity: 600 }], asks: [{ quantity: 400 }] }, liquidity: [], pullStack: [], sweeps: [], icebergs: [], estimated: false, lotSize: 75, bigLots: 10 }
  const callWriting = run({ spotPath: (m) => 22700 - Math.min(95, m), futOi: () => 1e7, pe: { 22600: (m) => 5e6 + m * 20000 }, ce: { 22800: (m) => 4e6 + m * 5000, 22650: (m) => 3e6 + m * 60000, 22700: (m) => 3e6 + m * 60000 } })
  check('options OI against (call writing near ATM) blocks the long', !evaluateStrategies({ ...base, oi: buildOiContext(callWriting) }).some((x) => x.id === 'wallDefence'))
  const putWriting = run({ spotPath: (m) => 22700 - Math.min(95, m), futOi: () => 1e7, pe: { 22600: (m) => 5e6 + m * 20000, 22650: (m) => 1e6 + m * 30000, 22700: (m) => 1e6 + m * 30000 }, ce: { 22800: (m) => 4e6 + m * 5000 } })
  const backed = evaluateStrategies({ ...base, oi: buildOiContext(putWriting) }).find((x) => x.id === 'wallDefence')
  const plain = evaluateStrategies({ ...base, oi: buildOiContext(run({ spotPath: (m) => 22700 - Math.min(95, m), futOi: () => 1e7, pe: { 22600: (m) => 5e6 + m * 20000 }, ce: { 22800: (m) => 4e6 + m * 5000, 22650: (m) => 1e6 + m * 20000 } })) }).find((x) => x.id === 'wallDefence') // calls written as fast: neutral
  check('put writing near ATM backs it: higher confidence than neutral, Confidence then Options OI shown first', backed && plain && /neutral/.test(plain.checks['Options OI']) && backed.confidence > plain.confidence && Object.keys(backed.checks)[0] === 'Confidence' && /options writers back it \+6/.test(backed.checks.Confidence) && Object.keys(backed.checks)[1] === 'Options OI' && /PCR/.test(backed.checks['Options OI']), backed?.checks['Options OI'])
}

// B. Short-covering squeeze LONG at 11:20: futures +0.2% in 10 min, futures OI -0.5%.
{
  const now = at(125) + 20_000
  const r = run({ spotPath: (m) => (m < 115 ? 22700 : 22700 + (m - 115) * 5), futOi: (m) => (m < 115 ? 1e7 : 1e7 - (m - 115) * 6000), ce: { 22800: (m) => 4e6 - Math.max(0, m - 115) * 1000 } })
  const oi = buildOiContext(r)
  const bs = bars(0, 124, (m) => { const p = m < 115 ? 22760 : 22760 + (m - 115) * 5; return { open: p - 2, high: p + 1, low: p - 3, close: p, buy: m >= 120 ? 1200 : 500, sell: m >= 120 ? 400 : 500 } })
  const sweeps = [{ id: 1, buy: true, startedAt: iso(now - 30000), endedAt: iso(now - 29000), fromPrice: 1, toPrice: 2, quantity: 900, prints: 3, levels: 3 }]
  const setups = evaluateStrategies({ nowMs: now, price: 22810, bars: bs, minuteBars: bs, prints: tapeWith(now, 80), book: { bids: [{ quantity: 700 }], asks: [{ quantity: 300 }] }, liquidity: [], pullStack: [], sweeps, icebergs: [], oi, estimated: false, lotSize: 75, bigLots: 10 })
  check('short-covering squeeze long fires', setups.some((x) => x.id === 'squeeze' && x.side === 'LONG'), setups.map((x) => x.id).join())
}

// C. Opening OI bias + ORB LONG at 09:41: put writing near ATM 09:15-09:30, break of the range high.
{
  const now = at(26) + 10_000
  const r = run({ spotPath: (m) => (m <= 15 ? 22650 + (m % 3) : 22660 + (m - 15) * 2), futOi: () => 1e7, pe: { 22600: (m) => 3e6 + m * 30000, 22650: (m) => 3e6 + m * 30000 } })
  const oi = buildOiContext(r)
  const bs = bars(0, 25, (m) => { const p = m < 15 ? 22710 + (m % 3) : (m < 25 ? 22711 : 22716); return { open: p - 1, high: p + 1, low: p - 2, close: p, buy: m === 25 ? 1500 : 500, sell: 500 } })
  const sweeps = [{ id: 2, buy: true, startedAt: iso(now - 20000), endedAt: iso(now - 19000), fromPrice: 1, toPrice: 2, quantity: 900, prints: 3, levels: 3 }]
  const setups = evaluateStrategies({ nowMs: now, price: 22716, bars: bs, minuteBars: bs, prints: tapeWith(now, 75), book: { bids: [{ quantity: 600 }], asks: [{ quantity: 400 }] }, liquidity: [], pullStack: [], sweeps, icebergs: [], oi, estimated: false, lotSize: 75, bigLots: 10 })
  check('opening OI bias breakout long fires', setups.some((x) => x.id === 'openingBias' && x.side === 'LONG'), setups.map((x) => x.id).join())
}

// D. Nothing fires before 09:30 or after 14:45.
{
  const r = run({ spotPath: () => 22700, futOi: () => 1e7 })
  const bs = bars(0, 10, () => ({ open: 1, high: 1, low: 1, close: 1, buy: 1, sell: 1 }))
  check('no setups before 09:30', evaluateStrategies({ nowMs: at(10), price: 22760, bars: bs, minuteBars: bs, oi: buildOiContext(r) }).length === 0)
}

// E. Stats and top 5.
{
  const mk = (id, rs) => rs.map((r, i) => ({ id, t: i, outcome: { status: r > 0 ? 'win' : 'loss', r } }))
  // wallBreak / migration are retired: their (old) trades are not counted.
  const trades = [...mk('wallBreak', [2, 2, -1, 2, -1, 2]), ...mk('range', [-1, -1, 0.5, -1, -1]), ...mk('squeeze', [1.3, 1.3, 1.3, -1, 1.3]),
    ...mk('buildUp', [2.5, -1, -1, 2.5, -1]), ...mk('flush', [-1, -1, -1, -1, 1.3]), ...mk('migration', [2, -1, 2, 2, -1])]
  const stats = strategyStats(trades)
  const sq = stats.find((s) => s.id === 'squeeze')
  check('win rate / avg R computed', Math.round(sq.winRate * 100) === 80 && Math.abs(sq.avgR - 0.84) < 1e-9, `${sq.winRate} ${sq.avgR}`)
  check('a retired strategy is not in the stats, whatever trades it has', !stats.some((s) => s.id === 'wallBreak' || s.id === 'migration'))
  const top = topFive(stats)
  check('top 5: best expectancy first, losing strategies never alerted, unmeasured picks fill in', top.ids[0] === 'squeeze' && !top.ids.includes('flush') && !top.ids.includes('range') && top.ids.includes('openingBias') && !top.measured, top.ids.join())
  const few = topFive(strategyStats(mk('range', [2, 2])))
  check('playbook picks until enough trades - never a retired one', !few.measured && few.ids.join() === 'buildUp,openingBias,iceberg', few.ids.join())
}
// Retired: the OI wall strategies #1 / #2, writer migration #3, #25, #26, #28, #29 and #30 - not run, listed
// or scored by default (tests run them with includeRetired). #12 the 80% rule and #27 run.
{
  const retired = ['wallDefence', 'wallBreak', 'migration', 'suddenWall', 'heatmapOi', 'oiStructure', 'vwapOi', 'ibFailed']
  check('#1 #2 #3 #25 #26 #28 #29 #30 are retired; #12 and #27 run', ACTIVE_STRATEGIES.some((x) => x.id === 'tpo80') && ACTIVE_STRATEGIES.some((x) => x.id === 'vwapPullback')
    && retired.every((id) => STRATEGIES.find((x) => x.id === id)?.retired && !ACTIVE_STRATEGIES.some((x) => x.id === id) && !strategyStats([]).some((x) => x.id === id)))
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
