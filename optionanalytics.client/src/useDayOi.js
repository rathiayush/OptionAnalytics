import { useEffect, useRef, useState } from 'react'
import * as signalR from '@microsoft/signalr'
import { buildOiContext } from './strategyEngine.js'
import { RECONNECT_RETRY_POLICY, joinAllSignalRGroups, onLiveBatch, syncSignalRGroups } from './shared.jsx'

const MIN = 60_000
// Live ticks are applied as they arrive; the context the page reads is republished at most this often
// (the strategies and the order flow read look at 15-minute and since-open OI, not single ticks).
const PUBLISH_MS = 2_000
const expiryFlagOf = (underlying) => (underlying === 'BANKNIFTY' ? 'MONTH' : 'WEEK')

/**
 * The day's options and futures OI (and option premiums) - the same data OI Replay loads - for the
 * Order Flow page: the order flow read, the strategy scanner and its option trades.
 *
 * A past day: one REST load. Today: one REST load for the day so far, then LIVE from Dhan's market-feed
 * websocket - the server's OiReplayLiveFeedService already streams every tracked strike's OI and
 * price ("oiReplayTicks"), the futures' price and OI ("futuresTicks") and the index ("spotUpdate")
 * over SignalR; they are folded into the day's minute series here. The REST load repeats only after
 * the SignalR connection drops and comes back (ticks may have been missed meanwhile).
 */
export function useDayOi(underlying, date, isReplay) {
  const [state, setState] = useState({ key: null, oi: null, error: null })
  const requestKey = `${underlying}:${date}:${isReplay ? 'replay' : 'live'}`
  const ctxRef = useRef(null)
  const publishRef = useRef(null)
  const liveRef = useRef({ underlying, flag: expiryFlagOf(underlying), live: !isReplay, key: requestKey })
  const [reloadNonce, setReloadNonce] = useState(0)

  useEffect(() => {
    liveRef.current = { underlying, flag: expiryFlagOf(underlying), live: !isReplay, key: requestKey }
  }, [underlying, isReplay, requestKey])

  // The day so far (REST). A failed or empty load (before 09:15, or a Dhan call that failed) is retried
  // after 15 s, 30 s, 60 s, then every 2 minutes until it loads - a retry, not a poll: once the day has
  // loaded, live OI comes from the websocket. The last good OI stays on screen meanwhile.
  useEffect(() => {
    if (!date) return undefined
    let cancelled = false
    let retryTimer = null
    let attempt = 0
    const key = requestKey
    const flag = expiryFlagOf(underlying)
    const params = new URLSearchParams({ date, timeframeMinutes: '1', expiryFlag: flag, ...(isReplay ? {} : { forceLive: 'true' }) })
    const fail = (error) => {
      setState((prev) => ({ key, oi: prev.key === key ? prev.oi : null, error }))
      if (isReplay) return // a past day does not change - Load day again to retry
      const delay = [15_000, 30_000, 60_000][attempt] ?? 120_000
      attempt += 1
      retryTimer = setTimeout(load, delay)
    }
    const load = () => Promise.all([
      fetch(`/api/oi-replay/${underlying}/run?${params}`).then((r) => r.json()),
      fetch(`/api/oi-replay/${underlying}/expiries`).then((r) => r.json()).catch(() => null),
    ])
      .then(([body, expiries]) => {
        if (cancelled) return
        if (!body?.success || !(body.spotCandlesOneMinute ?? body.spotCandles ?? []).length) {
          fail(body?.success ? 'no index data yet (before the open?)' : body?.error ?? 'OI data unavailable')
          return
        }
        const expiryDate = underlying === 'BANKNIFTY' ? expiries?.month ?? null : expiries?.week ?? null
        // A replayed day reads each minute once it is over; live, the current minute is the latest tick.
        ctxRef.current = buildOiContext(body, expiryDate, { live: !isReplay })
        setState({ key, oi: ctxRef.current, error: null })
      })
      .catch((err) => { if (!cancelled) fail(err.message) })
    load()
    return () => { cancelled = true; if (retryTimer) clearTimeout(retryTimer) }
  }, [underlying, date, isReplay, requestKey, reloadNonce])

  // Live: Dhan websocket ticks via SignalR, folded into the context's minute series.
  const connectionRef = useRef(null)
  const groupsRef = useRef([])
  useEffect(() => {
    const connection = new signalR.HubConnectionBuilder().withUrl('/hubs/spot').withAutomaticReconnect(RECONNECT_RETRY_POLICY).build()
    connectionRef.current = connection
    const schedule = () => {
      if (publishRef.current) return
      publishRef.current = setTimeout(() => {
        publishRef.current = null
        const ctx = ctxRef.current
        const { key } = liveRef.current
        if (ctx) setState((prev) => (prev.key === key ? { ...prev, oi: { ...ctx } } : prev))
      }, PUBLISH_MS)
    }
    onLiveBatch(connection, {
      oiReplayTicks: (ticks) => {
        const { underlying: u, flag, live } = liveRef.current
        const ctx = ctxRef.current
        if (!live || !ctx || !ticks?.length) return
        let changed = false
        for (const tick of ticks) {
          if (tick?.underlying !== u || tick?.expiryFlag !== flag) continue
          const map = tick.side === 'CE' ? ctx.ce : ctx.pe
          if (upsertMinute(map, Number(tick.strike), tick.time, { oi: tick.openInterest, price: tick.price, high: tick.high ?? tick.price, low: tick.low ?? tick.price })) changed = true
        }
        if (changed) schedule()
      },
      futuresTicks: (ticks) => {
        const { underlying: u, live } = liveRef.current
        const ctx = ctxRef.current
        if (!live || !ctx || !ticks?.length) return
        let changed = false
        for (const tick of ticks) {
          if (tick?.underlying !== u) continue
          if (upsertSeries(ctx.futures, tick.time, { close: tick.price, oi: tick.openInterest })) changed = true
        }
        if (changed) schedule()
      },
      spotUpdate: (snapshot) => {
        const { underlying: u, live } = liveRef.current
        const ctx = ctxRef.current
        if (!live || !ctx || snapshot?.underlying !== u || !snapshot?.currentBar) return
        if (upsertSeries(ctx.spot, snapshot.currentBar.time, { close: snapshot.currentBar.close })) schedule()
      },
    })
    connection.onreconnected(() => {
      joinAllSignalRGroups(connection, groupsRef.current)
      // Ticks may have been missed while disconnected - reload the day so far once.
      if (liveRef.current.live) setReloadNonce((n) => n + 1)
    })
    connection.start()
      .then(() => joinAllSignalRGroups(connection, groupsRef.current))
      .catch((err) => { if (err?.name !== 'AbortError') console.error('Order flow OI live connection failed:', err) })
    return () => {
      connectionRef.current = null
      if (publishRef.current) { clearTimeout(publishRef.current); publishRef.current = null }
      connection.stop()
    }
  }, [])

  // Only today's view joins the live groups.
  useEffect(() => {
    const flag = expiryFlagOf(underlying)
    const groups = !isReplay && underlying ? [`u:${underlying}`, `c:${underlying}:${flag}`] : []
    syncSignalRGroups(connectionRef.current, groupsRef.current, groups)
    groupsRef.current = groups
  }, [underlying, isReplay])

  const current = state.key === requestKey ? state : { oi: null, error: null }
  return { oi: current.oi, error: current.error }
}

// A tick into a strike's minute series (the REST run is one point per minute): updates the current
// minute's point, or starts the next minute. True when something changed.
function upsertMinute(map, strike, time, values) {
  if (!Number.isFinite(strike)) return false
  let series = map.get(strike)
  if (!series) { series = []; map.set(strike, series) }
  return upsertSeries(series, time, values)
}

function upsertSeries(series, time, values) {
  const ms = new Date(time).getTime()
  if (!Number.isFinite(ms)) return false
  const t = Math.floor(ms / MIN) * MIN
  const last = series[series.length - 1]
  const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v != null && Number.isFinite(v)))
  if (last && last.t === t) {
    // Within the minute the range widens; everything else is the newest reading.
    if (clean.high != null && last.high != null) clean.high = Math.max(last.high, clean.high)
    if (clean.low != null && last.low != null) clean.low = Math.min(last.low, clean.low)
    Object.assign(last, clean)
    return true
  }
  if (last && last.t > t) return false
  series.push({ t, ...clean })
  return true
}
