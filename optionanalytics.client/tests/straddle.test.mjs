// The OI Replay page's ATM straddle (straddle.js): from a set time, one line per strike that was the ATM - a new line
// when another strike becomes the ATM, the old one going on - never one line stitched across strikes; no look-ahead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { istClockOn, straddleLines } from '../src/straddle.js'

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
const straddle = (s, k, tv) => { const w = tv / phi(0); const c = callPrice(s, k, w); return c + (c - (s - k)) }

// A day minute by minute: spot(m), each leg's time value at the money tv(m).
function day({ minutes = 200, spot, tv = () => 70, skip = () => false }) {
  const ce = [], pe = [], spots = []
  for (let m = 0; m < minutes; m++) {
    const time = new Date(OPEN + m * MIN).toISOString()
    const s = spot(m)
    const w = tv(m) / phi(0)
    spots.push({ time: OPEN + m * MIN, close: s })
    for (const k of STRIKES) {
      const call = callPrice(s, k, w)
      const point = (price) => ({ time, strike: k, price, volume: 1000, impliedVolatility: 12, openInterest: 1e6 })
      if (!skip('ce', k, m)) ce.push(point(call))
      if (!skip('pe', k, m)) pe.push(point(call - (s - k)))
    }
  }
  return { ce, pe, spots }
}
const minuteOfDay = (hhmm) => (at(hhmm) - OPEN) / MIN
const valueAt = (line, hhmm) => line.data.find((p) => p.time === at(hhmm))?.value

test('the start time is IST on the day of the bars, configurable; the first line is the ATM strike then', () => {
  assert.equal(istClockOn(OPEN, '09:21'), at('09:21'))
  assert.equal(istClockOn(OPEN + 5 * 3600_000, '13:05'), at('13:05'))
  assert.equal(istClockOn(OPEN, '9:x'), null)

  const d = day({ spot: () => 25010 })
  const read = straddleLines(d.ce, d.pe, d.spots)
  assert.equal(read.lines.length, 1)
  const [line] = read.lines
  assert.equal(line.strike, 25000)
  assert.equal(line.from, at('09:21'))
  assert.equal(line.data[0].time, at('09:21'))
  assert.ok(Math.abs(line.start - straddle(25010, 25000, 70)) < 1e-9)
  assert.deepEqual(read.shifts, [])

  const later = straddleLines(d.ce, d.pe, d.spots, { start: '10:00' })
  assert.equal(later.lines[0].from, at('10:00'))
})

test('another strike becoming the ATM starts its own line; the old line goes on and rises as spot leaves it', () => {
  // Spot at 25000, then up to 25120 from 09:40.
  const d = day({ spot: (m) => (m < minuteOfDay('09:40') ? 25000 : 25120) })
  const read = straddleLines(d.ce, d.pe, d.spots)
  assert.deepEqual(read.lines.map((l) => l.strike), [25000, 25100])
  assert.deepEqual(read.shifts, [{ time: at('09:40'), from: 25000, to: 25100, spot: 25120 }])
  const [old, atm] = read.lines
  assert.equal(atm.from, at('09:40'))
  assert.equal(atm.data[0].time, at('09:40'))
  assert.ok(atm.atmNow && !old.atmNow)
  assert.equal(old.until, at('09:39'))
  // The old strike's own straddle all along - not the new ATM's: it is worth more now that spot left it.
  assert.ok(Math.abs(valueAt(old, '09:41') - straddle(25120, 25000, 70)) < 1e-9)
  assert.ok(valueAt(old, '09:41') > valueAt(old, '09:39') + 30)
  assert.ok(old.change > 30)
  assert.ok(Math.abs(valueAt(atm, '09:41') - straddle(25120, 25100, 70)) < 1e-9)
  // Neither line jumps from one strike to the other.
  assert.ok(old.data.every((p) => p.time < at('09:40') || Math.abs(p.value - straddle(25120, 25000, 70)) < 1e-9))
  assert.equal(read.now.strike, 25100)
})

test('a strike that becomes the ATM again goes on in its own line - no second line for it', () => {
  const d = day({ spot: (m) => (m < minuteOfDay('09:40') ? 25000 : m < minuteOfDay('10:10') ? 25110 : 25005) })
  const read = straddleLines(d.ce, d.pe, d.spots)
  assert.deepEqual(read.lines.map((l) => l.strike), [25000, 25100])
  assert.deepEqual(read.shifts.map((s) => [s.from, s.to]), [[25000, 25100], [25100, 25000]])
  const first = read.lines[0]
  assert.ok(first.atmNow)
  assert.equal(first.from, at('09:21'))
  // Its line has every minute from the start, through the time it was not the ATM.
  assert.equal(first.data.length, read.lines[1].data.length + minuteOfDay('09:40') - minuteOfDay('09:21'))
})

test('spot sitting at the midpoint between two strikes does not flip the ATM every minute', () => {
  // 25024 / 25026 / 25023 ... around the 25025 midpoint, never a tenth of a step (5) past it.
  const d = day({ spot: (m) => 25025 + (m % 2 ? 1.5 : -1.5) })
  const read = straddleLines(d.ce, d.pe, d.spots)
  assert.equal(read.shifts.length, 0)
  assert.equal(read.lines.length, 1)
  // Clearly past it: it switches.
  const moved = day({ spot: (m) => (m < minuteOfDay('09:40') ? 25020 : 25035) })
  assert.deepEqual(straddleLines(moved.ce, moved.pe, moved.spots).shifts.map((s) => s.to), [25050])
  // switchBuffer 0: the nearest strike every minute.
  assert.ok(straddleLines(d.ce, d.pe, d.spots, { switchBuffer: 0 }).shifts.length > 10)
})

test('only the strikes ATM most recently are drawn, the ATM now always among them', () => {
  // Spot stepping up a strike every 10 minutes: 25000, 25050, 25100, ... 25300.
  const d = day({ spot: (m) => 25000 + 50 * Math.min(6, Math.floor(Math.max(0, m - 6) / 10)) })
  const all = straddleLines(d.ce, d.pe, d.spots, { maxLines: null })
  assert.deepEqual(all.lines.map((l) => l.strike), [25000, 25050, 25100, 25150, 25200, 25250, 25300])
  assert.deepEqual(all.lines.map((l) => l.order), [0, 1, 2, 3, 4, 5, 6])
  const three = straddleLines(d.ce, d.pe, d.spots, { maxLines: 3 })
  assert.deepEqual(three.lines.map((l) => l.strike), [25200, 25250, 25300])
  assert.deepEqual(three.lines.map((l) => l.order), [4, 5, 6]) // colours stay the strikes'
  assert.equal(three.hidden, 4)
  assert.ok(three.lines.at(-1).atmNow)
})

test('nothing after the replay clock is used', () => {
  const d = day({ spot: (m) => (m < minuteOfDay('09:40') ? 25000 : 25120) })
  const atClock = straddleLines(d.ce, d.pe, d.spots, { asOfMs: at('09:39') + 30_000 })
  assert.equal(atClock.lines.length, 1)
  assert.equal(atClock.now.time, at('09:39'))
  assert.ok(atClock.lines[0].data.every((p) => p.time <= at('09:39')))
  // The same minutes read the same with or without the later bars.
  const cut = { ce: d.ce.filter((p) => Date.parse(p.time) <= at('09:39')), pe: d.pe.filter((p) => Date.parse(p.time) <= at('09:39')), spots: d.spots.filter((b) => b.time <= at('09:39')) }
  assert.deepEqual(straddleLines(cut.ce, cut.pe, cut.spots).lines, atClock.lines)
  // Before the start time: nothing yet.
  assert.equal(straddleLines(d.ce, d.pe, d.spots, { asOfMs: at('09:20') }).now, null)
})

test('a strike missing a leg for over 5 minutes is skipped for the next nearest', () => {
  const d = day({ spot: () => 25010, skip: (side, k, m) => side === 'pe' && k === 25000 && m >= 1 })
  const read = straddleLines(d.ce, d.pe, d.spots)
  // 09:21: the 25000 put last traded at 09:15 - over 5 minutes old - so 25050 is the nearest with both legs.
  assert.equal(read.lines[0].strike, 25050)
  assert.equal(read.lines.length, 1)
})
