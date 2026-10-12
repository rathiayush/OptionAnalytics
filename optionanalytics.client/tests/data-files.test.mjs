// The Data files page's helpers (src/dataFiles.js): sizes in words and a CSV read into a table - quoted fields,
// commas and quotes inside them, CRLF, and a file cut off part-way (its half line dropped). Run: npm test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bytesText, parseCsv } from '../src/dataFiles.js'

test('sizes in words', () => {
  assert.equal(bytesText(0), '0 B')
  assert.equal(bytesText(1536), '1.5 KB')
  assert.equal(bytesText(5 * 1024 * 1024), '5.0 MB')
  assert.equal(bytesText(300 * 1024 * 1024), '300 MB')
})

test('a CSV into a header and rows', () => {
  const t = parseCsv('time,strategy,note\r\n10:00,wallBreak,"held, then ran"\r\n10:05,trap,"said ""go"""\r\n')
  assert.deepEqual(t.header, ['time', 'strategy', 'note'])
  assert.deepEqual(t.rows, [['10:00', 'wallBreak', 'held, then ran'], ['10:05', 'trap', 'said "go"']])
  assert.deepEqual(parseCsv('a,b\n1,2').rows, [['1', '2']], 'no newline at the end: the last row is kept')
  assert.deepEqual(parseCsv('a,b\n1,2\n3,', { partialLastLine: true }).rows, [['1', '2']], 'cut off: the half line is dropped')
  assert.deepEqual(parseCsv('a,b\n\n1,2\n').rows, [['1', '2']], 'blank lines skipped')
  assert.deepEqual(parseCsv('').header, [])
})
