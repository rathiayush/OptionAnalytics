import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nearAtmOiChange, oiWalls } from '../src/marketRead.js'

// OI Replay's Market Read: the walls ahead of the price, and the OI build-up over the same bars as the price move.
const row = (strike, ceOi, peOi, extra = {}) => ({ strike, ceOi, peOi, ...extra })

test('resistance is the most call OI at or above the price, support the most put OI at or below it', () => {
  // After a rally to 25230: the heaviest calls (25000, written in the morning) are now BELOW the price - not resistance.
  const rows = [row(25400, 6e6, 1e6), row(25300, 7e6, 2e6), row(25200, 4e6, 5e6), row(25000, 9e6, 8e6), row(24900, 2e6, 10e6)]
  const { resistance, support } = oiWalls(rows, 25230)
  assert.equal(resistance.strike, 25300)
  assert.equal(support.strike, 24900)
  // At a strike exactly: it can be either side's wall.
  assert.equal(oiWalls(rows, 25200).resistance.strike, 25300)
  assert.equal(oiWalls([row(25200, 4e6, 5e6)], 25200).support.strike, 25200)
  // Nothing on a side (spot above the band): no wall there, never one from the wrong side.
  assert.deepEqual(oiWalls(rows, 25500), { resistance: null, support: rows[4] })
  assert.deepEqual(oiWalls(rows, null), { resistance: null, support: null })
})

test('the OI build-up near ATM is the change over the window asked, not the last minute', () => {
  const ist = (hhmm) => Date.parse(`2026-10-22T${hhmm}:00+05:30`)
  const pts = (...pairs) => pairs.map(([hhmm, oi]) => ({ time: new Date(ist(hhmm)).toISOString(), openInterest: oi }))
  const ce = new Map([
    [25000, pts(['10:00', 1_000_000], ['10:04', 1_300_000], ['10:05', 1_250_000])],
    [25200, pts(['10:00', 500_000], ['10:05', 700_000])], // 2 steps away at 50: out of +-100
    [25050, pts(['10:03', 400_000], ['10:05', 450_000])], // no reading at 10:00: left out
  ])
  const pe = new Map([[25000, pts(['10:00', 2_000_000], ['10:05', 1_900_000])]])
  // 10:00 -> 10:05: +250K CE (not the last minute's -50K), -100K PE.
  assert.deepEqual(nearAtmOiChange(ce, pe, 25000, 100, ist('10:00'), ist('10:05')), { ce: 250_000, pe: -100_000 })
  // Nothing after the clock is read.
  assert.deepEqual(nearAtmOiChange(ce, pe, 25000, 100, ist('10:00'), ist('10:04')), { ce: 300_000, pe: 0 })
})
