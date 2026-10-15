// The server-side strategy scanner: runs the Order Flow page's scanner for NIFTY, BANKNIFTY and SENSEX at
// once, with no browser - started and restarted by the server (ScannerRunnerHostedService), which passes:
//   RUNNER_BASE_URL  this server, e.g. http://127.0.0.1:8080
//   RUNNER_KEY       the key it accepts from this process only (X-Runner-Key, loopback only)
//   RUNNER_DATA_DIR  where the day's state is kept across restarts
// PAPER ONLY: alerts, paper trades and their exits go to Telegram tagged [Server]; the record goes to the
// scanner log's server-signals.csv / server-trades.csv. Its role cannot reach the live-trading API.

import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fetchPreviousSession } from '../src/profiles.js'
import { IndexScanner, istDate, topFromSignalsCsv, FINISH_BACK_DAYS } from './indexScanner.mjs'

const require = createRequire(import.meta.url)
const signalR = require('@microsoft/signalr')

const BASE = (process.env.RUNNER_BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '')
const KEY = process.env.RUNNER_KEY ?? ''
const DATA = process.env.RUNNER_DATA_DIR ?? join(process.cwd(), 'scanner-runner-data')
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX']
const LOOP_MS = 2_000
const STATUS_MS = 5_000
const CONFIG_MS = 60_000
const TOP_MS = 30 * 60_000
const startedUtc = new Date().toISOString()
mkdirSync(DATA, { recursive: true })

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`)

// Every relative /api call (ours and the shared modules' own, e.g. fetchPreviousSession) goes to this server
// with the runner's key.
const nativeFetch = globalThis.fetch
globalThis.fetch = (url, options = {}) => nativeFetch(String(url).startsWith('/') ? `${BASE}${url}` : url, { ...options, headers: { ...(options.headers ?? {}), 'X-Runner-Key': KEY } })

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  if (!res.ok) {
    let reason = text.slice(0, 200)
    try { const j = JSON.parse(text); reason = j?.error ?? j?.message ?? reason } catch { /* not JSON */ }
    throw new Error(`${path.split('?')[0]}: ${reason || `HTTP ${res.status}`}`)
  }
  try { return text ? JSON.parse(text) : null } catch { return text }
}

const statePath = (u, date) => join(DATA, `state-${u}-${date}.json`)
const io = {
  api,
  now: () => Date.now(),
  log,
  telegram: (text) => api('/api/alerts/telegram', { method: 'POST', body: { text } }).catch((err) => log(`telegram failed: ${err.message}`)),
  previousSession: (u, date, rowSize) => fetchPreviousSession(u, date, rowSize),
  loadState: async (u, date) => {
    try { return existsSync(statePath(u, date)) ? JSON.parse(readFileSync(statePath(u, date), 'utf8')) : null } catch { return null }
  },
  saveState: async (u, date, state) => {
    const path = statePath(u, date)
    writeFileSync(`${path}.tmp`, JSON.stringify(state))
    renameSync(`${path}.tmp`, path)
  },
}

const scanners = UNDERLYINGS.map((u) => new IndexScanner(u, io))

// Days the runner never finished - it was restarted overnight, or down at the close. Each one is finished now, on the
// backend: its signals judged and its trades closed on the day's minutes read back, and its final record posted. So a
// past day is never left showing "open". `force` (the trader pressed Reconcile) judges a day again even when it was
// marked finished - its signals may still be showing "open" because its minutes were missing at the time.
async function finishPastDays({ days = FINISH_BACK_DAYS, force = false } = {}) {
  const today = istDate(Date.now())
  const dates = new Map()
  const report = []
  let names = []
  try { names = readdirSync(DATA) } catch { return report }
  for (const name of names) {
    const m = /^state-([A-Z]+)-(\d{4}-\d{2}-\d{2})\.json$/.exec(name)
    if (!m || m[2] >= today) continue
    dates.set(m[1], [...(dates.get(m[1]) ?? []), m[2]])
  }
  for (const s of scanners) {
    for (const date of (dates.get(s.underlying) ?? []).sort().slice(-days)) {
      try {
        if (await s.finishDay(date, { force })) report.push(`${s.underlying} ${date}`)
      } catch (err) {
        log(`${s.underlying}: ${date} not finished - ${err.message}`)
        report.push(`${s.underlying} ${date}: ${err.message}`)
      }
    }
  }
  return report
}

// ---- Reconcile (the trader's button) -------------------------------------------------------------------
// POST /api/scanner-runner/reconcile puts an ask in the config; this process sees it on its next config read (within a
// minute). It judges every past day it left open again - and today too once its session is over - and posts each
// day's record again, then says in its status what it did. The ask standing when this process started needs nothing:
// finishPastDays already runs at startup.
let reconcileAsk = null
let reconcileDone = null
let reconcileReport = null
async function runReconcile(ask) {
  const startedUtc = new Date().toISOString()
  log(`reconcile asked (${ask.days ?? FINISH_BACK_DAYS} day(s) back) - judging the days left open again`)
  reconcileReport = { nonce: ask.nonce, askedUtc: ask.askedUtc ?? null, startedUtc, state: 'running', days: [] }
  const days = []
  try {
    days.push(...await finishPastDays({ days: Math.max(1, Math.min(60, Number(ask.days) || FINISH_BACK_DAYS)), force: true }))
    // Today as well, but only once its session is over - a signal still running today is open for a good reason.
    for (const s of scanners) {
      try { if (await s.finishIfDue({ force: true })) days.push(`${s.underlying} ${s.date} (today)`) } catch (err) { days.push(`${s.underlying} today: ${err.message}`) }
    }
    reconcileReport = { ...reconcileReport, state: 'done', doneUtc: new Date().toISOString(), days, message: days.length ? `${days.length} day(s) judged again` : 'nothing was left open' }
  } catch (err) {
    reconcileReport = { ...reconcileReport, state: 'failed', doneUtc: new Date().toISOString(), days, message: err.message }
  }
  log(`reconcile ${reconcileReport.state}: ${reconcileReport.message}`)
}

// ---- Config: the page's scanner settings (synced by an admin's Order Flow page) ---------------------
let top = null
let topAt = 0
async function refreshConfig() {
  try {
    const config = await api('/api/scanner-runner/config')
    if (!Array.isArray(config?.alertIds) && Date.now() - topAt > TOP_MS) {
      const [page, own] = await Promise.all(['/api/scanner-log/signals', '/api/scanner-log/server-signals'].map((p) => api(p).catch(() => null)))
      if (page != null || own != null) { top = topFromSignalsCsv([page, own]); topAt = Date.now() }
    }
    for (const s of scanners) s.setConfig({ ...config, top })
    reconcileAsk = config?.reconcile ?? null
  } catch (err) {
    log(`config not read: ${err.message}`)
  }
}

// ---- Live data: the same SignalR pushes the page gets ------------------------------------------------
const connection = new signalR.HubConnectionBuilder()
  .withUrl(`${BASE}/hubs/spot`, { headers: { 'X-Runner-Key': KEY }, transport: signalR.HttpTransportType.WebSockets })
  .withAutomaticReconnect({ nextRetryDelayInMilliseconds: (ctx) => [0, 2000, 5000, 10000, 15000, 30000][Math.min(ctx.previousRetryCount, 5)] })
  .configureLogging(signalR.LogLevel.Warning)
  .build()
const route = { orderFlowLive: 'onOrderFlowLive', oiReplayTicks: 'onOiTicks', futuresTicks: 'onFuturesTicks', spotUpdate: 'onSpotUpdate' }
connection.on('liveBatch', (batch) => {
  for (const item of batch?.items ?? []) {
    const handler = route[item.e]
    if (!handler) continue
    for (const s of scanners) { try { s[handler](item.d) } catch (err) { log(`${s.underlying}: ${item.e} failed - ${err.message}`) } }
  }
  if (batch?.sequence != null) connection.send('AckLive', batch.sequence).catch(() => {})
})
const joinAll = () => Promise.all(scanners.flatMap((s) => s.groups()).map((g) => connection.invoke('JoinGroup', g).catch((err) => log(`join ${g} failed: ${err.message}`))))
connection.onreconnected(() => { log('live feed reconnected - reloading the day so far'); joinAll(); for (const s of scanners) s.invalidate() })
connection.onclose((err) => log(`live feed closed${err ? `: ${err.message}` : ''}`))

async function connect() {
  for (;;) {
    try {
      await connection.start()
      await joinAll()
      log('live feed connected')
      return
    } catch (err) {
      log(`live feed not connected (${err.message}) - retrying in 10 s`)
      await new Promise((r) => setTimeout(r, 10_000))
    }
  }
}

// ---- The loop ------------------------------------------------------------------------------------------
let lastStatus = 0
let lastStatusSig = ''
let lastConfig = 0
// Started by the server: if the server goes away (this process re-parented), stop - the next server starts
// its own runner, with a new key this one could not use anyway.
const parentPid = process.ppid
async function loop() {
  if (process.ppid !== parentPid) { log('the server has gone - stopping'); process.exit(0) }
  const now = Date.now()
  if (now - lastConfig > CONFIG_MS) { lastConfig = now; await refreshConfig() }
  // A reconcile the trader asked for: done once, before the day's work, whatever happens.
  if (reconcileAsk?.nonce != null && reconcileAsk.nonce !== reconcileDone) {
    const ask = reconcileAsk
    reconcileDone = ask.nonce
    await runReconcile(ask)
  }
  const today = istDate(now)
  for (const s of scanners) {
    if (!s.enabled) continue
    try {
      await s.ensureDay(today)
      await s.evaluate()
      // Once the session is over, the day is finished (once): nothing is left open overnight.
      await s.finishIfDue()
    } catch (err) {
      s.error = err.message
      log(`${s.underlying}: ${err.stack ?? err.message}`)
    }
  }
  // Every STATUS_MS with the P&L - and at once when a signal fired or a trade opened / exited, so the pages show it as it
  // happens (the server passes it on to them - ScannerEvents).
  const statusSig = scanners.map((s) => s.changeSig()).join('\n')
  if (now - lastStatus > STATUS_MS || statusSig !== lastStatusSig) {
    lastStatus = now
    lastStatusSig = statusSig
    api('/api/scanner-runner/status', { method: 'POST', body: { startedUtc, reportedUtc: new Date().toISOString(), connection: connection.state, reconcile: reconcileReport, indices: scanners.map((s) => s.status()) } })
      .catch((err) => log(`status not posted: ${err.message}`))
  }
}

process.on('unhandledRejection', (err) => log(`unhandled: ${err?.stack ?? err}`))
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { connection.stop().finally(() => process.exit(0)) })

log(`scanner runner starting - ${UNDERLYINGS.join(', ')}, paper only, server ${BASE}`)
await refreshConfig()
lastConfig = Date.now()
await finishPastDays()
// The ask already standing is covered by the sweep above - only a NEW one makes this process reconcile again.
reconcileDone = reconcileAsk?.nonce ?? null
connect()
for (;;) {
  await loop()
  await new Promise((r) => setTimeout(r, LOOP_MS))
}
