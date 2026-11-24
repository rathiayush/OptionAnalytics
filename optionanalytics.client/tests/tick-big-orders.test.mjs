// The Tick Flow page's big option orders (tickBigOrders.js): a server event read as an order (side, position, bias), kept by sequence,
// filtered by size and the option's own usual, sweeps over the strikes, and the added-up summary - the words are OI Replay's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addOrders, bigEnough, hitText, toOrder, bigTradesSummary, MAX_KEPT } from '../src/tickBigOrders.js'

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
