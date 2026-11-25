import test from 'node:test'
import assert from 'node:assert/strict'
import { futuresDeltaRows, optionProfiles, priceAt, readOf } from '../src/tickDeltaProfile.js'

const M = 60_000
const bars = [{ time: 0, close: 24_003 }, { time: M, close: 24_012 }, { time: 2 * M, close: 24_026 }]
const o = (t, type, side, lots, oiChange = 0) => ({ t, type, side, lots, oiChange, lotSize: 75 })

test('price at an order is the last bar at or before it', () => {
  assert.equal(priceAt(bars, 30_000), 24_003)
  assert.equal(priceAt(bars, M), 24_012)
  assert.equal(priceAt(bars, -5), 24_003)
  assert.equal(priceAt([], 1), null)
})

test('net = calls flow less puts flow (+ bullish), OI = call OI less put OI (lots), total = OI less the scaled net', () => {
  const p = optionProfiles([o(10, 'CE', 1, 100), o(20, 'PE', -1, 40), o(M + 5, 'PE', 1, 30, 75 * 20), o(M + 9, 'CE', 1, 10, 75 * 5)], bars, 10)
  const low = p.rows.find((r) => r.price === 24_000)
  assert.equal(low.net, 100 - -40)             // call bought 100, put sold 40: both bullish
  const hi = p.rows.find((r) => r.price === 24_010)
  assert.equal(hi.net, 10 - 30)                // call bought 10, put bought 30
  assert.equal(hi.oi, 5 - 20)                  // call OI +5 lots, put OI +20 lots: puts added = negative = bullish
  assert.equal(p.rows[0].price, 24_010)        // high to low
  assert.equal(p.count, 4)
  assert.equal(low.total, low.oi - low.net * p.scale)
  assert.equal(readOf('net', 20), 'bullish'); assert.equal(readOf('oi', -3), 'bullish'); assert.equal(readOf('total', 4), 'bearish')
})

test('an order with no futures price or no size is left out; the scale is 1 with no flow or OI', () => {
  assert.equal(optionProfiles([o(1, 'CE', 1, 10)], [], 10).rows.length, 0)
  assert.equal(optionProfiles([o(1, 'CE', 1, 0)], bars, 10).rows.length, 0)
  assert.equal(optionProfiles([o(1, 'CE', 1, 10)], bars, 10).scale, 1)
})

test('a cut at the clock is the whole day up to it', () => {
  const all = [o(10, 'CE', 1, 10, 75), o(M + 1, 'PE', -1, 5, 75), o(2 * M + 1, 'CE', -1, 7)]
  const cut = optionProfiles(all.filter((x) => x.t <= M + 1), bars, 10)
  const upTo = optionProfiles(all.slice(0, 2), bars, 10)
  assert.deepEqual(cut, upTo)
})

test('futures delta rows: buy - sell per price row, high to low', () => {
  const r = futuresDeltaRows([{ levels: [{ price: 101, buy: 5, sell: 1 }, { price: 100, buy: 2, sell: 6 }] }, { levels: [{ price: 100, buy: 4, sell: 0 }] }])
  assert.deepEqual(r.rows.map((x) => [x.price, x.delta]), [[101, 4], [100, 0]])
  assert.equal(r.net, 4)
})

import { cdvObvProfiles, cumulativeSeries } from '../src/tickDeltaProfile.js'

test('CDV is the aggressor delta, OBV the premium move\'s sign x lots; net flips a put', () => {
  const orders = [
    { ...o(10, 'CE', 1, 10), movePct: 2 },
    { ...o(20, 'PE', 1, 4), movePct: 1.5 },      // put bought, premium up: bearish in net
    { ...o(30, 'CE', -1, 6), movePct: -1 },      // call sold, premium down
    { ...o(40, 'CE', 1, 3), movePct: 0 },        // no premium move: OBV 0
  ]
  const net = cdvObvProfiles(orders, bars, 10, 'net')
  assert.equal(net.rows.length, 1)
  assert.equal(net.cdv, 10 - 4 - 6 + 3)
  assert.equal(net.obv, 10 - 4 - 6 + 0)
  const ce = cdvObvProfiles(orders, bars, 10, 'ce')
  assert.equal(ce.cdv, 10 - 6 + 3)
  assert.equal(ce.count, 3)
  assert.equal(cdvObvProfiles(orders, bars, 10, 'pe').obv, 4)
})

test('cumulative series: futures delta in lots, option net flow and OI (CE - PE) up to each minute\'s end, no look-ahead', () => {
  const fb = [{ time: 0, buy: 750, sell: 150 }, { time: M, buy: 0, sell: 300 }, { time: 2 * M, buy: 75, sell: 0 }]
  const orders = [o(10, 'CE', 1, 10, 75 * 2), o(M + 5, 'PE', -1, 3, 75 * 4), o(2 * M + 1, 'CE', -1, 5)]
  const s = cumulativeSeries(orders, fb, 75)
  assert.deepEqual(s.map((p) => p.fut), [8, 4, 5])
  assert.deepEqual(s.map((p) => p.net), [10, 13, 8])      // call bought +10; put sold = +3; call sold -5
  assert.deepEqual(s.map((p) => p.oi), [2, -2, -2])       // call OI +2 lots; put OI +4 lots = -4
  assert.deepEqual(cumulativeSeries(orders.filter((x) => x.t < M), fb.slice(0, 1), 75), s.slice(0, 1))
})
