// The Signal backtest's days (backtestDates.js): the quick ranges of past days, a From / To kept in order, the days that
// can be picked, and the forms a typed date is read in.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat.js'
import { DATE_INPUT_FORMATS, isPastDay, rangePresets, withRangeEnd } from '../src/backtestDates.js'

dayjs.extend(customParseFormat)

test('the quick ranges: past days only, each ending the day before today; last year the whole calendar year', () => {
  const p = Object.fromEntries(rangePresets('2026-11-05').map((x) => [x.key, [x.from, x.to]]))
  assert.deepEqual(p['2w'], ['2026-10-22', '2026-11-04'])
  assert.deepEqual(p['1m'], ['2026-10-05', '2026-11-04'])
  assert.deepEqual(p['3m'], ['2026-08-05', '2026-11-04'])
  assert.deepEqual(p['1y'], ['2025-11-05', '2026-11-04'])
  assert.deepEqual(p.ytd, ['2026-01-01', '2026-11-04'])
  assert.deepEqual(p.ly, ['2025-01-01', '2025-12-31'])
  assert.match(rangePresets('2026-11-05').find((x) => x.key === 'ly').label, /2025/)
  // On 1 January "this year" has no past day yet - left out, not an empty range.
  assert.equal(rangePresets('2027-01-01').some((x) => x.key === 'ytd'), false)
  assert.deepEqual(rangePresets('nope'), [])
})

test('From / To kept in order: a From after the To moves the To, a To before the From moves the From', () => {
  const r = ['2026-10-01', '2026-10-31']
  assert.deepEqual(withRangeEnd(r, 'from', '2025-01-06'), ['2025-01-06', '2026-10-31'])     // an earlier year
  assert.deepEqual(withRangeEnd(r, 'to', '2026-10-15'), ['2026-10-01', '2026-10-15'])
  assert.deepEqual(withRangeEnd(r, 'from', '2026-11-03'), ['2026-11-03', '2026-11-03'])
  assert.deepEqual(withRangeEnd(r, 'to', '2026-09-01'), ['2026-09-01', '2026-09-01'])
  assert.deepEqual(withRangeEnd(undefined, 'to', '2026-09-01'), ['2026-09-01', '2026-09-01'])
  assert.equal(withRangeEnd(r, 'from', null), r)
})

test('a day can be picked only before today; a typed date is read in every form offered', () => {
  assert.ok(isPastDay(dayjs('2026-11-04'), '2026-11-05') && isPastDay(dayjs('2019-03-01'), '2026-11-05'))
  assert.ok(!isPastDay(dayjs('2026-11-05'), '2026-11-05') && !isPastDay(dayjs('2026-12-01'), '2026-11-05') && !isPastDay(null, '2026-11-05'))
  // Each form reads 6 January 2025, strictly (as antd parses what is typed).
  const typed = ['2025-01-06', '06-01-2025', '06/01/2025', '6/1/2025', '6-1-2025', '06.01.2025', '2025/01/06', '6 Jan 2025']
  for (const text of typed) {
    const hit = DATE_INPUT_FORMATS.map((f) => dayjs(text, f, true)).find((d) => d.isValid())
    assert.equal(hit?.format('YYYY-MM-DD'), '2025-01-06', text)
  }
  assert.equal(DATE_INPUT_FORMATS[0], 'YYYY-MM-DD')                // shown as before
  assert.ok(!DATE_INPUT_FORMATS.some((f) => dayjs('31/02/2025', f, true).isValid()))
})
