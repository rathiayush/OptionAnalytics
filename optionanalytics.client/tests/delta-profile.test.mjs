// The delta profiles (deltaProfile.js): the options' on the spot chart (each strike's bar-proxy delta weighted by its
// delta, laid on the spot rows of the minute), the futures' from the footprint - worked values, the sides, the POC /
// value area, and NO LOOK-AHEAD: a profile at a clock equals the one built only from the minutes up to it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { day as syntheticDay } from './synthetic-day.mjs'
import { barProxyDelta, deltaWeight } from '../src/optionFlow.js'
import { finishDeltaProfile, futuresDeltaProfile, optionDeltaProfile, rowAt } from '../src/deltaProfile.js'

const T = Date.parse('2026-10-05T04:00:00Z')      // 09:30 IST
const MIN = 60_000
const close = (a, b) => Math.abs(a - b) < 1e-9

test('options on the spot chart: a minute\'s weighted delta and volume spread over the spot rows it traded in', () => {
  // Spot traded 100 - 110 that minute: rows 100, 105, 110 (5-point rows).
  const spot = [{ time: T, open: 101, high: 110, low: 100, close: 108 }]
  // A CE closing at its high (all buying) and a PE closing at its low (all selling).
  const ce = [{ time: new Date(T).toISOString(), strike: 105, open: 2, high: 10, low: 0, price: 10, volume: 300 }]
  const pe = [{ time: new Date(T).toISOString(), strike: 105, open: 8, high: 10, low: 0, price: 0, volume: 120 }]
  const wc = deltaWeight(105, 108, true), wp = deltaWeight(105, 108, false)
  const ceDelta = barProxyDelta({ high: 10, low: 0, close: 10, volume: 300 }) * wc      // +300 x w
  const peDelta = barProxyDelta({ high: 10, low: 0, close: 0, volume: 120 }) * wp       // -120 x w
  const net = optionDeltaProfile(ce, pe, spot, { rowSize: 5 })
  assert.deepEqual(net.rows.map((r) => r.price), [100, 105, 110])
  for (const r of net.rows) {
    assert.ok(close(r.delta, (ceDelta - peDelta) / 3), `${r.price}: ${r.delta}`)   // calls bought + puts sold: bullish
    assert.ok(close(r.volume, (300 * wc + 120 * wp) / 3))
  }
  assert.ok(net.totals.net > 0 && close(net.totals.net, ceDelta - peDelta))
  // CE alone / PE alone: that side's own buying (+) or selling (-).
  const onlyCe = optionDeltaProfile(ce, pe, spot, { rowSize: 5, side: 'ce' })
  const onlyPe = optionDeltaProfile(ce, pe, spot, { rowSize: 5, side: 'pe' })
  assert.ok(onlyCe.rows.every((r) => close(r.delta, ceDelta / 3) && close(r.volume, (300 * wc) / 3)))
  assert.ok(onlyPe.rows.every((r) => close(r.delta, peDelta / 3) && r.delta < 0))
  // A minute the spot had no bar for: its last price, one row.
  const later = [{ ...ce[0], time: new Date(T + MIN).toISOString() }]
  const gap = optionDeltaProfile(later, [], spot, { rowSize: 5, side: 'ce' })
  assert.deepEqual(gap.rows.map((r) => r.price), [105])
  // No spot known yet: nothing to lay it on.
  assert.equal(optionDeltaProfile(ce, pe, [], { rowSize: 5 }).rows.length, 0)
})

test('the POC, the value area, the largest bars, the row under the crosshair', () => {
  const p = finishDeltaProfile([
    { price: 100, volume: 10, delta: -4 }, { price: 105, volume: 50, delta: 12 }, { price: 110, volume: 30, delta: -20 },
    { price: 115, volume: 5, delta: 1 }, { price: 120, volume: 0, delta: 0 },
  ], 5)
  assert.deepEqual(p.rows.map((r) => r.price), [100, 105, 110, 115])        // an empty row left out
  assert.equal(p.poc, 105)
  // The value area as every profile in the app reads it: two rows at a time from the POC (30 + 5 above beat 10 below).
  assert.deepEqual([p.val, p.vah], [105, 115])
  assert.deepEqual([p.maxVolume, p.maxAbsDelta, p.volume, p.delta], [50, 20, 95, -11])
  assert.equal(rowAt(p, 112.4).price, 110)
  assert.equal(rowAt(p, 99), null)
  assert.equal(finishDeltaProfile([], 5).poc, null)
})

test('the futures: the footprint\'s buy and sell at each price, regrouped into rows; estimated minutes counted', () => {
  const bar = (k, levels, extra = {}) => ({ time: new Date(T + k * MIN).toISOString(), open: 0, high: 0, low: 0, close: 0, levels, ...extra })
  const bars = [
    bar(0, [{ price: 25001, buy: 100, sell: 40 }, { price: 25003, buy: 10, sell: 70 }]),
    bar(1, [{ price: 25006, buy: 0, sell: 90 }, { price: 25004, buy: 30, sell: 30 }]),
    bar(2, [{ price: 25012, buy: 500, sell: 0 }], { estimated: true }),
  ]
  const p = futuresDeltaProfile(bars, { rowSize: 5 })
  assert.deepEqual(p.rows.map((r) => [r.price, r.buy, r.sell, r.delta]), [[25000, 140, 140, 0], [25005, 0, 90, -90], [25010, 500, 0, 500]])
  assert.deepEqual([p.minutes, p.estimatedMinutes, p.poc], [3, 1, 25010])
  // At the second minute's clock: the third (later) not counted.
  const cut = futuresDeltaProfile(bars, { rowSize: 5, asOfMs: T + MIN + 30_000 })
  assert.deepEqual(cut.rows.map((r) => [r.price, r.delta]), [[25000, 0], [25005, -90]])
  assert.equal(cut.estimatedMinutes, 0)
})

test('NO LOOK-AHEAD: the options\' profile at a clock = the one built from the minutes up to it only', () => {
  const { run } = syntheticDay()
  const spot = run.spotCandlesOneMinute.map((b) => ({ time: Date.parse(b.time), open: b.open, high: b.high, low: b.low, close: b.close }))
  // Give the option bars a range and volume (the synthetic chain has prices only).
  const withBars = (list) => list.map((p, k) => ({ ...p, open: p.price * 0.99, high: p.price * 1.02, low: p.price * 0.97, volume: 50 + (k % 7) * 10 }))
  const ce = withBars(run.cePoints), pe = withBars(run.pePoints)
  const full = optionDeltaProfile(ce, pe, spot, { rowSize: 5 })
  assert.ok(full.rows.length > 5 && full.minutes > 200)
  for (const k of [10, 90, 180]) {
    const clock = spot[k].time
    const keep = (list) => list.filter((p) => Date.parse(p.time) <= clock)
    for (const side of ['net', 'ce', 'pe']) {
      const atClock = optionDeltaProfile(ce, pe, spot, { rowSize: 5, side, asOfMs: clock + 40_000 })
      const cutDay = optionDeltaProfile(keep(ce), keep(pe), spot.filter((b) => b.time <= clock), { rowSize: 5, side })
      assert.deepEqual(atClock, cutDay, `${side} at minute ${k}`)
    }
  }
})
