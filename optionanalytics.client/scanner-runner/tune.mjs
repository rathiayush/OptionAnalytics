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
// Progress goes to stdout as lines "PROGRESS {json}".

import { writeFileSync, renameSync } from 'node:fs'
import { buildOiContext, ACTIVE_STRATEGIES, STRATEGY_BY_ID, TRADE_FILTERS } from '../src/strategyEngine.js'
import { autoBigLots } from '../src/orderFlowMath.js'
import { scannerProfileOf, trailFor } from '../src/scannerCore.js'
import { fetchPreviousSession } from '../src/profiles.js'
import { expiryFlagOf } from '../src/liveFeeds.js'
import { dayFromOrderFlow, scanDaySetups } from '../src/scanDay.js'
import { OI_GRID, rankStrategies, tuneStrategy, tuningDay, TUNING_GRID } from '../src/strategyTuning.js'
import { DEFAULT_ROW_SIZES } from './indexScanner.mjs'

const BASE = (process.env.RUNNER_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '')
const KEY = process.env.RUNNER_KEY ?? ''
const OUT = process.env.TUNE_OUT ?? 'tuning-result.json'
const job = JSON.parse(process.env.TUNE_JOB ?? '{}')
const U = String(job.underlying ?? 'NIFTY').toUpperCase()
const MAX_DAYS = Math.max(1, Math.min(250, Number(job.days) || 30))
const MIN_TRADES = Math.max(2, Math.min(100, Number(job.minTrades) || 8))
const WHAT = ['trade', 'oi', 'both'].includes(job.what) ? job.what : 'trade'
const startedUtc = new Date().toISOString()

const nativeFetch = globalThis.fetch
globalThis.fetch = (url, options = {}) => nativeFetch(String(url).startsWith('/') ? `${BASE}${url}` : url, { ...options, headers: { ...(options.headers ?? {}), 'X-Runner-Key': KEY } })
async function api(path) {
  const res = await fetch(path)
  const text = await res.text()
  if (!res.ok) {
    let reason = text.slice(0, 200)
    try { reason = JSON.parse(text)?.error ?? reason } catch { /* not JSON */ }
    throw new Error(`${path.split('?')[0]}: ${reason || `HTTP ${res.status}`}`)
  }
  return text ? JSON.parse(text) : null
}
const progress = (p) => console.log(`PROGRESS ${JSON.stringify(p)}`)
const write = (body) => {
  writeFileSync(`${OUT}.tmp`, JSON.stringify(body))
  renameSync(`${OUT}.tmp`, OUT)
}
const istToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())

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
  const config = await api('/api/scanner-runner/config').catch(() => ({}))
  const cfg = { ...(config?.settings ?? {}) }
  const rowSize = cfg.orderFlow?.rowSizes?.[U] ?? DEFAULT_ROW_SIZES[U] ?? 1
  const trail = trailFor(cfg, U)
  // The strategies' own entry filters as the trader set them; the trade filters are what is tuned (from their defaults).
  const tradeKeys = new Set(TRADE_FILTERS.map((f) => f.key))
  const entryFilters = Object.fromEntries(Object.entries(cfg.filters ?? {}).map(([id, f]) => [id, Object.fromEntries(Object.entries(f ?? {}).filter(([k]) => !tradeKeys.has(k)))]))

  // The days: the recorded (exact) ones, newest first; with includeEstimated, other weekdays too (rebuilt from 1-minute candles).
  const recorded = ((await api(`/api/order-flow/${U}/days`)) ?? []).filter((d) => !d.isLive && d.date < istToday)
  let plan = recorded.slice(0, MAX_DAYS).map((d) => ({ date: d.date, expiry: d.expiry ?? null, exact: true }))
  if (job.includeEstimated && plan.length < MAX_DAYS) {
    for (const date of pastWeekdays(MAX_DAYS * 2)) {
      if (plan.length >= MAX_DAYS) break
      if (!plan.some((p) => p.date === date)) plan.push({ date, expiry: null, exact: false })
    }
  }
  plan.sort((a, b) => (a.date < b.date ? 1 : -1))
  plan = plan.slice(0, MAX_DAYS)
  if (!plan.length) throw new Error(job.includeEstimated ? 'no past days could be listed' : 'no recorded past days on the server - include estimated days to tune on days rebuilt from 1-minute candles')

  const expiries = await api(`/api/oi-replay/${U}/expiries`).catch(() => null)
  const expiryDate = U === 'BANKNIFTY' ? expiries?.month ?? null : expiries?.week ?? null
  const days = []
  const skipped = []
  for (let i = 0; i < plan.length; i++) {
    const p = plan[i]
    progress({ stage: 'scan', day: p.date, done: i, total: plan.length })
    try {
      const expiryQuery = p.expiry ? `&expiry=${p.expiry}` : ''
      const body = await api(`/api/order-flow/${U}/day/${p.date}?rowSize=${rowSize}&minTradeLots=5&heatmapColumns=1500${expiryQuery}`)
      if (!body?.bars?.length) throw new Error('no bars')
      const day = dayFromOrderFlow(body, p.date, U)
      const estimated = day.source === 'estimated' || day.source === 'truedata'
      const lotSize = day.meta?.lotSize ?? 1
      const tape = estimated ? null : await api(`/api/order-flow/${U}/tape?date=${p.date}&count=60000${expiryQuery}`).catch(() => null)
      const prints = estimated ? null : tape?.prints ?? []
      const run = await api(`/api/oi-replay/${U}/run?${new URLSearchParams({ date: p.date, timeframeMinutes: '1', expiryFlag: expiryFlagOf(U) })}`)
      if (!run?.success) throw new Error(run?.error ?? 'no OI for the day')
      const oi = buildOiContext(run, expiryDate, { live: false })
      const prev = await fetchPreviousSession(U, p.date, rowSize).catch(() => null)
      const largeLots = cfg.orderFlow?.bigMode === 'auto' || cfg.orderFlow?.bigMode == null ? autoBigLots(prints ?? [], lotSize) ?? 10 : cfg.orderFlow?.largeLots?.[U] ?? 10
      const setups = await scanDaySetups({ day, prints, oi, profile: scannerProfileOf(prev?.bars, U, rowSize), rowSize, lotSize, largeLots, estimated, filters: entryFilters, keepAll: true })
      days.push({ ...tuningDay(p.date, setups, day), estimated })
    } catch (err) {
      skipped.push({ date: p.date, reason: err.message })
    }
  }
  if (!days.length) throw new Error(`none of the ${plan.length} day(s) could be scanned (${skipped[0]?.reason ?? 'unknown'})`)

  progress({ stage: 'rank', done: days.length, total: days.length })
  const ranked = rankStrategies(days, { trail, minTrades: MIN_TRADES }).map((r) => ({ ...r, name: STRATEGY_BY_ID[r.id]?.name, no: STRATEGY_BY_ID[r.id]?.no }))
  const pick = job.strategies
  const ids = Array.isArray(pick) ? pick.filter((id) => STRATEGY_BY_ID[id] && !STRATEGY_BY_ID[id].retired)
    : pick === 'all' ? ranked.filter((r) => r.n > 0).map((r) => r.id)
      : ranked.filter((r) => r.n >= MIN_TRADES).slice(0, pick === 'top5' ? 5 : 3).map((r) => r.id)
  const results = []
  for (let i = 0; i < ids.length; i++) {
    progress({ stage: 'tune', strategy: ids[i], done: i, total: ids.length })
    results.push(tuneStrategy(days, ids[i], { trail, minTrades: MIN_TRADES, what: WHAT }))
  }
  write({
    ok: true, underlying: U, job, startedUtc, finishedUtc: new Date().toISOString(), rowSize, trail, minTrades: MIN_TRADES, what: WHAT,
    grid: WHAT === 'trade' ? TUNING_GRID : WHAT === 'oi' ? OI_GRID : { ...OI_GRID, ...TUNING_GRID },
    days: days.map((d) => ({ date: d.date, estimated: d.estimated, setups: d.setups.length })), skipped, ranked, results,
    strategies: ACTIVE_STRATEGIES.length,
  })
  progress({ stage: 'done', done: ids.length, total: ids.length })
}

main().catch((err) => {
  console.error(err.stack ?? err.message)
  write({ ok: false, underlying: U, job, startedUtc, finishedUtc: new Date().toISOString(), error: err.message })
  process.exit(1)
})
