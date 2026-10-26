import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Drawer, Menu, Select, Space, Tag, Tooltip, Typography } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'
import { createSeriesMarkers, HistogramSeries, LineSeries, CrosshairMode, LineStyle, TickMarkType } from 'lightweight-charts'
import { createZoomableChart } from './chartZoom.js'
import * as signalR from '@microsoft/signalr'
import { reconcileCardOrder } from './cardOrder.js'

// Provided once, at the app root (App.jsx), after GET /api/auth/me resolves - {email, role} or
// null. NavBar (rendered independently from four different pages) reads this via useAuth() rather
// than each page threading it through as a prop.
export const AuthContext = createContext(null)

// Sent with a request a page's TIMER makes (not its first load, not a click): the server treats it as background work, so
// the Dhan calls it would cause are not sent outside market hours (IST weekdays 09:00 - 16:00 - MarketHours on the server).
export const POLL_HEADERS = { 'X-Poll': '1' }
export function useAuth() {
  return useContext(AuthContext)
}

// Path keys from NAV_ITEMS below that only an Admin account may see or use - Triggers arms real
// money, Contracts exposes the raw scrip-master/subscription diagnostic. Kept as one list so
// NavBar's own filtering and App.jsx's route guards can never drift apart on which paths these are.
export const ADMIN_ONLY_PATHS = ['/triggers', '/contracts', '/visitors']

// SignalR's own withAutomaticReconnect(), with no argument, only retries at [0, 2, 10, 30] seconds
// (~42s total) before giving up PERMANENTLY - the connection then sits closed until the page is
// reloaded, with no further automatic attempts ever. A live-market page open for a full trading day
// WILL eventually see a backend redeploy or a brief network/Dhan-feed blip longer than 42 seconds -
// it should keep trying forever with a capped backoff, not go silent until someone notices and
// refreshes. Every hub connection in this app (App.jsx's own useHub, oiShared.jsx's useOiLiveHub)
// passes this policy rather than the bare default.
export const RECONNECT_RETRY_POLICY = {
  nextRetryDelayInMilliseconds(retryContext) {
    const delays = [0, 2000, 5000, 10000, 15000, 30000]
    return delays[Math.min(retryContext.previousRetryCount, delays.length - 1)]
  },
}

// SpotHub used to broadcast every event to Clients.All - a client viewing just NIFTY Weekly still
// received (and had to filter out, client-side) every tick for every OTHER underlying/expiry/
// futures contract too, on top of CDV/confluence events for underlyings nobody had open. SpotHub.cs
// now scopes each broadcast to a SignalR Group instead (see its own doc comment for the two naming
// conventions - "u:{underlying}" and "c:{underlying}:{expiryFlag}"), so a client only ever receives
// what it explicitly joins. These two helpers are what every hub hook in this app (App.jsx's
// useHub, oiShared.jsx's useOiLiveHub, OiReplayPage.jsx's useOiReplayLiveFeed) calls to stay in
// sync with its own caller's current selection, so the join/leave/rejoin logic only has to be
// gotten right once rather than three times with three chances to drift apart.
//
// Silently no-ops if the connection isn't currently Connected - each hook's own onreconnected
// handler is what re-establishes group membership from scratch afterward (a dropped connection
// loses ALL of its own group membership server-side the instant it drops; there is nothing to
// "diff" against a stale prior list once that happens, only a fresh join of whatever groups are
// current right now).
export function syncSignalRGroups(connection, oldGroups, newGroups) {
  if (!connection || connection.state !== signalR.HubConnectionState.Connected) return
  for (const g of oldGroups) if (!newGroups.includes(g)) connection.invoke('LeaveGroup', g).catch(() => {})
  for (const g of newGroups) if (!oldGroups.includes(g)) connection.invoke('JoinGroup', g).catch((err) => console.error('Failed to join SignalR group', g, err))
}

// Every group in `groups`, unconditionally - used right after a fresh connect/reconnect, when the
// server-side connection is known to hold NO group membership at all yet, so there is nothing to
// diff against (unlike syncSignalRGroups, for a later selection change on an already-connected
// socket).
export function joinAllSignalRGroups(connection, groups) {
  for (const g of groups) connection.invoke('JoinGroup', g).catch((err) => console.error('Failed to join SignalR group', g, err))
}

// An open tab keeps running the JavaScript it was loaded with, while a deploy replaces the server
// underneath it - and live events are a contract between the two (an event renamed or reshaped on
// the server is simply never heard by an older page). The page then looks live but quietly stops
// updating whatever changed, e.g. the OI heatmap frozen at the minute of the deploy while spot still
// ticked. So: remember the server build this page started against (GET /api/version's
// buildTimeUtc), and the moment the server reports a different one, reload once to pick up the
// matching code. Checked every minute, when the tab becomes visible again, and on every live
// reconnect (a deploy restarts the server, so that's when a new build shows up first). Today's
// paper positions and the live-day cache survive a reload on their own.
const DEPLOY_CHECK_INTERVAL_MS = 60_000
const RELOADED_FOR_BUILD_KEY = 'optionanalytics.reloadedForBuild'
let pageBuild = null

export async function checkForNewDeploy() {
  try {
    const response = await fetch('/api/version', { cache: 'no-store' })
    const build = (await response.json())?.buildTimeUtc
    if (!build) return
    if (pageBuild == null) { pageBuild = build; return }
    if (build === pageBuild) return
    // At most one reload per new build, so an odd server can never put the page in a reload loop.
    try {
      if (sessionStorage.getItem(RELOADED_FOR_BUILD_KEY) === build) return
      sessionStorage.setItem(RELOADED_FOR_BUILD_KEY, build)
    } catch { /* storage unavailable - still reload once, this page instance won't try again */ }
    pageBuild = build
    window.location.reload()
  } catch {
    // Server restarting or unreachable - the next check will catch up.
  }
}

export function useReloadOnNewDeploy() {
  useEffect(() => {
    checkForNewDeploy()
    const id = setInterval(checkForNewDeploy, DEPLOY_CHECK_INTERVAL_MS)
    const onVisible = () => { if (!document.hidden) checkForNewDeploy() }
    document.addEventListener('visibilitychange', onVisible)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible) }
  }, [])
}

// Live state (spot, option legs, futures, CDV) arrives as one "liveBatch" per ~300ms, CONFLATED per
// browser on the server (see LiveBroadcastBatcher): each batch holds only the newest data, and the
// next one is sent only after this page acknowledges the previous. So a slow phone or a busy page
// skips straight to the latest picture instead of building up a queue of stale updates - the screen
// can't drift 10s/20s/a minute behind. The ack goes after the browser has painted, so the server is
// paced to what this device can actually show (a hidden tab stops acking and the server backs off
// to its ack timeout until the tab is visible again).
//
// onPainted(sentAtMs) runs at that same post-paint moment with the server's send time, which is
// what an honest "how far behind is the SCREEN" measure needs (receipt time alone misses slow
// rendering).
export function onLiveBatch(connection, handlers, onPainted) {
  const clock = createServerClock(connection)
  connection.on('liveBatch', (batch) => {
    clock.syncIfDue()
    for (const item of batch?.items ?? []) {
      try { handlers[item.e]?.(item.d) } catch (err) { console.error(`Live update "${item.e}" failed:`, err) }
    }
    if (batch?.sequence == null) return
    const afterPaint = () => {
      onPainted?.(new Date(batch.sentAtUtc).getTime(), clock.offsetMs())
      if (connection.state === signalR.HubConnectionState.Connected) connection.send('AckLive', batch.sequence).catch(() => {})
    }
    requestAnimationFrame(() => setTimeout(afterPaint, 0))
  })
}

// This device's clock minus the server's, estimated NTP-style from a ServerTime round trip: assume the
// reply was stamped halfway through, and trust the sample with the shortest round trip seen recently
// (a busy page or slow link only ever makes a round trip LONGER, never shorter). Null until the first
// sync lands. Re-synced every CLOCK_SYNC_INTERVAL_MS.
const CLOCK_SYNC_INTERVAL_MS = 30_000
const CLOCK_SAMPLE_MAX_AGE_MS = 5 * 60_000

function createServerClock(connection) {
  let best = null
  let lastAttempt = 0
  const sync = async () => {
    const t0 = Date.now()
    try {
      const serverTime = await connection.invoke('ServerTime')
      const t1 = Date.now()
      const sample = { rtt: t1 - t0, offset: t0 + (t1 - t0) / 2 - new Date(serverTime).getTime(), at: t1 }
      if (!best || sample.rtt <= best.rtt || t1 - best.at > CLOCK_SAMPLE_MAX_AGE_MS) best = sample
    } catch {
      // A server without ServerTime, or a dropped connection - the baseline measure still works.
    }
  }
  return {
    syncIfDue() {
      const now = Date.now()
      if (now - lastAttempt < CLOCK_SYNC_INTERVAL_MS) return
      lastAttempt = now
      if (connection.state === signalR.HubConnectionState.Connected) sync()
    },
    offsetMs: () => best?.offset ?? null,
  }
}

// How far behind the market this page is running, split into the two legs that can lag:
//  - delayMs: server -> this screen (network + rendering on this device), measured when a batch is
//    PAINTED. With the server clock offset known (createServerClock) it's the true delay; before the
//    first clock sync it falls back to the excess over the lowest lag seen recently (which cancels
//    clock skew but can't see a constant delay).
//  - sourceDelayMs: Dhan -> server (Dhan's own tick timestamp vs when the server received it), same
//    excess-over-baseline measure - tells "our side is slow" apart from "Dhan's feed is slow".
const FEED_LAG_WINDOW_MS = 5 * 60_000
export const FEED_LAG_WARN_MS = 2_000
export const FEED_LAG_BAD_MS = 5_000

// A reading older than this is dropped rather than shown - otherwise the last value before a feed
// went quiet (e.g. "Dhan's feed is 27.4s behind") stayed on screen indefinitely as if still current.
const FEED_LAG_SAMPLE_MAX_AGE_MS = 15_000

export function createFeedLagTracker() {
  return { windowStart: 0, windowMin: Infinity, prevWindowMin: Infinity, latest: null, peak: -Infinity, lastSampleAt: 0 }
}

export function recordFeedLag(tracker, receivedAt, sentMs) {
  if (!Number.isFinite(sentMs) || !Number.isFinite(receivedAt)) return
  const lag = receivedAt - sentMs
  if (receivedAt - tracker.windowStart > FEED_LAG_WINDOW_MS) {
    tracker.prevWindowMin = tracker.windowMin
    tracker.windowMin = Infinity
    tracker.windowStart = receivedAt
  }
  tracker.windowMin = Math.min(tracker.windowMin, lag)
  tracker.latest = lag
  tracker.peak = Math.max(tracker.peak, lag)
  tracker.lastSampleAt = Date.now()
}

// Worst excess lag since the previous summary, rounded to 0.1s so an unchanged reading doesn't
// re-render the page.
export function summarizeFeedLag(tracker) {
  if (tracker.latest == null || Date.now() - tracker.lastSampleAt > FEED_LAG_SAMPLE_MAX_AGE_MS) return null
  const baseline = Math.min(tracker.windowMin, tracker.prevWindowMin)
  const worst = Number.isFinite(tracker.peak) ? tracker.peak : tracker.latest
  tracker.peak = -Infinity
  return Math.round(Math.max(0, worst - baseline) / 100) * 100
}

export function useFeedLag(active) {
  const trackersRef = useRef({ link: createFeedLagTracker(), source: createFeedLagTracker(), absolute: { peak: -Infinity, latest: null, lastSampleAt: 0 } })
  const [lag, setLag] = useState({ delayMs: null, sourceDelayMs: null })
  useEffect(() => {
    if (!active) return
    const id = setInterval(() => {
      const trackers = trackersRef.current
      const relative = summarizeFeedLag(trackers.link)
      const absolute = trackers.absolute
      const fresh = Date.now() - absolute.lastSampleAt <= FEED_LAG_SAMPLE_MAX_AGE_MS
      const worst = !fresh ? null : Number.isFinite(absolute.peak) ? absolute.peak : absolute.latest
      absolute.peak = -Infinity
      const delayMs = worst != null ? Math.round(Math.max(0, worst) / 100) * 100 : relative
      const next = { delayMs, sourceDelayMs: summarizeFeedLag(trackers.source) }
      setLag((prev) => (prev.delayMs === next.delayMs && prev.sourceDelayMs === next.sourceDelayMs ? prev : next))
    }, 500)
    return () => clearInterval(id)
  }, [active])
  // A batch the server sent at sentAtMs has just been painted. clockOffsetMs: this device's clock
  // minus the server's, when known.
  const recordPainted = useCallback((sentAtMs, clockOffsetMs) => {
    const now = Date.now()
    const trackers = trackersRef.current
    recordFeedLag(trackers.link, now, sentAtMs)
    if (clockOffsetMs != null && Number.isFinite(sentAtMs)) {
      const lag = now - clockOffsetMs - sentAtMs
      trackers.absolute.latest = lag
      trackers.absolute.peak = Math.max(trackers.absolute.peak, lag)
      trackers.absolute.lastSampleAt = now
    }
  }, [])
  // Dhan stamped a tick at exchangeMs; the server received it at serverReceivedMs.
  const recordSource = useCallback((serverReceivedMs, exchangeMs) => {
    if (exchangeMs != null) recordFeedLag(trackersRef.current.source, serverReceivedMs, exchangeMs)
  }, [])
  return { ...lag, recordPainted, recordSource }
}

// Skips re-rendering a page section while it's scrolled off-screen, so a live update only pays for
// what's actually visible - on a phone that's one or two cards, not the whole page. The moment the
// section comes back into view (with a small margin, so it's already current by the time it's seen)
// it renders once with the newest data. `version` forces a re-render even while hidden, for changes
// that affect layout rather than data (card order, which sections are shown).
//
// display: contents keeps this wrapper out of the layout entirely, so the section's own root stays
// the flex item its `order` style (card drag-reordering) applies to; the observer watches that root.
const FrozenWhenHidden = memo(({ children }) => children, (prev, next) => next.frozen && prev.version === next.version)

// What a live chart's view is doing right before its data is replaced: FOLLOWING the newest data
// (then it should keep following it - the standard live-chart behaviour) or parked on a range the user
// scrolled/zoomed back to (then that exact range is restored). Needed because setData() resets the
// view: restoring the old time range unconditionally (what these charts used to do) pinned a live
// chart to the window it opened with, so new points kept landing off its right edge unseen.
export function captureChartView(chart, series) {
  if (!chart || !series) return null
  const timeScale = chart.timeScale()
  const lastIndex = series.data().length - 1
  const logical = timeScale.getVisibleLogicalRange()
  return { followsLive: !logical || lastIndex < 0 || logical.to >= lastIndex - 0.5, range: timeScale.getVisibleRange() }
}

export function restoreChartView(chart, view) {
  if (!chart || !view) return
  const timeScale = chart.timeScale()
  if (view.followsLive) timeScale.scrollToRealTime()
  else if (view.range) {
    try { timeScale.setVisibleRange(view.range) } catch { /* the range may no longer be covered - nothing to fight over */ }
  }
}

export function LiveSection({ version, children }) {
  const wrapperRef = useRef(null)
  const [onScreen, setOnScreen] = useState(true)
  useEffect(() => {
    const target = wrapperRef.current?.firstElementChild
    if (!target || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting), { rootMargin: '300px 0px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [])
  return (
    <div ref={wrapperRef} style={{ display: 'contents' }}>
      <FrozenWhenHidden frozen={!onScreen} version={version}>{children}</FrozenWhenHidden>
    </div>
  )
}

export function FeedLagTag({ delayMs }) {
  if (delayMs == null) return null
  return (
    <Tooltip title="How far behind the server's live data this screen is, measured when it's painted. Stays well under a second normally - the server only ever sends the newest data, never a backlog, so a slow moment can't pile up.">
      <Tag color={delayMs >= FEED_LAG_BAD_MS ? 'error' : delayMs >= FEED_LAG_WARN_MS ? 'warning' : 'default'}>
        Delay {(delayMs / 1000).toFixed(1)}s
      </Tag>
    </Tooltip>
  )
}

// Shown only when one leg is genuinely behind - says WHICH, since the fix is different for each.
export function FeedLagAlert({ delayMs, sourceDelayMs }) {
  if (sourceDelayMs != null && sourceDelayMs >= FEED_LAG_BAD_MS) {
    return <Alert type="warning" showIcon message={`Dhan's own feed is running ${(sourceDelayMs / 1000).toFixed(1)}s behind right now - the delay is upstream of this app (Dhan -> server), not this screen.`} />
  }
  if (delayMs != null && delayMs >= FEED_LAG_BAD_MS) {
    return <Alert type="warning" showIcon message={`This screen is ${(delayMs / 1000).toFixed(1)}s behind - the connection to the server is slow right now. It catches up to the latest data on its own as soon as the link recovers.`} />
  }
  return null
}

// Constants/components shared between App.jsx's DashboardPage and BacktestPage.jsx - kept in
// their own module (not exported from App.jsx) specifically to avoid a circular import: App.jsx
// imports BacktestPage for its route, so BacktestPage importing back from App.jsx creates a cycle
// that breaks under Vite's dev-time ESM evaluation order ("Cannot access 'X' before
// initialization"), even though a production build happens to paper over it.

export const UP_COLOR = '#26a69a'
export const DOWN_COLOR = '#ef5350'
export const CE_COLOR = '#3ddc84'
export const PE_COLOR = '#ff5c5c'
// The 5 EMA overlay's own line color on Backtrack/Expired Backtest's spot charts - distinct from
// every other color already in play there (CE/PE, UP/DOWN, the amber "Open" trade status).
export const EMA_COLOR = '#9254de'

// Standard EMA: seeded with a plain average of the first `period` closes, then the usual
// exponential recurrence. Returns one value per input bar, null before the seed window fills.
// Shared rather than duplicated per page - App.jsx's own EMA9/21 crossover overlay used this first;
// Backtrack/Expired Backtest's own "Show 5 EMA" chart toggle reuses it for the same visual line the
// 5 EMA strategies themselves reason about (see EmaCrossoverDetector.EmaSeries server-side - not
// byte-for-byte identical seeding, but the same standard EMA, close enough for a chart overlay).
export function computeEma(closes, period) {
  const result = new Array(closes.length).fill(null)
  if (closes.length < period) return result

  const k = 2 / (period + 1)
  let sum = 0
  for (let i = 0; i < period; i++) sum += closes[i]
  let prev = sum / period
  result[period - 1] = prev

  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k)
    result[i] = prev
  }
  return result
}

// A plain EMA line over a chart's own (already timeframe-bucketed) bars - used by both
// BacktestPage/ExpiredBacktestPage's own per-strategy indicator overlays (see each page's own
// indicatorDefs) to plot whichever EMA a strategy's own parameters currently specify.
export function emaLine(bars, period) {
  const values = computeEma(bars.map((b) => b.close), period)
  return bars.reduce((points, b, i) => {
    if (values[i] != null) points.push({ time: b.time, value: values[i] })
    return points
  }, [])
}

// Mirrors SrFlowSellStrategy's own rolling support/resistance channel exactly (see the backend's
// own doc comment on THE LEVEL): aggregates the NATIVE 1-minute spot history (oneMinuteBars, not
// the chart's own possibly-coarser timeframe) into srTimeframeMinutes buckets, drops a still-
// forming trailing one exactly like BacktestUtil.AggregateCandles does, then for each of the
// chart's own bars reads the rolling high (resistance) or low (support) over the last
// srLookbackBars such buckets that have fully closed strictly before that bar's own time - never
// the bucket still forming through it, so this never looks ahead of what the strategy itself could
// have known at the same moment.
export function srLevelLine(oneMinuteBars, chartBars, srTimeframeMinutes, srLookbackBars, which) {
  if (oneMinuteBars.length === 0 || chartBars.length === 0) return []

  const bucketSeconds = Math.max(1, srTimeframeMinutes) * 60
  const buckets = new Map()
  let latestCovered = 0
  for (const b of oneMinuteBars) {
    const t = Math.floor(b.time / bucketSeconds) * bucketSeconds
    const existing = buckets.get(t)
    if (!existing) buckets.set(t, { time: t, high: b.high, low: b.low })
    else { existing.high = Math.max(existing.high, b.high); existing.low = Math.min(existing.low, b.low) }
    if (b.time + 60 > latestCovered) latestCovered = b.time + 60
  }
  const srBars = Array.from(buckets.values()).sort((a, b) => a.time - b.time)
  if (srBars.length > 0 && srBars[srBars.length - 1].time + bucketSeconds > latestCovered) srBars.pop()

  const points = []
  let srIndex = -1
  for (const bar of chartBars) {
    while (srIndex + 1 < srBars.length && srBars[srIndex + 1].time + bucketSeconds <= bar.time) srIndex++
    if (srIndex + 1 < srLookbackBars) continue

    let value = which === 'high' ? -Infinity : Infinity
    for (let w = srIndex - srLookbackBars + 1; w <= srIndex; w++) {
      value = which === 'high' ? Math.max(value, srBars[w].high) : Math.min(value, srBars[w].low)
    }
    points.push({ time: bar.time, value })
  }
  return points
}

export const ALERT_KIND_LABEL = { Spot: 'Spot', AtmCe: 'ATM CE', AtmPe: 'ATM PE', Confluence: 'CONFLUENCE' }

// One list for every page, so a timeframe stored by one is always a valid choice on the others.
// Everything server-side stays at 1-minute resolution; coarser ones are aggregated from it.
export const TIMEFRAME_OPTIONS = [
  { value: 1, label: '1 min' },
  { value: 3, label: '3 min' },
  { value: 5, label: '5 min' },
  { value: 15, label: '15 min' },
]

// The underlying and the timeframe describe WHAT you are looking at rather than being a per-page
// setting, so picking either one should hold wherever you navigate next - and across a reload.
// Both live under these keys, and every page reads and writes the same two.
export const STORED_UNDERLYING = 'optionanalytics.underlying'
export const STORED_TIMEFRAME = 'optionanalytics.timeframe'
// One shared toggle for every page's VWAP checkbox, same as underlying/timeframe above - checking
// it on one page and finding it already checked on another is the expected behavior, not a bug.
// v2: VWAP is on by default now (it used to start off, and the first page visited saved that) - a new key so every
// viewer starts with it shown once; unticking it is still remembered.
export const STORED_SHOW_VWAP = 'optionanalytics.showVwap.v2'
// Same shape, for OI Replay's own previous-day volume profile (POC/VAH/VAL/HVN/LVN) overlay -
// shown on by default (the user's own original ask), with this the one way to hide it once it's
// in the way of something else on the chart.
export const STORED_SHOW_VOLUME_PROFILE = 'optionanalytics.showVolumeProfile'
function readStored(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? fallback : JSON.parse(raw)
  } catch {
    // Storage can throw outright (private browsing, blocked site data) - the app still works,
    // it just doesn't remember.
    return fallback
  }
}

export function usePersistedState(key, fallback) {
  const [value, setValue] = useState(() => readStored(key, fallback))

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Same as above - remembering is a convenience, never a requirement.
    }
  }, [key, value])

  return [value, setValue]
}

// Drag-to-reorder a fixed set of named cards, persisted per page (own storageKey) so a rearrangement
// survives a reload - no drag library needed for something this small, same reasoning
// DraggableFloatingPanel's own doc comment already gives for using plain native events instead of a
// dependency. `cardIds` is the CURRENT full set a page renders (order is unaware of each card's own
// layout/span - callers still own that, this only reorders which one comes first).
//
// Deliberately reconciles against a stale persisted order rather than trusting it outright: a page
// that later adds or removes a card must not end up silently dropping the new one (it would never
// render at all) or keeping a ghost id around forever from before a card was removed. A newly added
// card goes where the page puts it by default - after the card before it in `cardIds` - rather than at
// the very end, where it was easy to miss on a long page (reconcileCardOrder).
export function useCardOrder(storageKey, cardIds) {
  const [storedOrder, setStoredOrder] = usePersistedState(storageKey, cardIds)
  const dragIdRef = useRef(null)
  const [dragOverId, setDragOverId] = useState(null)

  const order = useMemo(
    () => reconcileCardOrder(storedOrder, cardIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [storedOrder, cardIds.join(',')],
  )

  const dragHandleProps = (id) => ({
    draggable: true,
    onDragStart: (e) => { dragIdRef.current = id; e.dataTransfer.effectAllowed = 'move' },
    onDragEnd: () => { dragIdRef.current = null; setDragOverId(null) },
  })

  // Placed on the whole CARD (not just its handle) - a drop can land anywhere over the card, not
  // only precisely on the small handle, which is both more forgiving and how every real drag-reorder
  // UI (a file manager, a kanban board) already behaves.
  const dropTargetProps = (id) => ({
    onDragOver: (e) => { if (dragIdRef.current && dragIdRef.current !== id) { e.preventDefault(); setDragOverId(id) } },
    onDragLeave: () => setDragOverId((prev) => (prev === id ? null : prev)),
    onDrop: (e) => {
      e.preventDefault()
      const sourceId = dragIdRef.current
      setDragOverId(null)
      if (!sourceId || sourceId === id) return
      const next = order.filter((x) => x !== sourceId)
      next.splice(next.indexOf(id), 0, sourceId)
      setStoredOrder(next)
    },
    // A light highlight on whichever card is currently the drop target - the only visual feedback
    // native HTML5 drag-and-drop doesn't already give you for free (the dragged element itself gets
    // the browser's own default drag ghost/cursor).
    style: dragOverId === id ? { outline: '2px dashed #4c9ffe', outlineOffset: 2, borderRadius: 8 } : undefined,
  })

  return { order, dragHandleProps, dropTargetProps }
}

// A small "⠿" grip, draggable to reorder its own card (see useCardOrder) - a dedicated handle
// rather than making the whole card/title draggable, so it never fights a title's own clickable
// controls (a Select, a Segmented toggle) for the same mousedown.
export function CardDragHandle(props) {
  return (
    <span
      {...props}
      title="Drag to reorder"
      style={{ cursor: 'grab', padding: '0 6px', color: '#9aa4b2', fontSize: 14, lineHeight: 1, userSelect: 'none' }}
    >
      ⠿
    </span>
  )
}

// Keeps a stored underlying only if the backend still offers it, otherwise falls back to the
// first one - so a stale or renamed symbol can't leave a page stuck on nothing.
export function pickUnderlying(list, current) {
  if (list?.some((u) => u.underlying === current)) return current
  return list?.[0]?.underlying ?? null
}

// Which expiry a PAGE is looking at. The app now tracks several expiries at once per underlying
// (NIFTY's nearest 3, BANKNIFTY's nearest 2 - see CdvHostedService), each with its own live state,
// so this is a per-page read: the page appends ?expiry= to its own requests and nothing about that
// choice reaches any other page, or any armed trigger. It used to POST a server-side switch that
// unsubscribed and rebuilt everything, which is why changing expiry used to blank all three pages
// for a minute or two.
//
// `expiries` is the TRACKED set, not every listed one - those are the expiries with live data
// behind them. `selectedExpiry` is what to display; `expiryParam` is what to put in a URL, and is
// null while the page is following the server's own selection (so the request stays identical to
// what it was before this existed).
export function useExpirySelector(underlying) {
  const [expiries, setExpiries] = useState([])
  const [defaultExpiry, setDefaultExpiry] = useState(null)
  const [pinned, setPinned] = useState(null)

  useEffect(() => {
    if (!underlying) return
    const cancelledRef = { cancelled: false }
    fetch(`/api/cdv/${underlying}/expiries`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelledRef.cancelled) return
        setExpiries(data?.expiries ?? [])
        setDefaultExpiry(data?.selected ?? null)
        // A pin from a previous underlying cannot survive the switch - the new underlying tracks a
        // different set of expiries entirely.
        setPinned((current) => ((data?.expiries ?? []).includes(current) ? current : null))
      })
      .catch((err) => console.error('Failed to load expiries:', err))
    return () => { cancelledRef.cancelled = true }
  }, [underlying])

  // Local only, and resolved so callers that refetch in a .then() keep working unchanged.
  const selectExpiry = (expiry) => {
    if (expiry !== undefined) setPinned(expiry ?? null)
    return Promise.resolve()
  }

  return {
    expiries,
    selectedExpiry: pinned ?? defaultExpiry,
    expiryParam: pinned,
    isManual: pinned !== null,
    loading: false,
    selectExpiry,
  }
}

// Appends ?expiry= to a request when the page has pinned one. Null/undefined leaves the URL
// untouched, so a page following the server's own selection sends exactly the request it always
// did.
export function withExpiry(url, expiry) {
  if (!expiry) return url
  return `${url}${url.includes('?') ? '&' : '?'}expiry=${encodeURIComponent(expiry)}`
}

// Sentinel antd Select value for "Auto (nearest)" - real expiries are ISO date strings, so this
// can never collide with one.
const AUTO_EXPIRY = '__auto__'

export function ExpirySelect({ expiries, value, isManual, loading, onChange, style }) {
  const options = [
    { value: AUTO_EXPIRY, label: 'Auto (nearest)' },
    ...(expiries ?? []).map((e) => ({ value: e, label: e })),
  ]
  return (
    <Select
      value={isManual ? value : AUTO_EXPIRY}
      loading={loading}
      onChange={(picked) => onChange(picked === AUTO_EXPIRY ? null : picked)}
      style={style ?? { width: 170 }}
      options={options}
    />
  )
}

export function fmtPrice(v) {
  return v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })
}

// Every plain-text timestamp on the page (alert feed entries, Backtrack's tables) renders in IST
// (India, fixed UTC+5:30 - the market this app is about) regardless of the viewer's own browser
// timezone, same reasoning as App.jsx's chart-axis IST formatters - just via Intl's timeZone
// option directly here, since there's no lightweight-charts day-bucketing to work around for
// plain text.
export function fmtIstDateTime(isoOrDate) {
  return new Date(isoOrDate).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
}

// The IST calendar day a UTC timestamp falls on, as 'YYYY-MM-DD'. Sortable and directly
// comparable to what antd's date pickers format to, which is what makes a date filter possible
// without pulling timezone maths into every page: 'en-CA' is the locale that renders a date in
// exactly that order. A signal at 20:00 UTC belongs to the NEXT IST day, so filtering on the raw
// UTC date would put it under the wrong session.
export function istDateKey(isoOrDate) {
  return new Date(isoOrDate).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

export function fmtIstTime(isoOrDate) {
  return new Date(isoOrDate).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true })
}

// A plain calendar date (a backend DateOnly, e.g. "2026-09-29") as "29 Sep 2026" - null passes
// through as null so a caller can fall back to its own placeholder rather than rendering "Invalid
// Date". Used to show the REAL resolved expiry date next to an otherwise-ambiguous "Weekly"/
// "Monthly" label (see OiReplayController.GetExpiries) - a date-only string has no time-of-day
// component to shift, so formatting it in IST is safe (never crosses a calendar boundary the way an
// actual UTC instant near midnight could).
export function fmtDateOnly(isoDate) {
  if (!isoDate) return null
  return new Date(isoDate).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric' })
}

// lightweight-charts styling/time-axis helpers, duplicated (not imported) from App.jsx's own
// private copies rather than having App.jsx import them from here - App.jsx's charting code is
// heavily tuned (cross-chart pan/zoom sync, EMA overlays, live-tick preservation of the visible
// range) and any of it is deliberately left untouched by pages that don't need that complexity.
// These are the small, stable, PURE pieces any simple read-only chart (StrikeDataPage's own) needs
// without the rest: lightweight-charts has no timezone support, so every timestamp fed to a chart
// is shifted forward by IST_OFFSET_SECONDS up front and then formatted AS IF it were UTC - which,
// because of the shift, is exactly its real IST wall-clock value. See App.jsx's own identical
// comment for the full reasoning; it is not repeated there to avoid the two drifting apart on
// wording while staying identical in behavior (the offset is fixed and will never change).
export const AXIS_COLOR = '#9aa4b2'
export const GRID_COLOR = '#ffffff14'
export const BORDER_COLOR = '#ffffff22'
export const RESET_MARKER_COLOR = '#ffd54f'

const IST_OFFSET_SECONDS = 5.5 * 3600

export function toChartTime(isoOrDate) {
  return Math.floor(new Date(isoOrDate).getTime() / 1000) + IST_OFFSET_SECONDS
}

// Inverse of toChartTime - a caller holding a chart-time value (e.g. a bar's own .time, already
// shifted for display) that needs to compare it against a REAL timestamp (an ISO string straight
// off the wire, never shifted) must convert back first - comparing the two directly, one shifted
// and one not, silently skews the comparison by a fixed 5.5 hours. Returns real UTC epoch seconds.
export function fromChartTime(chartTimeSeconds) {
  return chartTimeSeconds - IST_OFFSET_SECONDS
}

const IST_TIME_FORMAT = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'UTC' })
const IST_TIME_WITH_SECONDS_FORMAT = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, timeZone: 'UTC' })
const IST_TICK_DATE_FORMAT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })
// The time axis's own labels: short 24-hour IST ("09:30", "14:00") - the 12-hour "09:30 am" was so wide that a phone-width
// chart fitted one or two of them (and clipped the first), so the axis showed almost no time.
const IST_TICK_TIME_FORMAT = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' })

export function istTimeFormatter(time) {
  return IST_TIME_FORMAT.format(new Date(time * 1000))
}

// Only ever needed where a bucket size finer than a minute is possible (the OI change heatmap's own
// 30-second option) - istTimeFormatter alone would show the same hour:minute label for every such
// bucket, which is exactly the "same time repeated across many columns" bug that option was added to
// fix.
export function istTimeWithSecondsFormatter(time) {
  return IST_TIME_WITH_SECONDS_FORMAT.format(new Date(time * 1000))
}

export function istTickMarkFormatter(time, tickMarkType) {
  const date = new Date(time * 1000)
  return tickMarkType >= TickMarkType.Time ? IST_TICK_TIME_FORMAT.format(date) : IST_TICK_DATE_FORMAT.format(date)
}

export function toBar(c) {
  return { time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close }
}

// Chart times are already IST-shifted (see IST_OFFSET_SECONDS), so reading the shifted value AS
// UTC gives the IST calendar day directly - the chart-time counterpart to istDateKey above, which
// takes a plain ISO string instead.
function istDayKeyFromChartTime(chartTime) {
  return new Date(chartTime * 1000).toISOString().slice(0, 10)
}

// A "RESET" marker on the first bar of each new IST trading day, so a chart spanning several days
// reads as distinct sessions rather than one continuous, misleadingly smooth line/candle run
// straight through each overnight gap. The very first day in view gets no marker - there is no
// transition to see there, just the left edge of the loaded history.
export function dayResetMarkers(bars) {
  const markers = []
  let previousDay = null

  for (const bar of bars) {
    const day = istDayKeyFromChartTime(bar.time)
    if (previousDay !== null && day !== previousDay) {
      markers.push({ time: bar.time, position: 'aboveBar', color: RESET_MARKER_COLOR, shape: 'square', text: 'RESET' })
    }
    previousDay = day
  }
  return markers
}

// Last line of defense before handing data to lightweight-charts, which throws an UNCAUGHT error if
// two consecutive points share a time or aren't strictly ascending - duplicated (not imported) from
// App.jsx's own identical copy, same reasoning as every other duplicated helper in this file's own
// header comment. Sorts ascending; for a duplicate time, keeps the LAST occurrence.
function sanitizeSeries(points) {
  if (points.length === 0) return points
  const sorted = [...points].sort((a, b) => a.time - b.time)
  const result = []
  for (const p of sorted) {
    if (result.length > 0 && result[result.length - 1].time === p.time) {
      result[result.length - 1] = p
    } else {
      result.push(p)
    }
  }
  return result
}

// Raw {time: isoString, [valueKey]: number} points (the shape an ObvPoint/CandleWithVolume-derived
// series comes off the wire as) into lightweight-charts' own {time: epochSeconds, value} shape.
function toLinePoints(points, valueKey) {
  return points.map((p) => ({ time: toChartTime(p.time), value: p[valueKey] }))
}

// Recenters `chart`'s own current visible window on `isoTime`, preserving however wide/zoomed that
// window already is - what a "click a row, jump every chart to that moment" feature needs, WITHOUT
// changing zoom level out from under the user the way fitContent() or a fixed-width window would.
// lightweight-charts has no direct "scroll to this time" call (only scrollToPosition, which moves by
// a bar-index offset from the right edge - meaningless across charts with different bar counts/
// timeframes), so this reads the current {from, to} itself and shifts it by hand. A silent no-op if
// the chart has no data yet (getVisibleRange returns null) or the target falls outside what
// setVisibleRange will accept - "nothing to show there" is not worth surfacing as an error over a
// chart the user didn't necessarily mean to scroll (an OBV chart has no data before its own history
// started, for instance, even when the spot chart right next to it does).
export function scrollChartToTime(chart, isoTime) {
  if (!chart || !isoTime) return
  const range = chart.timeScale().getVisibleRange()
  if (!range) return
  const target = toChartTime(isoTime)
  const half = (range.to - range.from) / 2
  try { chart.timeScale().setVisibleRange({ from: target - half, to: target + half }) } catch { /* empty */ }
}

// One page's own group of charts that pan/zoom together - dragging or zooming any ONE of them pushes
// the same visible time range to every other chart in the SAME group. Deliberately NOT the global,
// module-level registry the Dashboard used to use (removed at the user's own report that it made the
// Dashboard hard to use - its charts remount/re-fit on every live tick and ATM strike roll, which
// kept re-broadcasting a stale chart's own auto-fit over whatever the user was actively looking at).
// Backtrack/Expired Backtest's own charts are a much safer fit for this: they only ever refresh on a
// deliberate Run, not continuously, so there is no equivalent stream of remounts to fight - and here
// the user explicitly asked for it, to correlate a spot move with what CDV/OBV/Volume did at the same
// instant by eye. One group per page instance (see useChartSyncGroup) rather than a shared singleton,
// so a page unmounting can never leave stale chart references behind for the next page to inherit.
function createChartSyncGroup() {
  const charts = new Set()
  let isApplying = false

  function register(chart) {
    const onVisibleRangeChange = () => {
      if (isApplying) return
      const range = chart.timeScale().getVisibleRange()
      if (!range) return

      isApplying = true
      try {
        for (const other of charts) {
          if (other === chart) continue
          // A chart whose own data doesn't reach into this window can reject the range - "nothing
          // to show there", not an error worth breaking the drag over.
          try { other.timeScale().setVisibleRange(range) } catch { /* empty */ }
        }
      } finally {
        isApplying = false
      }
    }

    charts.add(chart)
    chart.timeScale().subscribeVisibleTimeRangeChange(onVisibleRangeChange)

    return () => {
      chart.timeScale().unsubscribeVisibleTimeRangeChange(onVisibleRangeChange)
      charts.delete(chart)
    }
  }

  return { register }
}

// One sync group per page instance, stable across re-renders (React's lazy useState initializer
// runs the factory only once, on mount) - pass the SAME returned object to every chart on the page
// that should pan/zoom together.
export function useChartSyncGroup() {
  return useState(() => createChartSyncGroup())[0]
}

// Joins `chart` to `syncGroup` only once `chart`'s own fitContent() has actually settled - measured
// (against this exact lightweight-charts version) to still be raising its own visibleTimeRangeChange
// events a full animation frame after fitContent() is called and returns, so registering any sooner
// - including synchronously right after that call - broadcasts THIS chart's own first-load auto-fit
// to every other chart in the group as if it were a user's pan/zoom, silently overriding whatever
// view the user had already set on one of them. Two frames leaves a full frame of margin beyond the
// measured worst case. `isStale` lets a caller detect its own unmount/remount before the deferred
// callback runs (pass e.g. `() => chartRef.current !== chart`) and skip registering a chart that no
// longer belongs to the calling component instance. No-op if `syncGroup` is falsy, so a chart that
// doesn't want syncing can simply omit the prop.
export function registerChartForSyncAfterSettling(syncGroup, chart, isStale, onRegistered) {
  if (!syncGroup) return
  requestAnimationFrame(() => {
    if (isStale()) return
    requestAnimationFrame(() => {
      if (isStale()) return
      onRegistered(syncGroup.register(chart))
    })
  })
}

// The last point in a chart-time-ascending, already-converted array (bars from toBar, or points from
// toLinePoints/the volume mapper - anything shaped {time, [valueKey]}) at or before targetChartTime -
// what a highlight needs to know "where on this series' own line does that time actually fall",
// since a click's exact time rarely lands on one of this particular series' own bars (CE/PE/volume
// bars do not share spot's own timestamps).
export function lastValueAtOrBeforeChartTime(points, targetChartTime, valueKey = 'value') {
  let value = null
  for (const p of points) {
    if (p.time > targetChartTime) break
    value = p[valueKey]
  }
  return value
}

// Drops lightweight-charts' own crosshair (the dashed vertical+horizontal line pair, with axis
// labels) onto `series` at `targetChartTime`/`price` and leaves it there - unlike the crosshair's
// usual behavior (following the mouse, vanishing when it leaves the chart), an explicitly-set one
// stays exactly where put until moved or cleared, which is what makes it work as a persistent
// "here is the row you clicked" marker rather than something that disappears the instant the pointer
// moves. This is what actually answers "which bar is that" - scrollChartToTime alone only brings the
// right neighborhood into view, it does not mark anything.
//
// `targetChartTime` null clears the crosshair outright (nothing focused, or nothing to show it on
// yet); a non-null price` of null/undefined leaves the previous crosshair as-is rather than setting
// a nonsensical one - the caller has nothing at or before that time on THIS particular series (e.g.
// an OBV chart whose own history starts later than the clicked row).
export function highlightChartAtTime(chart, series, targetChartTime, price) {
  if (!chart) return
  if (targetChartTime == null) {
    try { chart.clearCrosshairPosition() } catch { /* empty */ }
    return
  }
  if (!series || price == null) return
  try { chart.setCrosshairPosition(price, targetChartTime, series) } catch { /* empty */ }
}

// A generic two-line CE/PE running-total chart - CDV or OBV, whichever `valueKey` names on the raw
// point shape the backend returns (ObvPoint's own JSON field is "obv" for both: OBV and CDV are
// exposed as the same shape). A simplified port of App.jsx's own CeVsPeChart (the Dashboard's live
// CDV/OBV chart) for Backtrack/Expired Backtest's own verification charts - see this file's header
// comment for why App.jsx's tuned original is left untouched rather than imported.
//
// prevCeSeries/prevPeSeries (optional, dashed) is a reference line - CDV's previous trading day,
// typically; OBV has no equivalent and simply omits them. `syncGroup` (see useChartSyncGroup) joins
// this chart's own pan/zoom to every other chart passed the same group - omit it for a standalone
// chart that shouldn't sync with anything.
export function CeVsPeChart({ ceSeries, peSeries, prevCeSeries = [], prevPeSeries = [], valueKey = 'obv', height = 240, focusTime, syncGroup }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const ceRef = useRef(null)
  const peRef = useRef(null)
  const prevCeRef = useRef(null)
  const prevPeRef = useRef(null)
  const markersRef = useRef(null)
  const hasFitRef = useRef(false)
  const syncCleanupRef = useRef(null)

  const sanitizedCe = useMemo(() => sanitizeSeries(toLinePoints(ceSeries, valueKey)), [ceSeries, valueKey])
  const sanitizedPe = useMemo(() => sanitizeSeries(toLinePoints(peSeries, valueKey)), [peSeries, valueKey])
  const sanitizedPrevCe = useMemo(() => sanitizeSeries(toLinePoints(prevCeSeries, valueKey)), [prevCeSeries, valueKey])
  const sanitizedPrevPe = useMemo(() => sanitizeSeries(toLinePoints(prevPeSeries, valueKey)), [prevPeSeries, valueKey])

  useEffect(() => {
    if (!containerRef.current) return

    const chart = createZoomableChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    prevCeRef.current = chart.addSeries(LineSeries, { color: CE_COLOR, lineWidth: 1, lineStyle: LineStyle.Dashed, title: 'CE (prev day)', priceLineVisible: false, crosshairMarkerVisible: false })
    prevPeRef.current = chart.addSeries(LineSeries, { color: PE_COLOR, lineWidth: 1, lineStyle: LineStyle.Dashed, title: 'PE (prev day)', priceLineVisible: false, crosshairMarkerVisible: false })
    ceRef.current = chart.addSeries(LineSeries, { color: CE_COLOR, lineWidth: 2, title: 'CE', priceLineVisible: false })
    peRef.current = chart.addSeries(LineSeries, { color: PE_COLOR, lineWidth: 2, title: 'PE', priceLineVisible: false })
    markersRef.current = createSeriesMarkers(ceRef.current, [])
    hasFitRef.current = false
    syncCleanupRef.current = null

    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth })
    }
    window.addEventListener('resize', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
      syncCleanupRef.current?.()
      chart.remove()
      chartRef.current = null
      ceRef.current = null
      peRef.current = null
      prevCeRef.current = null
      prevPeRef.current = null
      markersRef.current = null
    }
  }, [height])

  useEffect(() => {
    if (!ceRef.current || !peRef.current || !prevCeRef.current || !prevPeRef.current) return
    const view = hasFitRef.current ? captureChartView(chartRef.current, ceRef.current) : null
    prevCeRef.current.setData(sanitizedPrevCe)
    prevPeRef.current.setData(sanitizedPrevPe)
    ceRef.current.setData(sanitizedCe)
    peRef.current.setData(sanitizedPe)
    const hasAnyData = sanitizedCe.length > 0 || sanitizedPe.length > 0 || sanitizedPrevCe.length > 0 || sanitizedPrevPe.length > 0
    if (!hasFitRef.current && hasAnyData) {
      chartRef.current?.timeScale().fitContent()
      hasFitRef.current = true
      const chartAtFit = chartRef.current
      registerChartForSyncAfterSettling(syncGroup, chartAtFit, () => chartRef.current !== chartAtFit, (cleanup) => { syncCleanupRef.current = cleanup })
    } else {
      restoreChartView(chartRef.current, view)
    }
  }, [sanitizedCe, sanitizedPe, sanitizedPrevCe, sanitizedPrevPe])

  const resetMarkers = useMemo(
    () => dayResetMarkers([...sanitizedPrevCe, ...sanitizedCe]),
    [sanitizedPrevCe, sanitizedCe],
  )

  useEffect(() => {
    markersRef.current?.setMarkers(resetMarkers)
  }, [resetMarkers])

  // A row click elsewhere on the page sets focusTime to that row's own time - recenter (see
  // scrollChartToTime's own doc comment for why that recenters rather than re-fits/re-zooms) AND
  // drop a persistent crosshair on the CE line so the exact bar is actually marked, not just
  // somewhere in view - see highlightChartAtTime's own doc comment for why scrolling alone isn't
  // enough to answer "which one is it".
  useEffect(() => {
    scrollChartToTime(chartRef.current, focusTime)
    const target = focusTime ? toChartTime(focusTime) : null
    const price = target != null ? lastValueAtOrBeforeChartTime(sanitizedCe, target) : null
    highlightChartAtTime(chartRef.current, ceRef.current, target, price)
  }, [focusTime, sanitizedCe])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// A plain volume histogram with a VWAP line overlaid - the third of the three verification charts
// (CDV/OBV via CeVsPeChart above, this one for real spot/index volume - see
// DhanHistoricalDataService's own doc comment on Dhan's January 2026 index-volume rollout, and
// VwapCalculator). `volumeBars` is raw {time: isoString, volume: number} (CandleWithVolume's own
// JSON shape - open/high/low/close are ignored, only the bar's own volume is plotted); `vwapSeries`
// is raw {time: isoString, obv: number} (ObvPoint's own JSON shape, reused for VWAP the same way
// CdvCeSeries/CdvPeSeries reuse it for CDV).
export function VolumeVwapChart({ volumeBars, vwapSeries, height = 180, focusTime, syncGroup }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const volumeRef = useRef(null)
  const vwapRef = useRef(null)
  const hasFitRef = useRef(false)
  const syncCleanupRef = useRef(null)

  const sanitizedVolume = useMemo(
    () => sanitizeSeries(volumeBars.map((b) => ({ time: toChartTime(b.time), value: b.volume, color: UP_COLOR }))),
    [volumeBars],
  )
  const sanitizedVwap = useMemo(() => sanitizeSeries(toLinePoints(vwapSeries, 'obv')), [vwapSeries])

  useEffect(() => {
    if (!containerRef.current) return

    const chart = createZoomableChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    volumeRef.current = chart.addSeries(HistogramSeries, { color: UP_COLOR, priceFormat: { type: 'volume' }, title: 'Volume', priceLineVisible: false })
    vwapRef.current = chart.addSeries(LineSeries, { color: EMA_COLOR, lineWidth: 2, title: 'VWAP', priceLineVisible: false, priceScaleId: 'left' })
    chart.priceScale('left').applyOptions({ visible: true, borderColor: BORDER_COLOR })
    hasFitRef.current = false
    syncCleanupRef.current = null

    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth })
    }
    window.addEventListener('resize', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
      syncCleanupRef.current?.()
      chart.remove()
      chartRef.current = null
      volumeRef.current = null
      vwapRef.current = null
    }
  }, [height])

  useEffect(() => {
    if (!volumeRef.current || !vwapRef.current) return
    const view = hasFitRef.current ? captureChartView(chartRef.current, volumeRef.current) : null
    volumeRef.current.setData(sanitizedVolume)
    vwapRef.current.setData(sanitizedVwap)
    const hasAnyData = sanitizedVolume.length > 0 || sanitizedVwap.length > 0
    if (!hasFitRef.current && hasAnyData) {
      chartRef.current?.timeScale().fitContent()
      hasFitRef.current = true
      const chartAtFit = chartRef.current
      registerChartForSyncAfterSettling(syncGroup, chartAtFit, () => chartRef.current !== chartAtFit, (cleanup) => { syncCleanupRef.current = cleanup })
    } else {
      restoreChartView(chartRef.current, view)
    }
  }, [sanitizedVolume, sanitizedVwap])

  useEffect(() => {
    scrollChartToTime(chartRef.current, focusTime)
    const target = focusTime ? toChartTime(focusTime) : null
    const price = target != null ? lastValueAtOrBeforeChartTime(sanitizedVolume, target) : null
    highlightChartAtTime(chartRef.current, volumeRef.current, target, price)
  }, [focusTime, sanitizedVolume])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

export function DirectionTag({ direction }) {
  if (!direction) return <Tag>—</Tag>
  return <Tag color={direction === 'Bullish' ? UP_COLOR : DOWN_COLOR}>{direction === 'Bullish' ? '▲ Bullish' : '▼ Bearish'}</Tag>
}

const NAV_ITEMS = [
  { key: '/', label: 'Dashboard' },
  { key: '/backtest', label: 'Backtrack' },
  {
    key: 'strike-data-group',
    label: 'Strike Data',
    children: [
      { key: '/strike-data', label: 'Live' },
      { key: '/rolling-strike-data', label: 'Rolling (Expired)' },
    ],
  },
  { key: '/expired-backtest', label: 'Expired Backtest' },
  { key: '/oi-replay', label: 'OI Replay' },
  { key: '/order-flow', label: 'Order Flow' },
  { key: '/live-strike-data', label: 'Live Strike Data' },
  { key: '/triggers', label: 'Triggers' },
  { key: '/contracts', label: 'Contracts' },
  { key: '/trade-settings', label: 'Trade settings' },
  { key: '/strategy-tuning', label: 'Strategy tuning' },
  { key: '/visitors', label: 'Visitors' },
]

// Shared between EVERY page (all nine currently render it) - a proper horizontal menu (not just
// plain text links) so it reads as real site navigation, sitting inline in each page's own header
// row with a transparent background so it blends into the page rather than looking like a separate
// bar. Also carries the signed-in email and a log-out button - the one place that's shown
// regardless of which page rendered this.
//
// Below NAV_COLLAPSE_BREAKPOINT, the horizontal Menu (9 top-level items, one with children - it has
// no room to fit a phone-width screen at all, let alone stay legible) is replaced by a small "☰"
// trigger opening the SAME items as a full-height Drawer with a vertical Menu instead - the same
// "collapse to a drawer below a breakpoint" shape any responsive site nav uses. Both renderings
// exist in the DOM at once and CSS (.navbar-desktop-menu/.navbar-mobile-trigger in index.css) picks
// exactly one via the same breakpoint, rather than a JS resize listener - simpler, and immune to a
// stale measurement on first paint before any resize event has fired.
//
// Triggers/Contracts are hidden here for a non-Admin account, but that is a convenience, not the
// actual security boundary - App.jsx's own route guard covers someone typing the URL directly, and
// the real enforcement is server-side (TriggersController/CdvController's [Authorize(Roles =
// "Admin")]), since hiding a link never stops a direct API call.
// When the running build was deployed, and whether logins survived the last restart - see
// SystemController. Fetched once per page load and shared by every NavBar instance.
// pollMs refreshes it (admins watch the live feed's health through it); otherwise it's fetched once.
let systemInfoPromise = null
const fetchSystemInfo = () => fetch('/api/system/info').then((r) => (r.ok ? r.json() : null)).catch(() => null)
function useSystemInfo(pollMs = null) {
  const [info, setInfo] = useState(null)
  useEffect(() => {
    let cancelled = false
    systemInfoPromise ??= fetchSystemInfo()
    systemInfoPromise.then((value) => { if (!cancelled) setInfo(value) })
    const id = pollMs ? setInterval(() => {
      systemInfoPromise = fetchSystemInfo()
      systemInfoPromise.then((value) => { if (!cancelled && value) setInfo(value) })
    }, pollMs) : null
    return () => { cancelled = true; clearInterval(id) }
  }, [pollMs])
  return info
}

const FEED_HEALTH_POLL_MS = 15_000
const FEED_BEHIND_MS = 2_000

// The Dhan disk cache's proof it is working: the past days it held when the server started (so they came through the
// restart / deploy) and what this run read from it and saved to it. Red tags above cover a folder that is not writable / kept.
function DhanCacheTag({ cache, startedUtc }) {
  if (!cache || cache.writable === false || cache.keptAcrossDeploys === false || cache.daysAtStart == null) return null
  const saved = cache.savedToDisk ?? 0
  const thisRun = `Since then: ${cache.readsFromDisk ?? 0} read from disk instead of Dhan, ${saved} newly saved${cache.writeErrors ? `, ${cache.writeErrors} could not be saved` : ''}.`
  if (cache.daysAtStart === 0) {
    return (
      <Tooltip title={`The Dhan cache folder held no saved days when the server started (${fmtIstDateTime(startedUtc)} IST). On a first start that is expected; after a deploy it means /app/data was not kept - mount a named volume there (Dokploy: Advanced > Volumes, or deploy with docker-compose). ${thisRun}`}>
        <Tag color="warning">Dhan cache started empty</Tag>
      </Tooltip>
    )
  }
  const mb = (cache.bytesAtStart ?? 0) / 1048576
  return (
    <Tooltip title={`${cache.daysAtStart} saved days (one file per instrument and day - spot, futures, each option strike) were on the server's disk when it started (${fmtIstDateTime(startedUtc)} IST), ${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB, the oldest saved ${fmtIstDateTime(cache.oldestSavedUtc)} IST${cache.survivedRestart ? ' - kept through the restart' : ''}. ${thisRun}`}>
      <Tag color="success">Dhan cache ✓ {cache.daysAtStart + saved} files</Tag>
    </Tooltip>
  )
}

// The server's live-tick consumers (Spot, CDV, OI Replay - see TickConsumerQueue) as one tag: how far
// behind live the slowest one has been over the last minute, and whether any had to drop ticks.
function FeedHealthTag({ feed }) {
  if (!Array.isArray(feed) || feed.length === 0) return null
  const worst = feed.reduce((a, b) => (b.queueWaitMaxMs > a.queueWaitMaxMs ? b : a))
  const dropping = feed.filter((c) => c.dropped > 0)
  const behind = worst.queueWaitMaxMs >= FEED_BEHIND_MS
  const color = dropping.length > 0 ? 'error' : behind ? 'warning' : 'success'
  const label = dropping.length > 0 ? `Feed: ${dropping.map((c) => c.name).join(', ')} dropping ticks`
    : behind ? `Feed: ${worst.name} ${(worst.queueWaitMaxMs / 1000).toFixed(1)}s behind` : 'Feed OK'
  return (
    <Tooltip title={(
      <div>
        <div>Server-side live tick processing, worst over the last minute:</div>
        {feed.map((c) => (
          <div key={c.name}>
            {c.name}: up to {(c.queueWaitMaxMs / 1000).toFixed(1)}s behind, slowest tick {c.handlerMaxMs}ms, {c.queued} queued, {c.processed.toLocaleString('en-IN')} processed{c.dropped > 0 ? `, ${c.dropped.toLocaleString('en-IN')} dropped` : ''}
          </div>
        ))}
      </div>
    )}>
      <Tag color={color}>{label}</Tag>
    </Tooltip>
  )
}

export function NavBar() {
  const location = useLocation()
  const navigate = useNavigate()
  const auth = useAuth()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const isAdmin = auth?.user?.role === 'Admin'
  const systemInfo = useSystemInfo(isAdmin ? FEED_HEALTH_POLL_MS : null)
  const items = isAdmin ? NAV_ITEMS : NAV_ITEMS.filter((item) => !ADMIN_ONLY_PATHS.includes(item.key))

  const go = (key) => { navigate(key); setDrawerOpen(false) }

  return (
    <Space align="center" size={16} wrap>
      <div className="navbar-desktop-menu">
        <Menu
          mode="horizontal"
          theme="dark"
          selectedKeys={[location.pathname]}
          items={items}
          onClick={({ key }) => go(key)}
          style={{ minWidth: 340, background: 'transparent', borderBottom: 'none', lineHeight: '32px' }}
        />
      </div>
      <Button
        className="navbar-mobile-trigger" size="large" onClick={() => setDrawerOpen(true)}
        aria-label="Open navigation menu" style={{ fontSize: 18, lineHeight: 1 }}
      >
        ☰
      </Button>
      <Drawer title="Menu" placement="left" onClose={() => setDrawerOpen(false)} open={drawerOpen} width={260}>
        <Menu mode="inline" selectedKeys={[location.pathname]} items={items} onClick={({ key }) => go(key)} />
      </Drawer>
      {auth?.user && (
        <Space size={8}>
          {systemInfo?.buildTimeUtc && (
            <Tooltip title={`Server running since ${fmtIstDateTime(systemInfo.startedUtc)} IST`}>
              <Typography.Text type="secondary" style={{ fontSize: 11 }}>Deployed {fmtIstDateTime(systemInfo.buildTimeUtc)}</Typography.Text>
            </Tooltip>
          )}
          {isAdmin && <FeedHealthTag feed={systemInfo?.feed} />}
          {isAdmin && systemInfo?.loginsSurviveRestart === false && (
            <Tooltip title="The login key ring was regenerated when the server last started, so every earlier login stopped working. /app/data is not on a persistent volume - mount a named volume there (Dokploy: Advanced > Volumes) so logins survive deploys.">
              <Tag color="warning">Logins reset at last deploy</Tag>
            </Tooltip>
          )}
          {/* The Dhan disk cache (past days) only saves Dhan calls when its folder can be written and outlives a deploy. */}
          {isAdmin && systemInfo?.dhanCache?.writable === false && (
            <Tooltip title="The server cannot write its Dhan cache folder (/app/data/dhan-cache), so nothing is kept and every day is asked of Dhan again. Mount a named volume at /app/data (Dokploy: Advanced > Volumes, or deploy with docker-compose) - a bind mount of a root-owned host folder is not writable by the app.">
              <Tag color="error">Dhan cache not writable</Tag>
            </Tooltip>
          )}
          {isAdmin && systemInfo?.dhanCache?.writable !== false && systemInfo?.dhanCache?.keptAcrossDeploys === false && (
            <Tooltip title="The Dhan cache folder (/app/data/dhan-cache) is not on a persistent volume, so every deploy starts it empty and the past days are asked of Dhan again. Mount a named volume at /app/data (Dokploy: Advanced > Volumes, or deploy with docker-compose).">
              <Tag color="error">Dhan cache lost at every deploy</Tag>
            </Tooltip>
          )}
          {isAdmin && <DhanCacheTag cache={systemInfo?.dhanCache} startedUtc={systemInfo?.startedUtc} />}
          {/* Always in view for an admin (the menu's own "Visitors" item can fold into its "···" on a laptop screen). */}
          {isAdmin && (
            <Tooltip title="Who opened which page, when and from where - every account and visitors with no account">
              <Button size="small" type={location.pathname === '/visitors' ? 'primary' : 'default'} onClick={() => go('/visitors')}>👥 Visitors</Button>
            </Tooltip>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 12 }} className="navbar-email">{auth.user.email}</Typography.Text>
          <Button size="small" onClick={auth.logout}>Log out</Button>
        </Space>
      )}
    </Space>
  )
}
