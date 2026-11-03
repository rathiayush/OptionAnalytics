// The volume profile's bars (volumeProfilePrimitive.js): how wide and how solid they are drawn. OI Replay keeps its faint
// previous-day bars (DEFAULT_BAR_STYLE); the Profiles page draws them wide and solid (PROFILE_PAGE_BARS + its "Bars"
// size, VP_BAR_SIZES) - at 28% of the plot and 18 - 42% opacity the spot's bars were too small to read on a phone.
import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_BAR_STYLE, PROFILE_PAGE_BARS, VolumeProfilePrimitive } from '../src/volumeProfilePrimitive.js'
import { DEFAULT_VP_BARS, VP_BAR_SIZES, vpBarSize } from '../src/profileZones.js'

const WIDTH = 1000
// Draws `primitive` on a fake 1000 x 600 bitmap (pixel ratio 1) and returns the rectangles it filled.
function drawn(primitive) {
  const rects = []
  const ctx = {
    fillStyle: null, strokeStyle: null, lineWidth: 1,
    fillRect(x, y, w, h) { rects.push({ x, y, w, h, fill: this.fillStyle }) },
    strokeRect() {},
  }
  primitive.attached({ series: { priceToCoordinate: (price) => (200 - price) * 4 }, requestUpdate: () => {} })
  primitive.paneViews()[0].renderer().draw({
    useBitmapCoordinateSpace: (fn) => fn({ context: ctx, bitmapSize: { width: WIDTH, height: 600 }, horizontalPixelRatio: 1, verticalPixelRatio: 1 }),
  })
  return rects
}

// Rows of 10 points, the busiest (the POC) at 120; the value area 110 - 130.
const neutralProfile = () => ({
  rows: [[100, 200], [110, 600], [120, 1000], [130, 500], [140, 100]].map(([price, total]) => ({ price, buy: 0, sell: 0, total })),
  maxRow: 1000, poc: 120, val: 110, vah: 130,
})
const alphaOf = (fill) => Number(fill.match(/,([\d.]+)\)$/)[1])

test('OI Replay keeps its faint bars: 28% of the plot, 0.42 in the value area, 0.18 outside, no tip', () => {
  assert.equal(drawn(new VolumeProfilePrimitive()).length, 0) // no profile, nothing drawn
  const p = new VolumeProfilePrimitive()
  p.setProfile(neutralProfile(), 10)
  const bars = drawn(p)
  assert.equal(bars.length, 5)  // one bar a row, no tip
  const poc = bars.find((r) => r.w === Math.max(...bars.map((b) => b.w)))
  assert.equal(poc.w, WIDTH * DEFAULT_BAR_STYLE.widthPct)
  assert.equal(poc.x + poc.w, WIDTH) // anchored at the right edge
  assert.deepEqual([...new Set(bars.map((r) => alphaOf(r.fill)))].sort(), [0.18, 0.42])
  assert.ok(bars.every((r) => r.fill.startsWith('rgba(150,170,200,')))
})

test('the Profiles page draws them wide and solid: its width, a bright neutral colour, a tip at each bar end', () => {
  const p = new VolumeProfilePrimitive(PROFILE_PAGE_BARS)
  p.setStyle({ widthPct: VP_BAR_SIZES.normal.widthPct })
  p.setProfile(neutralProfile(), 10)
  const rects = drawn(p)
  const bars = rects.filter((r) => r.w > 1)
  const tips = rects.filter((r) => r.w === 1)
  assert.equal(bars.length, 5)
  assert.equal(tips.length, 5)
  assert.equal(Math.max(...bars.map((r) => r.w)), WIDTH * 0.45)
  // a row's bar is its share of the POC row's: 600 / 1000 of the longest
  const at110 = bars.find((r) => r.y === Math.round((200 - 120) * 4) + 1)
  assert.equal(at110.w, WIDTH * 0.45 * 0.6)
  for (const r of bars) {
    assert.ok(r.fill.startsWith('rgba(77,148,255,'), r.fill)
    assert.ok(alphaOf(r.fill) >= PROFILE_PAGE_BARS.alphaOut && alphaOf(r.fill) > DEFAULT_BAR_STYLE.alphaIn, `solid: ${r.fill}`)
  }
  // each tip sits at its bar's far (left) end
  for (const t of tips) assert.ok(bars.some((b) => b.y === t.y && Math.abs(b.x - t.x) <= 1))
  // the "Bars" choice changes the width of the chart already drawn
  p.setStyle({ widthPct: VP_BAR_SIZES.wide.widthPct })
  assert.equal(Math.max(...drawn(p).map((r) => r.w)), WIDTH * 0.6)
})

test('a futures row keeps its buy and sell split, in the solid style too', () => {
  const p = new VolumeProfilePrimitive(PROFILE_PAGE_BARS)
  p.setProfile({ rows: [{ price: 100, buy: 300, sell: 100, total: 400 }, { price: 110, buy: 0, sell: 0, total: 0 }], maxRow: 400, poc: 100, val: 100, vah: 100 }, 10)
  const rects = drawn(p)
  const buy = rects.find((r) => r.fill.startsWith('rgba(38,166,154,') && r.w > 1)
  const sell = rects.find((r) => r.fill.startsWith('rgba(239,83,80,') && r.w > 1)
  assert.equal(buy.w, WIDTH * 0.28 * 0.75) // PROFILE_PAGE_BARS leaves the width to the page
  assert.equal(sell.w, WIDTH * 0.28 * 0.25)
  assert.equal(buy.x + buy.w, WIDTH)
  assert.equal(sell.x + sell.w, buy.x)
  // the empty row draws nothing
  assert.ok(rects.every((r) => r.y !== Math.round((200 - 120) * 4) + 1))
})

test('the "Bars" sizes: Normal by default, wider than OI Replay, the room never more than the bars, unknown = default', () => {
  assert.equal(DEFAULT_VP_BARS, 'normal')
  assert.equal(vpBarSize(undefined), VP_BAR_SIZES.normal)
  assert.equal(vpBarSize('huge'), VP_BAR_SIZES.normal)
  assert.equal(vpBarSize('toString'), VP_BAR_SIZES.normal)
  assert.equal(vpBarSize('wide'), VP_BAR_SIZES.wide)
  assert.ok(VP_BAR_SIZES.normal.widthPct > DEFAULT_BAR_STYLE.widthPct)
  const order = ['narrow', 'normal', 'wide']
  for (let i = 0; i < order.length; i++) {
    const b = VP_BAR_SIZES[order[i]]
    assert.ok(b.room <= b.widthPct && b.room >= 0.25 && b.room < 0.5, order[i])
    if (i) assert.ok(b.widthPct > VP_BAR_SIZES[order[i - 1]].widthPct)
  }
})
