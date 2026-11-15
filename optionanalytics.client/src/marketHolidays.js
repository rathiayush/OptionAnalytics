// NSE's equity-derivatives (F&O) TRADING HOLIDAYS that fall on a weekday - what the straddle's time to expiry counts in
// sessions (straddle.js): a holiday between the day and the expiry is not a session, and counted as one it made the
// "today's share" of the straddle's priced range ~18% too narrow with two sessions left. NSE's own lists:
//   2025 - the 14 days of NSE's F&O holiday circular for 2025;
//   2026 - the 15 of NSE/FAOP/71777, and 15 January (Maharashtra municipal corporation elections, NSE/FAOP/72262).
// ADD THE NEXT YEAR'S LIST WHEN NSE PUBLISHES IT (each December): a year not listed counts every weekday as a session, as
// before (`HOLIDAY_YEARS` says which years are known).

export const NSE_FO_HOLIDAYS = new Set([
  // 2025
  '2025-02-26', '2025-03-14', '2025-03-31', '2025-04-10', '2025-04-14', '2025-04-18', '2025-05-01',
  '2025-08-15', '2025-08-27', '2025-10-02', '2025-10-21', '2025-10-22', '2025-11-05', '2025-12-25',
  // 2026
  '2026-01-15', '2026-01-26', '2026-03-03', '2026-03-26', '2026-03-31', '2026-04-03', '2026-04-14', '2026-05-01',
  '2026-05-28', '2026-06-26', '2026-09-14', '2026-10-02', '2026-10-20', '2026-11-10', '2026-11-24', '2026-12-25',
])

/** The years whose holidays are listed. */
export const HOLIDAY_YEARS = new Set([2025, 2026])

/** Whether `date` ('YYYY-MM-DD', or a UTC day number - days since 1970-01-01) is an F&O session: a weekday that is not one
 *  of NSE's listed holidays (a year not listed: every weekday). */
export function isFoSession(date) {
  const day = typeof date === 'number' ? new Date(date * 86_400_000) : new Date(`${String(date).slice(0, 10)}T00:00:00Z`)
  const weekday = day.getUTCDay()
  if (weekday === 0 || weekday === 6 || !Number.isFinite(day.getTime())) return false
  return !NSE_FO_HOLIDAYS.has(day.toISOString().slice(0, 10))
}
