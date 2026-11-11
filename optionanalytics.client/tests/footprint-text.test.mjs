// How the footprint's rows are written (footprintText.js): the numbers never run into each other - sell x buy (and the row
// delta) at the largest font the widest number fits, else the row delta alone across the cells ("Delta per row"), else
// colours only; a footprint whose text fits is drawn exactly as before.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FOOTPRINT_MIN_TEXT, footprintTextLayout, rowDeltaWidth } from '../src/footprintText.js'

// Widths at 10 px, about what "Segoe UI" / system-ui give in bold: "12" ~ 12, "1.2k" ~ 20, "+1.2k" ~ 26, "+12.3k" ~ 33.
const W = { two: 12, k: 20, signedK: 26, signedWide: 33 }

test('wide bars: everything at the rows\' own size, the cells exactly as they always were', () => {
  // 120 px, no delta column: cells (120 - 19) / 2 each, text 12 px.
  assert.deepEqual(footprintTextLayout({ colWidth: 120, size: 12, sell10: W.k, buy10: W.k }), { mode: 'full', size: 12, deltaSize: 0, deltaOnly: false, cellW: 50.5, deltaW: 0 })
  // With the delta column: its usual 30% (30 px), the delta at 11 px.
  const withDelta = footprintTextLayout({ colWidth: 120, rowDelta: true, size: 12, deltaSize: 11, sell10: W.k, buy10: W.k, delta10: 20 })
  assert.deepEqual(withDelta, { mode: 'full', size: 12, deltaSize: 11, deltaOnly: false, cellW: 35.5, deltaW: rowDeltaWidth(120) })
  assert.equal(rowDeltaWidth(120), 30)
})

test('a little short of room: the font steps down until the widest number fits', () => {
  // A phone's 76 px bar with no delta column: cells 28.5 px; "1.2k" at 12 px (24 + 5 > 28.5) steps down.
  const r = footprintTextLayout({ colWidth: 76, size: 12, sell10: W.k + 2, buy10: W.k })
  assert.equal(r.mode, 'full')
  assert.equal(r.size, 10)
  assert.ok((W.k + 2) * r.size / 10 + 5 <= r.cellW)
  // The delta column widens from its usual 30% when its number needs it and the cells can spare it.
  const wider = footprintTextLayout({ colWidth: 140, rowDelta: true, size: 12, deltaSize: 11, sell10: W.two, buy10: W.two, delta10: W.signedWide })
  assert.equal(wider.mode, 'full')
  assert.ok(wider.deltaW > rowDeltaWidth(140), `${wider.deltaW}`)
  assert.ok(W.signedWide * wider.deltaSize / 10 + 4 <= wider.deltaW + 1e-9)
  assert.ok(wider.cellW * 2 + wider.deltaW <= 140 - 19 + 1e-9)
})

test('too small for all three: the row delta alone across the cells (with "Delta per row")', () => {
  // The photo: a phone's bar with the delta column - cells 14.5 px, no room for "1.2k" at any size.
  const r = footprintTextLayout({ colWidth: 76, rowDelta: true, size: 12, deltaSize: 11, sell10: W.k, buy10: W.k, delta10: W.signedK })
  assert.deepEqual(r, { mode: 'delta', size: 0, deltaSize: 11, deltaOnly: true, cellW: 0, deltaW: 57 })
  // In lots the numbers are short ("12"): the same bar writes all three, smaller.
  const lots = footprintTextLayout({ colWidth: 76, rowDelta: true, size: 12, deltaSize: 11, sell10: W.two, buy10: W.two, delta10: 18 })
  assert.equal(lots.mode, 'full')
  assert.ok(lots.size >= FOOTPRINT_MIN_TEXT && lots.size < 12)
  // The delta column alone too narrow for its number (the cells would fit): delta only, rather than squashed text.
  const tight = footprintTextLayout({ colWidth: 90, rowDelta: true, size: 12, deltaSize: 11, sell10: W.k, buy10: W.k, delta10: W.signedWide })
  assert.equal(tight.mode, 'delta')
  assert.ok(W.signedWide * tight.deltaSize / 10 + 8 <= tight.deltaW)
})

test('still too small: colours only - never text over text', () => {
  // The narrowest bar (40 px): not even the delta fits at the smallest font.
  const r = footprintTextLayout({ colWidth: 40, rowDelta: true, size: 12, deltaSize: 11, sell10: W.k, buy10: W.k, delta10: W.signedWide })
  // Two cells and the delta column would run into the next bar: the delta's colours alone, across the bar.
  assert.deepEqual(r, { mode: 'none', size: 0, deltaSize: 0, deltaOnly: true, cellW: 0, deltaW: 21 })
  // No delta column: there is no "delta only" - the cells keep their colours.
  const plain = footprintTextLayout({ colWidth: 40, size: 12, sell10: W.k, buy10: W.k })
  assert.deepEqual(plain, { mode: 'none', size: 0, deltaSize: 0, deltaOnly: false, cellW: 10.5, deltaW: 0 })
  // Rows too thin for text at all: no text, the cells where they always were.
  assert.deepEqual(footprintTextLayout({ colWidth: 200, rowDelta: true, sell10: 5, buy10: 5, delta10: 5, showText: false }),
    { mode: 'none', size: 0, deltaSize: 0, deltaOnly: false, cellW: (200 - 19 - rowDeltaWidth(200)) / 2, deltaW: rowDeltaWidth(200) })
})
