// Strategies 17-23 (institutional + range-bound) and the gap fixes in 1-16: each fires on its rules and not without them.
// Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, evaluateStrategies as evaluate, resolveConflicts, STRATEGIES, RANGE_IDS, vwapBands, vwapCrosses } from '../src/strategyEngine.js'
// Wall defence (#1, retired) still exercises the shared gates (volatility floor, meaningful OI).
const evaluateStrategies = (input) => evaluate({ ...input, includeRetired: true })
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }

// Futures close per minute from `fut(m)`; the index = futures - 60 (basis 60); option OI per strike from
// functions of the minute (1e6 flat by default).
function oiCtx({ fut, minutes, futOi = () => 1e7, ce = {}, pe = {} }) {
  const spot = [], futures = [], cePoints = [], pePoints = []
  for (let m = 0; m <= minutes; m++) {
    const f = fut(m)
    spot.push({ time: iso(at(m)), open: f - 60, high: f - 60, low: f - 60, close: f - 60 })
    futures.push({ time: iso(at(m)), open: f, high: f, low: f, close: f, volume: 1000, openInterest: futOi(m) })
    for (let k = 22300; k <= 23200; k += 50) {
      pePoints.push({ time: iso(at(m)), strike: k, openInterest: (pe[k] ?? (() => 1e6))(m), price: 10 })
      cePoints.push({ time: iso(at(m)), strike: k, openInterest: (ce[k] ?? (() => 1e6))(m), price: 10 })
    }
  }
  return buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: spot, futuresBars: futures, cePoints, pePoints })
}
function mkBars(n, f) {
  const out = []
  let cvd = 0
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
const run = (now, bars, oi, o = {}) => evaluateStrategies({
  nowMs: now, price: o.price ?? bars.at(-1).close, bars, minuteBars: bars, prints: o.prints ?? tapeWith(now, o.buyPct ?? 50), book: book(o.bids ?? 500),
  liquidity: [], pullStack: [], sweeps: o.sweeps ?? [], icebergs: [], oi, estimated: o.estimated ?? false, lotSize: 75, bigLots: 10, profile: o.profile ?? null,
})
const find = (setups, id) => setups.find((s) => s.id === id)
const show = (s, all) => JSON.stringify(s ? { side: s.side, entry: s.entry, stop: +s.stop.toFixed(1), target: +s.target.toFixed(1), conf: s.confidence, checks: s.checks } : all.map((x) => `${x.id}:${x.side}`))

check('28 strategies, numbered 1-27, range group = 7, 22, 23', STRATEGIES.length === 28 && STRATEGIES.every((s, i) => s.no === i + 1) && RANGE_IDS.join() === 'range,vwapFade,ibFade', RANGE_IDS.join())

// ---- 17. Failed breakout trap ---------------------------------------------------------------------
{
  const now = at(100) + 10_000
  // SHORT: today's high 22770 (m 40), untouched until a sweep to 22780 at m 96, back below it now.
  const path = (m, v = {}) => {
    if (m === 40) return { c: 22760, h: 22770, l: 22755 }
    if (m < 95) return { c: 22750 + ((m % 6) - 3) * 2 }
    return [
      { o: 22758, h: 22766, l: 22756, c: 22764 },
      { o: 22764, h: 22780, l: 22762, c: 22772, buy: 1200, sell: 400 },
      { o: 22772, h: 22776, l: 22762, c: v.accepted ? 22774 : 22765 },
      { o: 22765, h: 22767, l: 22758, c: v.accepted ? 22771 : 22760, absorption: [{ side: 'sell', price: 22776 }] },
      { o: 22762, h: 22764, l: 22755, c: 22757, buy: 400, sell: 900 },
    ][m - 95]
  }
  const sweeps = [{ id: 1, buy: true, startedAt: iso(at(96) + 10_000), endedAt: iso(at(96) + 12_000), fromPrice: 22770, toPrice: 22780, quantity: 900, prints: 3, levels: 3 }]
  const ctx = (o = {}) => oiCtx({ minutes: 100, fut: (m) => (m >= 100 ? 22757 : path(m).c), futOi: (m) => 1e7 + Math.max(0, m - 95) * 8000, ce: { 22750: o.ce ?? ((m) => 2e6 + m * 10000) } })
  const bs = mkBars(100, (m) => path(m))
  const all = run(now, bs, ctx(), { buyPct: 30, bids: 400, sweeps })
  const s = find(all, 'trap')
  check('17 trap: SHORT after a swept-and-rejected high, CALL writers adding past it', s?.side === 'SHORT' && s.stop > 22780 && s.target < s.entry && /swept today's high/.test(s.checks.Trap) && /trapped buyers: sweep/.test(s.checks.Trap) && /CALL 22750/.test(s.checks.OI) && /trapped/.test(s.checks['Futures confirm']), show(s, all))
  check('17 trap: not without trapped aggression (no sweep / big prints / stack)', !find(run(now, bs, ctx(), { buyPct: 30, bids: 400, sweeps: [] }), 'trap'))
  check('17 trap: a buy sweep that stopped short of the high does not count', !find(run(now, bs, ctx(), { buyPct: 30, bids: 400, sweeps: [{ ...sweeps[0], fromPrice: 22740, toPrice: 22752 }] }), 'trap'))
  check('17 trap: not when the CALL writers are not adding past the high', !find(run(now, bs, ctx({ ce: () => 3e6 }), { buyPct: 30, bids: 400, sweeps }), 'trap'))
  check('17 trap: not when the breakout was accepted (3 closes above)', !find(run(now, mkBars(100, (m) => path(m, { accepted: true })), ctx(), { buyPct: 30, bids: 400, sweeps }), 'trap'))
  // LONG: the previous session's low 22700 swept to 22690 and reclaimed, PUT writers adding at 22600.
  const lpath = (m) => {
    if (m < 95) return { c: 22730 + ((m % 6) - 3) * 2 }
    return [
      { o: 22726, h: 22728, l: 22716, c: 22718 },
      { o: 22716, h: 22718, l: 22690, c: 22698, buy: 300, sell: 1200 },
      { o: 22698, h: 22708, l: 22696, c: 22705 },
      { o: 22705, h: 22710, l: 22701, c: 22708, absorption: [{ side: 'buy', price: 22692 }] },
      { o: 22707, h: 22714, l: 22706, c: 22712, buy: 900, sell: 400 },
    ][m - 95]
  }
  const lsweeps = [{ id: 2, buy: false, startedAt: iso(at(96) + 10_000), endedAt: iso(at(96) + 12_000), fromPrice: 22700, toPrice: 22690, quantity: 900, prints: 3, levels: 3 }]
  const lctx = oiCtx({ minutes: 100, fut: (m) => (m >= 100 ? 22712 : lpath(m).c), futOi: (m) => 1e7 + Math.max(0, m - 95) * 8000, pe: { 22600: (m) => 2e6 + m * 10000 } })
  const lall = run(now, mkBars(100, lpath), lctx, { buyPct: 70, bids: 600, sweeps: lsweeps, profile: { prevHigh: 22900, prevLow: 22700 } })
  const ls = find(lall, 'trap')
  check('17 trap: LONG after the previous session low is swept and reclaimed', ls?.side === 'LONG' && ls.stop < 22690 && /swept the previous session low/.test(ls.checks.Trap) && /PUT 22600/.test(ls.checks.OI), show(ls, lall))
}

// ---- 18. CVD divergence at the OI wall --------------------------------------------------------------
{
  const now = at(120) + 10_000
  const path = (m, v = {}) => {
    if (m < 80) return { c: 22760 + ((m % 4) - 2) }
    if (m <= 95) return { c: 22760 + (m - 80) * 2, h: m === 95 ? 22800 : 22762 + (m - 80) * 2, buy: 900, sell: 500 }
    if (m <= 109) return { c: 22785, h: 22788, l: 22782, buy: 450, sell: 550 }
    if (m <= 116) return { c: 22790 + (m - 110), h: m === 116 ? 22806 : 22792 + (m - 110), buy: v.strong ? 1500 : 500, sell: 520 }
    if (m <= 118) return { c: 22798, h: 22800, l: 22795, buy: 450, sell: 550 }
    return { o: 22798, c: 22795, h: 22799, l: 22792, buy: 300, sell: 800 }
  }
  const ctx = (ce) => oiCtx({ minutes: 120, fut: (m) => (m >= 120 ? 22795 : path(m).c), ce })
  const wall = { 22750: (m) => 3e6 + m * 5000 }
  const bs = mkBars(120, (m) => path(m))
  const all = run(now, bs, ctx(wall), { buyPct: 30, bids: 400 })
  const s = find(all, 'cvdDivergence')
  check('18 CVD divergence: SHORT at the CALL wall - higher high, lower ΣΔ', s?.side === 'SHORT' && s.stop > 22806 && /higher high/.test(s.checks.Divergence) && /CALL wall 22750/.test(s.checks.OI), show(s, all))
  check('18 CVD divergence: not when ΣΔ confirms the new high', !find(run(now, mkBars(120, (m) => path(m, { strong: true })), ctx(wall), { buyPct: 30, bids: 400 }), 'cvdDivergence'))
  check('18 CVD divergence: not when the wall is being covered', !find(run(now, bs, ctx({ 22750: (m) => (m < 105 ? 3e6 + m * 5000 : 3e6 + 105 * 5000 - (m - 105) * 20000) }), { buyPct: 30, bids: 400 }), 'cvdDivergence'))
  check('18 CVD divergence: not away from the wall', !find(run(now, bs, ctx({ 22850: (m) => 3e6 + m * 5000 }), { buyPct: 30, bids: 400 }), 'cvdDivergence'))
}

// ---- 19. Block-trade initiative -----------------------------------------------------------------------
{
  const now = at(100) + 10_000
  const path = (m) => (m < 85 ? { c: 22700 + Math.round(m * 0.3) } : { c: 22725 + (m - 85) * 3, buy: 700, sell: 450, stacked: m === 98 ? [{ side: 'buy', low: 22760, high: 22764, rows: 3 }] : [] })
  const ctx = (futOi = (m) => 1e7 + m * 5000) => oiCtx({ minutes: 100, fut: (m) => (m >= 100 ? 22768 : path(m).c), futOi, pe: { 22650: (m) => 2e6 + m * 10000 }, ce: { 22900: () => 5e6 } })
  const tape = (blocks) => [...tapeWith(now, 70), ...blocks].sort((a, b) => a.time - b.time).map((p, i) => ({ ...p, seq: i }))
  const buys = (px = [22760, 22763, 22765, 22767]) => px.map((price, i) => ({ time: now - 150_000 + i * 40_000, price, quantity: 1500, buy: true }))
  const sell = { time: now - 90_000, price: 22762, quantity: 750, buy: false }
  const bs = mkBars(100, path)
  const all = run(now, bs, ctx(), { price: 22768, bids: 600, prints: tape([...buys(), sell]) })
  const s = find(all, 'blockTrade')
  check('19 block trades: LONG with 4 big buys held above, put writers since open, long build-up', s?.side === 'LONG' && /4 big buys/.test(s.checks.Blocks) && /long build-up/.test(s.checks['Futures confirm']), show(s, all))
  check('19 block trades: not on only 2 big buys', !find(run(now, bs, ctx(), { price: 22768, bids: 600, prints: tape([...buys([22765, 22767]), sell]) }), 'blockTrade'))
  check('19 block trades: not when the other side traded as big', !find(run(now, bs, ctx(), { price: 22768, bids: 600, prints: tape([...buys(), sell, { ...sell, time: now - 80_000, quantity: 1500 }, { ...sell, time: now - 70_000, quantity: 1500 }]) }), 'blockTrade'))
  check('19 block trades: not when price is back below the blocks', !find(run(now, bs, ctx(), { price: 22768, bids: 600, prints: tape([...buys([22772, 22773, 22775, 22776]), sell]) }), 'blockTrade'))
  check('19 block trades: not when futures OI is falling (covering, not build-up)', !find(run(now, bs, ctx((m) => 1e7 - m * 5000), { price: 22768, bids: 600, prints: tape([...buys(), sell]) }), 'blockTrade'))
  check('19 block trades: exact days only', !find(run(now, bs, ctx(), { price: 22768, bids: 600, prints: tape([...buys(), sell]), estimated: true }), 'blockTrade'))
}

// ---- 20. Stacked-imbalance zone retest ----------------------------------------------------------------
{
  const now = at(100) + 10_000
  const path = (m, v = {}) => {
    if (m < 85) return { c: 22720 + ((m % 4) - 2) }
    if (m <= 88) return { c: 22735 + (m - 85) * 3, stacked: m === 88 ? [{ side: 'buy', low: 22740, high: 22746, rows: 3 }] : [] }
    if (m <= 93) return { c: 22750 + (m - 88) * 7 - (m === 92 ? 7 : 0), h: m === 93 ? 22787 : undefined }
    if (m <= 97) return { c: 22770, h: 22773, l: v.second && m === 95 ? 22750 : 22762 }
    if (m === 98) return { c: 22756, h: 22762, l: 22750 }
    return { o: 22752, c: 22758, h: 22760, l: 22749, buy: 900, sell: 500 }
  }
  const ctx = (pe = { 22700: (m) => 2e6 + m * 10000 }) => oiCtx({ minutes: 100, fut: (m) => (m >= 100 ? 22758 : path(m).c), pe })
  const bs = mkBars(100, (m) => path(m))
  const all = run(now, bs, ctx(), { buyPct: 70, bids: 600 })
  const s = find(all, 'imbalanceRetest')
  check('20 imbalance retest: LONG on the first retest of the buy stack, puts written around it', s?.side === 'LONG' && s.stop < 22740 && /first retest/.test(s.checks.Zone) && /PUT 22650-22750/.test(s.checks.OI), show(s, all))
  check('20 imbalance retest: not on a second retest', !find(run(now, mkBars(100, (m) => path(m, { second: true })), ctx(), { buyPct: 70, bids: 600 }), 'imbalanceRetest'))
  check('20 imbalance retest: not without put writers around the zone', !find(run(now, bs, ctx({}), { buyPct: 70, bids: 600 }), 'imbalanceRetest'))
}

// ---- 21. ATM OI crossover + VWAP reclaim ----------------------------------------------------------------
{
  const now = at(120) + 10_000
  const path = (m, v = {}) => {
    if (m < 100) return { c: 22760 + ((m % 6) - 3) }
    if (m <= 115) return { c: 22760 - (m - 100) }
    if (m <= 118) return { c: 22748, h: 22751, l: 22745 }
    return v.noReclaim ? { o: 22750, c: 22752, h: 22754, l: 22749, buy: 1100, sell: 500 }
      : { o: 22750, c: 22766, h: 22768, l: 22749, buy: 1100, sell: 500, stacked: [{ side: 'buy', low: 22755, high: 22762, rows: 3 }] }
  }
  const atmCe = { 22650: () => 3e6, 22700: () => 3e6, 22750: () => 3e6 }
  const flipPe = { 22650: (m) => 2e6 + m * 15000, 22700: (m) => 2e6 + m * 15000, 22750: (m) => 2e6 + m * 15000 }
  const ctx = (pe, ce = atmCe, last = 22766) => oiCtx({ minutes: 120, fut: (m) => (m >= 120 ? last : path(m).c), pe, ce })
  const bs = mkBars(120, (m) => path(m))
  const all = run(now, bs, ctx(flipPe), { buyPct: 70, bids: 600 })
  const s = find(all, 'atmFlip')
  check('21 ATM flip: LONG - puts overtook calls at ATM since the open, VWAP reclaimed', s?.side === 'LONG' && /writers flipped bullish/.test(s.checks.OI) && /reclaimed VWAP/.test(s.checks.VWAP), show(s, all))
  check('21 ATM flip: not without the flip (puts still below calls)', !find(run(now, bs, ctx({}), { buyPct: 70, bids: 600 }), 'atmFlip'))
  check('21 ATM flip: not without the VWAP reclaim', !find(run(now, mkBars(120, (m) => path(m, { noReclaim: true })), ctx(flipPe, atmCe, 22752), { buyPct: 70, bids: 600 }), 'atmFlip'))
  check('21 ATM flip: not when the whole chain is writing calls in 15m', !find(run(now, bs, ctx(flipPe, { ...atmCe, 23000: (m) => 1e6 + Math.max(0, m - 100) * 200000 }), { buyPct: 70, bids: 600 }), 'atmFlip'))
}

// ---- 22. VWAP ±2σ fade on a balanced day ------------------------------------------------------------------
{
  const now = at(171) + 10_000
  const N = 171
  const path = (m, v = {}) => {
    const base = 22760 + (v.trend ? m * 1.5 : 0)
    if (m < 168) return { c: Math.round(base + 50 * Math.sin((2 * Math.PI * m) / 40)) }
    return [
      { c: base + 66, h: base + 70, l: base + 58 },
      { c: base + 70, h: base + 76, l: base + 64, exhaustion: [{ side: 'sell', price: base + 76 }] },
      { o: base + 70, c: base + 62, h: base + 71, l: base + 60, buy: 400, sell: 900 },
    ][m - 168]
  }
  const walls = { pe: { 22600: (m) => 4e6 + m * 5000 }, ce: { 22850: (m) => 4e6 + m * 5000 } }
  const ctx = (o = {}, v = {}) => oiCtx({ minutes: N, fut: (m) => path(Math.min(m, N - 1), v).c, pe: o.pe ?? walls.pe, ce: o.ce ?? walls.ce })
  const bs = mkBars(N, (m) => path(m))
  const b = vwapBands(bs, now)
  const all = run(now, bs, ctx(), { buyPct: 30, bids: 400 })
  const s = find(all, 'vwapFade')
  check('22 VWAP fade: SHORT off the upper 2σ band on a balanced day, target VWAP', s?.side === 'SHORT' && Math.abs(s.target - b.vwap) < 0.5 && /VWAP crosses/.test(s.checks.Range) && /balanced/.test(s.checks.OI),
    `${show(s, all)} vwap ${b.vwap.toFixed(1)} sd ${b.sd.toFixed(1)} upper ${(b.vwap + 2 * b.sd).toFixed(1)} crosses ${vwapCrosses(bs, now, 90)}`)
  const tb = mkBars(N, (m) => path(m, { trend: true }))
  check('22 VWAP fade: not on a trend day', !find(run(now, tb, ctx({}, { trend: true }), { buyPct: 30, bids: 400 }), 'vwapFade'))
  check('22 VWAP fade: not unless both walls were written since the open', !find(run(now, bs, ctx({ pe: { 22600: () => 4e6 } }), { buyPct: 30, bids: 400 }), 'vwapFade'))
  check('22 VWAP fade: not into a CALL wall being covered', !find(run(now, bs, ctx({ ce: { 22850: (m) => (m < 155 ? 4e6 + m * 8000 : 4e6 + 155 * 8000 - (m - 155) * 40000) } }), { buyPct: 30, bids: 400 }), 'vwapFade'))
}

// ---- 23. Failed IB poke fade ------------------------------------------------------------------------------
{
  const now = at(100) + 10_000
  const path = (m, v = {}) => {
    if (m < 60) return { c: 22740 + Math.round(55 * Math.sin((2 * Math.PI * m) / 30)) }
    if (m < 95) return { c: 22745 + ((m % 8) - 4) * 4 }
    if (v.accepted) return [{ c: 22802, h: 22805 }, { c: 22804, h: 22806 }, { c: 22801, h: 22805 }, { c: 22800, h: 22804, exhaustion: [{ side: 'sell', price: 22804 }] }, { o: 22799, c: 22792, h: 22800, l: 22789, buy: 400, sell: 900 }][m - 95]
    const pokeHigh = v.far ? 22858 : 22810
    return [{ c: 22760 }, { c: 22780 }, { c: 22800, h: pokeHigh, exhaustion: [{ side: 'sell', price: pokeHigh }] }, { c: 22794 }, { o: 22795, c: 22790, h: 22797, l: 22788, buy: 400, sell: 900 }][m - 95]
  }
  const straddle = { ce: { 22750: (m) => 3e6 + m * 3000 }, pe: { 22750: (m) => 3e6 + m * 3000 } }
  const ctx = (o = straddle, v = {}) => oiCtx({ minutes: 100, fut: (m) => path(Math.min(m, 99), v).c, ce: o.ce, pe: o.pe })
  const bs = mkBars(100, (m) => path(m))
  const all = run(now, bs, ctx(), { buyPct: 30, bids: 400 })
  const s = find(all, 'ibFade')
  check('23 IB poke fade: SHORT after a rejected poke above the IB high, ATM straddle written', s?.side === 'SHORT' && /straddle written/.test(s.checks.OI) && /IB middle/.test(s.checks.Range), show(s, all))
  check('23 IB poke fade: not when price was accepted above the IB', !find(run(now, mkBars(100, (m) => path(m, { accepted: true })), ctx(straddle, { accepted: true }), { buyPct: 30, bids: 400 }), 'ibFade'))
  check('23 IB poke fade: not when only the calls were written', !find(run(now, bs, ctx({ ce: straddle.ce, pe: {} }), { buyPct: 30, bids: 400 }), 'ibFade'))
  check('23 IB poke fade: not on a poke too far (0.26%)', !find(run(now, mkBars(100, (m) => path(m, { far: true })), ctx(straddle, { far: true }), { buyPct: 30, bids: 400 }), 'ibFade'))
}

// ---- gap fixes ------------------------------------------------------------------------------------------------
{
  const L = (c, id = 'wallDefence') => ({ id, side: 'LONG', confidence: c, checks: {} })
  const S = (c) => ({ id: 'trap', side: 'SHORT', confidence: c, checks: {} })
  const both = resolveConflicts([L(70), S(52)])
  check('conflict within 20 points (70 vs 52): BOTH sides traded, each noting the other', both.length === 2 && both.some((s) => s.side === 'LONG') && both.some((s) => s.side === 'SHORT') && both.every((s) => /both sides are traded/.test(s.checks.Conflict)), JSON.stringify(both.map((s) => s.checks.Conflict)))
  const kept = resolveConflicts([L(86), S(66), L(60, 'iceberg')])
  check('conflict 20+ points apart (86 vs 66): only the stronger side kept, with a note', kept.length === 2 && kept.every((s) => s.side === 'LONG' && /Breakout trap/.test(s.checks.Conflict)), JSON.stringify(kept))
  check('no conflict: unchanged', resolveConflicts([L(70), L(60, 'iceberg')]).length === 2)
}
{
  // Wall defence (as in the engine test) with wider 1-minute bars: the stop is widened to 1.2x the average range.
  const now = at(100) + 30_000
  const ctx = (pe22600 = (m) => 5e6 + m * 20000) => oiCtx({ minutes: 100, fut: (m) => 22760 - Math.min(95, m), pe: { 22600: pe22600 }, ce: { 22800: (m) => 4e6 + m * 5000 } })
  const wide = (half) => mkBars(100, (m) => { const c = 22760 - Math.min(95, m); return { c, h: c + half, l: c - half, buy: m >= 98 ? 900 : 500, sell: 600, absorption: m === 99 ? [{ side: 'buy', price: 22665 }] : [] } })
  const base = (bs, oi) => evaluateStrategies({ nowMs: now, price: 22665, bars: bs, minuteBars: bs, prints: tapeWith(now, 70), book: book(600), liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi, estimated: false, lotSize: 75, bigLots: 10 })
  const normal = find(base(wide(2), ctx()), 'wallDefence')
  const widened = find(base(wide(12), ctx()), 'wallDefence')
  check('wall defence fires with normal bars (stop as planned)', normal && Math.abs(normal.entry - normal.stop - 23.1) < 0.5, show(normal, []))
  check('volatility floor: stop widened to 1.2 x the 1-minute range', widened && Math.abs(widened.entry - widened.stop - 28.8) < 0.5, show(widened, []))
  check('volatility floor: dropped when the target is then under 1.2R', !find(base(wide(25), ctx()), 'wallDefence'))
  check('a tiny OI increase (0.003%) is not "writers adding"', !find(base(wide(2), ctx((m) => 5e6 + m * 10)), 'wallDefence'))
}
{
  // Wall break LONG needs the futures moving with it.
  const now = at(100) + 10_000
  const path = (m, v = {}) => {
    // 15 minutes before the clock the latest finished minute is 84 (a replayed minute is read once over).
    if (m === 84 || m === 85) return { c: v.futDown ? 22800 : 22720 }
    if (m < 85) return { c: 22720 }
    if (m < 99) return { c: 22740 }
    return { o: 22742, c: 22768, h: 22770, l: 22741, buy: 1500, sell: 400, stacked: [{ side: 'buy', low: 22750, high: 22760, rows: 3 }] }
  }
  const ctx = (v = {}) => oiCtx({ minutes: 100, fut: (m) => (m >= 100 ? 22768 : path(m, v).c), ce: { 22700: (m) => (m < 80 ? 5e6 : 5e6 - (m - 80) * 30000) }, pe: { 22650: (m) => 3e6 + m * 15000 } })
  const go = (v) => run(now, mkBars(100, (m) => path(m, v)), ctx(v), { buyPct: 80, bids: 650 })
  const up = go({})
  check('wall break LONG fires with the futures up', find(up, 'wallBreak')?.side === 'LONG', show(find(up, 'wallBreak'), up))
  check('wall break: not when the futures are down over 15m', !find(go({ futDown: true }), 'wallBreak'))
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
