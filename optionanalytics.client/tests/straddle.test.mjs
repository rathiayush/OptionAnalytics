// The OI Replay page's ATM straddle read (straddle.js): the straddle from a set time, its VWAP, the priced range, the
// re-centre after a move, the read (sideways / trend / breakout / fake) and no look-ahead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { istClockOn, straddleRead } from '../src/straddle.js'

const MIN = 60_000
const OPEN = Date.parse('2026-10-20T09:15:00+05:30')
const at = (hhmm) => Date.parse(`2026-10-20T${hhmm}:00+05:30`)
const STRIKES = Array.from({ length: 17 }, (_, i) => 24600 + 50 * i)

// Option prices the way the market sets them (Bachelier: a normal spread of `w` points to expiry) - so the straddle at a
// strike next to spot is only slightly above the one at spot, as on a real chain.
const phi = (x) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI)
function cdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const tail = phi(x) * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return x >= 0 ? 1 - tail : tail
}
const callPrice = (s, k, w) => (s - k) * cdf((s - k) / w) + w * phi((s - k) / w)

// A day minute by minute: spot(m), each leg's time value at the money tv(m), IV iv(m), volume per leg per minute.
function day({ minutes = 200, spot, tv, iv = () => 12, volume = () => 1000, skip = () => false }) {
  const ce = [], pe = [], spots = []
  for (let m = 0; m < minutes; m++) {
    const time = new Date(OPEN + m * MIN).toISOString()
    const s = spot(m)
    const w = tv(m) / phi(0)
    spots.push({ time: OPEN + m * MIN, close: s })
    for (const k of STRIKES) {
      const call = callPrice(s, k, w)
      const point = (price) => ({ time, strike: k, price, volume: volume(m), impliedVolatility: iv(m), openInterest: 1e6 })
      if (!skip('ce', k, m)) ce.push(point(call))
      if (!skip('pe', k, m)) pe.push(point(call - (s - k)))
    }
  }
  return { ce, pe, spots }
}
const minuteOfDay = (hhmm) => (at(hhmm) - OPEN) / MIN

test('the start time is IST on the day of the bars, and configurable', () => {
  assert.equal(istClockOn(OPEN, '09:21'), at('09:21'))
  assert.equal(istClockOn(OPEN + 5 * 3600_000, '13:05'), at('13:05'))
  assert.equal(istClockOn(OPEN, '9:x'), null)

  const d = day({ spot: () => 25010, tv: () => 70 })
  const read = straddleRead(d.ce, d.pe, d.spots, { start: '09:21', step: 50 })
  assert.equal(read.series[0].time, at('09:21'))
  assert.equal(read.day.strike, 25000)
  // The straddle at 09:21: the 25000 call + put, spot 10 above the strike.
  const call = callPrice(25010, 25000, 70 / phi(0))
  assert.ok(Math.abs(read.day.value - (2 * call - 10)) < 1e-9)
  assert.ok(Math.abs(read.day.upper - (25000 + read.day.value)) < 1e-9 && Math.abs(read.day.lower - (25000 - read.day.value)) < 1e-9)

  const later = straddleRead(d.ce, d.pe, d.spots, { start: '10:00', step: 50 })
  assert.equal(later.series[0].time, at('10:00'))
  assert.equal(later.series.length, read.series.length - 39)
})

test('the straddle follows the strike nearest spot each minute; its VWAP is weighted by the legs\' volume', () => {
  const d = day({ spot: (m) => (m < minuteOfDay('09:40') ? 25000 : 25120), tv: () => 60, volume: (m) => (m % 2 ? 3000 : 1000) })
  const read = straddleRead(d.ce, d.pe, d.spots, { step: 50, recentreStrikes: 0 })
  const before = read.series.find((p) => p.time === at('09:39'))
  const after = read.series.find((p) => p.time === at('09:40'))
  assert.equal(before.strike, 25000)
  assert.equal(after.strike, 25100)
  const ceAt = (k, t) => d.ce.find((p) => p.strike === k && Date.parse(p.time) === t).price
  const peAt = (k, t) => d.pe.find((p) => p.strike === k && Date.parse(p.time) === t).price
  assert.equal(after.value, ceAt(25100, at('09:40')) + peAt(25100, at('09:40')))
  // VWAP = sum(value x (CE + PE volume)) / sum(volume) since the start.
  const upTo = read.series.filter((p) => p.time <= at('09:45'))
  const vols = upTo.map((p) => 2 * ((p.time - OPEN) / MIN % 2 ? 3000 : 1000))
  const vwap = upTo.reduce((a, p, i) => a + p.value * vols[i], 0) / vols.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(read.series.find((p) => p.time === at('09:45')).vwap - vwap) < 1e-9)

  // No volume known (a live minute): the plain average.
  const quiet = day({ spot: () => 25000, tv: (m) => 80 - m * 0.1, volume: () => 0 })
  const q = straddleRead(quiet.ce, quiet.pe, quiet.spots, { step: 50 })
  const mean = q.series.slice(0, 10).reduce((a, p) => a + p.value, 0) / 10
  assert.ok(Math.abs(q.series[9].vwap - mean) < 1e-9)
})

test('after a move the straddle is re-centred on the new ATM and the range read again from there', () => {
  // 25000 until 10:00, then 25060 (ATM 25050 - one strike), then 25110 at 10:30 (ATM 25100 - two strikes).
  const spot = (m) => (m < minuteOfDay('10:00') ? 25000 : m < minuteOfDay('10:30') ? 25060 : 25110)
  const d = day({ spot, tv: () => 60 })
  const two = straddleRead(d.ce, d.pe, d.spots, { step: 50, recentreStrikes: 2 })
  assert.deepEqual(two.anchors.map((a) => [a.time, a.strike]), [[at('09:21'), 25000], [at('10:30'), 25100]])
  const shifted = two.anchors[1]
  assert.ok(Math.abs(shifted.upper - (25100 + shifted.value)) < 1e-9)
  // Until the shift the straddle taken at 09:21 is still held at 25000 - its value includes the move.
  const p = two.series.find((x) => x.time === at('10:10'))
  assert.equal(p.anchorStrike, 25000)
  assert.ok(p.held > two.day.value)
  // The day's priced range stays the start's.
  assert.equal(two.day.strike, 25000)
  assert.equal(two.held.strike, 25100)

  const one = straddleRead(d.ce, d.pe, d.spots, { step: 50, recentreStrikes: 1 })
  assert.deepEqual(one.anchors.map((a) => a.strike), [25000, 25050, 25100])
  const never = straddleRead(d.ce, d.pe, d.spots, { step: 50, recentreStrikes: 0 })
  assert.deepEqual(never.anchors.map((a) => a.strike), [25000])
  assert.equal(never.held, null)
})

test('sideways: the straddle under its VWAP and spot inside the priced range', () => {
  const d = day({ spot: (m) => 25000 + 15 * Math.sin(m / 7), tv: (m) => 75 - m * 0.08 })
  const read = straddleRead(d.ce, d.pe, d.spots, { step: 50, asOfMs: at('11:30') })
  assert.equal(read.position, 'inside')
  assert.equal(read.control, 'sellers')
  assert.equal(read.verdict.kind, 'sideways')
  // Too early to read in the first minutes.
  assert.equal(straddleRead(d.ce, d.pe, d.spots, { step: 50, asOfMs: at('09:30') }).verdict.kind, 'early')
  // The straddle fading while IV rises: the fall is time decay, said so.
  const decay = day({ spot: () => 25000, tv: (m) => 75 - m * 0.08, iv: (m) => 12 + m * 0.05 })
  assert.match(straddleRead(decay.ce, decay.pe, decay.spots, { step: 50, asOfMs: at('11:30') }).verdict.note, /time decay/)
})

test('trend: spot beyond the range with the straddle over its VWAP; premium bought inside the range', () => {
  const rally = (m) => (m < minuteOfDay('10:00') ? 25000 : Math.min(25000 + (m - minuteOfDay('10:00')) * 10, 25300))
  const d = day({ spot: rally, tv: (m) => (m < minuteOfDay('10:00') ? 60 : 60 + (m - minuteOfDay('10:00')) * 0.6) })
  const read = straddleRead(d.ce, d.pe, d.spots, { step: 50, asOfMs: at('10:45') })
  assert.equal(read.position, 'above')
  assert.ok(read.breaks.up > at('10:00') && read.breaks.down == null)
  assert.equal(read.verdict.kind, 'trend')
  assert.equal(read.verdict.side, 'up')

  const building = day({ spot: () => 25000, tv: (m) => (m < minuteOfDay('10:00') ? 60 : 60 + (m - minuteOfDay('10:00')) * 0.5) })
  assert.equal(straddleRead(building.ce, building.pe, building.spots, { step: 50, asOfMs: at('10:30') }).verdict.kind, 'building')
})

test('a break the straddle does not confirm is called fake; an upside break needs only the straddle to stop falling', () => {
  // Spot jumps over the range while the straddle keeps falling fast: fake.
  const jump = (m) => (m < minuteOfDay('10:00') ? 25000 : 25200)
  const fading = day({ spot: jump, tv: (m) => 75 - m * 0.25 })
  const fake = straddleRead(fading.ce, fading.pe, fading.spots, { step: 50, asOfMs: at('10:30') })
  assert.equal(fake.position, 'above')
  assert.equal(fake.verdict.kind, 'fake')
  // The same below the range: a real breakdown lifts the straddle.
  const drop = day({ spot: (m) => (m < minuteOfDay('10:00') ? 25000 : 24800), tv: (m) => 75 - m * 0.25 })
  const down = straddleRead(drop.ce, drop.pe, drop.spots, { step: 50, asOfMs: at('10:30') })
  assert.equal(down.position, 'below')
  assert.equal(down.verdict.kind, 'fake')
  assert.equal(down.verdict.side, 'down')

  // Above the range, the straddle under its VWAP but no longer falling (IV lower on a rally): breakout.
  const settled = day({ spot: jump, tv: (m) => (m < minuteOfDay('10:00') ? 75 - m * 0.4 : 75 - minuteOfDay('10:00') * 0.4) })
  const breakout = straddleRead(settled.ce, settled.pe, settled.spots, { step: 50, asOfMs: at('10:45') })
  assert.equal(breakout.control, 'sellers')
  assert.equal(breakout.verdict.kind, 'breakout')
  // ... which below the range is still not a confirmed breakdown.
  const settledDown = day({ spot: (m) => (m < minuteOfDay('10:00') ? 25000 : 24800), tv: (m) => (m < minuteOfDay('10:00') ? 75 - m * 0.4 : 75 - minuteOfDay('10:00') * 0.4) })
  assert.equal(straddleRead(settledDown.ce, settledDown.pe, settledDown.spots, { step: 50, asOfMs: at('10:45') }).verdict.kind, 'fake')
})

test('nothing after the replay clock is used', () => {
  const d = day({ spot: (m) => 25000 + 4 * m, tv: (m) => 70 + 10 * Math.sin(m / 11) })
  const clock = at('10:37') + 25_000
  const cut = (points) => points.filter((p) => new Date(p.time).getTime() < at('10:38'))
  const whole = straddleRead(d.ce, d.pe, d.spots, { step: 50, asOfMs: clock })
  const known = straddleRead(cut(d.ce), cut(d.pe), cut(d.spots), { step: 50, asOfMs: clock })
  assert.equal(whole.series.at(-1).time, at('10:37'))
  assert.deepEqual(whole, known)
  // The replay not started yet (clock 0): nothing.
  const none = straddleRead(d.ce, d.pe, d.spots, { step: 50, asOfMs: 0 })
  assert.equal(none.series.length, 0)
  assert.equal(none.startMs, at('09:21'))
})

test('a strike missing a leg for over 5 minutes is skipped for the next nearest', () => {
  // The 25000 put stops printing at 10:00.
  const d = day({ spot: () => 25010, tv: () => 60, skip: (side, k, m) => side === 'pe' && k === 25000 && m >= minuteOfDay('10:00') })
  const read = straddleRead(d.ce, d.pe, d.spots, { step: 50, recentreStrikes: 0 })
  assert.equal(read.series.find((p) => p.time === at('10:04')).strike, 25000)   // its 09:59 reading, 5 minutes old
  assert.equal(read.series.find((p) => p.time === at('10:05')).strike, 25050)
})
