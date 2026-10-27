// The OI Replay page's straddle read (straddle.js): the Auto ATM straddle (ATM by the futures price) and the fixed one
// (never shifted) from a set time, their VWAPs, the priced range, the read (sideways / trend / breakout / fake) and no
// look-ahead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { STRADDLE_START_DEFAULT, istClockOn, straddleRead as readFrom } from '../src/straddle.js'

// The scenarios are timed from 09:21 (the default start is the 09:15 open - checked below).
const straddleRead = (ce, pe, spots, options = {}) => readFrom(ce, pe, spots, { start: '09:21', ...options })

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

// A day minute by minute: spot(m), each leg's time value at the money tv(m), IV iv(m), volume per leg per minute, and the
// futures' premium over spot carry(m) (the options are priced on the futures: call - put = futures - strike).
function day({ minutes = 200, spot, tv, iv = () => 12, volume = () => 1000, skip = () => false, carry = () => 0 }) {
  const ce = [], pe = [], spots = []
  for (let m = 0; m < minutes; m++) {
    const time = new Date(OPEN + m * MIN).toISOString()
    const s = spot(m)
    const w = tv(m) / phi(0)
    spots.push({ time: OPEN + m * MIN, close: s })
    const f = s + carry(m)
    for (const k of STRIKES) {
      const call = callPrice(f, k, w)
      const point = (price) => ({ time, strike: k, price, volume: volume(m), impliedVolatility: iv(m), openInterest: 1e6 })
      if (!skip('ce', k, m)) ce.push(point(call))
      if (!skip('pe', k, m)) pe.push(point(call - (f - k)))
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
  const read = straddleRead(d.ce, d.pe, d.spots, { step: 50 })
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

test('the fixed straddle stays on its strike all day - never shifted - and says what a seller of it has made', () => {
  // 25000 until 10:00, then 25060, then 25110 at 10:30 - the ATM moves two strikes; the fixed straddle does not.
  const spot = (m) => (m < minuteOfDay('10:00') ? 25000 : m < minuteOfDay('10:30') ? 25060 : 25110)
  const d = day({ spot, tv: (m) => 60 - m * 0.02, volume: (m) => (m % 3 ? 1000 : 4000) })
  const read = straddleRead(d.ce, d.pe, d.spots, { step: 50 })
  const ceAt = (k, t) => d.ce.find((p) => p.strike === k && Date.parse(p.time) === t).price
  const peAt = (k, t) => d.pe.find((p) => p.strike === k && Date.parse(p.time) === t).price
  assert.equal(read.fixed.strike, 25000)
  assert.equal(read.fixed.entry, ceAt(25000, at('09:21')) + peAt(25000, at('09:21')))
  assert.equal(read.series.find((p) => p.time === at('10:45')).strike, 25100)          // the Auto ATM moved on
  for (const p of read.series) assert.equal(p.fixed, ceAt(25000, p.time) + peAt(25000, p.time))
  // Its value now against what it was sold for = the seller's P&L; its own VWAP from its own legs' volume.
  const last = read.series.at(-1)
  assert.equal(read.fixed.now, last.fixed)
  assert.equal(read.fixed.sellerPnl, read.fixed.entry - last.fixed)
  const vols = read.series.map((p) => 2 * ((p.time - OPEN) / MIN % 3 ? 1000 : 4000))
  const vwap = read.series.reduce((a, p, i) => a + p.fixed * vols[i], 0) / vols.reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(read.fixed.vwap - vwap) < 1e-9)
  // Spot moved 110 away: the 25000 straddle is worth more than the ATM one - a seller of it is behind.
  assert.ok(last.fixed > last.value)

  // Any strike quoted at the start can be fixed instead.
  assert.ok(read.fixedChoices.includes(25200) && read.fixedChoices.includes(24800))
  const picked = straddleRead(d.ce, d.pe, d.spots, { step: 50, fixedStrike: 25100 })
  assert.equal(picked.fixed.strike, 25100)
  assert.equal(picked.fixed.asked, true)
  assert.equal(picked.series[0].fixed, ceAt(25100, at('09:21')) + peAt(25100, at('09:21')))
  // ... and the Auto ATM, the range and the read do not depend on it.
  assert.deepEqual([picked.day, picked.verdict], [read.day, read.verdict])
  // A strike not quoted at the start falls back to the start's ATM.
  assert.equal(straddleRead(d.ce, d.pe, d.spots, { step: 50, fixedStrike: 30000 }).fixed.strike, 25000)
})

test('the Auto ATM is the strike nearest the futures price (synthetic: strike + call - put), not spot', () => {
  // Spot 25020, futures 45 over it (25065): the ATM is 25050, the strike nearest the futures - nearest spot is 25000.
  const d = day({ spot: () => 25020, tv: () => 60, carry: () => 45 })
  const read = straddleRead(d.ce, d.pe, d.spots, { step: 50 })
  assert.ok(Math.abs(read.now.forward - 25065) < 1e-6)
  assert.equal(read.now.strike, 25050)
  assert.equal(read.day.strike, 25050)
  assert.equal(read.fixed.strike, 25050)
  // No carry: the futures price is spot, the ATM the strike nearest spot.
  const flat = day({ spot: () => 25020, tv: () => 60 })
  assert.equal(straddleRead(flat.ce, flat.pe, flat.spots, { step: 50 }).now.strike, 25000)
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
  const read = straddleRead(d.ce, d.pe, d.spots, { step: 50 })
  assert.equal(read.series.find((p) => p.time === at('10:04')).strike, 25000)   // its 09:59 reading, 5 minutes old
  assert.equal(read.series.find((p) => p.time === at('10:05')).strike, 25050)
})

test('the default start is the 09:15 open', () => {
  assert.equal(STRADDLE_START_DEFAULT, '09:15')
  const d = day({ spot: () => 25000, tv: () => 60 })
  assert.equal(readFrom(d.ce, d.pe, d.spots).series[0].time, OPEN)
})

test('the range is today\'s share of the straddle (ATM IV over the minutes left), not the move to expiry', () => {
  // A straddle of ~350 (expiry days away) at IV 12: today's priced move from 09:21 is ~150.
  const d = day({ minutes: 375, spot: () => 25000, tv: () => 175, iv: () => 12 })
  const today = straddleRead(d.ce, d.pe, d.spots, { step: 50, asOfMs: at('10:00') })
  const left = (at('15:30') - at('09:21')) / MIN
  const expected = Math.sqrt(2 / Math.PI) * 25000 * 0.12 * Math.sqrt(left / (252 * 375))
  assert.ok(today.day.value > 340)
  assert.ok(Math.abs(today.day.width - expected) < 1e-9)
  assert.ok(Math.abs(today.day.upper - (25000 + expected)) < 1e-9 && Math.abs(today.day.lower - (25000 - expected)) < 1e-9)
  // To expiry: the straddle's own breakevens.
  const expiry = straddleRead(d.ce, d.pe, d.spots, { step: 50, asOfMs: at('10:00'), scope: 'expiry' })
  assert.equal(expiry.day.width, expiry.day.value)
  // A range started later in the day prices less time.
  assert.ok(straddleRead(d.ce, d.pe, d.spots, { step: 50, start: '14:00' }).day.width < today.day.width)
  // Without an IV it falls back to the straddle; never wider than the straddle.
  const noIv = day({ spot: () => 25000, tv: () => 175, iv: () => null })
  const n = straddleRead(noIv.ce, noIv.pe, noIv.spots, { step: 50 })
  assert.equal(n.day.width, n.day.value)
  const expiryDay = day({ spot: () => 25000, tv: () => 30, iv: () => 40 })
  const e = straddleRead(expiryDay.ce, expiryDay.pe, expiryDay.spots, { step: 50 })
  assert.equal(e.day.width, e.day.value)
})

test('with the expiry date the range and the IV come from the option prices alone - a past day and live alike', () => {
  // Tuesday 20 Oct; the options expire Thursday 22 Oct: today's session left + Wednesday + Thursday.
  const d = day({ minutes: 375, spot: () => 25000, tv: () => 175, iv: () => 12 })
  const read = straddleRead(d.ce, d.pe, d.spots, { asOfMs: at('10:00'), expiry: '2026-10-22' })
  const left = (at('15:30') - at('09:21')) / MIN
  assert.ok(Math.abs(read.day.width - read.day.value * Math.sqrt(left / (left + 2 * 375))) < 1e-9)
  assert.equal(read.day.basis, 'expiry')
  assert.ok(Math.abs(read.day.sessions - (left + 750) / 375) < 1e-9)
  // The IV is the straddle's: straddle = 0.8 x futures x IV x sqrt(trading time left).
  const toExpiry = (at('15:30') - at('10:00')) / MIN + 750
  const iv = (read.now.value / (Math.sqrt(2 / Math.PI) * read.now.forward * Math.sqrt(toExpiry / (252 * 375)))) * 100
  assert.ok(Math.abs(read.now.iv - iv) < 1e-9)
  assert.equal(read.ivFrom, 'straddle')

  // The feed's IV changes nothing - none at all (a source without it), or a different one (another source's convention).
  const noIv = day({ minutes: 375, spot: () => 25000, tv: () => 175, iv: () => null })
  const otherIv = day({ minutes: 375, spot: () => 25000, tv: () => 175, iv: (m) => 30 + m * 0.1 })
  for (const other of [noIv, otherIv]) {
    const r = straddleRead(other.ce, other.pe, other.spots, { asOfMs: at('10:00'), expiry: '2026-10-22' })
    assert.deepEqual([r.day, r.verdict, r.ivChange], [read.day, read.verdict, read.ivChange])
  }

  // A weekend between: Friday 23 Oct to Tuesday 27 Oct counts Monday and Tuesday only.
  const fri = day({ minutes: 375, spot: () => 25000, tv: () => 175 })
  const shift = Date.parse('2026-10-23T09:15:00+05:30') - OPEN
  const moved = (points) => points.map((p) => ({ ...p, time: typeof p.time === 'number' ? p.time + shift : new Date(Date.parse(p.time) + shift).toISOString() }))
  const f = readFrom(moved(fri.ce), moved(fri.pe), moved(fri.spots), { start: '09:21', expiry: '2026-10-27' })
  assert.ok(Math.abs(f.day.sessions - (left + 750) / 375) < 1e-9)

  // Expiry day: the straddle is today's move. Past the expiry date: back to the feed's IV.
  assert.equal(straddleRead(d.ce, d.pe, d.spots, { expiry: '2026-10-20' }).day.width, straddleRead(d.ce, d.pe, d.spots, { expiry: '2026-10-20' }).day.value)
  const past = straddleRead(d.ce, d.pe, d.spots, { expiry: '2026-10-13' })
  assert.equal(past.day.basis, 'iv')
  assert.equal(past.ivFrom, 'feed')
})

test('the decay-only line: the start straddle with only time passing - the Auto ATM over it = IV up, under it = IV down', () => {
  // A quiet day of pure time decay at a steady IV: the straddle follows sqrt(time left), the decay-only line exactly.
  const left = (m) => (at('15:30') - (OPEN + m * MIN)) / MIN + 2 * 375   // Tue 20 Oct to Thu 22 Oct
  const quiet = day({ minutes: 300, spot: () => 25000, tv: (m) => 175 * Math.sqrt(left(m) / left(6)) })
  const read = straddleRead(quiet.ce, quiet.pe, quiet.spots, { asOfMs: at('13:00'), expiry: '2026-10-22' })
  for (const p of read.series) assert.ok(Math.abs(p.value - p.decay) < 1e-6)
  assert.ok(Math.abs(read.vsDecay) < 1e-6)
  // Under its VWAP all day (it only decays) - read as sellers, but the note says it is time decay, not selling.
  assert.equal(read.control, 'sellers')
  assert.match(read.verdict.note, /time decay, not selling/)

  // IV bid up 10% over the decay: the Auto ATM sits over the line by about 10%.
  const bid = day({ minutes: 300, spot: () => 25000, tv: (m) => 175 * Math.sqrt(left(m) / left(6)) * (m >= minuteOfDay('11:00') ? 1.1 : 1) })
  const up = straddleRead(bid.ce, bid.pe, bid.spots, { asOfMs: at('13:00'), expiry: '2026-10-22' })
  assert.ok(Math.abs(up.vsDecay / up.now.decay - 0.1) < 1e-6)
  // Sold 10% under it.
  const sold = day({ minutes: 300, spot: () => 25000, tv: (m) => 175 * Math.sqrt(left(m) / left(6)) * (m >= minuteOfDay('11:00') ? 0.9 : 1) })
  const down = straddleRead(sold.ce, sold.pe, sold.spots, { asOfMs: at('13:00'), expiry: '2026-10-22' })
  assert.ok(Math.abs(down.vsDecay / down.now.decay + 0.1) < 1e-6)
  assert.equal(down.verdict.note, undefined)
  // No expiry date: no decay line.
  assert.equal(straddleRead(quiet.ce, quiet.pe, quiet.spots).vsDecay, null)
})

// --- Trade ideas: option buying from the straddle ---------------------------------------------------------------------
// Tue 20 Oct, the options expire Thu 22 Oct (the decay-only line known). Quiet until 10:00 with the straddle decaying;
// from 10:00 a move with the straddle bid up (IV rising) - or not.
const leftAt = (m) => (at('15:30') - (OPEN + m * MIN)) / MIN + 2 * 375
const decaying = (m) => 60 * Math.sqrt(leftAt(m) / leftAt(0))
const trend = ({ dir = 1, from = '10:00', perMin = 4, bid = 1.15, minutes = 375 } = {}) => day({
  minutes,
  spot: (m) => 25000 + dir * Math.min(Math.max(0, m - minuteOfDay(from)) * perMin, 200),   // a move of up to 200
  tv: (m) => decaying(m) * (m >= minuteOfDay(from) ? bid : 1),
})
const EXP = { expiry: '2026-10-22' }
const legAt = (points, strike, t) => points.find((p) => p.strike === strike && Date.parse(p.time) === t).price

test('trade idea: premium expanding and the futures rising - BUY the ATM call, out at the target', () => {
  const d = trend()
  const read = straddleRead(d.ce, d.pe, d.spots, EXP)
  const [first] = read.trades.list
  assert.equal(first.side, 'CE')
  assert.ok(first.time > at('10:00') && first.time <= at('10:20'), istTime(first.time))
  assert.equal(first.entry, legAt(d.ce, first.strike, first.time))   // that minute's close of the ATM call
  assert.equal(first.exitReason, 'target')
  assert.ok(Math.abs(first.exit - first.entry * 1.5) < 1e-9)
  assert.ok(Math.abs(first.pct - 50) < 1e-9)
  assert.match(first.why, /over its VWAP 3 min and over its decay-only line, futures \+\d+ in 15 min/)
  assert.equal(read.trades.summary.wins, read.trades.summary.trades >= 1 ? read.trades.list.filter((t) => t.points > 0).length : 0)
})

test('trade idea: the mirror - futures falling with premium expanding - BUY the ATM put', () => {
  const d = trend({ dir: -1 })
  const [first] = straddleRead(d.ce, d.pe, d.spots, EXP).trades.list
  assert.equal(first.side, 'PE')
  assert.equal(first.entry, legAt(d.pe, first.strike, first.time))
  assert.equal(first.exitReason, 'target')
})

test('no trade without premium expanding, or without a direction', () => {
  // The futures rise but the straddle is sold (IV falling): it stays under its VWAP - no buying.
  const sold = trend({ bid: 0.8 })
  assert.deepEqual(straddleRead(sold.ce, sold.pe, sold.spots, EXP).trades.list, [])
  // Premium bid up but the futures flat: expansion with no side - no trade.
  const flat = trend({ perMin: 0 })
  assert.deepEqual(straddleRead(flat.ce, flat.pe, flat.spots, EXP).trades.list, [])
  // A move too small for today's priced range (under 25% of its half-width in 15 min).
  const tiny = trend({ perMin: 0.3 })
  assert.deepEqual(straddleRead(tiny.ce, tiny.pe, tiny.spots, EXP).trades.list, [])
})

test('exits: straddle back under its VWAP, a stop that the bar opens through or touches, 15:10; no entries after 14:45', () => {
  // The move stalls at 10:30 and the IV is crushed: the straddle falls back under its VWAP - out (no target / stop).
  const stall = day({
    minutes: 375,
    spot: (m) => 25000 + Math.min(Math.max(0, m - minuteOfDay('10:00')), 30) * 4,
    tv: (m) => decaying(m) * (m >= minuteOfDay('10:30') ? 0.85 : m >= minuteOfDay('10:00') ? 1.15 : 1),
  })
  const out = straddleRead(stall.ce, stall.pe, stall.spots, { ...EXP, trade: { targetPct: 500, slPct: 95 } }).trades.list[0]
  assert.equal(out.exitReason, 'straddle back under its VWAP')
  assert.ok(out.exitTime >= at('10:31'))
  assert.equal(out.exit, legAt(stall.ce, out.strike, out.exitTime))

  // A stop: the bar after the entry opens 40% lower - filled at its open; touched intrabar - filled at the stop.
  const d = trend()
  const entry = straddleRead(d.ce, d.pe, d.spots, EXP).trades.list[0]
  const gap = (open, low) => d.ce.map((p) => (p.strike === entry.strike && Date.parse(p.time) === entry.time + MIN
    ? { ...p, open, low, high: Math.max(open, p.price), price: Math.max(open, p.price) } : p))
  const gapped = straddleRead(gap(entry.entry * 0.6, entry.entry * 0.6), d.pe, d.spots, EXP).trades.list[0]
  assert.equal(gapped.exitReason, 'stop (opened through it)')
  assert.ok(Math.abs(gapped.exit - entry.entry * 0.6) < 1e-9)
  const touched = straddleRead(gap(entry.entry, entry.entry * 0.7), d.pe, d.spots, EXP).trades.list[0]
  assert.equal(touched.exitReason, 'stop')
  assert.ok(Math.abs(touched.exit - entry.entry * 0.75) < 1e-9)

  // Entered late, still open at 15:10: squared off at that minute's close.
  const late = trend({ from: '14:30', perMin: 2 })
  const sq = straddleRead(late.ce, late.pe, late.spots, { ...EXP, trade: { targetPct: 500, slPct: 95 } }).trades.list.at(-1)
  assert.equal(sq.exitReason, '15:10 square-off')
  assert.equal(sq.exitTime, at('15:10'))
  // A move starting after 14:45: no entry.
  const after = trend({ from: '14:46' })
  assert.deepEqual(straddleRead(after.ce, after.pe, after.spots, EXP).trades.list, [])
})

test('trade ideas use nothing after the replay clock - an open trade shows where it stands', () => {
  const d = trend()
  const full = straddleRead(d.ce, d.pe, d.spots, EXP).trades.list[0]
  const clock = full.time + 2 * MIN
  const cut = (points) => points.filter((p) => new Date(p.time).getTime() <= clock)
  const known = straddleRead(cut(d.ce), cut(d.pe), cut(d.spots), { ...EXP, asOfMs: clock })
  assert.deepEqual(straddleRead(d.ce, d.pe, d.spots, { ...EXP, asOfMs: clock }), known)
  assert.deepEqual(known.trades.list, [])
  assert.equal(known.trades.open.side, 'CE')
  assert.equal(known.trades.open.last, legAt(d.ce, full.strike, clock))
})

const istTime = (ms) => new Date(ms + 330 * MIN).toISOString().slice(11, 16)

test('a minute whose loaded chain does not reach the money is skipped, not read as premium', () => {
  // Spot runs to 25700, past the last strike loaded (25400): from the minute the nearest strike is over 1.5 steps from
  // the futures, no Auto ATM - no deep in-the-money straddle read as expansion.
  const d = day({ minutes: 300, spot: (m) => 25000 + Math.max(0, m - minuteOfDay('10:00')) * 4, tv: () => 60 })
  const read = straddleRead(d.ce, d.pe, d.spots, EXP)
  assert.ok(read.series.every((p) => Math.abs(p.forward - p.strike) <= 75))
  assert.equal(read.series.at(-1).time, at('11:58'))   // spot 25472 - the last minute within 25400 + 75
})
