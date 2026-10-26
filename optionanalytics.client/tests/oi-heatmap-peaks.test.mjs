import { test } from 'node:test'
import assert from 'node:assert/strict'
import { atmAtFromBars, atmPeakCells, strikeStep } from '../src/oiHeatmapPeaks.js'

// Strikes 22400 .. 22600 (step 50), three 1-minute columns.
const STRIKES = [22600, 22550, 22500, 22450, 22400]
const T = 1_000_000 * 60
const COLUMNS = [T, T + 60, T + 120]
const matrix = (rows) => new Map(Object.entries(rows).map(([strike, values]) => [Number(strike), new Map(values.map((v, i) => [COLUMNS[i], v]))]))

test('the strike step is the smallest gap between strikes', () => {
  assert.equal(strikeStep(STRIKES), 50)
  assert.equal(strikeStep([22500]), null)
})

test('a column is marked where its biggest OI change sits at ATM or one strike either side - added or removed alike', () => {
  const change = matrix({
    22600: [10, 0, 900],       // column 3: the biggest, but two strikes above ATM
    22550: [500, 0, 0],        // column 1: the biggest, ATM + 1, OI added
    22500: [20, -800, 100],    // column 2: the biggest, ATM itself, OI removed (unwinding)
    22450: [30, 300, 0],
    22400: [0, 0, 0],
  })
  const marked = atmPeakCells(change, COLUMNS, STRIKES, () => 22500)
  assert.deepEqual([...marked.get(COLUMNS[0])], [22550])
  assert.deepEqual([...marked.get(COLUMNS[1])], [22500])
  assert.equal(marked.has(COLUMNS[2]), false, 'the biggest change is away from ATM - nothing marked')
})

test('a column with no change, or no ATM known, marks nothing; a tie at ATM ± 1 marks each', () => {
  const change = matrix({ 22600: [0, 0, 0], 22550: [0, 400, 0], 22500: [0, -400, 0], 22450: [0, 0, 0], 22400: [0, 0, 0] })
  assert.equal(atmPeakCells(change, COLUMNS, STRIKES, () => 22500).has(COLUMNS[0]), false)
  assert.deepEqual([...atmPeakCells(change, COLUMNS, STRIKES, () => 22500).get(COLUMNS[1])].sort(), [22500, 22550])
  assert.equal(atmPeakCells(change, COLUMNS, STRIKES, () => null).size, 0)
})

test('a far strike matching the biggest change: the biggest is not at ATM - nothing marked', () => {
  // Column 1: ATM and 22400 (two strikes below) both +300. Column 2: every strike +10 (a quiet, even minute).
  const change = matrix({ 22600: [0, 10, 0], 22550: [0, 10, 0], 22500: [300, 10, 0], 22450: [0, 10, 0], 22400: [-300, 10, 0] })
  const marked = atmPeakCells(change, COLUMNS, STRIKES, () => 22500)
  assert.equal(marked.has(COLUMNS[0]), false)
  assert.equal(marked.has(COLUMNS[1]), false)
})

test("each column is read against its own ATM - the spot as that column ends, not today's", () => {
  // Spot 22510 in the first two minutes, then 22610: ATM 22500, then 22600.
  const bars = [0, 1, 2].map((i) => ({ time: COLUMNS[i], close: i < 2 ? 22510 : 22610 }))
  const atmAt = atmAtFromBars(bars, 50)
  assert.equal(atmAt(COLUMNS[0], 60), 22500)
  assert.equal(atmAt(COLUMNS[2], 60), 22600)
  assert.equal(atmAt(T - 120, 60), null, 'before the first bar')
  // A 3-minute column [T, T + 180) ends after the third bar: ATM 22600.
  assert.equal(atmAt(T, 180), 22600)
  const change = matrix({ 22600: [0, 0, 0], 22550: [0, 0, 700], 22500: [0, 0, 0], 22450: [600, 0, 0], 22400: [0, 0, 0] })
  const marked = atmPeakCells(change, COLUMNS, STRIKES, (t) => atmAt(t, 60))
  assert.deepEqual([...marked.get(COLUMNS[0])], [22450], 'ATM 22500 then: 22450 is ATM - 1')
  assert.deepEqual([...marked.get(COLUMNS[2])], [22550], 'ATM 22600 by then: 22550 is ATM - 1')
})
