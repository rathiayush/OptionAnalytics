// The market at a signal (scannerCore.marketAt), kept with each signal in the scanner record for the learning: tape
// aggression, big orders, delta, volume, futures price / OI, option writers, PCR, the book near the price, VWAP -
// read ONLY from what was known at the clock. Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { marketAt, MARKET_KEYS, scannerLogBody } from '../src/scannerCore.js'
import { buildOiContext } from '../src/strategyEngine.js'

const MIN = 60_000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()

function oiCtx() {
  const sp = [], fut = [], ce = [], pe = []
  for (let m = 0; m <= 60; m++) {
    sp.push({ time: iso(at(m)), open: 22640, high: 22640, low: 22640, close: 22640 })
    // futures up 0.2% and OI up 1% over the last 15 minutes of the hour, then a jump AFTER the clock (m 51+).
    const px = m <= 35 ? 22700 : m <= 50 ? 22700 + (m - 35) * 3 : 23500
    fut.push({ time: iso(at(m)), open: px, high: px, low: px, close: px, volume: 1, openInterest: m <= 35 ? 1e7 : m <= 50 ? 1e7 + (m - 35) * 6666 : 2e7 })
    for (let k = 22400; k <= 22900; k += 50) {
      ce.push({ time: iso(at(m)), strike: k, openInterest: 2e6 })
      pe.push({ time: iso(at(m)), strike: k, openInterest: Math.abs(k - 22650) <= 100 && m >= 35 ? 2e6 + (m - 35) * 50000 : 2e6 })
    }
  }
  return buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: sp, futuresBars: fut, cePoints: ce, pePoints: pe }, null, { live: false })
}

test('the market at a signal: every number from what was known at the clock', () => {
  const now = at(50) + 30_000
  const bars = Array.from({ length: 50 }, (_, m) => ({ time: at(m), open: 22740, high: 22745, low: 22735, close: 22740, buy: m >= 35 ? 1300 : 500, sell: 500, delta: m >= 35 ? 800 : 0 }))
  // Tape: the last minute mostly bought, one big buy of 20 lots and one big sell of 10 lots in the last 5 min - and
  // prints AFTER the clock (all sells, a huge one) that must not count.
  const tape = [
    ...Array.from({ length: 40 }, (_, i) => ({ seq: i, time: now - 40_000 + i * 1000, price: 22740, quantity: 75, buy: i % 4 !== 0 })),
    { seq: 100, time: now - 120_000, price: 22738, quantity: 1500, buy: true },
    { seq: 101, time: now - 200_000, price: 22739, quantity: 750, buy: false },
    { seq: 200, time: now + 5_000, price: 22700, quantity: 99_000, buy: false },
  ]
  const heatmap = [
    { t: now - 2000, bids: [[22735, 3000], [22700, 9000]], asks: [[22745, 1000]] },
    { t: now + 2000, bids: [], asks: [[22741, 99_000]] }, // after the clock: ignored
  ]
  const m = marketAt({ nowMs: now, price: 22740, bars, tapePrints: tape, oi: oiCtx(), heatmap, lotSize: 75, largeLots: 10 })
  assert.deepEqual(Object.keys(m).sort(), [...MARKET_KEYS].sort())
  assert.equal(m.tape30, 76, 'the last 30 s: 22 of 29 prints bought')
  assert.ok(m.tape60 > 50)
  assert.equal(m.bigCount, 2, 'only the big prints up to the clock, in the last 5 min')
  assert.equal(m.bigNet, 10, '+20 lots - 10 lots')
  assert.equal(m.cvd15, Math.round((15 * 800) / 75))
  assert.ok(m.volX > 1.3, `volume above the day's 15-min average: ${m.volX}`)
  assert.ok(m.futPx15 > 0.15 && m.futPx15 < 0.25, `futures +0.2% in 15 min, not the jump after the clock: ${m.futPx15}`)
  assert.ok(m.futOi15 > 0.8 && m.futOi15 < 1.2, `futures OI ~+1%: ${m.futOi15}`)
  assert.ok(m.writers15 > 0.5, `puts written near the money: ${m.writers15}`)
  assert.equal(m.bookImb, 0.5, 'bids 3000 vs asks 1000 within 0.15% of the price (the 22700 bid is too far)')
  assert.ok(Math.abs(m.vwapDist) < 0.01)
})

test('an estimated day (no tape, no book): those numbers are blank, never made up', () => {
  const now = at(50) + 30_000
  const bars = Array.from({ length: 50 }, (_, m) => ({ time: at(m), open: 22740, high: 22745, low: 22735, close: 22740, buy: 500, sell: 500, delta: 0 }))
  const m = marketAt({ nowMs: now, price: 22740, bars, tapePrints: null, oi: oiCtx(), heatmap: null, lotSize: 75, largeLots: 10 })
  assert.equal(m.tape30, null)
  assert.equal(m.bigNet, null)
  assert.equal(m.bigCount, null)
  assert.equal(m.bookImb, null)
  assert.ok(m.futOi15 != null && m.writers15 != null, 'the OI is still there')
})

test('the record a day posts carries each signal\'s market', () => {
  const market = { tape60: 70, bigNet: 5 }
  const body = scannerLogBody({ underlying: 'NIFTY', date: '2026-10-05', source: 'server', dayResults: [{ id: 'pocReject', t: at(50), side: 'LONG', entry: 1, stop: 0, target: 2, market, outcome: { status: 'open' } }], rows: [] })
  assert.deepEqual(body.signals[0].market, market)
})

test('the order-flow trade filters: each one on the market at the signal; off (the default) changes nothing', async () => {
  const { applyTradeFilter, strategyFilters, FLOW_FILTER_KEYS } = await import('../src/strategyEngine.js')
  const t = at(90)
  const setup = (side, market) => ({ id: 'trap', side, t, entry: 22700, stop: side === 'LONG' ? 22680 : 22720, target: side === 'LONG' ? 22740 : 22660, checks: {}, market })
  const f = (o) => ({ ...strategyFilters('trap', undefined), ...o })
  const withLong = { tape60: 62, bigNet: 15, bookImb: 0.2, cvd15: 300, volX: 1.5 }
  // Defaults: every one off - the setup goes through untouched.
  assert.ok(FLOW_FILTER_KEYS.every((k) => strategyFilters('trap', undefined)[k] === 'any'))
  assert.deepEqual(applyTradeFilter(setup('LONG', withLong), strategyFilters('trap', undefined)), setup('LONG', withLong))
  // Each filter: with the trade passes, against it blocks - for a LONG and the mirror SHORT.
  const against = { tape60: 38, bigNet: -15, bookImb: -0.2, cvd15: -300, volX: 0.7 }
  const mirror = (m) => ({ tape60: 100 - m.tape60, bigNet: -m.bigNet, bookImb: -m.bookImb, cvd15: -m.cvd15, volX: m.volX })
  for (const [key, mode] of [['tradeTape', 'with'], ['tradeTape', 'strong'], ['tradeBig', 'with'], ['tradeBook', 'with'], ['tradeCvd', 'with'], ['tradeVolume', 'above']]) {
    assert.ok(applyTradeFilter(setup('LONG', withLong), f({ [key]: mode })), `${key} ${mode}: LONG with it`)
    assert.equal(applyTradeFilter(setup('LONG', against), f({ [key]: mode })), null, `${key} ${mode}: LONG against it`)
    assert.ok(applyTradeFilter(setup('SHORT', mirror(withLong)), f({ [key]: mode })), `${key} ${mode}: SHORT with it`)
    assert.equal(applyTradeFilter(setup('SHORT', mirror(against)), f({ [key]: mode })), null, `${key} ${mode}: SHORT against it`)
  }
  // "Not against" lets a neutral reading through; "quiet" volume wants under the average.
  assert.ok(applyTradeFilter(setup('LONG', { tape60: 47, bigNet: 0, bookImb: -0.05 }), f({ tradeTape: 'notAgainst', tradeBig: 'notAgainst', tradeBook: 'notAgainst' })))
  assert.equal(applyTradeFilter(setup('LONG', { volX: 1.5 }), f({ tradeVolume: 'below' })), null)
  // Not there (an estimated day: no tape, no book) - the filter cannot judge, so the trade goes through.
  assert.ok(applyTradeFilter(setup('LONG', { tape60: null, bigNet: null, bookImb: null, cvd15: 100, volX: 1.3 }), f({ tradeTape: 'strong', tradeBig: 'with', tradeBook: 'with' })))
  assert.ok(applyTradeFilter(setup('LONG', undefined), f({ tradeTape: 'strong' })), 'no market at all: through')
})
