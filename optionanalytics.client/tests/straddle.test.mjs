// The OI Replay page's ATM straddle read (straddle.js): the straddle from a set time, its VWAP, the priced range, a new
// range only after an accepted break, the sideways check and the read (sideways / drift / trend / breakout / fake), and
// no look-ahead.
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
  const read = straddleRead(d.ce, d.pe, d.spots, { start: '09:21' })
  assert.equal(read.series[0].time, at('09:21'))
  assert.equal(read.day.strike, 25000)
  // The straddle at 09:21: the 25000 call + put, spot 10 above the strike.
  const call = callPrice(25010, 25000, 70 / phi(0))
  assert.ok(Math.abs(read.day.value - (2 * call - 10)) < 1e-9)
  assert.ok(Math.abs(read.day.upper - (25000 + read.day.value)) < 1e-9 && Math.abs(read.day.lower - (25000 - read.day.value)) < 1e-9)

  const later = straddleRead(d.ce, d.pe, d.spots, { start: '10:00' })
  assert.equal(later.series[0].time, at('10:00'))
  assert.equal(later.series.length, read.series.length - 39)
})

test('the ATM straddle follows the strike nearest spot each minute; its VWAP is weighted by the legs\' volume', () => {
  const d = day({ spot: (m) => (m < minuteOfDay('09:40') ? 25000 : 25120), tv: () => 60, volume: (m) => (m % 2 ? 3000 : 1000) })
  const read = straddleRead(d.ce, d.pe, d.spots, { acceptMinutes: 0 })
  assert.equal(read.series.find((p) => p.time === at('09:39')).strike, 25000)
  const after = read.series.find((p) => p.time === at('09:40'))
  assert.equal(after.strike, 25100)
  const ceAt = (k, t) => d.ce.find((p) => p.strike === k && Date.parse(p.time) === t).price
  const peAt = (k, t) => d.pe.find((p) => p.strike === k && Date.parse(p.time) === t).price
  assert.equal(after.value, ceAt(25100, at('09:40')) + peAt(25100, at('09:40')))
  // A move inside the range never moves the range.
  assert.equal(read.ranges.length, 1)
  // VWAP = sum(value x (CE + PE volume)) / sum(volume) since the range started.
  const upTo = read.series.filter((p) => p.time <= at('09:45'))
  const vols = upTo.map((p) => 2 * ((p.time - OPEN) / MIN % 2 ? 3000 : 1000))
  const vwap = upTo.reduce((a, p, i) => a + p.value * vols[i], 0) / vols.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(read.series.find((p) => p.time === at('09:45')).vwap - vwap) < 1e-9)

  // No volume known (a live minute): the plain average.
  const quiet = day({ spot: () => 25000, tv: (m) => 80 - m * 0.1, volume: () => 0 })
  const q = straddleRead(quiet.ce, quiet.pe, quiet.spots)
  const mean = q.series.slice(0, 10).reduce((a, p) => a + p.value, 0) / 10
  assert.ok(Math.abs(q.series[9].vwap - mean) < 1e-9)
})

test('a break held for the accept minutes starts a new range at the new ATM; one that comes back is a failed break', () => {
  // The 09:21 range is 25000 ± ~120; spot jumps to 25200 at 10:00 and stays.
  const held = day({ spot: (m) => (m < minuteOfDay('10:00') ? 25000 : 25200), tv: () => 60 })
  const read = straddleRead(held.ce, held.pe, held.spots, { acceptMinutes: 10 })
  assert.deepEqual(read.ranges.map((r) => [r.time, r.strike, r.reason]), [[at('09:21'), 25000, 'start'], [at('10:09'), 25200, 'up']])
  const [first, second] = read.ranges
  assert.deepEqual(first.breaks.map((b) => [b.side, b.from, b.accepted]), [['up', at('10:00'), at('10:09')]])
  assert.ok(Math.abs(second.upper - (25200 + second.value)) < 1e-9)
  // The VWAP starts again with the new range; the centre straddle is the new range's strike.
  const p = read.series.find((x) => x.time === at('10:09'))
  assert.equal(p.vwap, p.value)
  assert.equal(p.rangeIndex, 1)
  assert.equal(p.centre, p.value)
  // The day's range stays the 09:21 one, and says when it broke.
  assert.equal(read.day.strike, 25000)
  assert.equal(read.dayBreaks.up, at('10:00'))
  // Just re-centred: a new range, read before a verdict.
  const fresh = straddleRead(held.ce, held.pe, held.spots, { acceptMinutes: 10, asOfMs: at('10:15') })
  assert.equal(fresh.verdict.kind, 'new-range')
  assert.equal(fresh.verdict.side, 'up')

  // Back inside before 10 minutes: a failed break - no new range, and the read says so.
  const back = day({ spot: (m) => (m >= minuteOfDay('10:00') && m < minuteOfDay('10:06') ? 25200 : 25000), tv: (m) => 75 - m * 0.08 })
  const failed = straddleRead(back.ce, back.pe, back.spots, { acceptMinutes: 10, asOfMs: at('11:00') })
  assert.equal(failed.ranges.length, 1)
  assert.deepEqual([failed.failed.side, failed.failed.from, failed.failed.to, failed.failed.accepted], ['up', at('10:00'), at('10:06'), null])
  assert.match(failed.verdict.notes.join(' '), /failed break up \(10:00 – 10:06\)/)

  // Never re-centred.
  assert.equal(straddleRead(held.ce, held.pe, held.spots, { acceptMinutes: 0 }).ranges.length, 1)
})

test('sideways: spot inside, the straddle under its VWAP and the centre straddle below its start value', () => {
  const d = day({ spot: (m) => 25000 + 15 * Math.sin(m / 7), tv: (m) => 75 - m * 0.08 })
  const read = straddleRead(d.ce, d.pe, d.spots, { asOfMs: at('11:30') })
  assert.deepEqual(read.checks, { inside: true, premiumFalling: true, centreBelowStart: true, ivSteady: true })
  assert.equal(read.verdict.kind, 'sideways')
  assert.ok(read.centre.sellerPnl > 0)
  // Too early to read in the first minutes.
  assert.equal(straddleRead(d.ce, d.pe, d.spots, { asOfMs: at('09:30') }).verdict.kind, 'early')
  // The straddle fading while IV rises: the fall is time decay, said so.
  const decay = day({ spot: () => 25000, tv: (m) => 75 - m * 0.08, iv: (m) => 12 + m * 0.05 })
  const r = straddleRead(decay.ce, decay.pe, decay.spots, { asOfMs: at('11:30') })
  assert.equal(r.checks.ivSteady, false)
  assert.match(r.verdict.notes.join(' '), /time decay/)
})

test('drift: premium still falling but spot walking off the centre - not sideways', () => {
  // Spot walks from 25000 to 25090 (inside the ±~120 range) while the straddle decays slowly.
  const d = day({ spot: (m) => 25000 + Math.min(m, 90), tv: (m) => 60 - m * 0.03 })
  const read = straddleRead(d.ce, d.pe, d.spots, { asOfMs: at('11:00') })
  assert.equal(read.position, 'inside')
  assert.equal(read.checks.premiumFalling, true)
  assert.equal(read.checks.centreBelowStart, false)
  assert.equal(read.verdict.kind, 'drift')
  assert.equal(read.verdict.side, 'up')
})

test('trend, then the move accepted, then sideways at the new level', () => {
  // Quiet until 10:00, a rally to 25300 by 10:30 with the straddle bid up, then flat with the straddle fading.
  const spot = (m) => (m < minuteOfDay('10:00') ? 25000 : Math.min(25000 + (m - minuteOfDay('10:00')) * 10, 25300))
  const tv = (m) => (m < minuteOfDay('10:00') ? 60 : m < minuteOfDay('10:30') ? 60 + (m - minuteOfDay('10:00')) * 0.6 : 78 - (m - minuteOfDay('10:30')) * 0.15)
  const d = day({ minutes: 300, spot, tv })
  // Not accepted yet (never re-centred): spot beyond the range, the straddle over its VWAP.
  const trend = straddleRead(d.ce, d.pe, d.spots, { acceptMinutes: 0, asOfMs: at('10:28') })
  assert.equal(trend.position, 'above')
  assert.equal(trend.verdict.kind, 'trend')
  assert.equal(trend.verdict.side, 'up')
  // Accepted: new ranges along the way, then the last one goes quiet - sideways there.
  const later = straddleRead(d.ce, d.pe, d.spots, { acceptMinutes: 10, asOfMs: at('12:30') })
  assert.ok(later.ranges.length >= 2)
  assert.equal(later.ranges.at(-1).reason, 'up')
  assert.equal(later.verdict.kind, 'sideways')
  assert.equal(later.dayBreaks.up != null, true)
})

test('a break the straddle does not confirm is called fake; an upside break needs only the straddle to stop falling', () => {
  // Spot jumps over the range while the straddle keeps falling fast: fake.
  const jump = (m) => (m < minuteOfDay('10:00') ? 25000 : 25200)
  const fading = day({ spot: jump, tv: (m) => 75 - m * 0.25 })
  const fake = straddleRead(fading.ce, fading.pe, fading.spots, { acceptMinutes: 0, asOfMs: at('10:30') })
  assert.equal(fake.position, 'above')
  assert.equal(fake.verdict.kind, 'fake')
  assert.equal(fake.outsideFor, 31)
  // The same below the range: a real breakdown lifts the straddle.
  const drop = day({ spot: (m) => (m < minuteOfDay('10:00') ? 25000 : 24800), tv: (m) => 75 - m * 0.25 })
  const down = straddleRead(drop.ce, drop.pe, drop.spots, { acceptMinutes: 0, asOfMs: at('10:30') })
  assert.equal(down.position, 'below')
  assert.equal(down.verdict.kind, 'fake')
  assert.equal(down.verdict.side, 'down')

  // Above the range, the straddle under its VWAP but no longer falling (IV lower on a rally): breakout.
  const flatAfter = (m) => (m < minuteOfDay('10:00') ? 75 - m * 0.4 : 75 - minuteOfDay('10:00') * 0.4)
  const settled = day({ spot: jump, tv: flatAfter })
  const breakout = straddleRead(settled.ce, settled.pe, settled.spots, { acceptMinutes: 0, asOfMs: at('10:45') })
  assert.equal(breakout.control, 'sellers')
  assert.equal(breakout.verdict.kind, 'breakout')
  // ... which below the range is still not a confirmed breakdown.
  const settledDown = day({ spot: (m) => (m < minuteOfDay('10:00') ? 25000 : 24800), tv: flatAfter })
  assert.equal(straddleRead(settledDown.ce, settledDown.pe, settledDown.spots, { acceptMinutes: 0, asOfMs: at('10:45') }).verdict.kind, 'fake')
})

test('nothing after the replay clock is used', () => {
  const d = day({ spot: (m) => 25000 + 4 * m, tv: (m) => 70 + 10 * Math.sin(m / 11) })
  const clock = at('10:37') + 25_000
  const cut = (points) => points.filter((p) => new Date(p.time).getTime() < at('10:38'))
  const whole = straddleRead(d.ce, d.pe, d.spots, { asOfMs: clock })
  const known = straddleRead(cut(d.ce), cut(d.pe), cut(d.spots), { asOfMs: clock })
  assert.equal(whole.series.at(-1).time, at('10:37'))
  assert.deepEqual(whole, known)
  // The replay not started yet (clock 0): nothing.
  const none = straddleRead(d.ce, d.pe, d.spots, { asOfMs: 0 })
  assert.equal(none.series.length, 0)
  assert.equal(none.startMs, at('09:21'))
})

test('a strike missing a leg for over 5 minutes is skipped for the next nearest', () => {
  // The 25000 put stops printing at 10:00.
  const d = day({ spot: () => 25010, tv: () => 60, skip: (side, k, m) => side === 'pe' && k === 25000 && m >= minuteOfDay('10:00') })
  const read = straddleRead(d.ce, d.pe, d.spots, { acceptMinutes: 0 })
  assert.equal(read.series.find((p) => p.time === at('10:04')).strike, 25000)   // its 09:59 reading, 5 minutes old
  assert.equal(read.series.find((p) => p.time === at('10:05')).strike, 25050)
})
