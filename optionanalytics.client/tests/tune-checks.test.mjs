// The tuning's cross-check (scanner-runner/tuneChecks.mjs, strategyTuning.js checkSetting): tune one month, then
// another - each run finds its own "best" setting. Every run therefore also measures every setting found so far for its
// index on its own days that setting was NOT chosen on, beside the strategy as written on the same days, and keeps it in
// {run}-checks.csv; the Trades page ranks the settings on all their unseen days across runs and months
// (TuningPerformance.cs - StrategyTuningServiceTests). Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanDaySetups } from '../src/scanDay.js'
import { DEFAULT_VARIANT, checkSetting, dayTrades, splitDays, tuneStrategy, tuningDay } from '../src/strategyTuning.js'
import { candidatesFrom, candidatesOfResults, chosenOn, crossCheck, mergeCandidates, signatureOf, rawOfParams } from '../scanner-runner/tuneChecks.mjs'
import { CHECK_COLUMNS, DAY_COLUMNS, RUN_COLUMNS, SETTING_COLUMNS, SETTING_KEYS, historyOf, toCsv } from '../scanner-runner/tuneHistory.mjs'
import { day } from './synthetic-day.mjs'

const syn = day()
const replayDay = { meta: { lotSize: 75, lastPrice: syn.path.at(-1) }, minuteBars: syn.minuteBars, trades: [], icebergs: [], heatmap: [], sweeps: [], source: 'live' }
const all = await scanDaySetups({ day: replayDay, prints: syn.prints, oi: syn.oi, profile: null, rowSize: 1, lotSize: 75, largeLots: 10, estimated: false, filters: {}, keepAll: true })
const id = all[0].id
// Two "months" of days (the same synthetic session each day).
const sept = Array.from({ length: 6 }, (_, i) => tuningDay(`2026-09-1${i}`, all, replayDay, syn.oi))
const oct = Array.from({ length: 6 }, (_, i) => tuningDay(`2026-10-1${i}`, all, replayDay, syn.oi))
const sum = (xs) => xs.reduce((a, b) => a + b, 0)

test('a setting checked on a day: its trades and the strategy as written on the same day, in the tuning\'s own measure', () => {
  const params = { ...DEFAULT_VARIANT, tradeSide: 'long' }
  const rows = checkSetting(oct, id, params, 'R')
  assert.ok(rows.length > 0)
  for (const r of rows) {
    const d = oct.find((x) => x.date === r.date)
    const mine = dayTrades(d, id, params, null)
    const base = dayTrades(d, id, DEFAULT_VARIANT, null)
    assert.equal(r.n, mine.length)
    assert.ok(Math.abs(r.total - sum(mine)) < 1e-9)
    assert.equal(r.baseN, base.length)
    assert.ok(Math.abs(r.baseTotal - sum(base)) < 1e-9)
  }
})

test('the cross-check of a run\'s own setting is exactly what the tuning measured on its held-back days', () => {
  const days = [...sept, ...oct]
  const res = tuneStrategy(days, id, { minTrades: 2, what: 'trade' })
  assert.ok(res.best, 'something was tuned')
  const own = candidatesOfResults([{ ...res, settingText: 'x' }])
  const rows = crossCheck(days, own, null)
  const { test: held } = splitDays(days)
  assert.deepEqual([...new Set(rows.map((r) => r.date))].sort(), held.map((d) => d.date).filter((date) => rows.some((r) => r.date === date)).sort(), 'only the held-back days')
  assert.ok(rows.every((r) => !res.trainDays.includes(r.date)), 'never a day it was chosen on')
  assert.equal(sum(rows.map((r) => r.n)), res.best.test.n)
  assert.ok(Math.abs(sum(rows.map((r) => r.total)) - res.best.test.total) < 1e-9)
})

test('every setting found so far is checked on the days it was not chosen on - older runs\' from their history files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tune-checks-'))
  try {
    // September's run, as tune.mjs writes it: settings, days (train / test), runs.csv.
    const sepRes = tuneStrategy(sept, id, { minTrades: 2, what: 'trade' })
    assert.ok(sepRes.best)
    const sepTest = new Set(splitDays(sept).test.map((d) => d.date))
    const h = historyOf({
      underlying: 'NIFTY', data: 'futures', finishedMs: Date.parse('2026-10-01T10:00:00Z'), what: 'trade', search: 'step', minTrades: 2,
      days: sept.map((d) => ({ date: d.date, role: sepTest.has(d.date) ? 'test' : 'train' })), skipped: [], results: [{ ...sepRes, settingText: 'sept best' }], trades: [],
    })
    writeFileSync(join(dir, `${h.run_id}-settings.csv`), toCsv(SETTING_COLUMNS, h.settings))
    writeFileSync(join(dir, `${h.run_id}-days.csv`), toCsv(DAY_COLUMNS, h.days))
    // An older run with no days list, and one for another index - neither must leak in wrongly.
    const old = historyOf({ underlying: 'NIFTY', data: 'futures', finishedMs: Date.parse('2026-09-01T10:00:00Z'), what: 'trade', days: sept.slice(0, 3).map((d) => ({ date: d.date })), skipped: [], results: [{ ...sepRes, best: { ...sepRes.best, params: { ...sepRes.best.params, tradeSide: 'short' } }, settingText: 'old' }], trades: [] })
    writeFileSync(join(dir, `${old.run_id}-settings.csv`), toCsv(SETTING_COLUMNS, old.settings))
    const bank = historyOf({ underlying: 'BANKNIFTY', data: 'futures', finishedMs: Date.parse('2026-10-02T10:00:00Z'), what: 'trade', days: [], skipped: [], results: [{ ...sepRes, settingText: 'bank' }], trades: [] })
    writeFileSync(join(dir, `${bank.run_id}-settings.csv`), toCsv(SETTING_COLUMNS, bank.settings))
    writeFileSync(join(dir, 'runs.csv'), toCsv(RUN_COLUMNS, [old.run, h.run, bank.run]))

    const found = candidatesFrom(dir, { underlying: 'NIFTY', data: 'futures' })
    assert.equal(found.length, 2, 'NIFTY futures only: September\'s and the older run\'s')
    const sepC = found.find((c) => c.settingText === 'sept best')
    assert.deepEqual([...sepC.trainDates].sort(), sept.filter((d) => !sepTest.has(d.date)).map((d) => d.date))
    const oldC = found.find((c) => c.settingText === 'old')
    assert.equal(oldC.trainDates.size, 0)
    assert.deepEqual(oldC.ranges, [[sept[0].date, sept[2].date]], 'no days list: none of its days count as unseen')
    assert.ok(chosenOn(oldC, sept[1].date) && !chosenOn(oldC, oct[0].date))

    // October's run: its own setting, plus September's - which is checked on EVERY October day (all unseen for it).
    // (The synthetic months are alike, so October's own best is made different by hand: another stop size.)
    const octParams = { ...sepRes.best.params, tradeStopX: sepRes.best.params.tradeStopX === 2 ? 1.5 : 2 }
    const octTest = new Set(splitDays(oct).test.map((d) => d.date))
    const octOwn = { ...candidatesOfResults([{ ...sepRes, best: { ...sepRes.best, params: octParams }, trainDays: oct.filter((d) => !octTest.has(d.date)).map((d) => d.date), settingText: 'oct best' }])[0] }
    const cands = mergeCandidates(found, [octOwn])
    assert.equal(cands.length, 3)
    const rows = crossCheck(oct, cands, null)
    const sepRows = rows.filter((r) => r.settingText === 'sept best')
    const expected = oct.map((d) => dayTrades(d, id, { ...DEFAULT_VARIANT, ...sepRes.best.params }, null).length)
    assert.ok(sum(expected) > 0)
    assert.equal(sum(sepRows.map((r) => r.n)), sum(expected), 'September\'s setting measured on all of October')
    assert.ok(rows.filter((r) => r.settingText === 'oct best').every((r) => octTest.has(r.date)), 'October\'s own: only its held-back days')
    assert.equal(sum(rows.filter((r) => r.settingText === 'old').map((r) => r.n)), sum(oct.map((d) => dayTrades(d, id, { ...DEFAULT_VARIANT, ...sepRes.best.params, tradeSide: 'short' }, null).length)))
    // The CSV: the setting's own columns, and nothing else the server could mistake for one.
    const csv = toCsv(CHECK_COLUMNS, rows.map((r) => ({ ...r, run_id: 'X', index: 'NIFTY', data: 'futures' })))
    const header = csv.split('\n')[0].split(',')
    assert.deepEqual(header.filter((k) => /^(trade|opt)/.test(k)), SETTING_KEYS)
    // Re-checking September (no new tuning): October's setting is measured on all of September, September's only on
    // its own held-back days.
    const back = crossCheck(sept, cands, null)
    assert.ok(back.filter((r) => r.settingText === 'sept best').every((r) => sepTest.has(r.date)))
    assert.ok(back.filter((r) => r.settingText === 'oct best').every((r) => sept.some((d) => d.date === r.date)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the same setting chosen again by a later run keeps the days every run chose it on', () => {
  const a = { id, unit: 'R', raw: rawOfParams({ tradeSide: 'long' }), params: { tradeSide: 'long' }, trainDates: new Set(['2026-09-10']), ranges: [], runs: ['R1'] }
  const b = { ...a, trainDates: new Set(['2026-10-10']), runs: ['this run'], settingText: 'again' }
  const m = mergeCandidates([a], [b])
  assert.equal(m.length, 1)
  assert.deepEqual([...m[0].trainDates].sort(), ['2026-09-10', '2026-10-10'])
  assert.deepEqual(m[0].runs, ['R1', 'this run'])
  // A file with fewer columns (written before a filter existed) is the same setting.
  assert.equal(signatureOf({ tradeSide: 'long' }), signatureOf({ tradeSide: 'long', tradeWallRoom: '' }))
})
