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
//   TUNE_HISTORY_DIR              the history kept as CSV (tuneHistory.mjs): runs.csv, {run}-trades.csv, {run}-settings.csv, {run}-days.csv -
//                                 every run's trades and tuned settings, per index, read by the Trades page
//   TUNE_CACHE_DIR                where each past day's fetched data is kept (tuneFetch.mjs): a rerun / resume / longer range
//                                 reads it from disk - no Dhan call; TUNE_PACE_MS the pause between requests that reach the server
//   TUNE_JOB_BUDGET_MS            the whole job's time (see below); TUNE_MAX_FETCHES_PER_DAY how many times one day's
//                                 data of one kind may be fetched in a whole job
// Progress goes to stdout as lines "PROGRESS {json}".
//
// A JOB ALWAYS ENDS, AND ALWAYS WITH A RESULT. Three things see to that, because a job that never finishes is the one
// fault a trader cannot work around:
//   - TUNE_JOB_BUDGET_MS (StrategyTuning:JobBudgetMinutes, 90 minutes by default) is the whole job's time. Past it the
//     job STOPS scanning, gives up on the strategy it is fine-tuning and starts no further one, lists the days it did
//     not reach with that reason in plain words, and writes its result and history with the days it did get -
//     `budget` in the result says how many that was. (A strategy's fine-tuning is pure CPU that no timer can
//     interrupt, so the budget is checked in its own progress callback, every 250 combinations.)
//   - no single stretch can outlast it either: past the budget a busy server is no longer waited out (tuneFetch's
//     `deadline`), and one day's data of one kind is fetched at most TUNE_MAX_FETCHES_PER_DAY times in a whole job
//     (tuneFetch's `maxPerDay`) however many retry rounds would like to - what used to be up to eight fetches of one
//     day (two per attempt x four attempts) is now three.
//   - a last-resort watchdog: if the job is somehow still stuck a quarter past its budget (inside one request that
//     never returns, say), it writes an unsuccessful result naming the stage it was in and exits. There is no path out
//     of this script that leaves no result file behind.
//
// WHAT EACH DAY COST, COUNTED. `calls` in the result is the job's own HTTP requests by endpoint and by the part of the
// job that asked for them (range windows, per-day option chain, the busy retries, the previous session, futures, the
// tape), plus `dhan` - the server's own Dhan Data-API counter read before and after the job, so the Dhan calls the job
// caused are a measured number rather than an assertion. (The server's counter is account-wide: anything the live app
// did at the same time is in that delta too, which is why the per-endpoint counts are there beside it.)

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { buildOiContext, ACTIVE_STRATEGIES, SPOT_STRATEGIES, STRATEGY_BY_ID, TRADE_FILTERS, filtersForIndex, pinnedTrailOf } from '../src/strategyEngine.js'
import { scanSpotDay, spotBarsOf } from '../src/spotEngine.js'
import { autoBigLots } from '../src/orderFlowMath.js'
import { scannerProfileOf, trailFor } from '../src/scannerCore.js'
import { defaultTradeLevels } from '../src/tradeDefaults.js'
import { expiryFlagOf } from '../src/liveFeeds.js'
import { dayFromOrderFlow, scanDaySetups } from '../src/scanDay.js'
import { evaluateSetting, paramsFromFilters, DEFAULT_VARIANT, splitDays, OI_COMBO_CAP, OI_FACTORS, OPTION_GRID, countOiCombinations, oiFactorsFor, oiGridOf, optionText, rankStrategies, tradeDetails, tuneStrategy, tuningDay, TUNING_GRID, variantText } from '../src/strategyTuning.js'
import { DEFAULT_ROW_SIZES } from './indexScanner.mjs'
import { createFetcher, isTransientText, pruneCache } from './tuneFetch.mjs'
import { CHECK_COLUMNS, DAY_COLUMNS, RUN_COLUMNS, SETTING_COLUMNS, TRADE_COLUMNS, historyOf, runsCsvWith, toCsv } from './tuneHistory.mjs'
import { candidatesFrom, candidatesOfResults, crossCheck, mergeCandidates } from './tuneChecks.mjs'

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
// 'check': no new tuning - only the cross-check of every setting found so far on these days (tuneChecks.mjs).
// 'lab': no tuning either - ONE strategy measured with the setting the Strategy lab page sent (job.params), beside it as
// written and as applied on this index; nothing is written to the tuning history.
const WHAT = ['trade', 'oi', 'both', 'option', 'all', 'check', 'lab'].includes(job.what) ? job.what : 'trade'
const DATA = job.data === 'spot' ? 'spot' : 'futures' // spot: the index candles + the option chain's OI only - no futures, no order flow
const SEARCH = job.search === 'full' ? 'full' : 'step'
// Spot + options has no futures, so a futures OI input is dropped here too - whatever the page sent.
const USABLE_OI = oiFactorsFor(DATA).map((f) => f.key)
const OI_KEYS = Array.isArray(job.oiFactors) && job.oiFactors.length
  ? job.oiFactors.filter((k) => USABLE_OI.includes(k))
  : (DATA === 'spot' ? USABLE_OI : null)
const startedUtc = new Date().toISOString()
// The whole job's time budget. Generous by default - a 250-day job on a quiet night is meant to finish inside it - but
// hard: see the header. 0 / a negative value is not accepted; the floor is a second (the server itself never passes
// less than a whole minute - StrategyTuning:JobBudgetMinutes - but a test needs a budget it can run out of).
const BUDGET_MS = Math.max(1_000, Number(process.env.TUNE_JOB_BUDGET_MS) || 90 * 60_000)
const START_MS = Date.now()
const DEADLINE_MS = START_MS + BUDGET_MS
const overBudget = () => Date.now() >= DEADLINE_MS
const budgetMinutes = Math.round(BUDGET_MS / 60_000)
const budgetText = BUDGET_MS >= 60_000 ? `${budgetMinutes} minute(s)` : `${Math.round(BUDGET_MS / 1_000)} second(s)`
/** Where the job is, for the watchdog - the one thing it can report when nothing else can. */
const state = { stage: 'starting', scanned: 0, skipped: 0, planned: 0, tuned: 0 }
/** Why the job stopped early, in plain words, once it has. */
let budgetStop = null
const budgetReason = () => `the job's own time budget of ${budgetText} ran out after ${state.scanned} of ${state.planned} day(s) - the result holds those days; run the job again and the days already fetched come from the cache (no Dhan call for them)`

const progress = (p) => console.log(`PROGRESS ${JSON.stringify({ ...p, startedUtc, fetched: fetcher?.stats })}`)
const istToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
// The server (and through it Dhan) is read with retries while it is busy, and each past day's data is kept on disk.
let lastScan = null
const CACHE_DIR = process.env.TUNE_CACHE_DIR || null
const fetcher = createFetcher({
  base: BASE, key: KEY, today: istToday, cacheDir: CACHE_DIR, scope: U,
  paceMs: Math.max(0, Number(process.env.TUNE_PACE_MS) || 0),
  retryScale: Math.max(0.0001, Number(process.env.TUNE_RETRY_SCALE) || 1),
  // One day's data of one kind, at most this many fetches in a whole job - the hard stop on the retry rounds
  // multiplying a day's 42 Dhan option-series calls. 2 covers the ordinary case (an incomplete OI day fetched once
  // more), the third is the one retry round a genuinely busy server earns.
  maxPerDay: Math.max(1, Math.min(10, Number(process.env.TUNE_MAX_FETCHES_PER_DAY) || 3)),
  deadline: overBudget,
  // Always background priority: the live pages and the server scanner get Dhan first, the job what they leave (up to the
  // full 5/s while they are quiet) - a running job never slows the app down. (TUNE_PRIORITY=interactive overrides.)
  priority: () => (process.env.TUNE_PRIORITY === 'interactive' ? 'interactive' : 'background'),
  onWait: (w) => progress({ ...(lastScan ?? { stage: 'scan', day: null, done: 0, total: 0 }), wait: { ...w, until: new Date(Date.now() + w.waitMs).toISOString() } }),
})
const api = (path, opts = {}) => fetcher.api(path, { source: 'other', ...opts })
/** Written beside the final name and moved onto it, so a reader never sees half a file. */
const writeJson = (path, body, text = null) => {
  writeFileSync(`${path}.tmp`, text ?? JSON.stringify(body))
  renameSync(`${path}.tmp`, path)
}
const write = (body) => writeJson(OUT, body)
/** What the job did, for the result and the history row - the whole point being that "it made N calls, these are
 *  where they went" is countable afterwards instead of argued about. The per-endpoint and per-source counts are the
 *  job's OWN requests to this server (exact); `dhan` is the server's account-wide Dhan counter read before and after
 *  (so the live app's own calls during the job are in that delta too, which is why both are here). */
const callReport = (stats, perKind, fast, dhan) => {
  const oiFetches = perKind.oi?.fetches ?? 0
  return {
    note: 'byEndpoint / bySource count this job\'s own HTTP requests to this server, by endpoint (dates folded together) and by the part of the job that asked. optionChain turns the option-chain ones into Dhan option-series calls at the known 42 per per-day fetch; dhan is the server\'s own counter before and after, which is account-wide.',
    requests: stats.requests, retries: stats.retries, cacheHits: stats.cacheHits, sharedInFlight: stats.shared,
    daysSeededIntoCache: stats.seeded, waitedMs: stats.waitedMs,
    maxFetchesPerDay: stats.maxPerDay, repeatFetches: stats.repeats, refusedOverThatLimit: stats.refused,
    byEndpoint: stats.byEndpoint, bySource: stats.bySource, perKind,
    optionChain: {
      rangeWindowCalls: fast.windowCalls, serverPerDayFallbackCalls: fast.fallbackCalls,
      daysSeededByRange: fast.seeded, daysFromWindows: fast.fromWindows, daysTheServerFellBackFor: fast.fromFallback,
      perDayFetches: oiFetches, perDayCalls: oiFetches * 42,
      total: fast.windowCalls + fast.fallbackCalls + oiFetches * 42,
    },
    dhan: {
      atStart: dhan.first, atEnd: dhan.last, dailyLimit: dhan.dailyLimit,
      caused: dhan.first != null && dhan.last != null ? dhan.last - dhan.first : null,
      causedBackground: dhan.backgroundFirst != null && dhan.background != null ? dhan.background - dhan.backgroundFirst : null,
    },
  }
}
// Last resort. The cooperative checks above end a job inside its budget; this one covers the case none of them can -
// the job stuck inside a single request that never returns at all. It writes a result naming the stage it was in and
// stops, so there is no path out of this script that leaves no result behind. Unref'd: it never holds a job open.
const WATCHDOG_MS = BUDGET_MS + Math.max(60_000, Math.round(BUDGET_MS * 0.25))
const watchdog = setTimeout(() => {
  try {
    write({
      ok: false, underlying: U, job, startedUtc, finishedUtc: new Date().toISOString(),
      error: `the job was stopped: ${Math.round(WATCHDOG_MS / 60_000)} minute(s) in it was still in the "${state.stage}" stage, past its own ${budgetText} budget - ${state.scanned} of ${state.planned} day(s) scanned, ${state.skipped} left out, ${state.tuned} strategy(s) fine-tuned. Run it again (the days already fetched come from the cache) or with a shorter range.`,
      budget: { minutes: budgetMinutes, stoppedBy: 'watchdog', ...state },
    })
  } catch { /* nothing further can be done */ }
  process.exit(1)
}, WATCHDOG_MS)
watchdog.unref()

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
      // The same request a scanned day makes for itself, so one in-flight fetch is shared and a later day reads it
      // from the disk cache - a neighbouring day is never a second Dhan fetch of the same day.
      const body = await fetcher.dayApi('flow', key, dayPath(key, rowSize, own ? `&expiry=${own}` : ''), (b) => b?.bars?.length > 0, { source: 'previous-session' })
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
  const config = await api('/api/scanner-runner/config', { source: 'config' }).catch(() => ({}))
  const cfg = { ...(config?.settings ?? {}) }
  const rowSize = cfg.orderFlow?.rowSizes?.[U] ?? DEFAULT_ROW_SIZES[U] ?? 1
  const trail = trailFor(cfg, U)
  // The index's max rules (Trade settings: Max SL / Max target - the server's config.levels), which the scanner holds every
  // strategy's option trade to: every option measured here is held to them too (each day's optionCaps) - the bought and
  // the sold option of each trade, and the option trades a setting takes its own way.
  const levelsNow = { ...defaultTradeLevels(U), ...(config?.levels?.[U] ?? {}) }
  const optionLevels = { maxSl: Number(levelsNow.maxSl ?? levelsNow.sl) || 0, maxTarget: Number(levelsNow.maxTarget ?? levelsNow.target) || 0 }
  // The strategies' own entry filters as the trader set them (for this index); the trade filters are what is tuned (from their defaults).
  const tradeKeys = new Set(TRADE_FILTERS.map((f) => f.key))
  const entryFilters = Object.fromEntries(Object.entries(filtersForIndex({ filters: cfg.filters, filtersByIndex: config?.filtersByIndex }, U)).map(([id, f]) => [id, Object.fromEntries(Object.entries(f ?? {}).filter(([k]) => !tradeKeys.has(k)))]))

  // The days: the recorded (exact) ones, newest first; with includeEstimated, other weekdays too (rebuilt from 1-minute candles).
  // Spot + options needs no order flow: the past weekdays that have OI data are the days (holidays fail and are skipped).
  const recorded = DATA === 'spot' ? [] : ((await api(`/api/order-flow/${U}/days`, { source: 'days' })) ?? []).filter((d) => !(d.isLive ?? d.live) && d.date < istToday && inRange(d.date))
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

  state.planned = plan.length
  const expiries = await api(`/api/oi-replay/${U}/expiries`, { source: 'expiries' }).catch(() => null)
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
      const run = await fetcher.dayApi('oi', date, oiQuery(date), oiValid, { source: i === 0 ? 'option-chain-day' : 'option-chain-refetch' })
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
    const body = await fetcher.dayApi('flow', p.date, dayPath(p.date, rowSize, expiryQuery), (b) => b?.bars?.length >= MIN_SESSION_MINUTES, { source: 'futures-day' })
    if (!body?.bars?.length) throw new Error('no bars')
    const day = dayFromOrderFlow(body, p.date, U)
    if (day.minuteBars.length < MIN_SESSION_MINUTES) throw new Error(`futures bars for only ${day.minuteBars.length} of 375 minutes - a partial day`)
    const estimated = day.source === 'estimated' || day.source === 'truedata'
    const lotSize = day.meta?.lotSize ?? 1
    const tape = estimated ? null : await fetcher.dayApi('tape', p.date, `/api/order-flow/${U}/tape?date=${p.date}&count=60000${expiryQuery}`, (t) => Array.isArray(t?.prints) && t.prints.length > 0, { source: 'tape' })
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
      for (const t of tradeDetails([day], id, DEFAULT_VARIANT, trail, U, { checks: true, optionLevels })) asWritten.push({ id, no: STRATEGY_BY_ID[id].no, name: STRATEGY_BY_ID[id].name, setting: 'as written', ...t })
    }
    day.setups = day.setups.map((s) => (s.checks ? { ...s, checks: null } : s))
    delete day.byId
    day.optionCaps = optionLevels
    days.push(day)
    state.scanned = days.length
  }
  // Dhan allows 100,000 Data-API calls a day (https://dhanhq.co/docs/v2/), shared with the live pages and the server
  // scanner: the job stops scanning before it would take the last 10% (TUNE_DHAN_RESERVE) - the days it did not reach are
  // listed with the reason; run it again tomorrow (the days already fetched come from the disk cache).
  const reserve = Math.min(0.9, Math.max(0, Number(process.env.TUNE_DHAN_RESERVE ?? 0.1)))
  // The server's own Dhan Data-API counter, read as the job goes: the FIRST and LAST readings are what make "this job
  // caused N Dhan calls" a measured number in the result rather than a claim. (Account-wide, so the live app's own
  // calls are in the delta too - `calls.byEndpoint` beside it is the job's own, exact.)
  const dhan = { first: null, last: null, background: null, backgroundFirst: null, dailyLimit: null }
  const dhanBudgetLeft = async () => {
    const u = await api(`/api/strategy-tuning/dhan-usage`, { source: 'dhan-usage' }).catch(() => null)
    if (!(u?.dailyLimit > 0)) return null
    dhan.dailyLimit = u.dailyLimit
    if (dhan.first == null) dhan.first = u.calls
    dhan.last = u.calls
    if (typeof u.backgroundCalls === 'number') {
      if (dhan.backgroundFirst == null) dhan.backgroundFirst = u.backgroundCalls
      dhan.background = u.backgroundCalls
    }
    return u.calls < u.dailyLimit * (1 - reserve) ? null : `Dhan's daily Data-API limit nearly used (${u.calls.toLocaleString('en-IN')} of ${u.dailyLimit.toLocaleString('en-IN')} calls today) - stopped to leave the rest to the live app; run the job again tomorrow (the days already fetched come from the cache)`
  }
  await dhanBudgetLeft().catch(() => null) // the first reading, before anything is fetched
  let stopped = null
  // A few days are fetched at once (the server still holds Dhan to its 5 calls a second): while one day's setups are
  // being worked out - that is this process's own CPU, with nothing in flight - the next days' data is already on its
  // way, instead of the job going quiet between days.
  const AT_ONCE = Math.max(1, Math.min(8, Number(process.env.TUNE_DAYS_AT_ONCE) || 3))
  // ---- the option chain, a whole expiry cycle per Dhan call -----------------------------------------------------
  // Dhan serves up to 30 days of a strike's history in ONE call, so a cycle of days costs 42 calls instead of 42 a
  // day. It is used only once the server has PROVED it on this very job: one day is fetched both ways and every OI
  // point compared (range-check). Anything short of a match - or any trouble while prefetching - and the job carries
  // on exactly as before, a day at a time. The days it does bring back are put in the same cache the per-day path
  // reads, so nothing else about the job changes.
  const fastOi = {
    used: false, reason: null, detail: null, checked: null, proof: null,
    // seeded = days put in the cache the scan loop reads, so it never fetches them again. fromWindows / fromFallback
    // split those by how the SERVER got them: out of a cycle window, or per-day inside the range request because a
    // window could not answer. BOTH are seeded - a day the server already paid per-day for inside /range used to be
    // the one the scan loop could still go and pay for a second time if it came back anything less than perfect.
    seeded: 0, fromWindows: 0, fromFallback: 0, unusable: 0, unusableDays: [],
    windows: 0, chunks: 0, calls: 0, windowCalls: 0, fallbackCalls: 0, serverFallbackDays: 0, unservedByServer: 0,
    // span: whether ONE Dhan call per strike may cover a whole 30-day span straight across the expiries (Dhan serves
    // "upto 30 days of data in a single API call") - only once the server has shown, across a real expiry, that the
    // days come back identical to the per-day fetch (range-span-check). Otherwise one window per expiry cycle.
    span: { used: false, proof: null, checked: null, includeExpiryDays: false, reason: null },
  }
  // The proof is kept beside the cache, so a rerun / a resumed job / tomorrow's job does not spend it again: the
  // check costs a whole window of strike calls plus the same day fetched per-day (~84 Dhan calls) and proves a thing
  // about this server and this Dhan account, which does not change between two jobs an hour apart.
  const PROOF_TTL_MS = Math.max(0, Number(process.env.TUNE_CHECK_TTL_DAYS ?? 7)) * 86_400_000
  const proofPath = CACHE_DIR ? join(CACHE_DIR, `range-check-${U}-${expiryFlagOf(U)}.json`) : null
  const readProof = () => {
    if (!proofPath || !PROOF_TTL_MS || !existsSync(proofPath)) return null
    try {
      const kept = JSON.parse(readFileSync(proofPath, 'utf8'))
      return Date.parse(kept.at) > Date.now() - PROOF_TTL_MS ? kept : null
    } catch { return null }
  }
  async function prefetchOi() {
    if (process.env.TUNE_FAST_OI === 'off') return (fastOi.reason = 'switched off for this job')
    if (!CACHE_DIR) return (fastOi.reason = 'no cache directory to put the days in')
    const dates = plan.map((p) => p.date).filter((d) => d < istToday).sort()
    if (dates.length < 4) return (fastOi.reason = 'too few days to be worth it')
    // However this goes, the job must get on with scanning: the whole prefetch is given a budget - its own, and never
    // past the job's overall one - and whatever is not fetched by then is simply fetched a day at a time later.
    const own = Math.max(30_000, Number(process.env.TUNE_PREFETCH_BUDGET_MS) || 480_000)
    const until = Math.min(Date.now() + own, DEADLINE_MS)
    const left = () => Math.max(0, until - Date.now())
    const flag = expiryFlagOf(U)
    // Proof first - from disk when this server proved it recently, else on a day this job actually wants.
    const kept = readProof()
    let check
    if (kept) {
      fastOi.proof = `proved on ${kept.date} at ${kept.at} and kept for ${PROOF_TTL_MS / 86_400_000} day(s) - not proved again (a proof costs a window of strike calls plus the same day fetched per-day)`
      check = kept
    } else {
      const mid = dates[Math.floor(dates.length / 2)]
      lastScan = { stage: 'prefetch', day: mid, done: 0, total: dates.length, checking: true }
      progress(lastScan)
      try {
        check = await api(`/api/oi-replay/${U}/range-check?${new URLSearchParams({ date: mid, timeframeMinutes: '1', expiryFlag: flag })}`,
          { attempts: 1, timeoutMs: Math.max(30_000, Math.min(left(), Number(process.env.TUNE_CHECK_TIMEOUT_MS) || 150_000)), source: 'range-check' })
      } catch (err) {
        fastOi.detail = err.message
        return (fastOi.reason = 'the check did not come back in time - every day fetched the proven way instead')
      }
      check = { ...check, date: mid, at: new Date().toISOString() }
      fastOi.proof = 'proved on this job'
      try {
        mkdirSync(CACHE_DIR, { recursive: true })
        writeJson(proofPath, { date: mid, at: check.at, match: !!check.match, windowDays: check.windowDays ?? null, differences: check?.comparison?.differences?.slice(0, 3) ?? [] })
      }
      catch { /* nowhere to keep it: proved again next job */ }
    }
    fastOi.checked = { date: check.date, match: !!check?.match, windowDays: check?.windowDays ?? null, differences: check?.comparison?.differences?.slice(0, 3) ?? check?.differences ?? [], error: check?.error ?? null }
    if (!check?.match) {
      fastOi.detail = check?.error ?? fastOi.checked.differences?.slice(0, 3).join(' · ') ?? null
      return (fastOi.reason = 'a day fetched a cycle at a time did not match the same day fetched on its own - every day fetched the proven way instead')
    }
    // One step further, proved the same way and kept the same way: a whole span of days per Dhan call, straight
    // across the expiries, instead of a window per cycle (NIFTY's weekly cycle made that ~84 calls a week).
    await proveSpan(dates, left, flag)
    if (fastOi.span.used) return prefetchSpans(dates, left, flag)
    // Proven: bring the days back in chunks, oldest first. A chunk is asked for as WIDE as one request may be (the
    // server's own cap), not in little 5-day pieces: the server cuts a range at every real expiry itself, so a wide
    // chunk becomes whole, properly-anchored cycle windows, while a narrow chunk cut across a cycle turned one
    // window into two - 42 strike calls each - for the very same days.
    // Wide enough that a request covers whole expiry cycles (a chunk that splits one costs an extra window), narrow
    // enough that the answer is a size that comes back: a day is ~15,750 OI points, so 14 days is already tens of
    // megabytes of JSON for the server to build and this process to read. A request that times out wastes everything
    // it had fetched, so a smaller chunk also loses less when one does.
    const CHUNK = Math.max(2, Math.min(31, Number(process.env.TUNE_RANGE_DAYS) || 14))
    for (let i = 0; i < dates.length; i += CHUNK) {
      const from = dates[i]
      const to = dates[Math.min(i + CHUNK - 1, dates.length - 1)]
      if (!left()) { fastOi.reason = `took too long after ${fastOi.seeded} of ${dates.length} day(s) - the rest fetched a day at a time`; break }
      lastScan = { stage: 'prefetch', day: from, done: fastOi.seeded, total: dates.length, prefetch: { from, to, seeded: fastOi.seeded, of: dates.length } }
      progress(lastScan)
      let body
      try {
        // perDayFallback=false: a day no window could answer for is NOT fetched per-day inside this request. Those
        // days come back named, and the scan loop fetches each one once, through the cache, at the job's own pace -
        // instead of one huge request whose timeout would throw away every per-day call it had already made.
        body = await api(`/api/oi-replay/${U}/range?${new URLSearchParams({ from, to, timeframeMinutes: '1', expiryFlag: flag, perDayFallback: 'false' })}`,
          { attempts: 2, timeoutMs: Math.max(60_000, Math.min(left(), Number(process.env.TUNE_RANGE_TIMEOUT_MS) || 300_000)), source: 'range-window' })
      } catch (err) {
        fastOi.detail = err.message
        fastOi.reason = `${fastOi.seeded} day(s) came back this way; the rest fetched a day at a time`
        break
      }
      seedRange(body)
    }
    fastOi.used = fastOi.seeded > 0
    return fastOi.reason
  }
  // One range answer into the cache the scan loop reads.
  function seedRange(body) {
    fastOi.chunks++
    fastOi.windows += body?.windows?.length ?? 0
    fastOi.calls += body?.optionSeriesCalls ?? 0
    fastOi.windowCalls += body?.windowOptionSeriesCalls ?? body?.optionSeriesCalls ?? 0
    fastOi.fallbackCalls += body?.fallbackOptionSeriesCalls ?? 0
    fastOi.serverFallbackDays += (body?.fallbackDays ?? []).length
    fastOi.unservedByServer += (body?.unservedDays ?? []).length
    for (const run of body?.days ?? []) {
      const date = String(run?.date ?? '').slice(0, 10)
      if (!date) continue
      // EVERY day the range returned that is usable is kept - a window day and a day the server itself fell back
      // per-day alike (the same test the per-day path applies, oiValid). A day that is not usable is named here,
      // and the scan loop fetches it the old way, once.
      if (fetcher.putDay('oi', date, oiQuery(date), run, oiValid)) {
        fastOi.seeded++
        if (run?.fetchSource === 'day') fastOi.fromFallback++
        else fastOi.fromWindows++
      } else {
        fastOi.unusable++
        if (fastOi.unusableDays.length < 20) fastOi.unusableDays.push(date)
      }
    }
  }
  // The span proof (range-span-check), from disk when this server proved it recently.
  const spanProofPath = CACHE_DIR ? join(CACHE_DIR, `range-span-check-${U}-${expiryFlagOf(U)}.json`) : null
  async function proveSpan(dates, left, flag) {
    const span = fastOi.span
    if (process.env.TUNE_SPAN_OI === 'off') return (span.reason = 'switched off for this job')
    let check = null
    try {
      if (spanProofPath && PROOF_TTL_MS && existsSync(spanProofPath)) {
        const kept = JSON.parse(readFileSync(spanProofPath, 'utf8'))
        if (Date.parse(kept.at) > Date.now() - PROOF_TTL_MS) { check = kept; span.proof = `proved on ${kept.at} and kept - not proved again` }
      }
    } catch { check = null }
    if (!check) {
      const mid = dates[Math.floor(dates.length / 2)]
      lastScan = { stage: 'prefetch', day: mid, done: 0, total: dates.length, checking: 'span' }
      progress(lastScan)
      try {
        const body = await api(`/api/oi-replay/${U}/range-span-check?${new URLSearchParams({ date: mid, timeframeMinutes: '1', expiryFlag: flag })}`,
          { attempts: 1, timeoutMs: Math.max(30_000, Math.min(left(), Number(process.env.TUNE_CHECK_TIMEOUT_MS) || 150_000)), source: 'range-span-check' })
        check = { acrossMatch: !!body?.acrossMatch, expiryDayMatch: !!body?.expiryDayMatch, expiry: body?.expiry ?? null, error: body?.error ?? null,
          differences: (body?.days ?? []).filter((d) => !d.match).flatMap((d) => d.differences ?? []).slice(0, 3), at: new Date().toISOString() }
        span.proof = 'proved on this job'
        // Only a real answer is kept (an error / no comparison is asked again next job).
        if (spanProofPath && !check.error) { try { mkdirSync(CACHE_DIR, { recursive: true }); writeJson(spanProofPath, check) } catch { /* proved again next job */ } }
      } catch (err) {
        return (span.reason = `the span check did not come back (${err.message}) - one window per expiry cycle instead`)
      }
    }
    span.checked = { acrossMatch: !!check.acrossMatch, expiryDayMatch: !!check.expiryDayMatch, expiry: check.expiry ?? null, differences: check.differences ?? [], error: check.error ?? null }
    if (!check.acrossMatch) return (span.reason = `${check.error ?? 'a window across an expiry did not match the per-day fetch'} - one window per expiry cycle instead`)
    span.used = true
    span.includeExpiryDays = !!check.expiryDayMatch
    return null
  }
  // Proved: spans straight across the expiries, oldest first, ONE request (one Dhan call per strike) each. 15 days by
  // default - Dhan allows 30, but a whole month of minute OI is too big to send back in one answer.
  async function prefetchSpans(dates, left, flag) {
    const SPAN = Math.max(2, Math.min(31, Number(process.env.TUNE_SPAN_DAYS) || 15))
    const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
    let i = 0
    while (i < dates.length) {
      const from = dates[i]
      const limit = addDays(from, SPAN - 1)
      let to = from
      while (i < dates.length && dates[i] <= limit) to = dates[i++]
      if (!left()) { fastOi.reason = `took too long after ${fastOi.seeded} of ${dates.length} day(s) - the rest fetched a day at a time`; break }
      lastScan = { stage: 'prefetch', day: from, done: fastOi.seeded, total: dates.length, prefetch: { from, to, span: true, seeded: fastOi.seeded, of: dates.length } }
      progress(lastScan)
      let body
      try {
        body = await api(`/api/oi-replay/${U}/range?${new URLSearchParams({ from, to, timeframeMinutes: '1', expiryFlag: flag, perDayFallback: 'false',
          spanExpiries: 'true', includeExpiryDays: String(fastOi.span.includeExpiryDays) })}`,
        { attempts: 2, timeoutMs: Math.max(60_000, Math.min(left(), Number(process.env.TUNE_RANGE_TIMEOUT_MS) || 300_000)), source: 'range-span' })
      } catch (err) {
        fastOi.detail = err.message
        fastOi.reason = `${fastOi.seeded} day(s) came back this way; the rest fetched a day at a time`
        break
      }
      seedRange(body)
    }
    fastOi.used = fastOi.seeded > 0
    return fastOi.reason
  }
  state.stage = 'prefetch'
  await prefetchOi()
  lastScan = null
  state.stage = 'scan'
  progress({ stage: 'scan', day: plan[0]?.date, done: 0, total: plan.length, fastOi })

  const busy = []
  for (let i = 0; i < plan.length; i += AT_ONCE) {
    if (DATA === 'spot' && days.length >= MAX_DAYS) break
    lastScan = { stage: 'scan', day: plan[i].date, done: i, total: plan.length, scanned: days.length, skipped: skipped.length }
    progress(lastScan)
    // Two hard stops before each batch, both of which END the job with a result rather than going quiet: Dhan's
    // daily allowance running low, and the job's own time budget running out.
    if (overBudget()) stopped = budgetStop = budgetReason()
    if (stopped || (stopped = await dhanBudgetLeft())) {
      // (Spot + options lists spare weekdays for holidays: only as many as the days still wanted.)
      for (const rest of plan.slice(i, DATA === 'spot' ? i + Math.max(0, MAX_DAYS - days.length) : undefined)) skipped.push({ date: rest.date, reason: stopped, busy: true })
      state.skipped = skipped.length
      break
    }
    const batch = plan.slice(i, i + AT_ONCE)
    const done = await Promise.all(batch.map(async (p) => {
      try { return { p, day: await scanOne(p) } } catch (err) { return { p, err } }
    }))
    for (const { p, day, err } of done) {
      if (day) keepDay(day)
      else if (err.transient) busy.push({ p, err })
      else skipped.push({ date: p.date, reason: err.message })
    }
    state.skipped = skipped.length
  }
  // Days the server or Dhan was too busy for: tried again, in rounds, with a pause between them. Being busy is a
  // passing thing - a day is only given up on after several rounds, and then it says so plainly rather than showing
  // whatever the server said.
  const ROUNDS = Math.max(1, Math.min(10, Number(process.env.TUNE_BUSY_ROUNDS) || 3))
  state.stage = 'retry'
  // A round is only entered while there is budget left for it - and a day is only fetched again at all while its own
  // fetch ledger allows it (tuneFetch's maxPerDay), so the rounds cannot multiply one day's 42 option-series calls.
  for (let round = 1; busy.length && round <= ROUNDS && !overBudget(); round++) {
    const waitMs = Number(process.env.TUNE_BUSY_PAUSE_MS ?? 10_000 * round)
    lastScan = { stage: 'retry', day: busy[0].p.date, done: 0, total: busy.length, round, rounds: ROUNDS, waitUntil: new Date(Date.now() + waitMs).toISOString() }
    progress(lastScan)
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    const again = busy.splice(0, busy.length)
    for (let i = 0; i < again.length; i++) {
      const { p } = again[i]
      if (DATA === 'spot' && days.length >= MAX_DAYS) break
      lastScan = { stage: 'retry', day: p.date, done: i, total: again.length, round, rounds: ROUNDS, scanned: days.length, skipped: skipped.length }
      progress(lastScan)
      const out = stopped ?? (overBudget() ? (budgetStop = budgetReason()) : await dhanBudgetLeft())
      if (out) { stopped = out; skipped.push({ date: p.date, reason: out, busy: true }); state.skipped = skipped.length; continue }
      try { keepDay(await scanOne(p)) } catch (err) {
        if (err.transient && round < ROUNDS) busy.push({ p, err })
        else skipped.push({ date: p.date, reason: err.transient ? `the server stayed busy over ${ROUNDS} rounds - run the job again and the days already fetched come from the cache` : err.message, busy: !!err.transient })
      }
    }
  }
  // Nothing is ever left in limbo: a day still waiting for a retry round that the budget (or the round count) ended
  // is listed with its reason, so `days` + `skipped` always covers every day the job planned.
  for (const { p, err } of busy.splice(0, busy.length)) {
    skipped.push({ date: p.date, reason: budgetStop ?? stopped ?? `the server stayed busy over ${ROUNDS} rounds (${err?.message ?? 'busy'}) - run the job again and the days already fetched come from the cache`, busy: true })
  }
  state.skipped = skipped.length
  lastScan = null
  days.sort((a, b) => (a.date < b.date ? 1 : -1))
  // Spot + options counts the days that worked (holidays fail), and a batch can finish one or two past the number
  // asked for: the newest MAX_DAYS are kept.
  if (DATA === 'spot' && days.length > MAX_DAYS) days.length = MAX_DAYS
  skipped.sort((a, b) => (a.date < b.date ? 1 : -1))
  if (!days.length) throw new Error(budgetStop ? `no day was scanned before ${budgetStop}` : `none of the ${plan.length} day(s) could be scanned (${skipped[0]?.reason ?? 'unknown'})`)

  if (WHAT === 'lab') {
    // THE STRATEGY LAB: the days scanned exactly as for tuning, then one strategy measured three ways with the tuning's
    // own functions (evaluateSetting) - as written, as applied on this index now, and with the setting being tried.
    const id = Array.isArray(job.strategies) ? job.strategies[0] : null
    const meta = STRATEGY_BY_ID[id]
    if (!meta || meta.retired || (DATA === 'spot') !== !!meta.spot) throw new Error(`${id ?? 'no strategy'} is not an active ${DATA === 'spot' ? 'spot + options' : 'futures'} strategy`)
    state.stage = 'lab'
    progress({ stage: 'lab', done: 0, total: 1 })
    const opts = { trail, underlying: U, optionLevels }
    const applied = config?.filtersByIndex?.[U]?.[id] ?? null
    await dhanBudgetLeft().catch(() => null)
    write({
      ok: true, lab: true, underlying: U, job, startedUtc, finishedUtc: new Date().toISOString(), data: DATA, from: FROM, to: TO, rowSize, trail, optionLevels,
      strategy: { id, no: meta.no, name: meta.name },
      days: days.map((d) => ({ date: d.date, estimated: d.estimated, setups: d.setups.length, ...d.quality })), skipped,
      asWritten: evaluateSetting(days, id, {}, opts),
      // As applied: with the trailing stop it was applied with (pinnedTrailOf), when one was stored.
      applied: applied ? { ...evaluateSetting(days, id, paramsFromFilters(applied), pinnedTrailOf(applied) !== undefined ? { ...opts, trail: pinnedTrailOf(applied) } : opts), filters: applied } : null,
      yours: evaluateSetting(days, id, job.params ?? {}, opts),
      calls: callReport(fetcher.stats, fetcher.perKind(), fastOi, dhan),
      budget: { minutes: budgetMinutes, elapsedMinutes: Math.round((Date.now() - START_MS) / 60_000), stoppedBy: budgetStop ? 'budget' : stopped ? 'dhan-limit' : null, reason: budgetStop ?? stopped ?? null, daysPlanned: plan.length, daysScanned: days.length, daysLeftOut: skipped.length },
    })
    clearTimeout(watchdog)
    state.stage = 'done'
    progress({ stage: 'done', done: 1, total: 1 })
    return
  }

  progress({ stage: 'rank', done: days.length, total: days.length })
  const spotIds = SPOT_STRATEGIES.map((s) => s.id)
  const ranked = rankStrategies(days, { trail, minTrades: MIN_TRADES, ids: DATA === 'spot' ? spotIds : ACTIVE_STRATEGIES.map((s) => s.id) }).map((r) => ({ ...r, name: STRATEGY_BY_ID[r.id]?.name, no: STRATEGY_BY_ID[r.id]?.no }))
  const pick = job.strategies
  const ids = WHAT === 'check' ? [] : Array.isArray(pick) ? pick.filter((id) => STRATEGY_BY_ID[id] && !STRATEGY_BY_ID[id].retired && (DATA === 'spot') === !!STRATEGY_BY_ID[id].spot)
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
  state.stage = 'tune'
  let tuneStop = null
  for (let i = 0; i < ids.length; i++) {
    // Every combination of one strategy's filters is this process's own CPU and can run for minutes: no NEW strategy
    // is started past the budget. The ones already measured are kept and written - a partial result, said plainly.
    if (overBudget()) {
      tuneStop = `the job's own time budget of ${budgetText} ran out after ${i} of ${ids.length} strategy(s) were fine-tuned - the rest were not started`
      budgetStop ??= tuneStop
      break
    }
    progress({ stage: 'tune', strategy: ids[i], done: i, total: ids.length })
    try {
      results.push(tuneStrategy(days, ids[i], {
        trail, minTrades: MIN_TRADES, what: WHAT, oiKeys: OI_KEYS, search: SEARCH, underlying: U,
        // One strategy's own fine-tuning is this process's own CPU - tens of thousands of combinations, which no
        // timer can interrupt. It reports every 250 of them, so that is where the budget is checked: past it this
        // strategy is given up on from inside, and the strategies already measured are still written.
        onProgress: (p) => {
          if (overBudget()) throw Object.assign(new Error('over the job budget'), { overBudget: true })
          progress({ stage: 'tune', strategy: ids[i], done: i, total: ids.length, ...p })
        },
      }))
    } catch (err) {
      if (!err.overBudget) throw err
      tuneStop = `the job's own time budget of ${budgetText} ran out while fine-tuning ${STRATEGY_BY_ID[ids[i]]?.name ?? ids[i]} (${i} of ${ids.length} strategy(s) finished) - that one and the rest were left`
      budgetStop ??= tuneStop
      break
    }
    state.tuned = results.length
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
  // THE CROSS-CHECK (tuneChecks.mjs): every setting found so far for this index - this run's own and every earlier
  // run's - measured on this run's days it was not chosen on, so settings tuned on different months are compared on
  // days none of them was fitted to. Cheap: the days are already scanned; it only re-applies each setting's filters.
  // Past the time budget it stops and keeps what it checked.
  state.stage = 'check'
  progress({ stage: 'check', done: 0, total: 1 })
  // (Spot + options too: its settings now trade live on the server scanner, so they need the same record on unseen days.)
  const candidates = mergeCandidates(candidatesFrom(HISTORY_DIR, { underlying: U, data: DATA }), candidatesOfResults(results))
  const checks = crossCheck(days, candidates, trail, { stop: overBudget })
  const checkSummary = { settings: candidates.length, rows: checks.length, fromEarlierRuns: candidates.filter((c) => c.runs.some((r) => r !== 'this run')).length }
  // The last reading of the server's Dhan counter, so the report's own before/after covers the whole job.
  await dhanBudgetLeft().catch(() => null)
  const calls = callReport(fetcher.stats, fetcher.perKind(), fastOi, dhan)
  const budget = {
    minutes: budgetMinutes, elapsedMinutes: Math.round((Date.now() - START_MS) / 60_000),
    stoppedBy: budgetStop ? 'budget' : stopped ? 'dhan-limit' : null, reason: budgetStop ?? stopped ?? null,
    daysPlanned: plan.length, daysScanned: days.length, daysLeftOut: skipped.length,
    strategiesTuned: results.length, strategiesAsked: ids.length, tuningStopped: tuneStop,
  }
  let runId = null
  if (HISTORY_DIR) {
    // The same split tuneStrategy makes: the newest days are the test (held back), the rest the train.
    const testDays = new Set(splitDays(days).test.map((d) => d.date))
    const h = historyOf({
      underlying: U, data: DATA, finishedMs: Date.now(), what: WHAT, search: SEARCH, minTrades: MIN_TRADES, from: FROM, to: TO,
      days: days.map((d) => ({ date: d.date, estimated: d.estimated, role: testDays.has(d.date) ? 'test' : 'train' })), skipped, results, trades, fetched: fetcher.stats,
      calls, budget, checks,
    })
    mkdirSync(HISTORY_DIR, { recursive: true })
    writeJson(join(HISTORY_DIR, `${h.run_id}-checks.csv`), null, toCsv(CHECK_COLUMNS, h.checks))
    writeJson(join(HISTORY_DIR, `${h.run_id}-trades.csv`), null, toCsv(TRADE_COLUMNS, h.trades))
    writeJson(join(HISTORY_DIR, `${h.run_id}-settings.csv`), null, toCsv(SETTING_COLUMNS, h.settings))
    writeJson(join(HISTORY_DIR, `${h.run_id}-days.csv`), null, toCsv(DAY_COLUMNS, h.days))
    // runs.csv: the header once, then a line per run (appended - an older run's own values are never rewritten).
    // When a column has been ADDED since the file was written, the file is rebuilt with the new header and the old
    // rows keep what they have - otherwise the new row would have more fields than the header and be dropped.
    const runsPath = join(HISTORY_DIR, 'runs.csv')
    const next = runsCsvWith(existsSync(runsPath) ? readFileSync(runsPath, 'utf8') : null, RUN_COLUMNS, h.run)
    if (next.append) appendFileSync(runsPath, next.append)
    else writeJson(runsPath, null, next.text)
    runId = h.run_id
    console.log(`HISTORY ${h.run_id} (${h.trades.length} trades, ${h.settings.length} settings)`)
  }
  write({
    // runId: the history run this result belongs to - so deleting the run (Strategy tuning page) removes this too.
    ok: true, runId, underlying: U, job, startedUtc, finishedUtc: new Date().toISOString(), rowSize, trail, minTrades: MIN_TRADES, what: WHAT, search: SEARCH, data: DATA, from: FROM, to: TO, oiFactors: OI_KEYS ?? OI_FACTORS.map((f) => f.key),
    grid: WHAT === 'check' ? null : WHAT === 'trade' ? TUNING_GRID : WHAT === 'oi' ? oiGridOf(OI_KEYS) : WHAT === 'option' ? OPTION_GRID : WHAT === 'all' ? { ...oiGridOf(OI_KEYS), ...TUNING_GRID, ...OPTION_GRID } : { ...oiGridOf(OI_KEYS), ...TUNING_GRID },
    days: days.map((d) => ({ date: d.date, estimated: d.estimated, setups: d.setups.length, ...d.quality })), skipped, ranked, results, checks: checkSummary, fetched: fetcher.stats, fastOi,
    strategies: ACTIVE_STRATEGIES.length, calls, budget,
  })
  clearTimeout(watchdog)
  state.stage = 'done'
  progress({ stage: 'done', done: results.length, total: ids.length, budget })
}

main().catch((err) => {
  console.error(err.stack ?? err.message)
  clearTimeout(watchdog)
  // A failure writes a result too, with the stage it failed in and what it had got through - never a silent exit.
  write({
    ok: false, underlying: U, job, startedUtc, finishedUtc: new Date().toISOString(), error: err.message,
    budget: { minutes: budgetMinutes, elapsedMinutes: Math.round((Date.now() - START_MS) / 60_000), stoppedBy: budgetStop ? 'budget' : 'error', reason: budgetStop, ...state },
    calls: callReport(fetcher.stats, fetcher.perKind(), { windowCalls: 0, fallbackCalls: 0, seeded: 0, fromWindows: 0, fromFallback: 0 }, { first: null, last: null, background: null, backgroundFirst: null, dailyLimit: null }),
  })
  process.exit(1)
})
