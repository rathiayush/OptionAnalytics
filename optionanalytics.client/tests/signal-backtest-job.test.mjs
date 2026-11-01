// The Signal backtest in the BACKGROUND (signalBacktestJob.js, scanner-runner/signal-backtest.mjs): a run is its days'
// outcomes put together - the same trades and report the page works out (simulateRun / summarize) - its settings held to
// the page's ranges, and the job script, run against a fake server as the server runs it, writes exactly the report the
// page would show for the same days (a holiday not run, a day that failed on the way tried once more).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { day as syntheticDay } from './synthetic-day.mjs'
import { BACKTEST_DEFAULTS, prepareDay, simulateRun, summarize } from '../src/signalBacktest.js'
import {
  backtestReport, cleanBacktestSettings, dayOutcome, defaultRunName, engineSettings, loadBacktestDay, reportHead, reportReplacer, reportReviver,
} from '../src/signalBacktestJob.js'

const { run } = syntheticDay()
const BASE = Date.parse('2026-10-05T00:00:00Z')
// The synthetic day moved to `date`, its prices bent a little per day so the days differ.
function runFor(date) {
  const shift = Date.parse(`${date}T00:00:00Z`) - BASE
  const k = shift / 864e5
  const sign = k % 2 ? -1 : 1
  const move = (p) => ({ ...p, time: new Date(Date.parse(p.time) + shift).toISOString() })
  const bend = (b, m) => ({ ...move(b), open: b.open + sign * m * 0.15, high: b.high + sign * m * 0.15, low: b.low + sign * m * 0.15, close: b.close + sign * m * 0.15 })
  return {
    ...run, success: true, date, optionExpiry: date, underlying: 'NIFTY',
    spotCandlesOneMinute: run.spotCandlesOneMinute.map(bend), futuresBars: run.futuresBars.map(bend),
    cePoints: run.cePoints.map(move), pePoints: run.pePoints.map(move),
  }
}
const PREV = { success: true, profileDate: '2026-10-16', poc: 22740, vah: 22790, val: 22700, hvn: [22770], lvn: [22720], bins: [], bars: [] }
const DATES = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']
const HOLIDAY = '2026-10-21'
const RULE = { tree: { op: 'or', not: false, items: [{ line: { id: 'vwap', value: 'crossedAbove', windowMin: 5 } }, { line: { id: 'prevPoc', value: 'crossedAbove', windowMin: 5 } }] }, action: 'buyCE', mirror: true }
const SETTINGS = cleanBacktestSettings({ underlying: 'NIFTY', from: DATES[0], to: DATES.at(-1), rule: RULE, maxTradesPerDay: 5, cooldownMin: 0, timeStopMin: 30, trailGap: 10 })

// What the page works out for these days: each day prepared, then simulateRun / summarize as the page always has.
function pageReport(settings) {
  const engine = engineSettings(settings)
  const days = DATES.map((date) => (date === HOLIDAY ? { ok: false, date, reason: 'holiday' } : prepareDay(runFor(date), { underlying: 'NIFTY', prevProfile: date === '2026-10-23' ? null : PREV })))
  return { engine, days, ...simulateRun(days, engine) }
}

test('a run is its days\' outcomes: the same trades, signals and numbers simulateRun / summarize give', () => {
  for (const mirror of [true, false]) {
    const settings = { ...SETTINGS, rule: { ...SETTINGS.rule, mirror } }
    const { engine, days, trades, signals } = pageReport(settings)
    assert.ok(trades.length > 3)
    // In any order: the report sorts the days.
    const outcomes = days.map((d, k) => dayOutcome(DATES[k], d, engine)).reverse()
    const report = backtestReport(outcomes, settings)
    assert.deepEqual(report.trades, trades)
    assert.deepEqual(report.all, { key: 'all', id: 'all', name: 'Both', what: 'the rule and its mirror together', signals: signals.length, ...summarize(trades) })
    assert.deepEqual(report.sides, mirror ? ['rule', 'mirror'] : ['rule'])
    for (const row of report.rows) {
      assert.equal(row.signals, signals.filter((x) => x.strategy === row.id).length)
      assert.deepEqual({ ...row, key: 0, id: 0, name: 0, what: 0, signals: 0 }, { key: 0, id: 0, name: 0, what: 0, signals: 0, ...summarize(trades.filter((t) => t.strategy === row.id)) })
    }
    assert.equal(report.okDays, 4)
    assert.deepEqual(report.dayRows.map((r) => r.date), DATES)
    assert.deepEqual(report.dayRows.map((r) => r.expiry), [true, true, false, true, true])   // each day the synthetic run's expiry; the holiday not run
    assert.deepEqual(report.failed, [{ date: HOLIDAY, reason: 'holiday' }])
    assert.deepEqual(report.noPrev, ['2026-10-23'])           // the rule reads the previous day's POC
    const last = report.lines.find((l) => l.id === 'all').points.at(-1)
    assert.equal(last.value, Math.round(trades.reduce((a, t) => a + t.net, 0)))
  }
})

test('the settings are held to the page\'s ranges, the rule through its tree', () => {
  const s = cleanBacktestSettings({
    underlying: 'FINNIFTY', from: '2026-13-01', to: '2026-10-23', slPct: 5000, targetPct: -3, levelUnit: 'x', trailGap: '12', lots: 2.6, maxTradesPerDay: 0,
    cooldownMin: 500, timeStopMin: null, charges: 'yes', timeframe: 7, moneyness: 4, rule: { lines: [{ id: 'vwap', value: 'above' }, { id: 'nope', value: 'x' }], action: 'sellPE', mirror: false },
  })
  assert.equal(s.underlying, 'NIFTY')
  assert.equal(s.from, null)
  assert.equal(s.to, '2026-10-23')
  assert.equal(s.levelUnit, 'pct')
  assert.equal(s.slPct, 1000)                         // % of premium: at most 1000
  assert.equal(s.targetPct, 0)
  assert.equal(s.trailGap, 12)
  assert.equal(s.lots, 3)
  assert.equal(s.maxTradesPerDay, 1)
  assert.equal(s.cooldownMin, 120)
  assert.equal(s.timeStopMin, BACKTEST_DEFAULTS.timeStopMin)
  assert.equal(s.charges, BACKTEST_DEFAULTS.charges)
  assert.equal(s.timeframe, BACKTEST_DEFAULTS.timeframe)
  assert.equal(s.moneyness, 1)
  assert.deepEqual(s.rule, { tree: { op: 'and', not: false, items: [{ line: { id: 'vwap', value: 'above', join: 'and', param: 0 } }] }, action: 'sellPE', mirror: false })
  assert.equal(cleanBacktestSettings({ levelUnit: 'pts', slPct: 9000 }).slPct, 5000)
  assert.deepEqual(engineSettings(cleanBacktestSettings({ underlying: 'SENSEX' })).lotSize, 20)
  assert.equal(reportHead(SETTINGS, 4), 'NIFTY · 4 days · 1m candles · SL 30% · target 50% · trail 10%')
  assert.equal(reportHead(SETTINGS, 0), '')
  // The expiry day's choice: kept when it is one, else "as the rule"; named in the heading when it overrides.
  assert.equal(cleanBacktestSettings({ expiryDay: 'sell' }).expiryDay, 'sell')
  assert.equal(cleanBacktestSettings({ expiryDay: 'hold' }).expiryDay, 'rule')
  assert.equal(engineSettings(cleanBacktestSettings({ expiryDay: 'sell' })).expiryDay, 'sell')   // what the engine (and a background run) reads
  assert.equal(SETTINGS.expiryDay, 'rule')
  assert.equal(reportHead({ ...SETTINGS, expiryDay: 'sell' }, 4), 'NIFTY · 4 days · 1m candles · SL 30% · target 50% · trail 10% · expiry day: sell')
  assert.equal(defaultRunName(SETTINGS), 'NIFTY 19 Oct – 23 Oct · Buy CE + mirror')
  // A profit factor with no losing trade survives JSON.
  assert.deepEqual(JSON.parse(JSON.stringify({ pf: Infinity, w: -Infinity, x: 1 }, reportReplacer), reportReviver), { pf: Infinity, w: -Infinity, x: 1 })
})

test('a day that cannot be read is final, one that failed on the way is worth one more try', async () => {
  const answer = (status, body) => async () => ({ ok: status < 400, status, json: async () => body })
  const holiday = await loadBacktestDay('NIFTY', HOLIDAY, { fetch: answer(200, { success: false, error: 'No NIFTY spot candles (a holiday?)' }) })
  assert.deepEqual(holiday, { ok: false, date: HOLIDAY, reason: 'No NIFTY spot candles (a holiday?)', retry: false })
  assert.equal((await loadBacktestDay('NIFTY', HOLIDAY, { fetch: answer(502, null) })).retry, true)
  assert.equal((await loadBacktestDay('NIFTY', HOLIDAY, { fetch: async () => { throw new Error('socket hang up') } })).retry, true)
  const slow = await loadBacktestDay('NIFTY', HOLIDAY, { timeoutMs: 20, fetch: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) })
  assert.deepEqual([slow.reason, slow.retry], ['took too long to load', true])
  const thin = await loadBacktestDay('NIFTY', HOLIDAY, { fetch: answer(200, { ...runFor(HOLIDAY), spotCandlesOneMinute: [], futuresBars: [] }) })
  assert.equal(thin.ok, false)
  assert.equal(thin.final, true)
  const stop = new AbortController()
  stop.abort()
  await assert.rejects(loadBacktestDay('NIFTY', HOLIDAY, { signal: stop.signal, fetch: (_url, { signal }) => new Promise((_, reject) => { if (signal.aborted) reject(new Error('stopped')) }) }))
})

test('the background job, as the server runs it, writes the report the page would show', async (t) => {
  const asked = []
  let failOnce = true
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const date = url.searchParams.get('date')
    asked.push({ path: url.pathname, date, key: req.headers['x-runner-key'] })
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (url.pathname.endsWith('/previous-day-volume-profile')) return json(200, date === '2026-10-23' ? { success: false } : PREV)
    if (url.pathname === '/api/oi-replay/NIFTY/run') {
      if (date === HOLIDAY) return json(200, { success: false, error: 'holiday' })
      if (date === '2026-10-22' && failOnce) { failOnce = false; return json(503, { error: 'busy' }) }
      return json(200, runFor(date))
    }
    return json(404, { error: 'not mocked' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const dir = mkdtempSync(join(tmpdir(), 'oa-sbt-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const out = join(dir, 'result.json')
  const script = fileURLToPath(new URL('../scanner-runner/signal-backtest.mjs', import.meta.url))
  const progress = []
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env, RUNNER_BASE_URL: `http://127.0.0.1:${server.address().port}`, RUNNER_KEY: 'k-123', BACKTEST_OUT: out, BACKTEST_TODAY: '2026-10-26',
        BACKTEST_JOB: JSON.stringify({ ...SETTINGS, to: '2026-10-25' }),   // the weekend is not run
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    child.stdout.on('data', (b) => progress.push(...String(b).split('\n').filter((l) => l.startsWith('PROGRESS ')).map((l) => JSON.parse(l.slice(9)))))
    child.on('error', reject)
    child.on('exit', resolve)
  })
  assert.equal(code, 0)
  const result = JSON.parse(readFileSync(out, 'utf8'), reportReviver)
  assert.equal(result.ok, true)
  assert.deepEqual(result.dates, DATES)
  // The page's report for the same days, through JSON as the page reads the job's.
  const { engine, days } = pageReport(SETTINGS)
  const page = JSON.parse(JSON.stringify(backtestReport(days.map((d, k) => dayOutcome(DATES[k], d, engine)), SETTINGS), reportReplacer), reportReviver)
  assert.deepEqual(result.report, page)
  assert.deepEqual(result.settings, { ...SETTINGS, to: '2026-10-25' })
  // Every request carried the runner's key; the holiday was asked once, the day that failed on the way twice.
  assert.ok(asked.every((a) => a.key === 'k-123'))
  const runs = (date) => asked.filter((a) => a.path.endsWith('/run') && a.date === date).length
  assert.equal(runs(HOLIDAY), 1)
  assert.equal(runs('2026-10-22'), 2)
  assert.equal(runs('2026-10-19'), 1)
  assert.deepEqual(progress.filter((p) => p.stage === 'day').map((p) => p.day), DATES)
  assert.equal(progress.at(-1).stage, 'done')
  assert.equal(progress.at(-1).trades, page.trades.length)
})

test('the background job writes why when it cannot run', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'oa-sbt-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const out = join(dir, 'result.json')
  const script = fileURLToPath(new URL('../scanner-runner/signal-backtest.mjs', import.meta.url))
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, RUNNER_BASE_URL: 'http://127.0.0.1:9', BACKTEST_OUT: out, BACKTEST_TODAY: '2026-10-26', BACKTEST_JOB: JSON.stringify({ underlying: 'NIFTY', from: '2026-10-26', to: '2026-10-30' }) },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    child.on('exit', resolve)
  })
  assert.equal(code, 1)
  const result = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(result.ok, false)
  assert.match(result.error, /no past weekdays/)
})
