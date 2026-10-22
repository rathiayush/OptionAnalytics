// Automatic support / resistance on the OI totals' cumulative lines (the totals charts popup).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { lineLevels } from '../src/lineLevels.js'
import { buildOiTotalsRows, oiTotalsSeries } from '../src/oiTotalsHeatmap.js'

// A line through the given turning values, `step` points per leg, one point a minute (chart seconds).
function path(turns, step = 10) {
  const values = [turns[0]]
  for (let k = 1; k < turns.length; k++) {
    for (let i = 1; i <= step; i++) values.push(turns[k - 1] + ((turns[k] - turns[k - 1]) * i) / step)
  }
  return values.map((value, i) => ({ time: 1000 + i * 60, value }))
}

test('a line turned back three times at 100 and twice at 0: resistance ×3 above, support ×2 below', () => {
  const read = lineLevels(path([0, 100, 0, 100, 0, 100, 50]))
  assert.equal(read.now, 50)
  assert.equal(read.resistance.role, 'resistance')
  assert.equal(Math.round(read.resistance.value), 100)
  assert.equal(read.resistance.touches, 3)
  assert.equal(Math.round(read.support.value), 0)
  assert.equal(read.support.touches, 2)
  assert.equal(read.resistance.brokenAt, null)
})

test('a resistance the line went through is support now, with when it broke', () => {
  const points = path([0, 100, 20, 100, 20, 150])
  const read = lineLevels(points)
  const broken = read.levels.find((l) => Math.round(l.value) === 100)
  assert.equal(broken.role, 'support')
  assert.equal(broken.formedAs, 'resistance')
  assert.equal(broken.brokeUp, true)
  // The first point above 100 on the last leg (20 -> 150 in 10 steps: 20, 33, ... 111 at step 7).
  assert.equal(broken.brokenAt, points[40 + 7].time)
  assert.equal(read.support, broken)
})

test('a support broken downward is resistance now', () => {
  const read = lineLevels(path([100, 0, 80, 0, 80, -60]))
  const broken = read.levels.find((l) => Math.round(l.value) === 0)
  assert.equal(broken.role, 'resistance')
  assert.equal(broken.brokeUp, false)
})

test('no look-ahead: a turn needs its later points - the newest few points never make a level', () => {
  // Rising to 100 at the very end, then only two points down: not yet a swing.
  const points = path([0, 100]).concat([{ time: 1000 + 11 * 60, value: 95 }, { time: 1000 + 12 * 60, value: 90 }])
  assert.equal(lineLevels(points).levels.length, 0)
  // With the third point after it, it is.
  const more = points.concat([{ time: 1000 + 13 * 60, value: 85 }])
  assert.equal(Math.round(lineLevels(more).resistance.value), 100)
  // And a level is only ever made from points up to the end of what is given.
  for (const l of lineLevels(more).levels) assert.ok(l.lastTime <= more.at(-1).time)
})

test('small wiggles are not levels; a flat or short line has none', () => {
  const wiggly = path([0, 100]).map((p, i) => ({ ...p, value: p.value + (i % 2 ? 2 : 0) }))
  assert.equal(lineLevels(wiggly).levels.length, 0)
  assert.equal(lineLevels(path([5, 5, 5])).levels.length, 0)
  assert.equal(lineLevels(path([0, 10], 3)).levels.length, 0)
  assert.equal(lineLevels([]).now, null)
})

test('at most three levels a side, the most-held first', () => {
  const read = lineLevels(path([0, 100, 10, 90, 20, 80, 30, 70, 40, 60, 50]), { minSwingPct: 0.05 })
  assert.ok(read.levels.filter((l) => l.role === 'resistance').length <= 3)
  assert.ok(read.levels.filter((l) => l.role === 'support').length <= 3)
})

test('oiTotalsSeries: the table rows as lines, each point with the meaning the table colours it by', () => {
  const m = (o) => new Map(Object.entries(o).map(([k, v]) => [Number(k), new Map(Object.entries(v).map(([t, x]) => [Number(t), x]))]))
  const totals = buildOiTotalsRows(m({ 100: { 60: 10, 120: -4 } }), m({ 100: { 60: 2, 120: 8 } }))
  const s = oiTotalsSeries(totals)
  assert.deepEqual(s.ce.cum.map((p) => [p.time, p.value]), [[60, 10], [120, 6]])
  assert.deepEqual(s.ce.delta.map((p) => p.meaning), [-1, 1]) // CE added = bearish, CE removed = bullish
  assert.deepEqual(s.pe.cum.map((p) => p.meaning), [1, 1]) // PE ahead = bullish
  assert.deepEqual(s.net.cum.map((p) => [p.value, p.meaning]), [[8, -1], [-4, 1]])
})
