import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TLM_COLORS, TLM_KINDS, priceRowPosition, strikeGap, tickLiquidityDepth, tickLiquidityGrid } from '../src/tickLiquidityMap.js'

const MIN = 60_000
const o = (t, strike, type, read, value) => ({ t, strike, type, read, value, lots: 50 })

test('four distinct colours, one per kind', () => {
  assert.equal(new Set(Object.values(TLM_COLORS)).size, 4)
  assert.deepEqual([...TLM_KINDS].sort(), Object.keys(TLM_COLORS).sort())
})

test('cells hold the money by kind; the biggest kind colours the cell; strikes fill in at the step', () => {
  const g = tickLiquidityGrid({
    bucketMs: 3 * MIN,
    orders: [
      o(0, 25000, 'CE', 'long build-up', 100),    // calls bought
      o(60_000, 25000, 'PE', 'short build-up', 300), // puts written
      o(4 * MIN, 25100, 'PE', 'bought', 50),      // puts bought
      o(5 * MIN, 25100, 'CE', 'unclear', 999),    // no kind - left out
    ],
    step: 50, priceBars: [{ time: 0, close: 25040 }, { time: 5 * MIN, close: 25060 }],
  })
  assert.deepEqual(g.rows, [25100, 25050, 25000])
  assert.deepEqual(g.columns, [0, 3 * MIN])
  const a = g.cells.get('25000|0')
  assert.equal(a.total, 400); assert.equal(a.kind, 'peWritten'); assert.equal(a.ceBought, 100); assert.equal(a.count, 2)
  assert.equal(g.cells.get('25100|180000').kind, 'peBought')
  assert.equal(g.cells.size, 2)
  assert.equal(g.price.length, 2)
  assert.ok(tickLiquidityDepth(400, g.scale) <= 1 && tickLiquidityDepth(0, g.scale) === 0)
})

test('maxColumns keeps the newest; no usable order = an empty grid', () => {
  const g = tickLiquidityGrid({ bucketMs: MIN, orders: [o(0, 100, 'CE', 'bought', 1), o(10 * MIN, 100, 'CE', 'bought', 1)], maxColumns: 3 })
  assert.equal(g.columns.length, 3); assert.equal(g.columns.at(-1), 10 * MIN)
  assert.equal(g.cells.size, 1)
  assert.equal(tickLiquidityGrid({ bucketMs: MIN, orders: [o(0, 100, 'CE', 'unclear', 5)] }).rows.length, 0)
})

test('a cut at a clock = the whole day up to it, and the price row position', () => {
  const day = [o(0, 100, 'CE', 'bought', 5), o(MIN, 150, 'PE', 'sold', 7), o(9 * MIN, 100, 'CE', 'bought', 9)]
  const whole = tickLiquidityGrid({ bucketMs: MIN, orders: day })
  const cut = tickLiquidityGrid({ bucketMs: MIN, orders: day.filter((x) => x.t <= 2 * MIN) })
  assert.deepEqual(cut.columns, whole.columns.slice(0, cut.columns.length))
  assert.deepEqual(cut.cells.get('150|60000'), whole.cells.get('150|60000'))
  assert.equal(strikeGap([100, 150, 250]), 50)
  assert.equal(priceRowPosition(125, [150, 100]), 0.5)
})

test('the map filters: hedge positions are the far out-of-the-money orders, and a side keeps buyers or sellers', async () => {
  const { filterMapOrders, isHedgePosition, otmSteps } = await import('../src/tickLiquidityMap.js')
  const o = (type, atmDistance, side) => ({ type, atmDistance, side })
  assert.equal(otmSteps(o('CE', 6, 1)), 6)
  assert.equal(otmSteps(o('PE', -6, 1)), 6)
  assert.equal(otmSteps(o('PE', 6, 1)), -6)
  const list = [o('CE', 6, 1), o('PE', -7, -1), o('CE', 1, 1), o('PE', 4, -1)]
  assert.equal(isHedgePosition(list[0], 5), true)
  assert.equal(isHedgePosition(list[2], 5), false)
  assert.equal(filterMapOrders(list).length, 4)
  assert.deepEqual(filterMapOrders(list, { hedgeOnly: true, hedgeSteps: 5 }), [list[0], list[1]])
  assert.deepEqual(filterMapOrders(list, { hedgeOnly: true, hedgeSteps: 5, side: 'sell' }), [list[1]])
  assert.deepEqual(filterMapOrders(list, { side: 'buy' }), [list[0], list[2]])
})
