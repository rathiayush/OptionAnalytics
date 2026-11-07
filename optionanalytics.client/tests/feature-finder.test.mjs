// The feature finder (featureFinder.js): every reading at every candle as one table, what happened after it, and which
// readings ranked what came next on the earlier days AND still did on the later days.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { day as syntheticDay } from './synthetic-day.mjs'
import { optionFor, prepareDay, simulateTrade, timeframeView } from '../src/signalBacktest.js'
import { FEATURES, HOLD_IC, LABELS, dayRows, featureReport, rowsCsv, spearman } from '../src/featureFinder.js'

const LEVELS = { slPct: 30, targetPct: 60, levelUnit: 'pct', entryFrom: '09:30', lastEntry: '14:45' }
const prepared = () => {
  const { run } = syntheticDay()
  return { run, d: prepareDay({ ...run, optionExpiry: '2026-10-06' }, { underlying: 'NIFTY' }) }
}

test('a row a candle in the entry window, every feature and label', () => {
  const { d } = prepared()
  const rows = dayRows(d, { timeframe: 5, ...LEVELS })
  const v = timeframeView(d, 5)
  assert.ok(rows.length > 40 && rows.length < v.n)
  for (const r of rows) {
    assert.deepEqual(Object.keys(r.f), FEATURES.map((f) => f.key))
    assert.deepEqual(Object.keys(r.y), LABELS.map((l) => l.key))
    const m = new Date(r.time).getUTCHours() * 60 + new Date(r.time).getUTCMinutes() + 330
    assert.ok(m >= 9 * 60 + 30 && m <= 14 * 60 + 45, `row at ${m}`)
  }
  // Most features have a reading on this day (the synthetic one has OI, walls, straddle, VWAP ...).
  const filled = FEATURES.filter((f) => rows.some((r) => Number.isFinite(r.f[f.key])))
  assert.ok(filled.length >= 20, `${filled.length} features read`)
})

test('NO LOOK-AHEAD: the features of a day cut part way are the whole day\'s up to the cut', () => {
  const { run, d } = prepared()
  const cutMinute = 180
  const cut = Date.parse(run.spotCandlesOneMinute[cutMinute].time)
  const keep = (list) => list.filter((p) => Date.parse(p.time) <= cut)
  const part = prepareDay({ ...run, optionExpiry: '2026-10-06', spotCandlesOneMinute: keep(run.spotCandlesOneMinute), futuresBars: keep(run.futuresBars),
    cePoints: keep(run.cePoints), pePoints: keep(run.pePoints) }, { underlying: 'NIFTY' })
  for (const tf of [1, 5]) {
    const full = dayRows(d, { timeframe: tf, ...LEVELS })
    const cutRows = dayRows(part, { timeframe: tf, ...LEVELS })
    // Every candle that ended by the cut - the last one of the cut day may be a candle still forming at 5 min.
    const done = cutRows.filter((r) => r.time + (tf - 1) * 60_000 < cut)
    assert.ok(done.length > 20)
    for (const r of done) {
      const same = full.find((x) => x.time === r.time)
      for (const f of FEATURES) {
        const a = r.f[f.key], b = same.f[f.key]
        assert.ok((Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9, `${tf}m ${f.key} at ${new Date(r.time).toISOString()}: ${a} vs ${b}`)
      }
    }
  }
})

test('the labels: spot N minutes later, and the backtest\'s own trade bought at the candle', () => {
  const { d } = prepared()
  const rows = dayRows(d, { timeframe: 1, ...LEVELS })
  const r = rows[20]
  const m = d.t.indexOf(r.time)
  assert.ok(Math.abs(r.y.fwd15 - ((d.spot.c[m + 15] - d.spot.c[m]) / d.spot.c[m]) * 100) < 1e-9)
  const ce = simulateTrade(d, m, optionFor(1, 'buy', d.atm[m], d.step, 0), { slPct: 30, targetPct: 60, levelUnit: 'pct' })
  assert.ok(Math.abs(r.y.ceBuy - (ce.points / ce.entry) * 100) < 1e-9)
  const pe = simulateTrade(d, m, optionFor(-1, 'buy', d.atm[m], d.step, 0), { slPct: 30, targetPct: 60, levelUnit: 'pct' })
  assert.ok(Math.abs(r.y.peBuy - (pe.points / pe.entry) * 100) < 1e-9)
  // No label from past the day's last minute.
  const late = dayRows(d, { timeframe: 1, ...LEVELS, lastEntry: '15:29' }).at(-1)
  assert.ok(Number.isNaN(late.y.fwd60))
})

test('Spearman: ranks, ties, too few pairs', () => {
  const x = Array.from({ length: 20 }, (_, k) => k)
  assert.equal(spearman(x, x.map((v) => v * v)), 1)
  assert.equal(spearman(x, x.map((v) => -v)), -1)
  assert.ok(Number.isNaN(spearman(x.slice(0, 9), x.slice(0, 9))))
  assert.ok(Math.abs(spearman(x, x.map((v) => (v % 2 ? 1 : 0)))) < 0.2)       // no order between them
  assert.equal(spearman([...x, NaN], [...x, 5]), 1)                           // a pair without both numbers is left out
})

test('the report: what held on the LATER days, not what only worked on the earlier ones', () => {
  // 12 days, 40 rows each. move15 predicts fwd30 every day; rsi predicts it on the first 8 days and the other way after;
  // ema20 is noise.
  let seed = 3
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5 }
  const rows = []
  for (let day = 0; day < 12; day++) {
    const date = `2026-10-${String(day + 1).padStart(2, '0')}`
    for (let k = 0; k < 40; k++) {
      const y = rnd()
      const f = Object.fromEntries(FEATURES.map((ft) => [ft.key, NaN]))
      f.move15 = y + rnd() * 0.5
      f.rsi = (day < 8 ? y : -y) + rnd() * 0.5
      f.ema20 = rnd()
      rows.push({ date, time: Date.parse(`${date}T04:00:00Z`) + k * 60_000, f, y: { fwd30: y, ceBuy: y > 0 ? 10 : -5 } })
    }
  }
  const rep = featureReport(rows, 'fwd30')
  assert.equal(rep.split, true)
  assert.equal(rep.days, 12)
  assert.equal(rep.laterDays, 4)
  assert.equal(rep.firstLater, '2026-10-09')
  const by = Object.fromEntries(rep.features.map((x) => [x.key, x]))
  assert.ok(by.move15.holds && by.move15.icEarly > 0.5 && by.move15.icLater > 0.5 && by.move15.dayAgree === 100)
  assert.ok(!by.rsi.holds && by.rsi.icEarly > 0.5 && by.rsi.icLater < -0.5 && by.rsi.dayAgree === 0)
  assert.ok(!by.ema20.holds || Math.abs(by.ema20.icLater) < 0.2)
  assert.equal(rep.features[0].key, 'move15')                                   // what holds comes first
  assert.ok(Math.abs(by.move15.icLater) >= HOLD_IC)
  // The top fifth of move15 had far more CE wins than its bottom fifth (on the later days).
  const ce = featureReport(rows, 'ceBuy')
  const m = ce.features.find((x) => x.key === 'move15')
  assert.ok(m.fifths.high.win > 80 && m.fifths.low.win < 20)
  // Too few days for an honest split: every day in both, nothing "holds".
  const few = featureReport(rows.filter((r) => r.date < '2026-10-05'), 'fwd30')
  assert.equal(few.split, false)
  assert.ok(few.features.every((x) => !x.holds))
})

test('the CSV: a header of the keys, a row a candle, numbers rounded, cells formula-safe', () => {
  const { d } = prepared()
  const rows = dayRows(d, { timeframe: 15, ...LEVELS })
  const csv = rowsCsv(rows).trim().split('\n')
  assert.equal(csv[0], ['date', 'time', ...FEATURES.map((f) => f.key), ...LABELS.map((l) => l.key)].join(','))
  assert.equal(new Set(csv[0].split(',')).size, csv[0].split(',').length)                // every column named once
  assert.equal(csv.length, rows.length + 1)
  assert.match(csv[1], /^2026-10-05,09:(29|30|44|45),/)
  assert.equal(csv[1].split(',').length, 2 + FEATURES.length + LABELS.length)
})
