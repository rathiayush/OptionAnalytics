// The admin Cache page's pure parts (cacheBrowser.js): sizes in words, the folder trail, what a delete removes and what it
// did, and the rows' order.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EVERYTHING_URL, countOf, crumbsOf, deleteText, deletedText, downloadText, downloadUrl, formatBytes, parentOf, sortEntries } from '../src/cacheBrowser.js'

test('sizes in words', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.50 KB')
  assert.equal(formatBytes(12.3 * 1024 * 1024), '12.3 MB')
  assert.equal(formatBytes(4.07 * 1024 ** 3), '4.07 GB')
  assert.equal(formatBytes(250 * 1024 ** 3), '250 GB')
  assert.equal(formatBytes(-1), '—')
  assert.equal(formatBytes(undefined), '—')
  assert.equal(countOf(1, 'file'), '1 file')
  assert.equal(countOf(12345, 'file'), '12,345 files')
})

test('the trail to a folder, and the folder above', () => {
  assert.deepEqual(crumbsOf('v1/charts-intraday/days'), [
    { name: 'v1', path: 'v1' }, { name: 'charts-intraday', path: 'v1/charts-intraday' }, { name: 'days', path: 'v1/charts-intraday/days' },
  ])
  assert.deepEqual(crumbsOf(''), [])
  assert.equal(parentOf('v1/charts-intraday/days'), 'v1/charts-intraday')
  assert.equal(parentOf('v1'), '')
  assert.equal(parentOf(''), '')
})

test('a delete says what it removes, and what it did', () => {
  assert.equal(deleteText({ name: '2026-10', folder: true, files: 1234, bytes: 5 * 1024 ** 2 }), 'Delete the folder "2026-10" and everything in it - 1,234 files, 5.00 MB?')
  assert.equal(deleteText({ name: 'a.json.gz', folder: false, files: 1, bytes: 2048 }), 'Delete "a.json.gz" (2.00 KB)?')
  assert.equal(deletedText({ files: 12, bytes: 3.4 * 1024 ** 2, failed: 0 }), 'Deleted 12 files (3.40 MB)')
  assert.equal(deletedText({ files: 1, bytes: 10, failed: 2, firstError: 'busy' }), 'Deleted 1 file (10 B) - 2 items could not be deleted: busy')
})

test('folders first, then by the column asked', () => {
  const rows = [
    { name: 'b.gz', folder: false, bytes: 10, modifiedUtc: '2026-11-01T00:00:00Z' },
    { name: 'z', folder: true, bytes: 5, modifiedUtc: '2026-10-01T00:00:00Z' },
    { name: 'a.gz', folder: false, bytes: 99, modifiedUtc: '2026-11-05T00:00:00Z' },
    { name: 'm', folder: true, bytes: 500, modifiedUtc: '2026-11-06T00:00:00Z' },
  ]
  assert.deepEqual(sortEntries(rows).map((r) => r.name), ['m', 'z', 'a.gz', 'b.gz'])
  assert.deepEqual(sortEntries(rows, 'bytes').map((r) => r.name), ['m', 'z', 'a.gz', 'b.gz'])
  assert.deepEqual(sortEntries(rows, 'modified').map((r) => r.name), ['m', 'z', 'a.gz', 'b.gz'])
  assert.deepEqual(sortEntries([{ name: 'x', folder: false, bytes: 1 }, { name: 'y', folder: false, bytes: 2 }], 'bytes').map((r) => r.name), ['y', 'x'])
})

test('a download: a file as it is, a folder or a whole cache as one zip, every cache in one zip - each said before it starts', () => {
  assert.equal(downloadUrl('dhan', 'v1/charts-intraday'), '/api/cache/dhan/download?path=v1%2Fcharts-intraday')
  assert.equal(downloadUrl('order-flow', ''), '/api/cache/order-flow/download?path=')
  assert.equal(EVERYTHING_URL, '/api/cache/everything.zip')
  assert.equal(downloadText({ name: 'v1', folder: true, files: 21345, bytes: 4.2 * 1024 ** 3 }), 'Download "v1" as one zip - 21,345 files, 4.20 GB?')
  assert.equal(downloadText({ name: 'a.csv', folder: false, files: 1, bytes: 1024 }), 'Download "a.csv" (1.00 KB)?')
})
