import test from 'node:test'
import assert from 'node:assert/strict'
import { GAP_MIN_MS, columnAt, columnSpans, gapAt, isEmptyColumn, placeLabels, restingSince } from '../src/heatmapLayout.js'

// The liquidity heatmap's layout (asked for - "can we improve the liquidity heatmap on the data we have captured"): columns
// at their time, the stretches with no book named, the pills never over each other, how long a level has rested.

const T = Date.parse('2026-11-13T04:30:00Z') // 10:00 IST
const col = (t, bids = [[100, 10]], asks = [[101, 10]]) => ({ t, bids, asks })

test('each column sits at its time and runs to the next - the sampled morning and the live 2 s columns alike', () => {
  // The morning loaded as a sample (12 s apart), then the live feed's columns (2 s apart).
  const cols = [...Array.from({ length: 30 }, (_, i) => col(T + i * 12_000)), ...Array.from({ length: 30 }, (_, i) => col(T + 30 * 12_000 + i * 2000))]
  const { spans, gaps, startMs, endMs } = columnSpans(cols)
  assert.equal(gaps.length, 0, 'neither spacing is a gap')
  assert.deepEqual([spans[0].start, spans[0].end], [T, T + 12_000])
  assert.deepEqual([spans[29].start, spans[29].end], [T + 29 * 12_000, T + 30 * 12_000])
  assert.deepEqual([spans[30].start, spans[30].end], [T + 360_000, T + 362_000])
  assert.equal(startMs, T)
  assert.equal(endMs, T + 360_000 + 29 * 2000 + 2000, 'the last runs on by the spacing before it')
  // Columns cover time without holes or overlaps: a time's column is the one holding it.
  for (let i = 0; i < spans.length - 1; i++) assert.equal(spans[i].end, spans[i + 1].start)
  assert.equal(columnAt(spans, T + 5000), 0)
  assert.equal(columnAt(spans, T + 361_000), 30)
  assert.equal(columnAt(spans, T - 1), null)
})

test('a jump far past the spacing around it, or a column with no levels, is a stretch with no book', () => {
  // 2 s columns, then nothing for 3 minutes (a restart), then 2 s again with three empty columns (the depth feed away).
  const before = Array.from({ length: 20 }, (_, i) => col(T + i * 2000))
  const restartAt = T + 19 * 2000 + 180_000
  const after = Array.from({ length: 20 }, (_, i) => (i >= 5 && i < 8 ? col(restartAt + i * 2000, [], []) : col(restartAt + i * 2000)))
  const { spans, gaps } = columnSpans([...before, ...after])
  assert.equal(gaps.length, 2)
  assert.deepEqual(gaps[0], { start: T + 19 * 2000 + 2000, end: restartAt }, 'the restart: from where the last column would end to the next')
  assert.deepEqual(gaps[1], { start: restartAt + 5 * 2000, end: restartAt + 8 * 2000 }, 'the empty columns, one stretch')
  assert.equal(spans[19].end, T + 19 * 2000 + 2000, 'the column before the jump keeps its own width')
  assert.ok(isEmptyColumn(after[6]))
  assert.equal(columnAt(spans, restartAt + 6 * 2000 + 10), null, 'an empty column holds nothing to show')
  assert.deepEqual(gapAt(gaps, T + 100_000), gaps[0])
  assert.equal(gapAt(gaps, T + 1000), null)
  // A short pause - under GAP_MIN_MS - is not a gap even if it is a few times the spacing.
  const pause = columnSpans([col(T), col(T + 2000), col(T + 4000), col(T + 4000 + GAP_MIN_MS - 1000), col(T + 4000 + GAP_MIN_MS + 1000)])
  assert.equal(pause.gaps.length, 0)
  assert.deepEqual(columnSpans([]), { spans: [], gaps: [], startMs: null, endMs: null })
})

test('the pills: strongest first, none over another - above the anchor, else below, else a dot', () => {
  const items = [
    { x: 100, y: 100, w: 60, priority: 50, label: 'PULL 50%' },
    { x: 110, y: 100, w: 60, priority: 90, label: 'STACK 90%' },   // the strongest takes the place above
    { x: 120, y: 100, w: 60, priority: 70, label: 'PULL 70%' },    // next: below
    { x: 105, y: 102, w: 60, priority: 60, label: 'SPOOF 60%' },   // no room left: a dot
    { x: 400, y: 100, w: 60, priority: 10, label: 'PULL 10%' },    // far away: its own pill above
  ]
  const out = placeLabels(items, { width: 600, height: 300 })
  assert.equal(out[1].pill.y, 80)
  assert.equal(out[2].pill.y, 106)
  assert.equal(out[0].dot, true)
  assert.equal(out[3].dot, true)
  assert.equal(out[4].pill.y, 80)
  // No two pills overlap; each stays inside the plot.
  const pills = out.filter((o) => o.pill).map((o) => o.pill)
  for (const a of pills) for (const b of pills) if (a !== b) assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)
  for (const p of pills) assert.ok(p.x >= 1 && p.x + p.w <= 599 && p.y >= 1 && p.y + p.h <= 299)
  // Near the top edge the pill is kept inside.
  assert.equal(placeLabels([{ x: 5, y: 3, w: 40, priority: 1 }], { width: 600, height: 300 })[0].pill.y, 1)
})

test('how long a level has rested: back while it holds at least half its size, stopped by less, no book or a gap', () => {
  const at = (i) => T + i * 2000
  const cols = [
    col(at(0), [[100, 50]]), col(at(1), [[100, 300]]), col(at(2), [[100, 600]]), col(at(3), [[100, 550]]), col(at(4), [[100, 800]]),
  ]
  // Now 800: 550 and 600 hold at least half (400); 300 does not - since column 2.
  assert.deepEqual(restingSince(cols, 4, 'bid', 100), { since: at(2), quantity: 800 })
  assert.equal(restingSince(cols, 4, 'ask', 100), null, 'nothing resting there on that side')
  assert.equal(restingSince(cols, 0, 'bid', 100).since, at(0), 'the first column rests from itself')
  // An empty column (no book) or a gap in time ends the walk.
  const withHole = [col(at(0), [[100, 900]]), col(at(1), [], []), col(at(2), [[100, 900]])]
  assert.equal(restingSince(withHole, 2, 'bid', 100).since, at(2))
  const jumped = [col(T, [[100, 900]]), col(T + 2000, [[100, 900]]), col(T + 2000 + 600_000, [[100, 900]])]
  assert.equal(restingSince(jumped, 2, 'bid', 100, { spans: columnSpans(jumped).spans }).since, T + 2000 + 600_000)
})
