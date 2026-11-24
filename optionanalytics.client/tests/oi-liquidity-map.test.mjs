import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LIQ_COLORS, liquidityDepth, liquidityGrid, liquidityKind, liquidityScale, spotRowPosition } from '../src/oiLiquidityMap.js'

const m = (obj) => ({ buckets: [...new Set(Object.values(obj).flatMap((o) => Object.keys(o).map(Number)))].sort((a, b) => a - b), perStrikeChange: new Map(Object.entries(obj).map(([k, v]) => [Number(k), new Map(Object.entries(v).map(([t, c]) => [Number(t), c]))])) })

test('four colours, one per side and direction', () => {
  assert.equal(new Set(Object.values(LIQ_COLORS)).size, 4)
  assert.equal(liquidityKind(true, 5), 'ceAdd')
  assert.equal(liquidityKind(true, -5), 'ceCut')
  assert.equal(liquidityKind(false, 5), 'peAdd')
  assert.equal(liquidityKind(false, -5), 'peCut')
  assert.equal(liquidityKind(false, 0), null)
})

test('the grid joins both sides, strikes high to low, scale = 95th percentile, depth capped at 1', () => {
  const ce = m({ 100: { 0: 50, 60: -20 }, 150: { 60: 500 } })
  const pe = m({ 100: { 0: -10 }, 150: { 0: 30, 120: 5 } })
  const g = liquidityGrid({ ceMatrix: ce, peMatrix: pe, strikes: [100, 150], bucketSeconds: 60, spotBars: [{ time: 0, close: 120 }, { time: 60, close: 130 }, { time: 600, close: 1 }] })
  assert.deepEqual(g.rows, [150, 100])
  assert.deepEqual(g.columns, [0, 60, 120])
  assert.deepEqual(g.cells.get('100|0'), { ce: 50, pe: -10 })
  assert.deepEqual(g.cells.get('150|60'), { ce: 500, pe: 0 })
  assert.equal(g.cells.has('100|120'), false)
  assert.deepEqual(g.spot.map((s) => s.t), [0, 60])        // the bar past the columns' span is left out
  assert.equal(g.scale, 500)
  assert.equal(liquidityDepth(500, g.scale), 1)
  assert.equal(liquidityDepth(5000, g.scale), 1)
  assert.equal(liquidityDepth(0, g.scale), 0)
  assert.ok(liquidityDepth(50, g.scale) > 0.1 && liquidityDepth(50, g.scale) < 1)
})

test('maxColumns keeps the newest; an empty grid has no scale or spot', () => {
  const ce = m({ 100: { 0: 1, 60: 2, 120: 3 } })
  assert.deepEqual(liquidityGrid({ ceMatrix: ce, peMatrix: null, strikes: [100], bucketSeconds: 60, maxColumns: 2 }).columns, [60, 120])
  const e = liquidityGrid({ ceMatrix: null, peMatrix: null, strikes: [100], bucketSeconds: 60, spotBars: [{ time: 0, close: 1 }] })
  assert.equal(e.scale, 0); assert.deepEqual(e.spot, [])
  assert.equal(liquidityScale([]), 0)
})

test('spot sits between strike rows by steps and is null outside the band', () => {
  const rows = [150, 100, 50]
  assert.equal(spotRowPosition(150, rows), 0)
  assert.equal(spotRowPosition(125, rows), 0.5)
  assert.equal(spotRowPosition(50, rows), 2)
  assert.equal(spotRowPosition(200, rows), null)
  assert.equal(spotRowPosition(NaN, rows), null)
})

test('a cut at a clock = the whole day up to it (the matrices carry only readings up to it)', () => {
  const full = m({ 100: { 0: 5, 60: 7, 120: 9 } })
  const cut = m({ 100: { 0: 5, 60: 7 } })
  const a = liquidityGrid({ ceMatrix: full, peMatrix: null, strikes: [100], bucketSeconds: 60 })
  const b = liquidityGrid({ ceMatrix: cut, peMatrix: null, strikes: [100], bucketSeconds: 60 })
  assert.deepEqual(a.columns.slice(0, 2), b.columns)
  assert.deepEqual(a.cells.get('100|60'), b.cells.get('100|60'))
})
