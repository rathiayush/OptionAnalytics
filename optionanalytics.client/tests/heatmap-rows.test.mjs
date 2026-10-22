// The liquidity heatmap's own row size (the dropdown on its card): only its picture changes - the heatmap the
// scanner, the liquidity reads and the replayed book use stays exactly in the footprint's rows.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bucketBook, heatmapFetchRow, rebucketColumns, replayView, rowsNest } from '../src/orderFlowMath.js'
import { applyOrderFlowPush, withFineHeatmap } from '../src/liveFeeds.js'

const ROWS = [0.5, 1, 2, 5, 10, 20]

// A whole book in the server's 0.5-point heat rows, around 22710.
function book(seed = 1) {
  let x = seed
  const rand = () => { x = (x * 16807) % 2147483647; return x / 2147483647 }
  const bids = []
  const asks = []
  for (let i = 1; i <= 120; i++) {
    bids.push([22710 - i * 0.5, Math.round(rand() * 900) + 75])
    asks.push([22710 + i * 0.5, Math.round(rand() * 900) + 75])
  }
  return { bids: bids.reverse(), asks }
}

test('rowsNest: whole numbers of rows only', () => {
  assert.equal(rowsNest(5, 1), true)
  assert.equal(rowsNest(1, 0.5), true)
  assert.equal(rowsNest(5, 2), false)
  assert.equal(rowsNest(0.5, 1), false)
  assert.equal(rowsNest(1, 1), true)
})

test('heatmapFetchRow: the footprint rows unless finer ones are needed, then the largest row both are made of', () => {
  assert.equal(heatmapFetchRow(1, 1), 1)
  assert.equal(heatmapFetchRow(1, 5), 1) // coarser: re-bucketed on the page, nothing new fetched
  assert.equal(heatmapFetchRow(5, 20), 5)
  assert.equal(heatmapFetchRow(5, 1), 1)
  assert.equal(heatmapFetchRow(1, 0.5), 0.5)
  assert.equal(heatmapFetchRow(2, 5), 1)
  assert.equal(heatmapFetchRow(20, 10), 10)
  assert.equal(heatmapFetchRow(5, 0.5), 0.5)
})

test('re-bucketing the fetched rows gives exactly the rows the server would send - for every pair', () => {
  const { bids, asks } = book(7)
  for (const rowSize of ROWS) {
    for (const heatRow of ROWS) {
      const fineRow = heatmapFetchRow(rowSize, heatRow)
      const fetched = { t: 1, bids: bucketBook(bids, fineRow), asks: bucketBook(asks, fineRow) }
      const [read] = rebucketColumns([fetched], rowSize)
      assert.deepEqual(read.bids, bucketBook(bids, rowSize), `${rowSize} / ${heatRow}: bids`)
      assert.deepEqual(read.asks, bucketBook(asks, rowSize), `${rowSize} / ${heatRow}: asks`)
      if (rowsNest(heatRow, fineRow)) {
        const [shown] = rebucketColumns([fetched], heatRow)
        assert.deepEqual(shown.bids, bucketBook(bids, heatRow), `${rowSize} / ${heatRow}: shown`)
      }
    }
  }
})

test('rebucketColumns buckets each column once per row size', () => {
  const column = { t: 1, ...book(3) }
  const [a] = rebucketColumns([column], 5)
  const [b] = rebucketColumns([column], 5)
  assert.equal(a, b)
  assert.notEqual(rebucketColumns([column], 10)[0], a)
})

test('withFineHeatmap: the same rows change nothing; finer rows keep the picture apart and the heatmap in footprint rows', () => {
  const { bids, asks } = book(11)
  const view = { heatmap: [{ t: 1, bids: bucketBook(bids, 1), asks: bucketBook(asks, 1) }] }
  assert.equal(withFineHeatmap(view, 1, 1), view)
  const fine = { heatmap: [{ t: 1, bids: bucketBook(bids, 0.5), asks: bucketBook(asks, 0.5) }] }
  const out = withFineHeatmap(fine, 0.5, 1)
  assert.equal(out.heatFineRow, 0.5)
  assert.equal(out.heatFine, fine.heatmap)
  assert.deepEqual(out.heatmap, view.heatmap)
})

test('a live push adds the new column to both - the heatmap in footprint rows, the picture in its own', () => {
  const { bids, asks } = book(5)
  const base = { meta: { securityId: 1 }, trades: [], icebergs: [], sweeps: [], minuteBars: [], lastSeq: 0, heatmap: [] }
  const payload = { meta: { securityId: 1 }, time: '2026-10-22T04:00:00Z', heat: { bids, asks }, bars: [] }
  const plain = applyOrderFlowPush(base, payload, 5)
  assert.equal('heatFine' in plain, false)
  assert.deepEqual(plain.heatmap.at(-1).bids, bucketBook(bids, 5))

  const withFine = applyOrderFlowPush({ ...base, heatFine: [], heatFineRow: 1 }, payload, 5)
  assert.deepEqual(withFine.heatmap, plain.heatmap)
  assert.equal(withFine.heatFine.length, 1)
  assert.equal(withFine.heatFine[0].t, withFine.heatmap[0].t)
  assert.deepEqual(withFine.heatFine[0].bids, bucketBook(bids, 1))
  // Within the same column interval nothing is added to either.
  const again = applyOrderFlowPush(withFine, { ...payload, time: '2026-10-22T04:00:01Z' }, 5)
  assert.equal(again.heatmap.length, 1)
  assert.equal(again.heatFine.length, 1)
})

test('replay: the picture is cut at the clock like the heatmap (no look-ahead); a day without it has none', () => {
  const { bids, asks } = book(9)
  const columns = (row) => [0, 2000, 4000].map((t) => ({ t: 1_000_000 + t, bids: bucketBook(bids, row), asks: bucketBook(asks, row) }))
  const day = { meta: {}, minuteBars: [], trades: [], icebergs: [], sweeps: [], heatmap: columns(5), heatFine: columns(1), heatFineRow: 1 }
  const at = replayView(day, 1_002_500)
  assert.equal(at.heatmap.length, 2)
  assert.equal(at.heatFine.length, 2)
  assert.equal(at.heatFine.at(-1).t, at.heatmap.at(-1).t)
  // The replayed book still comes from the footprint-row heatmap.
  assert.equal(at.book.bids[0].price, bucketBook(bids, 5).at(-1)[0])
  const { heatFine: _drop, heatFineRow: _row, ...plainDay } = day
  assert.equal('heatFine' in replayView(plainDay, 1_002_500), false)
})
