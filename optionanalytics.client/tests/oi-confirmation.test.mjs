// The OI confirmation trade filters (TRADE_FILTERS tradeOiFlow / tradeOiCum / tradeFutOi / tradeWallRoom,
// oiGatePasses): every setup carries the OI at its own minute (oiCtx); each filter lets through a trade the OI
// backs and drops one it does not, LONG and SHORT; 'any' (the default) changes nothing; and the tuning tries
// them through the same applyTradeFilter the scanner uses. Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyTradeFilter, futuresOiStance, oiGatePasses, optionOiRead, strategyFilters } from '../src/strategyEngine.js'
import { scanDaySetups, withDayOutcomes } from '../src/scanDay.js'
import { DEFAULT_VARIANT, OI_GRID, oiVariantRedundant, stepSearch, TUNING_GRID, dayTrades, filtersFromTuning, tuneStrategy, tuningDay, variantText, variants } from '../src/strategyTuning.js'
import { day } from './synthetic-day.mjs'

const MIN = 60_000
const T915 = Date.parse('2026-10-09T03:45:00Z')
const at = (m) => T915 + m * MIN
// A long at 22500 (stop 22490, target 22520) with the OI behind it: puts written (flow / cum +), futures long
// build-up, the call wall 50 points above.
const ctx = { flow: 0.5, cum: 0.4, futOiPct: 0.004, futPricePct: 0.002, support: 22450, resistance: 22550, spot: 22500 }
const long = (c = {}) => ({ id: 'wallBreak', side: 'LONG', t: at(60), entry: 22500, stop: 22490, target: 22520, timeStopMs: at(80), checks: {}, oiCtx: { ...ctx, ...c } })
// The mirror short: calls written (flow / cum -), short build-up, the put wall 50 below.
const short = (c = {}) => ({ ...long(), side: 'SHORT', stop: 22510, target: 22480, oiCtx: { ...ctx, flow: -0.5, cum: -0.4, futPricePct: -0.002, ...c } })
const f = (o) => strategyFilters('wallBreak', o)

test('the defaults ("any") change nothing - the same setup back', () => {
  const s = long({ flow: -0.9, cum: -0.9, futPricePct: -0.01, resistance: 22501 })
  assert.equal(applyTradeFilter(s, f({})), s)
  assert.equal(oiGatePasses(s, f({})), true)
})

test('options OI in the last 15 minutes: with / not against the trade, LONG and SHORT', () => {
  for (const [make, sign] of [[long, 1], [short, -1]]) {
    assert.ok(applyTradeFilter(make(), f({ tradeOiFlow: 'with' })), 'writers with it')
    assert.equal(applyTradeFilter(make({ flow: 0.1 * sign }), f({ tradeOiFlow: 'with' })), null, 'too weak a lean is not "with"')
    assert.ok(applyTradeFilter(make({ flow: 0.1 * sign }), f({ tradeOiFlow: 'notAgainst' })), '...but it is not against')
    assert.equal(applyTradeFilter(make({ flow: -0.5 * sign }), f({ tradeOiFlow: 'notAgainst' })), null, 'writers against it')
    assert.ok(applyTradeFilter(make({ flow: -0.5 * sign }), f({ tradeOiFlow: 'any' })), 'loosened: back in')
  }
})

test('options OI since the open (the cumulative, net CE - PE): with / not against', () => {
  assert.ok(applyTradeFilter(long(), f({ tradeOiCum: 'with' })))
  assert.equal(applyTradeFilter(long({ cum: -0.4 }), f({ tradeOiCum: 'with' })), null)
  assert.equal(applyTradeFilter(long({ cum: -0.4 }), f({ tradeOiCum: 'notAgainst' })), null)
  assert.ok(applyTradeFilter(short(), f({ tradeOiCum: 'with' })))
  assert.equal(applyTradeFilter(short({ cum: 0.4 }), f({ tradeOiCum: 'notAgainst' })), null)
  // No read: passes "not against", fails "with".
  assert.ok(applyTradeFilter(long({ cum: null }), f({ tradeOiCum: 'notAgainst' })))
  assert.equal(applyTradeFilter(long({ cum: null }), f({ tradeOiCum: 'with' })), null)
})

test('futures OI: build-up, covering, against, unwinding - and each filter', () => {
  assert.equal(futuresOiStance({ futOiPct: 0.004, futPricePct: 0.002 }, 1), 'buildUp') // long build-up
  assert.equal(futuresOiStance({ futOiPct: -0.004, futPricePct: 0.002 }, 1), 'covering') // short covering
  assert.equal(futuresOiStance({ futOiPct: 0.004, futPricePct: -0.002 }, 1), 'against') // short build-up vs a long
  assert.equal(futuresOiStance({ futOiPct: 0.004, futPricePct: -0.002 }, -1), 'buildUp') // ...is a short's build-up
  assert.equal(futuresOiStance({ futOiPct: -0.004, futPricePct: -0.002 }, 1), 'unwinding')
  assert.equal(futuresOiStance({ futOiPct: 0.0002, futPricePct: 0.002 }, 1), 'flat', 'OI barely moved')
  assert.equal(futuresOiStance({ futOiPct: null, futPricePct: 0.002 }, 1), 'flat')
  const covering = { futOiPct: -0.004 }
  const against = { futPricePct: -0.002 }
  assert.ok(applyTradeFilter(long(), f({ tradeFutOi: 'buildUp' })))
  assert.equal(applyTradeFilter(long(covering), f({ tradeFutOi: 'buildUp' })), null)
  assert.ok(applyTradeFilter(long(covering), f({ tradeFutOi: 'withMove' })))
  assert.equal(applyTradeFilter(long(against), f({ tradeFutOi: 'withMove' })), null)
  assert.equal(applyTradeFilter(long(against), f({ tradeFutOi: 'notAgainst' })), null)
  assert.ok(applyTradeFilter(long(covering), f({ tradeFutOi: 'notAgainst' })))
  assert.ok(applyTradeFilter(short(), f({ tradeFutOi: 'buildUp' })), 'short build-up for a short')
  assert.equal(applyTradeFilter(short({ futPricePct: 0.002 }), f({ tradeFutOi: 'notAgainst' })), null)
})

test('room to the next OI wall: at least 1R, or the wall not inside the target (as traded)', () => {
  // Long: resistance 22550, 50 points of room; stop 10 (1R), target 20.
  assert.ok(applyTradeFilter(long(), f({ tradeWallRoom: 'target' })))
  assert.equal(applyTradeFilter(long({ resistance: 22515 }), f({ tradeWallRoom: 'target' })), null, 'the call wall sits inside the target')
  assert.ok(applyTradeFilter(long({ resistance: 22515 }), f({ tradeWallRoom: 'oneR' })), '15 points: more than 1R')
  assert.equal(applyTradeFilter(long({ resistance: 22505 }), f({ tradeWallRoom: 'oneR' })), null)
  assert.ok(applyTradeFilter(long({ resistance: null }), f({ tradeWallRoom: 'target' })), 'no wall that way')
  // Judged on the target as traded: x3 makes it 60 points - past the wall at 50.
  assert.equal(applyTradeFilter(long(), f({ tradeWallRoom: 'target', tradeTargetX: 3 })), null)
  assert.ok(applyTradeFilter(long(), f({ tradeWallRoom: 'target', tradeTargetX: 2 })))
  // Short: the put wall below.
  assert.ok(applyTradeFilter(short(), f({ tradeWallRoom: 'target' })))
  assert.equal(applyTradeFilter(short({ support: 22490 }), f({ tradeWallRoom: 'target' })), null)
})

test('the trade says which OI confirmation it passed', () => {
  const s = applyTradeFilter(long(), f({ tradeOiFlow: 'with', tradeFutOi: 'buildUp' }))
  assert.match(s.checks.Trade, /OI: options OI 15m with it, futures OI fresh build-up with it/)
  assert.match(variantText({ ...DEFAULT_VARIANT, tradeOiCum: 'notAgainst', tradeWallRoom: 'oneR' }), /OI: options OI since open not against, OI wall 1R\+/)
})

// The synthetic day as a replay day (as in strategy-tuning.test.mjs).
const syn = day()
const heatmap = syn.path.map((p, m) => ({ t: syn.at(m) + 30_000, bids: [[p - 1, 500]], asks: [[p + 1, 500]] }))
const replayDay = { meta: { lotSize: 75, lastPrice: syn.path.at(-1) }, minuteBars: syn.minuteBars, trades: [], icebergs: [], heatmap, sweeps: [], source: 'live' }
const base = { day: replayDay, prints: syn.prints, oi: syn.oi, profile: null, rowSize: 1, lotSize: 75, largeLots: 10, estimated: false }

test('every setup carries the OI of its own minute - nothing from after it', async () => {
  const all = await scanDaySetups({ ...base, filters: {}, keepAll: true })
  assert.ok(all.length > 0)
  for (const s of all.slice(0, 40)) {
    const read = optionOiRead(syn.oi, s.oiCtx.spot, s.t, 15)
    assert.equal(s.oiCtx.flow, read.lean)
    assert.equal(s.oiCtx.cum, read.leanOpen)
    assert.ok(Number.isFinite(s.oiCtx.futOiPct) && Number.isFinite(s.oiCtx.futPricePct))
  }
  // The same minute evaluated with the OI cut at that minute gives the same numbers.
  const s = all[Math.floor(all.length / 2)]
  const cut = { ...syn.oi, ce: new Map([...syn.oi.ce].map(([k, v]) => [k, v.filter((p) => p.t <= s.t)])), pe: new Map([...syn.oi.pe].map(([k, v]) => [k, v.filter((p) => p.t <= s.t)])), futures: syn.oi.futures.filter((p) => p.t <= s.t), spot: syn.oi.spot.filter((p) => p.t <= s.t) }
  const again = (await scanDaySetups({ ...base, oi: cut, filters: {}, keepAll: true, until: s.t })).find((x) => x.id === s.id && x.side === s.side && x.t === s.t)
  assert.deepEqual(again.oiCtx, s.oiCtx)
})

test('the tuning measures the OI confirmation exactly as the scanner takes it', async () => {
  const all = await scanDaySetups({ ...base, filters: {}, keepAll: true })
  const tday = tuningDay('2026-10-05', all, replayDay)
  const ids = [...new Set(all.map((s) => s.id))]
  for (const id of ids) {
    for (const v of [
      { ...DEFAULT_VARIANT, tradeOiFlow: 'notAgainst', tradeFutOi: 'notAgainst' },
      { ...DEFAULT_VARIANT, tradeOiCum: 'with', tradeWallRoom: 'oneR' },
      { ...DEFAULT_VARIANT, tradeFutOi: 'withMove', tradeTargetX: 2, tradeWallRoom: 'target' },
    ]) {
      const scanned = await scanDaySetups({ ...base, filters: { [id]: v }, trail: null })
      const scannerR = withDayOutcomes(scanned.filter((s) => s.id === id), replayDay).map((s) => s.outcome.r)
      assert.deepEqual(dayTrades(tday, id, v, null), scannerR, `${id} ${variantText(v)}`)
    }
  }
})

test('the OI grid is searched step by step, OI then trade tunes the trade on top, and the filters saved', async () => {
  const full = [...variants(OI_GRID)].length
  assert.ok(full > 1_000_000, `the full OI grid is far too big to try (${full})`)
  assert.equal([...variants(TUNING_GRID)].length, 7200)
  assert.ok([...variants(TUNING_GRID, { ...DEFAULT_VARIANT, tradeOiFlow: 'with' })].every((v) => v.tradeOiFlow === 'with'), 'a grid keeps what it does not tune')
  const all = await scanDaySetups({ ...base, filters: {}, keepAll: true })
  const days = Array.from({ length: 6 }, (_, i) => ({ ...tuningDay(`2026-09-1${i}`, all, replayDay) }))
  const id = all[0].id
  const both = tuneStrategy(days, id, { what: 'both', minTrades: 2 })
  assert.equal(both.what, 'both')
  const oiTried = both.tried - 7200
  assert.ok(oiTried >= 1 && oiTried < 400, `the OI part tried ${oiTried} combinations, not millions`)
  if (both.best && both.oiStage.best) for (const k of Object.keys(OI_GRID)) assert.equal(both.best.params[k], both.oiStage.best.params[k], 'the trade settings tuned on top of the chosen OI confirmation')
  assert.deepEqual(filtersFromTuning({ closesBeyond: 3 }, { ...DEFAULT_VARIANT, tradeOiFlow: 'with', tradeFutOi: 'buildUp' }), { closesBeyond: 3, tradeOiFlow: 'with', tradeFutOi: 'buildUp' })
})

test('step search: each filter takes the value that scores best given the others, windows only once their filter is on', () => {
  // A planted world: the score is 1 for the right futures OI, +1 for the right CE/PE pattern, +1 for 3-minute timeframe
  // but only while an options OI change filter is on.
  const grid = { tradeOiFlow: ['any', 'with'], tradeSideOi: ['any', 'lean', 'both'], tradeFutOi: ['any', 'buildUp', 'squeeze'], tradeOiWindow: [15, 1, 3] }
  const seenParams = []
  const scoreOf = (v) => {
    seenParams.push(v)
    const total = (v.tradeFutOi === 'squeeze' ? 1 : 0) + (v.tradeSideOi === 'both' ? 1 : 0) + (v.tradeOiFlow === 'with' && v.tradeOiWindow === 3 ? 1 : 0)
    return { n: 10, total, avg: total / 10, score: total / 10 }
  }
  const { rows, tried } = stepSearch(grid, { ...DEFAULT_VARIANT }, scoreOf, { minTrades: 5 })
  assert.equal(rows[0].params.tradeFutOi, 'squeeze')
  assert.equal(rows[0].params.tradeSideOi, 'both')
  assert.equal(rows[0].params.tradeOiFlow, 'with')
  assert.equal(rows[0].params.tradeOiWindow, 3, 'the timeframe is tried once the filter that reads it is on')
  assert.ok(tried < 30, `${tried} combinations tried, out of ${[...variants(grid)].length}`)
  assert.ok(seenParams.every((v) => !oiVariantRedundant(v) || JSON.stringify(v) === JSON.stringify(DEFAULT_VARIANT)), 'no combination where the timeframe changes nothing')
  // Too few trades: nothing qualifies, nothing moves.
  const none = stepSearch(grid, { ...DEFAULT_VARIANT }, () => ({ n: 2, total: 5, avg: 2.5, score: 2.5 }), { minTrades: 5 })
  assert.deepEqual(none.rows, [])
})

test('the tuning page can choose which OI inputs are tuned; the rest stay at their defaults', async () => {
  const { OI_FACTORS, oiGridOf } = await import('../src/strategyTuning.js')
  assert.deepEqual(OI_FACTORS.map((f) => f.key), Object.keys(OI_GRID))
  assert.deepEqual(Object.keys(oiGridOf(['tradeFutOi', 'nonsense'])), ['tradeFutOi'])
  assert.equal(Object.keys(oiGridOf(null)).length, Object.keys(OI_GRID).length, 'none chosen = all of them')
  const all = await scanDaySetups({ ...base, filters: {}, keepAll: true })
  const days = Array.from({ length: 6 }, (_, i) => tuningDay(`2026-09-1${i}`, all, replayDay))
  const id = all[0].id
  const only = tuneStrategy(days, id, { what: 'oi', minTrades: 2, oiKeys: ['tradeFutOi'] })
  assert.equal(only.tried, OI_GRID.tradeFutOi.length, 'the base and every other value of the one filter')
  for (const row of only.top) for (const k of Object.keys(OI_GRID).filter((x) => x !== 'tradeFutOi')) assert.equal(row.params[k], DEFAULT_VARIANT[k], `${k} untouched`)
  const two = tuneStrategy(days, id, { what: 'oi', minTrades: 2, oiKeys: ['tradeOiFlow', 'tradeOiCum'] })
  assert.ok(two.tried <= 9 && two.tried >= 5, `${two.tried}`)
})

test('OI timeframe 1 / 3 / 5 / 15: each setup records the shorter reads, and the filters read the chosen one', () => {
  const byWindow = { 1: { flow: -0.6, futOiPct: -0.002, futPricePct: -0.001 }, 3: { flow: 0.5, futOiPct: 0.002, futPricePct: 0.001 }, 5: { flow: 0.1, futOiPct: 0.0002, futPricePct: 0.0004 } }
  // 15 min: puts written (+0.5), futures long build-up; 1 min: calls written, futures short build-up (the move turned).
  const l = (extra) => ({ id: 'wallBreak', side: 'LONG', t: at(60), entry: 22500, stop: 22490, target: 22520, timeStopMs: at(80), checks: {}, oiCtx: { ...ctx, byWindow, ...extra } })
  const f = (o) => strategyFilters('wallBreak', o)
  assert.ok(applyTradeFilter(l(), f({ tradeOiFlow: 'with' })), '15 min is the default timeframe')
  assert.equal(applyTradeFilter(l(), f({ tradeOiFlow: 'with', tradeOiWindow: 1 })), null, 'on 1 min the writers are against a long')
  assert.ok(applyTradeFilter(l(), f({ tradeOiFlow: 'with', tradeOiWindow: 3 })))
  assert.equal(applyTradeFilter(l(), f({ tradeOiFlow: 'with', tradeOiWindow: 5 })), null, '+0.1 is under the 0.2 lean that counts as "with"')
  assert.ok(applyTradeFilter(l(), f({ tradeOiFlow: 'notAgainst', tradeOiWindow: 5 })))
  // Futures OI on each timeframe (the moves that count scale with the window).
  assert.equal(futuresOiStance(l().oiCtx, 1, 3), 'buildUp')
  assert.equal(futuresOiStance(l().oiCtx, 1, 1), 'unwinding', 'OI and price both falling for a long')
  assert.equal(futuresOiStance(l().oiCtx, 1, 5), 'flat', '0.02% of OI in 5 min is under the scaled bar (0.1% x 5/15 = 0.033%)')
  assert.equal(applyTradeFilter(l(), f({ tradeFutOi: 'buildUp', tradeFutWindow: 3 })) !== null, true)
  assert.equal(applyTradeFilter(l(), f({ tradeFutOi: 'buildUp', tradeFutWindow: 1 })), null)
  // The options OI and the futures OI have their own timeframe: options on 3 min (writers with), futures on 1 min (against).
  assert.equal(applyTradeFilter(l(), f({ tradeOiFlow: 'with', tradeOiWindow: 3, tradeFutOi: 'buildUp', tradeFutWindow: 1 })), null)
  assert.ok(applyTradeFilter(l(), f({ tradeOiFlow: 'with', tradeOiWindow: 3, tradeFutOi: 'buildUp', tradeFutWindow: 3 })))
  // SHORT mirror on 1 minute: calls written, futures short build-up.
  const sh = { ...l(), side: 'SHORT', stop: 22510, target: 22480 }
  assert.ok(applyTradeFilter(sh, f({ tradeOiFlow: 'with', tradeOiWindow: 1 })))
  assert.equal(applyTradeFilter(sh, f({ tradeOiFlow: 'with', tradeOiWindow: 3 })), null)
  // No read on that window (an older setup): "not against" passes, "with" fails.
  const old = { ...l(), oiCtx: { ...ctx } }
  assert.ok(applyTradeFilter(old, f({ tradeOiFlow: 'notAgainst', tradeOiWindow: 3 })))
  assert.equal(applyTradeFilter(old, f({ tradeOiFlow: 'with', tradeOiWindow: 3 })), null)
  // The default timeframe alone gates nothing.
  assert.deepEqual(applyTradeFilter(l(), f({ tradeOiWindow: 1 })).oiCtx, l().oiCtx)
  assert.match(applyTradeFilter(l(), f({ tradeOiFlow: 'with', tradeOiWindow: 3 })).checks.Trade, /options OI 3m with it/)
})

test('every setup records its OI on 1, 3 and 5 minutes as well as 15 - nothing after its own minute', async () => {
  const all = await scanDaySetups({ ...base, filters: {}, keepAll: true })
  for (const s of all.slice(0, 40)) {
    for (const m of [1, 3, 5]) {
      const r = optionOiRead(syn.oi, s.oiCtx.spot, s.t, m)
      assert.equal(s.oiCtx.byWindow[m].flow, r?.lean ?? null, `${m} min`)
    }
  }
  assert.ok(all.some((s) => s.oiCtx.byWindow[1].flow !== s.oiCtx.byWindow[5].flow), 'the windows read differently')
})

test('support / resistance OI: the wall in the way shrinking or growing, on the options OI timeframe', () => {
  const f = (o) => strategyFilters('wallBreak', o)
  // 15 min: the call wall above shrank 2%, the put wall below grew 3%; 1 min: the call wall grew 1%.
  const mk = (side, extra) => ({ id: 'wallBreak', side, t: at(60), entry: 22500, stop: side === 'LONG' ? 22490 : 22510, target: side === 'LONG' ? 22520 : 22480, checks: {},
    oiCtx: { ...ctx, resChg: -0.02, supChg: 0.03, byWindow: { 1: { resChg: 0.01, supChg: -0.01 }, 3: { resChg: null, supChg: null }, 5: { resChg: -0.0005, supChg: 0.0005 } }, ...extra } })
  assert.ok(applyTradeFilter(mk('LONG'), f({ tradeWallOi: 'shrinking' })), 'LONG: the call wall above is leaving')
  assert.equal(applyTradeFilter(mk('LONG'), f({ tradeWallOi: 'growing' })), null)
  assert.ok(applyTradeFilter(mk('SHORT'), f({ tradeWallOi: 'growing' })), 'SHORT: the put wall below is growing')
  assert.equal(applyTradeFilter(mk('SHORT'), f({ tradeWallOi: 'shrinking' })), null)
  assert.equal(applyTradeFilter(mk('LONG'), f({ tradeWallOi: 'shrinking', tradeOiWindow: 1 })), null, '1 min: it grew')
  assert.ok(applyTradeFilter(mk('LONG'), f({ tradeWallOi: 'growing', tradeOiWindow: 1 })))
  assert.equal(applyTradeFilter(mk('LONG'), f({ tradeWallOi: 'shrinking', tradeOiWindow: 5 })), null, '-0.05% in 5 min is under the bar (0.5% x 5/15)')
  assert.equal(applyTradeFilter(mk('LONG'), f({ tradeWallOi: 'shrinking', tradeOiWindow: 3 })), null, 'no read: it needs evidence')
  assert.ok(applyTradeFilter(mk('LONG'), f({})), 'default: not checked')
  assert.match(applyTradeFilter(mk('LONG'), f({ tradeWallOi: 'shrinking' })).checks.Trade, /wall OI shrinking/)
})

test('every setup records the OI of the walls ahead on each timeframe, nothing after its own minute', async () => {
  const all = await scanDaySetups({ ...base, filters: {}, keepAll: true })
  let seen = 0
  for (const s of all.slice(0, 40)) {
    const c = s.oiCtx
    assert.ok('resChg' in c && 'supChg' in c)
    for (const m of [1, 3, 5]) assert.ok('resChg' in c.byWindow[m] && 'supChg' in c.byWindow[m], `${m} min`)
    if (c.resistanceAhead != null) {
      const now = syn.oi.ce.get(c.resistanceAhead)
      const at15 = (t) => { let v = null; for (const p of now) if (p.t <= t) v = p; return v }
      const a = at15(s.t), b = at15(s.t - 15 * MIN)
      if (a && b && b.oi > 0) { assert.ok(Math.abs(c.resChg - (a.oi - b.oi) / b.oi) < 1e-9); seen++ }
    }
  }
  assert.ok(seen > 0)
})

test('CE and PE each rising / falling: delta on the timeframe and since the open, LONG and SHORT', () => {
  const f = (o) => strategyFilters('wallBreak', o)
  const mk = (side, extra) => ({ id: 'wallBreak', side, t: at(60), entry: 22500, stop: side === 'LONG' ? 22490 : 22510, target: side === 'LONG' ? 22520 : 22480, checks: {},
    oiCtx: { ...ctx, ceD: -0.01, peD: 0.01, ceC: -0.05, peC: 0.04, byWindow: { 3: { ceD: 0.01, peD: 0.01 }, 1: { ceD: null, peD: null } }, ...extra } })
  // PE rising + CE falling = both sides bullish.
  assert.ok(applyTradeFilter(mk('LONG'), f({ tradeSideOi: 'both' })))
  assert.equal(applyTradeFilter(mk('SHORT'), f({ tradeSideOi: 'lean' })), null, 'both sides are against a short')
  assert.equal(applyTradeFilter(mk('SHORT'), f({ tradeSideOi: 'notAgainst' })), null)
  // CE rising + PE falling = both bearish: the SHORT mirror.
  const bear = { ceD: 0.01, peD: -0.01, ceC: 0.05, peC: -0.04 }
  assert.ok(applyTradeFilter(mk('SHORT', bear), f({ tradeSideOi: 'both', tradeSideCum: 'both' })))
  assert.equal(applyTradeFilter(mk('LONG', bear), f({ tradeSideOi: 'notAgainst' })), null)
  // One side with it, the other flat: "lean" passes, "both" does not. One with, one against: only "notAgainst".
  assert.ok(applyTradeFilter(mk('LONG', { ceD: 0, peD: 0.01 }), f({ tradeSideOi: 'lean' })))
  assert.equal(applyTradeFilter(mk('LONG', { ceD: 0, peD: 0.01 }), f({ tradeSideOi: 'both' })), null)
  assert.equal(applyTradeFilter(mk('LONG', { ceD: 0.01, peD: 0.01 }), f({ tradeSideOi: 'lean' })), null, 'PE rising but CE rising too: they cancel')
  assert.ok(applyTradeFilter(mk('LONG', { ceD: 0.01, peD: 0.01 }), f({ tradeSideOi: 'notAgainst' })))
  // The timeframe: 3 min has both rising (cancelling); 1 min has no read.
  assert.equal(applyTradeFilter(mk('LONG'), f({ tradeSideOi: 'lean', tradeOiWindow: 3 })), null)
  assert.ok(applyTradeFilter(mk('LONG'), f({ tradeSideOi: 'notAgainst', tradeOiWindow: 1 })), 'no read passes "not against"')
  assert.equal(applyTradeFilter(mk('LONG'), f({ tradeSideOi: 'lean', tradeOiWindow: 1 })), null, 'no read fails "lean"')
  // Since the open (a 1% bar); small moves do not count.
  assert.equal(applyTradeFilter(mk('LONG', { ceC: 0.004, peC: 0.004 }), f({ tradeSideCum: 'lean' })), null, 'both under 1%: flat')
  assert.ok(applyTradeFilter(mk('LONG'), f({ tradeSideCum: 'both' })))
  assert.ok(applyTradeFilter(mk('LONG', { ceD: -0.01, peD: 0.01 }), f({})), 'default: not checked')
})

test('short squeeze, small move and day type', () => {
  const f = (o) => strategyFilters('wallBreak', o)
  const mk = (side, extra) => ({ id: 'wallBreak', side, t: at(60), entry: 22500, stop: side === 'LONG' ? 22490 : 22510, target: side === 'LONG' ? 22520 : 22480, checks: {},
    oiCtx: { ...ctx, dayType: 'trend-up', byWindow: {}, ...extra } })
  // Short squeeze for a long: price up on falling futures OI. Long unwinding for a short: price down on falling OI.
  assert.ok(applyTradeFilter(mk('LONG', { futOiPct: -0.004, futPricePct: 0.002 }), f({ tradeFutOi: 'squeeze' })))
  assert.equal(applyTradeFilter(mk('LONG', { futOiPct: 0.004, futPricePct: 0.002 }), f({ tradeFutOi: 'squeeze' })), null, 'a fresh build-up is not a squeeze')
  assert.ok(applyTradeFilter(mk('SHORT', { futOiPct: -0.004, futPricePct: -0.002 }), f({ tradeFutOi: 'squeeze' })))
  assert.equal(applyTradeFilter(mk('SHORT', { futOiPct: -0.004, futPricePct: 0.002 }), f({ tradeFutOi: 'squeeze' })), null)
  // Move size on the futures timeframe: under 0.1% in 15 min is small.
  assert.ok(applyTradeFilter(mk('LONG', { futPricePct: 0.0007 }), f({ tradeMoveSize: 'small' })))
  assert.equal(applyTradeFilter(mk('LONG', { futPricePct: 0.0007 }), f({ tradeMoveSize: 'large' })), null)
  assert.ok(applyTradeFilter(mk('SHORT', { futPricePct: -0.002 }), f({ tradeMoveSize: 'large' })), 'a fall counts by its size')
  assert.equal(applyTradeFilter(mk('LONG', { futPricePct: 0.0004, byWindow: { 5: { futPricePct: 0.0002 } } }), f({ tradeMoveSize: 'large', tradeFutWindow: 5 })), null, '0.02% in 5 min is small (the bar is 0.033%)')
  assert.ok(applyTradeFilter(mk('LONG', { futPricePct: 0.0004, byWindow: { 5: { futPricePct: 0.0004 } } }), f({ tradeMoveSize: 'large', tradeFutWindow: 5 })), '0.04% in 5 min is a real move')
  assert.equal(applyTradeFilter(mk('LONG', { futPricePct: null }), f({ tradeMoveSize: 'small' })), null, 'no read')
  // Day type: a trending day my way / against / a range.
  assert.ok(applyTradeFilter(mk('LONG'), f({ tradeDayType: 'withTrend' })))
  assert.equal(applyTradeFilter(mk('SHORT'), f({ tradeDayType: 'withTrend' })), null)
  assert.equal(applyTradeFilter(mk('SHORT'), f({ tradeDayType: 'notAgainstTrend' })), null)
  assert.ok(applyTradeFilter(mk('LONG'), f({ tradeDayType: 'trend' })))
  assert.ok(applyTradeFilter(mk('SHORT', { dayType: 'trend-down' }), f({ tradeDayType: 'withTrend' })))
  assert.equal(applyTradeFilter(mk('LONG', { dayType: 'range' }), f({ tradeDayType: 'trend' })), null)
  assert.ok(applyTradeFilter(mk('LONG', { dayType: 'range' }), f({ tradeDayType: 'range' })))
  assert.ok(applyTradeFilter(mk('LONG', { dayType: 'two-sided' }), f({ tradeDayType: 'range' })))
  assert.ok(applyTradeFilter(mk('LONG', { dayType: 'unclear' }), f({ tradeDayType: 'notAgainstTrend' })))
  assert.equal(applyTradeFilter(mk('LONG', { dayType: null }), f({ tradeDayType: 'withTrend' })), null, 'no read')
  assert.ok(applyTradeFilter(mk('LONG', { dayType: null }), f({ tradeDayType: 'notAgainstTrend' })))
  assert.match(applyTradeFilter(mk('LONG', { futOiPct: -0.004, futPricePct: 0.002 }), f({ tradeDayType: 'withTrend', tradeFutOi: 'squeeze' })).checks.Trade, /day: trending my way/)
})

test('every setup records CE / PE rising or falling, the day type, up to its own minute', async () => {
  const all = await scanDaySetups({ ...base, filters: {}, keepAll: true })
  assert.ok(all.length > 0)
  for (const s of all.slice(0, 40)) {
    const c = s.oiCtx
    const r = optionOiRead(syn.oi, c.spot, s.t, 15)
    assert.equal(c.peD, r.peChg / r.peNow)
    assert.equal(c.ceD, r.ceChg / r.ceNow)
    assert.equal(c.ceC, r.ceOpen / r.ceNow)
    assert.equal(c.peC, r.peOpen / r.peNow)
    for (const m of [1, 3, 5]) { const rm = optionOiRead(syn.oi, c.spot, s.t, m); assert.equal(c.byWindow[m].ceD, rm.ceChg / rm.ceNow, `${m} min`) }
    assert.equal(c.dayType, s.regime.type, 'the same day type the setup is tagged with')
  }
})

test('every combination: counts, the cap, and it finds at least what step by step finds', async () => {
  const { countOiCombinations, OI_COMBO_CAP } = await import('../src/strategyTuning.js')
  assert.deepEqual(countOiCombinations(['tradeFutOi']), { count: OI_GRID.tradeFutOi.length, over: false })
  assert.deepEqual(countOiCombinations(['tradeOiFlow', 'tradeOiCum']), { count: 9, over: false })
  // A timeframe changes nothing alone: flow (3) x window (4) is 1 + 2 x 4 = 9, not 12.
  assert.equal(countOiCombinations(['tradeOiFlow', 'tradeOiWindow']).count, 9)
  const all = countOiCombinations(null)
  assert.equal(all.over, true)
  assert.equal(all.count, OI_COMBO_CAP)
  const days0 = await scanDaySetups({ ...base, filters: {}, keepAll: true })
  const days = Array.from({ length: 6 }, (_, i) => tuningDay(`2026-09-1${i}`, days0, replayDay))
  const id = days0[0].id
  const keys = ['tradeOiFlow', 'tradeSideOi', 'tradeFutOi', 'tradeOiWindow']
  const seen = []
  const full = tuneStrategy(days, id, { what: 'oi', minTrades: 2, oiKeys: keys, search: 'full', onProgress: (p) => seen.push(p) })
  const step = tuneStrategy(days, id, { what: 'oi', minTrades: 2, oiKeys: keys })
  assert.equal(full.tried, countOiCombinations(keys).count, 'every combination was tried')
  assert.ok(step.tried < full.tried)
  assert.ok((full.top[0]?.train.score ?? -Infinity) >= (step.top[0]?.train.score ?? -Infinity), 'the full search finds at least as good on the train days')
  // Too many: refuses, naming what to do.
  assert.throws(() => tuneStrategy(days, id, { what: 'oi', minTrades: 2, search: 'full' }), /untick some OI inputs/)
  // The trade-only tuning never takes the OI search path.
  assert.equal(tuneStrategy(days, id, { what: 'trade', minTrades: 2, grid: { tradeSide: ['both', 'long'] } }).tried, 2)
  void seen
})

test('points captured: the index, futures in and out, and the option prices in and out', async () => {
  const { tradeDetails, pointsSummary } = await import('../src/strategyTuning.js')
  const { premiumAt, simulateOutcome } = await import('../src/strategyEngine.js')
  const all = await scanDaySetups({ ...base, filters: {}, keepAll: true })
  const id = all[0].id
  const day = tuningDay('2026-09-10', all, replayDay, syn.oi)
  const trades = tradeDetails([day], id, DEFAULT_VARIANT, null, 'NIFTY')
  assert.ok(trades.length > 0)
  const MIN = 60_000
  for (const t of trades) {
    const dir = t.side === 'LONG' ? 1 : -1
    assert.equal(t.index, 'NIFTY')
    assert.ok(Math.abs(t.points - dir * (t.exit - t.entry)) < 1e-9, 'points are the futures move in the trade\'s direction')
    // The setup, replayed on its own, gives the same exit price and R.
    const setup = all.find((s) => s.id === id && s.t === t.t)
    const o = simulateOutcome({ ...setup, trail: null }, day.minuteBars, day.endMs, true)
    assert.equal(o.r, t.r)
    assert.equal(o.exitPrice, t.exit)
    for (const [key, which] of [['buy', 'buy'], ['sell', 'sell']]) {
      const opt = setup.options?.[which]
      if (!opt) { assert.equal(t[key], null); continue }
      assert.equal(t[key].entry, opt.premium, 'the option\'s entry premium is the setup\'s')
      const exit = premiumAt(syn.oi, opt.side, opt.strike, (o.exitAt ?? day.endMs - MIN) + MIN)
      assert.equal(t[key].exit, exit, 'its exit premium is the premium at the exit minute')
      if (exit != null) assert.ok(Math.abs(t[key].points - (which === 'buy' ? exit - opt.premium : opt.premium - exit)) < 1e-9)
      assert.match(t[key].label, new RegExp(`^${which.toUpperCase()} ${opt.strike} ${opt.side}$`))
    }
  }
  const sum = pointsSummary(trades)
  assert.equal(sum.n, trades.length)
  assert.ok(Math.abs(sum.total - trades.reduce((a, t) => a + t.points, 0)) < 1e-9)
  assert.equal(sum.buy.n + 0, trades.filter((t) => Number.isFinite(t.buy?.points)).length)
  // Captured (winners) + lost (losers) = net, for the futures and each option; the stop-loss part is the futures
  // trades the stop ended at a loss.
  for (const [name, s, pts] of [['futures', sum, trades.map((t) => t.points)], ['buy', sum.buy, trades.map((t) => t.buy?.points).filter(Number.isFinite)], ['sell', sum.sell, trades.map((t) => t.sell?.points).filter(Number.isFinite)]]) {
    assert.ok(Math.abs(s.captured - pts.filter((p) => p > 0).reduce((x, y) => x + y, 0)) < 1e-9, `${name} captured`)
    assert.ok(Math.abs(s.lost - pts.filter((p) => p < 0).reduce((x, y) => x + y, 0)) < 1e-9, `${name} lost`)
    assert.ok(Math.abs(s.total - (s.captured + s.lost)) < 1e-9, `${name} net`)
    assert.equal(s.wins + s.losses <= s.n, true)
  }
  const slTrades = trades.filter((t) => t.stopHit && t.points < 0)
  assert.equal(sum.slN, slTrades.length)
  assert.ok(Math.abs(sum.slPoints - slTrades.reduce((x, t) => x + t.points, 0)) < 1e-9)
  assert.ok(sum.slPoints >= sum.lost - 1e-9 && sum.slPoints <= 0, 'the stop-loss points are part of what was lost')
  // Hand-made trades: two winners (one ended by a trailing stop in profit), a stop-loss, a time-stop loss.
  const mk = (points, extra) => ({ points, buy: { points: points * 0.4 }, sell: { points: -points * 0.4 }, ...extra })
  const hand = pointsSummary([mk(30), mk(12, { stopHit: true }), mk(-10, { stopHit: true }), mk(-6)])
  assert.deepEqual([hand.n, hand.captured, hand.lost, hand.total, hand.wins, hand.losses], [4, 42, -16, 26, 2, 2])
  assert.deepEqual([hand.slN, hand.slPoints], [1, -10], 'a trailing stop that locked a profit is not a stop-loss')
  assert.deepEqual([hand.buy.captured, hand.buy.lost], [16.8, -6.4], 'the bought option moves with the trade')
  assert.deepEqual([hand.sell.captured.toFixed(1), hand.sell.lost.toFixed(1)], ['6.4', '-16.8'], 'the sold option moves against it')
  assert.deepEqual(pointsSummary([]).total, 0)
  // No OI on the day: the options have no exit premium, the futures points are still there.
  const noOi = tradeDetails([{ ...day, oi: null }], id, DEFAULT_VARIANT, null, 'NIFTY')
  assert.ok(noOi.every((t) => (t.buy == null || t.buy.exit == null) && Number.isFinite(t.points)))
  // The tuning result carries them for the best setting and the strategy as written.
  const days = Array.from({ length: 6 }, (_, i) => tuningDay(`2026-09-1${i}`, all, replayDay, syn.oi))
  const r = tuneStrategy(days, id, { what: 'trade', minTrades: 2, grid: { tradeSide: ['both', 'long'] }, underlying: 'NIFTY' })
  assert.equal(r.baseline.points.n, tradeDetails(days, id, DEFAULT_VARIANT, null, 'NIFTY').length)
  if (r.best) { assert.ok(r.best.trades.length > 0 && r.best.points.n === r.best.trades.length); assert.equal(r.best.trades[0].index, 'NIFTY') }
})
