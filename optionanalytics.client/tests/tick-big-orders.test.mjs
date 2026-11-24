// The Tick Flow page's big option orders (tickBigOrders.js): a server event read as an order (side, position, bias), kept by sequence,
// filtered by size and the option's own usual, sweeps over the strikes, and the added-up summary - the words are OI Replay's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addOrders, bigEnough, hitText, sizeText, toOrder, bigTradesSummary, MAX_KEPT } from '../src/tickBigOrders.js'

const T0 = Date.parse('2026-11-24T04:30:00Z')
const ev = (seq, over = {}) => ({
  seq, time: new Date(T0 + seq * 1000).toISOString(), symbol: 'NIFTY26120125000CE', strike: 25000, type: 'CE', qty: 65 * 40, lots: 40, price: 100.5, buy: true,
  value: 100.5 * 65 * 40, ratio: 12, touchRatio: 2, through: false, bundled: false, oiChange: 650, movePct: 0.5, atmDistance: 0, lotSize: 65, ...over,
})

test('an order is read with the page\'s words: side x OI = position, and its bias for the index', () => {
  const buy = toOrder(ev(1))
  assert.equal(buy.side, 1); assert.equal(buy.read, 'long build-up'); assert.equal(buy.bias, 1)
  assert.equal(buy.t, T0 + 1000)
  const writer = toOrder(ev(2, { buy: false }))                 // a call sold with OI up: writers - bearish
  assert.equal(writer.read, 'short build-up'); assert.equal(writer.bias, -1)
  const put = toOrder(ev(3, { type: 'PE', buy: true }))          // a put bought: bearish
  assert.equal(put.bias, -1)
  const noOi = toOrder(ev(4, { oiChange: null }))
  assert.equal(noOi.read, 'bought'); assert.equal(noOi.bias, 0.5)
  assert.equal(toOrder(ev(5, { buy: true, oiChange: -650 })).read, 'short covering')
})

test('orders are kept by sequence - a repeat adds nothing - and capped at the newest', () => {
  let kept = addOrders([], [ev(1), ev(2)])
  assert.deepEqual(kept.map((o) => o.seq), [1, 2])
  assert.equal(addOrders(kept, [ev(2), ev(1)]), kept)            // already seen: the same array
  kept = addOrders(kept, [ev(2), ev(3)])
  assert.deepEqual(kept.map((o) => o.seq), [1, 2, 3])
  const many = addOrders([], Array.from({ length: MAX_KEPT + 50 }, (_, i) => ev(i + 1)))
  assert.equal(many.length, MAX_KEPT); assert.equal(many[0].seq, 51)
})

test('the filters: lots, and the option\'s own usual once it has one (0 = none yet)', () => {
  const orders = [ev(1, { lots: 40, ratio: 12 }), ev(2, { lots: 20, ratio: 12 }), ev(3, { lots: 40, ratio: 1.5 }), ev(4, { lots: 40, ratio: 0 })].map(toOrder)
  assert.deepEqual(bigEnough(orders, { minLots: 30, multiple: 3 }).map((o) => o.seq), [1, 4])
  assert.deepEqual(bigEnough(orders, { minLots: 10, multiple: 1 }).map((o) => o.seq), [1, 2, 3, 4])
})

test('a sweep: the same kind at three strikes within three minutes - and the summary adds the money up', () => {
  const orders = addOrders([], [ev(1, { strike: 25000 }), ev(20, { strike: 25050 }), ev(40, { strike: 25100 }), ev(60, { strike: 24900, type: 'PE', buy: false, oiChange: 650 })])
  const big = bigEnough(orders, { minLots: 30, multiple: 3 })
  assert.equal(big.filter((o) => o.sweep).length, 3)             // the three calls bought
  assert.ok(!big.find((o) => o.type === 'PE').sweep)
  const s = bigTradesSummary(big, T0 + 90_000, 15)
  assert.equal(s.kinds.ceBought.count, 3)
  assert.equal(s.kinds.peWritten.count, 1)                       // a put sold with OI up: written
  assert.equal(s.lean, 'bullish')                                // calls bought and a put written - both bullish
  assert.equal(s.net, 1)
})

test('how it hit the book, in words', () => {
  assert.equal(hitText(toOrder(ev(1, { through: true, touchRatio: 2.3 }))), 'swept · 2.3× the touch')
  assert.equal(hitText(toOrder(ev(1, { through: true, touchRatio: 0.4 }))), 'through the touch')
  assert.equal(hitText(toOrder(ev(1, { through: false, touchRatio: 1.5 }))), '1.5× the touch')
  assert.equal(hitText(toOrder(ev(1, { through: false, touchRatio: 0.25 }))), '25% of the touch')
  assert.equal(hitText(toOrder(ev(1, { touchRatio: 0 }))), '—')
})

test('the quantity the user defines: units instead of lots, and no "x usual" test when the size alone should decide', () => {
  const orders = [ev(1, { qty: 3250, lots: 50, ratio: 1.2 }), ev(2, { qty: 1300, lots: 20, ratio: 9 }), ev(3, { qty: 6500, lots: 100, ratio: 0 })].map(toOrder)
  assert.deepEqual(bigEnough(orders, { minQty: 3000, multiple: 0 }).map((o) => o.seq), [1, 3])         // by units, the usual not asked
  assert.deepEqual(bigEnough(orders, { minQty: 3000, multiple: 3 }).map((o) => o.seq), [3])            // with it, order 1 (1.2x) drops
  assert.deepEqual(bigEnough(orders, { minLots: 20, multiple: 0 }).map((o) => o.seq), [1, 2, 3])
  assert.equal(sizeText(orders[0], 'lots'), '50 L')
  assert.equal(sizeText(orders[0], 'qty'), '3,250')
})

test('a busy stream stays cheap: thousands of orders are swept and filtered in well under a second', () => {
  const many = Array.from({ length: 4000 }, (_, i) => ev(i + 1, { time: new Date(T0 + i * 2000).toISOString(), strike: 25000 + (i % 21) * 50, buy: i % 3 !== 0 }))
  const t = Date.now()
  const kept = addOrders([], many)
  const big = bigEnough(kept, { minLots: 30, multiple: 0 })
  for (let i = 0; i < 20; i++) bigEnough(kept, { minLots: 30, multiple: 3 })    // the page re-filters on every poll and every change of a box
  assert.equal(kept.length, MAX_KEPT)
  assert.ok(big.length > 0)
  assert.ok(Date.now() - t < 1500, `took ${Date.now() - t} ms`)
})

import { ordersOfDay, ordersUpTo } from '../src/tickBigOrders.js'
test('a whole replayed day: oldest first, none dropped past the live cap, cut at the clock', () => {
  const t0 = Date.parse('2026-11-23T04:00:00Z')
  const events = Array.from({ length: 2500 }, (_, i) => ({ seq: 2500 - i, time: new Date(t0 + (2499 - i) * 1000).toISOString(), strike: 25000, type: 'CE', buy: true, qty: 3000, lots: 46, price: 100, value: 3e5, ratio: 4, oiChange: 10, lotSize: 65, atmDistance: 0, movePct: 0, touchRatio: 1, through: false, bundled: false, symbol: 'X' }))
  const day = ordersOfDay(events)
  assert.equal(day.length, 2500)
  assert.ok(day.every((o, i) => i === 0 || day[i - 1].t <= o.t))
  assert.equal(ordersUpTo(day, t0 + 9_000).length, 10)
  assert.equal(ordersUpTo(day, null).length, 2500)
})

test('the card filters: calls / puts, buyers / sellers, far out-of-the-money hedges and a price under X', async () => {
  const { filterBigOrders } = await import('../src/tickBigOrders.js')
  const o = (type, atmDistance, side, price) => ({ type, atmDistance, side, price })
  const list = [o('CE', 6, 1, 3), o('PE', -7, -1, 40), o('CE', 1, 1, 120), o('PE', 4, -1, 200)]
  assert.equal(filterBigOrders(list).length, 4)
  assert.deepEqual(filterBigOrders(list, { type: 'puts' }), [list[1], list[3]])
  assert.deepEqual(filterBigOrders(list, { side: 'buy' }), [list[0], list[2]])
  assert.deepEqual(filterBigOrders(list, { hideFarOtm: 5 }), [list[2], list[3]])
  assert.deepEqual(filterBigOrders(list, { onlyFarOtm: 5 }), [list[0], list[1]])
  assert.deepEqual(filterBigOrders(list, { cheapBelow: 50 }), [list[2], list[3]])
  assert.deepEqual(filterBigOrders(list, { type: 'puts', side: 'sell', hideFarOtm: 5 }), [list[3]])
})
