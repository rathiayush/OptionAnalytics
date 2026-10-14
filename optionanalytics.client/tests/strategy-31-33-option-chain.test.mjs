// Strategies 31-33, built on the option chain + futures OI + VWAP (no book / heatmap / tape):
//   #31 straddleFade - ATM straddle decaying, CE and PE written at the money -> fade the OI wall back to the middle;
//   #32 wallShift    - the biggest PUT (CALL) wall rolls one strike up (down) and the futures follow;
//   #33 cumFlip      - the CE / PE OI added since the open flips sides, a futures build-up, on the VWAP side.
// Each fires on its rules LONG and SHORT, does NOT fire when a key condition is missing, a loosened filter lets its
// case through, and the same scenario fires at BANKNIFTY (~52,000, step 100) and SENSEX (~82,000, step 100) scale.
// Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, evaluateStrategies, STRATEGIES, ACTIVE_STRATEGIES, STRATEGY_FILTERS, strategyFilters, strategyStats, topFifteen } from '../src/strategyEngine.js'

const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }

const MINUTES = 120 // 09:15 - 11:15; the clock is 10 s into 11:15, the last finished minute 11:14
const NOW = at(MINUTES) + 10_000
const SCALES = {
  NIFTY: { K: 22700, step: 50 },
  BANKNIFTY: { K: 52000, step: 100 },
  SENSEX: { K: 82000, step: 100 },
}

// One day, written for the LONG; a SHORT is its mirror (the index moves the other way around K, the CE book at
// strike offset i is the long's PE book at -i and vice versa). Strikes are offsets i (K + i x step).
//   spotOff(m, sc) - the index minus K at minute m (long frame), ce(i, m) / pe(i, m) - OI, tv(m, sc) - each option's
//   time value (premium = time value + intrinsic), futOi(m), lastTurn - the last bar's open behind its close (strikes),
//   lastDelta - the last bar's delta (long frame).
function scenario(id, scaleName, dir, d, filters) {
  const sc = SCALES[scaleName]
  const { K, step } = sc
  const f = K / 22700
  const basis = 60 * f
  const spotAt = (m) => K + dir * d.spotOff(m, sc)
  const oiAt = (side, i, m) => {
    const src = dir > 0 ? side : side === 'ce' ? 'pe' : 'ce'
    return Math.round(d[src](dir > 0 ? i : -i, m))
  }
  const spot = [], futures = [], cePoints = [], pePoints = []
  // d.future: the OI / premiums / spot / futures of the running minute (11:15) and after, replaced with nonsense -
  // what a look-ahead would pick up (a replayed day reads each minute once it is over).
  for (let m = 0; m < MINUTES + (d.future ? 10 : 0); m++) {
    const junk = m >= MINUTES
    const s = spotAt(m) + (junk ? 400 * f * (m % 2 ? 1 : -1) : 0)
    const tv = (d.tv ? d.tv(m, sc) : 50 * f) * (junk ? 3 : 1)
    spot.push({ time: iso(at(m)), open: s, high: s, low: s, close: s })
    futures.push({ time: iso(at(m)), open: s + basis, high: s + basis, low: s + basis, close: s + basis, volume: 1000, openInterest: (d.futOi ? d.futOi(m) : 1e7) * (junk ? 3 : 1) })
    for (let i = -10; i <= 10; i++) {
      const k = K + i * step
      const ce = tv + Math.max(0, s - k)
      const pe = tv + Math.max(0, k - s)
      cePoints.push({ time: iso(at(m)), strike: k, openInterest: oiAt('ce', i, m) * (junk ? Math.abs(i % 3) + 2 : 1), price: ce, high: ce, low: ce })
      pePoints.push({ time: iso(at(m)), strike: k, openInterest: oiAt('pe', i, m) * (junk ? 4 - Math.abs(i % 3) : 1), price: pe, high: pe, low: pe })
    }
  }
  const oi = buildOiContext({ success: true, date: '2026-10-05', step, spotCandlesOneMinute: spot, futuresBars: futures, cePoints, pePoints })
  const bars = []
  let cvd = 0
  for (let m = 0; m < MINUTES; m++) {
    const c = spotAt(m) + basis
    const isLast = m === MINUTES - 1
    const open = isLast ? c - dir * (d.lastTurn ?? 0.05) * step : c
    const r = 0.04 * step
    const delta = isLast ? dir * (d.lastDelta ?? 200) : 0
    cvd += delta
    bars.push({ time: at(m), open, high: Math.max(open, c) + r, low: Math.min(open, c) - r, close: c, buy: 500 + Math.max(0, delta), sell: 500 + Math.max(0, -delta), delta, cvd, absorption: [], exhaustion: [], stacked: [] })
  }
  const setups = evaluateStrategies({ nowMs: NOW, price: bars.at(-1).close, bars, minuteBars: bars, prints: [], book: null, liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi, estimated: true, lotSize: 75, bigLots: 10, profile: null, filters: filters ? { [id]: filters } : undefined })
  return { s: setups.find((x) => x.id === id), all: setups, basis, K, step }
}
const show = (r) => JSON.stringify(r.s ? { side: r.s.side, entry: +r.s.entry.toFixed(1), stop: +r.s.stop.toFixed(1), target: +r.s.target.toFixed(1), checks: r.s.checks } : r.all.map((x) => `${x.id}:${x.side}`))
const sideOk = (r, dir) => r.s?.side === (dir > 0 ? 'LONG' : 'SHORT') && dir * (r.s.entry - r.s.stop) > 0 && dir * (r.s.target - r.s.entry) > 0
const SIDES = [[1, 'LONG'], [-1, 'SHORT']]

// ---- the line-up -------------------------------------------------------------------------------------------------
check('37 strategies, #31-33 are the option-chain ones, on trial and active', STRATEGIES.length === 37
  && ['straddleFade', 'wallShift', 'cumFlip'].every((id, i) => STRATEGIES.find((x) => x.no === 31 + i)?.id === id && STRATEGIES.find((x) => x.id === id).trial && ACTIVE_STRATEGIES.some((x) => x.id === id)))
{
  const top = topFifteen(strategyStats([]))
  check('unmeasured, #31-33 alert BESIDE the Top 15 (on trial), pushing nothing out', top.ids.length === 15
    && ['straddleFade', 'wallShift', 'cumFlip'].every((id) => top.trial.includes(id) && !top.ids.includes(id)), JSON.stringify(top))
}
check('every filter default is the rule as written (strategyFilters with no overrides = the defaults)',
  ['straddleFade', 'wallShift', 'cumFlip'].every((id) => STRATEGY_FILTERS[id].every((x) => strategyFilters(id, {})[x.key] === x.default)))

// ---- #31 ATM straddle decay - fade the OI wall --------------------------------------------------------------------
// Walls: PUT K-2 (support), CALL K+2 (resistance); the index sat at K, came down to K-2 + 0.2 strike by 10:55 and stays
// there; ATM is then K-2, ATM ±1 = K-3..K-1, both CE and PE OI there written from 10:55.
const SF = {
  inside: 0.2, resAt: 2, peRate: 10000, ceRate: 10000,
  spotOff(m, sc) { const end = (-2 + this.inside) * sc.step; return m < 90 ? 0 : m < 100 ? (end * (m - 90)) / 10 : end },
  tv: (m, sc) => 100 * (sc.K / 22700) * (1 - 0.002 * m),
  write(rate, m) { return m > 100 ? (m - 100) * rate : 0 },
  pe(i, m) { return i === -2 ? 8e6 + (this.wall ? this.wall(m) : this.write(this.peRate, m)) : i === -3 || i === -1 ? 2e6 + this.write(this.peRate, m) : 2e6 },
  ce(i, m) { return i === this.resAt ? 8e6 + ([-3, -2, -1].includes(i) ? this.write(this.ceRate, m) : 0) : [-3, -2, -1].includes(i) ? 2e6 + this.write(this.ceRate, m) : 2e6 },
  lastTurn: 0.1,
}
const sf = (o = {}) => ({ ...SF, ...o })
for (const [scale] of Object.entries(SCALES)) {
  for (const [dir, side] of SIDES) {
    const r = scenario('straddleFade', scale, dir, sf())
    check(`#31 ${scale} ${side}: straddle decaying, ATM CE + PE written, at the ${dir > 0 ? 'PUT' : 'CALL'} wall - fades it`, sideOk(r, dir)
      && /written on both sides/.test(r.s.checks.OI) && /decaying/.test(r.s.checks.Straddle), show(r))
    if (r.s) {
      const mid = r.K + r.basis
      check(`#31 ${scale} ${side}: stop beyond the wall, target the middle between the walls`, Math.abs(r.s.target - mid) < 1e-6
        && dir * ((r.K - dir * 2 * r.step + r.basis) - r.s.stop) > 0, show(r))
    }
  }
}
if (scenario('straddleFade', 'NIFTY', 1, sf()).s) console.log('   ', show(scenario('straddleFade', 'NIFTY', 1, sf())).slice(0, 900))
for (const scale of ['NIFTY', 'SENSEX']) {
  for (const [dir, side] of SIDES) {
    const tag = `#31 ${scale} ${side}`
    check(`${tag}: not when the straddle is flat (premium not decaying)`, !scenario('straddleFade', scale, dir, sf({ tv: (m, sc) => 100 * (sc.K / 22700) })).s)
    check(`${tag}: not when the straddle is above its session average (it was cheaper earlier)`, !scenario('straddleFade', scale, dir, sf({ tv: (m, sc) => 100 * (sc.K / 22700) * (m <= 100 ? 0.6 + 0.004 * m : 1 - 0.004 * (m - 100)) })).s)
    check(`${tag}: not when only one side is written at the money (the CE OI flat - a directional market)`, !scenario('straddleFade', scale, dir, sf({ ceRate: 0 })).s)
    check(`${tag}: not when the wall's writers are leaving (its OI down 1%+ in 15 min)`, !scenario('straddleFade', scale, dir, sf({ wall: (m) => (m > 100 ? -(m - 100) * 6000 : 0) })).s)
    check(`${tag}: not away from the wall (the index in the middle)`, !scenario('straddleFade', scale, dir, sf({ inside: 2 })).s)
    check(`${tag}: not when the last bar is not turning off the wall`, !scenario('straddleFade', scale, dir, sf({ lastTurn: -0.1 })).s)
    check(`${tag}: not with no room to the middle (the CALL wall right next to the PUT wall)`, !scenario('straddleFade', scale, dir, sf({ resAt: -1 })).s)
  }
}
// Loosening each filter lets its case through.
const slowDecay = sf({ tv: (m, sc) => 100 * (sc.K / 22700) * (1 - 0.001 * m) })
check('#31 filter fallPct 1: a slowly decaying straddle (1.6% in 15 min) - out by default, in when loosened', !scenario('straddleFade', 'NIFTY', 1, slowDecay).s
  && !!scenario('straddleFade', 'NIFTY', 1, slowDecay, { fallPct: 1 }).s, show(scenario('straddleFade', 'NIFTY', 1, slowDecay, { fallPct: 1 })))
check('#31 filter needBelowAvg off: a falling straddle above its session average passes', !!scenario('straddleFade', 'NIFTY', 1, sf({ tv: (m, sc) => 100 * (sc.K / 22700) * (m <= 100 ? 0.6 + 0.004 * m : 1 - 0.004 * (m - 100)) }), { needBelowAvg: false }).s)
check('#31 filter oiRisePct 0: CE flat at the money passes', !!scenario('straddleFade', 'NIFTY', 1, sf({ ceRate: 0 }), { oiRisePct: 0 }).s)
check('#31 filter edgeStrikes 1: the futures 0.7 strike off the wall - out by default, in when loosened',
  !scenario('straddleFade', 'NIFTY', -1, sf({ inside: 0.7 })).s && !!scenario('straddleFade', 'NIFTY', -1, sf({ inside: 0.7 }), { edgeStrikes: 1 }).s)
check('#31 filter minRR 0.5: a closer middle passes', !!scenario('straddleFade', 'NIFTY', 1, sf({ resAt: -1 }), { minRR: 0.5 }).s, show(scenario('straddleFade', 'NIFTY', 1, sf({ resAt: -1 }), { minRR: 0.5 })))

// ---- #32 S/R OI wall shift ------------------------------------------------------------------------------------------
// The PUT wall at K-1 (8e6); from 11:00 the put writers build K (6e6 -> 9e6 by 11:14) and the index rises 0.6 strike to
// K + 0.4 strike; the CALL wall at K+3 stays.
const WS = {
  endAt: 0.4, rise: 0.6, oldAt: -1, rampFrom: 104, rampRate: 200000, ceWallAt: 3, ceDownAt: null,
  spotOff(m, sc) { const rise = this.rise * sc.step; const base0 = this.endAt * sc.step - rise; return m <= 104 ? base0 : base0 + (rise * (m - 104)) / 15 },
  oldPe: () => 8e6,
  farPe: () => 0,
  pe(i, m) { return i === this.oldAt ? this.oldPe(m) : i === 0 ? 6e6 + Math.max(0, m - this.rampFrom) * this.rampRate : i === -8 ? 2e6 + this.farPe(m) : 2e6 },
  ce(i, m) { return i === this.ceWallAt ? 8e6 : i === this.ceDownAt ? 2e6 + Math.max(0, m - 104) * 600000 : 2e6 },
}
const ws = (o = {}) => ({ ...WS, ...o })
for (const [scale] of Object.entries(SCALES)) {
  for (const [dir, side] of SIDES) {
    const r = scenario('wallShift', scale, dir, ws())
    check(`#32 ${scale} ${side}: the ${dir > 0 ? 'PUT wall rolled up' : 'CALL wall rolled down'} one strike and the futures followed`, sideOk(r, dir)
      && new RegExp(`${dir > 0 ? 'PUT' : 'CALL'} wall moved ${r.K - dir * r.step} → ${r.K}`).test(r.s.checks.OI), show(r))
    if (r.s) {
      check(`#32 ${scale} ${side}: stop beyond the new wall, target 2R short of the next wall`, dir * ((r.K + r.basis) - r.s.stop) > 0
        && Math.abs(Math.abs(r.s.target - r.s.entry) - 2 * Math.abs(r.s.entry - r.s.stop)) < 1e-6 && dir * ((r.K + dir * 3 * r.step + r.basis) - r.s.target) > 0, show(r))
    }
  }
}
console.log('   ', show(scenario('wallShift', 'NIFTY', 1, ws())).slice(0, 900))
for (const scale of ['NIFTY', 'SENSEX']) {
  for (const [dir, side] of SIDES) {
    const tag = `#32 ${scale} ${side}`
    check(`${tag}: not when the wall did not move (no writing at the next strike)`, !scenario('wallShift', scale, dir, ws({ rampRate: 0 })).s)
    check(`${tag}: not when the futures did not follow (flat)`, !scenario('wallShift', scale, dir, ws({ rise: 0 })).s)
    check(`${tag}: not when the futures went the other way`, !scenario('wallShift', scale, dir, ws({ rise: -0.3, endAt: 0.2 })).s)
    check(`${tag}: not when the other wall moves against it`, !scenario('wallShift', scale, dir, ws({ ceDownAt: 2 })).s)
    check(`${tag}: not when the new wall is barely the bigger (1.025x)`, !scenario('wallShift', scale, dir, ws({ rampRate: 2.2e6 / 15 })).s)
    check(`${tag}: not when the wall jumped two strikes`, !scenario('wallShift', scale, dir, ws({ oldAt: -2 })).s)
    check(`${tag}: not when the futures already ran 1.2 strikes past the new wall`, !scenario('wallShift', scale, dir, ws({ endAt: 1.2, ceWallAt: 5 })).s)
    check(`${tag}: not when the shift is older than 15 minutes`, !scenario('wallShift', scale, dir, ws({ rampFrom: 90, rampRate: 150000 })).s)
  }
}
// (puts written far below as the old wall unwinds, so the whole chain does not lean against the trade - the options-OI veto)
const shrinkOld = ws({ oldPe: (m) => (m <= 104 ? 8e6 : 8e6 - (m - 104) * 170000), rampRate: 40000 / 15, farPe: (m) => Math.max(0, m - 104) * 170000 })
check('#32 filter newAddPct 0.5: a wall that moved by the old strike unwinding (little added at the new one) - out by default, in when loosened',
  !scenario('wallShift', 'NIFTY', 1, shrinkOld).s && !!scenario('wallShift', 'NIFTY', 1, shrinkOld, { newAddPct: 0.5 }).s, show(scenario('wallShift', 'NIFTY', 1, shrinkOld, { newAddPct: 0.5 })))
check('#32 filter leadX 1: a new wall barely the bigger passes', !!scenario('wallShift', 'NIFTY', 1, ws({ rampRate: 2.2e6 / 15 }), { leadX: 1 }).s)
check('#32 filter maxStrikes 2: a two-strike jump passes', !!scenario('wallShift', 'NIFTY', -1, ws({ oldAt: -2 }), { maxStrikes: 2 }).s)
check('#32 filter followPct 0: a hesitant follow (0.01%) - out by default, in when loosened',
  !scenario('wallShift', 'NIFTY', 1, ws({ rise: 0.04 })).s && !!scenario('wallShift', 'NIFTY', 1, ws({ rise: 0.04 }), { followPct: 0 }).s)
check('#32 filter maxAwayStrikes 1.5: futures 1.2 strikes past the new wall pass', !!scenario('wallShift', 'NIFTY', 1, ws({ endAt: 1.2, ceWallAt: 5 }), { maxAwayStrikes: 1.5 }).s)
check('#32 filter withinMin 25: a shift 18 minutes old passes', !!scenario('wallShift', 'NIFTY', 1, ws({ rampFrom: 90, rampRate: 150000 }), { withinMin: 25 }).s)

// ---- #33 since-open CE / PE flip ------------------------------------------------------------------------------------
// Calls written at K+6 from 09:45 to 10:55 (+2.8e6: call writers lead since the open); from 10:55 puts written at K-1 at
// 300k a minute - by 11:14 puts lead by ~3% of the chain. Futures: flat at K + 0.2 strike, then up 0.12% with OI
// up 0.3% in the last 15 minutes; the last bar's delta with it.
const CF = {
  risePct: 0.0012, peFrom: 100, peRate: 300000, futOiFlat: false, highEarly: false,
  spotOff(m, sc) {
    const base = 0.2 * sc.step
    if (this.highEarly && m < 60) return base + sc.K * 0.004
    return m <= 104 ? base : base + (sc.K * this.risePct * (m - 104)) / 15
  },
  ce(i, m) { return i === 6 ? 2e6 + Math.min(70, Math.max(0, m - 30)) * 40000 : 2e6 },
  pe(i, m) { return i === -1 ? 2e6 + Math.max(0, m - this.peFrom) * this.peRate : 2e6 },
  futOi(m) { return 1e7 + (this.futOiFlat ? 0 : Math.max(0, m - 104) * 2000) },
}
const cf = (o = {}) => ({ ...CF, ...o })
for (const [scale] of Object.entries(SCALES)) {
  for (const [dir, side] of SIDES) {
    const r = scenario('cumFlip', scale, dir, cf())
    check(`#33 ${scale} ${side}: ${dir > 0 ? 'put' : 'call'} writers took the since-open lead, futures build-up, ${dir > 0 ? 'above' : 'below'} VWAP`, sideOk(r, dir)
      && /took the lead/.test(r.s.checks.OI) && /build-up/.test(r.s.checks['Futures confirm']), show(r))
    if (r.s) check(`#33 ${scale} ${side}: target 2R (room to the next wall)`, Math.abs(Math.abs(r.s.target - r.s.entry) - 2 * Math.abs(r.s.entry - r.s.stop)) < 1e-6, show(r))
  }
}
console.log('   ', show(scenario('cumFlip', 'NIFTY', 1, cf())).slice(0, 900))
for (const scale of ['NIFTY', 'SENSEX']) {
  for (const [dir, side] of SIDES) {
    const tag = `#33 ${scale} ${side}`
    check(`${tag}: not when it had already flipped 15 minutes ago (not fresh)`, !scenario('cumFlip', scale, dir, cf({ peFrom: 80 })).s)
    check(`${tag}: not when the lead after the flip is tiny (0.1% of the chain)`, !scenario('cumFlip', scale, dir, cf({ peRate: 2.9e6 / 19 })).s)
    check(`${tag}: not without a futures build-up (OI flat)`, !scenario('cumFlip', scale, dir, cf({ futOiFlat: true })).s)
    check(`${tag}: not when the futures move against it`, !scenario('cumFlip', scale, dir, cf({ risePct: -0.0012 })).s)
    check(`${tag}: not on the wrong side of VWAP`, !scenario('cumFlip', scale, dir, cf({ highEarly: true })).s)
    check(`${tag}: not when the last bar's delta is against it`, !scenario('cumFlip', scale, dir, cf({ lastDelta: -200 })).s)
    check(`${tag}: not when stretched 0.35% from VWAP`, !scenario('cumFlip', scale, dir, cf({ risePct: 0.0035 })).s)
  }
}
check('#33 filter withinMin 25: a flip 13-18 minutes old - out by default, in when loosened',
  !scenario('cumFlip', 'NIFTY', 1, cf({ peFrom: 92 })).s && !!scenario('cumFlip', 'NIFTY', 1, cf({ peFrom: 92 }), { withinMin: 25 }).s)
check('#33 filter flipPct 0.05: a small lead passes', !!scenario('cumFlip', 'NIFTY', -1, cf({ peRate: 2.9e6 / 19 }), { flipPct: 0.05 }).s)
check('#33 filter needBuildUp off: price with it, OI flat passes', !!scenario('cumFlip', 'NIFTY', 1, cf({ futOiFlat: true }), { needBuildUp: false }).s)
check('#33 filter maxFromVwapPct 0.4: 0.33% from VWAP passes', !!scenario('cumFlip', 'NIFTY', 1, cf({ risePct: 0.0035 }), { maxFromVwapPct: 0.4 }).s, show(scenario('cumFlip', 'NIFTY', 1, cf({ risePct: 0.0035 }), { maxFromVwapPct: 0.4 })))
check('#33 filter needDelta off: delta against passes', !!scenario('cumFlip', 'NIFTY', 1, cf({ lastDelta: -200 }), { needDelta: false }).s)

// ---- no look-ahead: the running minute's and later OI / premiums / spot / futures change nothing ------------------
{
  const sig = (r) => (r.s ? `${r.s.side}:${r.s.entry}:${r.s.stop.toFixed(4)}:${r.s.target.toFixed(4)}:${r.s.options?.sell?.premium}` : 'none')
  for (const [id, base] of [['straddleFade', sf()], ['wallShift', ws()], ['cumFlip', cf()]]) {
    for (const scale of Object.keys(SCALES)) {
      for (const [dir, side] of SIDES) {
        const a = scenario(id, scale, dir, base)
        const b = scenario(id, scale, dir, { ...base, future: true })
        check(`${id} ${scale} ${side}: no look-ahead (the setup is the same with the future replaced)`, a.s && sig(a) === sig(b), `${sig(a)} vs ${sig(b)}`)
      }
    }
  }
}

console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
