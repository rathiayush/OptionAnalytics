// OI Replay's dashboard layout (dashboardLayout.js): the grid model react-grid-layout reads and writes -
// what the page starts with, what a saved layout reconciles to, the presets, and the height a chart filling
// a card gets. The dragging and resizing themselves are react-grid-layout's; these are the rules around it.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GRID_COLS, GRID_MARGIN, GRID_ROW_HEIGHT, MIN_H, MIN_W,
  contentHeight, defaultLayout, defaultRows, gridItem, isDefaultLayout, presetLayout, pxToRows,
  reconcileGridLayout, reconcileSections, rowsToPx,
} from '../src/dashboardLayout.js'

const IDS = ['topStats', 'marketRead', 'gex']

test('a card is as many rows tall as it covers, with the margins between them', () => {
  assert.equal(rowsToPx(1), GRID_ROW_HEIGHT)
  assert.equal(rowsToPx(2), GRID_ROW_HEIGHT * 2 + GRID_MARGIN)
  assert.equal(rowsToPx(10), GRID_ROW_HEIGHT * 10 + GRID_MARGIN * 9)
  // ...and back again
  assert.equal(pxToRows(rowsToPx(10)), 10)
  assert.equal(pxToRows(rowsToPx(7)), 7)
  assert.equal(pxToRows(0), MIN_H)      // never under the minimum
})

test('the page starts with every card full width, stacked in its own order', () => {
  const layout = defaultLayout(IDS)
  assert.deepEqual(layout.map((it) => it.i), IDS)
  assert.ok(layout.every((it) => it.x === 0 && it.w === GRID_COLS))
  assert.equal(layout[0].y, 0)
  assert.equal(layout[1].y, defaultRows('topStats'))
  assert.equal(layout[2].y, defaultRows('topStats') + defaultRows('marketRead'))
})

test('a card order saved before the grid existed still seeds the order', () => {
  const layout = defaultLayout(IDS, ['gex', 'topStats', 'marketRead'])
  assert.deepEqual(layout.map((it) => it.i), ['gex', 'topStats', 'marketRead'])
  assert.equal(layout[0].y, 0)
  // An id the order has never heard of goes last, not first.
  assert.deepEqual(defaultLayout(IDS, ['gex']).map((it) => it.i), ['gex', 'topStats', 'marketRead'])
})

test('one item is read back inside the grid, whatever was saved', () => {
  assert.deepEqual(gridItem({ x: 3, y: 4, w: 6, h: 9 }, 'gex'), { i: 'gex', x: 3, y: 4, w: 6, h: 9 })
  assert.deepEqual(gridItem({ x: 99, y: -5, w: 99, h: 1 }, 'gex'), { i: 'gex', x: 0, y: 0, w: GRID_COLS, h: MIN_H })
  assert.equal(gridItem({ w: 1 }, 'gex').w, MIN_W)
  // A card cannot start past the right edge: x is held to what its own width leaves.
  assert.equal(gridItem({ x: 11, w: 6 }, 'gex').x, GRID_COLS - 6)
  assert.deepEqual(gridItem(undefined, 'gex'), { i: 'gex', x: 0, y: 0, w: GRID_COLS, h: defaultRows('gex') })
})

test('a saved layout keeps its cards where they are; a new card goes to the bottom', () => {
  const saved = [{ i: 'gex', x: 6, y: 0, w: 6, h: 10 }, { i: 'topStats', x: 0, y: 0, w: 6, h: 5 }, { i: 'gone', x: 0, y: 9, w: 6, h: 5 }]
  const layout = reconcileGridLayout(saved, IDS)
  assert.deepEqual(layout.map((it) => it.i), IDS)                       // back in the page's order
  assert.deepEqual(layout.find((it) => it.i === 'gex'), { i: 'gex', x: 6, y: 0, w: 6, h: 10 })
  assert.equal(layout.some((it) => it.i === 'gone'), false)              // a card the page no longer has
  const added = layout.find((it) => it.i === 'marketRead')               // a card added since it was saved
  assert.deepEqual(added, { i: 'marketRead', x: 0, y: 10, w: GRID_COLS, h: defaultRows('marketRead') })
})

test('nothing saved - or nonsense saved - is the layout the page starts with', () => {
  assert.deepEqual(reconcileGridLayout(null, IDS), defaultLayout(IDS))
  assert.deepEqual(reconcileGridLayout([], IDS), defaultLayout(IDS))
  assert.deepEqual(reconcileGridLayout(['nope', { nope: 1 }], IDS), defaultLayout(IDS))
  assert.deepEqual(reconcileGridLayout(null, IDS, ['gex']), defaultLayout(IDS, ['gex']))
})

test('still the layout it started with = nothing to reset', () => {
  assert.equal(isDefaultLayout(defaultLayout(IDS), IDS), true)
  assert.equal(isDefaultLayout(defaultLayout(IDS, ['gex']), IDS, ['gex']), true)
  assert.equal(isDefaultLayout(presetLayout(IDS, 2), IDS), false)
  assert.equal(isDefaultLayout([], IDS), false)
  assert.equal(isDefaultLayout(null, IDS), false)
})

test('the presets put the same number of cards in every row, left to right', () => {
  const two = presetLayout(IDS, 2)
  assert.deepEqual(two.find((it) => it.i === 'topStats'), { i: 'topStats', x: 0, y: 0, w: 6, h: defaultRows('topStats') })
  assert.deepEqual(two.find((it) => it.i === 'marketRead'), { i: 'marketRead', x: 6, y: 0, w: 6, h: defaultRows('marketRead') })
  // The second row starts below the TALLEST card of the first, so nothing overlaps.
  assert.equal(two.find((it) => it.i === 'gex').y, Math.max(defaultRows('topStats'), defaultRows('marketRead')))
  assert.deepEqual(presetLayout(IDS, 3).map((it) => it.x), [0, 4, 8])
  assert.deepEqual(presetLayout(IDS, 4).map((it) => it.w), [3, 3, 3])
  assert.deepEqual(presetLayout(IDS, 1).map((it) => it.w), [12, 12, 12])
})

test('a preset keeps the heights the cards were given', () => {
  const layout = [{ i: 'gex', x: 0, y: 0, w: 12, h: 25 }]
  assert.equal(presetLayout(IDS, 2, { layout }).find((it) => it.i === 'gex').h, 25)
})

test('a chart filling a card gets the card less its title bar, and never a sliver', () => {
  assert.equal(contentHeight(10, { chromePx: 86 }), rowsToPx(10) - 86)
  assert.equal(contentHeight(null), null)          // no grid height: the chart keeps its own
  assert.equal(contentHeight(undefined), null)
  assert.ok(contentHeight(MIN_H, { chromePx: 400 }) >= 90)
})

test('the cards to show are reconciled too, and never leave an empty page', () => {
  const all = ['a', 'b', 'c']
  const fallback = ['b', 'c']
  assert.deepEqual(reconcileSections(['a', 'c'], all, fallback), ['a', 'c'])
  assert.deepEqual(reconcileSections(['a', 'gone', 'a'], all, fallback), ['a'])   // unknown and duplicates dropped
  assert.deepEqual(reconcileSections(null, all, fallback), fallback)              // nothing saved: the default set
  assert.deepEqual(reconcileSections([], all, fallback), fallback)                // and never nothing at all
  assert.deepEqual(reconcileSections(['gone'], all, fallback), fallback)
  assert.notEqual(reconcileSections(null, all, fallback), fallback)               // a copy, not the array itself
})
