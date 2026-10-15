// The server scanner's changes, pushed to the open page the moment they happen (ScannerEvents.cs on the server, over the
// SpotHub connection) - so its paper and live trades, their exits and P&L show at once, not at the next poll:
//  - scannerStatus: what the runner just reported (GET /api/scanner-runner/status's shape) - sent at once on a signal,
//    a trade opened or exited, and every 5 s with the P&L (premium now);
//  - scannerRecord: a day of the scanner's record was saved ({ source: 'server' | page, underlying, date });
//  - scannerLive: a server scanner live trade, or an index's Live today, changed (admins only).
// One connection for the page, opened while a view listens and closed a little after the last one goes. Each view keeps
// a slower poll as the fallback (a page whose connection dropped is told { resync: true } once it is back).
import { useEffect, useRef, useState } from 'react'
import * as signalR from '@microsoft/signalr'
import { RECONNECT_RETRY_POLICY, joinAllSignalRGroups } from './shared.jsx'

const GROUPS = ['scanner', 'scanner-live']
const EVENTS = ['scannerStatus', 'scannerRecord', 'scannerLive']
const STATUS_POLL_MS = 15_000
const listeners = new Map(EVENTS.map((e) => [e, new Set()]))
let connection = null
let users = 0
let stopTimer = null

function tell(name, payload) {
  for (const fn of listeners.get(name)) {
    try { fn(payload) } catch (err) { console.error(`${name} handler failed:`, err) }
  }
}

function start() {
  clearTimeout(stopTimer)
  if (connection) return
  const c = new signalR.HubConnectionBuilder().withUrl('/hubs/spot').withAutomaticReconnect(RECONNECT_RETRY_POLICY).build()
  connection = c
  for (const e of EVENTS) c.on(e, (payload) => tell(e, payload))
  // A new connection holds no groups, and what changed while it was away was not heard: join again, read afresh.
  c.onreconnected(() => {
    joinAllSignalRGroups(c, GROUPS)
    tell('scannerRecord', { resync: true })
    tell('scannerLive', { resync: true })
  })
  const connect = () => c.start()
    .then(() => joinAllSignalRGroups(c, GROUPS))
    .catch(() => { if (connection === c) setTimeout(connect, 10_000) })
  connect()
}

function stop() {
  const c = connection
  connection = null
  c?.stop().catch(() => {})
}

/** Listens for one of the scanner's events; returns the function that stops listening. */
export function onScannerEvent(name, fn) {
  listeners.get(name).add(fn)
  users += 1
  start()
  return () => {
    listeners.get(name).delete(fn)
    users -= 1
    if (users <= 0) { users = 0; clearTimeout(stopTimer); stopTimer = setTimeout(stop, 5_000) }
  }
}

/** `handler(payload)` on each `name` event while the component is on screen - only those `when(payload)` accepts, when
 *  given. `debounceMs`: several accepted in a row (each index saving its record) run it once, after the last. */
export function useScannerEvent(name, handler, debounceMs = 0, when = null) {
  const ref = useRef({ handler, when })
  useEffect(() => { ref.current = { handler, when } })
  useEffect(() => {
    let timer = null
    const off = onScannerEvent(name, (payload) => {
      if (ref.current.when && !ref.current.when(payload)) return
      if (!debounceMs) { ref.current.handler(payload); return }
      clearTimeout(timer)
      timer = setTimeout(() => ref.current.handler(payload), debounceMs)
    })
    return () => { clearTimeout(timer); off() }
  }, [name, debounceMs])
}

// ---- The runner's status, shared by every view on the page -------------------------------------------------------
let status = { data: null, error: null }
const statusViews = new Set()
let statusPoll = null
let offStatus = null
const setStatus = (next) => { status = next; for (const fn of statusViews) fn(next) }
const loadStatus = () => fetch('/api/scanner-runner/status')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
  .then((data) => setStatus({ data, error: null }))
  .catch((err) => setStatus({ data: status.data, error: err.message }))

/** The server scanner's status as it is now: pushed on each change (a trade opened / exited, the P&L every 5 s), read
 *  every 15 s besides. { status (GET /status's body), error, reload }. */
export function useScannerStatus() {
  const [s, setS] = useState(status)
  useEffect(() => {
    statusViews.add(setS)
    if (statusViews.size === 1) {
      loadStatus()
      statusPoll = setInterval(loadStatus, STATUS_POLL_MS)
      offStatus = onScannerEvent('scannerStatus', (data) => setStatus({ data, error: null }))
    }
    return () => {
      statusViews.delete(setS)
      if (!statusViews.size) { clearInterval(statusPoll); statusPoll = null; offStatus?.(); offStatus = null }
    }
  }, [])
  return { status: s.data, error: s.error, reload: loadStatus }
}

/** Today's SIGNAL as the runner last reported it - its points and R so far, and both options as they stand now
 *  (entry, premium now, points): what the record cannot hold while a signal is still running. Matched on the
 *  strategy and the minute it fired. Null when it is not one of today's. */
export function runnerSignal(statusBody, underlying, strategyId, timeIst, date = null) {
  const ix = statusBody?.status?.indices?.find((x) => x.underlying === underlying)
  if (!ix || (date && ix.date !== date) || !strategyId || !timeIst) return null
  const hhmm = String(timeIst).slice(11, 16)
  return ix.signals?.find((s) => s.id === strategyId && new Date(s.t).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) === hhmm) ?? null
}

/** Today's trade `key` on `underlying` as the runner last reported it (premium now, points, rupees, exit) - null when it
 *  is not one of today's. `date` (yyyy-mm-dd), when given, must be the runner's day. */
export function runnerTrade(statusBody, underlying, key, date = null) {
  const ix = statusBody?.status?.indices?.find((x) => x.underlying === underlying)
  if (!ix || (date && ix.date !== date)) return null
  return ix.trades?.find((t) => t.key === key) ?? null
}
