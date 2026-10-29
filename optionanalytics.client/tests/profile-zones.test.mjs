// The Profiles page's maths (profileZones.js): the bars known at a clock, the day's volume / market profile
// and the zones drawn as boxes - the volume profile's busy (HVN) and thin (LVN) areas, the market profile's
// accepted areas, single prints and tails.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ZONE_RULES, barsKnownAt, candlesOf, dayMarketProfile, dayVolumeProfile, lastPeriodRunningAt, marketProfileZones, volumeZones,
} from '../src/profileZones.js'

const MIN = 60_000
const T915 = Date.parse('2026-10-05T03:45:00Z') // 09:15 IST
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()

// A volume profile with its rows given directly ([price, total] at 10-point rows).
const vpOf = (pairs) => {
  const rows = pairs.map(([price, total]) => ({ price, buy: total / 2, sell: total / 2, total }))
  const poc = rows.reduce((b, r) => (r.total > b.total ? r : b)).price
  return { rows, poc, vah: null, val: null }
}

test('a replay sees only the minutes COMPLETED by its clock, and only the session', () => {
  const bars = [
    { time: iso(at(-5)), open: 1, high: 1, low: 1, close: 1 },  // 09:10 - before the open
    { time: iso(at(0)), open: 1, high: 1, low: 1, close: 1 },   // 09:15
    { time: iso(at(1)), open: 1, high: 1, low: 1, close: 1 },   // 09:16
    { time: iso(at(2)), open: 1, high: 1, low: 1, close: 1 },   // 09:17
  ]
  // At 09:17:00 the 09:16 minute has just finished; the 09:17 one has not.
  assert.deepEqual(barsKnownAt(bars, at(2)).map((b) => b.time), [iso(at(0)), iso(at(1))])
  assert.deepEqual(barsKnownAt(bars, at(2) + 59_000).map((b) => b.time), [iso(at(0)), iso(at(1))])
  assert.equal(barsKnownAt(bars, at(3)).length, 3)
  // Live (no clock): every bar of the session, the running minute too - never the pre-open one.
  assert.equal(barsKnownAt(bars, null).length, 3)
  assert.equal(barsKnownAt(null).length, 0)
})

test('the volume profile is built from the footprint levels, in the row picked', () => {
  const bars = [
    { time: iso(at(0)), open: 100, high: 104, low: 100, close: 104, levels: [{ price: 100, buy: 10, sell: 0 }, { price: 101, buy: 5, sell: 5 }, { price: 104, buy: 0, sell: 7 }] },
    { time: iso(at(1)), open: 104, high: 107, low: 104, close: 106, levels: [{ price: 106, buy: 3, sell: 0 }] },
  ]
  const vp = dayVolumeProfile(bars, 5)
  assert.deepEqual(vp.rows.map((r) => [r.price, r.buy, r.sell]), [[100, 15, 12], [105, 3, 0]])
  assert.equal(vp.poc, 100)
  // No levels at all: each candle's volume spread over its range instead.
  const plain = dayVolumeProfile([{ time: iso(at(0)), open: 100, high: 109, low: 100, close: 109, volume: 100 }], 5)
  assert.deepEqual(plain.rows.map((r) => [r.price, r.total]), [[100, 50], [105, 50]])
})

test('two busy areas with a thin one between: two HVN boxes, one LVN box, the POC area marked', () => {
  // Busy 100-120 (POC 110), thin 140-160, busy 170-190; the profile's own edges are thin too.
  const vp = vpOf([[80, 5], [90, 20], [100, 90], [110, 120], [120, 95], [130, 40], [140, 8], [150, 5], [160, 9], [170, 80], [180, 100], [190, 75], [200, 30], [210, 4]])
  const z = volumeZones(vp, 10)
  assert.equal(z.high.length, 2)
  const [first, second] = z.high // by volume
  assert.deepEqual([first.low, first.high, first.node, first.poc], [100, 130, 115, true])
  assert.deepEqual([second.low, second.high, second.node, second.poc], [170, 200, 185, false])
  assert.ok(first.share > second.share && first.share < 1)
  // The thin area INSIDE the profile, its LVN at its thinnest row; the thin top and bottom edges are not gaps.
  assert.equal(z.low.length, 1)
  assert.deepEqual([z.low[0].low, z.low[0].high, z.low[0].node], [140, 170, 155])
  // HVN = the busy area that is not the POC's; LVN = the gap's node.
  assert.deepEqual(z.hvn, [185])
  assert.deepEqual(z.lvn, [155])
})

test('a flat profile has no zones; at most maxZones of each', () => {
  assert.deepEqual(volumeZones(vpOf([[100, 10], [110, 10], [120, 10], [130, 10]]), 10), { high: [], low: [], hvn: [], lvn: [] })
  assert.deepEqual(volumeZones(null, 10), { high: [], low: [], hvn: [], lvn: [] })
  // Four separate busy areas with gaps between them, kept to two.
  const pairs = []
  for (let k = 0; k < 4; k++) pairs.push([100 + k * 60, 5], [110 + k * 60, 100 - k], [120 + k * 60, 5], [130 + k * 60, 2], [140 + k * 60, 2], [150 + k * 60, 5])
  const z = volumeZones(vpOf(pairs), 10, { ...ZONE_RULES, maxZones: 2 })
  assert.equal(z.high.length, 2)
  assert.ok(z.low.length <= 2)
})

test('a row nobody traded inside the range counts as thin - the grid is full', () => {
  // 120 and 130 missing entirely (a jump): still an LVN gap between the two busy areas.
  const vp = vpOf([[90, 10], [100, 100], [110, 80], [140, 80], [150, 100], [160, 10]])
  const z = volumeZones(vp, 10)
  assert.equal(z.low.length, 1)
  assert.deepEqual([z.low[0].low, z.low[0].high], [120, 140])
})

// One bar per 30-minute period covering [low, high] - periods A, B, C... from 09:15.
const periodBars = (ranges) => ranges.map(([low, high], i) => ({ time: iso(at(i * 30)), open: low, high, low, close: high }))

// A: 100-120, B: 115-135, C: 125-135, D: 135-155 (a fast move up), E: 155-160, F: 125-135.
// Rows (5 points; a bar marks every row from its low's up to its high's): 100-110 A only (a buying tail),
// 115-120 AB, 125-130 BCF, 135 BCDF (POC), 140-150 D only (single prints between 135 and 155), 155 DE,
// 160 E only (one row - the high, not a tail).
const RANGES = [[100, 120], [115, 135], [125, 135], [135, 155], [155, 160], [125, 135]]

test('market profile: accepted area, single prints inside, a buying tail - and a one-row high is not a tail', () => {
  const tpo = dayMarketProfile(periodBars(RANGES), 5)
  assert.equal(tpo.poc, 135)
  assert.equal(tpo.periods, 6)
  const z = marketProfileZones(tpo)
  // Where the market spent its time: rows with at least 0.7 x the POC row's TPOs (4 -> 3 or more).
  assert.deepEqual(z.accepted.map((a) => [a.low, a.high, a.poc]), [[125, 140, true]])
  // The fast move: D alone, with more than one period on both sides.
  assert.deepEqual(z.singles.map((s) => [s.low, s.high, s.rows, s.forming]), [[140, 155, 3, false]])
  // A alone at the low for three rows, ending at a row two periods visited.
  assert.deepEqual(z.tails.map((t) => [t.side, t.low, t.high, t.rows]), [['buying', 100, 115, 3]])
  // The value area contains the POC row; the initial balance is A + B.
  assert.ok(z.value.low <= 135 && z.value.high >= 140)
  assert.deepEqual(z.ib, { kind: 'ib', low: 100, high: 135 })
})

test('a tail made only by the period still running is forming; once that period is over it is not', () => {
  // G: 160-175 - E reached 160, so 165-175 are G alone at the top: a selling tail of three rows.
  const bars = periodBars([...RANGES, [160, 175]])
  const tpo = dayMarketProfile(bars, 5)
  const running = marketProfileZones(tpo, { lastPeriodRunning: true }).tails.find((t) => t.side === 'selling')
  assert.deepEqual([running.low, running.high, running.rows, running.forming], [165, 180, 3, true])
  assert.equal(marketProfileZones(tpo, { lastPeriodRunning: false }).tails.find((t) => t.side === 'selling').forming, false)
  // The buying tail is A's - not the running period's - so never forming.
  assert.equal(marketProfileZones(tpo, { lastPeriodRunning: true }).tails.find((t) => t.side === 'buying').forming, false)
})

test('one period is not a profile yet: no single prints, no tails, no accepted areas', () => {
  const tpo = dayMarketProfile(periodBars([[100, 130]]), 5)
  const z = marketProfileZones(tpo, { lastPeriodRunning: true })
  assert.deepEqual([z.singles, z.tails, z.accepted], [[], [], []])
  assert.ok(z.value)
  assert.deepEqual(marketProfileZones(null), { value: null, accepted: [], singles: [], tails: [], ib: null })
})

test('the last TPO period is running until its 30 minutes are over', () => {
  const bars = [{ time: iso(at(31)), open: 1, high: 1, low: 1, close: 1 }] // 09:46 - period B, 09:45 - 10:15
  assert.equal(lastPeriodRunningAt(bars, null), true)
  assert.equal(lastPeriodRunningAt(bars, at(32)), true)
  assert.equal(lastPeriodRunningAt(bars, at(59) + 59_000), true)
  assert.equal(lastPeriodRunningAt(bars, at(60)), false)
  assert.equal(lastPeriodRunningAt([], at(60)), false)
})

test('candles of a timeframe are bucketed on the clock', () => {
  const bars = [0, 1, 2, 3, 4, 5, 6].map((m) => ({ time: iso(at(m)), open: 10 + m, high: 20 + m, low: m, close: 11 + m, buy: 1, sell: 2 }))
  const five = candlesOf(bars, 5)
  assert.equal(five.length, 2)
  assert.deepEqual(five[0], { time: at(0), open: 10, high: 24, low: 0, close: 15, volume: 15 })
  assert.deepEqual(five[1], { time: at(5), open: 15, high: 26, low: 5, close: 17, volume: 6 })
})

test('no look-ahead: what comes after the clock changes nothing in the profiles or their boxes', () => {
  const day = periodBars([...RANGES, [160, 175], [90, 100]])
  // Every minute of each period, so the clock can stop inside one.
  const minutes = []
  day.forEach((b, i) => { for (let k = 0; k < 30; k++) minutes.push({ ...b, time: iso(at(i * 30 + k)), levels: [{ price: b.low, buy: 10 + k, sell: 5 }, { price: b.high, buy: 3, sell: 9 + i }] }) })
  const clock = at(3 * 30 + 12) // inside D
  const known = barsKnownAt(minutes, clock)
  const later = barsKnownAt([...minutes, { time: iso(at(400)), open: 500, high: 600, low: 400, close: 550 }], clock)
  assert.deepEqual(later, known)
  assert.ok(known.every((b) => Date.parse(b.time) + MIN <= clock))
  assert.deepEqual(volumeZones(dayVolumeProfile(later, 5), 5), volumeZones(dayVolumeProfile(known, 5), 5))
  assert.deepEqual(marketProfileZones(dayMarketProfile(later, 5)), marketProfileZones(dayMarketProfile(known, 5)))
})
