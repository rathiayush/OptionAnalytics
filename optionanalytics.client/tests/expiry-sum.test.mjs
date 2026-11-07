// OI Replay's "Σ 3 expiries" (expirySum.js): every OI read takes the nearest expiry's OI plus the next two's at the same
// strike and minute; the premiums stay the nearest's; an expiry first read at a strike later in the day counts by its change
// only; nothing after a point's time is read.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expirySumText, sumExpiryOi, summedExpiries } from '../src/expirySum.js'

// 1-minute points of one day from 09:15 IST: minute i of strike s.
const OPEN = Date.parse('2026-11-05T09:15:00+05:30')
const at = (i) => new Date(OPEN + i * 60_000).toISOString()
const pt = (strike, i, oi, extra = {}) => ({ time: at(i), strike, openInterest: oi, price: 100 + i, impliedVolatility: 12, volume: 5, ...extra })
const oiAt = (points, strike, i) => points.find((p) => p.strike === strike && p.ms === OPEN + i * 60_000)?.openInterest

test('the expiries summed, live: the next and the monthly - the monthly never twice', () => {
  const listed = ['2026-11-10', '2026-11-17', '2026-11-24', '2026-12-01', '2026-12-29']
  // NIFTY, early in the month: the current weekly + the next weekly + the month's last (monthly).
  assert.deepEqual(summedExpiries(listed, '2026-11-24', 'WEEK'), [
    { key: 'N2', liveFlag: 'N2', expiryFlag: 'WEEK', expiryCode: 2, expiry: '2026-11-17', name: 'next' },
    { key: 'MONTH', liveFlag: 'MONTH', expiryFlag: 'MONTH', expiryCode: 1, expiry: '2026-11-24', name: 'monthly' },
  ])
  // The month's last weeks: the monthly IS the next expiry, or the current one - not counted twice.
  assert.deepEqual(summedExpiries(['2026-11-17', '2026-11-24', '2026-12-01'], '2026-11-24', 'WEEK').map((b) => b.key), ['N2'])
  assert.deepEqual(summedExpiries(['2026-11-24', '2026-12-01', '2026-12-08'], '2026-11-24', 'WEEK').map((b) => b.key), ['N2'])
  // BANKNIFTY (monthlies only): the current month is the monthly - the current + the next month.
  assert.deepEqual(summedExpiries(['2026-11-24', '2026-12-29', '2027-01-26'], '2026-11-24', 'MONTH'), [
    { key: 'N2', liveFlag: 'N2', expiryFlag: 'MONTH', expiryCode: 2, expiry: '2026-12-29', name: 'next' },
  ])
  // The listed expiries not loaded yet: nothing to add yet.
  assert.deepEqual(summedExpiries([], '2026-11-24', 'WEEK'), [])
})

test('each point\'s OI is the three expiries\' at that strike and minute; the premium, IV and volume stay the nearest\'s', () => {
  const base = [pt(25000, 0, 1000), pt(25000, 1, 1100), pt(25050, 0, 500)]
  const next = [pt(25000, 0, 300, { price: 999 }), pt(25000, 1, 320), pt(25050, 0, 50)]
  const far = [pt(25000, 0, 40), pt(25000, 1, 45)]
  const sum = sumExpiryOi(base, [next, far])
  assert.equal(oiAt(sum, 25000, 0), 1340)
  assert.equal(oiAt(sum, 25000, 1), 1465)
  assert.equal(oiAt(sum, 25050, 0), 550)          // the far expiry has none there: nearest + next
  const p = sum.find((x) => x.strike === 25000 && x.ms === OPEN)
  assert.equal(p.price, 100)                       // the nearest's premium, never the next's 999
  assert.equal(p.impliedVolatility, 12)
  assert.equal(p.volume, 5)
  assert.equal(p.oiNearest, 1000)
  // Nothing else to add: the points as they were.
  assert.equal(sumExpiryOi(base, []), base)
  assert.equal(sumExpiryOi(base, [[], null]), base)
})

test('an expiry\'s last reading at or before the minute is carried on - never a later one', () => {
  const base = [pt(25000, 0, 1000), pt(25000, 1, 1000), pt(25000, 2, 1000), pt(25000, 3, 1000)]
  const next = [pt(25000, 0, 200), pt(25000, 2, 260)]   // nothing at minute 1 and 3
  const sum = sumExpiryOi(base, [next])
  assert.deepEqual([0, 1, 2, 3].map((i) => oiAt(sum, 25000, i)), [1200, 1200, 1260, 1260])
  // A reading 30 seconds into minute 2 (live) is not seen at minute 2's start, but from the next point on.
  const live = sumExpiryOi(base, [[pt(25000, 0, 200), { time: new Date(OPEN + 2.5 * 60_000).toISOString(), strike: 25000, openInterest: 900 }]])
  assert.deepEqual([0, 1, 2, 3].map((i) => oiAt(live, 25000, i)), [1200, 1200, 1200, 1900])
})

test('an expiry first read at a strike later in the day counts by its change from that reading - no fake OI added', () => {
  const base = [0, 1, 2, 3, 4].map((i) => pt(25150, i, 1000))
  // The next expiry's ATM±3 window reaches this strike only at minute 2 (spot moved): 5000 then, 5300 at minute 4.
  const next = [pt(25150, 2, 5000), pt(25150, 3, 5000), pt(25150, 4, 5300)]
  const sum = sumExpiryOi(base, [next])
  assert.deepEqual([0, 1, 2, 3, 4].map((i) => oiAt(sum, 25150, i)), [1000, 1000, 1000, 1000, 1300])
  // Read from the strike's start: counted in full.
  const full = sumExpiryOi(base, [[pt(25150, 0, 5000), pt(25150, 4, 5300)]])
  assert.deepEqual([0, 4].map((i) => oiAt(full, 25150, i)), [6000, 6300])
  // A strike the nearest joins later: the other expiry read before it counts in full from the nearest's first reading.
  const late = sumExpiryOi([pt(25200, 3, 700)], [[pt(25200, 1, 80), pt(25200, 3, 90)]])
  assert.equal(oiAt(late, 25200, 3), 790)
})

test('strikes the nearest does not have are left out; a point with no OI keeps none; outside the session nothing', () => {
  const base = [pt(25000, 0, 1000), pt(25000, 1, null)]
  const next = [pt(25000, 0, 10), pt(26000, 0, 999), { time: '2026-11-05T15:45:00+05:30', strike: 25000, openInterest: 1 }]
  const sum = sumExpiryOi(base, [next])
  assert.equal(sum.length, 2)
  assert.ok(!sum.some((p) => p.strike === 26000))
  assert.equal(oiAt(sum, 25000, 0), 1010)
  assert.equal(sum.find((p) => p.ms === OPEN + 60_000).openInterest, null)
})

test('no look-ahead: the sum of the minutes up to a clock is the same worked out from the points up to it only', () => {
  const strikes = [24900, 24950, 25000, 25050, 25100]
  const day = (seed, from = 0) => strikes.flatMap((s, k) => Array.from({ length: 40 }, (_, i) => i)
    .filter((i) => i >= from + (k % 2) * 7 && (i * seed + k) % 3 !== 0)
    .map((i) => pt(s, i, 1000 * seed + k * 37 + ((i * seed * 13) % 50))))
  const base = day(1)
  const next = day(2, 5)
  const far = day(3, 11)
  const whole = sumExpiryOi(base, [next, far])
  for (const clock of [0, 6, 12, 19, 33, 39]) {
    const cut = (pts) => pts.filter((p) => Date.parse(p.time) <= OPEN + clock * 60_000)
    const part = sumExpiryOi(cut(base), [cut(next), cut(far)])
    const upTo = whole.filter((p) => Date.parse(p.time) <= OPEN + clock * 60_000)
    const key = (p) => `${p.strike}|${Date.parse(p.time)}`
    assert.deepEqual(new Map(upTo.map((p) => [key(p), p.openInterest])), new Map(part.map((p) => [key(p), p.openInterest])), `clock ${clock}`)
  }
})

test('the controls\' line says what is summed, what is not, and the monthly counted once', () => {
  const [next, month] = summedExpiries(['2026-11-10', '2026-11-17'], '2026-11-24', 'WEEK')
  assert.equal(expirySumText('2026-11-10', [{ ...next, state: 'ready' }, { ...month, state: 'ready' }], { month: '2026-11-24' }),
    'OI = 10 Nov (current) + 17 Nov (next) + 24 Nov (monthly)')
  assert.equal(expirySumText('2026-11-10', [{ ...next, state: 'ready', dhanBandSteps: 3, liveFrom: '2026-11-10T05:30:00Z' }, { ...month, state: 'loading' }], { month: '2026-11-24' }),
    'OI = 10 Nov (current) + 17 Nov (next) (monthly loading…) - the next expiry ATM±3 before 11:00 (all Dhan gives for it; the live feed\'s ATM±10 from then)')
  const [onlyNext] = summedExpiries(['2026-11-17', '2026-11-24'], '2026-11-24', 'WEEK')
  assert.equal(expirySumText('2026-11-17', [{ ...onlyNext, state: 'error', error: 'Dhan said no' }], { month: '2026-11-24' }),
    'OI = 17 Nov (current) (next not loaded (Dhan said no)) - the monthly (24 Nov) is already the next expiry - counted once')
})
