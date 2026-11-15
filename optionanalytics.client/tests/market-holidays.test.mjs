// NSE's F&O trading holidays (marketHolidays.js) - what the straddle's time to expiry skips.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HOLIDAY_YEARS, NSE_FO_HOLIDAYS, isFoSession } from '../src/marketHolidays.js'

test('a listed holiday and a weekend are not sessions; any other weekday is', () => {
  assert.equal(isFoSession('2026-11-10'), false, 'Diwali-Balipratipada')
  assert.equal(isFoSession('2026-01-15'), false, 'Maharashtra municipal elections (added by NSE/FAOP/72262)')
  assert.equal(isFoSession('2026-11-14'), false, 'a Saturday')
  assert.equal(isFoSession('2026-11-15'), false, 'a Sunday')
  assert.equal(isFoSession('2026-11-11'), true)
  // The same by UTC day number (straddle.js counts days that way).
  assert.equal(isFoSession(Date.UTC(2026, 10, 10) / 86_400_000), false)
  assert.equal(isFoSession(Date.UTC(2026, 10, 11) / 86_400_000), true)
  // A year not listed: every weekday is a session, as before.
  assert.equal(HOLIDAY_YEARS.has(2027), false)
  assert.equal(isFoSession('2027-01-26'), true)
})

test('every listed holiday is a weekday of a listed year, and the counts are NSE\'s (2025: 14, 2026: 15 + 15 January)', () => {
  for (const d of NSE_FO_HOLIDAYS) {
    const day = new Date(`${d}T00:00:00Z`).getUTCDay()
    assert.ok(day >= 1 && day <= 5, `${d} is a weekday`)
    assert.ok(HOLIDAY_YEARS.has(Number(d.slice(0, 4))), `${d}'s year is listed`)
  }
  const inYear = (y) => [...NSE_FO_HOLIDAYS].filter((d) => d.startsWith(`${y}-`)).length
  assert.equal(inYear(2025), 14)
  assert.equal(inYear(2026), 16)
})
