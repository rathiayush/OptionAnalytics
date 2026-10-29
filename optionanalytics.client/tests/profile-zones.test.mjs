// The Profiles page's maths (profileZones.js): the bars known at a clock, the day's volume / market profile
// and the zones drawn as boxes - the volume profile's busy (HVN) and thin (LVN) areas, the market profile's
// accepted areas, single prints and tails.
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ZONE_RULES, barsKnownAt, candlesOf, compositeMarketProfile, dayMarketProfile, dayVolumeProfile, lastPeriodRunningAt, marketProfileZones,
  mergeSpotLive, pastSessionsNeeded, profileSessions, volumeZones,
} from '../src/profileZones.js'
import { mergeLiveFuturesTicks } from '../src/futuresLive.js'

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

test('"Days": the day so far and the sessions before it, or only the sessions before it', () => {
  const past = [['d1'], ['d2'], ['d3'], ['d4']] // oldest first
  const today = ['t']
  assert.deepEqual(profileSessions({ today, past, days: 1, of: 'today' }), [today])
  assert.deepEqual(profileSessions({ today, past, days: 3, of: 'today' }), [['d3'], ['d4'], today])
  assert.deepEqual(profileSessions({ today, past, days: 1, of: 'previous' }), [['d4']])
  assert.deepEqual(profileSessions({ today, past, days: 2, of: 'previous' }), [['d3'], ['d4']])
  // Fewer found than asked: as many as there are. No minutes yet today: the earlier sessions alone.
  assert.deepEqual(profileSessions({ today, past, days: 9, of: 'previous' }), past)
  assert.deepEqual(profileSessions({ today: [], past, days: 2, of: 'today' }), [['d4']])
  // An empty session (a holiday) never counts as one.
  assert.deepEqual(profileSessions({ today, past: [['d1'], []], days: 3, of: 'today' }), [['d1'], today])
  assert.equal(pastSessionsNeeded(1, 'today'), 0)
  assert.equal(pastSessionsNeeded(5, 'today'), 4)
  assert.equal(pastSessionsNeeded(5, 'previous'), 5)
  assert.equal(pastSessionsNeeded(500, 'previous'), 20)
})

test('a composite market profile adds every session\'s own TPOs - one session\'s A is not another\'s', () => {
  // Day 1: A 100-110, B 105-115. Day 2: A 100-105, B 110-120 - each day lettered from A.
  const day1 = periodBars([[100, 110], [105, 115]])
  const day2 = periodBars([[100, 105], [110, 120]]).map((b) => ({ ...b, time: new Date(Date.parse(b.time) + 86_400_000).toISOString() }))
  // One session: exactly that session's profile.
  assert.deepEqual(compositeMarketProfile([day1], 5), dayMarketProfile(day1, 5))
  const c = compositeMarketProfile([day1, day2], 5)
  const at = (price) => c.rows.find((r) => r.price === price)
  // 100: day 1 A + day 2 A = two TPOs (a merge by letter would count one).
  assert.deepEqual([at(100).letters, at(100).count], ['AA', 2])
  assert.deepEqual([at(105).letters, at(105).count], ['ABA', 3])
  assert.deepEqual([at(110).letters, at(110).count], ['ABB', 3])
  assert.deepEqual([at(120).letters, at(120).count], ['B', 1])
  assert.equal(c.sessions, 2)
  assert.equal(c.periods, 4)
  // The POC from the summed counts (105 and 110 tie - the one nearer the middle), the initial balance the last day's.
  assert.ok([105, 110].includes(c.poc))
  assert.deepEqual(c.ib, dayMarketProfile(day2, 5).ib)
  assert.equal(compositeMarketProfile([], 5), null)
})

test('a composite volume profile is every session\'s volume at each price added up', () => {
  const a = [{ time: iso(at(0)), open: 100, high: 101, low: 100, close: 101, levels: [{ price: 100, buy: 10, sell: 5 }] }]
  const b = [{ time: iso(at(0) + 86_400_000), open: 100, high: 106, low: 100, close: 106, levels: [{ price: 101, buy: 1, sell: 1 }, { price: 106, buy: 4, sell: 0 }] }]
  const vp = dayVolumeProfile([...a, ...b], 5)
  assert.deepEqual(vp.rows.map((r) => [r.price, r.total]), [[100, 17], [105, 4]])
})

test('live: footprint minutes (loaded) and candle minutes (the feed\'s since) make one volume profile', () => {
  const loaded = { time: iso(at(0)), open: 100, high: 104, low: 100, close: 104, levels: [{ price: 100, buy: 10, sell: 0 }, { price: 103, buy: 0, sell: 6 }] }
  const live = { time: iso(at(1)), open: 104, high: 109, low: 104, close: 108, volume: 20 } // no levels: spread over 100-105-row... 104 -> rows 100, 105
  const vp = dayVolumeProfile([loaded, live], 5)
  // Row 100: the footprint's 16 + half the live minute's 20 (it spans rows 100 and 105, an up candle - bought).
  assert.deepEqual(vp.rows.map((r) => [r.price, r.buy, r.sell]), [[100, 20, 6], [105, 10, 0]])
})

test('live spot: the newest prices, the open kept, and a minute\'s volume the most any source has', () => {
  const loaded = [
    { time: iso(at(0)), open: 100, high: 102, low: 99, close: 101, volume: 500 },
    { time: iso(at(1)), open: 101, high: 103, low: 100, close: 102, volume: 0 }, // the minute forming when it loaded
  ]
  // The feed's memory since: minute 1 finished, its volume re-read from Dhan; minute 2 from ticks - no volume yet.
  const feed = [
    { time: iso(at(1)), open: 101.5, high: 104, low: 100, close: 103, volume: 640 },
    { time: iso(at(2)), open: 103, high: 103.5, low: 102, close: 102.5, volume: 0 },
  ]
  // The push's forming minute (OHLC only), then a newer one.
  const live = [
    { time: iso(at(2) + 20_000), open: 103, high: 106, low: 102, close: 105 },
    { time: iso(at(3) + 5_000), open: 105, high: 105, low: 105, close: 105 },
  ]
  const day = mergeSpotLive(loaded, feed, live)
  assert.deepEqual(day.map((b) => [b.time, b.open, b.high, b.low, b.close, b.volume]), [
    [iso(at(0)), 100, 102, 99, 101, 500],
    [iso(at(1)), 101, 104, 100, 103, 640],
    [iso(at(2)), 103, 106, 102, 105, 0],
    [iso(at(3)), 105, 105, 105, 105, 0],
  ])
  // Outside the session: dropped.
  assert.equal(mergeSpotLive([{ time: iso(at(-30)), open: 1, high: 1, low: 1, close: 1, volume: 9 }]).length, 0)
})

test('the futures ticks fold into minutes, a minute\'s volume the rise of Dhan\'s day volume (OI Replay\'s fold)', () => {
  const ticks = [
    { underlying: 'NIFTY', time: iso(at(0) + 5_000), price: 100, open: 100, high: 100, low: 100, openInterest: 1, dayVolume: 1000 },
    { underlying: 'NIFTY', time: iso(at(0) + 40_000), price: 102, high: 102, low: 100, openInterest: 1, dayVolume: 1300 },
    { underlying: 'NIFTY', time: iso(at(1) + 10_000), price: 101, high: 101, low: 101, openInterest: 1, dayVolume: 1450 },
  ]
  const minutes = mergeLiveFuturesTicks([], ticks)
  assert.deepEqual(minutes.map((m) => [m.time, m.open, m.high, m.low, m.close, m.volume]), [
    [iso(at(0)), 100, 102, 100, 102, 300],
    [iso(at(1)), 101, 101, 101, 101, 150],
  ])
})
