// The Signal backtest in the BACKGROUND - started by the server (SignalBacktestJobService) for one queued run, in its own
// Node process, so the browser can be closed: each day is loaded through this server's API as the page loads it (the
// server keeps every past day on disk - a day it has not kept comes from Dhan once), replayed through the rule with the
// page's own code (signalBacktestJob.js - the same report the page would show) and the report written to one JSON file.
// Read-only: it places nothing and changes no setting.
// A FEATURE FINDER run (BACKTEST_KIND=features) loads the same days and builds the page's Feature finder over them instead
// (featureFinder.js - dayRows of each day, featureReport for every label): each day's lines written to BACKTEST_CSV as it
// comes and only its rows as COLUMNS kept (dayTable - 1 500 days of 1-minute rows are ~474 000 rows), the reports to the
// result file at the end.
// Up to MAX_BACKGROUND_DAYS (1 500) weekdays. A run whose days keep failing ON THE WAY (a timeout, the network, a server
// error - the server or Dhan not answering) STOPS after STOP_AFTER of them in a row: the days not asked are listed as not
// run and the result says why (`stopped`) - never hundreds of days of failing calls.
//
// Environment (from the server):
//   RUNNER_BASE_URL, RUNNER_KEY   this server and the key it accepts from local processes
//   BACKTEST_JOB                  the run's settings (cleanBacktestSettings: index, from / to, rule, levels, timeframe)
//   BACKTEST_OUT                  the result file
//   BACKTEST_KIND                 "backtest" (default) or "features"
//   BACKTEST_CSV                  a features run's dataset file
//   BACKTEST_TODAY                (tests only) today's IST date - the days run are the weekdays before it
//   BACKTEST_RETRY_PAUSE_MS       (tests only) the pause before a Feature finder day is tried again (5 s)
// Progress goes to stdout as lines "PROGRESS {json}".

import { closeSync, openSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { MAX_BACKGROUND_DAYS, backtestDays, deltaDaysNeeded } from '../src/signalBacktest.js'
import { backtestReport, cleanBacktestSettings, dayOutcome, daySource, engineSettings, loadBacktestDay, reportReplacer } from '../src/signalBacktestJob.js'
import { csvHeader, csvLines, dayRows, dayTable, featureReportsOfDays } from '../src/featureFinder.js'

const BASE = (process.env.RUNNER_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '')
const KEY = process.env.RUNNER_KEY ?? ''
const OUT = process.env.BACKTEST_OUT ?? 'signal-backtest-result.json'
const KIND = process.env.BACKTEST_KIND === 'features' ? 'features' : 'backtest'
const CSV = process.env.BACKTEST_CSV ?? 'signal-backtest-features.csv'
// A day the server has not kept yet comes from Dhan (spot, 42 option series, futures) at the shared 5 a second - no hurry here.
const DAY_TIMEOUT_MS = Number(process.env.BACKTEST_DAY_TIMEOUT_MS) || 600_000
const RETRY_PAUSE_MS = Number.isFinite(Number(process.env.BACKTEST_RETRY_PAUSE_MS)) && process.env.BACKTEST_RETRY_PAUSE_MS !== '' ? Number(process.env.BACKTEST_RETRY_PAUSE_MS) : 5_000
/** Days in a row that failed on the way before the run stops asking. */
const STOP_AFTER = 5
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
// Where the days came from - the server's disk, or Dhan (a day nothing had loaded before): each date's latest load.
const sources = new Map()
const sourceCounts = () => {
  const out = { disk: 0, dhan: 0 }
  for (const s of sources.values()) if (s) out[s]++
  return out
}
const load = async (underlying, date, options) => {
  const day = await loadBacktestDay(underlying, date, options)
  if (underlying === settings.underlying) sources.set(date, daySource(day))
  return day
}
// Days that failed ON THE WAY in a row (`retry` - a timeout, the network, a server error): STOP_AFTER of them stops the run.
// A day that answered - run, or with no data (a holiday) - starts the count again.
function newBreaker() {
  let inRow = 0
  const b = {
    stopped: false, why: null, notAsked: null,
    saw({ retry, reason }) {
      if (!retry) { inRow = 0; return }
      if (++inRow < STOP_AFTER) return
      b.stopped = true
      b.why = `${STOP_AFTER} days in a row failed on the way (the last: ${reason}) - the server or Dhan was not answering, so nothing more was asked`
      b.notAsked = `not asked - the run stopped after ${STOP_AFTER} days in a row failed on the way`
    },
  }
  return b
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
    return { trades, net: Math.round(net), sources: sourceCounts() }
  }
  // A day is replayed as soon as it is loaded and only its outcome kept - 60 prepared days are not held at once.
  // Trading in another index: that index's day of the same date too (the trades are taken in it); a day either failed on
  // the way is tried once more.
  const deltaDays = deltaDaysNeeded(settings.rule)
  const runDay = async (date) => {
    // "Σ 3 expiries": the day's next and monthly expiries summed into its OI reads (loadBacktestDay) - the traded index's
    // day is read for its premiums only.
    // The option delta profile's days before, when the rule reads them (loadBacktestDay - each kept for the next day).
    const day = await load(settings.underlying, date, { timeoutMs: DAY_TIMEOUT_MS, sumExpiries: settings.sumExpiries, deltaDays })
    const tradeDay = settings.tradeIn && day.ok ? await load(settings.tradeIn, date, { timeoutMs: DAY_TIMEOUT_MS }) : null
    outcomes.set(date, dayOutcome(date, day, engine, tradeDay))
    return { retry: Boolean(day.retry || tradeDay?.retry), reason: day.ok ? tradeDay?.reason : day.reason }
  }
  const breaker = newBreaker()
  const again = []
  for (let k = 0; k < dates.length; k++) {
    if (breaker.stopped) { outcomes.set(dates[k], dayOutcome(dates[k], { ok: false, reason: breaker.notAsked }, engine)); continue }
    progress({ stage: 'day', day: dates[k], done: k, total: dates.length, ...totals() })
    const day = await runDay(dates[k])
    breaker.saw(day)
    if (day.retry) again.push(dates[k])
  }
  // One more try for a day that failed on the way (a timeout, a server error) - not for one with no data, and never a loop;
  // none once the run has stopped (it would fail the same way).
  for (let k = 0; k < again.length && !breaker.stopped; k++) {
    progress({ stage: 'retry', day: again[k], done: dates.length, total: dates.length, ...totals() })
    await runDay(again[k])
  }
  const report = backtestReport([...outcomes.values()], settings)
  write({
    ok: true, settings, dates, today: istToday, startedUtc, finishedUtc: new Date().toISOString(), sources: sourceCounts(), report,
    ...(breaker.stopped ? { stopped: breaker.why } : {}),
  })
  progress({ stage: 'done', done: dates.length, total: dates.length, ...totals() })
}

// The Feature finder over the days: each day's rows (the page's dayRows with the run's timeframe and levels - an ATM / the
// run's strike CE and PE bought and sold there, its SL / target / trail) as soon as it is loaded - its CSV lines written,
// its rows kept as columns, the day itself dropped. A day that failed on the way is tried once more AT ONCE (after a short
// pause), so the CSV stays in date order. Then every label's report from the columns.
async function features(dates) {
  const engine = engineSettings(settings)
  const tables = []
  const failed = new Map()
  let rows = 0
  const breaker = newBreaker()
  const fd = openSync(`${CSV}.tmp`, 'w')
  try {
    writeSync(fd, csvHeader())
    for (let k = 0; k < dates.length; k++) {
      const date = dates[k]
      if (breaker.stopped) { failed.set(date, breaker.notAsked); continue }
      const at = { done: k, total: dates.length, rows, okDays: tables.length, sources: sourceCounts() }
      progress({ stage: 'day', day: date, ...at })
      const options = { timeoutMs: DAY_TIMEOUT_MS, sumExpiries: settings.sumExpiries }
      let day = await load(settings.underlying, date, options)
      if (day.retry) {
        progress({ stage: 'retry', day: date, ...at })
        await pause(RETRY_PAUSE_MS)
        day = await load(settings.underlying, date, options)
      }
      breaker.saw(day)
      if (!day.ok) { failed.set(date, day.reason); continue }
      const list = dayRows(day, engine)
      writeSync(fd, csvLines(list))
      tables.push(dayTable(date, list))
      rows += list.length
    }
  } finally {
    closeSync(fd)
  }
  renameSync(`${CSV}.tmp`, CSV)
  progress({ stage: 'done', done: dates.length, total: dates.length, rows, okDays: tables.length, sources: sourceCounts() })
  write({
    ok: true, kind: 'features', settings, dates, today: istToday, startedUtc, finishedUtc: new Date().toISOString(), sources: sourceCounts(),
    ...(breaker.stopped ? { stopped: breaker.why } : {}),
    features: {
      rows, okDays: tables.length, timeframe: settings.timeframe,
      failed: dates.filter((d) => failed.has(d)).map((date) => ({ date, reason: failed.get(date) })),
      reports: featureReportsOfDays(tables),
    },
  })
}

main().catch((err) => {
  console.error(err.stack ?? err.message)
  write({ ok: false, kind: KIND, settings, startedUtc, finishedUtc: new Date().toISOString(), error: err.message })
  process.exit(1)
})
