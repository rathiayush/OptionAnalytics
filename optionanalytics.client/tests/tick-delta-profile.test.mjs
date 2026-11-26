import test from 'node:test'
import assert from 'node:assert/strict'
import { futuresDeltaRows, futuresRowsOf, optionProfiles, optionProfilesOf, priceAt, profileLevels, readOf, standouts } from '../src/tickDeltaProfile.js'

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

test('futures rows: buy - sell per price row in LOTS, regrouped to the row size, high to low', () => {
  const bars = [{ levels: [{ price: 101, buy: 500, sell: 100 }, { price: 100, buy: 200, sell: 600 }, { price: 99, buy: 100, sell: 0 }] }, { levels: [{ price: 100, buy: 400, sell: 0 }] }]
  const r = futuresRowsOf([{ bars, lotSize: 100 }], 1)
  assert.deepEqual(r.rows.map((x) => [x.price, x.delta, x.vol]), [[101, 4, 6], [100, 0, 12], [99, 1, 1]])
  assert.equal(r.net, 5)
  const two = futuresRowsOf([{ bars, lotSize: 100 }], 2)               // 101 and 100 share the 100 row, 99 is the 98 row
  assert.deepEqual(two.rows.map((x) => [x.price, x.delta]), [[100, 4], [98, 1]])
})

test('sessions add up row by row: the day and the sessions before it, each with its own futures price', () => {
  const day1 = { orders: [o(10, 'CE', 1, 10)], bars: [{ time: 0, close: 25012 }] }
  const day2 = { orders: [o(10, 'CE', 1, 5), o(20, 'PE', 1, 2)], bars: [{ time: 0, close: 25014 }] }
  const p = optionProfilesOf([day1, day2], 25)
  assert.equal(p.rows.length, 1)
  assert.equal(p.rows[0].price, 25000)
  assert.equal(p.rows[0].vol, 17)
  assert.equal(p.rows[0].net, 13)                                      // 10 + 5 call flow less 2 put flow
  assert.equal(optionProfilesOf([day1], 25).rows[0].vol, 10)
  assert.equal(cdvObvProfilesOf([day1, day2], 25, 'ce').rows[0].vol, 15)
})

test('profile levels: the POC and the 70% value area; standout rows by |value| on each side', () => {
  const rows = [{ price: 104, vol: 5 }, { price: 103, vol: 40 }, { price: 102, vol: 100 }, { price: 101, vol: 30 }, { price: 100, vol: 5 }]
  assert.deepEqual(profileLevels(rows), { poc: 102, vah: 103, val: 102 })
  assert.deepEqual(profileLevels([]), { poc: null, vah: null, val: null })
  const d = [{ price: 5, x: 9 }, { price: 4, x: 3 }, { price: 3, x: -7 }, { price: 2, x: -1 }]
  assert.deepEqual(standouts(d, 'x'), { b1: 5, b2: 4, s1: 3, s2: 2 })
  assert.deepEqual(standouts(d, 'x', true), { b1: 3, b2: 2, s1: 5, s2: 4 })   // the OI's CE - PE: negative is bullish
})

import { cdvObvProfiles, cdvObvProfilesOf } from '../src/tickDeltaProfile.js'

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


test('the footprint column\'s futures delta rows: buy - sell per price row in units, high to low', () => {
  const r = futuresDeltaRows([{ levels: [{ price: 101, buy: 5, sell: 1 }, { price: 100, buy: 2, sell: 6 }] }, { levels: [{ price: 100, buy: 4, sell: 0 }] }])
  assert.deepEqual(r.rows.map((x) => [x.price, x.delta]), [[101, 4], [100, 0]])
  assert.equal(r.net, 4)
})
