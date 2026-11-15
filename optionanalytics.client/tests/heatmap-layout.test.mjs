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

// ---- As the professional heatmaps draw it: cutoffs + contrast curve, BBO, volume dots, the current order book ----
import { HEAT_BANDS, bestQuotes, cobBars, heatLevel, heatScale, volumeDots } from '../src/heatmapLayout.js'
import { rowOf } from '../src/orderFlowMath.js'

test('the colour scale: each colour band a fixed share of the sizes in view (Bookmap\'s percentage cutoffs)', () => {
  const sizes = Array.from({ length: 1000 }, (_, i) => i + 1) // 1 .. 1000
  const s = heatScale(sizes)
  assert.deepEqual(s.knots, [[501, 0], [801, 0.3], [931, 0.55], [981, 0.8], [996, 1]])
  assert.equal(heatLevel(300, s), 0, 'the bottom half: the dark background')
  assert.equal(heatLevel(999, s), 1, 'the top 0.5%: the brightest')
  assert.ok(Math.abs(heatLevel(651, s) - 0.15) < 1e-9, 'straight between two knots')
  assert.ok(heatLevel(800, s) < heatLevel(900, s), 'bigger is brighter')
  // Adaptive: the same wall is less bright among bigger orders.
  assert.ok(heatLevel(900, heatScale(sizes)) > heatLevel(900, heatScale(sizes.map((q) => q * 2))))
  // A flat book still orders its bands; nothing in view does not fail.
  const flat = heatScale([5, 5, 5, 5])
  assert.ok(flat.knots.every((k, i) => i === 0 || k[0] > flat.knots[i - 1][0]))
  assert.equal(heatLevel(5, flat), 0)
  assert.equal(heatScale([]).knots.length, HEAT_BANDS.length)
})

test('unticked "Pro colours": the original heatmap\'s straight scale up to the 98th percentile', () => {
  const sizes = Array.from({ length: 100 }, (_, i) => i + 1)
  const s = heatScale(sizes, { classic: true })
  assert.deepEqual(s, { classic: true, cap: 99 })
  assert.equal(heatLevel(49.5, s), 0.5)
  assert.equal(heatLevel(150, s), 1)
  assert.equal(heatLevel(0, s), 0)
  assert.deepEqual(heatScale([], { classic: true }), { classic: true, cap: 1 })
})

test('a wall (4x the median size in view) is always hot, even when walls are many', () => {
  // A busy book: 10% of the cells are walls of ~6x the ordinary size.
  const sizes = [...Array.from({ length: 900 }, (_, i) => 100 + (i % 50)), ...Array.from({ length: 100 }, () => 700)]
  const s = heatScale(sizes)
  assert.ok(heatLevel(700, s) >= 0.8, `a 6x wall is at least yellow: ${heatLevel(700, s)}`)
  assert.equal(heatLevel(8 * s.median, s), 1, '8x the median: red')
  assert.ok(heatLevel(3.9 * s.median, s) < 1, 'under 4x: by its rank')
})

test('the same balance on a book: ~7% cyan or brighter, ~2 - 4% yellow or brighter, ~1% red', () => {
  let seed = 7
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd())
  for (const sigma of [0.2, 0.5, 0.7]) {
    const sizes = Array.from({ length: 20000 }, () => Math.exp(6 + sigma * gauss()) * (rnd() < 0.01 ? 8 + 7 * rnd() : 1))
    const s = heatScale(sizes)
    const share = (from) => sizes.filter((q) => heatLevel(q, s) >= from).length / sizes.length
    assert.ok(Math.abs(share(0.55) - 0.075) < 0.015, `sigma ${sigma}: cyan or brighter ${share(0.55)}`)
    assert.ok(share(0.8) >= 0.015 && share(0.8) <= 0.045, `sigma ${sigma}: yellow or brighter ${share(0.8)}`)
    assert.ok(share(1) <= 0.012, `sigma ${sigma}: red ${share(1)}`)
    assert.ok(Math.abs(share(1e-9) - 0.5) < 0.01, `sigma ${sigma}: half the book dark ${share(1e-9)}`)
  }
})

test('the best bid / ask of a column and the current order book bars', () => {
  const col = { t: 0, bids: [[99, 10], [100, 30], [98, 5]], asks: [[102, 7], [101, 50], [103, 0]] }
  assert.deepEqual(bestQuotes(col), { bid: 100, ask: 101 })
  assert.deepEqual(bestQuotes({ bids: [], asks: [[5, 1]] }), { bid: null, ask: 5 })
  const book = cobBars(col)
  assert.equal(book.max, 50)
  assert.equal(book.asks.length, 2, 'an empty level is not a bar')
  assert.deepEqual(cobBars(null), { bids: [], asks: [], max: 0 })
})

test('volume dots: every traded minute at each row, sized by its volume, with its delta; only the minutes in view', () => {
  const T = Date.parse('2026-11-13T04:00:00Z')
  const bars = [
    { time: new Date(T).toISOString(), levels: [{ price: 100, buy: 30, sell: 10 }, { price: 100.5, buy: 0, sell: 20 }, { price: 101, buy: 5, sell: 5 }] },
    { time: new Date(T + 60_000).toISOString(), levels: [{ price: 102, buy: 0, sell: 0 }, { price: 103, buy: 100, sell: 60 }] },
  ]
  const dots = volumeDots(bars, 1, rowOf)
  // Rows of 1 point: 100 and 100.5 are one row.
  const at100 = dots.find((d) => d.price === 100 && d.t === T + 30_000)
  assert.deepEqual([at100.volume, at100.delta], [60, 0])
  assert.equal(dots.filter((d) => d.t === T + 90_000).length, 1, 'a row with nothing traded has no dot')
  const biggest = dots.find((d) => d.price === 103)
  assert.equal(biggest.r, 1)
  assert.ok(Math.abs(at100.r - Math.sqrt(60 / 160)) < 1e-12)
  // Only the minutes overlapping the time in view.
  assert.equal(volumeDots(bars, 1, rowOf, { t0: T + 61_000, t1: T + 200_000 }).length, 1)
  assert.deepEqual(volumeDots(null, 1, rowOf), [])
})
