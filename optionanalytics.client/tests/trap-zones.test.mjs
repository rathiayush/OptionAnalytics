// Trapped / squeeze zones (trapZones.js): clusters, their role against price, the open rule, the crossings, no look-ahead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dayRead, mergeZones, openRuleDay, openingRead, profileRuns, readZones, sourceZones, zoneCrossings, zoneKind } from '../src/trapZones.js'

const T0 = Date.UTC(2026, 10, 16, 3, 45)  // 09:15 IST
const MIN = 60_000

test('runs of adjacent same-sign rows, the significant ones kept, merged across profiles', () => {
  const rows = [{ price: 100, delta: 5 }, { price: 105, delta: 7 }, { price: 110, delta: -2 }, { price: 120, delta: -9 }, { price: 125, delta: -1 }]
  const runs = profileRuns(rows, 5)
  assert.deepEqual(runs.map((r) => [r.low, r.high, r.sum, r.bullish]), [[100, 110, 12, true], [110, 115, -2, false], [120, 130, -10, false]])
  const oi = profileRuns(rows, 5, { bullishNegative: true })
  assert.deepEqual(oi.map((r) => r.bullish), [false, true, true])
  const z = sourceZones('cdv', rows, 5)
  assert.deepEqual(z.map((x) => [x.low, x.high, x.bullish, Math.round(x.strength * 100)]), [[100, 110, true, 100], [120, 130, false, 83]])   // -2 under 20% of 12: dropped
  const merged = mergeZones([...z, { source: 'oi', bullish: true, low: 105, high: 115, strength: 0.5 }])
  assert.deepEqual(merged.map((m) => [m.low, m.high, m.sources, m.score]), [[100, 115, ['oi', 'cdv'], 1.5], [120, 130, ['cdv'], 0.83]])
})

test('a zone\'s role against price: floor, trapped longs, ceiling, trapped shorts, inside', () => {
  const bull = { bullish: true, low: 100, high: 110 }, bear = { bullish: false, low: 100, high: 110 }
  assert.equal(zoneKind(bull, 120), 'support')
  assert.equal(zoneKind(bull, 90), 'trappedLongs')
  assert.equal(zoneKind(bear, 90), 'resistance')
  assert.equal(zoneKind(bear, 120), 'trappedShorts')
  assert.equal(zoneKind(bear, 105), 'insideBear')
  const r = readZones([{ ...bull, score: 1 }, { bullish: false, low: 140, high: 150, score: 1 }], 112)
  assert.equal(r.zones[0].kind, 'support')
  assert.ok(r.lean > 0)   // the floor is nearer than the ceiling
})

// A day: spot opens at 25000; puts written in the rows under it, then price rises.
function spotDay(n, path) { return Array.from({ length: n }, (_, k) => { const c = path(k); return { time: T0 + k * MIN, open: k ? path(k - 1) : c, high: c + 2, low: c - 2, close: c } }) }

test('the open rule: puts written below the open and price above it = bullish, held 3 minutes; the mirror', () => {
  const spot = spotDay(20, (k) => (k < 5 ? 24990 - k : 24990 + (k - 4) * 5))
  const oi = spot.slice(0, 6).map((b) => ({ t: b.time, low: b.low, high: b.high, ce: 10, pe: 400 }))
  const r = openRuleDay({ oi, spot, open: spot[0].open, rowSize: 5 })
  assert.equal(r.state, 'bull')
  assert.ok(r.below < 0)
  // On only once it held 3 minutes after the close went over the open.
  const firstAbove = spot.findIndex((b) => b.close > spot[0].open)
  assert.equal(r.since, spot[firstAbove].time)
  // A cut before that minute + 2 = not on yet: nothing read from later minutes.
  const cut = openRuleDay({ oi, spot: spot.slice(0, firstAbove + 2), open: spot[0].open, rowSize: 5 })
  assert.equal(cut.state, null)
  // Mirror: calls written above, price below.
  const down = spotDay(20, (k) => (k < 5 ? 25010 + k : 25010 - (k - 4) * 5))
  const oiDown = down.slice(0, 6).map((b) => ({ t: b.time, low: b.low, high: b.high, ce: 400, pe: 10 }))
  assert.equal(openRuleDay({ oi: oiDown, spot: down, open: down[0].open, rowSize: 5 }).state, 'bear')
})

test('crossings of the previous zones: a ceiling closed above = short squeeze, back inside = failed', () => {
  const zone = { bullish: false, low: 25020, high: 25030 }
  const spot = spotDay(12, (k) => [25010, 25015, 25025, 25035, 25040, 25028, 25045, 25050, 25050, 25050, 25050, 25050][k])
  const e = zoneCrossings([zone], spot)
  assert.deepEqual(e.map((x) => [x.type, (x.t - T0) / MIN]), [['shortSqueeze', 3], ['failedUp', 5], ['shortSqueeze', 6]])
})

test('opening read from the session before and the day read up to the clock (no look-ahead)', () => {
  const prevSpot = spotDay(30, (k) => 24900 + k * 5)
  const prevOi = prevSpot.map((b, k) => ({ t: b.time, low: b.low, high: b.high, ce: k > 20 ? 300 : 5, pe: k < 8 ? 300 : 5 }))
  const prev = { date: '2026-11-13', items: [], oi: prevOi, candles: prevSpot }
  const opening = openingRead({ prevOptions: [prev], prevFutures: [], rowSize: 5 })
  assert.equal(opening.close, prevSpot.at(-1).close)
  assert.ok(opening.zones.some((z) => z.bullish && z.kind === 'support'))      // puts written low in the day: a floor under the close
  assert.ok(opening.zones.some((z) => !z.bullish))                               // calls written late: sellers' cluster
  const spot = spotDay(40, (k) => 25050 + k * 3)
  const oi = spot.slice(0, 10).map((b) => ({ t: b.time, low: b.low - 60, high: b.low - 50, ce: 5, pe: 300 }))
  const whole = dayRead({ opening, oi, spot, rowSize: 5 })
  assert.ok(whole.score > 0 && /bullish/i.test(whole.verdict))
  // A cut at minute 20 = the day read from minutes 0 - 20 alone.
  const cut = dayRead({ opening, oi: oi.filter((m) => m.t <= spot[20].time), spot: spot.slice(0, 21), rowSize: 5 })
  assert.equal(cut.price, spot[20].close)
  assert.deepEqual(cut.crossings.filter((c) => c.t > spot[20].time), [])
})
