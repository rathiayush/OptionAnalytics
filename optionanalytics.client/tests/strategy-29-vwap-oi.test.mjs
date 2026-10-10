// Strategy 29, VWAP + options & futures OI confluence: the VWAP trend-day pullback with BOTH the option
// writers and a futures build-up behind it, on any day (no heatmap needed). LONG and SHORT, and not when a
// key condition is missing. Run: npm test (node --test) - see CLAUDE.md.
import { ACTIVE_STRATEGIES, buildOiContext, evaluateStrategies, STRATEGIES, strategyStats, topFifteen, vwapOf } from '../src/strategyEngine.js'
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
const NOW = at(85) + 10_000 // 10:40
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }

function scenario(d, o = {}) {
  const mir = (p) => (d > 0 ? p : 2 * 22750 - p)
  // A trend: up 1.5 a minute to 10:29, then a light pullback toward VWAP.
  const raw = (m) => (o.flat ? 22750 + ((m % 4) - 2) : m < 75 ? 22700 + m * 1.5 : 22812 - (m - 75) * 5)
  const bars = []
  let cvd = 0
  for (let m = 0; m < 85; m++) {
    const c = mir(raw(m))
    const heavy = m < 75
    bars.push({ time: at(m), open: c, high: c + 2, low: c - 2, close: c, buy: heavy ? 500 : 60, sell: heavy ? 500 : 60, absorption: [], exhaustion: [], stacked: [], levels: [] })
  }
  // The pullback tags VWAP on the last bars; the last one turns back with the trend (opens near VWAP,
  // closes away from it) unless `noTurn`.
  const vwap = vwapOf(bars, at(84))
  for (let m = 82; m < 85; m++) {
    const b = bars[m]
    const c = vwap + d * (o.brokeThrough && m === 83 ? -30 : m === 84 ? 4 : 1)
    const open = m === 84 ? vwap + d * (o.noTurn ? 6 : 1) : c
    Object.assign(b, { open, close: c, high: Math.max(c, open, vwap) + 1, low: Math.min(c, open, vwap) - 1 })
    if (m === 84) { b.buy = d > 0 ? 90 : 40; b.sell = d > 0 ? 40 : 90 }
  }
  if (o.deltaAgainst) { const b = bars[84]; [b.buy, b.sell] = [b.sell, b.buy] }
  for (const b of bars) { b.delta = b.buy - b.sell; cvd += b.delta; b.cvd = cvd }
  const price = bars[84].close
  // OI: the trade's side written across the chain (puts for a long), futures OI building with price.
  const spot = [], futures = [], cePoints = [], pePoints = []
  for (let m = 0; m <= 85; m++) {
    const f = m < 85 ? bars[m].close : price
    const fOi = o.oiFalling ? 1e7 - m * 3000 : o.oiDownSinceOpen ? (m <= 60 ? 1e7 - m * 5000 : 1e7 - 300000 + (m - 60) * 3000) : o.oiFallingLately && m > 70 ? 1e7 + 70 * 3000 - (m - 70) * 2000 : 1e7 + m * 3000
    spot.push({ time: iso(at(m)), open: f - 60, high: f - 60, low: f - 60, close: f - 60 })
    futures.push({ time: iso(at(m)), open: f, high: f, low: f, close: f, volume: 1000, openInterest: fOi })
    for (let k = 22300; k <= 23200; k += 50) {
      const written = o.noWriters ? 1e6 : 1e6 + m * 8000
      pePoints.push({ time: iso(at(m)), strike: k, openInterest: d > 0 ? written : 1e6, price: 10 })
      cePoints.push({ time: iso(at(m)), strike: k, openInterest: d > 0 ? 1e6 : written, price: 10 })
    }
  }
  const oi = buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: spot, futuresBars: futures, cePoints, pePoints })
  const buyPct = d > 0 ? 70 : 30
  const prints = Array.from({ length: 50 }, (_, i) => ({ seq: i, time: NOW - 50_000 + i * 1000, price: 1, quantity: 75, buy: ((i * 37) % 100) < buyPct }))
  const setups = evaluateStrategies({ includeRetired: true, nowMs: NOW, price, bars, minuteBars: bars, prints: o.estimated ? null : prints, book: o.estimated ? null : { bids: [{ quantity: d > 0 ? 600 : 400 }], asks: [{ quantity: d > 0 ? 400 : 600 }] },
    liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi, estimated: !!o.estimated, lotSize: 75, bigLots: 10, profile: null, filters: o.filters })
  return { s: setups.find((x) => x.id === 'vwapOi'), all: setups, vwap }
}
const show = ({ s, all }) => JSON.stringify(s ? { side: s.side, entry: s.entry, stop: +s.stop.toFixed(1), target: +s.target.toFixed(1), checks: s.checks } : all.map((x) => `${x.id}:${x.side}`))

check('33 strategies, #29 is VWAP + OI confluence - retired (not run, listed, alerted or scored; the rules stay tested)', STRATEGIES.length === 33 && STRATEGIES.find((x) => x.no === 29)?.id === 'vwapOi' && STRATEGIES.find((x) => x.no === 29).retired && !ACTIVE_STRATEGIES.some((x) => x.id === 'vwapOi'))
const L = scenario(1)
check('LONG: above a rising VWAP, the pullback tags it and turns, put writers + futures long build-up', L.s?.side === 'LONG' && L.s.stop < L.s.entry && L.s.target > L.s.entry
  && /writers back it/.test(L.s.checks.OI) && /long build-up/.test(L.s.checks.OI), show(L))
console.log('   ', L.s?.checks.VWAP, '|', L.s?.checks.OI, '|', L.s?.checks.Plan)
check('...target 2-3R', L.s && L.s.target - L.s.entry >= 2 * (L.s.entry - L.s.stop) - 0.01 && L.s.target - L.s.entry <= 3 * (L.s.entry - L.s.stop) + 0.01)
check('...needs no heatmap (no heatmap given)', !!L.s)
const S = scenario(-1)
check('SHORT: the mirror under a falling VWAP, call writers + futures short build-up', S.s?.side === 'SHORT' && S.s.stop > S.s.entry && S.s.target < S.s.entry && /short build-up/.test(S.s.checks.OI), show(S))
check('fires on an estimated day too', scenario(1, { estimated: true }).s?.side === 'LONG' && scenario(-1, { estimated: true }).s?.side === 'SHORT')
check('not without the option writers (futures build-up alone)', !scenario(1, { noWriters: true }).s && !scenario(-1, { noWriters: true }).s)
check('not without the futures build-up (writers alone, futures OI falling since the open)', !scenario(1, { oiFalling: true }).s && !scenario(-1, { oiFalling: true }).s)
check('not when the futures OI is down since the open (no build-up), even if it rose lately', !scenario(1, { oiDownSinceOpen: true }).s && !scenario(-1, { oiDownSinceOpen: true }).s)
check('not when the futures OI is falling in the last 15 minutes', !scenario(1, { oiFallingLately: true }).s)
check('not after a close through VWAP (the pullback broke it)', !scenario(1, { brokeThrough: true }).s && !scenario(-1, { brokeThrough: true }).s)
check('not on a flat day (VWAP not sloping, no trend)', !scenario(1, { flat: true }).s)
check('not before the last bar turns back with the trend', !scenario(1, { noTurn: true }).s)
check('not with the delta against it', !scenario(1, { deltaAgainst: true }).s)
// The trader's filters (STRATEGY_FILTERS.vwapOi) - each requirement switched off lets its case through.
const vF = (o) => ({ vwapOi: o })
check('filter: writers off -> fires on the futures build-up alone', scenario(1, { noWriters: true, filters: vF({ needWriters: false }) }).s?.side === 'LONG' && scenario(-1, { noWriters: true, filters: vF({ needWriters: false }) }).s?.side === 'SHORT')
check('filter: futures build-up off -> fires with the OI down since the open', scenario(1, { oiDownSinceOpen: true, filters: vF({ needFuturesBuild: false }) }).s?.side === 'LONG')
check('filter: futures OI holding off -> fires with the OI falling in the last 15 min', scenario(1, { oiFallingLately: true, filters: vF({ needFuturesHolding: false }) }).s?.side === 'LONG')
check('filter: delta off -> fires with the delta against it', scenario(1, { deltaAgainst: true, filters: vF({ needDelta: false }) }).s?.side === 'LONG')
check('filter: VWAP slope 0.2% -> this trend (0.06%) is too flat', !scenario(1, { filters: vF({ slopePct: 0.2 }) }).s)
{
  const r = scenario(1, { filters: vF({ targetR: 1, maxR: 1, timeStopMin: 30 }) }).s
  check('filter: target 1R (no stretch), 30-min time stop', r && Math.abs((r.target - r.entry) - (r.entry - r.stop)) < 0.01 && r.timeStopMs - r.t === 30 * MIN, show({ s: r, all: [] }))
}
{
  const mk = (id, rs) => rs.map((r, i) => ({ id, t: i, outcome: { status: r > 0 ? 'win' : 'loss', r } }))
  const unmeasured = topFifteen(strategyStats([]))
  // On trial (#29 / #30 retired): #27, the never-alerted 5, 7, 10, 16, 22, 23 and the new #31-33 - beside the Top 15, pushing nothing out.
  check('on trial: #27, 5 / 7 / 10 / 16 / 22 / 23 and #31-33, beside the Top 15, pushing nothing out', unmeasured.trial.join() === 'flush,range,maxPain,weakWall,vwapFade,ibFade,vwapPullback,straddleFade,wallShift,cumFlip'
    && unmeasured.trial.every((id) => !unmeasured.ids.includes(id))
    && unmeasured.ids.length === 15 && unmeasured.ids.includes('blockTrade') && unmeasured.ids.includes('imbalanceRetest'), JSON.stringify({ ids: unmeasured.ids, trial: unmeasured.trial }))
  const measured = topFifteen(strategyStats([...mk('vwapOi', [2, 2, -1, 2, 2, 2]), ...mk('ibFailed', [2, 2, -1, 2, 2, 2])]))
  check('a retired strategy is never alerted, whatever trades it was scored with', !measured.ids.includes('vwapOi') && !measured.trial.includes('vwapOi') && !measured.ids.includes('ibFailed') && !measured.ids.includes('wallDefence'))
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
