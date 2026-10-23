import { useEffect, useRef, useState } from 'react'
import * as signalR from '@microsoft/signalr'
import { buildOiContext } from './strategyEngine.js'
import { RECONNECT_RETRY_POLICY, joinAllSignalRGroups, onLiveBatch, syncSignalRGroups } from './shared.jsx'
import { applyFuturesTicks, applyOiTicks, applySpotUpdate, expiryFlagOf } from './liveFeeds.js'

// Live ticks are applied as they arrive; the context the page reads is republished at most this often
// (the strategies and the order flow read look at 15-minute and since-open OI, not single ticks).
const PUBLISH_MS = 2_000
// An empty day before the open (the server answered fine) is looked at again this often.
const BEFORE_OPEN_RETRY_MS = 120_000

/**
 * The day's options and futures OI (and option premiums) - the same data OI Replay loads - for the
 * Order Flow page: the order flow read, the strategy scanner and its option trades.
 *
 * A past day: one REST load. Today: one REST load for the day so far, then LIVE from Dhan's market-feed
 * websocket - the server's OiReplayLiveFeedService already streams every tracked strike's OI and
 * price ("oiReplayTicks"), the futures' price and OI ("futuresTicks") and the index ("spotUpdate")
 * over SignalR; they are folded into the day's minute series here. The REST load repeats only after
 * the SignalR connection drops and comes back (ticks may have been missed meanwhile) - never after a failed load.
 */
export function useDayOi(underlying, date, isReplay) {
  const [state, setState] = useState({ key: null, oi: null, error: null })
  const requestKey = `${underlying}:${date}:${isReplay ? 'replay' : 'live'}`
  const ctxRef = useRef(null)
  const publishRef = useRef(null)
  const liveRef = useRef({ underlying, flag: expiryFlagOf(underlying), live: !isReplay, key: requestKey })
  const [reloadNonce, setReloadNonce] = useState(0)
  // The last load of the day failed (the server or Dhan said no) - not asked again on its own, not even on a reconnect.
  const failedRef = useRef(false)

  useEffect(() => {
    liveRef.current = { underlying, flag: expiryFlagOf(underlying), live: !isReplay, key: requestKey }
  }, [underlying, isReplay, requestKey])

  // The day so far (REST). A FAILED load (the server or a Dhan call said no) is NOT asked again on its own - no loop of
  // a failing request (Dhan support flagged them): the error stays on screen until the index / day changes, the page
  // reloads, or the connection comes back after a load that had worked. Only an empty day before the open (the server
  // answered fine, the session has not started) is looked at again, every 2 minutes. The last good OI stays on screen.
  useEffect(() => {
    if (!date) return undefined
    let cancelled = false
    let retryTimer = null
    const key = requestKey
    const flag = expiryFlagOf(underlying)
    const params = new URLSearchParams({ date, timeframeMinutes: '1', expiryFlag: flag, ...(isReplay ? {} : { forceLive: 'true' }) })
    const fail = (error, { beforeOpen = false } = {}) => {
      failedRef.current = true
      setState((prev) => ({ key, oi: prev.key === key ? prev.oi : null, error }))
      if (isReplay || !beforeOpen) return
      retryTimer = setTimeout(load, BEFORE_OPEN_RETRY_MS)
    }
    const load = () => Promise.all([
      fetch(`/api/oi-replay/${underlying}/run?${params}`).then((r) => r.json()),
      fetch(`/api/oi-replay/${underlying}/expiries`).then((r) => r.json()).catch(() => null),
    ])
      .then(([body, expiries]) => {
        if (cancelled) return
        if (!body?.success || !(body.spotCandlesOneMinute ?? body.spotCandles ?? []).length) {
          if (body?.success) fail('no index data yet (before the open?)', { beforeOpen: true })
          else fail(body?.error ?? 'OI data unavailable')
          return
        }
        const expiryDate = underlying === 'BANKNIFTY' ? expiries?.month ?? null : expiries?.week ?? null
        // A replayed day reads each minute once it is over; live, the current minute is the latest tick.
        ctxRef.current = buildOiContext(body, expiryDate, { live: !isReplay })
        failedRef.current = false
        setState({ key, oi: ctxRef.current, error: null })
      })
      .catch((err) => { if (!cancelled) fail(err.message) })
    failedRef.current = false
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
        if (live && applyOiTicks(ctxRef.current, ticks, u, flag)) schedule()
      },
      futuresTicks: (ticks) => {
        const { underlying: u, live } = liveRef.current
        if (live && applyFuturesTicks(ctxRef.current, ticks, u)) schedule()
      },
      spotUpdate: (snapshot) => {
        const { underlying: u, live } = liveRef.current
        if (live && applySpotUpdate(ctxRef.current, snapshot, u)) schedule()
      },
    })
    connection.onreconnected(() => {
      joinAllSignalRGroups(connection, groupsRef.current)
      // Ticks may have been missed while disconnected - reload the day so far once (not after a load that failed:
      // that is not asked again on its own).
      if (liveRef.current.live && !failedRef.current) setReloadNonce((n) => n + 1)
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
