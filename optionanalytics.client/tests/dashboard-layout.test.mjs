// OI Replay's dashboard layout (dashboardLayout.js): how wide and how tall each card is laid out, what a
// drag of its grip lands on, and that a narrow screen keeps its one full-width column whatever was saved.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_ENTRY, LAYOUT_COLUMNS, MAX_CARD_HEIGHT, MIN_CARD_HEIGHT, MIN_SPAN,
  cardStyle, contentHeight, heightFromDrag, isDefaultLayout, layoutEntry, presetLayout, reconcileLayout, spanFromDrag,
} from '../src/dashboardLayout.js'

const IDS = ['topStats', 'spotAndEntry', 'gex']

test('a card with nothing saved is full width and its own height', () => {
  assert.deepEqual(layoutEntry(undefined), DEFAULT_ENTRY)
  assert.deepEqual(layoutEntry(null), { span: LAYOUT_COLUMNS, h: null })
  assert.deepEqual(layoutEntry({}), { span: LAYOUT_COLUMNS, h: null })
})

test('a saved entry is read back within its limits, and nonsense falls back', () => {
  assert.deepEqual(layoutEntry({ span: 6, h: 400 }), { span: 6, h: 400 })
  assert.deepEqual(layoutEntry({ span: 99, h: 99999 }), { span: LAYOUT_COLUMNS, h: MAX_CARD_HEIGHT })
  assert.deepEqual(layoutEntry({ span: 0, h: 10 }), { span: MIN_SPAN, h: MIN_CARD_HEIGHT })
  assert.deepEqual(layoutEntry({ span: 'half', h: 'tall' }), { span: LAYOUT_COLUMNS, h: null })
})

test('a saved layout is reconciled with the cards the page has now', () => {
  const layout = reconcileLayout({ topStats: { span: 4 }, gone: { span: 6 } }, IDS)
  assert.deepEqual(Object.keys(layout), IDS)                 // the card that no longer exists is dropped
  assert.equal(layout.topStats.span, 4)
  assert.deepEqual(layout.gex, DEFAULT_ENTRY)                // a card added since is the default
  assert.deepEqual(reconcileLayout(null, IDS).spotAndEntry, DEFAULT_ENTRY)
  assert.deepEqual(reconcileLayout({}, []), {})
})

test('all defaults = nothing to reset', () => {
  assert.equal(isDefaultLayout(reconcileLayout({}, IDS)), true)
  assert.equal(isDefaultLayout(reconcileLayout({ gex: { span: 6 } }, IDS)), false)
  assert.equal(isDefaultLayout(reconcileLayout({ gex: { h: 300 } }, IDS)), false)
})

test('dragging sideways moves the width a twelfth at a time, within its limits', () => {
  const row = 1200   // 100 px a twelfth
  assert.equal(spanFromDrag(12, 0, row), 12)
  assert.equal(spanFromDrag(12, -600, row), 6)      // half the row back = half the width
  assert.equal(spanFromDrag(6, 200, row), 8)
  assert.equal(spanFromDrag(6, -40, row), 6)        // under half a twelfth: no change
  assert.equal(spanFromDrag(6, -9000, row), MIN_SPAN)
  assert.equal(spanFromDrag(6, 9000, row), LAYOUT_COLUMNS)
  assert.equal(spanFromDrag(6, 100, 0), 6)          // a row of no width cannot be read
})

test('dragging down sets the height, from whatever the card is laid out at', () => {
  assert.equal(heightFromDrag(400, 120, 999), 520)
  assert.equal(heightFromDrag(null, 50, 300), 350)        // not sized yet: from its measured height
  assert.equal(heightFromDrag(null, -9000, 300), MIN_CARD_HEIGHT)
  assert.equal(heightFromDrag(400, 9000, 300), MAX_CARD_HEIGHT)
  assert.equal(heightFromDrag(null, 50, null), null)      // nothing to measure
})

test('the presets put the same number of cards in every row', () => {
  const two = presetLayout(IDS, 2)
  assert.deepEqual(Object.values(two).map((e) => e.span), [6, 6, 6])
  assert.deepEqual(Object.values(presetLayout(IDS, 3)).map((e) => e.span), [4, 4, 4])
  assert.deepEqual(Object.values(presetLayout(IDS, 4)).map((e) => e.span), [3, 3, 3])
  assert.deepEqual(Object.values(presetLayout(IDS, 1)).map((e) => e.span), [12, 12, 12])
  // Heights the cards were given stay - a preset is about the widths.
  assert.equal(presetLayout(IDS, 2, { gex: { span: 12, h: 500 } }).gex.h, 500)
})

test('a card is laid out at its share of the row, in its place in the order', () => {
  const half = cardStyle({ span: 6, h: 420 }, { wide: true, order: 3 })
  assert.equal(half.order, 3)
  assert.equal(half.maxWidth, '50%')
  assert.equal(half.flex, '0 0 50%')
  assert.equal(half.height, 420)
  assert.equal(cardStyle({ span: 4 }, { wide: true }).maxWidth, `${(4 / 12) * 100}%`)
})

test('a narrow screen keeps one full-width column, whatever was saved', () => {
  const narrow = cardStyle({ span: 3, h: 200 }, { wide: false, order: 1 })
  assert.equal(narrow.maxWidth, '100%')
  assert.equal(narrow.flex, '0 0 100%')
  assert.equal(narrow.height, undefined)        // and its own height, not a 200px sliver
  assert.equal(narrow.order, 1)                 // the order is still the page's
})

test('a chart filling a sized card gets the card less its title bar; otherwise its own height', () => {
  assert.equal(contentHeight({ span: 6, h: 500 }, { wide: true, chromePx: 86, fallback: 320 }), 414)
  assert.equal(contentHeight({ span: 6, h: null }, { wide: true, fallback: 320 }), 320)
  assert.equal(contentHeight({ span: 6, h: 500 }, { wide: false, fallback: 320 }), 320)
  // Never negative, however short the card is.
  assert.ok(contentHeight({ span: 6, h: MIN_CARD_HEIGHT }, { wide: true, chromePx: 400, fallback: 320 }) > 0)
})
