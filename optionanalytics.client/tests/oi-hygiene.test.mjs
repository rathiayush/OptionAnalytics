// OI data hygiene and the wall-room filter: a 0 OI / 0 price from the feed is "no reading", never data; a tick
// without OI keeps the strike; the wall room looks at the wall AHEAD of the price. Run: npm test (see CLAUDE.md).
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyOiTicks, upsertSeries } from '../src/liveFeeds.js'
import { buildOiContext, oiGatePasses, optionOiRead, optionStopTargetHit, strategyFilters, applyTradeFilter } from '../src/strategyEngine.js'
import { scanDaySetups } from '../src/scanDay.js'
import { day } from './synthetic-day.mjs'

const MIN = 60_000
const T = Date.parse('2026-10-09T04:00:00Z')
const iso = (m) => new Date(T + m * MIN).toISOString()
const pt = (m, strike, oi, price = 50) => ({ time: iso(m), strike, openInterest: oi, price })
// A small chain: strikes 22400..22600, CE / PE, one point a minute for 31 minutes.
function run(over = {}) {
  const ce = [], pe = []
  for (let m = 0; m <= 30; m++) for (const k of [22400, 22450, 22500, 22550, 22600]) {
    ce.push(pt(m, k, 2e6 + m * 1000, 60)); pe.push(pt(m, k, 2e6 + m * 1000, 60))
  }
  return { success: true, date: '2026-10-09', step: 50, cePoints: over.ce ?? ce, pePoints: over.pe ?? pe, futuresBars: [], spotCandlesOneMinute: Array.from({ length: 31 }, (_, m) => ({ time: iso(m), close: 22500 })) }
}

test('a 0-OI point is the feed\'s "no reading": it is not an unwind, and a since-open add is not inflated', () => {
  for (const side of ['ce', 'pe']) {
    const r = run()
    const clean = optionOiRead(buildOiContext(r, null, { live: true }), 22500, T + 30 * MIN, 15)
    // The 22500 strike reads 0 at minute 20 (a packet without OI).
    const points = r[`${side}Points`]
    points.push(pt(20, 22500, 0, 60))
    const dirty = optionOiRead(buildOiContext(r, null, { live: true }), 22500, T + 30 * MIN, 15)
    assert.deepEqual({ peChg: dirty.peChg, ceChg: dirty.ceChg, peOpen: dirty.peOpen, ceOpen: dirty.ceOpen }, { peChg: clean.peChg, ceChg: clean.ceChg, peOpen: clean.peOpen, ceOpen: clean.ceOpen }, side)
    // ...and a 0 at the OPEN does not become the base of the since-open change.
    const r2 = run()
    r2[`${side}Points`].push(pt(0, 22500, 0, 60))
    const atOpen = optionOiRead(buildOiContext(r2, null, { live: true }), 22500, T + 30 * MIN, 15)
    assert.ok(Math.abs(atOpen[`${side}Open`] - clean[`${side}Open`]) < 1e-9, `${side} since open unchanged by a 0 at the open`)
  }
})

test('a tick without OI that starts a new minute keeps the strike in the OI read', () => {
  const ctx = buildOiContext(run(), null, { live: true })
  const before = optionOiRead(ctx, 22500, T + 30 * MIN, 15)
  for (const side of ['CE', 'PE']) {
    applyOiTicks(ctx, [{ underlying: 'NIFTY', expiryFlag: 'W', side, strike: 22500, time: iso(31) + '', openInterest: 0, price: 61, high: 62, low: 60 }], 'NIFTY', 'W')
    const map = side === 'CE' ? ctx.ce : ctx.pe
    const last = map.get(22500).at(-1)
    assert.equal(last.t, T + 31 * MIN)
    assert.equal(last.oi, 2e6 + 30 * 1000, `${side}: the minute carries the last OI`)
  }
  const after = optionOiRead(ctx, 22500, T + 31 * MIN, 15)
  assert.equal(after.strikes, before.strikes, 'no strike dropped out of the read')
})

test('a price of 0 never becomes a minute\'s low / close; a real tick still widens the range', () => {
  const series = []
  upsertSeries(series, iso(0), { price: 60, high: 60, low: 60, oi: 100 })
  upsertSeries(series, iso(0), { price: 0, high: 0, low: 0, oi: 100 })
  assert.deepEqual([series[0].price, series[0].high, series[0].low], [60, 60, 60])
  upsertSeries(series, iso(0), { price: 58, high: 58, low: 58 })
  assert.equal(series[0].low, 58)
  // The first tick of a minute with price 0: no price, but the OI is kept.
  upsertSeries(series, iso(1), { price: 0, low: 0, oi: 120 })
  assert.equal(series[1].low, undefined)
  assert.equal(series[1].oi, 120)
})

test('an option\'s stop is not hit by a 0 low, and a real touch still is', () => {
  const trade = { side: 'CE', strike: 22500, action: 'BUY', premium: 60 }
  const mk = (low, high = 61) => ({ ce: new Map([[22500, [{ t: T + 2 * MIN, oi: 1, price: 60, high, low }]]]), pe: new Map(), lag: 0 })
  assert.equal(optionStopTargetHit(mk(0), trade, T, T + 10 * MIN, 10, 0), null, 'BUY: a 0 low is no reading')
  const hit = optionStopTargetHit(mk(49), trade, T, T + 10 * MIN, 10, 0)
  assert.equal(hit?.premium, 50, 'BUY: a real low through the stop hits it')
  const sell = { ...trade, action: 'SELL' }
  assert.equal(optionStopTargetHit(mk(0), sell, T, T + 10 * MIN, 0, 10), null, 'SELL: a 0 low is not a target hit')
  assert.equal(optionStopTargetHit(mk(49), sell, T, T + 10 * MIN, 0, 10)?.premium, 50, 'SELL: a real low reaches the target')
})

// ---- wall room ----------------------------------------------------------------------------------------
const ctx = (over) => ({ flow: 0, cum: 0, futOiPct: null, futPricePct: null, spot: 22500, support: 22450, resistance: 22550, ...over })
const long = (c) => ({ id: 'wallBreak', side: 'LONG', t: T, entry: 22500, stop: 22490, target: 22520, checks: {}, oiCtx: ctx(c) })
const short = (c) => ({ id: 'wallBreak', side: 'SHORT', t: T, entry: 22500, stop: 22510, target: 22480, checks: {}, oiCtx: ctx(c) })
const f = (o) => strategyFilters('wallBreak', o)
