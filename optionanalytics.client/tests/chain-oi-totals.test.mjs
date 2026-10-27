import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chainOiDay, chainOiTotalsAt } from '../src/chainOiTotals.js'

// Chain-wide OI totals: a strike that joins the band later counts from its first reading, not with its whole OI.
const ist = (hhmm) => Date.parse(`2026-10-22T${hhmm}:00+05:30`)
const point = (hhmm, oi, extra = {}) => ({ time: new Date(ist(hhmm)).toISOString(), openInterest: oi, ...extra })
const byStrike = (entries) => new Map(entries)

test('a strike joining the band at 11:00 adds only what changes after it joined', () => {
  // 25000 CE there from the open, 25300 CE (5M OI already written) first seen at 11:00 as spot rallied.
  const ce = byStrike([
    [25000, [point('09:15', 1_000_000), point('10:00', 1_200_000), point('11:00', 1_300_000), point('12:00', 1_250_000)]],
    [25300, [point('11:00', 5_000_000), point('12:00', 5_400_000)]],
  ])
  const pe = byStrike([[25000, [point('09:15', 2_000_000), point('12:00', 2_600_000)]]])
  const times = ['09:15', '10:00', '11:00', '12:00'].map(ist)
  assert.deepEqual(chainOiTotalsAt(ce, pe, ist('09:15'), times).map((t) => t.ce), [1_000_000, 1_200_000, 1_300_000, 1_650_000])
  const day = chainOiDay(ce, pe, ist('09:15'), ist('12:00'))
  // CE: +250K at 25000, +400K at 25300 since it joined - not +5.65M.
  assert.deepEqual(day.change, { ce: 650_000, pe: 600_000 })
  assert.deepEqual(day.now, { ce: 1_650_000, pe: 2_600_000 })
  // Before it joins it adds nothing; at the minute it joins, nothing either.
  assert.equal(chainOiDay(ce, pe, ist('09:15'), ist('11:00')).change.ce, 300_000)
})

test('the open\'s strikes count in full; a strike that leaves the band keeps its last reading', () => {
  const ce = byStrike([
    [24800, [point('09:15', 3_000_000), point('09:30', 3_100_000)]], // left the band at 09:30
    [25000, [point('09:15', 1_000_000), point('10:00', 900_000)]],
  ])
  const [at915, at1000] = chainOiTotalsAt(ce, new Map(), ist('09:15'), [ist('09:15'), ist('10:00')])
  assert.equal(at915.ce, 4_000_000)
  assert.equal(at1000.ce, 4_000_000)
  assert.equal(chainOiDay(ce, new Map(), ist('09:15'), ist('10:00')).change.ce, 0)
})

test('a reading with no OI keeps the strike at its last one (never counted as 0)', () => {
  const ce = byStrike([[25000, [point('09:15', 1_000_000), point('09:16', null), point('09:17', 1_100_000)]]])
  assert.deepEqual(chainOiTotalsAt(ce, new Map(), ist('09:15'), [ist('09:16'), ist('09:17')]).map((t) => t.ce), [1_000_000, 1_100_000])
  // A strike whose first readings had no OI counts from its first one that has.
  const late = byStrike([[25100, [point('09:15', null), point('10:00', 700_000), point('11:00', 800_000)]]])
  assert.equal(chainOiDay(late, new Map(), ist('09:15'), ist('11:00')).change.ce, 100_000)
})

test('live points (their own ms) are read at their tick time; nothing after the clock is counted', () => {
  const ce = byStrike([[25000, [point('09:15', 1_000_000), { time: new Date(ist('10:00') + 20_000).toISOString(), ms: ist('10:00') + 20_000, openInterest: 1_050_000 }]]])
  assert.equal(chainOiDay(ce, new Map(), ist('09:15'), ist('10:00')).change.ce, 0)
  assert.equal(chainOiDay(ce, new Map(), ist('09:15'), ist('10:00') + 30_000).change.ce, 50_000)
  assert.equal(chainOiDay(ce, new Map(), null, ist('10:00')), null)
})
