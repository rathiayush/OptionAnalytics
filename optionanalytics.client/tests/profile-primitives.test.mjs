// The Profiles page's chart drawings (profilePrimitives.js) on a fake canvas: the market profile (TPO) draws through its
// POC row (a stray reference there threw mid-paint - the letters stopped at the POC and the candles were never drawn), and
// the Delta column draws rows only 1 - 2 px tall (a wide BANKNIFTY / SENSEX range: they were all skipped, the column empty).
import test from 'node:test'
import assert from 'node:assert/strict'
import { DeltaColumnPrimitive, TpoProfilePrimitive } from '../src/profilePrimitives.js'

function fakeTarget(width, height, pr = 1) {
  const rects = []
  const ctx = new Proxy({ fillRect: (...a) => rects.push(a), strokeRect: (...a) => rects.push(a), fillText() {}, measureText: (t) => ({ width: t.length * 6 }) }, {
    get: (o, k) => (k in o ? o[k] : () => {}),
    set: () => true,
  })
  return { rects, target: { useBitmapCoordinateSpace: (fn) => fn({ context: ctx, bitmapSize: { width: width * pr, height: height * pr }, horizontalPixelRatio: pr, verticalPixelRatio: pr, mediaSize: { width, height } }) } }
}
// A price scale of `low`..`high` over `height` px.
const series = (low, high, height) => ({ priceToCoordinate: (p) => ((high - p) / (high - low)) * height })
const draw = (primitive) => (target) => primitive.paneViews()[0].renderer().draw(target)

test('the market profile draws every row, the POC row too, without throwing', () => {
  const p = new TpoProfilePrimitive()
  p.attached({ series: series(25000, 25100, 400), requestUpdate() {} })
  const rows = [0, 10, 20, 30, 40].map((k, i) => ({ price: 25020 + k, count: 2 + i % 3, letters: 'ABCDE'.slice(0, 2 + i % 3) }))
  p.setProfile({ rows, rowSize: 10, poc: 25040, vah: 25050, val: 25020 })
  const { rects, target } = fakeTarget(800, 400)
  assert.doesNotThrow(() => draw(p)(target))
  assert.ok(rects.length >= rows.reduce((t, r) => t + r.letters.length, 0))
})

test('the Delta column draws rows only 1 - 2 px tall', () => {
  for (const pr of [1, 2]) {
    const p = new DeltaColumnPrimitive()
    p.attached({ series: series(62600, 65400, 450), requestUpdate() {} })    // 10 points = 1.6 css px
    const rows = Array.from({ length: 50 }, (_, i) => ({ price: 63000 + i * 10, delta: i % 2 ? 100 + i : -(50 + i) }))
    p.setProfile({ rows, rowSize: 10, maxAbsDelta: 200 })
    const { rects, target } = fakeTarget(1000, 450, pr)
    draw(p)(target)
    // background + the centre line + one bar a row
    assert.equal(rects.length, 2 + rows.length, `pixel ratio ${pr}`)
    for (const [, , w, h] of rects.slice(2)) assert.ok(w >= 1 && h >= 1)
  }
})
