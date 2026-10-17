// The tuning chooses a setting that holds month after month, not the one that fit one lucky month (strategyTuning.js
// periodsOf / robustScore / pickSimplest): scored on each month of the train days, needs enough trades a month, and of
// the settings about as good as the top one takes the one closest to as written. Run: npm test (node --test).
import test from 'node:test'
import assert from 'node:assert/strict'
import { NEAR_BEST, changesFrom, periodsOf, pickSimplest, robustScore, scoreR } from '../src/strategyTuning.js'

const days = (from, n) => Array.from({ length: n }, (_, i) => {
  const d = new Date(`${from}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + Math.floor(i * 7 / 5))
  return { date: d.toISOString().slice(0, 10) }
})

test('periods: calendar months; a short month joins its neighbour; under two months, ~10-day blocks; few days, one', () => {
  const three = [...days('2026-06-01', 20), ...days('2026-07-01', 20), ...days('2026-08-03', 20)]
  assert.deepEqual(periodsOf(three).map((p) => p.length), [20, 20, 20])
  // 3 days of a month at the end join the month before; 2 at the start join the next.
  const ragged = [...days('2026-05-28', 2), ...days('2026-06-01', 20), ...days('2026-07-01', 20), ...days('2026-08-03', 3)]
  assert.deepEqual(periodsOf(ragged).map((p) => p.length), [22, 23])
  // One month of 21 days: two ~10-day blocks; 10 days: one stretch.
  assert.deepEqual(periodsOf(days('2026-06-01', 21)).map((p) => p.length), [11, 10])
  assert.equal(periodsOf(days('2026-06-01', 10)).length, 1)
  // Out of order in, in order out.
  assert.equal(periodsOf([...three].reverse())[0][0].date, three[0].date)
})

test('a setting that made its money in one month loses to one that made a little every month', () => {
  // Fluke: +3R twice in month 1, small losses after - more R in total. Steady: +0.4R every trade, every month.
  const fluke = [[3, 3, 0.2], [-0.3, -0.2, -0.1], [-0.2, -0.3, 0.1]]
  const steady = [[0.4, 0.4, 0.4], [0.4, 0.4, 0.4], [0.4, 0.4, 0.4]]
  assert.ok(scoreR(fluke.flat()).total > scoreR(steady.flat()).total)
  const f = robustScore(fluke)
  const s = robustScore(steady)
  assert.equal(f.score, null, 'won 1 of 3 months: not chosen at all')
  assert.equal(f.why, 'inconsistent')
  assert.equal(f.periodsWon, 1)
  assert.ok(s.score > 0)
  assert.equal(s.periodsWon, 3)
  // Two months only: not ruled out, but the swing between them costs it.
  const twoFluke = robustScore([[3, 3], [-0.3, -0.2]])
  const twoSteady = robustScore([[0.6, 0.6], [0.6, 0.6]])
  assert.ok(twoSteady.score > twoFluke.score, `${twoSteady.score} > ${twoFluke.score}`)
  // A month without a trade counts as 0, not as missing.
  assert.ok(robustScore([[0.5, 0.5], [], [0.5, 0.5]]).score < robustScore([[0.5, 0.5], [0.5, 0.5], [0.5, 0.5]]).score)
})

test('one stretch: the cautious score as before (short ranges unchanged)', () => {
  const rs = [0.5, -0.2, 0.8, 0.1]
  assert.equal(robustScore([rs]).score, scoreR(rs).score)
})

test('trades a month: below the minimum, not chosen; 0 = no such rule', () => {
  const rs = [[0.5, 0.5], [0.5, 0.5]] // 4 trades on 42 train days = 2 a month
  assert.equal(robustScore(rs, { tradingDays: 42, minPerMonth: 4 }).score, null)
  assert.equal(robustScore(rs, { tradingDays: 42, minPerMonth: 4 }).why, 'rare')
  assert.equal(robustScore(rs, { tradingDays: 42, minPerMonth: 4 }).perMonth, 2)
  assert.ok(robustScore(rs, { tradingDays: 42, minPerMonth: 2 }).score > 0)
  assert.ok(robustScore(rs, { tradingDays: 42, minPerMonth: 0 }).score > 0)
})

test('of the settings about as good as the top one, the one closest to as written', () => {
  const asWritten = { tradeSide: 'both', tradeStopX: '1', tradeTargetX: '2', tradeTrail: 'on' }
  const row = (score, params, at) => ({ params: { ...asWritten, ...params }, train: { score }, at })
  const rows = [
    row(1.0, { tradeSide: 'long', tradeStopX: '1.5', tradeTrail: 'off' }, 1), // 3 changes, the top
    row(0.9, { tradeSide: 'long' }, 2), // 1 change, within 15%
    row(0.88, {}, 3), // as written, within 15%
    row(0.5, { tradeTargetX: '3' }, 4),
  ]
  assert.equal(changesFrom(rows[0].params, asWritten), 3)
  const { chosen, nearBest } = pickSimplest(rows, asWritten)
  assert.equal(nearBest, 3)
  assert.equal(chosen, rows[2], 'as written itself is within the margin: nothing to change')
  // Without as written in reach: the one change.
  assert.equal(pickSimplest([rows[0], rows[1], rows[3]], asWritten).chosen, rows[1])
  // Beyond the margin, the top stays.
  assert.equal(pickSimplest([rows[0], row(1 - NEAR_BEST - 0.01, {}, 5)], asWritten).chosen, rows[0])
  // Nothing positive: the top, as before.
  assert.equal(pickSimplest([row(-0.1, { tradeSide: 'long' }, 1), row(-0.2, {}, 2)], asWritten).chosen.at, 1)
})

test('a setting chosen on one short stretch is shown, never recommended - however well it did there', async () => {
  const { heldToMinDays, MIN_TUNE_DAYS } = await import('../src/strategyTuning.js')
  assert.equal(MIN_TUNE_DAYS, 60)
  const good = { recommend: true, reason: 'better on the train days and on the 6 unseen test day(s)', best: { params: { tradeSide: 'long' } } }
  const short = heldToMinDays(good, 21)
  assert.equal(short.recommend, false)
  assert.deepEqual(short.tooFewDays, { days: 21, min: 60 })
  assert.match(short.reason, /only 21 trading day\(s\).*60\+ trading days.*\(better on the train days/)
  assert.equal(short.best, good.best, 'the setting itself is still shown')
  // Enough days: untouched. Not recommended anyway: untouched.
  assert.equal(heldToMinDays(good, 60), good)
  const no = { recommend: false, reason: 'it fitted the past' }
  assert.equal(heldToMinDays(no, 10), no)
  // The job's own threshold can be set (the tests run on a few days).
  assert.equal(heldToMinDays(good, 6, 5), good)
})
