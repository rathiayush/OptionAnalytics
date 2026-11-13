import test from 'node:test'
import assert from 'node:assert/strict'
import { BIG_FACTOR, bookLadder, ladderRow, ladderRowAt, pulledByRow, tradedByRow } from '../src/bookLadder.js'

// The Order Flow page's "Chart and order book" card (asked for - "the liquidity heatmap on the futures chart, like the one
// I sent"): the book at the clock in rows of N points - waiting, bought / sold, pulled, the nearest big buyers / sellers.

const T = Date.parse('2026-11-13T05:00:00Z') // 10:30 IST
const S = 1000
const MIN = 60_000
const L = (p, q) => ({ price: p, quantity: q })

// A book around 25,103: bids from 25,103 down, offers from 25,104 up (1-point levels), a wall of bids at 25,100 - 25,104
// and of offers at 25,115 - 25,119.
function book() {
  const bids = []
  const asks = []
  for (let p = 25103; p >= 25050; p--) bids.push(L(p, p >= 25100 ? 2000 : 300))
  for (let p = 25104; p <= 25160; p++) asks.push(L(p, p >= 25115 && p < 25120 ? 2500 : 250))
  return { bids, asks }
}

test('the ladder row is a whole number of the columns\' rows', () => {
  assert.equal(ladderRow(5, 1), 5)
  assert.equal(ladderRow(5, 2), 6)
  assert.equal(ladderRow(2, 5), 5)
  assert.equal(ladderRow(10, 5), 10)
  assert.equal(ladderRow(5, 0.5), 5)
})

test('waiting: the book added up a row; big rows; the nearest big buyers under the price and sellers over it', () => {
  const l = bookLadder({ book: book(), columns: [], minuteBars: [], clockMs: T, row: 5, price: 25103.1 })
  const at = (p) => l.rows.find((r) => r.price === p)
  assert.equal(l.priceRow, 25100)
  assert.equal(at(25100).bid, 4 * 2000)          // 25,100 - 25,103
  assert.equal(at(25100).ask, 250, 'the best offer 25,104 sits in the price row')
  assert.equal(at(25095).bid, 5 * 300)
  assert.equal(at(25115).ask, 5 * 2500)
  assert.equal(at(25105).ask, 5 * 250)
  assert.ok(at(25100).bigBid && !at(25095).bigBid)
  assert.ok(at(25115).bigAsk && !at(25110).bigAsk)
  assert.deepEqual(l.buyers, { lo: 25100, hi: 25105, quantity: 8000, rows: 1, distance: 0 })
  assert.deepEqual(l.sellers, { lo: 25115, hi: 25120, quantity: 12500, rows: 1, distance: 11.9 })
  // Rows top to bottom; the bars scale on the rows near the price.
  assert.ok(l.rows[0].price > l.rows.at(-1).price)
  assert.equal(l.maxWaiting, 12500)
  assert.equal(ladderRowAt(l, 25117).price, 25115)
  assert.equal(ladderRowAt(l, 10), null)
})

test('adjacent big rows read as one zone; no big row = none', () => {
  const b = book()
  for (const lvl of b.bids) if (lvl.price >= 25090 && lvl.price < 25100) lvl.quantity = 2000
  const l = bookLadder({ book: b, columns: [], minuteBars: [], clockMs: T, row: 5, price: 25103 })
  assert.deepEqual(l.buyers, { lo: 25090, hi: 25105, quantity: 4 * 2000 + 10 * 2000, rows: 3, distance: 0 })
  const flat = { bids: [L(100, 10), L(99, 10), L(98, 10)], asks: [L(101, 10), L(102, 10), L(103, 10)] }
  const f = bookLadder({ book: flat, columns: [], minuteBars: [], clockMs: T, row: 1, price: 100.5 })
  assert.equal(f.buyers, null)
  assert.equal(f.sellers, null)
  assert.ok(BIG_FACTOR > 1)
})

// Book columns 2 s apart (1-point rows, [price, quantity]).
const col = (t, bids, asks) => ({ t, bids, asks })

test('pulled: a drop AWAY from the touch in both columns is cancelled; at the touch it may have traded; gaps and the window', () => {
  const cols = [
    col(T - 10 * S, [[25103, 100], [25101, 900], [25090, 400]], [[25104, 100], [25118, 1000]]),
    // 25,101 bids drop 600 (away from the 25,103 best bid) = pulled; the 25,103 best bid drops (at the touch) - not
    // counted; 25,118 offers drop 700 (away from 25,104) = pulled.
    col(T - 8 * S, [[25103, 20], [25101, 300], [25090, 400]], [[25104, 100], [25118, 300]]),
    // The best bid moves DOWN to 25,101: in this pair 25,101 is the touch - its drop is not counted.
    col(T - 6 * S, [[25101, 100], [25090, 400]], [[25104, 100], [25118, 300]]),
    // After a gap of over a minute nothing is compared.
    col(T - 6 * S + 61 * S, [[25101, 100]], [[25104, 100], [25118, 300]]),
  ]
  const clock = T + 55 * S
  const p = pulledByRow(cols, { clockMs: clock, windowMs: 5 * MIN, row: 5 })
  assert.equal(p.bids.get(25100), 600)
  assert.equal(p.asks.get(25115), 700)
  assert.equal(p.bids.get(25090), undefined, 'the 25,090 bids went across the gap - that step is not compared')
  assert.equal(p.bids.size, 1, 'nothing at the touch was counted')
  // Only steps inside the window: a window that starts after the drops sees none.
  assert.equal(pulledByRow(cols, { clockMs: clock, windowMs: 30 * S, row: 5 }).bids.size, 0)
  // Nothing after the clock: the same columns read at T - 9 s hold no step yet.
  assert.equal(pulledByRow(cols, { clockMs: T - 9 * S, windowMs: 5 * MIN, row: 5 }).bids.size, 0)
})

test('pulled: a level that fell off the far edge of the book as price moved is out of view, not cancelled', () => {
  // A 3-level book that moves up a point: 25,097 leaves the bottom of the bids, 25,107 joins the top of the offers.
  const a = col(T - 4 * S, [[25100, 100], [25099, 100], [25097, 500]], [[25101, 100], [25102, 100], [25104, 100]])
  const b = col(T - 2 * S, [[25101, 100], [25100, 100], [25099, 100]], [[25102, 100], [25104, 40], [25107, 100]])
  const p = pulledByRow([a, b], { clockMs: T, windowMs: MIN, row: 1 })
  assert.equal(p.bids.get(25097), undefined, 'below the newer book\'s deepest bid - not seen, not pulled')
  assert.equal(p.asks.get(25104), 60, 'inside the newer book and away from the touch - pulled')
})

test('bought / sold: the footprint minutes that overlap the window, up to the clock', () => {
  const bars = [
    { time: new Date(T - 7 * MIN).toISOString(), levels: [{ price: 25101, buy: 999, sell: 999 }] },   // before the window
    { time: new Date(T - 5 * MIN - 30 * S).toISOString(), levels: [{ price: 25101, buy: 10, sell: 0 }] }, // overlaps its start
    { time: new Date(T - 2 * MIN).toISOString(), levels: [{ price: 25101, buy: 50, sell: 70 }, { price: 25106, buy: 5, sell: 0 }] },
    { time: new Date(T).toISOString(), levels: [{ price: 25101, buy: 1, sell: 1 }] },                 // the clock's own minute
    { time: new Date(T + MIN).toISOString(), levels: [{ price: 25101, buy: 500, sell: 500 }] },        // after the clock
  ]
  const t = tradedByRow(bars, { clockMs: T, windowMs: 5 * MIN, row: 5 })
  assert.equal(t.bought.get(25100), 61)
  assert.equal(t.sold.get(25100), 71)
  assert.equal(t.bought.get(25105), 5)
  const l = bookLadder({ book: book(), columns: [], minuteBars: bars, clockMs: T, row: 5, price: 25103 })
  const r = l.rows.find((x) => x.price === 25100)
  assert.deepEqual([r.bought, r.sold], [61, 71])
  assert.equal(l.boughtQty, 66)
  assert.equal(l.maxTraded, 71)
})

test('nothing after the clock: columns and bars past it change nothing', () => {
  const cols = Array.from({ length: 60 }, (_, i) => col(T - 120 * S + i * 2 * S, [[25103, 100], [25095, 500 - i * 5]], [[25104, 100], [25120, 500 + (i % 3) * 50]]))
  const bars = Array.from({ length: 6 }, (_, i) => ({ time: new Date(T - 4 * MIN + i * MIN).toISOString(), levels: [{ price: 25103, buy: 10 + i, sell: 5 + i }] }))
  for (const clock of [T - 60 * S, T - 3 * S, T + 30 * S]) {
    const cut = { columns: cols.filter((c) => c.t <= clock), minuteBars: bars.filter((b) => Date.parse(b.time) <= clock) }
    const a = bookLadder({ book: book(), ...cut, clockMs: clock, row: 5, price: 25103, windowMin: 2 })
    const b = bookLadder({ book: book(), columns: cols, minuteBars: bars, clockMs: clock, row: 5, price: 25103, windowMin: 2 })
    assert.deepEqual(a, b, `clock ${clock}`)
  }
  // The steady drop at 25,095 (5 a step, away from the touch) over the last 2 minutes.
  const l = bookLadder({ book: book(), columns: cols, minuteBars: bars, clockMs: T, row: 5, price: 25103, windowMin: 2 })
  assert.equal(l.rows.find((r) => r.price === 25095).pulledBid, 5 * 59)
})

test('no price or no row = no ladder', () => {
  assert.equal(bookLadder({ book: book(), row: 5, price: 0, clockMs: T }), null)
  assert.equal(bookLadder({ book: book(), row: 0, price: 25103, clockMs: T }), null)
})
