// The AI analysis of a run's report (llmAnalysis.js): a report becomes compact TEXT for a local model. Every figure in it
// comes from the report - nothing is worked out or made up - and a report with nothing in it gives no text at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BACKTEST_DEFAULTS } from '../src/signalBacktest.js'
import { storedRunText, backtestReportText, compareText, featureReportText, MAX_TEXT_CHARS } from '../src/llmAnalysis.js'

const trade = (date, h, net, extra = {}) => ({
  date, strategy: 'rule', side: 'CE', net, gross: net + 30, charges: 30, points: net / 50, holdMin: 20, exitReason: net > 0 ? 'Target' : 'Stop loss',
  entryTime: Date.parse(`${date}T${String(h).padStart(2, '0')}:10:00Z`) - 5.5 * 3600e3, ...extra,
})
const trades = [trade('2026-09-01', 10, 1200), trade('2026-09-02', 11, -800), trade('2026-10-01', 10, 600), trade('2026-10-02', 13, -300)]
const row = (name, net) => ({
  id: name, name, what: 'PE crossed above CE', signals: 6, trades: 4, winRate: 50, net, gross: net + 120, charges: 120, profitFactor: 1.5, expectancy: net / 4,
  avgWin: 900, avgLoss: -550, maxDrawdown: 800, best: 1200, worst: -800, winningDays: 2, days: 4, avgHoldMin: 20,
})
const report = {
  okDays: 4, sides: ['rule'], trades, rows: [row('Rule', 700)], all: row('Rule', 700), failed: [{ date: '2026-09-03', reason: 'holiday' }],
  noPrev: [], noPivots: [], noDeltaPast: [],
  dayRows: [
    { date: '2026-09-01', ok: true, trades: 1, net: 1200 }, { date: '2026-09-02', ok: true, trades: 1, net: -800 },
    { date: '2026-10-01', ok: true, trades: 1, net: 600 }, { date: '2026-10-02', ok: true, trades: 1, net: -300 },
  ],
}
const settings = { ...BACKTEST_DEFAULTS, underlying: 'NIFTY', timeframe: 5, slPct: 20, targetPct: 40, levelUnit: '%', trailGap: 0, trailStart: 0 }

test('a backtest report becomes text with its rule, results, exits, hours, months and days', () => {
  const text = backtestReportText(report, settings)
  assert.match(text, /SIGNAL BACKTEST REPORT/)
  assert.match(text, /NIFTY/)
  assert.match(text, /PE crossed above CE/)
  assert.match(text, /4 trades, win 50%, net ₹700/)
  assert.match(text, /Target: 2 trades, win 100%, net ₹1,800/)
  assert.match(text, /Stop loss: 2 trades/)
  assert.match(text, /10h: 2 trades/)            // IST hour of the entry, not UTC
  assert.match(text, /2026-09: 2 days, 2 trades/)
  assert.match(text, /Best days: 2026-09-01 ₹1,200/)
  assert.match(text, /11h: 1 trade, win 0%, net -₹800/)
  assert.match(text, /The best day \(10% of the traded days\) made ₹1,200; all 4 traded days made ₹700/)
  assert.match(text, /Days not run: 1 \(holiday\)/)
})

test('every figure in the text is one the report holds - a month is the sum of its trades', () => {
  const text = backtestReportText(report, settings)
  assert.match(text, /2026-09: 2 days, 2 trades, win 50%, net ₹400/)
  assert.match(text, /2026-10: 2 days, 2 trades, win 50%, net ₹300/)
  assert.match(text, /2 of 2 months were green/)
})

test('an infinite profit factor and missing numbers read as inf / n/a, never NaN or undefined', () => {
  const r = { ...report, all: { ...row('Rule', 700), profitFactor: Infinity, avgLoss: null, expectancy: NaN } }
  const text = backtestReportText(r, settings)
  assert.match(text, /profit factor inf/)
  assert.match(text, /avg loss n\/a/)
  assert.doesNotMatch(text, /NaN|undefined|null/)
})

test('a report with no day run gives no text', () => {
  assert.equal(backtestReportText({ okDays: 0 }, settings), '')
  assert.equal(backtestReportText(null, settings), '')
})

const feature = (name, group, icEarly, icLater, holds, extra = {}) => ({
  key: name, name, group, icEarly, icLater, holds, dayAgree: 70, days: 10, coverage: 95,
  fifths: { high: { n: 50, win: 56, avg: 0.04 }, low: { n: 50, win: 44, avg: -0.03 }, all: { n: 250, win: 50, avg: 0.0 } }, ...extra,
})
const featureReport = {
  target: 'fwd30', split: true, days: 30, earlyDays: 20, laterDays: 10, firstLater: '2026-10-05', rows: 5000, earlyRows: 3300, laterRows: 1700,
  features: [feature('RSI 14', 'Momentum', 0.08, 0.07, true), feature('GEX net', 'Gamma', 0.06, -0.05, false), feature('Time of day', 'Clock', 0.01, 0.0, false)],
}

test('a feature report lists what holds first, then the strongest that does not, with the split explained', () => {
  const text = featureReportText(featureReport, 'fwd30', { underlying: 'BANKNIFTY', timeframe: 5 })
  assert.match(text, /FEATURE FINDER REPORT/)
  assert.match(text, /BANKNIFTY/)
  assert.match(text, /Spot 30 min later %/)
  assert.match(text, /20 earlier days/)
  assert.match(text, /10 later days/)
  assert.match(text, /1 of 3 readings hold/)
  const holds = text.indexOf('RSI 14'), flipped = text.indexOf('GEX net')
  assert.ok(holds > 0 && flipped > holds, 'what holds comes before what does not')
  assert.match(text, /top fifth of the reading: win 56%/)
  assert.doesNotMatch(text, /a hint, not proof/)   // 10 later days is enough to say more than a hint
  assert.match(featureReportText({ ...featureReport, laterDays: 8 }, 'fwd30'), /Only 8 later days: a hint, not proof/)
})

test('a feature report with no split says nothing can be said to hold', () => {
  const text = featureReportText({ ...featureReport, split: false, features: featureReport.features.map((f) => ({ ...f, holds: false })) }, 'fwd30')
  assert.match(text, /nothing can be said to hold/)
})

test('Compare all becomes one line a template, best first, saying the ranking is in-sample', () => {
  const rows = [
    { name: 'Alpha', family: 'Trend', timeframe: 5, trades: 10, winRate: 60, net: 5000, profitFactor: 2, expectancy: 500, maxDrawdown: 900, ruleNet: 3000, mirrorNet: 2000, days: 30, idea: 'follows the OI' },
    { name: 'Beta', family: 'Reversal', timeframe: 3, trades: 8, winRate: 40, net: -1000, profitFactor: 0.7, expectancy: -125, maxDrawdown: 1500, ruleNet: -1000, mirrorNet: null, days: 30, idea: 'fades the move' },
  ]
  const text = compareText(rows, { underlying: 'NIFTY' })
  assert.match(text, /COMPARE ALL/)
  assert.ok(text.indexOf('Alpha') < text.indexOf('Beta'))
  assert.match(text, /in-sample/)
  assert.match(text, /1 of 2 templates ended in profit/)
  assert.equal(compareText([]), '')
})

test('a huge report is cut to what a model reads', () => {
  const many = Array.from({ length: 4000 }, (_, i) => feature(`Reading number ${i} with a long descriptive name to take space`, 'Group', 0.2, 0.2, true))
  const text = featureReportText({ ...featureReport, features: many }, 'fwd30')
  assert.ok(text.length <= MAX_TEXT_CHARS + 10)
})

test('a finished background run becomes text: a backtest\'s report, or a Feature finder\'s first labels', () => {
  const backtest = storedRunText({ ok: true, settings: { ...settings, rule: { lines: [] } }, report })
  assert.match(backtest, /SIGNAL BACKTEST REPORT/)

  const finder = storedRunText({
    ok: true, kind: 'features', settings,
    features: { timeframe: 1, reports: { fwd30: featureReport, ceBuy: { ...featureReport, target: 'ceBuy' }, other: featureReport } },
  })
  assert.equal((finder.match(/FEATURE FINDER REPORT/g) ?? []).length, 2)      // ceBuy and fwd30 - the labels it holds of the three
  assert.match(finder, /CE bought there/)
  assert.match(finder, /Spot 30 min later/)
  assert.match(finder, /1-minute candles/)

  assert.equal(storedRunText(null), '')
  assert.equal(storedRunText({ ok: true, kind: 'features', settings, features: {} }), '')
})
