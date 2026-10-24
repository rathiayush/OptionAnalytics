import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkpoints, checkpointStep, checkpointLabel } from '../src/halfHourMarks.js'

// Chart times are IST-shifted seconds: 09:15 IST on a day reads as 09:15 UTC.
const at = (h, m) => Date.UTC(2026, 9, 23, h, m) / 1000
const minutes = (fromH, fromM, count, step = 1) => Array.from({ length: count }, (_, i) => at(fromH, fromM) + i * step * 60)

test('labels read as IST HH:MM', () => {
  assert.equal(checkpointLabel(at(9, 30)), '09:30')
  assert.equal(checkpointLabel(at(15, 0)), '15:00')
})

test('every :00 and :30 of a 1-minute session is a checkpoint; the left edge is not', () => {
  const marks = checkpoints(minutes(9, 15, 376)) // 09:15 .. 15:30
  assert.deepEqual(marks.map((m) => m.label).slice(0, 4), ['09:30', '10:00', '10:30', '11:00'])
  assert.equal(marks.at(-1).label, '15:30')
  assert.equal(marks.length, 13)
})

test('a chart starting exactly on a half hour marks it', () => {
  assert.equal(checkpoints(minutes(9, 30, 10))[0].label, '09:30')
})

test('a gap puts the checkpoint on the next bar, labelled with its half hour', () => {
  const times = [at(9, 27), at(9, 28), at(9, 33), at(9, 34)]
  assert.deepEqual(checkpoints(times).map((m) => [m.time, m.label]), [[at(9, 33), '09:30']])
})

test('5-minute bars and hourly steps', () => {
  assert.deepEqual(checkpoints(minutes(9, 15, 20, 5)).map((m) => m.label), ['09:30', '10:00', '10:30'])
  assert.deepEqual(checkpoints(minutes(9, 15, 120), 3600).map((m) => m.label), ['10:00', '11:00'])
})

test('zoomed out, half hours give way to hours, then to longer steps', () => {
  assert.equal(checkpointStep(1 / 30), 1800)   // 60 px per half hour
  assert.equal(checkpointStep(1 / 60), 3600)   // 30 px per half hour -> hourly
  assert.equal(checkpointStep(1 / 1000), 86400)
})
