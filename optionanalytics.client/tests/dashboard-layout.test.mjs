// OI Replay's dashboard layout (dashboardLayout.js): the grid model react-grid-layout reads and writes -
// what the page starts with, what a saved layout reconciles to, the presets, and the scale a sized card's
// content is drawn at to fill it. The dragging and resizing themselves are react-grid-layout's; these are the rules around it.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FIT_SCALE_MAX, FIT_SCALE_MIN, GRID_COLS, GRID_MARGIN, GRID_ROW_HEIGHT, MIN_H, MIN_W,
  defaultLayout, defaultRows, defaultSpan, fitLayoutHeights, gridItem, isDefaultArrangement, isDefaultLayout,
  isStackedLayout, nextFitScale, presetLayout, pxToRows, reconcileGridLayout, reconcileSections, rowsToHold, rowsToPx,
  SECTION_SPLITS, withSplitSections, defaultSpan as spanOf, cardsARowChoices, SIX_A_ROW_PX,
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

test('the page starts as a dashboard: each card at its own width, left to right, wrapping to a new row', () => {
  const layout = defaultLayout(IDS)
  assert.deepEqual(layout.map((it) => it.i), IDS)
  // The snapshot is full width; the two reads after it sit side by side under it.
  assert.deepEqual(layout[0], { i: 'topStats', x: 0, y: 0, w: GRID_COLS, h: defaultRows('topStats') })
  assert.deepEqual(layout[1], { i: 'marketRead', x: 0, y: defaultRows('topStats'), w: defaultSpan('marketRead'), h: defaultRows('marketRead') })
  assert.deepEqual(layout[2], { i: 'gex', x: defaultSpan('marketRead'), y: defaultRows('topStats'), w: defaultSpan('gex'), h: defaultRows('gex') })
  // A row starts under the TALLEST card of the row above, so nothing overlaps.
  const three = defaultLayout(['marketRead', 'gex', 'straddle'])
  assert.equal(three[2].y, Math.max(defaultRows('marketRead'), defaultRows('gex')))
  assert.equal(three[2].x, 0)
})

test('the old saved one-column stack is told apart from a real arrangement', () => {
  const stacked = IDS.map((i, n) => ({ i, x: 0, y: n * 10, w: GRID_COLS, h: 10 }))
  assert.equal(isStackedLayout(stacked, IDS), true)
  assert.equal(isStackedLayout(defaultLayout(IDS), IDS), false)
  assert.equal(isStackedLayout(stacked.slice(0, 2), IDS), false)     // not the whole page: someone's own
  assert.equal(isStackedLayout(null, IDS), false)
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

test('a saved layout keeps its cards where they are; a new card goes right under the card before it', () => {
  const saved = [{ i: 'gex', x: 6, y: 0, w: 6, h: 10 }, { i: 'topStats', x: 0, y: 0, w: 6, h: 5 }, { i: 'gone', x: 0, y: 9, w: 6, h: 5 }]
  const layout = reconcileGridLayout(saved, IDS)
  assert.deepEqual(layout.map((it) => it.i), IDS)                       // back in the page's order
  assert.deepEqual(layout.find((it) => it.i === 'gex'), { i: 'gex', x: 6, y: 0, w: 6, h: 10 })
  assert.equal(layout.some((it) => it.i === 'gone'), false)              // a card the page no longer has
  const added = layout.find((it) => it.i === 'marketRead')               // a card added since it was saved: under topStats
  assert.deepEqual(added, { i: 'marketRead', x: 0, y: 5, w: spanOf('marketRead'), h: defaultRows('marketRead') })
  // With none of the cards before it saved, at the bottom, full width.
  const first = reconcileGridLayout([{ i: 'gex', x: 0, y: 0, w: 12, h: 10 }], ['topStats', 'gex'])
  assert.deepEqual(first.find((it) => it.i === 'topStats'), { i: 'topStats', x: 0, y: 10, w: GRID_COLS, h: defaultRows('topStats') })
})

test('a card split out of another lands where its content was - everything below moves down to make room', () => {
  // The OI totals left the heatmap card: a saved dashboard gets them right under the heatmap, not at the page's foot.
  const ids = ['dayOi', 'oiHeatmap', 'oiTotals', 'spotAndEntry', 'gex']
  const saved = [
    { i: 'dayOi', x: 0, y: 0, w: 6, h: 13 },
    { i: 'oiHeatmap', x: 0, y: 13, w: 12, h: 17 },
    { i: 'spotAndEntry', x: 0, y: 30, w: 12, h: 23 },
    { i: 'gex', x: 6, y: 0, w: 6, h: 13 },
  ]
  const layout = reconcileGridLayout(saved, ids)
  const at = (id) => layout.find((it) => it.i === id)
  assert.deepEqual(at('oiTotals'), { i: 'oiTotals', x: 0, y: 30, w: 12, h: defaultRows('oiTotals') })
  assert.equal(at('spotAndEntry').y, 30 + defaultRows('oiTotals'))     // moved down by the new card's height
  assert.deepEqual([at('dayOi').y, at('gex').y, at('oiHeatmap').y], [0, 0, 13])   // above it: untouched
})

test('a saved choice of cards that showed the heatmap shows the totals split out of it - once', () => {
  assert.deepEqual(SECTION_SPLITS, { oiTotals: 'oiHeatmap' })
  assert.deepEqual(withSplitSections(['dayOi', 'oiHeatmap', 'gex']), ['dayOi', 'oiHeatmap', 'oiTotals', 'gex'])
  // The heatmap hidden: the totals stay hidden too (nothing of it was on the page).
  assert.deepEqual(withSplitSections(['dayOi', 'gex']), ['dayOi', 'gex'])
  // Already there: nothing doubled; nothing saved: nothing to do.
  assert.deepEqual(withSplitSections(['oiHeatmap', 'oiTotals']), ['oiHeatmap', 'oiTotals'])
  assert.equal(withSplitSections(null), null)
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
  // Six a row on a very wide monitor: a sixth each; more than six is six.
  assert.deepEqual(presetLayout(IDS, 6).map((it) => [it.x, it.w]), [[0, 2], [2, 2], [4, 2]])
  assert.deepEqual(presetLayout(IDS, 9).map((it) => it.w), [2, 2, 2])
})

test('"Cards a row" offers six only on a monitor wide enough for it', () => {
  assert.deepEqual(cardsARowChoices(1500), [1, 2, 3, 4])
  assert.deepEqual(cardsARowChoices(SIX_A_ROW_PX), [1, 2, 3, 4, 6])
  assert.deepEqual(cardsARowChoices(3440), [1, 2, 3, 4, 6])
  // A card can be as narrow as a sixth - and is read back no narrower than that.
  assert.equal(MIN_W, GRID_COLS / 6)
  assert.equal(gridItem({ x: 0, y: 0, w: 1, h: 10 }, 'gex').w, MIN_W)
})

test('a preset lays out only the cards given, keeps the spot / entry charts readable, and leaves no holes', () => {
  // The page passes the cards it SHOWS - a hidden card given a slot left a hole at the top.
  const shown = ['entryChecklist', 'dayOi', 'oiHeatmap', 'oiTotals', 'spotAndEntry', 'optionPremium', 'optionFlow', 'gex']
  const six = presetLayout(shown, 6)
  assert.deepEqual(six.map((it) => it.i), shown)
  const at = (id) => six.find((it) => it.i === id)
  assert.equal(at('spotAndEntry').w, 6)                                 // three charts: never a sixth
  // The first row takes the narrow cards that still fit, rather than closing at the wide one.
  assert.deepEqual(['entryChecklist', 'dayOi', 'oiHeatmap', 'oiTotals', 'optionPremium', 'optionFlow'].map((id) => [at(id).x, at(id).y]),
    [[0, 0], [2, 0], [4, 0], [6, 0], [8, 0], [10, 0]])
  assert.equal(at('spotAndEntry').y, Math.max(...['entryChecklist', 'dayOi', 'oiHeatmap', 'oiTotals', 'optionPremium', 'optionFlow'].map(defaultRows)))
  // Every row filled edge to edge: the row closed short (spot / entry 6 + gex 2, nothing left) is the last - left as is.
  assert.deepEqual([at('spotAndEntry').x, at('gex').x, at('gex').w], [0, 6, 2])
  // A row closed short because the next card does not fit: its last card takes the rest.
  const three = presetLayout(['dayOi', 'spotAndEntry', 'gex', 'oiTotals'], 3)
  const t = (id) => three.find((it) => it.i === id)
  // dayOi 4 + spot / entry 6 = 10, gex (4) does not fit the 2 left: spot / entry takes them (8), gex starts the next row.
  assert.deepEqual([t('dayOi').w, t('spotAndEntry').w, t('gex').x, t('gex').y], [4, 8, 0, defaultRows('spotAndEntry')])
  assert.equal(t('spotAndEntry').x + t('spotAndEntry').w, GRID_COLS)
})

test('a preset keeps the heights the cards were given', () => {
  const layout = [{ i: 'gex', x: 0, y: 0, w: 12, h: 25 }]
  assert.equal(presetLayout(IDS, 2, { layout }).find((it) => it.i === 'gex').h, 25)
})

// A sized card's content: every chart (and table box) in it is its own height x one scale, measured until the content is
// the card's height (2 px of slack). `charts` = the heights that scale, summed - the first step's slope.
const SIZE = { box: 802, width: 900, charts: 400 }

test('a sized card: the first step scales by what its charts can take up', () => {
  const first = nextFitScale(null, { ...SIZE, scale: 1, content: 600 })
  assert.equal(first.scale, 1.5)                            // 200 px short, 400 px of charts: x1.5
  assert.equal(first.state.steps, 1)
  // Later steps go by what the last step actually did (text that wraps, a box that does not scale).
  const second = nextFitScale(first.state, { ...SIZE, scale: 1.5, content: 780 })
  assert.equal(second.scale, 1.556)                         // 180 px for 0.5: 20 more px = +0.0556
  // Fits (within 3 px of the box less the slack): left as it is.
  const done = nextFitScale(second.state, { ...SIZE, scale: 1.556, content: 801 })
  assert.equal(done.scale, 1.556)
  assert.equal(done.state.steps, 0)
})

test('a sized card shorter than its content shrinks the charts, never under the floor or over the ceiling', () => {
  assert.equal(nextFitScale(null, { ...SIZE, scale: 1, content: 1000 }).scale, 0.5)   // 200 px over, 400 px of charts: x0.5
  assert.equal(nextFitScale(null, { box: 200, width: 900, charts: 100, scale: 1, content: 5000 }).scale, FIT_SCALE_MIN)
  assert.equal(nextFitScale(null, { box: 5000, width: 900, charts: 100, scale: 1, content: 100 }).scale, FIT_SCALE_MAX)
})

test('a card with nothing that scales is left alone (its body scrolls)', () => {
  const next = nextFitScale(null, { box: 300, width: 900, charts: 0, scale: 1, content: 900 })
  assert.equal(next.scale, 1)
})

test('the fit gives up after a few steps - and starts again when the card is resized', () => {
  let state = null
  let scale = 1
  // Content that never answers the scale: it must stop, not chase it for ever.
  for (let i = 0; i < 20; i += 1) ({ scale, state } = nextFitScale(state, { ...SIZE, scale, content: 600 }))
  assert.equal(state.steps, 8)
  const stuck = nextFitScale(state, { ...SIZE, scale, content: 600 })
  assert.equal(stuck.scale, scale)
  // A new height, or a new width (text wraps differently), is a new fit.
  assert.notEqual(nextFitScale(state, { ...SIZE, box: 1002, scale, content: 600 }).scale, scale)
  assert.equal(nextFitScale(state, { ...SIZE, width: 1200, scale, content: 600 }).state.steps, 1)
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

test('a card fitted to its content holds all of it - the fewest rows, never a row short', () => {
  for (const px of [1, 100, 582, 705, 1135, 1200]) {
    const rows = rowsToHold(px)
    assert.ok(rows === MIN_H || rowsToPx(rows) >= px, `${px} px in ${rows} rows = ${rowsToPx(rows)} px`)
    assert.ok(rows === MIN_H || rowsToPx(rows - 1) < px, `${rows} rows is the fewest for ${px} px`)
  }
  // The nearest row (pxToRows) can be shorter than the content; rowsToHold never is.
  assert.ok(rowsToPx(pxToRows(690)) < 690 && rowsToPx(rowsToHold(690)) >= 690)   // 674 px vs 720
})

test('a card nobody sized follows its content; one dragged to a height keeps it', () => {
  const layout = [{ i: 'gex', x: 0, y: 0, w: 6, h: 19 }, { i: 'straddle', x: 6, y: 0, w: 6, h: 19 }]
  const measured = new Map([['gex', 1135], ['straddle', 400]])
  const fitted = fitLayoutHeights(layout, measured, new Set(['straddle']))
  assert.equal(fitted[0].h, rowsToHold(1135))
  assert.equal(fitted[1], layout[1])                                       // sized: untouched
  // Nothing new to fit: the same array back, so measuring the same page again costs no render.
  assert.equal(fitLayoutHeights(fitted, measured, new Set(['straddle'])), fitted)
  assert.equal(fitLayoutHeights(layout, new Map()), layout)
  assert.equal(fitLayoutHeights(layout, new Map([['gex', 0]])), layout)    // not measured yet
})

test('"anything to reset?" asks about the arrangement - not the heights the cards fitted to', () => {
  const base = defaultLayout(IDS)
  assert.equal(isDefaultArrangement(base, IDS), true)
  // Every card fitted to its content and packed up again: still the page's own arrangement.
  const fitted = base.map((it) => ({ ...it, h: it.h + 3, y: it.y === 0 ? 0 : it.y + 3 }))
  assert.equal(isDefaultArrangement(fitted, IDS), true)
  assert.equal(isDefaultLayout(fitted, IDS), false)
  // A card moved to another column, made wider, or put above another in its column: arranged.
  assert.equal(isDefaultArrangement(base.map((it) => (it.i === 'gex' ? { ...it, x: 3 } : it)), IDS), false)
  assert.equal(isDefaultArrangement(base.map((it) => (it.i === 'gex' ? { ...it, w: 8 } : it)), IDS), false)
  assert.equal(isDefaultArrangement(base.map((it) => (it.i === 'marketRead' ? { ...it, y: -1 } : it.i === 'topStats' ? { ...it, y: 40 } : it)), IDS), false)
  assert.equal(isDefaultArrangement(presetLayout(IDS, 2), IDS), false)
  assert.equal(isDefaultArrangement(null, IDS), false)
  // Only the cards on the page count: a hidden one comes back wherever the grid put it.
  const hiddenMoved = base.map((it) => (it.i === 'topStats' ? { ...it, x: 0, w: 6, y: 90 } : it))
  assert.equal(isDefaultArrangement(hiddenMoved, IDS), false)
  assert.equal(isDefaultArrangement(hiddenMoved, IDS, null, ['marketRead', 'gex']), true)
  assert.equal(isDefaultArrangement(base.filter((it) => it.i !== 'gex'), IDS, null, ['marketRead', 'gex']), false)
})
