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
import { BACKTEST_DEFAULTS, MAX_BACKGROUND_DAYS, backtestDays, prepareDay, simulateRun, summarize } from '../src/signalBacktest.js'
import {
  backtestReport, cleanBacktestSettings, dayOutcome, daySource, defaultRunName, engineSettings, featureRunHead, featureTradeText, indexLevels, loadBacktestDay, loadSourceText, monthRows, reportHead,
  reportReplacer, reportReviver, runRange, withIndexLevels,
} from '../src/signalBacktestJob.js'
import { CONTEXT, dayRows, featureReports, rowsCsv } from '../src/featureFinder.js'

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

test('expiry day not traded: the expiry days\' rows say so with no trade on them - another day as the rule', () => {
  const skip = { ...SETTINGS, expiryDay: 'skip' }
  const { engine, days } = pageReport(skip)
  // The synthetic days are all their options' expiry; 22 Oct made an ordinary day - it trades as with "As the rule".
  const mixed = days.map((d) => (d.date === '2026-10-22' ? { ...d, isExpiry: false } : d))
  const report = backtestReport(mixed.map((d, k) => dayOutcome(DATES[k], d, engine)), skip)
  const asRule = backtestReport(mixed.map((d, k) => dayOutcome(DATES[k], d, engineSettings(SETTINGS))), SETTINGS)
  assert.deepEqual(report.dayRows.map((r) => [r.date, r.expiry, r.expirySkipped, r.trades]), [
    ['2026-10-19', true, true, 0], ['2026-10-20', true, true, 0], [HOLIDAY, false, false, 0],
    ['2026-10-22', false, false, asRule.dayRows[3].trades], ['2026-10-23', true, true, 0],
  ])
  assert.ok(asRule.dayRows[3].trades > 0)
  assert.deepEqual(report.trades, asRule.trades.filter((t) => t.date === '2026-10-22'))
  assert.ok(asRule.dayRows.every((r) => !r.expirySkipped))
})

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
    assert.ok(report.dayRows.every((r) => r.limit === null))   // no day limit set
  }
  // A day max profit: each day's outcome and row says which day it ended (no trade after it) - the same trades as the page.
  const limited = { ...SETTINGS, maxDayProfit: 1500 }
  const { engine, days, trades } = pageReport(limited)
  const outcomes = days.map((d, k) => dayOutcome(DATES[k], d, engine))
  const report = backtestReport(outcomes, limited)
  assert.deepEqual(report.trades, trades)
  assert.deepEqual(report.dayRows.map((r) => r.limit), ['profit', 'profit', null, 'profit', 'profit'])   // every day made more than ₹1,500 without it
  for (const r of report.dayRows.filter((x) => x.limit)) {
    assert.equal(outcomes.find((x) => x.date === r.date).limit, 'profit')
    assert.ok(r.net >= 1500 - 0.01 && r.net < 3278)
  }
})

test('the settings are held to the page\'s ranges, the rule through its tree', () => {
  const s = cleanBacktestSettings({
    underlying: 'FINNIFTY', from: '2026-13-01', to: '2026-10-23', slPct: 5000, targetPct: -3, levelUnit: 'x', trailGap: '12', lots: 2.6, maxTradesPerDay: 0,
    cooldownMin: 500, timeStopMin: null, charges: 'yes', timeframe: 7, moneyness: 6, rule: { lines: [{ id: 'vwap', value: 'above' }, { id: 'nope', value: 'x' }], action: 'sellPE', mirror: false },
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
  assert.equal(s.moneyness, 4)                         // ATM, 1 - 4 ITM / OTM: 6 held to 4 ITM
  assert.deepEqual([-7, -2.6, 3].map((m) => cleanBacktestSettings({ moneyness: m }).moneyness), [-4, -3, 3])
  // Cost SL: off by default, read on spot or the premium; anything else off. Named in the heading with the strike.
  assert.deepEqual(['spot', 'premium', 'yes', undefined].map((c) => cleanBacktestSettings({ costSl: c }).costSl), ['spot', 'premium', '', ''])
  assert.match(reportHead({ ...SETTINGS, costSl: 'spot', moneyness: -2 }, 4), / · 1m candles · 2 OTM · SL 30% · target 50% · trail 10% · cost SL \(spot\) · net of /)
  // Its "after +": held to 0 - 5000, named with its unit (spot points; the premium's in the levels' unit).
  assert.deepEqual([20, -3, 9999, 'x'].map((v) => cleanBacktestSettings({ costAfter: v }).costAfter), [20, 0, 5000, 0])
  assert.match(reportHead({ ...SETTINGS, costSl: 'spot', costAfter: 20 }, 4), / · cost SL \(spot after \+20 pts\) · /)
  assert.match(reportHead({ ...SETTINGS, costSl: 'premium', costAfter: 15 }, 4), / · cost SL \(premium after \+15%\) · /)
  assert.deepEqual(s.rule, { tree: { op: 'and', not: false, items: [{ line: { id: 'vwap', value: 'above', join: 'and', param: 0 } }] }, action: 'sellPE', mirror: false })
  assert.equal(cleanBacktestSettings({ levelUnit: 'pts', slPct: 9000 }).slPct, 5000)
  assert.deepEqual(engineSettings(cleanBacktestSettings({ underlying: 'SENSEX' })).lotSize, 20)
  assert.equal(reportHead(SETTINGS, 4), 'NIFTY · 4 days · 19 Oct 2026 – 23 Oct 2026 · 1m candles · SL 30% · target 50% · trail 10% · net of STT 0.15% + ₹20 an order')
  assert.match(reportHead({ ...SETTINGS, charges: false }, 4), / · no charges$/)
  assert.match(reportHead({ ...SETTINGS, otherPerTrade: 7 }, 4), / · net of STT 0.15% \+ ₹20 an order \+ ₹7 a trade$/)
  // The charge rates: the defaults (0.15% STT, ₹20 an order, nothing else), held to their ranges, read by the engine.
  assert.deepEqual([SETTINGS.sttPct, SETTINGS.brokeragePerOrder, SETTINGS.otherPerTrade], [0.15, 20, 0])
  const rates = cleanBacktestSettings({ sttPct: 5, brokeragePerOrder: -3, otherPerTrade: '12' })
  assert.deepEqual([rates.sttPct, rates.brokeragePerOrder, rates.otherPerTrade], [1, 0, 12])
  assert.deepEqual(['sttPct', 'brokeragePerOrder', 'otherPerTrade'].map((k) => engineSettings(rates)[k]), [1, 0, 12])
  assert.equal(reportHead(SETTINGS, 0), '')
  // The expiry day's choice: kept when it is one, else "as the rule"; named in the heading when it overrides.
  assert.equal(cleanBacktestSettings({ expiryDay: 'sell' }).expiryDay, 'sell')
  assert.equal(cleanBacktestSettings({ expiryDay: 'hold' }).expiryDay, 'rule')
  assert.equal(engineSettings(cleanBacktestSettings({ expiryDay: 'sell' })).expiryDay, 'sell')   // what the engine (and a background run) reads
  assert.equal(SETTINGS.expiryDay, 'rule')
  assert.equal(reportHead({ ...SETTINGS, expiryDay: 'sell' }, 4), 'NIFTY · 4 days · 19 Oct 2026 – 23 Oct 2026 · 1m candles · SL 30% · target 50% · trail 10% · expiry day: sell · net of STT 0.15% + ₹20 an order')
  // "Don't trade" on the expiry day: kept, named in the heading.
  assert.equal(cleanBacktestSettings({ expiryDay: 'skip' }).expiryDay, 'skip')
  assert.match(reportHead({ ...SETTINGS, expiryDay: 'skip' }, 4), / · trail 10% · expiry day: not traded · net of /)
  // The day's max loss / profit: off (0) by default, held to 0 - ₹1 crore, read by the engine, named in the heading.
  assert.deepEqual([SETTINGS.maxDayLoss, SETTINGS.maxDayProfit], [0, 0])
  const limits = cleanBacktestSettings({ maxDayLoss: '5000', maxDayProfit: 2e8 })
  assert.deepEqual([limits.maxDayLoss, limits.maxDayProfit], [5000, 10_000_000])
  assert.deepEqual([cleanBacktestSettings({ maxDayLoss: -5 }).maxDayLoss, cleanBacktestSettings({ maxDayProfit: true }).maxDayProfit], [0, 0])
  assert.deepEqual(['maxDayLoss', 'maxDayProfit'].map((k) => engineSettings(limits)[k]), [5000, 10_000_000])
  assert.equal(reportHead({ ...SETTINGS, maxDayLoss: 5000, maxDayProfit: 12500 }, 4),
    'NIFTY · 4 days · 19 Oct 2026 – 23 Oct 2026 · 1m candles · SL 30% · target 50% · trail 10% · day max loss ₹5,000 · day max profit ₹12,500 · net of STT 0.15% + ₹20 an order')
  assert.match(reportHead({ ...SETTINGS, maxDayProfit: 12500 }, 4), / · trail 10% · day max profit ₹12,500 · net of/)
  assert.equal(defaultRunName(SETTINGS), 'NIFTY 19 Oct 2026 – 23 Oct 2026 · Buy CE + mirror')
  // A run's days carry their years: two runs of "1 Jan – 31 Dec" can be different years, and a range can cross one.
  assert.equal(runRange('2025-01-01', '2025-12-31'), '1 Jan 2025 – 31 Dec 2025')
  assert.equal(runRange('2025-12-01', '2026-01-31'), '1 Dec 2025 – 31 Jan 2026')
  assert.equal(runRange(null, '2026-11-03'), '? – 3 Nov 2026')
  // A profit factor with no losing trade survives JSON.
  assert.deepEqual(JSON.parse(JSON.stringify({ pf: Infinity, w: -Infinity, x: 1 }, reportReplacer), reportReviver), { pf: Infinity, w: -Infinity, x: 1 })
})

test('where a day came from: the server\'s X-Dhan-Calls - Dhan, its disk, or not said', async () => {
  const answer = (headers) => async () => ({ ok: true, status: 200, headers: new Headers(headers), json: async () => runFor('2026-10-19') })
  const fromDhan = await loadBacktestDay('NIFTY', '2026-10-19', { fetch: answer({ 'X-Dhan-Calls': '45' }) })
  const fromDisk = await loadBacktestDay('NIFTY', '2026-10-19', { fetch: answer({ 'X-Dhan-Calls': '0' }) })
  const unknown = await loadBacktestDay('NIFTY', '2026-10-19', { fetch: answer({}) })
  assert.deepEqual([fromDhan.dhanCalls, fromDisk.dhanCalls, unknown.dhanCalls], [45, 0, null])
  assert.deepEqual([daySource(fromDhan), daySource(fromDisk), daySource(unknown)], ['dhan', 'disk', null])
  assert.equal(loadSourceText({ disk: 57, dhan: 3 }), "57 from the server's disk, 3 asked of Dhan (the first time - kept on the server now)")
  assert.equal(loadSourceText({ tab: 4 }), '4 already in this tab')
  assert.equal(loadSourceText({}), '')
})

test('a day that cannot be read is final, one that failed on the way is worth one more try', async () => {
  const answer = (status, body) => async () => ({ ok: status < 400, status, json: async () => body })
  const holiday = await loadBacktestDay('NIFTY', HOLIDAY, { fetch: answer(200, { success: false, error: 'No NIFTY spot candles (a holiday?)' }) })
  assert.deepEqual(holiday, { ok: false, date: HOLIDAY, reason: 'No NIFTY spot candles (a holiday?)', retry: false, dhanCalls: null })
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

// The same day as SENSEX's - its premiums half as high again, so a trade taken in it differs from NIFTY's.
const sensexFor = (date) => {
  const r = runFor(date)
  const priced = (p) => ({ ...p, price: p.price * 1.5 })
  return { ...r, underlying: 'SENSEX', cePoints: r.cePoints.map(priced), pePoints: r.pePoints.map(priced) }
}

test('trade in another index: the settings, the traded lot size, the heading; a day without the traded index\'s does not run', () => {
  assert.equal(cleanBacktestSettings({ underlying: 'NIFTY', tradeIn: 'SENSEX' }).tradeIn, 'SENSEX')
  assert.equal(cleanBacktestSettings({ underlying: 'NIFTY', tradeIn: 'NIFTY' }).tradeIn, '')        // its own index = no trade-in
  assert.equal(cleanBacktestSettings({ underlying: 'NIFTY', tradeIn: 'FTSE' }).tradeIn, '')
  assert.equal(cleanBacktestSettings({ underlying: 'NIFTY' }).tradeIn, '')
  assert.equal(SETTINGS.tradeIn, '')
  assert.deepEqual([engineSettings(SETTINGS).lotSize, engineSettings({ ...SETTINGS, tradeIn: 'SENSEX' }).lotSize, engineSettings({ ...SETTINGS, tradeIn: 'BANKNIFTY' }).lotSize], [65, 20, 30])
  assert.match(reportHead({ ...SETTINGS, tradeIn: 'SENSEX' }, 4), /^NIFTY signals → traded in SENSEX · 4 days · /)
  const day = prepareDay(runFor('2026-10-19'), { underlying: 'NIFTY', prevProfile: PREV })
  const engine = engineSettings({ ...SETTINGS, tradeIn: 'SENSEX' })
  assert.deepEqual(dayOutcome('2026-10-19', day, engine, { ok: false, reason: 'holiday' }), { date: '2026-10-19', ok: false, reason: 'SENSEX: holiday', trades: [], signals: { rule: 0, mirror: 0 } })
  const traded = dayOutcome('2026-10-19', day, engine, prepareDay(sensexFor('2026-10-19'), { underlying: 'SENSEX', prevProfile: PREV }))
  assert.ok(traded.ok && traded.trades.length > 0)
  assert.ok(traded.trades.every((t) => t.tradeIndex === 'SENSEX' && Math.abs(t.gross - t.points * 20) < 1e-6))
  // The signals are NIFTY's: the same as trading in NIFTY itself, the trades' minutes too.
  const own = dayOutcome('2026-10-19', day, engineSettings(SETTINGS))
  assert.deepEqual(traded.signals, own.signals)
  assert.deepEqual(traded.trades.map((t) => t.entryTime), own.trades.map((t) => t.entryTime))
  assert.notDeepEqual(traded.trades.map((t) => t.entry), own.trades.map((t) => t.entry))
})

test('trade in another index in the background: each day loads that index\'s day too - the page\'s report', async (t) => {
  const asked = []
  let failOnce = true
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const date = url.searchParams.get('date')
    asked.push({ path: url.pathname, date })
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (url.pathname.endsWith('/previous-day-volume-profile')) return json(200, PREV)
    if (url.pathname === '/api/oi-replay/NIFTY/run') return json(200, date === HOLIDAY ? { success: false, error: 'holiday' } : runFor(date))
    if (url.pathname === '/api/oi-replay/SENSEX/run') {
      if (date === '2026-10-20' && failOnce) { failOnce = false; return json(503, { error: 'busy' }) }
      return json(200, sensexFor(date))
    }
    return json(404, { error: 'not mocked' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const dir = mkdtempSync(join(tmpdir(), 'oa-sbt-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const out = join(dir, 'result.json')
  const settings = { ...SETTINGS, tradeIn: 'SENSEX' }
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scanner-runner/signal-backtest.mjs', import.meta.url))], {
      env: { ...process.env, RUNNER_BASE_URL: `http://127.0.0.1:${server.address().port}`, RUNNER_KEY: 'k', BACKTEST_OUT: out, BACKTEST_TODAY: '2026-10-26', BACKTEST_JOB: JSON.stringify(settings) },
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    child.on('error', reject)
    child.on('exit', resolve)
  })
  assert.equal(code, 0)
  const result = JSON.parse(readFileSync(out, 'utf8'), reportReviver)
  // The page's report for the same days: NIFTY's days, each with SENSEX's of the same date.
  const engine = engineSettings(settings)
  const outcomes = DATES.map((date) => {
    if (date === HOLIDAY) return dayOutcome(date, { ok: false, date, reason: 'holiday' }, engine)
    return dayOutcome(date, prepareDay(runFor(date), { underlying: 'NIFTY', prevProfile: PREV }), engine, prepareDay(sensexFor(date), { underlying: 'SENSEX', prevProfile: PREV }))
  })
  const page = JSON.parse(JSON.stringify(backtestReport(outcomes, settings), reportReplacer), reportReviver)
  assert.deepEqual(result.report, page)
  assert.ok(page.trades.length > 3 && page.trades.every((t) => t.tradeIndex === 'SENSEX'))
  // SENSEX asked for every day NIFTY ran (not the holiday), the one that failed on the way once more.
  const sensexRuns = (date) => asked.filter((a) => a.path === '/api/oi-replay/SENSEX/run' && a.date === date).length
  assert.deepEqual(DATES.map(sensexRuns), [1, 2, 0, 1, 1])
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

test('a run carries its strategy\'s name: in its settings (one line, at most 80 characters), its report heading and its default name', () => {
  const named = cleanBacktestSettings({ ...SETTINGS, strategyName: '  Narrow CPR\n trend day  ' })
  assert.equal(named.strategyName, 'Narrow CPR trend day')
  assert.equal(cleanBacktestSettings({ ...SETTINGS, strategyName: 'x'.repeat(200) }).strategyName.length, 80)
  assert.equal(cleanBacktestSettings({ ...SETTINGS, strategyName: 42 }).strategyName, '')
  assert.equal(cleanBacktestSettings(SETTINGS).strategyName ?? '', '')
  assert.match(reportHead(named, 4), /^Narrow CPR trend day · NIFTY · 4 days · /)
  assert.equal(defaultRunName(named), 'Narrow CPR trend day · NIFTY 19 Oct 2026 – 23 Oct 2026')
  // Without one: as before.
  assert.equal(defaultRunName({ ...named, strategyName: '' }), 'NIFTY 19 Oct 2026 – 23 Oct 2026 · Buy CE + mirror')
  assert.doesNotMatch(reportHead({ ...named, strategyName: '' }, 4), /Narrow/)
  // The engine does not read it.
  assert.equal('strategyName' in engineSettings(named), false)
})

test('SL / target / trail kept per index: each index its own once set, the old levels until then, held to their ranges', () => {
  const old = { slPct: 25, targetPct: 40, levelUnit: 'pct', trailGap: 0, trailStart: 0, costAfter: 0 }
  // Nothing set: every index reads the old levels.
  assert.deepEqual(indexLevels({}, 'SENSEX', old), old)
  assert.deepEqual(indexLevels(null, 'NIFTY', {}), { slPct: BACKTEST_DEFAULTS.slPct, targetPct: BACKTEST_DEFAULTS.targetPct, levelUnit: 'pct', trailGap: 0, trailStart: 0, costAfter: 0 })
  // SENSEX's SL in points: SENSEX keeps its whole set from then on (the rest as they were); NIFTY still the old.
  let by = withIndexLevels({}, 'SENSEX', { levelUnit: 'pts', slPct: 40 }, old)
  assert.deepEqual(indexLevels(by, 'SENSEX', old), { slPct: 40, targetPct: 40, levelUnit: 'pts', trailGap: 0, trailStart: 0, costAfter: 0 })
  // The Cost SL's "after +" is the index's too (spot points differ per index).
  by = withIndexLevels(by, 'SENSEX', { costAfter: 60 }, old)
  assert.deepEqual([indexLevels(by, 'SENSEX', old).costAfter, indexLevels(by, 'NIFTY', old).costAfter], [60, 0])
  assert.deepEqual(indexLevels(by, 'NIFTY', old), old)
  by = withIndexLevels(by, 'NIFTY', { targetPct: 80 }, old)
  assert.deepEqual([indexLevels(by, 'NIFTY', old).targetPct, indexLevels(by, 'SENSEX', old).targetPct], [80, 40])
  // A change of the old levels later does not move an index that has its own.
  assert.equal(indexLevels(by, 'SENSEX', { ...old, slPct: 10 }).slPct, 40)
  assert.equal(indexLevels(by, 'BANKNIFTY', { ...old, slPct: 10 }).slPct, 10)
  // Held to the ranges: % at most 1000, points 5000; junk = the default.
  assert.deepEqual(indexLevels({ NIFTY: { slPct: 9000, targetPct: 'x', levelUnit: 'pts', costAfter: -5 } }, 'NIFTY'), { slPct: 5000, targetPct: BACKTEST_DEFAULTS.targetPct, levelUnit: 'pts', trailGap: 0, trailStart: 0, costAfter: 0 })
  assert.equal(indexLevels({ NIFTY: 'junk' }, 'NIFTY', old).slPct, 25)
})

test('month by month: the report\'s days and trades by calendar month - the totals the report\'s, each month its own days', () => {
  // A run over the end of September into October, one day that did not run.
  const dates = ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05']
  const settings = { ...SETTINGS, from: dates[0], to: dates.at(-1) }
  const engine = engineSettings(settings)
  const outcomes = dates.map((date) => (date === '2026-10-01'
    ? dayOutcome(date, { ok: false, reason: 'holiday' }, engine)
    : dayOutcome(date, prepareDay(runFor(date), { underlying: 'NIFTY', prevProfile: PREV }), engine)))
  const report = backtestReport(outcomes, settings)
  const months = monthRows(report)
  assert.deepEqual(months.map((m) => [m.month, m.days]), [['2026-09', 3], ['2026-10', 2]])   // the holiday not counted
  assert.ok(report.all.trades > 3)
  // Together they are the report: trades, wins, gross, charges, net; each side's net adds up to the month's.
  const sum = (k) => months.reduce((a, m) => a + m[k], 0)
  assert.equal(sum('trades'), report.all.trades)
  assert.equal(sum('wins'), report.all.wins)
  for (const k of ['gross', 'charges', 'net']) assert.ok(Math.abs(sum(k) - report.all[k]) < 1e-6, k)
  for (const m of months) {
    assert.ok(Math.abs(m.rule + m.mirror - m.net) < 1e-6)
    const days = report.dayRows.filter((d) => d.ok && d.date.startsWith(m.month))
    assert.ok(Math.abs(days.reduce((a, d) => a + d.net, 0) - m.net) < 1e-6)
    const traded = days.filter((d) => d.trades > 0)
    assert.equal(m.daysTraded, traded.length)
    assert.equal(m.greenDays, traded.filter((d) => d.net > 0).length)
    assert.equal(m.best, Math.max(...traded.map((d) => d.net)))
    assert.equal(m.worst, Math.min(...traded.map((d) => d.net)))
    assert.equal(m.winRate, (m.wins / m.trades) * 100)
  }
  // The running total to each month's end; the last is the run's net.
  assert.ok(Math.abs(months[0].total - months[0].net) < 1e-6)
  assert.ok(Math.abs(months.at(-1).total - report.all.net) < 1e-6)
  // A report read back from JSON (a background run's, written before month by month) gives the same; nothing = none.
  assert.deepEqual(monthRows(JSON.parse(JSON.stringify(report, reportReplacer), reportReviver)), months)
  assert.deepEqual(monthRows(null), [])
  assert.deepEqual(monthRows({ dayRows: [{ date: '2026-09-28', ok: true, trades: 0, net: 0 }], trades: [] }).map((m) => [m.month, m.days, m.trades, m.winRate, m.best]), [['2026-09', 1, 0, null, null]])
})

test('Σ 3 expiries in the background: each day loads its next and monthly expiries, summed - the page\'s report', async (t) => {
  const asked = []
  const chainOf = (date, scale) => {
    const r = runFor(date)
    const side = (list) => list.map((p) => ({ ...p, openInterest: p.openInterest * scale, price: p.price * 2 }))
    return { cePoints: side(r.cePoints), pePoints: side(r.pePoints) }
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const date = url.searchParams.get('date')
    asked.push({ path: url.pathname, date, search: url.search })
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (url.pathname.endsWith('/previous-day-volume-profile')) return json(200, PREV)
    if (url.pathname === '/api/oi-replay/NIFTY/run') return json(200, date === HOLIDAY ? { success: false, error: 'holiday' } : runFor(date))
    if (url.pathname === '/api/oi-replay/NIFTY/summed-expiries') return json(200, { current: '2026-10-27', next: '2026-11-03', monthly: '2026-11-24' })
    if (url.pathname === '/api/oi-replay/NIFTY/expiry-band') {
      const c = chainOf(date, url.searchParams.get('expiryFlag') === 'MONTH' ? 3 : 1)
      return json(200, { success: true, ...c })
    }
    return json(404, { error: 'not mocked' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const dir = mkdtempSync(join(tmpdir(), 'oa-sbt-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const out = join(dir, 'result.json')
  const settings = { ...SETTINGS, sumExpiries: true }
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scanner-runner/signal-backtest.mjs', import.meta.url))], {
      env: { ...process.env, RUNNER_BASE_URL: `http://127.0.0.1:${server.address().port}`, RUNNER_KEY: 'k', BACKTEST_OUT: out, BACKTEST_TODAY: '2026-10-26', BACKTEST_JOB: JSON.stringify(settings) },
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    child.on('error', reject)
    child.on('exit', resolve)
  })
  assert.equal(code, 0)
  const result = JSON.parse(readFileSync(out, 'utf8'), reportReviver)
  assert.equal(result.settings.sumExpiries, true)
  // The page's report for the same days, each prepared with its two other expiries.
  const engine = engineSettings(settings)
  const outcomes = DATES.map((date) => {
    if (date === HOLIDAY) return dayOutcome(date, { ok: false, date, reason: 'holiday' }, engine)
    const chains = [{ ...chainOf(date, 1), expiry: '2026-11-03' }, { ...chainOf(date, 3), expiry: '2026-11-24' }]
    return dayOutcome(date, prepareDay(runFor(date), { underlying: 'NIFTY', prevProfile: PREV, expiryChains: chains }), engine)
  })
  const page = JSON.parse(JSON.stringify(backtestReport(outcomes, settings), reportReplacer), reportReviver)
  assert.deepEqual(result.report, page)
  // Every day the run read (not the holiday) asked its two bands once - the next (code 2) and the monthly.
  const bands = (date) => asked.filter((a) => a.path.endsWith('/expiry-band') && a.date === date).map((a) => a.search.replace(/^\?date=[\d-]+&/, ''))
  for (const date of DATES) assert.deepEqual(bands(date), date === HOLIDAY ? [] : ['expiryFlag=WEEK&expiryCode=2', 'expiryFlag=MONTH&expiryCode=1'], date)
})

test('the FEATURE FINDER in the background: the page\'s table of the same days as CSV, every label\'s report, a failed day tried once more', async (t) => {
  // Two weeks - enough days (9 run, the holiday not) for the earlier / later check.
  const dates = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']
  const asked = []
  let failOnce = true
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const date = url.searchParams.get('date')
    asked.push({ path: url.pathname, date })
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (url.pathname.endsWith('/previous-day-volume-profile')) return json(200, PREV)
    if (url.pathname === '/api/oi-replay/NIFTY/run') {
      if (date === HOLIDAY) return json(200, { success: false, error: 'holiday' })
      if (date === '2026-10-14' && failOnce) { failOnce = false; return json(503, { error: 'busy' }) }
      // Where each day came from, as the server says it: the first week asked of Dhan, the rest from its disk.
      res.setHeader('X-Dhan-Calls', date < '2026-10-15' ? '45' : '0')
      return json(200, runFor(date))
    }
    return json(404, { error: 'not mocked' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const dir = mkdtempSync(join(tmpdir(), 'oa-sbt-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const out = join(dir, 'result.json')
  const csv = join(dir, 'features.csv')
  // 5-minute candles, a CE / PE bought with 30% SL / 60% target; the rule plays no part.
  const settings = cleanBacktestSettings({ underlying: 'NIFTY', from: dates[0], to: dates.at(-1), timeframe: 5, slPct: 30, targetPct: 60 })
  const progress = []
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scanner-runner/signal-backtest.mjs', import.meta.url))], {
      env: {
        ...process.env, RUNNER_BASE_URL: `http://127.0.0.1:${server.address().port}`, RUNNER_KEY: 'k', BACKTEST_OUT: out, BACKTEST_TODAY: '2026-10-26',
        BACKTEST_KIND: 'features', BACKTEST_CSV: csv, BACKTEST_JOB: JSON.stringify(settings), BACKTEST_RETRY_PAUSE_MS: '0',
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    child.stdout.on('data', (b) => progress.push(...String(b).split('\n').filter((l) => l.startsWith('PROGRESS ')).map((l) => JSON.parse(l.slice(9)))))
    child.on('error', reject)
    child.on('exit', resolve)
  })
  assert.equal(code, 0)
  // What the page's Feature finder builds from the same days (each prepared as the loader prepares it).
  const engine = engineSettings(settings)
  const rows = dates.filter((d) => d !== HOLIDAY).flatMap((date) => dayRows(prepareDay(runFor(date), { underlying: 'NIFTY', prevProfile: PREV }), engine))
  assert.ok(rows.length > 9 * 50)
  assert.equal(readFileSync(csv, 'utf8'), rowsCsv(rows))
  // The capture holds the spot price and the context beside every reading - real numbers, a row a candle.
  {
    const [head, ...lines] = readFileSync(csv, 'utf8').trim().split('\n')
    const cols = head.split(',')
    assert.deepEqual(cols.slice(0, 2 + CONTEXT.length), ['date', 'time', ...CONTEXT])
    assert.equal(lines.length, rows.length)
    const at = (line, name) => Number(line.split(',')[cols.indexOf(name)])
    assert.ok(lines.every((l) => at(l, 'spot') > 0 && at(l, 'spotHigh') >= at(l, 'spotLow')), 'every row has the spot price')
    assert.ok(lines.filter((l) => at(l, 'atm') > 0).length > lines.length * 0.9, 'the ATM strike is there')
    assert.ok(lines.filter((l) => Number.isFinite(at(l, 'cePremium'))).length > lines.length * 0.5, 'the ATM premiums are there')
  }
  const result = JSON.parse(readFileSync(out, 'utf8'), reportReviver)
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'features')
  assert.equal(result.report, undefined)
  assert.deepEqual(result.dates, dates)
  assert.deepEqual({ ...result.features, reports: null }, { rows: rows.length, okDays: 9, timeframe: 5, failed: [{ date: HOLIDAY, reason: 'holiday' }], reports: null })
  // Every label's report as the page's card works it out - through JSON, as the page reads it back.
  assert.deepEqual(result.features.reports, JSON.parse(JSON.stringify(featureReports(rows))))
  assert.deepEqual(Object.keys(result.features.reports), ['fwd15', 'fwd30', 'fwd60', 'ceBuy', 'peBuy', 'ceSell', 'peSell', 'up30', 'down30'])
  assert.equal(result.features.reports.ceBuy.split, true)
  assert.equal(result.features.reports.ceBuy.laterDays, 3)
  // The day that failed on the way was asked twice - at once, so the CSV stays in date order - the holiday once; the
  // progress counts the rows.
  const runs = (date) => asked.filter((a) => a.path.endsWith('/run') && a.date === date).length
  assert.deepEqual([runs('2026-10-14'), runs(HOLIDAY), runs('2026-10-12')], [2, 1, 1])
  assert.deepEqual(progress.filter((p) => p.stage === 'retry').map((p) => p.day), ['2026-10-14'])
  assert.deepEqual(progress.at(-1), { stage: 'done', done: 10, total: 10, rows: rows.length, okDays: 9, sources: { disk: 6, dhan: 3 } })
  assert.deepEqual(result.sources, { disk: 6, dhan: 3 })     // the holiday said nothing: counted as neither
})

test('a Feature finder run\'s name and heading: the index, the days, the candles and the option its CE / PE labels buy', () => {
  const s = cleanBacktestSettings({ underlying: 'BANKNIFTY', from: '2026-08-03', to: '2026-10-23', timeframe: 5, slPct: 30, targetPct: 60, strategyName: 'My rule' })
  assert.equal(defaultRunName(s, 'features'), 'BANKNIFTY 3 Aug 2026 – 23 Oct 2026 · 5m candles')
  assert.match(defaultRunName(s), /^My rule · BANKNIFTY /)                 // a backtest's as before
  assert.equal(featureRunHead(s, 58), 'BANKNIFTY · 58 days · 3 Aug 2026 – 23 Oct 2026 · 5m candles · ATM CE / PE bought: SL 30% · target 60%')
  const more = { ...s, moneyness: -2, levelUnit: 'pts', trailGap: 10, trailStart: 5, timeStopMin: 30, sumExpiries: true }
  assert.equal(featureTradeText(more), '5m candles · OI Σ 3 expiries · 2 OTM CE / PE bought: SL 30 pts · target 60 pts · trail 10 pts after +5 pts · out after 30 min')
  assert.equal(featureRunHead({ ...s, targetPct: 0 }, 1), 'BANKNIFTY · 1 day · 3 Aug 2026 – 23 Oct 2026 · 5m candles · ATM CE / PE bought: SL 30% · target none')
})

// The job script run as the server runs it, against `handle` (the fake server's /run answer for a date), for `dates`.
async function runJob(t, { kind = 'backtest', dates, handle }) {
  const asked = []
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    const date = url.searchParams.get('date')
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
    if (url.pathname.endsWith('/previous-day-volume-profile')) return json(200, PREV)
    if (url.pathname === '/api/oi-replay/NIFTY/run') { asked.push(date); const [status, body] = handle(date); return json(status, body) }
    return json(404, { error: 'not mocked' })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const dir = mkdtempSync(join(tmpdir(), 'oa-sbt-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const out = join(dir, 'result.json'), csv = join(dir, 'features.csv')
  const settings = cleanBacktestSettings({ ...SETTINGS, from: dates[0], to: dates.at(-1), timeframe: 5 })
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../scanner-runner/signal-backtest.mjs', import.meta.url))], {
      env: {
        ...process.env, RUNNER_BASE_URL: `http://127.0.0.1:${server.address().port}`, RUNNER_KEY: 'k', BACKTEST_OUT: out, BACKTEST_CSV: csv,
        BACKTEST_TODAY: '2026-10-26', BACKTEST_KIND: kind, BACKTEST_RETRY_PAUSE_MS: '0', BACKTEST_JOB: JSON.stringify(settings),
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    })
    child.on('error', reject)
    child.on('exit', resolve)
  })
  return { code, asked, result: JSON.parse(readFileSync(out, 'utf8'), reportReviver), csv: kind === 'features' ? readFileSync(csv, 'utf8') : null }
}

test('a run whose days keep failing on the way STOPS after 5 in a row - the days after not asked, the result says why', async (t) => {
  const dates = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']
  // The first two days answer; from the third the server is down (503) - except a holiday answered in the middle, which
  // starts the count again: 14, 15 fail, 16 the holiday, then 19, 20, 21, 22, 23 ... the fifth in a row is 23 Oct.
  const handle = (date) => (date < '2026-10-14' ? [200, runFor(date)] : date === '2026-10-16' ? [200, { success: false, error: 'holiday' }] : [503, { error: 'busy' }])
  for (const kind of ['backtest', 'features']) {
    const { code, asked, result, csv } = await runJob(t, { kind, dates, handle })
    assert.equal(code, 0)
    assert.equal(result.ok, true)
    assert.match(result.stopped, /^5 days in a row failed on the way \(the last: busy\)/)
    const failed = kind === 'features' ? result.features.failed : result.report.failed
    assert.deepEqual(failed.map((f) => f.date), dates.slice(2), kind)
    assert.equal(failed.find((f) => f.date === '2026-10-16').reason, 'holiday')
    // A backtest tries the failed days again at the end - not once it has stopped; a Feature finder run tries each at once.
    const times = (date) => asked.filter((d) => d === date).length
    for (const date of ['2026-10-14', '2026-10-15', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']) {
      assert.equal(times(date), kind === 'features' ? 2 : 1, `${kind} ${date}`)
    }
    if (kind === 'features') {
      assert.equal(result.features.okDays, 2)
      assert.equal(csv.trim().split('\n').length - 1, result.features.rows)
    } else {
      assert.equal(result.report.okDays, 2)
    }
  }
  // Fewer than 5 in a row: no stop - every day asked, the failed ones tried again.
  const short = await runJob(t, { dates: dates.slice(0, 6), handle: (date) => (date === '2026-10-14' || date === '2026-10-15' ? [503, { error: 'busy' }] : [200, runFor(date)]) })
  assert.equal(short.result.stopped, undefined)
  assert.deepEqual(short.result.report.failed.map((f) => f.date), ['2026-10-14', '2026-10-15'])
  assert.equal(short.asked.filter((d) => d === '2026-10-14').length, 2)
})

test('up to 1 500 weekdays in the background, the latest of a longer range', () => {
  assert.equal(MAX_BACKGROUND_DAYS, 1500)
  const all = backtestDays('2018-01-01', '2026-10-23', '2026-10-26', MAX_BACKGROUND_DAYS)
  assert.equal(all.length, 1500)
  assert.equal(all.at(-1), '2026-10-23')
  assert.equal(all[0] > '2020-11-01' && all[0] < '2021-01-31', true, all[0])     // about 5.75 years of weekdays
})

test('a capture where NOT ONE day could be read FAILS with the reason - it is not an empty "done"', async (t) => {
  const dates = ['2026-10-12', '2026-10-13', '2026-10-14']
  const reason = 'Stored data is not configured on this server (no NiftyDataCollector database connection)'
  const { code, result } = await runJob(t, { kind: 'features', dates, handle: () => [200, { success: false, error: reason }] })
  assert.equal(code, 1)
  assert.equal(result.ok, false)
  assert.match(result.error, /^No day could be captured - 3 of 3 failed, 3 of them: Stored data is not configured/)
  assert.equal(result.features.rows, 0)
})
