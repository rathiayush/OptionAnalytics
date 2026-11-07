// The Signal backtest's DAYS (asked for - "when I select dates it gets picked to an old date; I should be able to enter
// manually as well as previous years"): on a phone the two-month range picker was wider than the screen - its left month
// (the older one) ran off the left edge with its ◀ / « buttons, so the dates showing at the edge were that older month's
// and the years before could not be reached. A phone has a From and a To picker of one month each; every screen takes a
// date TYPED in any of these forms and the quick ranges below.
import dayjs from 'dayjs'

/** The forms a typed date is read in - the first is how a date is shown (antd parses the typed text against each, strict). */
export const DATE_INPUT_FORMATS = ['YYYY-MM-DD', 'DD-MM-YYYY', 'DD/MM/YYYY', 'D/M/YYYY', 'D-M-YYYY', 'DD.MM.YYYY', 'YYYY/MM/DD', 'D MMM YYYY']

const iso = (d) => d.format('YYYY-MM-DD')

/** Quick ranges of PAST days, each ending the day before `today` (YYYY-MM-DD) - the backtest runs past weekdays only.
 *  [{ key, label, from, to }]; "Last year" is the whole calendar year before this one. */
export function rangePresets(today) {
  const t = dayjs(today)
  if (!t.isValid()) return []
  const end = t.subtract(1, 'day')
  const lastYear = t.subtract(1, 'year')
  return [
    { key: '2w', label: 'Last 2 weeks', from: iso(t.subtract(14, 'day')), to: iso(end) },
    { key: '1m', label: 'Last month', from: iso(t.subtract(1, 'month')), to: iso(end) },
    { key: '3m', label: 'Last 3 months', from: iso(t.subtract(3, 'month')), to: iso(end) },
    { key: '6m', label: 'Last 6 months', from: iso(t.subtract(6, 'month')), to: iso(end) },
    { key: '1y', label: 'Last 12 months', from: iso(t.subtract(1, 'year')), to: iso(end) },
    { key: 'ytd', label: `This year (${t.year()})`, from: `${t.year()}-01-01`, to: iso(end) },
    { key: 'ly', label: `Last year (${lastYear.year()})`, from: `${lastYear.year()}-01-01`, to: `${lastYear.year()}-12-31` },
    // For a background run (up to 1 500 weekdays - the last 6 years is just over it: the latest 1 500 are run).
    { key: '2y', label: 'Last 2 years', from: iso(t.subtract(2, 'year')), to: iso(end) },
    { key: '5y', label: 'Last 5 years', from: iso(t.subtract(5, 'year')), to: iso(end) },
    { key: '6y', label: 'Last 6 years (background: the latest 1,500 days)', from: iso(t.subtract(6, 'year')), to: iso(end) },
  ].filter((p) => p.from <= p.to)
}

/** The range after one end is set (`side` 'from' | 'to', `date` YYYY-MM-DD) - kept in order: a From after the To moves the
 *  To to it, a To before the From moves the From (the other end is never lost to an empty range). */
export function withRangeEnd(range, side, date) {
  if (!date) return range
  const [from, to] = range ?? []
  if (side === 'from') return [date, to && to >= date ? to : date]
  return [from && from <= date ? from : date, date]
}

/** A day that can be picked: before `today` (YYYY-MM-DD) - today has not finished, a future day has no data. */
export const isPastDay = (d, today) => Boolean(d) && dayjs(d).isValid() && dayjs(d).format('YYYY-MM-DD') < today
