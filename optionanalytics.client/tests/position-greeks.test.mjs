// The order panel's position Greeks (positionGreeks.js): each leg's delta / gamma / theta / vega checked against the price's
// own slopes, a book added up per index with its notional, the intrinsic fallback, a straddle's delta near zero, the limit
// and what one more order changes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { black76, bookGreeks, deltaBreaches, legGreeks, orderDeltaChange, yearsToExpiry } from '../src/positionGreeks.js'

const AT = Date.parse('2026-11-17T10:00:00+05:30')
const EXPIRY = '2026-11-20'
const T = yearsToExpiry(EXPIRY, AT)

test('years to 15:30 IST on the expiry day; none without one, 0 past it', () => {
  assert.ok(Math.abs(T - (3 * 86400000 + 5.5 * 3600000) / (365 * 86400000)) < 1e-12)
  assert.equal(yearsToExpiry(null, AT), null)
  assert.equal(yearsToExpiry('2026-11-16', AT), 0)
})

test("a leg's Greeks are the slopes of its own price - the IV read back from its premium", () => {
  const S = 25000, K = 25100, sigma = 0.13
  for (const side of ['CE', 'PE']) {
    const call = side === 'CE'
    const mark = black76(call, S, K, sigma, T)
    const g = legGreeks({ side, strike: K, spot: S, expiry: EXPIRY, mark }, AT)
    assert.ok(Math.abs(g.iv - sigma) < 1e-5)
    const h = 1
    const up = black76(call, S + h, K, sigma, T), down = black76(call, S - h, K, sigma, T)
    assert.ok(Math.abs(g.delta - (up - down) / (2 * h)) < 1e-4, `${side} delta ${g.delta}`)
    assert.ok(Math.abs(g.gamma - (up - 2 * mark + down) / (h * h)) < 1e-5, `${side} gamma`)
    assert.ok(Math.abs(g.vega - (black76(call, S, K, sigma + 0.01, T) - mark)) < 1e-9)
    assert.ok(g.theta < 0, 'a long option loses a day of time value')
  }
  // Below intrinsic: no IV - counted as intrinsic.
  const deep = legGreeks({ side: 'CE', strike: 24000, spot: 25000, expiry: EXPIRY, mark: 990 }, AT)
  assert.deepEqual([deep.intrinsic, deep.delta, deep.gamma], [true, 1, 0])
  assert.equal(legGreeks({ side: 'CE', strike: 25000, spot: null, expiry: EXPIRY, mark: 100 }, AT), null)
  assert.equal(legGreeks({ side: 'CE', strike: 25000, spot: 25000, expiry: null, mark: 100 }, AT), null)
})

const leg = (id, side, strike, units, { u = 'NIFTY', spot = 25000, lotSize = 65, sigma = 0.13 } = {}) => ({
  id, underlying: u, side, strike, units, lotSize, spot, expiry: EXPIRY, mark: black76(side === 'CE', spot, strike, sigma, T),
})

test('a book per index: delta in units / lots, its notional, gamma per 1%, theta, vega; a sold straddle is short gamma and earns theta', () => {
  const book = bookGreeks([leg('a', 'CE', 25000, -65), leg('b', 'PE', 25000, -65), leg('c', 'CE', 82000, 20, { u: 'SENSEX', spot: 82000, lotSize: 20 })], AT)
  const nifty = book.byIndex.find((s) => s.underlying === 'NIFTY')
  const ce = legGreeks(leg('a', 'CE', 25000, 1), AT), pe = legGreeks(leg('b', 'PE', 25000, 1), AT)
  assert.ok(Math.abs(nifty.delta - -65 * (ce.delta + pe.delta)) < 1e-9)
  assert.ok(Math.abs(nifty.deltaLots) < 0.15, 'an ATM straddle is near delta neutral')
  assert.ok(Math.abs(nifty.notional - nifty.delta * 25000) < 1e-6)
  assert.ok(nifty.gammaPct < 0 && nifty.theta > 0 && nifty.vega < 0)
  assert.ok(Math.abs(nifty.gammaPct - -65 * (ce.gamma + pe.gamma) * 250 * 25000) < 1e-6)
  // ±1% P&L from delta and gamma: a short straddle loses either way.
  assert.ok(nifty.pnlUp < 0 && nifty.pnlDown < 0)
  const sensex = book.byIndex.find((s) => s.underlying === 'SENSEX')
  assert.ok(sensex.deltaLots > 0.4 && sensex.deltaLots < 0.6)
  assert.ok(Math.abs(book.total.notional - (nifty.notional + sensex.notional)) < 1e-6)
  assert.equal(book.total.legs, 3)
  // A leg with no spot is listed as missing, the rest still added up.
  const partial = bookGreeks([leg('a', 'CE', 25000, 65), { ...leg('x', 'CE', 25000, 65), spot: null }], AT)
  assert.equal(partial.byIndex[0].missing, 1)
  assert.equal(partial.byIndex[0].legs, 1)
})

test('the limit and what one more order changes', () => {
  const legs = [leg('a', 'CE', 24900, 65 * 3)]
  const book = bookGreeks(legs, AT)
  const lotsNow = book.byIndex[0].deltaLots
  assert.ok(lotsNow > 1.5 && lotsNow < 3)
  assert.deepEqual(deltaBreaches(book, 0), [])
  assert.equal(deltaBreaches(book, 1).length, 1)
  assert.equal(deltaBreaches(book, 5).length, 0)
  const order = leg('o', 'CE', 25000, 65)
  const after = bookGreeks([...legs, order], AT)
  const change = orderDeltaChange(book, after, 'NIFTY', lotsNow + 0.1)
  assert.ok(Math.abs(change.adds - legGreeks(order, AT).delta) < 1e-9)
  assert.equal(change.breaches, true)
  // Selling a call against it brings the delta back in: never a breach.
  const hedge = orderDeltaChange(book, bookGreeks([...legs, leg('h', 'CE', 25000, -65)], AT), 'NIFTY', 1)
  assert.ok(hedge.adds < 0)
  assert.equal(hedge.breaches, false)
  // First order with no book.
  const first = orderDeltaChange(bookGreeks([], AT), bookGreeks([order], AT), 'NIFTY')
  assert.equal(first.before, 0)
})
