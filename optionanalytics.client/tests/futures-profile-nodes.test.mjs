// The futures chart's previous-day profile marks its HVN and LVN like the entry charts do (profiles.profileNodes on
// a candle-spread profile), drawn as price lines in the previous session's colours (setProfileLines).
import test from 'node:test'
import assert from 'node:assert/strict'
import { volumeProfileFromCandles } from '../src/orderFlowMath.js'
import { histogramNodes, profileNodes, sessionVolumeProfile } from '../src/profiles.js'
import { setProfileLines } from '../src/volumeProfilePrimitive.js'
import { PREV_PROFILE } from '../src/profileColors.js'

// Two busy areas (peaking at 100 and at 140, the lower one busiest) with a thin stretch between them: candles of every
// width around each centre, so the volume piles up towards it as in a real session.
function twoAreaDay() {
  const candles = []
  const around = (mid, volume) => { for (let w = 1; w <= 6; w++) for (let i = 0; i < 5; i++) candles.push({ open: mid - w, close: mid + w, high: mid + w, low: mid - w, volume }) }
  around(100, 9000)
  around(140, 6000)
  for (let i = 0; i < 6; i++) candles.push({ open: 106, close: 134, high: 134, low: 106, volume: 400 })
  return candles
}

test('a candle-spread profile gets its HVN (the second busy area) and LVN (the thin stretch between)', () => {
  const profile = volumeProfileFromCandles(twoAreaDay(), 2)
  assert.ok(profile.poc >= 94 && profile.poc <= 106, `POC in the busiest area (${profile.poc})`)
  const nodes = profileNodes(profile)
  assert.ok(nodes.hvnTop >= 134 && nodes.hvnTop <= 146, `HVN in the second area (${nodes.hvnTop})`)
  assert.ok(nodes.lvnTop > 106 && nodes.lvnTop < 134, `LVN between the two (${nodes.lvnTop})`)
})

test('no rows, no nodes', () => {
  assert.deepEqual(profileNodes(volumeProfileFromCandles([], 2)), { hvn: [], lvn: [], hvnTop: null, lvnTop: null })
  assert.deepEqual(profileNodes(null), { hvn: [], lvn: [], hvnTop: null, lvnTop: null })
})

test('sessionVolumeProfile keeps its nodes (the same rule, now shared)', () => {
  const vp = sessionVolumeProfile([])
  assert.deepEqual([vp.hvn, vp.lvn, vp.hvnTop, vp.lvnTop], [[], [], null, null])
})

// The futures chart reads its nodes the way the SPOT one does (the server's rule), not the stricter rule the
// strategies read - a profile built by spreading each minute's volume over its range is smooth enough that the
// strict rule finds no LVN on a real day, and the two charts' levels sit side by side.
test('the futures nodes are a strict local peak / trough of the raw rows, the POC and the edges left out', () => {
  const rows = [
    { price: 100, total: 10 }, { price: 101, total: 90 }, { price: 102, total: 40 },
    { price: 103, total: 70 }, { price: 104, total: 20 }, { price: 105, total: 55 }, { price: 106, total: 5 },
  ]
  const n = histogramNodes({ rows, poc: 101 })
  assert.deepEqual(n.hvn, [103, 105])      // 90 is the POC's own row; 103 and 105 are the other peaks
  assert.equal(n.hvnTop, 103)              // the bigger of them
  assert.deepEqual(n.lvn, [102, 104])      // the troughs between them
  assert.equal(n.lvnTop, 104)              // the thinner of them
})

test('a smooth, single-peaked day still gets its nodes where the strict rule gives none', () => {
  // One hump: the strict rule (profileNodes) wants a peak 1.3x the mean and a trough BETWEEN the peaks.
  const rows = [10, 30, 70, 120, 70, 30, 10].map((total, i) => ({ price: 100 + i, total }))
  const profile = { rows, poc: 103 }
  assert.equal(profileNodes(profile).lvnTop, null)
  // ...and the server's rule gives none either - there is no interior trough at all. Nothing is invented.
  assert.equal(histogramNodes(profile).lvnTop, null)
  // Two humps with a dip between them: the futures rule finds it, the strict one does not (the dip is not
  // under 0.6x the mean once the humps are close).
  const twoHumps = [10, 60, 100, 70, 100, 60, 10].map((total, i) => ({ price: 100 + i, total }))
  assert.equal(histogramNodes({ rows: twoHumps, poc: 102 }).lvnTop, 103)
})

test('too few rows, or none, is no nodes rather than a crash', () => {
  assert.deepEqual(histogramNodes({ rows: [], poc: null }), { hvn: [], lvn: [], hvnTop: null, lvnTop: null })
  assert.deepEqual(histogramNodes(null), { hvn: [], lvn: [], hvnTop: null, lvnTop: null })
  assert.deepEqual(histogramNodes({ rows: [{ price: 1, total: 1 }, { price: 2, total: 2 }] }).hvn, [])
})

test('the futures chart draws POC, VAH, VAL, HVN and LVN in the previous session\'s colours', () => {
  const created = []
  const removed = []
  const series = { createPriceLine: (o) => { created.push(o); return o }, removePriceLine: (l) => removed.push(l) }
  const profile = { ...volumeProfileFromCandles(twoAreaDay(), 2) }
  Object.assign(profile, histogramNodes(profile))
  const lines = setProfileLines(series, ['old'], profile, 2, ' (27 Oct)')
  assert.deepEqual(removed, ['old'])
  const byTitle = Object.fromEntries(lines.map((l) => [l.title, l]))
  assert.deepEqual(Object.keys(byTitle).sort(), ['HVN', 'LVN', 'POC (27 Oct)', 'VAH', 'VAL'])
  assert.equal(byTitle['POC (27 Oct)'].color, PREV_PROFILE.poc)
  assert.equal(byTitle.VAH.color, PREV_PROFILE.va)
  assert.equal(byTitle.HVN.color, PREV_PROFILE.hvn)
  assert.equal(byTitle.LVN.color, PREV_PROFILE.lvn)
  assert.equal(byTitle.HVN.price, profile.hvnTop + 1) // the row's middle
  assert.equal(byTitle.LVN.price, profile.lvnTop + 1)
})

test('a profile without nodes draws just POC / VAH / VAL', () => {
  const series = { createPriceLine: (o) => o, removePriceLine: () => {} }
  const profile = volumeProfileFromCandles([{ open: 100, close: 102, high: 102, low: 100, volume: 1000 }], 2)
  const titles = setProfileLines(series, [], { ...profile, ...histogramNodes(profile) }, 2).map((l) => l.title).sort()
  assert.deepEqual(titles, ['POC', 'VAH', 'VAL'])
})

// ---- The spot / entry charts' volume-profile BARS (profiles.binsProfile -> VolumeProfilePrimitive) ----
// The server bins the previous day by each bar's CLOSE, so a real day's histogram is sparse: plenty of bins
// never traded. The row size has to come from the bins themselves, not only the ones that did.
function serverBins({ low = 22600, high = 22800, count = 60, traded = (i) => i % 3 === 0 } = {}) {
  const size = (high - low) / count
  return Array.from({ length: count }, (_, i) => ({
    price: Math.round((low + (i + 0.5) * size) * 100) / 100,
    volume: traded(i) ? 1000 * (i + 1) : 0,
  }))
}

test('the bars are a row per traded bin, one bin tall, at the bin BOTTOM price', async () => {
  const { binsProfile } = await import('../src/profiles.js')
  const bins = serverBins()
  const p = binsProfile({ bins, poc: bins[30].price, vah: bins[40].price, val: bins[20].price })
  const binSize = bins[1].price - bins[0].price
  assert.ok(Math.abs(p.rowSize - binSize) < 0.01, `row = one bin (${p.rowSize} vs ${binSize})`)
  assert.equal(p.rows.length, bins.filter((b) => b.volume > 0).length)   // only the bins that traded are drawn
  assert.ok(p.rows.every((r) => r.buy === 0 && r.sell === 0 && r.total > 0))  // no side of their own: one neutral bar
  assert.equal(p.maxRow, Math.max(...bins.map((b) => b.volume)))
  // Rows and levels are both at the bin's BOTTOM, so the value-area shading lines up with the VAH / VAL lines.
  assert.ok(Math.abs(p.rows[0].price - (bins[0].price - binSize / 2)) < 0.01)
  assert.ok(Math.abs(p.poc - (bins[30].price - binSize / 2)) < 0.01)
})

test('a day with one traded bin, or none, draws no bars at all', async () => {
  const { binsProfile } = await import('../src/profiles.js')
  assert.equal(binsProfile({ bins: serverBins({ traded: () => false }) }), null)
  assert.equal(binsProfile({ bins: [{ price: 100, volume: 5 }] }), null)
  assert.equal(binsProfile({ bins: [] }), null)
  assert.equal(binsProfile(null), null)
})
