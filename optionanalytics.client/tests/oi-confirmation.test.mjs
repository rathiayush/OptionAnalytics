// The OI confirmation trade filters (TRADE_FILTERS tradeOiFlow / tradeOiCum / tradeFutOi / tradeWallRoom,
// oiGatePasses): every setup carries the OI at its own minute (oiCtx); each filter lets through a trade the OI
// backs and drops one it does not, LONG and SHORT; 'any' (the default) changes nothing; and the tuning tries
// them through the same applyTradeFilter the scanner uses. Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyTradeFilter, futuresOiStance, oiGatePasses, optionOiRead, strategyFilters } from '../src/strategyEngine.js'
import { scanDaySetups, withDayOutcomes } from '../src/scanDay.js'
import { DEFAULT_VARIANT, OI_GRID, TUNING_GRID, dayTrades, filtersFromTuning, tuneStrategy, tuningDay, variantText, variants } from '../src/strategyTuning.js'
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

test('the OI grid (108), OI then trade (108 + 7,200), and the filters saved', async () => {
  assert.equal([...variants(OI_GRID)].length, 108)
  assert.equal([...variants(TUNING_GRID)].length, 7200)
  // A grid keeps what it does not tune from its base.
  assert.ok([...variants(TUNING_GRID, { ...DEFAULT_VARIANT, tradeOiFlow: 'with' })].every((v) => v.tradeOiFlow === 'with'))
  const all = await scanDaySetups({ ...base, filters: {}, keepAll: true })
  const days = Array.from({ length: 6 }, (_, i) => ({ ...tuningDay(`2026-09-1${i}`, all, replayDay) }))
  const id = all[0].id
  const both = tuneStrategy(days, id, { what: 'both', minTrades: 2, grid: undefined })
  assert.equal(both.what, 'both')
  assert.equal(both.tried, 108 + 7200)
  if (both.best && both.oiStage.best) for (const k of Object.keys(OI_GRID)) assert.equal(both.best.params[k], both.oiStage.best.params[k], 'the trade settings tuned on top of the chosen OI confirmation')
  assert.deepEqual(filtersFromTuning({ closesBeyond: 3 }, { ...DEFAULT_VARIANT, tradeOiFlow: 'with', tradeFutOi: 'buildUp' }), { closesBeyond: 3, tradeOiFlow: 'with', tradeFutOi: 'buildUp' })
})
