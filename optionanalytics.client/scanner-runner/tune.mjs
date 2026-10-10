// Strategy tuning job - started by the server (StrategyTuningService) for one index, in its own Node process
// so the live scanner is never held up. It scans each past day once with the strategies' rules (the same
// scanDaySetups the scanner's Scan day runs), ranks the strategies as written, then tries every combination
// of each chosen strategy's trade filters (strategyTuning.js) and writes the result. Read-only: it fetches
// the days through the server's API with the runner's key and writes one JSON file.
//
// Environment (from the server):
//   RUNNER_BASE_URL, RUNNER_KEY   this server and the key it accepts from local processes
//   TUNE_JOB                      { underlying, strategies: 'top3' | 'top5' | 'all' | [ids], days, includeEstimated, minTrades,
//                                   what: 'trade' | 'oi' | 'both' (the trade settings, the OI confirmation, or the OI first then the trade) }
//   TUNE_OUT                      the result file
//   TUNE_HISTORY_DIR              the history kept as CSV (tuneHistory.mjs): runs.csv, {run}-trades.csv, {run}-settings.csv -
//                                 every run's trades and tuned settings, per index, read by the Trades page
//   TUNE_CACHE_DIR                where each past day's fetched data is kept (tuneFetch.mjs): a rerun / resume / longer range
//                                 reads it from disk - no Dhan call; TUNE_PACE_MS the pause between requests that reach the server
// Progress goes to stdout as lines "PROGRESS {json}".

import { appendFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { buildOiContext, ACTIVE_STRATEGIES, SPOT_STRATEGIES, STRATEGY_BY_ID, TRADE_FILTERS } from '../src/strategyEngine.js'
import { scanSpotDay, spotBarsOf } from '../src/spotEngine.js'
import { autoBigLots } from '../src/orderFlowMath.js'
import { scannerProfileOf, trailFor } from '../src/scannerCore.js'
import { expiryFlagOf } from '../src/liveFeeds.js'
import { dayFromOrderFlow, scanDaySetups } from '../src/scanDay.js'
import { DEFAULT_VARIANT, OI_COMBO_CAP, OI_FACTORS, OPTION_GRID, countOiCombinations, oiGridOf, optionText, rankStrategies, tradeDetails, tuneStrategy, tuningDay, TUNING_GRID, variantText } from '../src/strategyTuning.js'
import { DEFAULT_ROW_SIZES } from './indexScanner.mjs'
import { createFetcher, isTransientText, pruneCache } from './tuneFetch.mjs'
import { RUN_COLUMNS, SETTING_COLUMNS, TRADE_COLUMNS, historyOf, toCsv } from './tuneHistory.mjs'

const BASE = (process.env.RUNNER_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '')
const KEY = process.env.RUNNER_KEY ?? ''
const OUT = process.env.TUNE_OUT ?? 'tuning-result.json'
const HISTORY_DIR = process.env.TUNE_HISTORY_DIR ?? null
const job = JSON.parse(process.env.TUNE_JOB ?? '{}')
const U = String(job.underlying ?? 'NIFTY').toUpperCase()
// A date range (from / to, YYYY-MM-DD, either may be left open) picks the days instead of "the last N": every day
// in it is used, up to 250.
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
const FROM = isDate(job.from) ? job.from : null
const TO = isDate(job.to) ? job.to : null
const RANGED = !!(FROM || TO)
const inRange = (date) => (!FROM || date >= FROM) && (!TO || date <= TO)
// Saturdays and Sundays have no trading: never fetched, whatever lists them.
const isWeekend = (date) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay())
const MAX_DAYS = RANGED ? 250 : Math.max(1, Math.min(250, Number(job.days) || 30))
const MIN_TRADES = Math.max(2, Math.min(100, Number(job.minTrades) || 8))
const WHAT = ['trade', 'oi', 'both', 'option', 'all'].includes(job.what) ? job.what : 'trade'
const DATA = job.data === 'spot' ? 'spot' : 'futures' // spot: the index candles + the option chain's OI only - no futures, no order flow
const SEARCH = job.search === 'full' ? 'full' : 'step'
const OI_KEYS = Array.isArray(job.oiFactors) && job.oiFactors.length ? job.oiFactors.filter((k) => OI_FACTORS.some((f) => f.key === k)) : null
const startedUtc = new Date().toISOString()

const progress = (p) => console.log(`PROGRESS ${JSON.stringify({ ...p, startedUtc, fetched: fetcher?.stats })}`)
const istToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
// The server (and through it Dhan) is read with retries while it is busy, and each past day's data is kept on disk.
let lastScan = null
const CACHE_DIR = process.env.TUNE_CACHE_DIR || null
const fetcher = createFetcher({
  base: BASE, key: KEY, today: istToday, cacheDir: CACHE_DIR,
  paceMs: Math.max(0, Number(process.env.TUNE_PACE_MS) || 0),
  retryScale: Math.max(0.0001, Number(process.env.TUNE_RETRY_SCALE) || 1),
  // Always background priority: the live pages and the server scanner get Dhan first, the job what they leave (up to the
  // full 5/s while they are quiet) - a running job never slows the app down. (TUNE_PRIORITY=interactive overrides.)
  priority: () => (process.env.TUNE_PRIORITY === 'interactive' ? 'interactive' : 'background'),
  onWait: (w) => progress({ ...(lastScan ?? { stage: 'scan' }), wait: { ...w, until: new Date(Date.now() + w.waitMs).toISOString() } }),
})
const api = (path) => fetcher.api(path)
/** Written beside the final name and moved onto it, so a reader never sees half a file. */
const writeJson = (path, body, text = null) => {
  writeFileSync(`${path}.tmp`, text ?? JSON.stringify(body))
  renameSync(`${path}.tmp`, path)
}
const write = (body) => writeJson(OUT, body)

// A full session is 375 minutes (09:15 - 15:30); a day with much less (a special / Muhurat session, a feed that started
// late, a gap in the archive) would be scored as if it were a whole day - it is left out and listed with the reason.
export const MIN_SESSION_MINUTES = 300
const minutesOf = (points) => new Set((points ?? []).map((p) => String(p.time ?? p.t ?? '').slice(0, 16))).size

// The previous session's bars (the profile strategies' levels): the weekday before, read the same way as a scanned day
// (and from the same cache entry - the previous day is usually a scanned day too).
async function previousSession(date, rowSize, plan) {
  const d = new Date(`${date}T00:00:00Z`)
  for (let back = 1; back <= 7; back++) {
    const day = new Date(d.getTime() - back * 86_400_000)
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue
    const key = day.toISOString().slice(0, 10)
    try {
      // That day's own contract when it is a scanned day (the same request, so the same cache entry), else the default.
      const own = plan.find((x) => x.date === key)?.expiry
      const body = await fetcher.dayApi('flow', key, dayPath(key, rowSize, own ? `&expiry=${own}` : ''), (b) => b?.bars?.length > 0)
      if (body?.bars?.length) return { date: key, bars: body.bars }
    } catch (err) {
      if (err.transient) throw err // busy: the day is tried again later, not scanned without its profile
    }
  }
  return null
}
const dayPath = (date, rowSize, expiryQuery) => `/api/order-flow/${U}/day/${date}?rowSize=${rowSize}&minTradeLots=5&heatmapColumns=1500${expiryQuery}`

// The weekdays to try, newest first: in the date range when there is one (up to yesterday), else the last `n` before today.
function candidateWeekdays(n) {
  if (!RANGED) return pastWeekdays(n)
  const out = []
  const last = TO && TO < istToday ? TO : new Date(Date.parse(`${istToday}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
  for (let t = Date.parse(`${last}T00:00:00Z`); out.length < 400; t -= 86_400_000) {
    const day = new Date(t)
    const date = day.toISOString().slice(0, 10)
    if (FROM && date < FROM) break
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) out.push(date)
  }
  return out
}

// The past weekdays before today, newest first.
function pastWeekdays(n) {
  const out = []
  const d = new Date(`${istToday}T00:00:00Z`)
  for (let back = 1; out.length < n && back < n * 2 + 14; back++) {
    const day = new Date(d.getTime() - back * 86_400_000)
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) out.push(day.toISOString().slice(0, 10))
  }
  return out
}

async function main() {
  if (CACHE_DIR) pruneCache(CACHE_DIR, Math.max(0, Number(process.env.TUNE_CACHE_MAX_MB ?? 4096)) * 1_000_000)
  // "Every combination" of the ticked OI inputs must be a size that can be run - say so before scanning any day.
  if (WHAT !== 'trade' && WHAT !== 'option' && SEARCH === 'full' && countOiCombinations(OI_KEYS).over) {
    throw new Error(`more than ${OI_COMBO_CAP.toLocaleString('en-IN')} OI combinations with those OI inputs - untick some, or search step by step`)
  }
  const config = await api('/api/scanner-runner/config').catch(() => ({}))
  const cfg = { ...(config?.settings ?? {}) }
  const rowSize = cfg.orderFlow?.rowSizes?.[U] ?? DEFAULT_ROW_SIZES[U] ?? 1
  const trail = trailFor(cfg, U)
  // The strategies' own entry filters as the trader set them; the trade filters are what is tuned (from their defaults).
  const tradeKeys = new Set(TRADE_FILTERS.map((f) => f.key))
  const entryFilters = Object.fromEntries(Object.entries(cfg.filters ?? {}).map(([id, f]) => [id, Object.fromEntries(Object.entries(f ?? {}).filter(([k]) => !tradeKeys.has(k)))]))

  // The days: the recorded (exact) ones, newest first; with includeEstimated, other weekdays too (rebuilt from 1-minute candles).
  // Spot + options needs no order flow: the past weekdays that have OI data are the days (holidays fail and are skipped).
  const recorded = DATA === 'spot' ? [] : ((await api(`/api/order-flow/${U}/days`)) ?? []).filter((d) => !(d.isLive ?? d.live) && d.date < istToday && inRange(d.date))
  let plan = recorded.slice(0, MAX_DAYS).map((d) => ({ date: d.date, expiry: d.expiry ?? null, exact: true }))
  if (DATA === 'spot') plan = candidateWeekdays(MAX_DAYS + Math.ceil(MAX_DAYS / 4) + 6).map((date) => ({ date, expiry: null, exact: false }))
  else if (job.includeEstimated && plan.length < MAX_DAYS) {
    for (const date of candidateWeekdays(MAX_DAYS * 2)) {
      if (plan.length >= MAX_DAYS) break
      if (!plan.some((p) => p.date === date)) plan.push({ date, expiry: null, exact: false })
    }
  }
  plan = plan.filter((p) => !isWeekend(p.date))
  plan.sort((a, b) => (a.date < b.date ? 1 : -1))
  if (DATA !== 'spot') plan = plan.slice(0, MAX_DAYS)
  if (!plan.length) {
    const range = RANGED ? ` between ${FROM ?? 'the start'} and ${TO ?? 'yesterday'}` : ''
    throw new Error(job.includeEstimated || DATA === 'spot' ? `no past days could be listed${range}` : `no recorded past days on the server${range} - include estimated days to tune on days rebuilt from 1-minute candles`)
  }

  const expiries = await api(`/api/oi-replay/${U}/expiries`).catch(() => null)
  const expiryDate = U === 'BANKNIFTY' ? expiries?.month ?? null : expiries?.week ?? null
  const days = []
  const skipped = []
  const asWritten = [] // every strategy's trades as written, per day as it is scanned (with its checks - why it fired)
  const oiQuery = (date) => `/api/oi-replay/${U}/run?${new URLSearchParams({ date, timeframeMinutes: '1', expiryFlag: expiryFlagOf(U) })}`
  // A strike whose Dhan call failed for the load (rate limit, timeout, the session renewing) leaves a hole in the day's
  // OI: such a run is never cached and the day is tried again; any other strike error is noted on the day.
  const busyStrikes = (run) => (run?.optionErrors ?? []).filter((e) => isTransientText(e))
  const oiValid = (run) => run?.success === true && minutesOf(run.spotCandlesOneMinute ?? run.spotCandles) >= MIN_SESSION_MINUTES && busyStrikes(run).length === 0
  const checkRun = (run) => {
    if (!run?.success) {
      const e = new Error(run?.error ?? 'no OI for the day')
      e.transient = isTransientText(run?.error)
      throw e
    }
    const busy = busyStrikes(run)
    if (busy.length && stopped) for (const { p } of busy) skipped.push({ date: p.date, reason: stopped, busy: true })
  else if (busy.length) {
      const e = new Error(`option OI incomplete - ${busy.length} strike series failed (${busy[0]})`)
      e.transient = true
      throw e
    }
    return (run.optionErrors ?? []).length ? run.optionErrors : null
  }
  // The day's OI, fetched once more (after 3 s) when it comes back incomplete for the load - the server has already
  // retried each strike; Dhan's limit is per second, so a short pause clears it.
  async function fetchRun(date) {
    for (let i = 0; ; i++) {
      const run = await fetcher.dayApi('oi', date, oiQuery(date), oiValid)
      const busy = run?.success ? busyStrikes(run).length : isTransientText(run?.error) ? 1 : 0
      if (!busy || i >= 1) return run
      const waitMs = 3_000 // once: the server already retried each strike; still incomplete -> skipped, tried once more at the end
      progress({ ...(lastScan ?? { stage: 'scan' }), wait: { label: 'option OI', attempt: i + 2, of: 2, waitMs, until: new Date(Date.now() + waitMs).toISOString(), reason: run?.success ? `${busy} strike series failed - fetching the day again` : run?.error } })
      await new Promise((resolve) => setTimeout(resolve, Number(process.env.TUNE_BUSY_PAUSE_MS ?? waitMs)))
    }
  }
  // One day: fetched (from disk when it was fetched before), checked, scanned. Throws with the reason it cannot be used;
  // `err.transient` when the server / Dhan was busy (tried again at the end).
  async function scanOne(p) {
    if (DATA === 'spot') {
      const run = await fetchRun(p.date)
      const optionErrors = checkRun(run)
      const bars = spotBarsOf(run.spotCandlesOneMinute ?? run.spotCandles)
      if (bars.length < MIN_SESSION_MINUTES) throw new Error(`spot candles for only ${bars.length} of 375 minutes - a partial day`)
      const oiMinutes = minutesOf(run.cePoints)
      if (oiMinutes < MIN_SESSION_MINUTES) throw new Error(`option OI for only ${oiMinutes} of 375 minutes - a partial day`)
      const oi = buildOiContext(run, expiryDate, { live: false })
      return { ...tuningDay(p.date, scanSpotDay({ bars, oi, filters: entryFilters }), { minuteBars: bars, heatmap: [] }, oi), estimated: false, quality: { minutes: bars.length, oiMinutes, source: 'spot', ...(optionErrors ? { optionErrors } : {}) } }
    }
    const expiryQuery = p.expiry ? `&expiry=${p.expiry}` : ''
    const body = await fetcher.dayApi('flow', p.date, dayPath(p.date, rowSize, expiryQuery), (b) => b?.bars?.length >= MIN_SESSION_MINUTES)
    if (!body?.bars?.length) throw new Error('no bars')
    const day = dayFromOrderFlow(body, p.date, U)
    if (day.minuteBars.length < MIN_SESSION_MINUTES) throw new Error(`futures bars for only ${day.minuteBars.length} of 375 minutes - a partial day`)
    const estimated = day.source === 'estimated' || day.source === 'truedata'
    const lotSize = day.meta?.lotSize ?? 1
    const tape = estimated ? null : await fetcher.dayApi('tape', p.date, `/api/order-flow/${U}/tape?date=${p.date}&count=60000${expiryQuery}`, (t) => Array.isArray(t?.prints) && t.prints.length > 0)
    const prints = estimated ? null : tape?.prints ?? []
    const run = await fetchRun(p.date)
    const optionErrors = checkRun(run)
    const oiMinutes = minutesOf(run.cePoints)
    if (oiMinutes < MIN_SESSION_MINUTES) throw new Error(`option OI for only ${oiMinutes} of 375 minutes - a partial day`)
    const oi = buildOiContext(run, expiryDate, { live: false })
    const prev = await previousSession(p.date, rowSize, plan)
    const largeLots = cfg.orderFlow?.bigMode === 'auto' || cfg.orderFlow?.bigMode == null ? autoBigLots(prints ?? [], lotSize) ?? 10 : cfg.orderFlow?.largeLots?.[U] ?? 10
    const setups = await scanDaySetups({ day, prints, oi, profile: scannerProfileOf(prev?.bars, U, rowSize), rowSize, lotSize, largeLots, estimated, filters: entryFilters, keepAll: true })
    return { ...tuningDay(p.date, setups, day, oi), estimated, quality: { minutes: day.minuteBars.length, oiMinutes, prints: prints?.length ?? null, previousSession: prev?.date ?? null, source: day.source ?? null, futuresOi: !!run.futuresOiAvailable, ...(optionErrors ? { optionErrors } : {}) } }
  }
  // The day's trades as written, kept now (with why each fired); the setups then drop their check texts - a 250-day
  // job holds every day in memory, and the tuning needs only the numbers.
  const keepDay = (day) => {
    const ids = [...new Set(day.setups.map((s) => s.id))].filter((id) => STRATEGY_BY_ID[id] && !STRATEGY_BY_ID[id].retired)
    for (const id of ids) {
      for (const t of tradeDetails([day], id, DEFAULT_VARIANT, trail, U, { checks: true })) asWritten.push({ id, no: STRATEGY_BY_ID[id].no, name: STRATEGY_BY_ID[id].name, setting: 'as written', ...t })
    }
    day.setups = day.setups.map((s) => (s.checks ? { ...s, checks: null } : s))
    delete day.byId
    days.push(day)
  }
  // Dhan allows 100,000 Data-API calls a day (https://dhanhq.co/docs/v2/), shared with the live pages and the server
  // scanner: the job stops scanning before it would take the last 10% (TUNE_DHAN_RESERVE) - the days it did not reach are
  // listed with the reason; run it again tomorrow (the days already fetched come from the disk cache).
  const reserve = Math.min(0.9, Math.max(0, Number(process.env.TUNE_DHAN_RESERVE ?? 0.1)))
  const dhanBudgetLeft = async () => {
    const u = await api(`/api/strategy-tuning/dhan-usage`).catch(() => null)
    if (!(u?.dailyLimit > 0)) return null
    return u.calls < u.dailyLimit * (1 - reserve) ? null : `Dhan's daily Data-API limit nearly used (${u.calls.toLocaleString('en-IN')} of ${u.dailyLimit.toLocaleString('en-IN')} calls today) - stopped to leave the rest to the live app; run the job again tomorrow (the days already fetched come from the cache)`
  }
  let stopped = null
  const busy = []
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i]
    if (DATA === 'spot' && days.length >= MAX_DAYS) break
    lastScan = { stage: 'scan', day: p.date, done: i, total: plan.length, scanned: days.length, skipped: skipped.length }
    progress(lastScan)
    if ((stopped = await dhanBudgetLeft())) {
      // (Spot + options lists spare weekdays for holidays: only as many as the days still wanted.)
      for (const rest of plan.slice(i, DATA === 'spot' ? i + Math.max(0, MAX_DAYS - days.length) : undefined)) skipped.push({ date: rest.date, reason: stopped, busy: true })
      break
    }
    try {
      keepDay(await scanOne(p))
    } catch (err) {
      if (err.transient) busy.push({ p, err })
      else skipped.push({ date: p.date, reason: err.message })
    }
  }
  // Days the server / Dhan was too busy for, even after the retries: once more after a pause, then listed as skipped.
  if (busy.length) {
    progress({ stage: 'scan', day: busy[0].p.date, done: plan.length, total: plan.length, retrying: busy.length, wait: { label: 'busy days', waitMs: 10_000, until: new Date(Date.now() + 10_000).toISOString(), reason: `${busy.length} day(s) the server was too busy for - trying them again` } })
    await new Promise((resolve) => setTimeout(resolve, Number(process.env.TUNE_BUSY_PAUSE_MS ?? 10_000)))
    for (const { p } of busy) {
      if (DATA === 'spot' && days.length >= MAX_DAYS) break
      lastScan = { stage: 'scan', day: p.date, done: plan.length, total: plan.length, retrying: busy.length, scanned: days.length, skipped: skipped.length }
      progress(lastScan)
      const out = stopped ?? await dhanBudgetLeft()
      if (out) { stopped = out; skipped.push({ date: p.date, reason: out, busy: true }); continue }
      try { keepDay(await scanOne(p)) } catch (err) { skipped.push({ date: p.date, reason: err.message, busy: !!err.transient }) }
    }
  }
  days.sort((a, b) => (a.date < b.date ? 1 : -1))
  skipped.sort((a, b) => (a.date < b.date ? 1 : -1))
  if (!days.length) throw new Error(`none of the ${plan.length} day(s) could be scanned (${skipped[0]?.reason ?? 'unknown'})`)

  progress({ stage: 'rank', done: days.length, total: days.length })
  const spotIds = SPOT_STRATEGIES.map((s) => s.id)
  const ranked = rankStrategies(days, { trail, minTrades: MIN_TRADES, ids: DATA === 'spot' ? spotIds : ACTIVE_STRATEGIES.map((s) => s.id) }).map((r) => ({ ...r, name: STRATEGY_BY_ID[r.id]?.name, no: STRATEGY_BY_ID[r.id]?.no }))
  const pick = job.strategies
  const ids = Array.isArray(pick) ? pick.filter((id) => STRATEGY_BY_ID[id] && !STRATEGY_BY_ID[id].retired && (DATA === 'spot') === !!STRATEGY_BY_ID[id].spot)
    : pick === 'all' ? ranked.filter((r) => r.n > 0).map((r) => r.id)
      : (() => {
        // The top ones with at least the minimum trades; when fewer than asked reach it, the next ones that traded at all
        // (marked below the minimum in the result) rather than showing nothing.
        const want = pick === 'top5' ? 5 : 3
        const enough = ranked.filter((r) => r.n >= MIN_TRADES)
        const rest = ranked.filter((r) => r.n > 0 && r.n < MIN_TRADES)
        return [...enough, ...rest].slice(0, want).map((r) => r.id)
      })()
  const results = []
  for (let i = 0; i < ids.length; i++) {
    progress({ stage: 'tune', strategy: ids[i], done: i, total: ids.length })
    results.push(tuneStrategy(days, ids[i], {
      trail, minTrades: MIN_TRADES, what: WHAT, oiKeys: OI_KEYS, search: SEARCH, underlying: U,
      onProgress: (p) => progress({ stage: 'tune', strategy: ids[i], done: i, total: ids.length, ...p }),
    }))
  }
  // The run's own place in the HISTORY, as CSV (no database): its trades - each strategy as written on every day
  // scanned, with why it fired, and each fine-tuned strategy's best setting - and the settings themselves, so a
  // strategy can be compared run by run. Written before the result, so a result always has its history beside it.
  const trades = [...asWritten]
  for (const res of results) {
    res.settingText = res.best ? `${variantText(res.best.params)}${res.unit === 'pts' ? ` · ${optionText(res.best.params)}` : ''}` : null
    for (const t of res.best?.trades ?? []) trades.push({ id: res.id, no: res.no, name: res.name, setting: 'best', settingText: res.settingText, recommend: res.recommend, ...t })
  }
  trades.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || a.t - b.t || (a.no ?? 0) - (b.no ?? 0))
  if (HISTORY_DIR) {
    const h = historyOf({
      underlying: U, data: DATA, finishedMs: Date.now(), what: WHAT, search: SEARCH, minTrades: MIN_TRADES, from: FROM, to: TO,
      days: days.map((d) => ({ date: d.date, estimated: d.estimated })), skipped, results, trades, fetched: fetcher.stats,
    })
    mkdirSync(HISTORY_DIR, { recursive: true })
    writeJson(join(HISTORY_DIR, `${h.run_id}-trades.csv`), null, toCsv(TRADE_COLUMNS, h.trades))
    writeJson(join(HISTORY_DIR, `${h.run_id}-settings.csv`), null, toCsv(SETTING_COLUMNS, h.settings))
    // runs.csv: the header once, then a line per run (appended - an older run is never rewritten).
    const runsPath = join(HISTORY_DIR, 'runs.csv')
    const line = toCsv(RUN_COLUMNS, [h.run])
    appendFileSync(runsPath, existsSync(runsPath) ? line.slice(line.indexOf('\n') + 1) : line)
    console.log(`HISTORY ${h.run_id} (${h.trades.length} trades, ${h.settings.length} settings)`)
  }
  write({
    ok: true, underlying: U, job, startedUtc, finishedUtc: new Date().toISOString(), rowSize, trail, minTrades: MIN_TRADES, what: WHAT, search: SEARCH, data: DATA, from: FROM, to: TO, oiFactors: OI_KEYS ?? OI_FACTORS.map((f) => f.key),
    grid: WHAT === 'trade' ? TUNING_GRID : WHAT === 'oi' ? oiGridOf(OI_KEYS) : WHAT === 'option' ? OPTION_GRID : WHAT === 'all' ? { ...oiGridOf(OI_KEYS), ...TUNING_GRID, ...OPTION_GRID } : { ...oiGridOf(OI_KEYS), ...TUNING_GRID },
    days: days.map((d) => ({ date: d.date, estimated: d.estimated, setups: d.setups.length, ...d.quality })), skipped, ranked, results, fetched: fetcher.stats,
    strategies: ACTIVE_STRATEGIES.length,
  })
  progress({ stage: 'done', done: ids.length, total: ids.length })
}

main().catch((err) => {
  console.error(err.stack ?? err.message)
  write({ ok: false, underlying: U, job, startedUtc, finishedUtc: new Date().toISOString(), error: err.message })
  process.exit(1)
})
