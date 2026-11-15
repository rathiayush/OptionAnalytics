// The OI profile (oiProfile.js): OI change by price - futures OI on the futures' rows, option OI (PE − CE) on the spot's.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { futuresOiMinutes, oiProfileOf, optionOiMinutes } from '../src/oiProfile.js'

const T0 = Date.parse('2026-10-05T09:15:00+05:30')
const at = (m) => new Date(T0 + m * 60_000).toISOString()
const near = (a, b) => Math.abs(a - b) < 1e-9

test('futures: each minute\'s OI change on the rows its bar covered; + opened, − closed', () => {
  const bars = [
    { time: at(0), open: 100, high: 101, low: 100, close: 101, openInterest: 1000 },
    { time: at(1), open: 101, high: 104, low: 101, close: 104, openInterest: 1600 },   // +600 over 100..104
    { time: at(2), open: 104, high: 104, low: 102, close: 102, openInterest: 1600 },   // no change
    { time: at(3), open: 102, high: 102, low: 100, close: 100, openInterest: 1300 },   // −300 over 100..102
  ]
  const minutes = futuresOiMinutes(bars)
  assert.deepEqual(minutes.map((m) => m.oi), [600, -300])
  const p = oiProfileOf([minutes], { rowSize: 5 })
  // 101 - 104 is one 5-point row (100), 100 - 102 the same row: 600 - 300.
  assert.deepEqual(p.rows.map((r) => r.price), [100])
  assert.ok(near(p.rows[0].delta, 300))
  const fine = oiProfileOf([minutes], { rowSize: 1 })
  // +600 spread over 101..104 (4 rows), −300 over 100..102 (3 rows).
  const at101 = fine.rows.find((r) => r.price === 101)
  assert.ok(near(at101.delta, 150 - 100))
  assert.ok(near(fine.rows.find((r) => r.price === 104).delta, 150))
  assert.ok(near(fine.rows.find((r) => r.price === 100).delta, -100))
  assert.ok(near(fine.delta, 300))
  assert.equal(fine.built, 103.5)
  assert.equal(fine.unwound, 100.5)
})

test('options: each strike from its own first reading; NET = PE added − CE added on the spot\'s rows', () => {
  const spot = [0, 1, 2].map((m) => ({ time: T0 + m * 60_000, open: 200, high: 201, low: 200, close: 200 + m }))
  const ce = [
    { time: at(0), strike: 200, openInterest: 500 },
    { time: at(1), strike: 200, openInterest: 800 },      // +300 CE at minute 1
    { time: at(2), strike: 210, openInterest: 9000 },     // a strike's FIRST reading: 0, not +9000
  ]
  const pe = [
    { time: at(0), strike: 200, openInterest: 400 },
    { time: at(2), strike: 200, openInterest: 1400 },     // +1000 PE at minute 2
  ]
  const minutes = optionOiMinutes(ce, pe, spot)
  assert.deepEqual(minutes.map((m) => [m.ce, m.pe]), [[300, 0], [0, 1000]])
  const p = oiProfileOf([minutes], { rowSize: 10 })
  assert.deepEqual(p.rows.map((r) => r.price), [200])
  assert.ok(near(p.rows[0].delta, 1000 - 300))
  assert.ok(near(p.rows[0].ce, 300))
  assert.ok(near(p.rows[0].pe, 1000))
})

test('nothing after the clock: a profile at a clock = the one built from the minutes up to it', () => {
  const spot = Array.from({ length: 30 }, (_, m) => ({ time: T0 + m * 60_000, open: 200 + m, high: 202 + m, low: 199 + m, close: 201 + m }))
  const ce = [], pe = [], fut = []
  for (let m = 0; m < 30; m++) {
    for (const k of [200, 210, 220]) {
      ce.push({ time: at(m), strike: k, openInterest: 1000 + ((m * 37 + k) % 23) * 10 })
      pe.push({ time: at(m), strike: k, openInterest: 1000 + ((m * 53 + k) % 19) * 10 })
    }
    fut.push({ time: at(m), open: 200 + m, high: 203 + m, low: 199 + m, close: 202 + m, openInterest: 50_000 + ((m * 41) % 17) * 100 })
  }
  for (const k of [3, 11, 29]) {
    const clock = T0 + k * 60_000
    const cut = (list) => list.filter((p) => Date.parse(p.time) <= clock)
    assert.deepEqual(optionOiMinutes(ce, pe, spot, { asOfMs: clock }), optionOiMinutes(cut(ce), cut(pe), spot.slice(0, k + 1)))
    assert.deepEqual(futuresOiMinutes(fut, { asOfMs: clock }), futuresOiMinutes(cut(fut)))
  }
  // Sessions add up price by price.
  const a = futuresOiMinutes(fut.slice(0, 15)), b = futuresOiMinutes(fut.slice(15))
  const both = oiProfileOf([a, b], { rowSize: 5 })
  assert.ok(near(both.delta, oiProfileOf([a], { rowSize: 5 }).delta + oiProfileOf([b], { rowSize: 5 }).delta))
  assert.deepEqual(oiProfileOf([], { rowSize: 5 }).rows, [])
})
