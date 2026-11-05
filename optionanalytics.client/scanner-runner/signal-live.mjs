// SAVED STRATEGIES SCANNED LIVE - started and kept running by the server (SignalLiveHostedService), in its own Node
// process with the runner's key. Each minute of the session (IST weekdays, 09:16 - 15:59), for every index with a saved
// strategy on Live: today's run as OI Replay's live mode reads it (the server's memory - its one backfill joined to the
// live feed), cut to the completed minutes and prepared as the Signal backtest prepares a past day; each strategy's day so
// far (signalLive.js - its own settings, the backtest's trades): its entries and exits go to the server, which keeps them
// (CSV) and sends the new ones to Telegram once (by key). From 15:31 the day's report: the closed trades and the numbers
// (CSV) and, if asked, Telegram - once. Paper only: it places nothing and changes no setting.
//
// Environment (from the server):
//   RUNNER_BASE_URL, RUNNER_KEY   this server and the key it accepts from local processes
//   LIVE_NOW, LIVE_ONCE           (tests only) a fixed clock (ISO) and one round, then exit

import { cleanBacktestSettings, engineSettings, prevProfileUrl } from '../src/signalBacktestJob.js'
import { LIVE_FROM_MINUTE, LIVE_UNTIL_MINUTE, REPORT_FROM_MINUTE, dayRecord, dayReportText, istClock, liveDayEvents, liveRunUrl, prepareLiveDay } from '../src/signalLive.js'

const BASE = (process.env.RUNNER_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '')
const KEY = process.env.RUNNER_KEY ?? ''
const FIXED_NOW = process.env.LIVE_NOW ? Date.parse(process.env.LIVE_NOW) : null
const ONCE = process.env.LIVE_ONCE === '1'
const MIN_MS = 60_000
const now = () => FIXED_NOW ?? Date.now()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method, headers: { 'X-Runner-Key': KEY, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  if (!res.ok) {
    let reason = text.slice(0, 200)
    try { reason = JSON.parse(text)?.error ?? reason } catch { /* not JSON */ }
    throw new Error(`${path.split('?')[0]}: ${reason || `HTTP ${res.status}`}`)
  }
  return text ? JSON.parse(text) : null
}

// An index whose day could not be read is asked again later, the wait doubling (1 min -> 30 min) - never a loop of a
// failing request (a holiday reads as one too).
const backoff = new Map()
function failed(u, why) {
  const delayMs = Math.min(30 * MIN_MS, (backoff.get(u)?.delayMs ?? MIN_MS / 2) * 2)
  backoff.set(u, { until: now() + delayMs, delayMs })
  console.log(`${u}: today not read (${why}) - again in ${Math.round(delayMs / MIN_MS)} min`)
}

// Yesterday's volume profile does not change during the day: asked once an index a day (a failure is asked again).
const prevProfiles = new Map()
async function prevProfile(u, date) {
  const key = `${u}|${date}`
  if (prevProfiles.has(key)) return prevProfiles.get(key)
  const body = await api(prevProfileUrl(u, date)).catch(() => undefined)
  if (body !== undefined) {
    for (const k of prevProfiles.keys()) if (!k.endsWith(`|${date}`)) prevProfiles.delete(k)
    prevProfiles.set(key, body)
  }
  return body ?? null
}

async function round(nowMs) {
  const ist = istClock(nowMs)
  if (ist.weekday === 0 || ist.weekday === 6 || ist.minute < LIVE_FROM_MINUTE || ist.minute > LIVE_UNTIL_MINUTE) return
  const cfg = await api('/api/signal-strategies/live')
  const date = cfg?.today ?? ist.date
  const list = (cfg?.strategies ?? []).map((s) => ({ ...s, clean: cleanBacktestSettings(s.settings) }))
  if (!list.length) return
  const complete = ist.minute >= REPORT_FROM_MINUTE
  const byIndex = new Map()
  for (const s of list) byIndex.set(s.clean.underlying, [...(byIndex.get(s.clean.underlying) ?? []), s])
  // Today's day of every index wanted - each strategy's own and, one trading in another (`tradeIn`), that one - read once.
  const wanted = new Set()
  for (const [u, strategies] of byIndex) {
    if (complete && strategies.every((s) => s.reported)) continue
    wanted.add(u)
    for (const s of strategies) if (s.clean.tradeIn) wanted.add(s.clean.tradeIn)
  }
  const days = new Map()
  for (const u of wanted) {
    if ((backoff.get(u)?.until ?? 0) > nowMs) continue
    try {
      const [run, prev] = await Promise.all([api(liveRunUrl(u, date)), prevProfile(u, date)])
      if (!run?.success) throw new Error(run?.error ?? 'no data for today')
      const day = prepareLiveDay(run, { underlying: u, prevProfile: prev, nowMs })
      backoff.delete(u)
      if (day.ok && day.date === date) days.set(u, day)
    } catch (err) {
      failed(u, err.message)
    }
  }
  for (const [u, strategies] of byIndex) {
    const day = days.get(u)
    if (!day || (complete && strategies.every((s) => s.reported))) continue
    for (const s of strategies) {
      // Trading in another index: its day too - not read this round, the strategy waits for the next.
      const tradeDay = s.clean.tradeIn ? days.get(s.clean.tradeIn) ?? null : null
      if (s.clean.tradeIn && !tradeDay) continue
      try {
        const result = liveDayEvents(day, engineSettings(s.clean), { name: s.name, complete, nowMs, tradeDay })
        const sent = new Set(s.sent ?? [])
        const fresh = result.events.filter((e) => !sent.has(e.key)).map(({ key, kind, text }) => ({ key, kind, text }))
        if (fresh.length) await api('/api/signal-strategies/live/events', { method: 'POST', body: { strategyId: s.id, date, events: fresh } })
        if (complete && !s.reported) {
          await api('/api/signal-strategies/live/day', { method: 'POST', body: { strategyId: s.id, date, ...dayRecord(day, result), text: dayReportText(s.name, day, result) } })
        }
      } catch (err) {
        console.error(`${s.name} (${u}): ${err.message}`)
      }
    }
  }
}

async function main() {
  console.log('Saved strategies live scan started.')
  for (;;) {
    try { await round(now()) } catch (err) { console.error(`round: ${err.message}`) }
    if (ONCE) return
    // Each minute, a few seconds after it completes (its bars settled on the server).
    await sleep(MIN_MS - (Date.now() % MIN_MS) + 5_000)
  }
}

main().catch((err) => {
  console.error(err.stack ?? err.message)
  process.exit(1)
})
