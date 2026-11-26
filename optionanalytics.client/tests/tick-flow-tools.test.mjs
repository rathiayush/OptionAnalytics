// The Tick Flow tools (tickFlowTools.js): VWAP, volume profile, auctions, stacked imbalances, COT and its read, absorption / exhaustion, icebergs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { absorptionExhaustion, auctionOf, barVwaps, cotOfBars, cotRead, icebergs, stackedImbalances, unfinishedAuctions, volumeProfile } from '../src/tickFlowTools.js'

const T0 = Date.parse('2026-11-24T03:45:00Z')
const bar = (i, levels, over = {}) => {
  const buy = levels.reduce((a, l) => a + l.buy, 0)
  const sell = levels.reduce((a, l) => a + l.sell, 0)
  const prices = levels.map((l) => l.price)
  return { time: T0 + i * 60_000, ms: T0 + i * 60_000, open: prices.at(-1), high: Math.max(...prices), low: Math.min(...prices), close: prices[0], buy, sell, levels, ...over }
}

test('the VWAP is the running price x quantity over the quantity', () => {
  const bars = [bar(0, [{ price: 100, buy: 10, sell: 10 }]), bar(1, [{ price: 110, buy: 20, sell: 20 }])]
  const v = barVwaps(bars)
  assert.equal(v[0], 100)
  assert.equal(v[1], (100 * 20 + 110 * 40) / 60)
  assert.equal(barVwaps([bar(0, [{ price: 100, buy: 5, sell: 5 }])], 2)[0], 101)
  assert.equal(barVwaps([{ levels: [] }])[0], null)
})

test('the volume profile: the POC and the 70% value area around it', () => {
  const p = volumeProfile([bar(0, [
    { price: 105, buy: 5, sell: 5 }, { price: 104, buy: 10, sell: 10 }, { price: 103, buy: 40, sell: 40 }, { price: 102, buy: 10, sell: 10 }, { price: 101, buy: 5, sell: 5 },
  ])])
  assert.equal(p.poc, 103)
  assert.equal(p.total, 140)
  // 80 + 20 = 100 of 140 = 71% >= 70%: the busier neighbour (104 ties with 102 - the higher goes first), then the other.
  assert.equal(p.vah, 104)
  assert.ok(p.val <= 103 && p.val >= 102)
  assert.equal(volumeProfile([]).poc, null)
})

test('auctions: no selling at the top / no buying at the bottom is finished; both sides there is unfinished, until a later bar trades back in', () => {
  const a = auctionOf(bar(0, [{ price: 105, buy: 7, sell: 0 }, { price: 104, buy: 5, sell: 5 }, { price: 103, buy: 4, sell: 4 }]))
  assert.deepEqual(a, { high: 'finished', low: 'unfinished' })
  assert.deepEqual(auctionOf(bar(0, [{ price: 105, buy: 3, sell: 2 }, { price: 104, buy: 0, sell: 6 }])), { high: 'unfinished', low: 'finished' })
  assert.deepEqual(auctionOf({ levels: [] }), { high: null, low: null })
  const bars = [
    bar(0, [{ price: 105, buy: 3, sell: 2 }, { price: 104, buy: 4, sell: 4 }]),
    bar(1, [{ price: 103, buy: 4, sell: 4 }, { price: 102, buy: 4, sell: 4 }]),
    bar(2, [{ price: 105, buy: 1, sell: 1 }, { price: 104, buy: 1, sell: 1 }]),
  ]
  const u = unfinishedAuctions(bars)
  const hi = u.find((x) => x.index === 0 && x.side === 'high')
  assert.equal(hi.price, 105)
  assert.equal(hi.until, 2)
  assert.equal(u.find((x) => x.index === 0 && x.side === 'low').until, 2)   // bar 0's low row is 104 - bar 2 trades there
})

test('stacked imbalances: three adjacent diagonal imbalances', () => {
  // Buyers at 103, 102, 101 each 5x the sellers one row below: a buy stack of three.
  const levels = [
    { price: 104, buy: 1, sell: 1 }, { price: 103, buy: 50, sell: 1 }, { price: 102, buy: 50, sell: 5 }, { price: 101, buy: 50, sell: 5 }, { price: 100, buy: 1, sell: 5 },
  ]
  const s = stackedImbalances(levels, 1, 3, 3)
  assert.equal(s.buy.length, 1)
  assert.deepEqual([s.buy[0].from, s.buy[0].to, s.buy[0].rows], [103, 101, 3])
  assert.equal(stackedImbalances(levels, 1, 3, 4).buy.length, 0)
})

test('COT: the delta after the last new high / low, a new extreme starts it at 0', () => {
  const t = (s) => T0 + s * 1000
  const bubbles = [
    { ms: t(1), price: 100, qty: 10, buy: true },    // high 100, low 100
    { ms: t(2), price: 101, qty: 5, buy: true },     // new high: cH 0
    { ms: t(3), price: 101, qty: 8, buy: false },    // cH -8
    { ms: t(4), price: 100, qty: 4, buy: false },    // cH -12 ; low equal: cL counts (not new): cL += -4 ... after the first print cL 0, then -? see below
    { ms: t(5), price: 99, qty: 6, buy: false },     // new low: cL 0 (cH -18)
    { ms: t(6), price: 100, qty: 9, buy: true },     // cH -9, cL +9
  ]
  const [c] = cotOfBars([bar(0, [{ price: 101, buy: 1, sell: 1 }])], bubbles)
  assert.equal(c.high, -9)
  assert.equal(c.low, 9)
  assert.equal(cotOfBars([bar(5, [{ price: 101, buy: 1, sell: 1 }])], bubbles)[0], null)
})

test('the COT read: rejected / trapped / still pushing, only at >= 20% of the volume', () => {
  const b = (close) => ({ high: 110, low: 100, close, buy: 50, sell: 50 })
  assert.equal(cotRead(b(102), { high: -30, low: 0 }).kind, 'rejected')
  assert.equal(cotRead(b(102), { high: -30, low: 0 }).side, -1)
  assert.equal(cotRead(b(102), { high: 30, low: 0 }).kind, 'buyers trapped')
  assert.equal(cotRead(b(109), { high: 30, low: 0 }).kind, 'still pushing')
  assert.equal(cotRead(b(109), { high: 30, low: 0 }).side, 1)
  assert.equal(cotRead(b(108), { low: 40, high: 0 }).kind, 'rejected')   // the low's mirror
  assert.equal(cotRead(b(108), { low: 40, high: 0 }).side, 1)
  assert.equal(cotRead(b(102), { high: -10, low: 0 }), null)             // under 20% of 100
  assert.equal(cotRead(b(102), null), null)
})

test('absorption: sellers pile in at the low and the bar still closes well up', () => {
  const calm = (i) => bar(i, [{ price: 110, buy: 10, sell: 10 }, { price: 109, buy: 10, sell: 10 }, { price: 108, buy: 10, sell: 10 }, { price: 107, buy: 10, sell: 10 }], { open: 108, close: 109 })
  const heavy = bar(4, [
    { price: 110, buy: 10, sell: 5 }, { price: 109, buy: 12, sell: 6 }, { price: 108, buy: 10, sell: 12 }, { price: 107, buy: 8, sell: 40 }, { price: 106, buy: 5, sell: 60 },
  ], { open: 109, close: 109.6, high: 110.9, low: 106 })
  const marks = absorptionExhaustion([calm(0), calm(1), calm(2), calm(3), heavy], { minScore: 40 })
  const m = marks.find((x) => x.kind === 'ABS' && x.index === 4)
  assert.ok(m, 'an absorption mark on the heavy bar')
  assert.equal(m.side, 1)
  assert.ok(m.score >= 40 && m.score <= 100)
  assert.equal(m.status, 'pending')
  assert.equal(absorptionExhaustion([calm(0), calm(1)]).length, 0)   // too few bars to know a usual one
})

test('a mark is confirmed by a later close past the signal bar, failed by a later trade past its far edge', () => {
  const calm = (i) => bar(i, [{ price: 110, buy: 10, sell: 10 }, { price: 109, buy: 10, sell: 10 }, { price: 108, buy: 10, sell: 10 }, { price: 107, buy: 10, sell: 10 }], { open: 108, close: 109 })
  const heavy = bar(4, [
    { price: 110, buy: 10, sell: 5 }, { price: 109, buy: 12, sell: 6 }, { price: 108, buy: 10, sell: 12 }, { price: 107, buy: 8, sell: 40 }, { price: 106, buy: 5, sell: 60 },
  ], { open: 109, close: 109.6, high: 110.9, low: 106 })
  const up = bar(5, [{ price: 112, buy: 9, sell: 3 }, { price: 111, buy: 9, sell: 3 }], { open: 111, close: 112, high: 112, low: 111 })
  const down = bar(5, [{ price: 106, buy: 3, sell: 9 }, { price: 105, buy: 3, sell: 9 }], { open: 106, close: 105, high: 106, low: 105 })
  const a = absorptionExhaustion([calm(0), calm(1), calm(2), calm(3), heavy, up], { minScore: 40 }).find((x) => x.index === 4 && x.kind === 'ABS')
  const f = absorptionExhaustion([calm(0), calm(1), calm(2), calm(3), heavy, down], { minScore: 40 }).find((x) => x.index === 4 && x.kind === 'ABS')
  assert.equal(a.status, 'confirmed')
  assert.equal(f.status, 'failed')
})

test('an iceberg: one price traded again and again while the best quote keeps refilling', () => {
  const t = (s) => T0 + s * 1000
  const bubbles = [1, 4, 7, 10, 13].map((s) => ({ ms: t(s), price: 100, qty: 650, buy: true, prints: 1 }))   // 5 x 10 lots at the ask 100
  const quotes = [
    { ms: t(0), ask: 100, askQty: 130 }, { ms: t(2), ask: 100, askQty: 65 }, { ms: t(3), ask: 100, askQty: 130 }, { ms: t(5), ask: 100, askQty: 65 },
    { ms: t(6), ask: 100, askQty: 130 }, { ms: t(8), ask: 100, askQty: 65 }, { ms: t(9), ask: 100, askQty: 130 },
  ]
  const r = icebergs(bubbles, quotes, { lotSize: 65, minLots: 20 })
  assert.equal(r.length, 1)
  assert.equal(r[0].price, 100)
  assert.equal(r[0].buy, true)
  assert.equal(r[0].lots, 50)
  assert.equal(r[0].shown, 130)
  assert.ok(r[0].refills >= 2)
  // No refills (the quote never came back) = not an iceberg; and too few lots = not one either.
  assert.equal(icebergs(bubbles, [{ ms: t(0), ask: 100, askQty: 130 }], { lotSize: 65, minLots: 20 }).length, 0)
  assert.equal(icebergs(bubbles, quotes, { lotSize: 65, minLots: 80 }).length, 0)
  // A sell is read on the bid.
  const sells = bubbles.map((b) => ({ ...b, buy: false }))
  const bids = quotes.map((x) => ({ ms: x.ms, bid: x.ask, bidQty: x.askQty }))
  assert.equal(icebergs(sells, bids, { lotSize: 65, minLots: 20 }).length, 1)
})
