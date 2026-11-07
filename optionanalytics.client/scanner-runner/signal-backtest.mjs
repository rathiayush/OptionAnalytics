// The Signal backtest in the BACKGROUND - started by the server (SignalBacktestJobService) for one queued run, in its own
// Node process, so the browser can be closed: each day is loaded through this server's API as the page loads it (the
// server keeps every past day on disk - a day it has not kept comes from Dhan once), replayed through the rule with the
// page's own code (signalBacktestJob.js - the same report the page would show) and the report written to one JSON file.
// Read-only: it places nothing and changes no setting.
// A FEATURE FINDER run (BACKTEST_KIND=features) loads the same days and builds the page's Feature finder over them instead
// (featureFinder.js - dayRows of each day, featureReport for every label): the whole table to BACKTEST_CSV, the reports to
// the result file - a day at a time too (only its rows kept).
//
// Environment (from the server):
//   RUNNER_BASE_URL, RUNNER_KEY   this server and the key it accepts from local processes
//   BACKTEST_JOB                  the run's settings (cleanBacktestSettings: index, from / to, rule, levels, timeframe)
//   BACKTEST_OUT                  the result file
//   BACKTEST_KIND                 "backtest" (default) or "features"
//   BACKTEST_CSV                  a features run's dataset file
//   BACKTEST_TODAY                (tests only) today's IST date - the days run are the weekdays before it
// Progress goes to stdout as lines "PROGRESS {json}".

import { writeFileSync, renameSync } from 'node:fs'
import { MAX_BACKGROUND_DAYS, backtestDays } from '../src/signalBacktest.js'
import { backtestReport, cleanBacktestSettings, dayOutcome, engineSettings, loadBacktestDay, reportReplacer } from '../src/signalBacktestJob.js'
import { dayRows, featureReports, rowsCsv } from '../src/featureFinder.js'

const BASE = (process.env.RUNNER_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '')
const KEY = process.env.RUNNER_KEY ?? ''
const OUT = process.env.BACKTEST_OUT ?? 'signal-backtest-result.json'
const KIND = process.env.BACKTEST_KIND === 'features' ? 'features' : 'backtest'
const CSV = process.env.BACKTEST_CSV ?? 'signal-backtest-features.csv'
// A day the server has not kept yet comes from Dhan (spot, 42 option series, futures) at the shared 5 a second - no hurry here.
const DAY_TIMEOUT_MS = Number(process.env.BACKTEST_DAY_TIMEOUT_MS) || 600_000
const startedUtc = new Date().toISOString()

const nativeFetch = globalThis.fetch
globalThis.fetch = (url, options = {}) => nativeFetch(String(url).startsWith('/') ? `${BASE}${url}` : url, { ...options, headers: { ...(options.headers ?? {}), 'X-Runner-Key': KEY } })
const progress = (p) => console.log(`PROGRESS ${JSON.stringify(p)}`)
const write = (body) => {
  writeFileSync(`${OUT}.tmp`, JSON.stringify(body, reportReplacer))
  renameSync(`${OUT}.tmp`, OUT)
}
const istToday = process.env.BACKTEST_TODAY || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
let settings = null

async function main() {
  settings = cleanBacktestSettings(JSON.parse(process.env.BACKTEST_JOB ?? '{}'))
  if (!settings.from || !settings.to) throw new Error('no days chosen')
  const dates = backtestDays(settings.from, settings.to, istToday, MAX_BACKGROUND_DAYS)
  if (!dates.length) throw new Error('no past weekdays in the range')
  if (KIND === 'features') return features(dates)
  const engine = engineSettings(settings)
  const outcomes = new Map()
  const totals = () => {
    let trades = 0
    let net = 0
    for (const o of outcomes.values()) { trades += o.trades.length; net += o.trades.reduce((a, t) => a + t.net, 0) }
    return { trades, net: Math.round(net) }
  }
  // A day is replayed as soon as it is loaded and only its outcome kept - 60 prepared days are not held at once.
  // Trading in another index: that index's day of the same date too (the trades are taken in it); a day either failed on
  // the way is tried once more.
  const runDay = async (date) => {
    // "Σ 3 expiries": the day's next and monthly expiries summed into its OI reads (loadBacktestDay) - the traded index's
    // day is read for its premiums only.
    const day = await loadBacktestDay(settings.underlying, date, { timeoutMs: DAY_TIMEOUT_MS, sumExpiries: settings.sumExpiries })
    const tradeDay = settings.tradeIn && day.ok ? await loadBacktestDay(settings.tradeIn, date, { timeoutMs: DAY_TIMEOUT_MS }) : null
    outcomes.set(date, dayOutcome(date, day, engine, tradeDay))
    return { retry: Boolean(day.retry || tradeDay?.retry) }
  }
  const again = []
  for (let k = 0; k < dates.length; k++) {
    progress({ stage: 'day', day: dates[k], done: k, total: dates.length, ...totals() })
    const day = await runDay(dates[k])
    if (day.retry) again.push(dates[k])
  }
  // One more try for a day that failed on the way (a timeout, a server error) - not for one with no data, and never a loop.
  for (let k = 0; k < again.length; k++) {
    progress({ stage: 'retry', day: again[k], done: dates.length, total: dates.length, ...totals() })
    await runDay(again[k])
  }
  const report = backtestReport([...outcomes.values()], settings)
  write({ ok: true, settings, dates, today: istToday, startedUtc, finishedUtc: new Date().toISOString(), report })
  progress({ stage: 'done', done: dates.length, total: dates.length, ...totals() })
}

// The Feature finder over the days: each day's rows (the page's dayRows with the run's timeframe and levels - an ATM / the
// run's strike CE and PE bought there, its SL / target / trail) as soon as it is loaded, the day itself dropped; a day that
// failed on the way tried once more. Then the table (in date order) and every label's report.
async function features(dates) {
  const engine = engineSettings(settings)
  const rows = new Map()
  const failed = new Map()
  const count = () => { let n = 0; for (const r of rows.values()) n += r.length; return n }
  const runDay = async (date) => {
    const day = await loadBacktestDay(settings.underlying, date, { timeoutMs: DAY_TIMEOUT_MS, sumExpiries: settings.sumExpiries })
    if (!day.ok) { failed.set(date, day.reason); return { retry: Boolean(day.retry) } }
    failed.delete(date)
    rows.set(date, dayRows(day, engine))
    return { retry: false }
  }
  const again = []
  for (let k = 0; k < dates.length; k++) {
    progress({ stage: 'day', day: dates[k], done: k, total: dates.length, rows: count(), okDays: rows.size })
    if ((await runDay(dates[k])).retry) again.push(dates[k])
  }
  for (const date of again) {
    progress({ stage: 'retry', day: date, done: dates.length, total: dates.length, rows: count(), okDays: rows.size })
    await runDay(date)
  }
  progress({ stage: 'done', done: dates.length, total: dates.length, rows: count(), okDays: rows.size })
  const table = [...rows.keys()].sort().flatMap((d) => rows.get(d))
  writeFileSync(`${CSV}.tmp`, rowsCsv(table))
  renameSync(`${CSV}.tmp`, CSV)
  write({
    ok: true, kind: 'features', settings, dates, today: istToday, startedUtc, finishedUtc: new Date().toISOString(),
    features: {
      rows: table.length, okDays: rows.size, timeframe: settings.timeframe,
      failed: dates.filter((d) => failed.has(d)).map((date) => ({ date, reason: failed.get(date) })),
      reports: featureReports(table),
    },
  })
}

main().catch((err) => {
  console.error(err.stack ?? err.message)
  write({ ok: false, kind: KIND, settings, startedUtc, finishedUtc: new Date().toISOString(), error: err.message })
  process.exit(1)
})
