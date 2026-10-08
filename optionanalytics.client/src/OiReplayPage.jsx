import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dayjs from 'dayjs'
import { Select, Space, Typography, Card, Button, Statistic, Row, Col, DatePicker, TimePicker, Alert, Empty, Tooltip, Popconfirm, Slider, Tag, InputNumber, Switch, Table, Segmented, Checkbox, Modal, message } from 'antd'
import { findSuddenWalls, suddenWallText } from './suddenOi.js'
import { buildOiTotalsRows } from './oiTotalsHeatmap.js'
import { PlayCircleOutlined, PauseCircleOutlined, ReloadOutlined, SoundOutlined, ExportOutlined } from '@ant-design/icons'
import { createSeriesMarkers, CandlestickSeries, LineSeries, HistogramSeries, CrosshairMode } from 'lightweight-charts'
import { createZoomableChart } from './chartZoom.js'
import * as signalR from '@microsoft/signalr'
import './oiMobile.css'
import {
  UP_COLOR, DOWN_COLOR, AXIS_COLOR, GRID_COLOR, BORDER_COLOR,
  istTimeFormatter, istTimeWithSecondsFormatter, istTickMarkFormatter, toBar, toChartTime, fromChartTime, istDateKey, fmtDateOnly,
  NavBar, TIMEFRAME_OPTIONS, STORED_UNDERLYING, STORED_TIMEFRAME, STORED_SHOW_VWAP, STORED_SHOW_VOLUME_PROFILE, usePersistedState,
  syncSignalRGroups, joinAllSignalRGroups, useCardOrder, CardDragHandle, onLiveBatch, useFeedLag, FeedLagTag, FeedLagAlert, LiveSection, checkForNewDeploy, useAuth,
} from './shared.jsx'
import { alignToBars, chartVwap, sessionVwapFromBars } from './chartVwap.js'
import { notifyLiveTradeEvents, notifyTrade } from './tradeNotify.js'
import { loadTradeLevels, saveTradeLevels, subscribeTradeLevels } from './tradeDefaults.js'
import { PREV_PROFILE } from './profileColors.js'
import { optionTrailLevel, tighterStop } from './optionTrail.js'
import { PremiumEmaChart, DraggableFloatingPanel, useFitContentAsDataGrows, useChartUserControl, CANDLE_SCALE_MARGINS } from './oiShared.jsx'
import { LivePositionsView, liveTradingApi } from './LiveTrading.jsx'
import { StrikePicker, moneynessLabel } from './StrikePicker.jsx'
import { DomDrawer } from './DomDrawer.jsx'
import { volumeProfileFromCandles } from './orderFlowMath.js'
import { VolumeProfilePrimitive, setProfileLines } from './volumeProfilePrimitive.js'
import { useReplaySync, useReplaySyncEnabled, ReplaySyncControl, withSpeedOption, SYNC_DRIFT_MS } from './replaySync.jsx'

const { Text, Title } = Typography

// A stable default for an optional array prop (ReplayChart/EmaChart's own vwapSeries) - a plain `[]`
// literal default is a NEW array every render, which would re-trigger any effect keyed on it even
// when the caller never actually passes one.
const EMPTY_ARRAY = []


// How long today's replay can go without ANY tick (spot, OI, or futures) before this page treats it
// as suspicious rather than trusting the "● LIVE" tag - that tag only reflects the browser's own
// SignalR connection to OUR server, never whether the SERVER's own upstream Dhan feed is actually
// flowing (see DhanMarketFeedClient's own stall detector for how THAT gets diagnosed, server-side,
// from logs this page cannot see). A silently stalled upstream feed would otherwise look identical,
// from here, to a page working correctly during a genuinely quiet market moment - the "are we not
// receiving live ticks from Dhan, flag us" ask this closes.
const FEED_STALL_WARNING_MS = 3 * 60_000

// How long load() waits for /api/oi-replay/.../run before giving up on its own and showing an
// error, rather than leaving the browser's plain fetch() (no timeout of its own) pending
// indefinitely. Sized above the backend's own worst case: up to 44 live Dhan calls, 10 at a time,
// each with its own 20s server-side timeout (see DhanHistoricalDataService.CallTimeout) - so
// roughly ceil(44/10) * 20s = 100s in the worst case, plus real network time. A mobile/cellular
// connection is more likely to hit this than WiFi/broadband: a long-held single connection is more
// exposed to a carrier's own idle-connection timeout, and a backgrounded tab (screen lock, app
// switch) can suspend or kill the fetch outright - either way, the user gets a clear message and a
// live Cancel button instead of an indefinite spinner with no way out.
const LOAD_TIMEOUT_MS = 120_000

// Bare withAutomaticReconnect() uses SignalR's own default retry policy - 0s/2s/10s/30s, then it
// gives up FOR GOOD and fires onclose, leaving the connection permanently dead until the page is
// manually reloaded - exactly the "had given up entirely after withAutomaticReconnect's own retry
// budget ran out" scenario useOiReplayLiveFeed's own doc comment below already names as a real,
// previously-hit failure mode (that round only added a clearer disconnected-state indicator, never
// actually fixed the give-up itself). A live-market page open for a full trading day WILL eventually
// see a backend redeploy or a brief network blip longer than 42 seconds - it should keep trying
// forever with a capped backoff, not go silent until someone notices and reloads.
const RECONNECT_RETRY_POLICY = {
  nextRetryDelayInMilliseconds(retryContext) {
    const delays = [0, 2000, 5000, 10000, 15000, 30000]
    return delays[Math.min(retryContext.previousRetryCount, delays.length - 1)]
  },
}

// Connects to the same SignalR hub the live dashboard already uses (App.jsx's own useHub), for
// these events: "spotUpdate" (SpotFeedHostedService's existing push - the underlying's own
// currently-forming 1-minute bar, reused as-is rather than building a second live-spot pipeline),
// "oiReplayTicks" (OiReplayLiveFeedService's coalesced push - each option leg's live price/OI), and
// "futuresTicks" (that same service's push for the underlying's own nearest futures contract - the
// user's own "make sure ALL functionality of this page should work [live]" ask: the Futures section
// used to be a one-time REST snapshot that never updated again until the next full reload), and
// "oiRestSnapshot" (Dhan's option-chain snapshot - the live IV source).
//
// ALWAYS connects on mount and never tears down/rebuilds - an empty dependency array, exactly like
// App.jsx's own useHub/oiShared.jsx's useOiLiveHub. This USED to depend on `[enabled]`
// (isLive && liveFeedSupported && Boolean(result)) so the connection only opened while genuinely
// viewing today live - which sounds right but wasn't: `result` briefly goes null/undefined on
// EVERY load() call (including a plain data refresh, not just a day switch), flipping `enabled`
// false-then-true-then-false in quick succession and tearing the real WebSocket down and rebuilding
// it each time - a real, confirmed source of "lots of web connections"/reconnect churn, the exact
// bug oiShared.jsx's useOiLiveHub was already built specifically to avoid. Every callback below
// already independently checks `isLive` itself
// before acting (see handleSpotUpdate/handleOiReplayTicks/handleFuturesTicks's own `if (!isLive...)`
// guards) via the SAME ref-read pattern used here, so a tick arriving while a historical (non-today)
// day is loaded already safely no-ops - nothing about correctness depended on tearing the
// connection itself down, only on gating what it's ALLOWED to do once a tick arrives.
const EMPTY_GROUPS = []

function useOiReplayLiveFeed(onSpotUpdate, onOiReplayTicks, onFuturesTicks, onRestSnapshot, onReconnected, onPainted, underlying, expiryFlag, onLivePositions = null, extraGroups = EMPTY_GROUPS) {
  const spotRef = useRef(onSpotUpdate)
  const tickRef = useRef(onOiReplayTicks)
  const futuresRef = useRef(onFuturesTicks)
  const restSnapshotRef = useRef(onRestSnapshot)
  const reconnectedRef = useRef(onReconnected)
  const paintedRef = useRef(onPainted)
  paintedRef.current = onPainted
  spotRef.current = onSpotUpdate
  tickRef.current = onOiReplayTicks
  futuresRef.current = onFuturesTicks
  restSnapshotRef.current = onRestSnapshot
  reconnectedRef.current = onReconnected
  // The trade panel's Live mode: the account's real positions/P&L, pushed by LiveTradingService to
  // the admin-only "positions" group (passed in extraGroups while Live mode is open).
  const livePositionsRef = useRef(onLivePositions)
  livePositionsRef.current = onLivePositions

  // The actual SignalR connection state - the page's own "Live" badge used to be purely a date
  // comparison, so it read "Live" (green) even when this connection had failed to negotiate, was
  // stuck reconnecting, or had given up entirely after withAutomaticReconnect's own retry budget ran
  // out - exactly the "everything is stuck but it still says Live" confusion the user hit.
  // 'connecting' while start() is in flight, 'connected' once it resolves (or after onreconnected),
  // 'reconnecting' while the client is retrying a dropped connection on its own, 'disconnected' once
  // onclose fires (retries exhausted).
  const [connectionState, setConnectionState] = useState('connecting')
  const connectionRef = useRef(null)
  // "u:{underlying}" (spotUpdate/futuresTicks) plus "c:{underlying}:{expiryFlag}" (oiReplayTicks/oiRestSnapshot) -
  // same two-group shape as oiShared.jsx's useOiLiveHub, see its own doc comment.
  const groupsRef = useRef([])

  useEffect(() => {
    // Belt-and-suspenders, not a fix for an observed leak: with today's `[]` deps this effect only
    // ever runs once per mount, and React always runs the PREVIOUS mount's own cleanup (which already
    // calls connection.stop() below) before a new one - so connectionRef.current is already null by
    // the time we get here in every normal case. Stopping whatever's still referenced here anyway
    // costs nothing and closes the one way this could ever go wrong: a future edit reintroducing a
    // dependency to this array (exactly the reconnect-churn bug this hook's own history already
    // describes) would otherwise leave the OLD connection open and unreferenced - a genuine socket
    // leak - the moment a new one replaces it.
    if (connectionRef.current) connectionRef.current.stop()
    const connection = new signalR.HubConnectionBuilder()
      .withUrl('/hubs/spot')
      .withAutomaticReconnect(RECONNECT_RETRY_POLICY)
      .build()
    connectionRef.current = connection

    // spotUpdate/oiReplayTicks/futuresTicks all arrive inside the conflated "liveBatch" (see
    // onLiveBatch) - the newest state only, acknowledged after paint, so this page can't fall behind.
    onLiveBatch(connection, {
      spotUpdate: (snapshot) => spotRef.current(snapshot),
      oiReplayTicks: (ticks) => tickRef.current(ticks ?? []),
      futuresTicks: (ticks) => futuresRef.current?.(ticks ?? []),
      livePositions: (snapshot) => livePositionsRef.current?.(snapshot),
    }, (sentAtMs, clockOffsetMs) => paintedRef.current?.(sentAtMs, clockOffsetMs))
    // Dhan's option-chain snapshot (every ~30-90s per expiry) - the only live source of IV, since
    // the websocket tick carries none.
    connection.on('oiRestSnapshot', (snapshot) => restSnapshotRef.current?.(snapshot))
    connection.onreconnecting(() => setConnectionState('reconnecting'))
    // A reconnect gets a brand-new server-side connection with no group membership at all - rejoin
    // the CURRENT selection (groupsRef.current), not whatever it was when this connection object was
    // first created.
    connection.onreconnected(() => {
      setConnectionState('connected')
      joinAllSignalRGroups(connection, groupsRef.current)
      checkForNewDeploy()
      reconnectedRef.current?.()
    })
    connection.onclose(() => setConnectionState('disconnected'))
    connection.start()
      .then(() => {
        setConnectionState('connected')
        joinAllSignalRGroups(connection, groupsRef.current)
      })
      .catch((err) => {
        // React StrictMode double-mounts every effect once in development - the first connection's
        // start() gets aborted by this effect's own cleanup before negotiation finishes on the
        // second mount. Not a real failure.
        if (err?.name === 'AbortError') return
        console.error('OI Replay live feed connection failed:', err)
        setConnectionState('disconnected')
      })

    return () => { connectionRef.current = null; connection.stop() }
  }, [])

  // Keeps server-side group membership in sync with the currently selected underlying/expiryFlag,
  // without touching the connection itself - see oiShared.jsx's useOiLiveHub for the identical
  // shape/reasoning.
  useEffect(() => {
    const newGroups = [
      underlying ? `u:${underlying}` : null,
      underlying && expiryFlag ? `c:${underlying}:${expiryFlag}` : null,
      ...extraGroups,
    ].filter(Boolean)
    syncSignalRGroups(connectionRef.current, groupsRef.current, newGroups)
    groupsRef.current = newGroups
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underlying, expiryFlag, extraGroups.join('|')])

  return connectionState
}

// One entry per distinct strike this side ever reported, its own points sorted ascending by time -
// built once per fetched run (see useMemo below), not recomputed on every replay tick. Grouping by
// strike here is what lets the replay loop below look up "this strike's latest reading at or before
// time T" as a simple per-strike scan instead of re-filtering the whole flat point list every tick.
function groupByStrike(points) {
  const byStrike = new Map()
  for (const p of points) {
    let list = byStrike.get(p.strike)
    if (!list) byStrike.set(p.strike, (list = []))
    list.push(p)
  }
  // Runs on every live flush over the whole day's points - so skip the sort entirely when a strike's
  // list is already in order (the normal case: REST history, then live points appended in arrival
  // order) instead of re-sorting with a Date parse inside every comparison.
  for (const list of byStrike.values()) {
    for (const p of list) if (p.ms == null) p.ms = new Date(p.time).getTime()
    for (let i = 1; i < list.length; i++) {
      if (pointMs(list[i]) < pointMs(list[i - 1])) { list.sort((a, b) => pointMs(a) - pointMs(b)); break }
    }
  }
  return byStrike
}

// Live points carry their own pre-parsed `ms`; REST points (and older cached live ones) get it
// stamped once by groupByStrike, so a lookup never re-parses a date string.
function pointMs(p) {
  return p.ms ?? new Date(p.time).getTime()
}

// The last point at or before asOfMs in a time-ascending list - null if the series hasn't started
// yet as of this point in the replay. Binary search: this runs for every strike (and, in the
// per-bar loops, for every bar too) on every live batch, and a linear scan over a whole day's
// series made the page slower and slower as the day went on.
function latestAtOrBefore(sortedPoints, asOfMs) {
  let lo = 0
  let hi = sortedPoints.length - 1
  let found = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (pointMs(sortedPoints[mid]) <= asOfMs) { found = sortedPoints[mid]; lo = mid + 1 } else hi = mid - 1
  }
  return found
}

// The server coalesces Dhan's per-strike ticks (100+/s across a strike band) into one "oiReplayTicks"
// array per ~300ms - see LiveBroadcastBatcher - each entry carrying that leg's latest reading plus the
// open/high/low of its price inside the window. Each batch is applied as ONE state update. Raw ticks
// are never kept: each strike holds one 1-minute bar per completed minute (open/high/low/last price,
// OI and IV as of the minute's last tick - the same shape as the REST history) plus the forming
// minute, which later batches update in place. A minute can see thousands of ticks, but the day's
// history stays at ~375 points per strike, so memory and per-batch work stay flat all day. The newest
// reading is always what's shown.
const LIVE_STATUS_INTERVAL_MS = 500
const LIVE_POINT_SLOT_MS = 60_000

function mergeLiveOptionTicks(prev, ticks, ivByStrike, slotMs = LIVE_POINT_SLOT_MS) {
  if (ticks.length === 0) return prev
  const next = prev.slice()
  const wanted = new Set(ticks.map((t) => t.strike))
  const lastIndex = new Map()
  for (let i = next.length - 1; i >= 0 && lastIndex.size < wanted.size; i--) {
    const strike = next[i].strike
    if (wanted.has(strike) && !lastIndex.has(strike)) lastIndex.set(strike, i)
  }
  const ordered = [...ticks].sort((a, b) => new Date(a.time) - new Date(b.time))
  for (const tick of ordered) {
    const ms = new Date(tick.time).getTime()
    if (!Number.isFinite(ms)) continue
    const tickHigh = Number.isFinite(tick.high) ? tick.high : tick.price
    const tickLow = Number.isFinite(tick.low) ? tick.low : tick.price
    const idx = lastIndex.get(tick.strike)
    const last = idx != null ? next[idx] : null
    if (last && Math.floor(pointMs(last) / slotMs) === Math.floor(ms / slotMs)) {
      const high = Number.isFinite(last.high) ? Math.max(last.high, tickHigh) : tickHigh
      const low = Number.isFinite(last.low) ? Math.min(last.low, tickLow) : tickLow
      next[idx] = { ...last, time: tick.time, ms, openInterest: tick.openInterest, price: tick.price, high, low }
    } else if (!last || ms >= pointMs(last)) {
      next.push({
        time: tick.time, ms, strike: tick.strike, openInterest: tick.openInterest,
        impliedVolatility: ivByStrike?.get(tick.strike) ?? last?.impliedVolatility ?? null,
        price: tick.price, open: Number.isFinite(tick.open) ? tick.open : tick.price, high: tickHigh, low: tickLow,
      })
      lastIndex.set(tick.strike, next.length - 1)
    }
  }
  return next
}

// Futures entries folded into their own current MINUTE. A tick's dayVolume is Dhan's CUMULATIVE day
// volume, so a minute's volume is its rise since the minute began: dayVolumeOpen is the cumulative
// figure at the minute's start (the previous live minute's last one, else the minute's first tick -
// which misses only the part of that first minute before the page started listening). Without
// dayVolume (an older server) volume stays null, which futuresVolumeSoFar's own sum treats as 0.
function mergeLiveFuturesTicks(prev, ticks) {
  if (ticks.length === 0) return prev
  const next = prev.slice()
  const ordered = [...ticks].sort((a, b) => new Date(a.time) - new Date(b.time))
  for (const tick of ordered) {
    const bucketIso = new Date(Math.floor(new Date(tick.time).getTime() / 60_000) * 60_000).toISOString()
    const high = Number.isFinite(tick.high) ? tick.high : tick.price
    const low = Number.isFinite(tick.low) ? tick.low : tick.price
    const last = next[next.length - 1]
    const dayVolume = tick.dayVolume > 0 ? tick.dayVolume : null
    if (last && last.time === bucketIso) {
      const volume = dayVolume != null && last.dayVolumeOpen != null ? Math.max(0, dayVolume - last.dayVolumeOpen) : last.volume
      next[next.length - 1] = { ...last, high: Math.max(last.high, high), low: Math.min(last.low, low), close: tick.price, openInterest: tick.openInterest, volume, dayVolume: dayVolume ?? last.dayVolume }
    } else if (!last || bucketIso > last.time) {
      const dayVolumeOpen = dayVolume == null ? null : last?.dayVolume ?? dayVolume
      next.push({
        time: bucketIso, open: Number.isFinite(tick.open) ? tick.open : tick.price, high, low, close: tick.price, openInterest: tick.openInterest,
        volume: dayVolume != null ? Math.max(0, dayVolume - dayVolumeOpen) : null, dayVolume, dayVolumeOpen,
      })
    }
  }
  return next
}

// Stamps a fresh option-chain IV onto each strike's newest live point - IV is otherwise frozen at the
// morning REST seed, since Dhan's websocket tick has no IV field at all.
function applyIvSnapshot(prev, ivByStrike) {
  if (ivByStrike.size === 0) return prev
  let next = null
  const seen = new Set()
  for (let i = prev.length - 1; i >= 0 && seen.size < ivByStrike.size; i--) {
    const p = prev[i]
    if (seen.has(p.strike) || !ivByStrike.has(p.strike)) continue
    seen.add(p.strike)
    const iv = ivByStrike.get(p.strike)
    if (p.impliedVolatility === iv) continue
    next ??= prev.slice()
    next[i] = { ...p, impliedVolatility: iv }
  }
  return next ?? prev
}

const STORED_REPLAY_CONTROLS_FLOATING = 'optionanalytics.oiReplay.replayControlsFloating'
const STORED_SPOT_FLOATING = 'optionanalytics.oiReplay.spotFloating'

// Replay position (a visible-bar count) for a picked IST wall-clock time: the last 1-minute bar at
// or before it, so Start plays on from exactly there. A time before the first bar lands on the first
// bar, one after the last on the last. Chart times are IST wall-clock encoded as UTC seconds (see
// toChartTime), so the day's midnight is just the first bar's time floored to a whole day.
function replayCountAt(oneMinBars, hour, minute) {
  if (oneMinBars.length === 0) return 0
  const target = Math.floor(oneMinBars[0].time / 86_400) * 86_400 + hour * 3600 + minute * 60
  let count = 1
  for (let i = 0; i < oneMinBars.length && oneMinBars[i].time <= target; i++) count = i + 1
  return count
}

// NSE indices tick about once a second in market hours - this much silence on spot alone is a
// real stall even while option ticks keep the connection looking alive.
const SPOT_SILENCE_WARN_MS = 20_000

function isIndianMarketHours(ms) {
  const ist = new Date(ms + 5.5 * 3600_000)
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes()
  const day = ist.getUTCDay()
  return day >= 1 && day <= 5 && minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30
}

// Last known IV per strike from the REST seed - live ticks carry none (see OiReplayLiveFeedService).
function lastIvByStrike(points) {
  const map = new Map()
  for (const p of points ?? []) if (p.impliedVolatility != null) map.set(p.strike, p.impliedVolatility)
  return map
}

// Client-side counterpart to the backend's own BacktestUtil.AggregateCandles - buckets native
// 1-minute bars (already chart-time-shifted by toBar/toChartTime) into timeframeMinutes candles.
// Deliberately does NOT drop a trailing incomplete bucket the way the backend does for a finished
// backtest: here the whole point is to show the CURRENTLY FORMING candle live as 1-minute ticks
// keep arriving, the same way a real charting terminal's current bar updates mid-formation. Safe to
// bucket the already-IST-shifted time directly - the shift (5.5 hours) divides evenly into every
// offered timeframe (1/3/5/15 min), so it lands on the exact same bucket boundaries plain UTC would.
function aggregateBars(oneMinBars, timeframeMinutes) {
  if (timeframeMinutes <= 1) return oneMinBars
  const bucketSeconds = timeframeMinutes * 60
  const buckets = new Map()
  for (const bar of oneMinBars) {
    const bucketTime = Math.floor(bar.time / bucketSeconds) * bucketSeconds
    const existing = buckets.get(bucketTime)
    if (existing) {
      existing.high = Math.max(existing.high, bar.high)
      existing.low = Math.min(existing.low, bar.low)
      existing.close = bar.close
    } else {
      buckets.set(bucketTime, { time: bucketTime, open: bar.open, high: bar.high, low: bar.low, close: bar.close })
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time)
}

// Buckets a plain {time, value} line series (as opposed to aggregateBars' own OHLC candles) into
// timeframeMinutes buckets, keeping the LAST value seen in each bucket - the right way to downsample
// a LEVEL (like OI, which isn't meaningfully summed or averaged across a window) rather than a flow.
// Used by the OI lookback features below (both the Entry chart B overlay and the Total OI Lookback
// Table) and the OI change heatmap.
//
// Previously short-circuited (returned the raw points untouched) whenever minutes <= 1, on the
// assumption a "1-minute" bucket size meant "the source is already 1-minute resolution, nothing to
// do" - true for candle-derived series, but OI ticks arrive whenever the feed updates, not neatly
// once a minute, so that early return left them un-bucketed: every raw tick became its own column,
// most within the SAME displayed minute (istTimeFormatter only shows hour:minute, no seconds) - the
// "tick by tick instead of a real timeframe" report, where the heatmap showed the same time label
// repeated across many columns and most of the grid blank. Also allows fractional minutes (0.5 = 30
// seconds) for a finer bucket than the whole-minute options everywhere else on this page offer.
function aggregateLinePoints(points, minutes) {
  if (minutes <= 0 || points.length === 0) return points
  const bucketSeconds = minutes * 60
  const buckets = new Map()
  for (const p of points) buckets.set(Math.floor(p.time / bucketSeconds) * bucketSeconds, { ...p, time: Math.floor(p.time / bucketSeconds) * bucketSeconds })
  return [...buckets.values()].sort((a, b) => a.time - b.time)
}

// "Current" vs "N bars ago" within an already-bucketed {time, value}[] line series - the shared
// building block behind both OI lookback features below. OI is always non-negative and so never
// crosses zero the way a CDV reading legitimately can (see App.jsx's own computeLookbackChange),
// needing only the divide-by-zero guard, not that one's extra sign-crossing guard.
function computeOiLookbackChange(series, barsAgo) {
  const lastIndex = series.length - 1
  if (lastIndex < 0) return { bars: barsAgo, current: null, previous: null, delta: null, percentChange: null }
  const current = series[lastIndex].value
  const previousIndex = lastIndex - barsAgo
  if (previousIndex < 0) return { bars: barsAgo, current, previous: null, delta: null, percentChange: null }
  const previous = series[previousIndex].value
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return { bars: barsAgo, current, previous, delta: null, percentChange: null }
  const delta = current - previous
  return { bars: barsAgo, current, previous, delta, percentChange: previous === 0 ? null : (delta / Math.abs(previous)) * 100 }
}

function fmtOiDelta(v) {
  return v == null ? '—' : `${v > 0 ? '+' : ''}${v.toLocaleString()}`
}

// Per-minute OI CHANGE (the delta from the previous bucket) off an already-bucketed total-OI level
// series (aggregateLinePoints' own output, one point per minute, last-value-per-bucket) - the
// derivative of that level series, one point per minute after the first (which has no earlier
// bucket to diff against, so it is left out rather than shown as some fake baseline delta). This is
// what the strike drill-down's own "Per-minute change" tab plots - a level series alone answers
// "how much OI is there," but not "which minute did it actually get added/removed in," which is
// exactly the "how can I see WHERE it's been added" ask this exists for.
function computeOiChangeSeries(totalSeries) {
  const result = []
  for (let i = 1; i < totalSeries.length; i++) {
    result.push({ time: totalSeries[i].time, value: totalSeries[i].value - totalSeries[i - 1].value })
  }
  return result
}

// The cumulative counterpart to computeOiChangeSeries above - every point re-based against the
// FIRST point in the series (today's own opening OI, since every series plotted through this
// component already starts at market open), rather than the previous point. Answers "how much has
// built up/unwound since the day started, as of any given minute" as a running line - the same
// number the ladder/Day OI Accumulation cards already show as a single "as of right now" figure,
// just plotted continuously so its own trajectory through the day is visible instead of only its
// current value.
function toSinceOpenSeries(totalSeries) {
  // Every call site here is a plain useMemo, not wrapped in its own ChartErrorBoundary the way the
  // chart that eventually renders this IS - an exception thrown here would crash the whole page's
  // top-level render instead of just that one chart. Guarded defensively after a real report of
  // exactly that (a blank/crashed page, right after this since-open feature shipped) - degrading to
  // an empty series (the chart then just shows nothing) is a far better failure than taking the
  // entire page down with it.
  try {
    if (!Array.isArray(totalSeries) || totalSeries.length === 0) return []
    const base = totalSeries[0]?.value
    if (!Number.isFinite(base)) return []
    return totalSeries.map((p) => ({ time: p.time, value: p.value - base }))
  } catch {
    return []
  }
}

// The all-strikes counterpart to the single-strike drill-down's own change tab - "where, across the
// WHOLE tracked band, has OI actually been added or removed" at a glance, which reading one strike
// at a time can't give. Builds a strike x timeframe matrix for one side (CE or PE): each strike gets
// its own computeOiChangeSeries off its own timeframeMinutes-bucketed level series, keyed by bucket
// time in a Map for O(1) lookup per cell. The column set is the UNION of every bucket ANY strike in
// the band has touched (not just the first strike's own), so a strike that only started ticking
// partway through the day still lines up against the correct real time rather than sliding left.
//
// The one bucket where a strike's series switches from the morning REST seed (Dhan's historical
// /charts/rollingoption data) to the live websocket feed only counts what the LIVE feed saw change
// inside it: those are two independent Dhan pipelines that don't report identical OI (see
// OiReplayLiveFeedService's own note on it), so live-minus-seed is mostly the gap between two
// sources, not OI actually added or removed.
// Drawn, it showed up as one huge fake column that set the color scale and left every genuine live
// change after it nearly invisible - the heatmap looked frozen while it was in fact updating. Live
// points are the ones carrying their own pre-parsed `ms` (see mergeLiveOptionTicks).
function buildOiChangeMatrix(byStrike, strikes, asOfMs, timeframeMinutes) {
  const perStrikeChange = new Map()
  const bucketSet = new Set()
  for (const strike of strikes) {
    const raw = (byStrike.get(strike) ?? []).filter((p) => asOfMs == null || pointMs(p) <= asOfMs)
    const total = aggregateLinePoints(raw.map((p) => ({ time: toChartTime(p.time), value: p.openInterest, live: p.ms != null })), timeframeMinutes)
    const byBucket = new Map()
    for (let i = 1; i < total.length; i++) {
      let change = total[i].value - total[i - 1].value
      if (total[i].live && !total[i - 1].live) {
        // Seam bucket: only what the live feed itself saw change inside it, never live-vs-seed.
        const firstLive = raw.find((p) => p.ms != null && bucketOf(toChartTime(p.time), timeframeMinutes) === total[i].time)
        change = firstLive ? total[i].value - firstLive.openInterest : 0
      }
      byBucket.set(total[i].time, change)
      bucketSet.add(total[i].time)
    }
    perStrikeChange.set(strike, byBucket)
  }
  return { buckets: [...bucketSet].sort((a, b) => a - b), perStrikeChange }
}

function bucketOf(chartTime, minutes) {
  const bucketSeconds = minutes * 60
  return Math.floor(chartTime / bucketSeconds) * bucketSeconds
}

// The |change| that maps to full color - the 95th percentile of every non-zero change on the grid
// rather than the single largest one, so one outsized burst (a big block trade, a strike newly
// entering the band) can't wash every ordinary minute out to near-transparent. Anything above it
// simply draws at full intensity; the tooltip always has the exact number.
const HEATMAP_SCALE_PERCENTILE = 0.95

function heatmapScale(perStrikeChange) {
  const magnitudes = []
  for (const byBucket of perStrikeChange.values())
    for (const v of byBucket.values())
      if (Number.isFinite(v) && v !== 0) magnitudes.push(Math.abs(v))
  if (magnitudes.length === 0) return 0
  magnitudes.sort((a, b) => a - b)
  return magnitudes[Math.min(magnitudes.length - 1, Math.floor(magnitudes.length * HEATMAP_SCALE_PERCENTILE))]
}

function hexToRgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

// Single-value options for chart B's own "last N bars" OI-change overlay - a plain number picker,
// not a multi-select: this overlay is one figure, tied directly to chart B itself, not a table with
// several lookback windows at once (that's what the Total OI Lookback Table below is for instead).
const OI_LOOKBACK_N_OPTIONS = [3, 5, 7, 10, 15, 20]

// The Total OI Lookback Table's own multi-select bar-count options and independent timeframe picker -
// unlike chart B's single-value overlay above, this table shows SEVERAL lookback windows at once
// (the user's own "I can select multiple [bar counts]" ask), against the WHOLE chain's total CE/PE
// OI rather than one strike, so it belongs in the Day OI Accumulation card rather than pinned to a
// chart. Defaults to 1-minute bars ("it should work per min") - independent of chart B's own
// timeframe, since this table can be read on its own regardless of what chart B is currently set to.
const TOTAL_OI_LOOKBACK_BAR_OPTIONS = [3, 5, 7, 10, 15, 20, 25, 30]
const DEFAULT_TOTAL_OI_LOOKBACK_BARS = [3, 5, 7]
const TOTAL_OI_LOOKBACK_TIMEFRAME_OPTIONS = [
  { value: 1, label: '1 min' }, { value: 2, label: '2 min' }, { value: 3, label: '3 min' }, { value: 5, label: '5 min' },
]

function renderOiLookbackDelta(v) {
  if (v == null) return <Text type="secondary">—</Text>
  const color = v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined
  return <Text style={{ color }} title={`${v > 0 ? '+' : ''}${v.toLocaleString()}`}>{formatOiMillions(v, { signed: true })}</Text>
}

function renderOiLookbackPercent(v) {
  if (v == null) return <Text type="secondary">—</Text>
  const color = v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined
  return <Text style={{ color }}>{v > 0 ? '+' : ''}{v.toFixed(1)}%</Text>
}

// Standard exponential moving average over already-aggregated bars' own closes - seeded with a
// plain SMA of the first `period` closes (the conventional seed every charting tool uses), then
// smoothed forward from there with the usual k = 2/(period+1) factor. Returns one point per bar
// from index period-1 onward - a bar before that doesn't have `period` bars of history behind it
// yet, so it's left out entirely (no plotted point) rather than shown as a misleadingly early
// partial average.
function computeEma(bars, period) {
  if (!bars || period <= 0 || bars.length < period) return []
  const k = 2 / (period + 1)
  let sum = 0
  for (let i = 0; i < period; i++) sum += bars[i].close
  let ema = sum / period
  const points = [{ time: bars[period - 1].time, value: ema }]
  for (let i = period; i < bars.length; i++) {
    ema = bars[i].close * k + ema * (1 - k)
    points.push({ time: bars[i].time, value: ema })
  }
  return points
}

// Volume profile row size for the futures chart, per underlying.
const FUTURES_PROFILE_ROWS = { NIFTY: 5, BANKNIFTY: 10, SENSEX: 10 }

// A short beep via the Web Audio API - no asset file needed. Lazily creates (and reuses) one
// AudioContext, created on first call rather than at module load, since most browsers refuse to
// start an AudioContext before any user gesture on the page - by the time this can fire (a replay
// tick), the user has already clicked Load/Start, which satisfies that.
let sharedAudioCtx = null
function playBeep() {
  try {
    sharedAudioCtx ??= new (window.AudioContext || window.webkitAudioContext)()
    const ctx = sharedAudioCtx
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 880
    gain.gain.setValueAtTime(0.001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35)
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.35)
  } catch {
    // Audio unavailable/blocked - the visual alert banner still shows either way, so this is not
    // the only way the user finds out.
  }
}

// The classic Max Pain read: the strike where option WRITERS (as a whole, both legs) would owe the
// least if the underlying settled there today - candidates are exactly the strikes this run actually
// has OI for, since anywhere else is not a real strike price to consider.
function computeMaxPain(rows) {
  if (rows.length === 0) return null
  let best = null
  let bestPain = Infinity
  for (const candidate of rows) {
    let pain = 0
    for (const row of rows) {
      if (row.ceOi) pain += row.ceOi * Math.max(0, candidate.strike - row.strike)
      if (row.peOi) pain += row.peOi * Math.max(0, row.strike - candidate.strike)
    }
    if (pain < bestPain) { bestPain = pain; best = candidate.strike }
  }
  return best
}

// EmaChart's own timeframe choices - a subset of the shared TIMEFRAME_OPTIONS (1/3/5 min only, no
// 15) since the whole point of this second chart is a FASTER read than the main chart's own
// (typically 15-min) timeframe for timing entries - the user's own explicit "1-3-5min" ask.
const FAST_TIMEFRAME_OPTIONS = TIMEFRAME_OPTIONS.filter((o) => o.value <= 5)

// Every major OPTIONAL section on this page - the user's own "give option to remove everything...
// by default all sections true, and we can select to include" ask, for a big-monitor layout where
// the three charts (15/3/1 min) matter most and the heuristic/summary cards underneath them are
// optional clutter on any given day. All start checked; unchecking one just stops that Card from
// rendering at all, nothing about its own data or state. The main Spot chart itself is deliberately
// NOT in this list - it's the one Card holding the shared playback controls (Start/Pause/Reset/
// Speed/timeline slider) every other chart on the page (including both fast entry charts) depends
// on, so hiding it would strand the whole page with no way to advance the replay at all.
const SECTION_OPTIONS = [
  { value: 'topStats', label: 'Top stats' },
  { value: 'marketRead', label: 'Market Read' },
  { value: 'dayOi', label: 'Day OI Accumulation' },
  { value: 'oiHeatmap', label: 'OI change heatmap (all strikes)' },
  { value: 'entryCharts', label: 'Fast entry charts (3/1 min)' },
  { value: 'optionPremium', label: 'Option premium (CE/PE)' },
  { value: 'liquidityMap', label: 'Liquidity map' },
  { value: 'futures', label: 'Futures' },
]
const ALL_SECTION_VALUES = SECTION_OPTIONS.map((o) => o.value)

// The page's own top-level draggable blocks, in DEFAULT order - see useCardOrder's own doc comment
// for why the actual render order comes from that hook, not this literal order, once the user has
// ever dragged anything. Deliberately a SEPARATE, coarser list than SECTION_OPTIONS above (which
// toggles visibility) - 'spotAndEntry' bundles three individually-titled Cards (Spot/Entry B/Entry
// C) that already share one responsive Row (see its own doc comment on the wide-monitor 3-up
// layout), and 'ladder' is never hidden by SECTION_OPTIONS at all but is still reorderable.
const OI_REPLAY_CARD_IDS = ['topStats', 'marketRead', 'dayOi', 'oiHeatmap', 'spotAndEntry', 'optionPremium', 'ladder', 'liquidityMap', 'futures']

// How many strikes on EACH side get an actual line drawn on the chart - the ladder already shows
// every strike; the chart would just be noise at that density, so only the strongest few (by OI)
// per side earn a line there. Support/resistance is a relative-strength read anyway. Also the
// MINIMUM count ReplayChart's own ATM-centered window widens to find - see that component's own
// doc comment on why "at least 5, always" needed an adaptive window rather than a fixed one.
const CHART_LEVELS_PER_SIDE = 5

// The widest ReplayChart's own candidate window is ever allowed to grow to hunt for
// CHART_LEVELS_PER_SIDE strikes with real OI - matches the backend's own StrikeBandSteps (the
// fetched band's own half-width), since a window wider than that would just be band strikes that
// were never actually fetched.
const CHART_MAX_WINDOW_STEPS = 10

// How big a since-PREVIOUS-CANDLE OI/price move has to be before FuturesChart marks it as a real
// regime shift rather than noise - a futures contract's own total OI is a totally different scale
// from a single option strike's (tens of millions vs a single strike's few million), so this is
// its own dedicated threshold rather than reusing the options ladder's per-strike alertThreshold.
// PRICE_STEP_FACTOR is a fraction of the underlying's own strike step (already a sensible "is this
// a real move" unit elsewhere on this page), not a fixed point value, so it scales automatically
// between NIFTY (step 50) and BANKNIFTY (step 100).
const FUTURES_REGIME_OI_THRESHOLD = 50_000
const FUTURES_REGIME_PRICE_STEP_FACTOR = 0.2

// latestAtOrBefore always returns the newest point at-or-before "now", even if that point is from
// an hour ago - if NiftyDataCollector's own backfill for a strike/side simply has no newer rows yet
// (a real gap in the stored data, not a rendering bug), the ladder/chart would otherwise silently
// keep repeating that same last-known reading forever, looking exactly like "the page froze" with
// nothing in the UI to say why. Anything older than this, relative to the replay's current time, is
// flagged stale (dimmed + a "no update since HH:MM" tooltip) instead of being shown as if live.
const OI_STALE_MS = 5 * 60_000

// How far the ladder's own "prior" (one-minute-ago) reference point is allowed to sit BEFORE the
// exact minute-ago mark and still count as "one minute ago" for the OiChange/Large-OI-shift-alert
// figures - not the same thing as OI_STALE_MS above (which flags the CURRENT reading as frozen).
// latestAtOrBefore(series, priorMs) returns the LATEST point at or before priorMs regardless of how
// far back that actually is - if the live feed had a real gap (a Dhan reconnect affecting the whole
// subscribed strike band at once, or simply the seam between backfilled and live data), that "prior"
// point can silently be many minutes old. The resulting delta is real, but every strike on the chain
// would then report a big change "in the last minute" at the exact same tick once the feed catches
// up - a coordinated false alarm, not an actual sudden move. Confirmed for real: a reported "Large OI
// shift near ATM" alert firing on ~10 strikes at once, all unwinding, all in the same tick.
const PRIOR_MINUTE_TOLERANCE_MS = 90_000

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// Linear interpolation between a light and a dark shade, t in [0,1] - t=0 is the lightest (weakest
// OI among the levels actually drawn), t=1 the darkest (heaviest, "hardest" wall). Used for both
// the resistance (red) and support (green) lines below with their own two endpoints.
function shade(lightHex, darkHex, t) {
  const [lr, lg, lb] = hexToRgb(lightHex)
  const [dr, dg, db] = hexToRgb(darkHex)
  const r = Math.round(lr + (dr - lr) * t)
  const g = Math.round(lg + (dg - lg) * t)
  const b = Math.round(lb + (db - lb) * t)
  return `rgb(${r}, ${g}, ${b})`
}

// lightweight-charts' price-line `title` renders as a text label whose background box auto-sizes to
// fit its OWN TEXT, not to any data value - so varying lineWidth/color alone (as this chart used to)
// never produces a visible "length" difference, since the label itself is the dominant element and
// every label is roughly the same string length regardless of OI. Block characters baked directly
// into the title text are the only way to get a genuinely variable-length visual inside that API -
// this renders as a little inline bar-chart before the strike, e.g. "R ██████░░░░ 23400 (11.94M OI)".
const OI_BAR_BLOCKS = 10
function oiBarText(t, maxBlocks = OI_BAR_BLOCKS) {
  const filled = Math.max(1, Math.min(maxBlocks, Math.round(t * maxBlocks)))
  return '█'.repeat(filled) + '░'.repeat(maxBlocks - filled)
}

const RESISTANCE_LIGHT = '#ffb3b3'
const RESISTANCE_DARK = '#7a0000'
const SUPPORT_LIGHT = '#b3f0c2'
const SUPPORT_DARK = '#0a5c1f'

// Candlestick chart that reveals `bars` progressively as the replay advances - a single visibleCount
// controls exactly how many of the (already-loaded) day's bars are shown, so playback needs no
// further data fetch, just a local re-render. Also draws the strongest OI levels on each side as
// horizontal price lines directly on the chart (darker = heavier OI = a "harder" level) - the same
// data the ladder shows in table form, here as the market-structure read on the price chart itself.
// Long enough for the second click of a double-click to arrive (see ReplayChart's click handler).
const STRIKE_CLICK_DELAY_MS = 300

function ReplayChart({ bars, ladderRows, dayKey, atmStrike, step, top5Only = true, vwapSeries = EMPTY_ARRAY, showVwap = false, onStrikeClick, height = 440 }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const vwapSeriesRef = useRef(null)
  // Refs, not effect dependencies - clicking is wired up once in the chart-creation effect below
  // ([height] only), so a new onStrikeClick/step on every render (step rarely changes; onStrikeClick
  // is an inline arrow function at the call site) must not tear down and recreate the whole chart.
  const onStrikeClickRef = useRef(onStrikeClick)
  onStrikeClickRef.current = onStrikeClick
  const stepRef = useRef(step)
  stepRef.current = step
  const priceLinesRef = useRef([])

  // Same ATM-centered adaptive window the price lines below are drawn from - memoized so the
  // render's own CE/PE delta tags (see the bottom of this component) read the EXACT SAME top
  // strikes the chart just drew as R/S, rather than picking a possibly different pair.
  //
  // ceTop/peTop are always each independently ranked (the strongest 5 CE-OI strikes, the strongest 5
  // PE-OI strikes anywhere in the fetched band) - used for ceLead/peLead below (the single heaviest
  // wall PER SIDE, for the left-edge delta tags) regardless of top5Only, since "the single strongest
  // wall" is a well-defined idea either way.
  //
  // topRows is the DRAWING set, and IS what top5Only switches: true (the default) keeps it to the
  // union of ceTop/peTop, each entry carrying its OWN ceOi AND peOi so both R and S are drawn for
  // every row in it (the user's own earlier "at each level, buying and selling both should be
  // shown" ask) - still capped to the 5 strongest per side so the chart stays readable. false shows
  // EVERY strike in the whole fetched band with real OI on either side, no ranking or cap at all -
  // the user's own "switch ... if true show top 5 else all wall" ask.
  const { ceTop, peTop, topRows } = useMemo(() => {
    if (!ladderRows || ladderRows.length === 0 || atmStrike == null || !step) return { ceTop: [], peTop: [], topRows: [] }
    const findTop = (key) => {
      for (let windowSteps = CHART_LEVELS_PER_SIDE; windowSteps <= CHART_MAX_WINDOW_STEPS; windowSteps++) {
        const candidates = ladderRows.filter((r) => Math.abs(r.strike - atmStrike) <= step * windowSteps && (r[key] ?? 0) > 0)
        if (candidates.length >= CHART_LEVELS_PER_SIDE || windowSteps === CHART_MAX_WINDOW_STEPS)
          return candidates.sort((a, b) => (b[key] ?? 0) - (a[key] ?? 0)).slice(0, CHART_LEVELS_PER_SIDE)
      }
      return []
    }
    const ceTop = findTop('ceOi')
    const peTop = findTop('peOi')

    if (!top5Only) {
      const allWalls = ladderRows.filter((r) =>
        Math.abs(r.strike - atmStrike) <= step * CHART_MAX_WINDOW_STEPS && ((r.ceOi ?? 0) > 0 || (r.peOi ?? 0) > 0))
      return { ceTop, peTop, topRows: allWalls }
    }

    const byStrike = new Map()
    for (const row of [...ceTop, ...peTop]) byStrike.set(row.strike, row)
    return { ceTop, peTop, topRows: [...byStrike.values()] }
  }, [ladderRows, atmStrike, step, top5Only])

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createZoomableChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      // A bigger fontSize than the page's other charts - the OI-wall price-line labels here carry
      // the strike, OI, IV and now separate Δ/S-R badges, all crammed against the right axis, and
      // the user's own "labels bit bigger, [I] can see it" ask was specifically about this chart.
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 13 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR, scaleMargins: CANDLE_SCALE_MARGINS },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    seriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
    })
    vwapSeriesRef.current = chart.addSeries(LineSeries, { color: VWAP_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'VWAP' })

    // Click-to-drill-down: rounds whatever price was clicked to the nearest tracked strike (the same
    // step every other strike-rounding on this page uses), regardless of whether that exact level
    // happens to have an OI-wall price line drawn on it right now - every strike in the fetched band
    // has its own ceByStrike/peByStrike history, walled or not, so this works anywhere on the chart.
    //
    // Opened a moment after the click rather than at once, so a double-click (which resets the
    // chart's view - see useChartUserControl) isn't swallowed: the popup opening on its first click
    // put its backdrop under the second one.
    let pendingStrikeClick = null
    chart.subscribeDblClick(() => { clearTimeout(pendingStrikeClick) })
    chart.subscribeClick((param) => {
      clearTimeout(pendingStrikeClick)
      if (!param.point || !seriesRef.current || !stepRef.current) return
      const price = seriesRef.current.coordinateToPrice(param.point.y)
      // A click landing on the price axis/label margin (exactly where the R/S wall labels render)
      // can hand back a value outside the series' own plotted range - not always a plain number.
      // Guarded explicitly (rather than trusting `price == null` alone) after a real report of this
      // click crashing the whole app: a non-finite strike reaching setDrilldownStrike downstream
      // would render a broken title/lookup with nothing to show for it.
      if (price == null || !Number.isFinite(price)) return
      const strike = Math.round(price / stepRef.current) * stepRef.current
      if (!Number.isFinite(strike)) return
      pendingStrikeClick = setTimeout(() => onStrikeClickRef.current?.(strike), STRIKE_CLICK_DELAY_MS)
    })

    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) }
    // ResizeObserver, not a plain window 'resize' listener: on mobile, a chart's own container
    // can still read a stale/zero clientWidth at the moment this effect runs (layout not yet
    // settled - address bar show/hide, a not-yet-laid-out flex/card ancestor, fonts still
    // loading), and nothing but an actual BROWSER WINDOW resize ever fired the old listener - a
    // real report ("looks to be mobile only... when squeezing resolution it started working")
    // was exactly this: resizing the window was the only thing that ever re-measured the chart.
    // ResizeObserver fires once immediately on observe() with the container's ACTUAL current
    // size, then again on every later layout change, not just a window-level resize.
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(containerRef.current)
    return () => {
      resizeObserver.disconnect()
      clearTimeout(pendingStrikeClick)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      vwapSeriesRef.current = null
      priceLinesRef.current = [] // the series they belonged to is gone along with the chart
    }
  }, [height])

  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setData(bars)
  }, [bars])

  // Fed only while checked, empty otherwise - on the candles' own times (chartVwap): a 1-minute /
  // multi-day VWAP series adds time points the candles do not have and squeezes them into a corner.
  useEffect(() => {
    vwapSeriesRef.current?.setData(showVwap ? chartVwap(bars, vwapSeries) : EMPTY_ARRAY)
  }, [vwapSeries, showVwap, bars])

  // Re-fits to the WHOLE day so far as it grows, not just once when it first loads - see
  // useFitContentAsDataGrows' own doc comment. Only while the viewer is already at the live edge,
  // so a deliberate pan/zoom/scroll during playback to inspect an earlier stretch is left alone -
  // the "should be able to zoom in/out" ask still holds, this just stops the DEFAULT view from
  // staying frozen at whatever few bars existed the moment the day was first loaded.
  useFitContentAsDataGrows(chartRef, bars.length, dayKey)

  // Redraws the strongest CHART_LEVELS_PER_SIDE (5) resistance (CE OI) / support (PE OI) lines on
  // every tick, since OI itself changes as the replay advances AND which strikes even qualify
  // shifts as ATM moves - always clears the previous set first rather than trying to diff/reuse
  // handles, since "top 5" can change entirely from one tick to the next.
  //
  // Candidates are ranked within a window CENTERED ON ATM (not the day's own realized high/low),
  // widened one strike-step at a time until at least CHART_LEVELS_PER_SIDE candidates qualify (or
  // the fetched band - +-10 steps - is exhausted) - two real problems this fixes together:
  //   1. A day-range-based window is fixed for the whole day and doesn't move with price, so once
  //      ATM has drifted away from where the day opened, "the 5 strongest levels" silently stopped
  //      being the 5 strongest levels NEAR PRICE - the user's own "as soon as price shifts you add
  //      or remove new ones" ask.
  //   2. A FIXED window width (even an ATM-centered one) still under-fills to fewer than 5 lines
  //      whenever a quiet stretch or a data gap leaves too few non-zero strikes inside it - this
  //      widens just as far as actually needed to reach 5, rather than an always-maximal band that
  //      would reintroduce the original "candle axis squashed by a far-away strike" bug (see
  //      CHART_MAX_WINDOW_STEPS's own comment) or an always-narrow one that under-fills.
  useEffect(() => {
    if (!seriesRef.current) return
    for (const line of priceLinesRef.current) seriesRef.current.removePriceLine(line)
    priceLinesRef.current = []
    if (topRows.length === 0) return

    // ONE shared scale across BOTH sides, not one independently computed per side - drawing R and
    // S lines with their own separate scale meant a 33M PE level could render THINNER than a 17M
    // CE level (each was only ranked against its own side's other four candidates), which is
    // exactly backwards and misleading to read at a glance. A strike's line thickness/darkness on
    // this chart now means the same thing everywhere on it, CE or PE.
    //
    // t is a TRUE proportion of the absolute value (row[key] / maxOi), not a min-max stretch
    // between the weakest and strongest of the five shown (the earlier (value-min)/(max-min) form)
    // - that stretch always forced the weakest candidate down to the thinnest/lightest line and the
    // strongest up to the thickest/darkest regardless of how close together their real OI actually
    // was, which is exactly the "shown out of proportion" the user's own screenshots were catching.
    // Same formula the ladder's own bar width already uses (row.xxOi / maxOi), for the same reason.
    const allOi = [...topRows.map((r) => r.ceOi ?? 0), ...topRows.map((r) => r.peOi ?? 0)]
    const maxOi = allOi.length > 0 ? Math.max(...allOi) : 0

    // Both calls below now iterate the SAME topRows (the union, see this component's own doc
    // comment on ceTop/peTop/topRows) - a row that only qualified via its OTHER side still gets ITS
    // OWN line drawn here, using whatever real OI it has on THIS side, however modest - "at each
    // level, both buying and selling should be shown", not just whichever side independently ranked
    // in the top 5. A side with genuinely zero OI (never collected/never traded) still draws nothing
    // for it - there is no real level to show there.
    const drawSide = (rows, key, ivKey, staleKey, sinceOpenKey, lightColor, darkColor, labelPrefix) => {
      for (const row of rows) {
        if ((row[key] ?? 0) <= 0) continue
        const t = maxOi > 0 ? row[key] / maxOi : 1
        // A stale level (see OI_STALE_MS) is a real OI reading, just a frozen one - still worth
        // drawing (it's the last known wall), but visually muted and labeled so it doesn't look
        // like a live, currently-updating level when the underlying data has stopped arriving.
        const stale = row[staleKey]
        // The actual change since today's open (row[sinceOpenKey] IS current - open, already
        // computed by ladderRows) - shown right in the on-chart label (a price line's title renders
        // directly on the chart, not just on hover) so EVERY drawn level's own delta is visible, not
        // just the single strongest one called out in the left-side overlay tag above this chart.
        // This used to back it out INTO the raw open-of-day value instead ("open +13.61M") which
        // read like a delta but wasn't one - the user's own "show delta at each level" ask.
        const sinceOpen = row[sinceOpenKey]
        // Current support-minus-resistance OI at this level (peOi - ceOi right now - a DIFFERENT,
        // complementary number from the since-open Δ below) folded into this SAME line's title,
        // rather than a separate price line per number: splitting Δ/S-R into their own axis-label
        // badges tripled the number of rows stacked on the price axis (one for the wall, one for Δ,
        // one for S-R, at every single strike) and turned the ladder into unreadable clutter - a
        // real, screenshot-caught regression. Back to one combined, larger-font (see this chart's own
        // fontSize) label per line.
        const srDiff = (row.peOi ?? 0) - (row.ceOi ?? 0)
        const line = seriesRef.current.createPriceLine({
          price: row.strike,
          color: stale ? `${shade(lightColor, darkColor, t)}80` : shade(lightColor, darkColor, t),
          lineWidth: 1 + Math.round(t * 2), // thicker as OI (and darkness) increases too
          lineStyle: stale ? 1 : 2, // dotted when stale, dashed when live
          axisLabelVisible: true,
          title: `${labelPrefix} ${oiBarText(t)} ${row.strike} (${formatOiMillions(row[key])} OI${row[ivKey] != null ? `, IV ${row[ivKey].toFixed(1)}` : ''}${sinceOpen != null ? `, Δ ${formatOiMillions(sinceOpen, { signed: true })}` : ''}, S-R ${formatOiMillions(srDiff, { signed: true })})${stale ? ' [STALE]' : ''}`,
        })
        priceLinesRef.current.push(line)
      }
    }

    drawSide(topRows, 'ceOi', 'ceIv', 'ceStale', 'ceOiSinceOpen', RESISTANCE_LIGHT, RESISTANCE_DARK, 'R')
    drawSide(topRows, 'peOi', 'peIv', 'peStale', 'peOiSinceOpen', SUPPORT_LIGHT, SUPPORT_DARK, 'S')
  }, [topRows])

  // The single heaviest strike on each side - the actual level just drawn as "R"/"S" above - read as
  // a bullish/bearish tag from its OI change since today's open: rising CALL OI means fresh call
  // writing defending that resistance (bearish), rising PUT OI means fresh put writing defending
  // that support (bullish) - the standard option-OI reading, mirroring classifyFuturesRegime's own
  // price/OI read for futures below. Rendered as plain HTML on the LEFT edge of the chart (not
  // another lightweight-charts price line) since the price-line labels already crowd the right edge
  // - the user's own "right side become too noisy" complaint - so this is deliberately a second,
  // separate visual channel rather than one more thing stacked into that same corner.
  const ceLead = ceTop[0] ?? null
  const peLead = peTop[0] ?? null
  const ceDelta = ceLead?.ceOiSinceOpen ?? null
  const peDelta = peLead?.peOiSinceOpen ?? null
  const ceBias = ceDelta ? (ceDelta > 0 ? 'bearish' : 'bullish') : null
  const peBias = peDelta ? (peDelta > 0 ? 'bullish' : 'bearish') : null
  const biasColor = (bias) => (bias === 'bullish' ? UP_COLOR : bias === 'bearish' ? DOWN_COLOR : AXIS_COLOR)
  const deltaTagStyle = (bias) => ({
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 6px',
    borderRadius: 4,
    background: '#00000080',
    color: biasColor(bias),
    border: `1px solid ${biasColor(bias)}`,
  })

  return (
    <div style={{ position: 'relative', width: '100%', height, overflow: 'hidden' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {(ceLead || peLead) && (
        <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', flexDirection: 'column', gap: 4, pointerEvents: 'none' }}>
          {ceLead && <span style={deltaTagStyle(ceBias)}>R {ceLead.strike} Δ {formatOiMillions(ceDelta, { signed: true })}</span>}
          {peLead && <span style={deltaTagStyle(peBias)}>S {peLead.strike} Δ {formatOiMillions(peDelta, { signed: true })}</span>}
        </div>
      )}
    </div>
  )
}

// The strike drill-down popup's own chart - CE and PE as two series, either both LineSeries (mode
// 'total': the plain OI level, one point per minute) or both HistogramSeries (mode 'change': the
// per-minute delta from computeOiChangeSeries, positive bars above zero when OI is being added,
// negative below when it's unwinding - the "where has it been added" read a single since-open number
// can't show). Rebuilds the whole chart on a mode switch rather than trying to swap a series' type
// in place - lightweight-charts has no such API, and a mode change is a deliberate tab click, not a
// live-tick-rate event, so the small recreation cost here is a non-issue.
function StrikeOiDrilldownChart({ ceSeries, peSeries, mode, dayKey, height = 320 }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const ceSeriesRef = useRef(null)
  const peSeriesRef = useRef(null)

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
      // OI in millions on the axis and crosshair (5.96M, not 5962385.00). The per-minute change
      // chart keeps a third decimal - a single minute's change is often well under 0.01M.
      localization: { timeFormatter: istTimeFormatter, priceFormatter: (v) => formatOiMillionsAxis(v, mode === 'change') },
    })
    chartRef.current = chart
    if (mode === 'total' || mode === 'sinceOpen') {
      // sinceOpen is still a plain LINE, same as total - a running Δ-from-open is exactly as
      // continuous as the raw level it's derived from (see toSinceOpenSeries), just re-based to
      // start at zero instead of at the day's actual opening OI. Only the title changes.
      const title = mode === 'sinceOpen' ? 'CE OI Δ (since open)' : 'CE OI'
      const peTitle = mode === 'sinceOpen' ? 'PE OI Δ (since open)' : 'PE OI'
      // DOWN_COLOR/UP_COLOR (this app's own bearish/bullish convention), not CE_COLOR/PE_COLOR (a
      // plain "tell the two lines apart" identity pair used for premium/price charts elsewhere) -
      // OI specifically reads by option-SELLING convention: rising CE (call) OI is fresh call
      // writing, bearish; rising PE (put) OI is fresh put writing, bullish. Matches ReplayChart's
      // own R/S wall colors (RESISTANCE=CE=red-ish, SUPPORT=PE=green-ish) further up this same page.
      ceSeriesRef.current = chart.addSeries(LineSeries, { color: DOWN_COLOR, lineWidth: 2, title, priceLineVisible: false })
      peSeriesRef.current = chart.addSeries(LineSeries, { color: UP_COLOR, lineWidth: 2, title: peTitle, priceLineVisible: false })
    } else {
      // Two independent histograms on the SAME chart, CE on its own price scale in the top half and
      // PE on its own in the bottom half (own scaleMargins so they don't overlap) - that vertical
      // position is what tells CE and PE apart here, freeing color up to answer the actual "where is
      // it being added vs removed" ask instead: each BAR is colored by its own sign in the setData
      // effect below (OI_ADDED_COLOR when OI grew that minute, OI_REMOVED_COLOR when it shrank) -
      // deliberately blue/orange, not this app's own green/red up/down convention, since ReplayChart's
      // OI-wall price lines right next to this popup already use red/green for a different meaning
      // (see OI_ADDED_COLOR's own doc comment).
      ceSeriesRef.current = chart.addSeries(HistogramSeries, { title: 'CE OI Δ', priceLineVisible: false, priceScaleId: 'ce-change' })
      peSeriesRef.current = chart.addSeries(HistogramSeries, { title: 'PE OI Δ', priceLineVisible: false, priceScaleId: 'pe-change' })
      chart.priceScale('ce-change').applyOptions({ scaleMargins: { top: 0.1, bottom: 0.5 } })
      chart.priceScale('pe-change').applyOptions({ scaleMargins: { top: 0.5, bottom: 0.1 } })
    }

    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) }
    // ResizeObserver, not a plain window 'resize' listener: on mobile, a chart's own container
    // can still read a stale/zero clientWidth at the moment this effect runs (layout not yet
    // settled - address bar show/hide, a not-yet-laid-out flex/card ancestor, fonts still
    // loading), and nothing but an actual BROWSER WINDOW resize ever fired the old listener - a
    // real report ("looks to be mobile only... when squeezing resolution it started working")
    // was exactly this: resizing the window was the only thing that ever re-measured the chart.
    // ResizeObserver fires once immediately on observe() with the container's ACTUAL current
    // size, then again on every later layout change, not just a window-level resize.
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(containerRef.current)
    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
      ceSeriesRef.current = null
      peSeriesRef.current = null
    }
  }, [height, mode])

  const userControlRef = useChartUserControl(chartRef, `${dayKey}-${mode}`)

  useEffect(() => {
    if (!ceSeriesRef.current || !peSeriesRef.current) return
    // 'total'/'sinceOpen' are a plain level - the series' own flat DOWN_COLOR/UP_COLOR (set at
    // series-creation time above) already applies with no per-point override needed. 'change' colors each bar by its OWN
    // sign - added (OI grew that minute) vs removed (OI shrank) - see this component's own doc
    // comment on why that, not a flat per-series color, is what actually answers "where is it being
    // added/removed."
    const withDirectionColor = (series) => mode === 'change' ? series.map((p) => ({ ...p, color: p.value >= 0 ? OI_ADDED_COLOR : OI_REMOVED_COLOR })) : series
    // Auto-fits to the whole series only until the viewer zooms/drags (see useChartUserControl) -
    // this used to fitContent() on EVERY update, and with live data arriving several times a second
    // any zoom or scroll-back snapped back to the full day before a value could be read.
    // Once they have, the view stays exactly where they put it - not even following the newest bar.
    const heldRange = userControlRef.current ? chartRef.current?.timeScale().getVisibleLogicalRange() : null
    ceSeriesRef.current.setData(withDirectionColor(ceSeries))
    peSeriesRef.current.setData(withDirectionColor(peSeries))
    if (!userControlRef.current) {
      if (ceSeries.length > 0 || peSeries.length > 0) chartRef.current?.timeScale().fitContent()
    } else if (heldRange) {
      chartRef.current?.timeScale().setVisibleLogicalRange(heldRange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ceSeries, peSeries, mode, dayKey])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// Deliberately NOT UP_COLOR/DOWN_COLOR (this page's own green/red convention for a bullish/bearish
// or gain/loss read) - ReplayChart's own OI-wall price lines already use red (RESISTANCE_LIGHT/DARK,
// the CE side) and green (SUPPORT_LIGHT/DARK, the PE side) for a COMPLETELY different meaning (which
// side, and how heavy). Reusing red/green here for "added vs removed" on the same page risks a
// reader carrying one chart's meaning into the other - a strike whose wall renders red is a CE wall,
// not "OI being removed," but a green/red change chart right next to it invites exactly that
// conflation. Blue/orange instead: this app's own categorical palette's first two hues, an entirely
// different hue family from the wall convention, so "which encoding am I looking at" is never
// ambiguous. Validated as a CVD-safe pair against this app's real dark chart surface (#0d0e12):
// worst-pair ΔE 26.8 protan / 31.8 normal-vision, both clear of the dataviz method's 8/15 targets.
const OI_ADDED_COLOR = '#3987e5'
const OI_REMOVED_COLOR = '#d95926'

// One color, opacity-scaled by magnitude, per pole - the diverging encoding: OI_ADDED_COLOR at low
// alpha for a small change, ramping toward full alpha at the grid's own typical-large |change| (see
// heatmapScale) - so intensity is always relative to what this specific view is actually
// showing, not some fixed absolute scale that would wash out on a quiet day and clip on a violent
// one. OI_REMOVED_COLOR mirrors it for OI being removed.
const HEATMAP_MIN_ALPHA = 0.12
const HEATMAP_MAX_ALPHA = 0.9
const LIVE_COLUMN_OUTLINE_COLOR = 'rgba(255, 255, 255, 0.55)'

// The heatmap's own bucket size - independent of every other timeframe picker on this page (chart B,
// the Total OI Lookback table), since none of those need a sub-minute option and this one specifically
// does: OI ticks arrive whenever the feed updates, not neatly once a minute, so without a real bucket
// size every raw tick became its own column (see aggregateLinePoints' own doc comment for the "tick by
// tick instead of a real timeframe" report this fixes). 1 min is the finest offered: the REST history
// and the live feed both keep one point per strike per minute (see LIVE_POINT_SLOT_MS).
const HEATMAP_TIMEFRAME_OPTIONS = [
  { value: 1, label: '1 min' },
  { value: 3, label: '3 min' },
]

// Strike x minute OI-change grid for one side (CE or PE) - the all-strikes counterpart to the
// single-strike drill-down popup's own "Per-minute change" tab. A native scrollable HTML table
// rather than a lightweight-charts series: lightweight-charts has no heatmap/cell series type, and a
// table gives free horizontal scroll, a sticky strike column, and a native per-cell hover tooltip
// (the exact value, satisfying the "every value must be reachable, not just implied by color" rule)
// with no extra plumbing. Defaults scrolled to the newest minute so a live/"today" view doesn't open
// showing 9:15 AM while ticks are landing at 2 PM.
// Cell/row geometry, fixed rather than responsive - a heatmap this dense (up to ~375 one-minute
// columns for a full session) needs a stable pixel grid to draw and hit-test against; letting it
// stretch to the container would make every column a different width depending on how many strikes
// happen to be tracked that day, and the axis math below would have to recompute constantly instead
// of being simple arithmetic.
const HEATMAP_CELL_WIDTH = 14
const HEATMAP_ROW_HEIGHT = 20
const HEATMAP_LABEL_WIDTH = 64
const HEATMAP_AXIS_HEIGHT = 20

// The all-strikes OI-change plot - a genuine rendered chart (HTML5 canvas), not a table dressed up
// with cell colors: an actual x/y grid with real axes (strike rows down the left, time columns along
// the bottom) and a live hover readout, matching how every other chart on this page works. Canvas
// instead of one lightweight-charts series per strike (which would mean up to ~21 separate chart
// instances, one per row) or a DOM table (which means literally thousands of <td> elements for a
// full session) - one canvas draws the whole grid as pixels, which is both the simplest way to get a
// real heatmap out of a library with no native heatmap series type, and the cheapest to render at
// this cell count. The strike-label column is plain HTML (not baked into the canvas) so it can stay
// visually fixed while only the canvas itself scrolls horizontally through the day.
function OiChangeHeatmapPlot({ label, byStrike, strikes, atmStrike, asOfMs, timeframeMinutes, live = false }) {
  const canvasRef = useRef(null)
  const scrollRef = useRef(null)
  const [hover, setHover] = useState(null)
  const { buckets, perStrikeChange } = useMemo(
    () => buildOiChangeMatrix(byStrike, strikes, asOfMs, timeframeMinutes),
    [byStrike, strikes, asOfMs, timeframeMinutes],
  )
  // Newest minute on the LEFT, older minutes running off to the right - the latest activity is
  // what's read first, right next to the strike labels, instead of at the far end of a long scroll.
  const columns = useMemo(() => [...buckets].reverse(), [buckets])
  // istTimeFormatter (hour:minute only) reads two distinct 30-second buckets as the identical label -
  // fine at 1 min/3 min, where every column IS a distinct minute, but exactly the "same time shown
  // over and over" look at the 30 sec option unless seconds are shown too.
  const formatBucketTime = timeframeMinutes < 1 ? istTimeWithSecondsFormatter : istTimeFormatter

  const maxAbs = useMemo(() => heatmapScale(perStrikeChange), [perStrikeChange])

  // `strikes` is the UNION of every strike EITHER side has ever reported (see heatmapStrikes' own
  // doc comment) - a strike with real PE activity but that this side (say CE) has simply never
  // ticked for renders as a genuinely, entirely empty row here, not a bug: buildOiChangeMatrix gives
  // it an empty Map (nothing to compute a delta FROM), so every cell in its row correctly has
  // nothing to draw. Tracked separately from maxAbs === 0 (below) - that's "every row is flat",
  // this is "THIS row specifically has no data at all" - so the row's own label can say so instead
  // of leaving a blank row that reads exactly like a rendering glitch.
  const strikesWithNoData = useMemo(() => {
    const set = new Set()
    for (const strike of strikes) if ((perStrikeChange.get(strike)?.size ?? 0) === 0) set.add(strike)
    return set
  }, [strikes, perStrikeChange])

  // The whole grid's own totals - every strike, every minute this side has revealed so far, summed
  // rather than left to only ever be read cell by cell. `removed` is kept as the NEGATIVE sum (so
  // `delta = added + removed` falls out directly) and only flipped to a positive magnitude for
  // display, matching how the per-cell tooltip and Day OI Accumulation card both already show
  // "removed" as a magnitude, not a signed figure that would otherwise read as "still positive".
  const totals = useMemo(() => {
    let added = 0
    let removed = 0
    for (const byBucket of perStrikeChange.values())
      for (const v of byBucket.values()) {
        if (!Number.isFinite(v)) continue
        if (v > 0) added += v
        else if (v < 0) removed += v
      }
    return { added, removed, delta: added + removed }
  }, [perStrikeChange])

  const plotWidth = buckets.length * HEATMAP_CELL_WIDTH
  const plotHeight = strikes.length * HEATMAP_ROW_HEIGHT

  // Redraws the whole grid whenever the underlying matrix changes - a plain fillRect per cell, no
  // retained shapes to diff, so a full redraw on every live tick is cheap (a canvas clear + a few
  // thousand rectangle fills is well under a frame budget) and much simpler than trying to patch
  // individual cells in place.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || buckets.length === 0 || strikes.length === 0) return
    const dpr = window.devicePixelRatio || 1
    const totalHeight = plotHeight + HEATMAP_AXIS_HEIGHT
    canvas.width = plotWidth * dpr
    canvas.height = totalHeight * dpr
    canvas.style.width = `${plotWidth}px`
    canvas.style.height = `${totalHeight}px`
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, plotWidth, totalHeight)

    strikes.forEach((strike, row) => {
      const byBucket = perStrikeChange.get(strike)
      const y = row * HEATMAP_ROW_HEIGHT
      columns.forEach((t, col) => {
        const v = byBucket?.get(t)
        if (v == null || v === 0 || maxAbs === 0) return
        const alpha = HEATMAP_MIN_ALPHA + Math.min(1, Math.abs(v) / maxAbs) * (HEATMAP_MAX_ALPHA - HEATMAP_MIN_ALPHA)
        // Added vs removed, by SIGN - not a fixed per-card color the way the CE/PE identity is
        // encoded elsewhere (Total OI/Since-open Δ charts). Side is already unambiguous here without
        // needing color for it at all: this plot always renders once per side, in its OWN card,
        // labeled "CE" or "PE" in the card title - so the cell color is free to answer a DIFFERENT
        // question this specific view exists for ("where has OI been added vs pulled, minute by
        // minute"), the one thing a fixed-hue-by-side scheme would have hidden entirely. A real "how
        // do you show OI removed, I need to tell them apart" report confirmed exactly that gap.
        ctx.fillStyle = hexToRgba(v > 0 ? OI_ADDED_COLOR : OI_REMOVED_COLOR, alpha)
        ctx.fillRect(col * HEATMAP_CELL_WIDTH, y, HEATMAP_CELL_WIDTH - 1, HEATMAP_ROW_HEIGHT - 1)
      })
    })

    // While live, the newest (leftmost) column is the bucket still filling - outlined so it's
    // obvious which column is updating right now (a quiet bucket has no colored cells yet, which
    // otherwise reads as nothing happening).
    if (live) {
      ctx.strokeStyle = LIVE_COLUMN_OUTLINE_COLOR
      ctx.lineWidth = 1
      ctx.strokeRect(0.5, 0.5, HEATMAP_CELL_WIDTH - 1, plotHeight - 1)
    }

    // Time axis along the bottom - one label roughly every 60px regardless of cell width, so it
    // never crowds even at the full 375-column width of a whole session.
    ctx.fillStyle = AXIS_COLOR
    ctx.font = '10px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'center'
    const labelEvery = Math.max(1, Math.round(60 / HEATMAP_CELL_WIDTH))
    // The first (newest) label starts at the left edge instead of centering on its cell, which
    // would push half of it off the canvas; any label that would then overlap the one before it is
    // skipped rather than drawn on top of it.
    ctx.textAlign = 'left'
    let nextFreeX = -Infinity
    columns.forEach((t, col) => {
      if (col % labelEvery !== 0) return
      const text = formatBucketTime(t)
      const width = ctx.measureText(text).width
      const x = col === 0 ? 1 : col * HEATMAP_CELL_WIDTH + HEATMAP_CELL_WIDTH / 2 - width / 2
      if (x < nextFreeX) return
      ctx.fillText(text, x, plotHeight + 14)
      nextFreeX = x + width + 6
    })
  }, [columns, perStrikeChange, strikes, maxAbs, plotWidth, plotHeight, formatBucketTime, live])

  // Brings the view back to the newest minute (the left edge) whenever a new column appears - not on
  // every tick within a minute, which would yank a reader's own scroll into history on every update.
  const bucketCountRef = useRef(0)
  useEffect(() => {
    if (buckets.length === 0 || buckets.length === bucketCountRef.current) return
    bucketCountRef.current = buckets.length
    if (scrollRef.current) scrollRef.current.scrollLeft = 0
  }, [buckets.length])

  const handleMouseMove = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const col = Math.floor(x / HEATMAP_CELL_WIDTH)
    const row = Math.floor(y / HEATMAP_ROW_HEIGHT)
    if (y >= plotHeight || col < 0 || col >= columns.length || row < 0 || row >= strikes.length) { setHover(null); return }
    const strike = strikes[row]
    const t = columns[col]
    setHover({ clientX: e.clientX, clientY: e.clientY, strike, time: t, value: perStrikeChange.get(strike)?.get(t) })
  }

  if (buckets.length === 0) return <Empty description={`No ${label} OI data yet.`} />
  // Cells this dense are drawn only where OI actually moved (see the draw effect's own
  // v === 0/maxAbs === 0 guard) - a day where every tracked strike's own OI happened to be
  // perfectly flat between EVERY tick draws nothing at all, which reads exactly like "broken" even
  // though it is a real (if unusual) reading. Told apart here explicitly rather than left to look
  // identical to the "no data fetched at all" Empty state above.
  if (maxAbs === 0) return <Empty description={`${label} OI hasn't changed at all since the first data point today - nothing to show yet.`} />

  return (
    <>
    <div style={{ display: 'flex', border: `1px solid ${BORDER_COLOR}`, borderRadius: 4, overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, width: HEATMAP_LABEL_WIDTH, background: '#161a22' }}>
        <div style={{ height: HEATMAP_AXIS_HEIGHT }} />
        {strikes.map((strike) => {
          const noData = strikesWithNoData.has(strike)
          return (
            <div
              key={strike}
              title={noData ? `No ${label} OI data at this strike` : undefined}
              style={{
                height: HEATMAP_ROW_HEIGHT, lineHeight: `${HEATMAP_ROW_HEIGHT}px`, textAlign: 'right', paddingRight: 8,
                fontSize: 11, whiteSpace: 'nowrap', fontWeight: strike === atmStrike ? 700 : 400,
                // Dimmed further than the normal AXIS_COLOR label, and italic - an empty row reads
                // like a rendering glitch otherwise (see strikesWithNoData's own doc comment); this
                // marks it as a real, explained absence instead, without needing a whole extra column.
                color: noData ? `${AXIS_COLOR}80` : strike === atmStrike ? '#fff' : AXIS_COLOR,
                fontStyle: noData ? 'italic' : 'normal',
              }}
            >
              {strike.toLocaleString()}
            </div>
          )
        })}
      </div>
      <div ref={scrollRef} style={{ overflowX: 'auto', overflowY: 'hidden' }} onMouseLeave={() => setHover(null)}>
        <canvas ref={canvasRef} onMouseMove={handleMouseMove} style={{ display: 'block' }} />
      </div>
      {hover && (
        <div
          style={{
            position: 'fixed',
            // Flips to the LEFT of the cursor once there isn't roughly enough room to the right for
            // the widest label this ever renders ("CE 22,650 @ 03:14 pm: +1.23M") - fixed `left:
            // clientX + 14` alone ran the label straight off the right edge of the screen on a phone
            // (or anywhere the cursor/touch lands in that last ~220px), clipping it exactly like the
            // real screenshot caught. translateX(-100%) shifts the box fully behind its own anchor
            // point instead of needing this label's own actual rendered width up front.
            ...(hover.clientX > window.innerWidth - 220
              ? { left: hover.clientX - 14, transform: 'translateX(-100%)' }
              : { left: hover.clientX + 14 }),
            top: hover.clientY + 14, zIndex: 1000,
            background: '#161a22', border: `1px solid ${BORDER_COLOR}`, borderRadius: 4, padding: '4px 8px',
            fontSize: 11, color: '#fff', pointerEvents: 'none', whiteSpace: 'nowrap',
          }}
        >
          {label} {hover.strike.toLocaleString()} @ {formatBucketTime(hover.time)}:{' '}
          <Text strong style={{ color: !hover.value ? '#fff' : hover.value > 0 ? OI_ADDED_COLOR : OI_REMOVED_COLOR }}>
            {hover.value == null ? '—' : formatOiMillions(hover.value, { signed: true })}
          </Text>
        </div>
      )}
    </div>
    <Space size={16} style={{ marginTop: 6 }}>
      <Text style={{ fontSize: 12 }}>
        Total {label} OI added: <Text strong style={{ color: OI_ADDED_COLOR }}>{formatOiMillions(totals.added)}</Text>
      </Text>
      <Text style={{ fontSize: 12 }}>
        Total {label} OI removed: <Text strong style={{ color: OI_REMOVED_COLOR }}>{formatOiMillions(Math.abs(totals.removed))}</Text>
      </Text>
      <Text style={{ fontSize: 12 }}>
        Δ: <Text strong style={{ color: totals.delta >= 0 ? OI_ADDED_COLOR : OI_REMOVED_COLOR }}>{formatOiMillions(totals.delta, { signed: true })}</Text>
      </Text>
    </Space>
    </>
  )
}

// Rows of the OI totals heatmap: the whole band's OI added/removed per bucket (delta) and its running
// sum (cumulative), for CE, PE and the net CE - PE. `cum` rows scale to their own largest value, delta
// rows to their own 95th percentile (same reasoning as heatmapScale), so a small row isn't washed out
// by a big one.
const OI_TOTALS_ROWS = [
  { key: 'ceDelta', label: 'CE Δ', cum: false, gap: false },
  { key: 'ceCum', label: 'CE cumulative Δ', cum: true, gap: false },
  { key: 'peDelta', label: 'PE Δ', cum: false, gap: true },
  { key: 'peCum', label: 'PE cumulative Δ', cum: true, gap: false },
  { key: 'netDelta', label: 'Net Δ (CE − PE)', cum: false, gap: true },
  { key: 'netCum', label: 'Net cumulative (CE − PE)', cum: true, gap: false },
]
const OI_TOTALS_ROW_HEIGHT = 24
const OI_TOTALS_GAP = 6
const OI_TOTALS_LABEL_WIDTH = 190

function OiTotalsHeatmap({ ceByStrike, peByStrike, strikes, asOfMs, timeframeMinutes, live = false }) {
  const canvasRef = useRef(null)
  const scrollRef = useRef(null)
  const [hover, setHover] = useState(null)
  const { buckets, rows } = useMemo(() => {
    const ce = buildOiChangeMatrix(ceByStrike, strikes, asOfMs, timeframeMinutes).perStrikeChange
    const pe = buildOiChangeMatrix(peByStrike, strikes, asOfMs, timeframeMinutes).perStrikeChange
    return buildOiTotalsRows(ce, pe)
  }, [ceByStrike, peByStrike, strikes, asOfMs, timeframeMinutes])
  const columns = useMemo(() => [...buckets].reverse(), [buckets])
  const formatBucketTime = istTimeFormatter

  const scales = useMemo(() => {
    const out = {}
    for (const r of OI_TOTALS_ROWS) {
      const mags = [...rows[r.key].values()].filter((v) => Number.isFinite(v) && v !== 0).map(Math.abs).sort((a, b) => a - b)
      out[r.key] = mags.length === 0 ? 0 : r.cum ? mags[mags.length - 1] : mags[Math.min(mags.length - 1, Math.floor(mags.length * HEATMAP_SCALE_PERCENTILE))]
    }
    return out
  }, [rows])

  const rowY = (index) => index * OI_TOTALS_ROW_HEIGHT + OI_TOTALS_ROWS.slice(0, index + 1).filter((r) => r.gap).length * OI_TOTALS_GAP
  const plotWidth = buckets.length * HEATMAP_CELL_WIDTH
  const plotHeight = rowY(OI_TOTALS_ROWS.length - 1) + OI_TOTALS_ROW_HEIGHT

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || buckets.length === 0) return
    const dpr = window.devicePixelRatio || 1
    const totalHeight = plotHeight + HEATMAP_AXIS_HEIGHT
    canvas.width = plotWidth * dpr
    canvas.height = totalHeight * dpr
    canvas.style.width = `${plotWidth}px`
    canvas.style.height = `${totalHeight}px`
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, plotWidth, totalHeight)
    OI_TOTALS_ROWS.forEach((r, i) => {
      const y = rowY(i)
      columns.forEach((t, col) => {
        const v = rows[r.key].get(t)
        if (v == null || v === 0 || scales[r.key] === 0) return
        const alpha = HEATMAP_MIN_ALPHA + Math.min(1, Math.abs(v) / scales[r.key]) * (HEATMAP_MAX_ALPHA - HEATMAP_MIN_ALPHA)
        ctx.fillStyle = hexToRgba(v > 0 ? OI_ADDED_COLOR : OI_REMOVED_COLOR, alpha)
        ctx.fillRect(col * HEATMAP_CELL_WIDTH, y, HEATMAP_CELL_WIDTH - 1, OI_TOTALS_ROW_HEIGHT - 1)
      })
    })
    if (live) {
      ctx.strokeStyle = LIVE_COLUMN_OUTLINE_COLOR
      ctx.lineWidth = 1
      ctx.strokeRect(0.5, 0.5, HEATMAP_CELL_WIDTH - 1, plotHeight - 1)
    }
    ctx.fillStyle = AXIS_COLOR
    ctx.font = '10px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'left'
    const labelEvery = Math.max(1, Math.round(60 / HEATMAP_CELL_WIDTH))
    let nextFreeX = -Infinity
    columns.forEach((t, col) => {
      if (col % labelEvery !== 0) return
      const text = formatBucketTime(t)
      const width = ctx.measureText(text).width
      const x = col === 0 ? 1 : col * HEATMAP_CELL_WIDTH + HEATMAP_CELL_WIDTH / 2 - width / 2
      if (x < nextFreeX) return
      ctx.fillText(text, x, plotHeight + 14)
      nextFreeX = x + width + 6
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns, rows, scales, plotWidth, plotHeight, formatBucketTime, live])

  const bucketCountRef = useRef(0)
  useEffect(() => {
    if (buckets.length === 0 || buckets.length === bucketCountRef.current) return
    bucketCountRef.current = buckets.length
    if (scrollRef.current) scrollRef.current.scrollLeft = 0
  }, [buckets.length])

  const handleMouseMove = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const col = Math.floor(x / HEATMAP_CELL_WIDTH)
    const index = OI_TOTALS_ROWS.findIndex((_, i) => y >= rowY(i) && y < rowY(i) + OI_TOTALS_ROW_HEIGHT)
    if (col < 0 || col >= columns.length || index < 0) { setHover(null); return }
    const r = OI_TOTALS_ROWS[index]
    setHover({ clientX: e.clientX, clientY: e.clientY, label: r.label, time: columns[col], value: rows[r.key].get(columns[col]) })
  }

  if (buckets.length === 0) return <Empty description="No OI data yet." />

  const latest = (key) => (columns.length ? rows[key].get(columns[0]) : null)
  return (
    <div style={{ display: 'flex', border: `1px solid ${BORDER_COLOR}`, borderRadius: 4, overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, width: OI_TOTALS_LABEL_WIDTH, background: '#161a22', position: 'relative' }}>
        {OI_TOTALS_ROWS.map((r, i) => {
          const v = latest(r.key)
          return (
            <div
              key={r.key}
              style={{
                position: 'absolute', transform: `translateY(${rowY(i)}px)`, width: OI_TOTALS_LABEL_WIDTH, height: OI_TOTALS_ROW_HEIGHT,
                lineHeight: `${OI_TOTALS_ROW_HEIGHT}px`, display: 'flex', justifyContent: 'space-between', padding: '0 8px', fontSize: 11, boxSizing: 'border-box',
                color: AXIS_COLOR, fontWeight: r.cum ? 400 : 700,
              }}
            >
              <span>{r.label}</span>
              <span style={{ color: !v ? AXIS_COLOR : v > 0 ? OI_ADDED_COLOR : OI_REMOVED_COLOR }}>{v == null ? '—' : formatOiMillions(v, { signed: true })}</span>
            </div>
          )
        })}
        <div style={{ height: plotHeight + HEATMAP_AXIS_HEIGHT }} />
      </div>
      <div ref={scrollRef} style={{ overflowX: 'auto', overflowY: 'hidden' }} onMouseLeave={() => setHover(null)}>
        <canvas ref={canvasRef} onMouseMove={handleMouseMove} style={{ display: 'block' }} />
      </div>
      {hover && (
        <div
          style={{
            position: 'fixed',
            ...(hover.clientX > window.innerWidth - 260
              ? { left: hover.clientX - 14, transform: 'translateX(-100%)' }
              : { left: hover.clientX + 14 }),
            top: hover.clientY + 14, zIndex: 1000,
            background: '#161a22', border: `1px solid ${BORDER_COLOR}`, borderRadius: 4, padding: '4px 8px',
            fontSize: 11, color: '#fff', pointerEvents: 'none', whiteSpace: 'nowrap',
          }}
        >
          {hover.label} @ {formatBucketTime(hover.time)}:{' '}
          <Text strong style={{ color: !hover.value ? '#fff' : hover.value > 0 ? OI_ADDED_COLOR : OI_REMOVED_COLOR }}>
            {hover.value == null ? '—' : formatOiMillions(hover.value, { signed: true })}
          </Text>
        </div>
      )}
    </div>
  )
}

const EMA1_COLOR = '#f0b429'
const EMA2_COLOR = '#38bdf8'
const VWAP_COLOR = '#e072e8'

// Previous-day volume profile overlay colors - all distinct from EMA1/EMA2/VWAP above and from the
// main chart's own red/green R/S wall convention, so five more lines on the SAME chart never get
// mistaken for one of those. POC is the boldest (the single most important level); VAH/VAL a step
// down; HVN/LVN dotted and muted - genuinely useful reference points, but secondary to POC/VA.
// The previous session's levels - the same colours as everywhere else (profileColors.js); today's running
// profile (the futures chart) has its own.
const VOLUME_PROFILE_POC_COLOR = PREV_PROFILE.poc
const VOLUME_PROFILE_VA_COLOR = PREV_PROFILE.va
const VOLUME_PROFILE_HVN_COLOR = PREV_PROFILE.hvn
const VOLUME_PROFILE_LVN_COLOR = PREV_PROFILE.lvn

// Index 0 = the single strongest HVN/LVN (ComputeVolumeProfile's own OrderByDescending/OrderBy
// already ranks them this way, backend-side) - shown at near-full strength; each one after it fades
// further, so "there are several of these" reads as several DIFFERENT-weight levels, not several
// identical-looking lines. Backend caps each list at 2, but this reads by index regardless of length
// (falling back to the last entry for anything beyond it) rather than hard-coding "exactly two."
const VOLUME_PROFILE_NODE_SHADE_ALPHAS = [0.9, 0.45]

// A second, independently-timeframed candlestick chart with two EMA overlays - the user's own "one
// more chart along with this 15 min running chart... add ema indicator... for parallel execution to
// specific entry" ask: a faster 1/3/5-min read with EMA crossovers for timing an entry precisely,
// alongside (not instead of) the main chart's own coarser timeframe. Driven by the SAME replay
// clock as the main chart (oneMinBars/visibleCount, both owned by the page, not this component) so
// the two always show the same moment in the day, just re-aggregated to a different bucket size -
// this one never fetches or replays anything on its own.
//
// The two EMA series are created ONCE (in the same setup effect as the candlestick series) and
// only ever re-titled/re-fed data afterward, rather than destroyed and recreated when a period
// changes - lightweight-charts series are cheap to keep, not to keep re-adding.
function EmaChart({
  oneMinBars, visibleCount, timeframe, onTimeframeChange, ema1Period, onEma1PeriodChange, ema2Period, onEma2PeriodChange, dayKey,
  vwapSeries = EMPTY_ARRAY, showVwap = false, height = 320, volumeProfile = null, showVolumeProfile = true,
}) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const ema1SeriesRef = useRef(null)
  const ema2SeriesRef = useRef(null)
  const vwapSeriesRef = useRef(null)
  const volumeProfileLinesRef = useRef([])

  const displayBars = useMemo(
    () => aggregateBars(oneMinBars.slice(0, visibleCount), timeframe),
    [oneMinBars, visibleCount, timeframe],
  )
  const ema1Points = useMemo(() => computeEma(displayBars, ema1Period), [displayBars, ema1Period])
  const ema2Points = useMemo(() => computeEma(displayBars, ema2Period), [displayBars, ema2Period])

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createZoomableChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR, scaleMargins: CANDLE_SCALE_MARGINS },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    seriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
    })
    ema1SeriesRef.current = chart.addSeries(LineSeries, { color: EMA1_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: true })
    ema2SeriesRef.current = chart.addSeries(LineSeries, { color: EMA2_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: true })
    vwapSeriesRef.current = chart.addSeries(LineSeries, { color: VWAP_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'VWAP' })

    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) }
    // ResizeObserver, not a plain window 'resize' listener: on mobile, a chart's own container
    // can still read a stale/zero clientWidth at the moment this effect runs (layout not yet
    // settled - address bar show/hide, a not-yet-laid-out flex/card ancestor, fonts still
    // loading), and nothing but an actual BROWSER WINDOW resize ever fired the old listener - a
    // real report ("looks to be mobile only... when squeezing resolution it started working")
    // was exactly this: resizing the window was the only thing that ever re-measured the chart.
    // ResizeObserver fires once immediately on observe() with the container's ACTUAL current
    // size, then again on every later layout change, not just a window-level resize.
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(containerRef.current)
    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      ema1SeriesRef.current = null
      ema2SeriesRef.current = null
      vwapSeriesRef.current = null
      volumeProfileLinesRef.current = [] // the series they belonged to is gone along with the chart
    }
  }, [height])

  useEffect(() => { ema1SeriesRef.current?.applyOptions({ title: `EMA ${ema1Period}` }) }, [ema1Period])
  useEffect(() => { ema2SeriesRef.current?.applyOptions({ title: `EMA ${ema2Period}` }) }, [ema2Period])

  useEffect(() => { if (seriesRef.current) seriesRef.current.setData(displayBars) }, [displayBars])
  useEffect(() => { if (ema1SeriesRef.current) ema1SeriesRef.current.setData(ema1Points) }, [ema1Points])
  useEffect(() => { if (ema2SeriesRef.current) ema2SeriesRef.current.setData(ema2Points) }, [ema2Points])
  // The session VWAP's value at each candle, on the candle's own time (chartVwap) - its native
  // 1-minute points on a 5-minute chart added four empty slots between candles (the distortion).
  useEffect(() => {
    vwapSeriesRef.current?.setData(showVwap ? chartVwap(displayBars, vwapSeries) : EMPTY_ARRAY)
  }, [vwapSeries, showVwap, displayBars])

  // Previous-day volume profile - marked on BY DEFAULT (no toggle; the user's own explicit ask), not
  // gated behind isLive the way VWAP is: yesterday's own already-closed levels are just as valid a
  // reference while reviewing an older replay day as while trading live today. Redrawn from scratch
  // on every change (clear then recreate, same shape as ReplayChart's own OI-wall lines) since these
  // five-ish lines never so densely churn that diffing them individually would be worth the code -
  // in practice this only ever actually reruns once per day/underlying, when the fetch that produced
  // volumeProfile itself resolves.
  useEffect(() => {
    if (!seriesRef.current) return
    for (const line of volumeProfileLinesRef.current) seriesRef.current.removePriceLine(line)
    volumeProfileLinesRef.current = []
    if (!volumeProfile || !showVolumeProfile) return
    const addLine = (price, color, title, lineWidth, lineStyle) => {
      if (price == null) return
      const line = seriesRef.current.createPriceLine({ price, color, lineWidth, lineStyle, axisLabelVisible: true, title })
      volumeProfileLinesRef.current.push(line)
    }
    const dateLabel = volumeProfile.profileDate ? ` (${fmtDateOnly(volumeProfile.profileDate)})` : ''
    addLine(volumeProfile.poc, VOLUME_PROFILE_POC_COLOR, `POC${dateLabel}`, 2, 0)
    addLine(volumeProfile.vah, VOLUME_PROFILE_VA_COLOR, 'VAH', 1, 2)
    addLine(volumeProfile.val, VOLUME_PROFILE_VA_COLOR, 'VAL', 1, 2)
    // Multiple HVN/LVN entries are already returned STRONGEST FIRST (ComputeVolumeProfile's own
    // OrderByDescending/OrderBy) - shading each by that same rank, not redoing the ranking here,
    // is what actually answers "show shades" for however many of each there are: the single
    // strongest node in each list stays full-strength, and every one after it fades a step further,
    // so a second/third node reads as "real but secondary" rather than looking identical in weight
    // to the primary one.
    const addRankedLines = (levels, color, title) => {
      levels?.forEach((price, i) => addLine(price, hexToRgba(color, VOLUME_PROFILE_NODE_SHADE_ALPHAS[i] ?? VOLUME_PROFILE_NODE_SHADE_ALPHAS.at(-1)), title, 1, 1))
    }
    // ONE of each: the strongest HVN and the thinnest LVN (the server ranks them strongest first).
    addRankedLines(volumeProfile.hvn?.slice(0, 1), VOLUME_PROFILE_HVN_COLOR, 'HVN')
    addRankedLines(volumeProfile.lvn?.slice(0, 1), VOLUME_PROFILE_LVN_COLOR, 'LVN')
  }, [volumeProfile, showVolumeProfile])

  // Unconditional re-fit on a brand new day AND whenever this chart's OWN timeframe changes (unlike
  // just growing with more data, below) - switching from 5min to 1min here goes from ~75 candles to
  // ~375 for the same revealed stretch, and leaving the old zoom level in place would show only a
  // sliver of that much denser series rather than the whole thing. Also keeps re-fitting as MORE
  // bars accumulate live at the SAME timeframe, while still at the live edge - see
  // useFitContentAsDataGrows' own doc comment.
  useFitContentAsDataGrows(chartRef, displayBars.length, `${dayKey}-${timeframe}`)

  return (
    <div style={{ width: '100%' }}>
      <Space align="center" size={12} wrap style={{ marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>Timeframe</Text>
        <Select value={timeframe} onChange={onTimeframeChange} style={{ width: 90 }} options={FAST_TIMEFRAME_OPTIONS} />
        <Text type="secondary" style={{ fontSize: 12, color: EMA1_COLOR }}>EMA</Text>
        <InputNumber value={ema1Period} onChange={(v) => onEma1PeriodChange(v || 1)} min={1} max={200} style={{ width: 70 }} />
        <Text type="secondary" style={{ fontSize: 12, color: EMA2_COLOR }}>EMA</Text>
        <InputNumber value={ema2Period} onChange={(v) => onEma2PeriodChange(v || 1)} min={1} max={200} style={{ width: 70 }} />
      </Space>
      <div ref={containerRef} style={{ width: '100%', height }} />
    </div>
  )
}

// Colors for the futures regime read - Long Buildup/Short Covering are bullish (price+OI both
// rising, or OI unwinding as price rises - fresh longs or shorts closing out), Short Buildup/Long
// Unwinding are bearish (the mirror image) - same UP_COLOR/DOWN_COLOR sentiment convention as
// everywhere else on this page, not the CE/PE-type colors.
const FUTURES_REGIME_INFO = {
  'Long Buildup': { bias: 'Bullish', color: UP_COLOR, blurb: 'Price rising with OI rising - fresh long positions being added.' },
  'Short Covering': { bias: 'Bullish', color: UP_COLOR, blurb: 'Price rising with OI falling - shorts buying back to close, not fresh buying.' },
  'Short Buildup': { bias: 'Bearish', color: DOWN_COLOR, blurb: 'Price falling with OI rising - fresh short positions being added.' },
  'Long Unwinding': { bias: 'Bearish', color: DOWN_COLOR, blurb: 'Price falling with OI falling - longs exiting, not fresh selling.' },
  Neutral: { bias: 'Neutral', color: AXIS_COLOR, blurb: 'No significant price/OI move yet.' },
}

// The classic futures 4-quadrant read: price direction x OI direction. Unlike an option strike
// (where OI sits AT a level and a wall is a relative-strength read), a future has exactly one
// instrument, so its own OI change is a direct, unambiguous read on aggregate conviction - no
// "relative to what" question the way an option chain's OI needs.
function classifyFuturesRegime(priceDelta, oiDelta, priceThreshold, oiThreshold) {
  if (oiDelta == null || Math.abs(oiDelta) < oiThreshold || Math.abs(priceDelta) < priceThreshold) return 'Neutral'
  if (oiDelta > 0) return priceDelta > 0 ? 'Long Buildup' : 'Short Buildup'
  return priceDelta > 0 ? 'Short Covering' : 'Long Unwinding'
}

// Candlestick chart for the day's futures contract - same reveal-as-replay-advances shape as
// ReplayChart - PLUS an OI overlay line (own left-hand price scale, so it never competes with the
// candles' own right-hand price axis) and regime-change markers (Long Buildup/Short Buildup/Short
// Covering/Long Unwinding - see classifyFuturesRegime) stamped directly on the candle where each
// shift actually started, the "show me when what happened" read for a future's own OI - unlike an
// option strike, a future has no strike chain to draw S/R walls for, so this chart's OI story is
// entirely about ITS OWN change over time rather than a level.
// profile: the session volume profile (orderFlowMath.volumeProfileFromCandles) in profileRowSize
// rows - drawn into the chart by VolumeProfilePrimitive, with POC / VAH / VAL price lines.
// deltaBars: [{ time (chart time), delta, cvd }] per candle - each candle's delta as a histogram and
// the cumulative delta as a line, in a band under the candles (own scales).
function FuturesChart({ bars, oiLine, markers, dayKey, height = 320, profile = null, profileRowSize = 0, deltaBars = null, vwap = EMPTY_ARRAY }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const vwapSeriesRef = useRef(null)
  const seriesRef = useRef(null)
  const oiSeriesRef = useRef(null)
  const markersRef = useRef(null)
  const profilePrimitiveRef = useRef(null)
  const profileLinesRef = useRef([])
  const deltaSeriesRef = useRef(null)
  const cvdSeriesRef = useRef(null)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createZoomableChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR, scaleMargins: CANDLE_SCALE_MARGINS },
      leftPriceScale: { visible: true, borderColor: BORDER_COLOR },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    seriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
    })
    // lightweight-charts v5 removed ISeriesApi.setMarkers() - markers are now a separate plugin
    // instance created via createSeriesMarkers, same pattern every other chart in this codebase
    // already uses (App.jsx, BacktestPage.jsx, etc). Calling .setMarkers() on the series itself (as
    // this chart used to) throws a TypeError as soon as any regime markers exist, which the
    // ChartErrorBoundary above then swallows into "This chart could not be rendered" - the exact
    // "futures chart is unable to render" bug.
    markersRef.current = createSeriesMarkers(seriesRef.current, [])
    profilePrimitiveRef.current = new VolumeProfilePrimitive()
    seriesRef.current.attachPrimitive(profilePrimitiveRef.current)
    profileLinesRef.current = []
    // Delta (histogram) and cumulative delta (line) share the bottom band of the pane.
    deltaSeriesRef.current = chart.addSeries(HistogramSeries, { priceScaleId: 'delta', priceLineVisible: false, lastValueVisible: false, title: 'Δ' })
    cvdSeriesRef.current = chart.addSeries(LineSeries, { priceScaleId: 'cvd', color: '#f5c542', lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'ΣΔ' })
    chart.priceScale('delta').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, visible: false })
    chart.priceScale('cvd').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 }, visible: false })
    // Own (left) price scale and a thin, semi-transparent line - OI's own numbers (lakhs/crores)
    // are a totally different scale than price, so sharing the right-hand axis with candles would
    // otherwise squash one or the other into a flat line.
    oiSeriesRef.current = chart.addSeries(LineSeries, {
      color: `${AXIS_COLOR}cc`, lineWidth: 2, priceScaleId: 'left', priceLineVisible: false, lastValueVisible: true,
      title: 'OI (M)',
    })
    vwapSeriesRef.current = chart.addSeries(LineSeries, { color: VWAP_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'VWAP' })
    // The plotted values are already OI/1e6 (see the caller's own futuresOiLine) - format the axis
    // itself to 2 decimals instead of lightweight-charts' own default (which would otherwise round
    // a value like 12.34 down to whole numbers and make small OI moves invisible on the axis).
    chart.priceScale('left').applyOptions({ mode: 0 })
    oiSeriesRef.current.applyOptions({ priceFormat: { type: 'custom', formatter: (v) => v.toFixed(2) } })

    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) }
    // ResizeObserver, not a plain window 'resize' listener: on mobile, a chart's own container
    // can still read a stale/zero clientWidth at the moment this effect runs (layout not yet
    // settled - address bar show/hide, a not-yet-laid-out flex/card ancestor, fonts still
    // loading), and nothing but an actual BROWSER WINDOW resize ever fired the old listener - a
    // real report ("looks to be mobile only... when squeezing resolution it started working")
    // was exactly this: resizing the window was the only thing that ever re-measured the chart.
    // ResizeObserver fires once immediately on observe() with the container's ACTUAL current
    // size, then again on every later layout change, not just a window-level resize.
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(containerRef.current)
    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      oiSeriesRef.current = null
      markersRef.current = null
      profilePrimitiveRef.current = null
      profileLinesRef.current = []
      deltaSeriesRef.current = null
      cvdSeriesRef.current = null
      vwapSeriesRef.current = null
    }
  }, [height])
  // The futures' session VWAP, already on these candles' times (the caller aligns it).
  useEffect(() => { vwapSeriesRef.current?.setData(vwap) }, [vwap])

  useEffect(() => {
    if (!deltaSeriesRef.current || !cvdSeriesRef.current || !seriesRef.current) return
    const rows = deltaBars ?? []
    deltaSeriesRef.current.setData(rows.map((d) => ({ time: d.time, value: d.delta, color: d.delta >= 0 ? `${UP_COLOR}aa` : `${DOWN_COLOR}aa` })))
    cvdSeriesRef.current.setData(rows.map((d) => ({ time: d.time, value: d.cvd })))
    // Candles keep the top of the pane when there is a delta band under them.
    seriesRef.current.priceScale().applyOptions({ scaleMargins: rows.length ? { top: 0.12, bottom: 0.28 } : CANDLE_SCALE_MARGINS })
  }, [deltaBars, height])

  useEffect(() => {
    if (!seriesRef.current) return
    profilePrimitiveRef.current?.setProfile(profile, profileRowSize)
    profileLinesRef.current = setProfileLines(seriesRef.current, profileLinesRef.current, profile, profileRowSize)
  }, [profile, profileRowSize, height])

  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setData(bars)
  }, [bars])

  useEffect(() => {
    if (!oiSeriesRef.current) return
    oiSeriesRef.current.setData(oiLine)
  }, [oiLine])

  useEffect(() => {
    markersRef.current?.setMarkers(markers ?? [])
  }, [markers])

  useFitContentAsDataGrows(chartRef, bars.length, dayKey)

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// DraggableFloatingPanel itself now lives in oiShared.jsx only (was a byte-identical duplicate
// here) - imported below, alongside PremiumEmaChart.

// Scans every REVEALED point strictly after entry (bounded by asOfMs, so the replay never "sees" a
// bar it hasn't played yet) to find whether a stop-loss or target was actually TOUCHED at any point
// since entry - not merely whether the LATEST point has crossed it, which would miss an intra-minute
// spike that reversed before the next check. Each point's own high/low (a real historical minute bar
// - see OiReplayPoint's own doc comment on the backend) is used when present; a live tick (a genuine
// single point in time, with no range of its own) falls back to its own price for both - the most
// accurate check that kind of data supports. Returns { kind: 'sl' | 'target', fillPrice } for the
// FIRST point where either level was touched (fillPrice is the configured level itself, not the
// bar's own high/low - a paper stop/limit order is assumed to fill exactly at its own level, not
// with extra favorable slippage), or null if neither has been touched yet. If a single bar's own
// range spans BOTH levels at once (a large bar engulfing both), the stop-loss is assumed to have
// been touched first - the standard, conservative convention, since OHLC alone can't say which one
// price actually reached first.
function computeStopTargetHit(series, entryTimeMs, asOfMs, entryPrice, direction, slPoints, targetPoints, trailStart = 0, trailGap = 0) {
  const hasSl = slPoints > 0
  const hasTarget = targetPoints > 0
  const hasTrail = trailGap > 0
  if ((!hasSl && !hasTarget && !hasTrail) || !series) return null
  const slLevel = hasSl ? (direction === 'SELL' ? entryPrice + slPoints : entryPrice - slPoints) : null
  const targetLevel = direction === 'SELL' ? entryPrice - targetPoints : entryPrice + targetPoints
  // Trailing (optionTrail.js): the stop in force in a bar comes from the best premium of the bars BEFORE
  // it - it moves after each bar, only tightening.
  let best = entryPrice
  for (const p of series) {
    const t = new Date(p.time).getTime()
    if (t <= entryTimeMs) continue
    if (asOfMs != null && t > asOfMs) break
    const high = p.high ?? p.price
    const low = p.low ?? p.price
    if (high == null || low == null) continue
    const trailed = hasTrail ? optionTrailLevel(direction, entryPrice, best, trailStart, trailGap) : null
    const stop = tighterStop(direction, slLevel, trailed)
    const slHit = stop != null && (direction === 'SELL' ? high >= stop : low <= stop)
    const targetHit = hasTarget && (direction === 'SELL' ? low <= targetLevel : high >= targetLevel)
    if (slHit) return { kind: stop === trailed && trailed !== slLevel ? 'trail' : 'sl', fillPrice: stop }
    if (targetHit) return { kind: 'target', fillPrice: targetLevel }
    best = direction === 'SELL' ? Math.min(best, low) : Math.max(best, high)
  }
  return null
}

// SEBI periodically revises each index's own lot size - update this if it changes. This feature is
// paper trading only (no real order is ever placed - see PaperTradePanel's own doc comment), so a
// stale value here only skews the SIMULATED PnL's scale, not anything real.
const PAPER_TRADE_LOT_SIZE = { NIFTY: 65, BANKNIFTY: 30, SENSEX: 20 }

// Survives a page reload for TODAY's own live session only - a historical replay day's positions
// still reset on every load() the same as before (see PaperTradePanel's own doc comment: "a paper
// position only means something against the ONE day's premium series it was punched into"), which is
// exactly why this is scoped to BOTH the underlying and the calendar day, not a single flat key -
// restoring blindly from storage regardless of which underlying/day is now loaded would resurrect
// yesterday's (or a different underlying's) positions against today's entirely different premium
// series. Real order placement was never in scope here (see PAPER_TRADE_LOT_SIZE's own comment) - a
// stale localStorage entry from an old session, or one edited by hand, only ever skews a SIMULATED
// PnL number, so restoring it needs no more validation than "does the shape look like an array."
const PAPER_POSITIONS_STORAGE_KEY = 'optionanalytics.oiReplay.livePaperPositions'

function readPersistedPaperPositions(underlying, dateKey) {
  try {
    const raw = window.localStorage.getItem(PAPER_POSITIONS_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (parsed?.underlying !== underlying || parsed?.dateKey !== dateKey || !Array.isArray(parsed.positions)) return []
    return parsed.positions
  } catch {
    // Storage can throw outright (private browsing, blocked site data) - the feature still works,
    // it just doesn't remember, same as usePersistedState elsewhere on this page.
    return []
  }
}

function writePersistedPaperPositions(underlying, dateKey, positions) {
  try {
    window.localStorage.setItem(PAPER_POSITIONS_STORAGE_KEY, JSON.stringify({ underlying, dateKey, positions }))
  } catch {
    // Same as above - remembering is a convenience, never a requirement.
  }
}

// Today's own fetched run (result) plus everything the live feed has appended on top of it since
// (liveBars/liveCePoints/livePePoints/liveFuturesPoints) - the "keep current day data in memory, and
// live ticks, so a reload doesn't have to load it again" ask. Scoped by underlying + calendar day,
// same reasoning as PAPER_POSITIONS_STORAGE_KEY's own doc comment: a cached NIFTY snapshot from
// yesterday (or from BANKNIFTY today) means nothing once a different underlying/day is what's
// actually loaded, and must never be mistaken for it.
//
// Stale-while-revalidate, not a fetch skip: ONLY consulted by the very first auto-live call on page
// mount (see the mount effect below), and even then load() still performs the exact same real fetch
// right after painting from it - see load()'s own restoredFromCache branches. An earlier version of
// this skipped that fetch outright on a cache hit, on the theory that "Go Live"/"Load day"/the live
// feed's own reconnect-triggered re-sync were the only paths that ever needed to be genuinely fresh.
// That reasoning had a real hole: NONE of those three ever run on a plain page reload (a reconnect's
// own re-sync only fires after a genuine SignalR drop-and-recover, never on a fresh connect), so
// whatever ticked in the real world while the tab was closed/reloading was gone for good - a real,
// confirmed "why do I see gaps" report. The cache now only ever buys a fast paint while that same
// fetch runs in the background to reconcile, never a skipped one.
const LIVE_DAY_CACHE_STORAGE_KEY = 'optionanalytics.oiReplay.liveDayCache'

// How often the live-day cache is actually allowed to write to localStorage, at most - see the
// write effect's own doc comment for the real, confirmed slowdown this throttle fixes. Each write
// serializes the whole day so far, so it is kept rare. Up to 30s of staleness in the cache is a
// non-issue: the reload path that reads it back still reconciles with a genuine fetch right after
// painting from it (see this constant's own caller), so this is purely a perceived-latency
// optimization, not a correctness one giving anything up.
const CACHE_WRITE_THROTTLE_MS = 30_000

function readLiveDayCache(underlying, dateKey) {
  try {
    const raw = window.localStorage.getItem(LIVE_DAY_CACHE_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed?.underlying !== underlying || parsed?.dateKey !== dateKey || parsed?.result == null) return null
    return parsed
  } catch {
    // Storage can throw outright (private browsing, blocked site data) - falling back to a genuine
    // fetch is always safe, so this just means the reload isn't instant this one time.
    return null
  }
}

// Returns false when the write failed - most often the browser's ~5 MB storage quota. The caller
// then stops trying for the rest of the page's life rather than re-serializing the whole day every
// throttle window only to be refused again.
function writeLiveDayCache(underlying, dateKey, snapshot) {
  try {
    window.localStorage.setItem(LIVE_DAY_CACHE_STORAGE_KEY, JSON.stringify({ underlying, dateKey, ...snapshot }))
    return true
  } catch {
    // Same as above - remembering is a convenience, never a requirement. Drop the older entry so a
    // reload doesn't paint from a snapshot that stopped updating hours ago.
    clearLiveDayCache()
    return false
  }
}

function clearLiveDayCache() {
  try {
    window.localStorage.removeItem(LIVE_DAY_CACHE_STORAGE_KEY)
  } catch {
    // Nothing to do - if removeItem itself threw, the entry likely never stuck in the first place.
  }
}

// One simulated position: Buy (long) or Sell (short/write) CE/PE at whatever this replay's own
// premium series shows as of the CURRENT replay tick, then Exit later (again at whatever the series
// shows as of the tick Exit is clicked) - entirely client-side, no backend call, no real order.
// Punching multiple positions in one session, CE and PE both, is the point (the user's own "I can
// trade multiple things ce and pe both") - each is tracked independently, so several positions (any
// mix of Buy/Sell, CE/PE) can be open at once with their own live PnL. A Sell position's PnL is the
// mirror of a Buy's (entryPrice - ltp instead of ltp - entryPrice, since the writer profits as the
// premium falls) - see the PnL calc in the caller's own enrichedPaperPositions.
//
// Live mode (admins, while today is followed live): the same inputs place REAL Dhan orders instead
// - see LiveTrading.jsx / LiveTradingService. A Super Order priced off the live ask (buy) or bid
// (sell) plus `liveSlippage`, with this panel's SL/target as its legs; the paper table gives way to
// the account's real positions and P&L.
function PaperTradePanel({
  atmStrike, step, side, onSideChange, direction, onDirectionChange, strikeOffset, onStrikeOffsetChange,
  qtyLots, onQtyLotsChange, slPoints, onSlPointsChange, targetPoints, onTargetPointsChange,
  trailStart = 0, onTrailStartChange, trailGap = 0, onTrailGapChange,
  onPunch, canPunch, positions, onExit, onExitAll, onClearAll,
  mode = 'paper', onModeChange = null, liveAvailable = false, liveUnavailableReason = null,
  liveSlippage = 1, onLiveSlippageChange = null, onLivePunch = null, canLivePunch = false, liveBusy = false,
  liveOrderSummary = '', liveContent = null, liveBlockReason = null,
  underlying = null, onUnderlyingChange = null,
}) {
  const isLiveMode = mode === 'live'

  const totalPnl = positions.reduce((sum, p) => sum + p.pnl, 0)
  const hasOpenPosition = positions.some((p) => p.status === 'OPEN')

  const columns = [
    {
      title: 'Action', dataIndex: 'direction', key: 'direction', width: 60,
      render: (d, r) => <Tag color={d === 'BUY' ? 'success' : 'error'}>{d} {r.side}</Tag>,
    },
    { title: 'Strike', dataIndex: 'strike', key: 'strike', width: 70 },
    { title: 'Qty', dataIndex: 'qtyLots', key: 'qtyLots', width: 60, render: (q, r) => `${q}×${r.lotSize}` },
    { title: 'Entry', dataIndex: 'entryPrice', key: 'entryPrice', width: 65, render: (v) => v.toFixed(2) },
    { title: 'LTP', dataIndex: 'ltp', key: 'ltp', width: 65, render: (v) => v.toFixed(2) },
    {
      title: 'PnL', dataIndex: 'pnl', key: 'pnl', width: 85,
      render: (v) => <Text strong style={{ color: v >= 0 ? UP_COLOR : DOWN_COLOR, fontSize: 12 }}>{v >= 0 ? '+' : ''}{v.toFixed(0)}</Text>,
    },
    {
      title: '', key: 'action', width: 70,
      render: (_, r) => (r.status === 'OPEN'
        ? <Button size="small" onClick={() => onExit(r.id)}>Exit</Button>
        : <Tag color={r.exitReason === 'SL' ? 'error' : r.exitReason === 'Target' ? 'success' : 'default'}>{r.exitReason ?? 'Closed'}</Tag>),
    },
  ]

  return (
    <div style={{ width: '100%' }}>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {onUnderlyingChange && (
          <Tooltip title="Pick the index to trade - the panel then uses that index's ATM strike, expiry and premium. An open position in another index stays where it is.">
            <Segmented
              value={underlying} onChange={onUnderlyingChange} aria-label="Index to trade"
              options={['NIFTY', 'BANKNIFTY', 'SENSEX'].map((u) => ({ label: u, value: u }))}
            />
          </Tooltip>
        )}
        {onModeChange && (
          <Space wrap size={8}>
            <Tooltip title={liveAvailable ? null : liveUnavailableReason}>
              <Segmented
                value={mode} onChange={onModeChange}
                options={[{ label: 'Paper', value: 'paper' }, { label: 'Live (real orders)', value: 'live', disabled: !liveAvailable && !isLiveMode }]}
              />
            </Tooltip>
            {isLiveMode && <Tag color="error">LIVE - orders go to your Dhan account</Tag>}
          </Space>
        )}
        <Space wrap size={8}>
          <Segmented value={direction} onChange={onDirectionChange} options={[{ label: 'Buy', value: 'BUY' }, { label: 'Sell', value: 'SELL' }]} />
          {/* Switching CE <-> PE keeps the moneyness (2 ITM stays 2 ITM), which mirrors the offset. */}
          <Segmented
            value={side} options={[{ label: 'CE', value: 'CE' }, { label: 'PE', value: 'PE' }]}
            onChange={(next) => { if (next !== side && strikeOffset) onStrikeOffsetChange(-strikeOffset); onSideChange(next) }}
          />
          <StrikePicker atmStrike={atmStrike} step={step} side={side} offset={strikeOffset} onChange={onStrikeOffsetChange} />
          <InputNumber value={qtyLots} onChange={(v) => onQtyLotsChange(v ?? 1)} min={1} step={1} style={{ width: 100 }} addonAfter="lots" />
          <InputNumber
            value={slPoints} onChange={(v) => onSlPointsChange(v ?? 0)} min={0} step={5} style={{ width: 110 }}
            addonBefore="SL" addonAfter="pts"
          />
          <InputNumber
            value={targetPoints} onChange={(v) => onTargetPointsChange(v ?? 0)} min={0} step={5} style={{ width: 130 }}
            addonBefore="Target" addonAfter="pts"
          />
          {onTrailGapChange && (
            <Tooltip title="Trailing stop on the premium: once the trade is 'Trail after' points in profit, the stop follows the best premium 'Follow' points behind and only tightens. Follow 0 = off. Paper here; live, the server moves the super order's stop-loss leg.">
              <Space size={4}>
                <InputNumber value={trailStart} onChange={(v) => onTrailStartChange?.(v ?? 0)} min={0} step={5} style={{ width: 130 }} addonBefore="Trail after" addonAfter="pts" aria-label="Trail after points" />
                <InputNumber value={trailGap} onChange={(v) => onTrailGapChange(v ?? 0)} min={0} step={1} style={{ width: 120 }} addonBefore="Follow" addonAfter="pts" aria-label="Trail follow points" />
              </Space>
            </Tooltip>
          )}
          {isLiveMode && (
            <InputNumber
              value={liveSlippage} onChange={(v) => onLiveSlippageChange?.(v ?? 0)} min={0} step={0.5} style={{ width: 140 }}
              addonBefore="Slippage" addonAfter="pts"
            />
          )}
          {isLiveMode ? (
            <Popconfirm
              title="Place a REAL order on Dhan?"
              description={liveOrderSummary}
              okText={`${direction === 'SELL' ? 'Sell' : 'Buy'} live`} okButtonProps={{ danger: true }}
              onConfirm={onLivePunch} disabled={!canLivePunch || liveBusy}
            >
              <Button type="primary" danger size="small" disabled={!canLivePunch} loading={liveBusy}>
                {direction === 'SELL' ? 'Sell' : 'Buy'} LIVE
              </Button>
            </Popconfirm>
          ) : (
            <Button type="primary" size="small" onClick={onPunch} disabled={!canPunch}>
              {direction === 'SELL' ? 'Sell' : 'Buy'}
            </Button>
          )}
        </Space>
        {isLiveMode && liveBlockReason && <Text type="warning" style={{ fontSize: 12 }}>{liveBlockReason}</Text>}
        {isLiveMode && liveContent}
        {!isLiveMode && positions.length > 0 && (
          <>
            {/* scroll.x - the panel itself is capped to fit a phone's viewport width (see
                DraggableFloatingPanel below), narrower than these columns' own combined width, so
                the table needs to scroll horizontally within the panel rather than overflow it. */}
            <Table dataSource={positions} columns={columns} rowKey="id" size="small" pagination={false} scroll={{ x: 475, y: 220 }} />
            <Space style={{ width: '100%', justifyContent: 'space-between' }} wrap>
              <Text strong style={{ color: totalPnl >= 0 ? UP_COLOR : DOWN_COLOR }}>
                Total PnL: {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(0)}
              </Text>
              <Space size={8}>
                <Button size="small" onClick={onExitAll} disabled={!hasOpenPosition}>Exit all</Button>
                <Button size="small" danger onClick={onClearAll}>Clear all</Button>
              </Space>
            </Space>
          </>
        )}
        {isLiveMode ? (
          <Text type="secondary" style={{ fontSize: 10 }}>
            Live: each order is a Dhan Super Order (INTRADAY) - a LIMIT entry at the live ask (buy) or bid (sell)
            plus the slippage above, with the SL and target measured from that ask/bid as its exit legs, which
            Dhan itself manages after the fill. Positions are read from your Dhan account, so they come back
            after a restart and include anything opened elsewhere; P&amp;L moves with the live tick feed.
          </Text>
        ) : (
        <Text type="secondary" style={{ fontSize: 10 }}>
          Paper trade only - simulated against this replay's own premium series, no real order is ever placed. Buy (long) or Sell (short/write),
          then Exit; lot size is a fixed per-underlying constant, not fetched live. SL/Target auto-exit an
          open position once its own premium has moved that many points against/in its favor (0 disables
          either), checked against every revealed minute bar's own high-low since entry (or each live
          tick, once today's live feed is ticking) - not just the latest price - so a real intra-bar touch
          is caught even if price reverses before the next check. Exit all closes every open position
          right now at its current price, without clearing the table the way Clear all does. Today's own
          positions survive a page reload (saved locally in this browser); loading a historical day, a
          different underlying, or clicking Clear all still resets them.
        </Text>
        )}
      </Space>
    </div>
  )
}

// The right-hand OI/IV ladder: every strike in the fetched band gets its own row (never just the
// single heaviest one - see this page's own "there could be multiple [levels]" request), a CE bar
// extending right and a PE bar extending left from a shared center scale, both sides' IV printed
// alongside. The row(s) actually carrying the MOST OI on each side are called out as the current
// resistance (CE)/support (PE) read, since a wall only means something relative to the rest of the
// chain, not in isolation.
function OiLadder({ rows, atmStrike, sudden = [] }) {
  if (rows.length === 0) return <Empty description="No stored OI/IV data yet at this point in the replay." />

  // ONE shared max across BOTH sides, not one independently computed per side - the exact same bug
  // just fixed on the chart's own R/S lines (see ReplayChart's own doc comment): a 33M PE bar and a
  // 17M CE bar rendering at the SAME width because each was only ever measured against its own
  // side's own max would give exactly the "false impression" the user's own screenshots caught.
  // Bar width now means the same thing everywhere in this ladder, CE or PE.
  const maxOi = Math.max(1, ...rows.map((r) => r.ceOi ?? 0), ...rows.map((r) => r.peOi ?? 0))
  const resistanceStrike = rows.reduce((best, r) => ((r.ceOi ?? 0) > (best?.ceOi ?? -1) ? r : best), null)?.strike
  const supportStrike = rows.reduce((best, r) => ((r.peOi ?? 0) > (best?.peOi ?? -1) ? r : best), null)?.strike
  const suddenAt = new Map(sudden.map((w) => [`${w.side}${w.strike}`, w]))

  return (
    // Every row packs several fixed-width pieces (bars, OI text, IV text) into the 10/4/10 split
    // below - shrinking that split on a narrow phone would squash or wrap those pieces into an
    // unreadable mess, so instead this scrolls horizontally at its own natural width (minWidth)
    // rather than trying to reflow. touchAction/WebkitOverflowScrolling make that scroll a normal
    // touch swipe on a phone, not just a desktop scrollbar drag.
    <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 500 }}>
      <Row style={{ fontSize: 'clamp(9px, 2.4vw, 11px)', color: AXIS_COLOR, marginBottom: 4 }}>
        <Col span={10} style={{ textAlign: 'right', paddingRight: 6 }}>PE OI (support, in M)</Col>
        <Col span={4} style={{ textAlign: 'center' }}>Strike</Col>
        <Col span={10} style={{ paddingLeft: 6 }}>CE OI (resistance, in M)</Col>
      </Row>
      {rows.map((row) => {
        const isAtm = atmStrike != null && row.strike === atmStrike
        const isResistance = row.strike === resistanceStrike && (row.ceOi ?? 0) > 0
        const isSupport = row.strike === supportStrike && (row.peOi ?? 0) > 0
        return (
          <Row
            key={row.strike}
            align="middle"
            style={{
              background: isAtm ? '#ffffff12' : 'transparent',
              borderTop: isResistance ? `1px solid ${DOWN_COLOR}` : isSupport ? `1px solid ${UP_COLOR}` : '1px solid transparent',
              borderBottom: isResistance ? `1px solid ${DOWN_COLOR}` : isSupport ? `1px solid ${UP_COLOR}` : '1px solid transparent',
              padding: '1px 0',
            }}
          >
            <Col span={10} style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4, opacity: row.peStale ? 0.45 : 1 }}>
              <OiChangeStack changeValue={row.peOiChange} sinceOpenValue={row.peOiSinceOpen} />
              <Text style={{ fontSize: 'clamp(8px, 2.2vw, 10px)', color: AXIS_COLOR, whiteSpace: 'nowrap' }}>
                {row.pePrice != null ? `${row.pePrice.toFixed(2)}` : ''}
                {row.peIv != null ? ` · IV ${row.peIv.toFixed(1)}` : ''}
                {row.peStale ? ' ⚠' : ''}
              </Text>
              <Text style={{ fontSize: 'clamp(7px, 2vw, 9px)', color: AXIS_COLOR, width: 'clamp(24px, 7vw, 34px)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                {row.peOi != null ? formatOiMillions(row.peOi) : ''}
              </Text>
              <div style={{ width: 'clamp(44px, 13vw, 70px)', display: 'flex', justifyContent: 'flex-end' }}>
                <Tooltip title={row.peOi != null ? `PE OI: ${row.peOi.toLocaleString()}${row.pePrice != null ? `, LTP ${row.pePrice.toFixed(2)}` : ''}${row.peOiChange != null ? ` (${row.peOiChange >= 0 ? '+' : ''}${row.peOiChange.toLocaleString()} in the last min)` : ''}${row.peOiSinceOpen != null ? ` (${row.peOiSinceOpen >= 0 ? '+' : ''}${row.peOiSinceOpen.toLocaleString()} since open)` : ''}${row.peStale && row.peAsOfMs != null ? ` — STALE, no update since ${istTimeFormatter(toChartTime(row.peAsOfMs))}` : ''}` : 'No data'}>
                  <div style={{
                    width: `${((row.peOi ?? 0) / maxOi) * 100}%`, minWidth: row.peOi ? 2 : 0, height: 14,
                    background: isSupport ? UP_COLOR : `${UP_COLOR}99`,
                  }} />
                </Tooltip>
              </div>
            </Col>
            <Col span={4} style={{ textAlign: 'center' }}>
              {suddenAt.has(`PE${row.strike}`) && <Tooltip title={`Sudden PUT wall: ${suddenWallText(suddenAt.get(`PE${row.strike}`))}`}><span style={{ color: UP_COLOR, marginRight: 2 }} aria-label="Sudden PUT wall">🧱</span></Tooltip>}
              <Text strong={isAtm} style={{ fontSize: 'clamp(10px, 2.8vw, 12px)', color: isAtm ? '#fff' : undefined }}>{row.strike.toLocaleString()}</Text>
              {suddenAt.has(`CE${row.strike}`) && <Tooltip title={`Sudden CALL wall: ${suddenWallText(suddenAt.get(`CE${row.strike}`))}`}><span style={{ color: DOWN_COLOR, marginLeft: 2 }} aria-label="Sudden CALL wall">🧱</span></Tooltip>}
            </Col>
            <Col span={10} style={{ display: 'flex', alignItems: 'center', gap: 4, opacity: row.ceStale ? 0.45 : 1 }}>
              <div style={{ width: 'clamp(44px, 13vw, 70px)' }}>
                <Tooltip title={row.ceOi != null ? `CE OI: ${row.ceOi.toLocaleString()}${row.cePrice != null ? `, LTP ${row.cePrice.toFixed(2)}` : ''}${row.ceOiChange != null ? ` (${row.ceOiChange >= 0 ? '+' : ''}${row.ceOiChange.toLocaleString()} in the last min)` : ''}${row.ceOiSinceOpen != null ? ` (${row.ceOiSinceOpen >= 0 ? '+' : ''}${row.ceOiSinceOpen.toLocaleString()} since open)` : ''}${row.ceStale && row.ceAsOfMs != null ? ` — STALE, no update since ${istTimeFormatter(toChartTime(row.ceAsOfMs))}` : ''}` : 'No data'}>
                  <div style={{
                    width: `${((row.ceOi ?? 0) / maxOi) * 100}%`, minWidth: row.ceOi ? 2 : 0, height: 14,
                    background: isResistance ? DOWN_COLOR : `${DOWN_COLOR}99`,
                  }} />
                </Tooltip>
              </div>
              <Text style={{ fontSize: 'clamp(7px, 2vw, 9px)', color: AXIS_COLOR, width: 'clamp(24px, 7vw, 34px)', whiteSpace: 'nowrap' }}>
                {row.ceOi != null ? formatOiMillions(row.ceOi) : ''}
              </Text>
              <OiChangeStack changeValue={row.ceOiChange} sinceOpenValue={row.ceOiSinceOpen} />
              <Text style={{ fontSize: 'clamp(8px, 2.2vw, 10px)', color: AXIS_COLOR, whiteSpace: 'nowrap' }}>
                {row.cePrice != null ? `${row.cePrice.toFixed(2)}` : ''}
                {row.ceIv != null ? ` · IV ${row.ceIv.toFixed(1)}` : ''}
                {row.ceStale ? ' ⚠' : ''}
              </Text>
            </Col>
          </Row>
        )
      })}
    </div>
    </div>
  )
}

// Inside this band, CE and PE OI at a strike are considered close enough to call the level
// "Balanced" rather than one side outright dominating - a strike sitting only barely call-heavy
// isn't a real resistance read, it's noise around a 50/50 split.
const IMBALANCE_NEUTRAL_BAND = 0.15
// Liquidity strength buckets - a strike's OWN dominant side (whichever of CE/PE is larger there),
// read as a fraction of the WHOLE band's own heaviest single side anywhere - the same "how does
// this compare to the strongest wall on the chain" read the chart's own price lines already use
// (see ReplayChart's own t = value/maxOi), just bucketed into three labels instead of a continuous
// line thickness, since a table row needs a word, not a gradient.
const LIQUIDITY_STRONG_THRESHOLD = 0.66
const LIQUIDITY_MEDIUM_THRESHOLD = 0.33

function biasTagColor(bias) {
  return bias === 'Bullish' ? 'success' : bias === 'Bearish' ? 'error' : 'default'
}

// Per-strike liquidity/imbalance/bias read across the WHOLE fetched band (not just the 5 strongest
// levels ReplayChart draws) - the user's own "table which shows price imbalance and liquidity level
// and where price can likely go" ask. Each row answers three questions at that ONE strike:
//   - Zone: which side (if either) actually dominates there (Resistance=call-heavy, Support=
//     put-heavy, Balanced=neither, inside IMBALANCE_NEUTRAL_BAND)
//   - Liquidity: how heavy that dominant side is, relative to the single heaviest side ANYWHERE in
//     the band - "is this a real wall or a minor bump"
//   - Bias: reads the dominant side's own OI change since today's open, same rule ReplayChart's own
//     left-side CE/PE delta tags already use (rising CE OI = bearish call-writing defending
//     resistance, rising PE OI = bullish put-writing defending support) - applied here per level
//     instead of just the single strongest one.
// This is a mechanical relabeling of numbers already shown elsewhere on this page (the ladder, the
// chart, Market Read) into one glanceable table, not a new prediction - see the summary row below
// the table for the plain "nearest wall each way" read of "where price can likely go".
function LiquidityMapTable({ rows, atmStrike, currentPrice, sudden = [] }) {
  if (rows.length === 0) return <Empty description="No stored OI/IV data yet at this point in the replay." />

  const bandMaxOi = Math.max(1, ...rows.map((r) => r.ceOi ?? 0), ...rows.map((r) => r.peOi ?? 0))

  const enriched = rows.map((row) => {
    const ce = row.ceOi ?? 0
    const pe = row.peOi ?? 0
    const total = ce + pe
    const imbalance = total > 0 ? (ce - pe) / total : 0
    const zone = total === 0 ? 'No OI' : imbalance > IMBALANCE_NEUTRAL_BAND ? 'Resistance' : imbalance < -IMBALANCE_NEUTRAL_BAND ? 'Support' : 'Balanced'
    const dominantOi = Math.max(ce, pe)
    const liquidityFrac = dominantOi / bandMaxOi
    const liquidity = dominantOi === 0 ? 'None' : liquidityFrac >= LIQUIDITY_STRONG_THRESHOLD ? 'Strong' : liquidityFrac >= LIQUIDITY_MEDIUM_THRESHOLD ? 'Medium' : 'Weak'

    let bias = 'Neutral'
    if (zone === 'Resistance' && row.ceOiSinceOpen != null && row.ceOiSinceOpen !== 0) bias = row.ceOiSinceOpen > 0 ? 'Bearish' : 'Bullish'
    else if (zone === 'Support' && row.peOiSinceOpen != null && row.peOiSinceOpen !== 0) bias = row.peOiSinceOpen > 0 ? 'Bullish' : 'Bearish'

    const distance = currentPrice != null ? row.strike - currentPrice : null
    return { ...row, zone, imbalance, liquidity, bias, distance }
  })

  // "Where price can likely go" - the nearest REAL wall (Medium/Strong liquidity, not a Weak/
  // Balanced blip) on each side of the current price. A trader reads this as "the move needs to
  // clear THIS many points to reach the next real resistance/support" - a plain distance-to-wall
  // fact, not a forecast of whether it will.
  const above = enriched.filter((r) => r.distance != null && r.distance > 0 && r.zone === 'Resistance' && r.liquidity !== 'Weak')
    .sort((a, b) => a.distance - b.distance)
  const below = enriched.filter((r) => r.distance != null && r.distance < 0 && r.zone === 'Support' && r.liquidity !== 'Weak')
    .sort((a, b) => b.distance - a.distance)
  const nearestResistance = above[0] ?? null
  const nearestSupport = below[0] ?? null

  const columns = [
    {
      title: 'Strike', dataIndex: 'strike', key: 'strike', width: 90,
      render: (strike) => <Text strong={strike === atmStrike}>{strike.toLocaleString()}{strike === atmStrike ? ' (ATM)' : ''}</Text>,
    },
    { title: 'Distance', dataIndex: 'distance', key: 'distance', width: 90, render: (d) => (d == null ? '—' : `${d >= 0 ? '+' : ''}${d.toFixed(0)}`) },
    { title: 'CE OI', dataIndex: 'ceOi', key: 'ceOi', width: 90, render: (v) => formatOiMillions(v) },
    { title: 'PE OI', dataIndex: 'peOi', key: 'peOi', width: 90, render: (v) => formatOiMillions(v) },
    {
      title: 'Imbalance', dataIndex: 'imbalance', key: 'imbalance', width: 130,
      render: (v, r) => (r.zone === 'No OI' ? '—' : `${(Math.abs(v) * 100).toFixed(0)}% ${v >= 0 ? 'call' : 'put'}-heavy`),
    },
    { title: 'Zone', dataIndex: 'zone', key: 'zone', width: 100, render: (z) => <Tag color={z === 'Resistance' ? 'error' : z === 'Support' ? 'success' : 'default'}>{z}</Tag> },
    { title: 'Liquidity', dataIndex: 'liquidity', key: 'liquidity', width: 90, render: (l) => <Tag color={l === 'Strong' ? 'red' : l === 'Medium' ? 'orange' : 'default'}>{l}</Tag> },
    { title: 'Bias', dataIndex: 'bias', key: 'bias', width: 90, render: (b) => <Tag color={biasTagColor(b)}>{b}</Tag> },
    {
      title: <Tooltip title="A sudden OI wall in the last 5 minutes: the strike added 3%+ of its OI at 3x+ its pace before.">Sudden (5m)</Tooltip>, key: 'sudden', width: 150,
      render: (_, r) => {
        const here = sudden.filter((w) => w.strike === r.strike)
        return here.length ? here.map((w) => (
          <Tooltip key={w.side} title={suddenWallText(w)}>
            <Tag color={w.side === 'PE' ? 'green' : 'red'} style={{ marginBottom: 2 }}>🧱 {w.side === 'PE' ? 'PUT' : 'CALL'} +{(w.add / 1e5).toFixed(1)}L</Tag>
          </Tooltip>
        )) : null
      },
    },
  ]

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Row gutter={24}>
        <Col>
          <Statistic
            title="Nearest resistance above"
            value={nearestResistance ? `${nearestResistance.strike} (+${nearestResistance.distance.toFixed(0)} pts)` : '— none in range'}
            valueStyle={{ fontSize: 16, color: nearestResistance ? DOWN_COLOR : undefined }}
          />
          {nearestResistance && <Text type="secondary" style={{ fontSize: 11 }}>{nearestResistance.liquidity} liquidity, {nearestResistance.bias.toLowerCase()} bias</Text>}
        </Col>
        <Col>
          <Statistic
            title="Nearest support below"
            value={nearestSupport ? `${nearestSupport.strike} (-${Math.abs(nearestSupport.distance).toFixed(0)} pts)` : '— none in range'}
            valueStyle={{ fontSize: 16, color: nearestSupport ? UP_COLOR : undefined }}
          />
          {nearestSupport && <Text type="secondary" style={{ fontSize: 11 }}>{nearestSupport.liquidity} liquidity, {nearestSupport.bias.toLowerCase()} bias</Text>}
        </Col>
      </Row>
      <div aria-label="Sudden OI walls">
        <Text strong style={{ fontSize: 12 }}>Sudden OI walls (last 5 min): </Text>
        {sudden.length === 0 && <Text type="secondary" style={{ fontSize: 12 }}>none</Text>}
        {sudden.map((w) => (
          <Tooltip key={`${w.side}${w.strike}`} title={suddenWallText(w)}>
            <Tag color={w.side === 'PE' ? 'green' : 'red'} style={{ marginBottom: 4 }}>
              🧱 {w.side === 'PE' ? 'PUT' : 'CALL'} {w.strike} +{(w.add / 1e5).toFixed(1)}L ({(w.pct * 100).toFixed(1)}%) · {w.side === 'PE' ? 'support' : 'resistance'}
            </Tag>
          </Tooltip>
        ))}
      </div>
      {/* scroll.x - these columns' own widths sum past a phone's viewport, so the table needs to
          scroll horizontally there rather than squash columns or overflow the page. */}
      <Table
        dataSource={enriched} columns={columns} rowKey="strike" size="small" pagination={false}
        scroll={{ x: 920, y: 360 }}
        onRow={(r) => (sudden.some((w) => w.strike === r.strike) ? { style: { background: '#faad1418' } } : {})}
      />
      <Text type="secondary" style={{ fontSize: 11 }}>
        Zone/Liquidity/Bias are a mechanical read of the OI already shown in the ladder above (CE vs PE at each strike, and how that compares to the
        rest of the band) - not a prediction. "Nearest wall" is a distance fact; whether price actually reaches or holds it is not something OI alone can tell you.
      </Text>
    </Space>
  )
}

// Same reasoning as ExpiredBacktestPage's own ChartErrorBoundary - a lightweight-charts assertion or
// bad data shape should degrade to a message, not blank the whole page (the stats/ladder above are
// still useful even if the chart itself can't render). Must be a class component; React has no hook
// equivalent for catching a child's render/effect errors.
class ChartErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error('OI Replay chart crashed:', error)
  }

  render() {
    if (this.state.error) {
      return <Alert type="warning" showIcon message="This chart could not be rendered - the ladder and stats above are still available." />
    }
    return this.props.children
  }
}

// A small colored delta label for a one-minute OI change - green/up for building, red/down for
// unwinding, dash for no change or not-yet-available (first minute of the day, no prior reading).
function OiChange({ value }) {
  if (value == null || value === 0) return <Text style={{ fontSize: 'clamp(7px, 2vw, 9px)', color: AXIS_COLOR }}>·</Text>
  const up = value > 0
  return (
    <Text style={{ fontSize: 'clamp(7px, 2vw, 9px)', color: up ? UP_COLOR : DOWN_COLOR }}>
      {up ? '▲' : '▼'}{formatOiMillions(Math.abs(value))}
    </Text>
  )
}

// OI, everywhere on this page, always in millions - the user's own explicit "show all the tags in
// million for OI" ask, so every OI figure (a level's own OI, a per-minute/since-open/since-previous-
// candle change, a whole-band total) reads in the SAME unit and is directly comparable at a glance,
// rather than mixing raw comma-grouped numbers in some places and K/M-switching ones in others.
// signed=true prefixes a delta with +/- (a "change" reads oddly without a sign); an absolute level
// never needs one. withUnit=false drops the trailing "M" for a context that already labels the unit
// itself (an axis/column header, most concretely).
function formatOiMillionsAxis(v, precise) {
  if (!Number.isFinite(v)) return ''
  const millions = v / 1_000_000
  return `${millions > 0 && precise ? '+' : ''}${millions.toFixed(precise ? 3 : 2)}M`
}

function formatOiMillions(n, { signed = false, withUnit = true } = {}) {
  if (n == null) return '—'
  const millions = n / 1_000_000
  const sign = signed && millions > 0 ? '+' : ''
  return `${sign}${millions.toFixed(2)}${withUnit ? 'M' : ''}`
}

// Cumulative OI change since the day's very first revealed candle - same up/down coloring as
// OiChange (the last-minute delta) but visually distinct ("open" tag and a tooltip with the exact
// figure) so it's never confused with the single-tick number sitting right next to it - this is
// the whole day's drift, per the user's own "change in OI since days open".
function SinceOpenChange({ value }) {
  if (value == null) return null
  if (value === 0) return <Text style={{ fontSize: 'clamp(6px, 1.8vw, 8px)', color: AXIS_COLOR }}>open ·</Text>
  const up = value > 0
  return (
    <Tooltip title={`${up ? '+' : ''}${value.toLocaleString()} since today's open`}>
      <Text style={{ fontSize: 'clamp(6px, 1.8vw, 8px)', color: up ? UP_COLOR : DOWN_COLOR, whiteSpace: 'nowrap' }}>
        open {formatOiMillions(value, { signed: true })}
      </Text>
    </Tooltip>
  )
}

function OiChangeStack({ changeValue, sinceOpenValue }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.15 }}>
      <OiChange value={changeValue} />
      <SinceOpenChange value={sinceOpenValue} />
    </div>
  )
}

function biasColor(bias) {
  return bias === 'Bullish' ? 'success' : bias === 'Bearish' ? 'error' : 'default'
}

const SPEED_OPTIONS = [
  { value: 2000, label: '0.5x' },
  { value: 1000, label: '1x' },
  { value: 500, label: '2x' },
  { value: 250, label: '4x' },
  { value: 100, label: '10x' },
]

// Candle-by-candle replay of one trading day - spot chart on the left, an OI/IV ladder across the
// whole fetched strike band on the right, updating together as playback advances. A past day's data
// comes from NiftyDataCollector's own TimescaleDB, falling back to a direct Dhan REST call when
// that's not fresh enough (see OiReplayService's own doc comment); TODAY additionally stays live
// via OiReplayLiveFeedService's WebSocket-fed ticks (see useOiReplayLiveFeed below) once the
// initial snapshot has loaded, rather than only ever showing whatever was true at load time.
export default function OiReplayPage() {
  const [underlying, setUnderlying] = usePersistedState(STORED_UNDERLYING, 'NIFTY')
  const [timeframe, setTimeframe] = usePersistedState(STORED_TIMEFRAME, 5)
  // Only meaningful for a HISTORICAL (non-today) day - Dhan's rolling-option REST endpoint (what a
  // past day's CE/PE data ultimately comes from) only ever accepts these two literal flags.
  const [expiryFlag, setExpiryFlag] = useState('WEEK')
  // "N1".."N6" - the Nth nearest currently-listed expiry for `underlying` overall, only meaningful
  // while isLive (see the expiry Select below, shown in place of the WEEK/MONTH one once live). The
  // user's own explicit "it's going to next expiry, add an expiry filter" ask for the live page this
  // replaced (see OiReplayLiveFeedService.PositionalExpiriesPerUnderlying's own doc comment) - being
  // able to see and pick the EXACT contract removes any need to trust an automatic "nearest"
  // resolution once today is playing live.
  const [liveExpiryFlag, setLiveExpiryFlag] = useState('N1')
  // The full flat list of currently-listed expiry dates backing that picker (index i is always flag
  // "N{i+1}" - see OiReplayController.GetExpiries' own doc comment), plus which of them (if any) is
  // the real calendar date "Weekly"/"Monthly" resolve to, shown as a tag on the matching option.
  const [resolvedExpiries, setResolvedExpiries] = useState({ week: null, month: null, expiries: [] })
  const [date, setDate] = useState(null)
  const [speedMs, setSpeedMs] = useState(500)

  // Two EmaChart instances, running SIDE BY SIDE alongside the main (typically 15-min) chart - the
  // user's own "I need basically three charts... 15, 3 and 1 min... according to their tick" ask:
  // not a single switchable secondary chart anymore, but two independent ones defaulting to 3-min
  // and 1-min so all three are visible and ticking at once on a wide enough monitor. Each keeps its
  // own timeframe/EMA controls (see EmaChart itself), so either can still be retuned to something
  // else entirely if wanted. Deliberately NOT persisted the way the main timeframe is - a quick
  // per-session tuning knob, not a durable preference.
  const [chartBTimeframe, setChartBTimeframe] = useState(3)
  const [chartBEma1, setChartBEma1] = useState(9)
  const [chartBEma2, setChartBEma2] = useState(15)
  // ATM OI change over the last N bars of chart B's OWN timeframe - shown as a small overlay
  // directly on chart B's own Card (not a separate panel) - the replay clock (asOfMs) keeps this
  // from ever revealing more than the rest of the page has "played" up to.
  const [oiLookbackBars, setOiLookbackBars] = useState(3)
  // Total OI Lookback Table's own state (Day OI Accumulation card, below) - deliberately separate
  // from chart B's own oiLookbackBars above: several bar counts at once, against the WHOLE chain's
  // total OI rather than one strike, with its own independent timeframe (default 1-minute bars).
  const [totalOiLookbackBars, setTotalOiLookbackBars] = useState(DEFAULT_TOTAL_OI_LOOKBACK_BARS)
  const [totalOiLookbackTimeframe, setTotalOiLookbackTimeframe] = useState(1)
  // OI change heatmap's own bucket size - see HEATMAP_TIMEFRAME_OPTIONS' own doc comment for why this
  // is independent of every other timeframe picker on the page.
  const [heatmapTimeframeMinutes, setHeatmapTimeframeMinutes] = useState(1)
  // The Futures chart's own candle timeframe (1/3/5/15), independent of the spot chart's.
  const [futuresTimeframe, setFuturesTimeframe] = usePersistedState('optionanalytics.oiReplay.futuresTimeframe', 5)
  // The futures DOM (full market depth ladder) drawer - see DomDrawer.jsx.
  const [domOpen, setDomOpen] = useState(false)
  // Volume profile on the futures chart (POC / value area lines) - see futuresProfile below.
  const [futuresProfileOn, setFuturesProfileOn] = usePersistedState('optionanalytics.oiReplay.futuresProfile', true)
  // Delta / cumulative delta under the futures candles - from the order flow server: exact for a day it
  // saw live, else estimated from 1-minute candles (see futuresFlow below).
  const [futuresDeltaOn, setFuturesDeltaOn] = usePersistedState('optionanalytics.oiReplay.futuresDelta', true)
  const [futuresFlow, setFuturesFlow] = useState(null)
  // Which of the two whole-chain OI charts the Day OI Accumulation card shows - see the chart
  // itself, further down, for why this is a switch rather than the per-strike drilldown's own
  // stacked pair (both would double this card's already-tall height, and the day-level numbers
  // right above the chart already give the CURRENT since-open figure - the chart's own job here is
  // showing its TRAJECTORY, one view at a time, not re-deriving the same number again).
  const [dayOiChartMode, setDayOiChartMode] = useState('total')
  const [chartCTimeframe, setChartCTimeframe] = useState(1)
  const [chartCEma1, setChartCEma1] = useState(9)
  const [chartCEma2, setChartCEma2] = useState(15)

  // Option premium chart's own CE/PE strike pickers - offsets from ATM (see StrikePicker.jsx),
  // independently selectable, both defaulting to ATM itself.
  const [cePremiumOffset, setCePremiumOffset] = useState(0)
  const [pePremiumOffset, setPePremiumOffset] = useState(0)
  const [cePremiumTimeframe, setCePremiumTimeframe] = useState(1)
  const [cePremiumEma1, setCePremiumEma1] = useState(9)
  const [cePremiumEma2, setCePremiumEma2] = useState(15)
  const [pePremiumTimeframe, setPePremiumTimeframe] = useState(1)
  const [pePremiumEma1, setPePremiumEma1] = useState(9)
  const [pePremiumEma2, setPePremiumEma2] = useState(15)

  const [visibleSections, setVisibleSections] = useState(ALL_SECTION_VALUES)
  // Drag-to-reorder the page's own top-level blocks - see OI_REPLAY_CARD_IDS' own doc comment.
  const { order: cardOrder, dragHandleProps, dropTargetProps } = useCardOrder('optionanalytics.oiReplayCardOrder', OI_REPLAY_CARD_IDS)
  // dropTargetProps already returns its own conditional highlight `style` (see useCardOrder's own
  // doc comment) - merged here with the `order` CSS property that actually moves the block, rather
  // than each of the 9 call sites below re-deriving that merge by hand.
  // See LiveSection - off-screen sections still re-render when this changes (layout, not data).
  const sectionVersion = `${cardOrder.join(',')}|${visibleSections.join(',')}`

  const orderedDropProps = (id) => {
    const { style, ...handlers } = dropTargetProps(id)
    return { style: { order: cardOrder.indexOf(id), ...style }, ...handlers }
  }

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  // The MANUAL replay position - only meaningful for a historical (non-today) day. Renamed from
  // this component's old bare `visibleCount` because today never uses it at all any more - see
  // visibleCount's own derivation further down.
  const [manualVisibleCount, setManualVisibleCount] = useState(0)
  const [playing, setPlaying] = useState(false)
  const timerRef = useRef(null)

  // The in-flight run fetch's own controller - lets a NEWER load() abort a STILL-PENDING older one
  // (so a stale response can never land after a newer one already did) and lets the user's own
  // Cancel button abort a load that is taking too long, instead of just staring at "Loading..."
  // with no way out. See LOAD_TIMEOUT_MS's own doc comment for the auto-cancel this also drives.
  const activeLoadController = useRef(null)

  // The live "tail" beyond whatever the initial REST snapshot carried - only ever appended to while
  // isLive is true (see below), reset on every fresh load() so switching days never carries a
  // previous day's live ticks forward.
  const [liveBars, setLiveBars] = useState([])
  const [liveCePoints, setLiveCePoints] = useState([])
  const [livePePoints, setLivePePoints] = useState([])
  const [liveFuturesPoints, setLiveFuturesPoints] = useState([])
  const lastTickAtRef = useRef(null)
  const lastSpotAtRef = useRef(null)
  // Newest server-observed tick time seen so far - see asOfMs below.
  const [latestLiveMs, setLatestLiveMs] = useState(0)
  // When Dhan last reported a DIFFERENT open interest on any tracked leg - see the heatmap card's own
  // "OI last changed" readout. Prices tick constantly but OI only moves on position changes, so this
  // is what tells "the feed is live but OI is quiet" apart from "nothing is arriving".
  const lastOiByLegRef = useRef(new Map())
  const [lastOiChangeMs, setLastOiChangeMs] = useState(null)
  const [spotSilentMs, setSpotSilentMs] = useState(0)

  // Session VWAP - only meaningful for isLive (see oneMinBars' own identical isLive split just
  // below): the live GET .../vwap-series endpoint reflects SpotUnderlyingState's own in-memory
  // volume bars, i.e. recent/current days, not whatever historical day this page might otherwise be
  // replaying. A genuinely historical day's own spotCandlesOneMinute carries no volume at all (see
  // OiReplayResult), so VWAP simply isn't shown while replaying one - reset on every load() like
  // liveBars above, seeded once isLive in load()'s own .then(), grown live by handleSpotUpdate.
  const [vwapSeries, setVwapSeries] = useState([])
  const [showVwap, setShowVwap] = usePersistedState(STORED_SHOW_VWAP, false)

  // Previous-day volume profile (POC/VAH/VAL/HVN/LVN) - marked on the fast entry charts (B/C) ON BY
  // DEFAULT (the user's own original ask), with this checkbox the one way to hide it once it's
  // covering something else on the chart - same persisted-shared-across-pages shape as showVwap
  // above, just defaulting true instead of false since this one starts ON. Still fetched regardless
  // of whether it's currently shown (cheap, and toggling back on shouldn't need a fresh network
  // round trip) - only the DRAWING inside EmaChart is gated on it.
  const [showVolumeProfile, setShowVolumeProfile] = usePersistedState(STORED_SHOW_VOLUME_PROFILE, true)
  // Refetched whenever the underlying or the loaded day itself changes (NOT on every tick - these are
  // yesterday's own already-closed levels, which never move once fetched) - keyed off result's own
  // fields rather than the raw underlying/date state above so this never fires for a day whose actual
  // data hasn't landed yet.
  const [volumeProfile, setVolumeProfile] = useState(null)
  useEffect(() => {
    if (!result?.success || !underlying || !result.date) { setVolumeProfile(null); return }
    let cancelled = false
    fetch(`/api/oi-replay/${underlying}/previous-day-volume-profile?date=${result.date}`)
      .then((r) => r.json())
      .then((body) => { if (!cancelled) setVolumeProfile(body?.success ? body : null) })
      .catch((err) => { if (!cancelled) { console.error('Failed to load previous-day volume profile:', err); setVolumeProfile(null) } })
    return () => { cancelled = true }
  }, [underlying, result?.success, result?.date])

  // Paper trade panel state - see PaperTradePanel's own doc comment. strikeOffset defaults to 0
  // (ATM) and stays an OFFSET rather than an absolute strike, so "the default is ATM" holds true
  // all through the session even as ATM itself drifts with price - the user never has to re-pick it
  // unless they actually want an OTM/ITM strike instead. Positions reset on every fresh load() of a
  // HISTORICAL day, same as the live feed's own tail - a paper position only means something against
  // the ONE day's premium series it was punched into. TODAY's own positions are the one exception:
  // they persist in localStorage instead (see PAPER_POSITIONS_STORAGE_KEY's own doc comment) so a
  // page reload doesn't lose an open live session's positions - only Clear all, or loading a
  // different day/underlying, actually clears them.
  const [paperSide, setPaperSide] = useState('CE')
  const [paperDirection, setPaperDirection] = useState('BUY')
  const [paperStrikeOffset, setPaperStrikeOffset] = useState(0)
  const [paperQtyLots, setPaperQtyLots] = useState(10)
  // Auto stop-loss/target, in premium points - on by default with each underlying's own levels
  // (tradeDefaults.js: NIFTY 20/30, BANKNIFTY 50/75, SENSEX 60/90), what the trader sets kept per
  // underlying in this browser. 0/blank disables either one (see the effect that reads these below).
  const [paperSlPoints, setPaperSlPointsState] = useState(() => loadTradeLevels('oiReplay', underlying).sl)
  const [paperTargetPoints, setPaperTargetPointsState] = useState(() => loadTradeLevels('oiReplay', underlying).target)
  useEffect(() => {
    const levels = loadTradeLevels('oiReplay', underlying)
    setPaperSlPointsState(levels.sl)
    setPaperTargetPointsState(levels.target)
  }, [underlying])
  // Trailing stop on the premium: after `trailStart` pts of profit the stop follows the best premium
  // `trailGap` pts behind (0 = off) - paper here, and the live super order's stop-loss leg on the server.
  const [paperTrailStart, setPaperTrailStartState] = useState(() => loadTradeLevels('oiReplay', underlying).trailStart)
  const [paperTrailGap, setPaperTrailGapState] = useState(() => loadTradeLevels('oiReplay', underlying).trailGap)
  useEffect(() => {
    const levels = loadTradeLevels('oiReplay', underlying)
    setPaperTrailStartState(levels.trailStart)
    setPaperTrailGapState(levels.trailGap)
  }, [underlying])
  // The levels are one global setting per underlying: a change made on another page / tab lands here too.
  useEffect(() => subscribeTradeLevels(() => {
    const levels = loadTradeLevels('oiReplay', underlying)
    setPaperSlPointsState(levels.sl)
    setPaperTargetPointsState(levels.target)
    setPaperTrailStartState(levels.trailStart)
    setPaperTrailGapState(levels.trailGap)
  }), [underlying])
  const setPaperTrailStart = (v) => { setPaperTrailStartState(v); saveTradeLevels('oiReplay', underlying, { trailStart: v }) }
  const setPaperTrailGap = (v) => { setPaperTrailGapState(v); saveTradeLevels('oiReplay', underlying, { trailGap: v }) }
  const setPaperSlPoints = (v) => { setPaperSlPointsState(v); saveTradeLevels('oiReplay', underlying, { sl: v, target: paperTargetPoints }) }
  const setPaperTargetPoints = (v) => { setPaperTargetPointsState(v); saveTradeLevels('oiReplay', underlying, { sl: paperSlPoints, target: v }) }
  const [paperPositions, setPaperPositions] = useState([])
  // Toggled by the trigger button/tag and the panel's own close button only - never by clicking
  // elsewhere (it's a portal-rendered DraggableFloatingPanel, not an antd Popover, so there is no
  // click-outside-to-dismiss behavior to fight in the first place). Position lives here, not inside
  // the panel component, so it survives closing and reopening rather than resetting every time.
  const [paperPanelOpen, setPaperPanelOpen] = useState(false)
  const [paperPanelPos, setPaperPanelPos] = useState(() => ({
    x: Math.max(24, window.innerWidth - 480), y: 140,
  }))
  // null (the default) keeps DraggableFloatingPanel's own original fixed-440px-wide, grow-to-content
  // height - only set once the user actually drags the resize handle, same "caller owns the state"
  // shape as paperPanelPos above.
  const [paperPanelSize, setPaperPanelSize] = useState(null)
  // The replay controls (Start/Pause, Reset, Speed, Go to time, slider) either sit inline in the Spot
  // card or float in their own draggable panel that stays in reach while scrolling - the viewer's
  // choice, remembered in this browser. Closing the floating panel docks them back inline.
  const [replayControlsFloating, setReplayControlsFloating] = usePersistedState(STORED_REPLAY_CONTROLS_FLOATING, false)
  const [replayPanelPos, setReplayPanelPos] = useState(() => ({ x: Math.max(24, Math.round(window.innerWidth / 2 - 240)), y: 90 }))
  const [replayPanelSize, setReplayPanelSize] = useState(null)
  // The whole Spot card (chart, alerts, replay controls) can float too - e.g. beside the heatmap.
  // Remembered in this browser; independent of every other floating panel's own state.
  const [spotFloating, setSpotFloating] = usePersistedState(STORED_SPOT_FLOATING, false)
  // Trade panel Live mode - REAL Dhan orders (see LiveTrading.jsx). Never persisted: every page load
  // starts on Paper, and switching to Live asks for confirmation first.
  const auth = useAuth()
  const isAdmin = auth?.user?.role === 'Admin'
  const [tradeMode, setTradeMode] = useState('paper')
  const [liveSlippage, setLiveSlippage] = usePersistedState('optionanalytics.oiReplay.liveSlippage', 1)
  const [livePositions, setLivePositions] = useState(null)
  // Every live positions snapshot (pushed, or read after an action) carries the day's trade events -
  // entry filled, stop-loss / target hit, exit filled, rejected - each notified once.
  const applyLivePositions = useCallback((snapshot) => {
    setLivePositions(snapshot)
    notifyLiveTradeEvents(snapshot?.events)
  }, [])
  const [liveBusy, setLiveBusy] = useState(false)
  const liveTradeActive = tradeMode === 'live' && isAdmin
  const liveExtraGroups = useMemo(() => (liveTradeActive ? ['positions'] : []), [liveTradeActive])
  const [spotPanelPos, setSpotPanelPos] = useState(() => ({ x: Math.max(24, window.innerWidth - 780), y: 70 }))
  const [spotPanelSize, setSpotPanelSize] = useState({ width: 740 })

  // BANKNIFTY has no weekly expiry - NSE discontinued it (same rule Expired Backtest enforces).
  // Corrected right in the underlying picker's own onChange below, not a separate effect - this
  // is a direct response to that one user action, not a value derived from external state.
  const selectUnderlying = (value) => {
    setUnderlying(value)
    if (value === 'BANKNIFTY' && expiryFlag === 'WEEK') setExpiryFlag('MONTH')
  }

  const canLoad = Boolean(underlying && date)
  // Today can be followed live (Go Live) or replayed like any other day (Load day) - replaying it
  // fetches the day so far and gets the Start/Pause/slider scrubber instead of the live feed.
  // isLive is "today, followed live": every live-only behaviour below keys off it.
  const [todayMode, setTodayMode] = useState('live')
  const isTodayDate = Boolean(date && date.format('YYYY-MM-DD') === istDateKey(new Date()))
  const isLive = isTodayDate && todayMode === 'live'
  const feedLag = useFeedLag(isLive)

  // Keeps today's own paper positions in storage as they change (punched, exited, SL/target hit) so
  // a page reload can restore them (see load()'s own read, and PAPER_POSITIONS_STORAGE_KEY's doc
  // comment) - a historical replay day's positions are deliberately never written here, matching how
  // they were never meant to survive past that one load() in the first place. Clear all clearing the
  // array back to [] flows through this same effect, no separate storage write needed there.
  useEffect(() => {
    if (!isLive || !underlying || !date) return
    writePersistedPaperPositions(underlying, date.format('YYYY-MM-DD'), paperPositions)
  }, [paperPositions, isLive, underlying, date])

  // Keeps today's own fetched run PLUS everything the live feed has appended since in storage, so a
  // reload can restore it instantly instead of re-fetching (see load()'s own preferCache branch, and
  // LIVE_DAY_CACHE_STORAGE_KEY's doc comment). `result` is null for a moment during every load() call
  // (including a historical day switch) - skipped rather than overwriting today's still-good cache
  // with nothing, same reasoning useOiReplayLiveFeed's own doc comment gives for not tearing the
  // connection down on that same transient null.
  //
  // THROTTLED, not run on every tick directly - this used to fire this effect's own JSON.stringify +
  // synchronous localStorage.setItem unconditionally on every single live tick (spot, each strike's
  // own OI, futures, all independently), and the payload it serializes only grows through the day -
  // by the afternoon this was a real, confirmed "the page hangs and gets slower as the day goes on"
  // regression: a synchronous main-thread write of an ever-larger blob, several times a second, was
  // squarely in the way of every chart's own re-render. cacheWriteRef holds a trailing timer so the
  // LATEST state still always eventually gets written (never silently dropped), but never more often
  // than CACHE_WRITE_THROTTLE_MS - immediately if enough time has already passed since the last
  // write, otherwise scheduled for whatever's left of that window.
  const cacheWriteRef = useRef({ timeoutId: null, lastWriteMs: 0, disabled: false })
  useEffect(() => {
    if (!isLive || !underlying || !date || !result || cacheWriteRef.current.disabled) return
    const state = cacheWriteRef.current
    if (state.timeoutId) clearTimeout(state.timeoutId)
    const writeNow = () => {
      state.lastWriteMs = Date.now()
      if (!writeLiveDayCache(underlying, date.format('YYYY-MM-DD'), { result, liveBars, liveCePoints, livePePoints, liveFuturesPoints, vwapSeries, liveExpiryFlag })) state.disabled = true
    }
    const elapsedMs = Date.now() - state.lastWriteMs
    if (elapsedMs >= CACHE_WRITE_THROTTLE_MS) writeNow()
    else state.timeoutId = setTimeout(writeNow, CACHE_WRITE_THROTTLE_MS - elapsedMs)
    return () => clearTimeout(state.timeoutId)
  }, [result, liveBars, liveCePoints, livePePoints, liveFuturesPoints, vwapSeries, liveExpiryFlag, isLive, underlying, date])

  // Backs the live-mode expiry picker - fetched per underlying regardless of isLive, so the list is
  // already there the instant the user clicks Go Live rather than needing its own separate load.
  useEffect(() => {
    if (!underlying) return
    let cancelled = false
    fetch(`/api/oi-replay/${underlying}/expiries`)
      .then((r) => r.json())
      .then((body) => { if (!cancelled) setResolvedExpiries({ week: body?.week ?? null, month: body?.month ?? null, expiries: body?.expiries ?? [] }) })
      .catch((err) => { if (!cancelled) console.error('Failed to load resolved expiry dates:', err) })
    return () => { cancelled = true }
  }, [underlying])

  // Clamps back to N1 if the currently-selected position no longer exists once a fresh expiries list
  // lands - e.g. switching underlying to one with fewer near-term listed expiries than the previous
  // one, or a listed date rolling off entirely. N1 always exists whenever anything is listed at all.
  useEffect(() => {
    const position = Number(liveExpiryFlag.slice(1))
    if (resolvedExpiries.expiries.length > 0 && position > resolvedExpiries.expiries.length) setLiveExpiryFlag('N1')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedExpiries.expiries])

  // Takes an optional explicit date rather than only ever reading the `date` state, so goLive below
  // can set today's date AND kick off the fetch in one click - setDate(today) followed immediately
  // by load() would still read the OLD `date` from this closure (React state updates aren't
  // synchronous), so the caller passes the date it just set instead of relying on it having landed.
  // preferCache: ONLY passed true by the page-mount effect below, never by the Go Live button,
  // "Load day," or the live feed's own reconnect-triggered load() - it never skips THIS call's own
  // real fetch, only paints from the cache first while that fetch is still in flight (see
  // LIVE_DAY_CACHE_STORAGE_KEY's own doc comment).
  const load = (overrideDate, { preferCache = false, live } = {}) => {
    const effectiveDate = overrideDate ?? date
    if (!underlying || !effectiveDate) return
    const effectiveIsToday = effectiveDate.format('YYYY-MM-DD') === istDateKey(new Date())
    // `live` is passed by the buttons that just switched todayMode (the state hasn't landed yet).
    const effectiveLive = effectiveIsToday && (live ?? todayMode === 'live')
    const dateKey = effectiveDate.format('YYYY-MM-DD')

    // Paints instantly from cache when one exists, but NEVER as a substitute for the real fetch
    // below - only as a head start on it. A page can sit closed/reloading for minutes; skipping the
    // fetch outright on a cache hit (an earlier version of this DID exactly that) left whatever
    // ticked in that gap permanently missing, since neither the live feed's own reconnect-triggered
    // re-sync (that only fires on a genuine SignalR drop-and-recover, never on a fresh page load) nor
    // anything else was ever going to fill it in afterward - the exact "gaps" a real screenshot of
    // this caught. Stale-while-revalidate instead: restore now for a fast paint, still fetch for
    // real right after, and once that lands treat it as authoritative - see the liveBars/etc reset
    // inside the fetch's own .then() below for the other half of this fix.
    let restoredFromCache = false
    if (preferCache && effectiveLive) {
      const cached = readLiveDayCache(underlying, dateKey)
      if (cached) {
        restoredFromCache = true
        setPlaying(false)
        setError(null)
        setResult(cached.result)
        setLiveBars(cached.liveBars ?? [])
        setLiveCePoints(cached.liveCePoints ?? [])
        setLivePePoints(cached.livePePoints ?? [])
        setLiveFuturesPoints(cached.liveFuturesPoints ?? [])
        // Restored alongside the data it was actually tracking - liveExpiryFlag itself resets to its
        // own 'N1' default on every fresh mount (never persisted), so without this a restore of a
        // cached NON-default expiry (N2+) would show that expiry's frozen snapshot while the live feed
        // silently rejoins N1's group instead, ticking an expiry the screen isn't even showing.
        if (cached.liveExpiryFlag) setLiveExpiryFlag(cached.liveExpiryFlag)
        setPaperPositions(readPersistedPaperPositions(underlying, dateKey))
        setVwapSeries(cached.vwapSeries ?? [])
      }
    }

    // Abort whatever run fetch might still be pending from a previous click - otherwise a stale
    // response landing late could clobber the result of THIS load with an older day's data.
    activeLoadController.current?.abort('superseded')
    const controller = new AbortController()
    activeLoadController.current = controller
    setPlaying(false)
    setError(null)
    // Only flash to a blank/loading state when there's nothing decent on screen yet - a cache hit
    // already painted a good picture above, so resetting these here too would just be a pointless
    // blank flicker before the very same data (plus whatever ticked since) reappears a moment later.
    if (!restoredFromCache) {
      setLoading(true)
      setLiveBars([])
      setLiveCePoints([])
      setLivePePoints([])
      setLiveFuturesPoints([])
      lastOiByLegRef.current = new Map()
      setLastOiChangeMs(null)
      // Today's own positions survive THIS reload (see PAPER_POSITIONS_STORAGE_KEY's own doc comment) -
      // restored from storage rather than reset, so long as they were punched against the SAME
      // underlying and the SAME calendar day now loading. Any other day (or a stale/foreign entry)
      // still resets to empty exactly as before.
      setPaperPositions(effectiveLive ? readPersistedPaperPositions(underlying, dateKey) : [])
      setVwapSeries([])
    }
    // Only for today - see vwapSeries' own doc comment on why a historical day has no VWAP to show
    // at all (its own spotCandlesOneMinute carries no volume, and the live endpoint below reflects
    // only recent/in-memory days). Independent of the main run fetch below so a slow/failed VWAP
    // fetch never blocks or fails the actual replay load.
    if (effectiveLive) {
      fetch(`/api/spot/${underlying}/vwap-series`)
        .then((r) => r.json())
        .then((vwap) => setVwapSeries((vwap ?? []).map((p) => ({ time: toChartTime(p.time), value: p.obv }))))
        .catch((err) => console.error('Failed to load VWAP series:', err))
    }
    // While playing today live, expiryFlag (WEEK/MONTH - the historical picker) is not what the user
    // actually picked (liveExpiryFlag, "N1".."N6", is - see its own doc comment); Dhan's rolling-
    // option REST endpoint (what this call's own cePoints/pePoints come from) only ever accepts the
    // literal flags WEEK/MONTH though, never our own positional "N{k}" label, so this always asks for
    // the SAFE, already-verified nearest flag (WEEK, or MONTH for BANKNIFTY which lists no weeklies
    // at all) regardless of which position the user picked. For N1 that IS the picked contract
    // (BANKNIFTY's own MONTH already duplicates its position-0 date - see
    // OiReplayLiveFeedService.PositionalExpiriesPerUnderlying's own doc comment), so its CE/PE
    // since-open history is used as-is. For N2..N6 - a real, different, further-out contract - that
    // history would be for the WRONG expiry, so it's discarded below and the CE/PE series instead
    // start empty, filled in going forward purely by this page's own live ticks for the ACTUAL picked
    // expiry - less convenient than a full day's history, but never wrong data.
    const requestFlag = effectiveLive ? (underlying === 'BANKNIFTY' ? 'MONTH' : 'WEEK') : expiryFlag
    const usesRunsCePeData = !effectiveLive || liveExpiryFlag === 'N1'
    // forceLive for today: this page's own "today, live" mode has no scenario where preferring
    // possibly-stale or entirely-absent stored data over a direct Dhan call makes sense - it's about
    // to hand off to the live tick feed anyway (see useOiReplayLiveFeed below), so the SEED itself
    // should always be the freshest reading available rather than first checking a periodically-
    // backfilled database that may simply not have caught up to today yet (NiftyDataCollector's own
    // backfill runs on its own cadence - see OiReplayService's own doc comment). A historical
    // (non-today) day keeps the default stored-first behavior exactly as before - reviewing a
    // genuinely closed day has no "freshness" concern to force past.
    const params = new URLSearchParams({
      date: effectiveDate.format('YYYY-MM-DD'),
      timeframeMinutes: String(timeframe),
      expiryFlag: requestFlag,
      ...(effectiveIsToday ? { forceLive: 'true' } : {}),
    })
    const timeoutId = setTimeout(() => controller.abort('timeout'), LOAD_TIMEOUT_MS)
    fetch(`/api/oi-replay/${underlying}/run?${params.toString()}`, { signal: controller.signal })
      .then(async (r) => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.error || `Request failed (HTTP ${r.status}).`)
        return body
      })
      .then((body) => {
        if (!body?.success) throw new Error(body?.error || 'This run did not succeed.')
        setResult(usesRunsCePeData ? body : { ...body, cePoints: [], pePoints: [] })
        // This fresh, authoritative result now covers everything up to THIS moment - reset the live
        // arrays so only ticks arriving AFTER it (genuinely new) populate them again. Only needed on
        // the cache-restore path: its own liveBars/etc could still be holding whatever accumulated
        // BEFORE this reload, which this result's own history now already supersedes, and neither
        // oneMinBars' merge (by timestamp) nor cePoints/pePoints' own flat concat downstream is
        // designed to reconcile "old cached ticks" against "a fresher, more complete history" on its
        // own - it would just double up. The normal (non-cache) path already reset these BEFORE this
        // fetch started, so doing it again here is never needed there.
        if (restoredFromCache) {
          setLiveBars([])
          setLiveCePoints([])
          setLivePePoints([])
          setLiveFuturesPoints([])
          }
        const initialLen = body.spotCandlesOneMinute?.length ?? 0
        // manualVisibleCount only matters for a historical (non-today) day - see visibleCount's own
        // derivation below, which reads oneMinBars.length directly for today, always, unconditionally.
        setManualVisibleCount(initialLen > 0 ? 1 : 0)
      })
      .catch((err) => {
        // 'superseded' means a NEWER load() already aborted this one on purpose - that newer call
        // owns the loading/error state now, so this stale one has nothing left to report.
        if (controller.signal.reason === 'superseded') return
        console.error('Failed to load OI replay data:', err)
        // A cache hit already has a decent picture on screen - a transient failure reconciling it in
        // the background shouldn't blow that away into a hard error state; the user can still hit
        // Clear cache for an explicit retry. Only the normal (no-cache-to-fall-back-on) path clears
        // to the error view exactly as before.
        if (restoredFromCache) return
        setResult(null)
        setError(
          controller.signal.reason === 'timeout'
            ? `This took longer than ${LOAD_TIMEOUT_MS / 1000}s and was cancelled - the server may still be waiting on a slow Dhan response, or the connection dropped (more common on mobile/cellular, or if the tab was backgrounded). Try again.`
            : controller.signal.reason === 'user-cancelled'
              ? 'Cancelled.'
              : err.message || 'Failed to load this day.',
        )
      })
      .finally(() => {
        clearTimeout(timeoutId)
        // Guards against a SUPERSEDED call's own finally clearing the loading state a newer call
        // just set - only the currently-active controller's own completion may touch it.
        if (activeLoadController.current === controller) {
          setLoading(false)
          activeLoadController.current = null
        }
      })
  }

  // Lets the user clear a load that is stuck/taking too long instead of only ever waiting for
  // LOAD_TIMEOUT_MS's own auto-cancel - see the Loading alert's own Cancel button below.
  const cancelLoad = () => activeLoadController.current?.abort('user-cancelled')

  // A page reload already re-fetches for real in the background regardless (see
  // LIVE_DAY_CACHE_STORAGE_KEY's own doc comment) - this instead skips straight to that same real
  // fetch with NO stale cache shown first, for whenever the cached picture on screen right now looks
  // wrong and waiting for the background reconciliation isn't good enough. Wipes the cached entry,
  // then calls load() with no options (preferCache defaults false), the exact same real fetch Go
  // Live/Load day already do. Only shown while isLive (see its own button below) - a historical day
  // was never cached in the first place, so there'd be nothing here to clear.
  const handleClearLiveCache = () => {
    clearLiveDayCache()
    load(date)
  }

  // One click for "switch to today and start following it live" - the user's own "if tomorrow
  // markets opens and if select live this will work on live data" ask, rather than needing to open
  // the date picker and find today's date by hand every single morning. Whatever underlying/
  // liveExpiryFlag/timeframe are already selected stay as they are - this only ever changes the date.
  // isLive (see below) is what actually keeps it updating tick by tick once loaded; this button just
  // gets there in one step instead of several.
  const goLive = () => {
    const today = dayjs()
    setTodayMode('live')
    setDate(today)
    load(today, { live: true })
  }

  // Load day always REPLAYS the picked day - today included, as far as it has got - with the
  // Start/Pause/slider scrubber. Go Live is the way back to following today live.
  const loadForReplay = () => {
    setTodayMode('replay')
    load(undefined, { live: false })
  }

  // Opens straight into today's live view instead of the empty "pick a day and click Load day"
  // state - the user's own "should always be a live dashboard, we shouldn't have to load every time"
  // ask. Guarded on `date` still being null (its own initial value, before ANYTHING has been
  // loaded) so this only ever fires once, on the very first mount - manually loading a historical
  // day afterward is untouched, and re-clicking Go Live is still exactly the same one-liner it
  // always was. underlying needs no guard of its own: it's already persisted with a real default
  // (see its own usePersistedState call above), never null.
  //
  // preferCache (not goLive() itself - see load()'s own doc comment on preferCache) is what actually
  // answers the "keep current day data in memory + live ticks, don't make us load it again" ask: a
  // reload lands here, finds today's own cached run still in storage, and restores it instantly for a
  // fast paint - load() still fetches for real right behind it to reconcile anything that ticked
  // while this tab was closed/reloading (see LIVE_DAY_CACHE_STORAGE_KEY's own doc comment). The Clear
  // cache button below skips straight to that same real fetch, with no stale cache shown first.
  useEffect(() => {
    if (date) return
    const today = dayjs()
    setDate(today)
    load(today, { preferCache: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The TRUE replay clock - native 1-minute bars, so every derived read (ladder, OI change, Market
  // Read, Day Accumulation, alerts) advances one real minute per tick regardless of which timeframe
  // the CHART itself displays. The chart's own candles are a re-aggregation of a slice of this,
  // computed separately below - the two used to be the same array, which meant everything on the
  // page only updated once per whole displayed candle (once every 5 or 15 real minutes on a coarser
  // timeframe) instead of continuously. While isLive, this also folds in liveBars - the initial
  // REST snapshot's own bars, with the live feed's tail merged on top (replacing the still-forming
  // final minute in place as it updates, appending once a new minute actually starts).
  const oneMinBars = useMemo(() => {
    const base = (result?.spotCandlesOneMinute ?? []).map(toBar)
    if (!isLive || liveBars.length === 0) return base
    const merged = base.slice()
    for (const bar of liveBars) {
      if (merged.length > 0 && merged[merged.length - 1].time === bar.time) merged[merged.length - 1] = bar
      else if (merged.length === 0 || bar.time > merged[merged.length - 1].time) merged.push(bar)
    }
    return merged
  }, [result, liveBars, isLive])
  const ceByStrike = useMemo(
    () => groupByStrike(isLive ? [...(result?.cePoints ?? []), ...liveCePoints] : (result?.cePoints ?? [])),
    [result, liveCePoints, isLive],
  )
  const peByStrike = useMemo(
    () => groupByStrike(isLive ? [...(result?.pePoints ?? []), ...livePePoints] : (result?.pePoints ?? [])),
    [result, livePePoints, isLive],
  )

  // The strike drill-down popup - opened by clicking anywhere on the main chart (see ReplayChart's
  // own onStrikeClick), answering the "how can I see per-minute OI change AND total OI for one
  // strike, not just its since-open number" ask. Shows both together (see the Modal's own JSX
  // further down), not behind a tab switch, so the two can be read against each other directly -
  // that comparison is the whole point. null strike means the popup is closed.
  const [drilldownStrike, setDrilldownStrike] = useState(null)
  // drilldownCeTotal/PeTotal/etc. (the popup's own OI series for whichever strike is picked) are
  // defined further down, right after asOfMs - they need to filter against it, so they can't be
  // declared here (asOfMs itself isn't computed yet at this point in the component).

  // See FEED_STALL_WARNING_MS's own doc comment - set on every live tick that actually matches
  // today/the current underlying/expiryFlag, so this tracks "last time THIS page's own feed
  // genuinely advanced", not just "last time any tick arrived for anything".
  const [lastTickAtMs, setLastTickAtMs] = useState(null)

  // Live feed wiring - see useOiReplayLiveFeed's own doc comment. Only connects once an initial
  // snapshot has actually loaded (this is a "keep it fresh from here" layer on top of that fetch,
  // not a replacement for it) and only for a combo OiReplayLiveFeedService actually tracks.
  const handleSpotUpdate = (snapshot) => {
    if (!isLive || snapshot?.underlying !== underlying || !snapshot?.currentBar) return
    const receivedAt = Date.now()
    lastTickAtRef.current = receivedAt
    lastSpotAtRef.current = receivedAt
    feedLag.recordSource(new Date(snapshot.timestampUtc).getTime(), snapshot.exchangeTimeUtc ? new Date(snapshot.exchangeTimeUtc).getTime() : null)
    const bar = toBar(snapshot.currentBar)
    setLiveBars((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].time === bar.time) {
        const next = prev.slice()
        next[next.length - 1] = bar
        return next
      }
      return [...prev, bar]
    })
    // null before the day's first traded volume (see SpotSnapshot's own doc comment) - nothing to
    // plot yet, not a zero.
    if (snapshot.vwap != null) {
      const point = { time: toChartTime(snapshot.currentBar.time), value: snapshot.vwap }
      setVwapSeries((prev) => {
        if (prev.length > 0 && prev[prev.length - 1].time === point.time) return [...prev.slice(0, -1), point]
        return [...prev, point]
      })
    }
  }
  // Each batch (~every 300ms, one entry per leg - see LiveBroadcastBatcher) is applied as ONE state
  // update per side. Entry `time` is the server's own receive time of that leg's latest tick (see
  // OiReplayLiveFeedService.OnTick), which is also what feed lag is measured against.
  const handleOiReplayTicks = (batch) => {
    if (!isLive) return
    const ce = []
    const pe = []
    for (const tick of batch) {
      if (tick?.underlying !== underlying || tick?.expiryFlag !== liveExpiryFlag) continue
      ;(tick.side === 'CE' ? ce : pe).push(tick)
    }
    if (ce.length === 0 && pe.length === 0) return
    const receivedAt = Date.now()
    lastTickAtRef.current = receivedAt
    let newest = 0
    for (const tick of [...ce, ...pe]) newest = Math.max(newest, new Date(tick.time).getTime() || 0)
    let oiChangedAt = 0
    for (const tick of [...ce, ...pe]) {
      const key = `${tick.side}:${tick.strike}`
      const previousOi = lastOiByLegRef.current.get(key)
      if (previousOi != null && previousOi !== tick.openInterest) oiChangedAt = Math.max(oiChangedAt, new Date(tick.time).getTime() || 0)
      lastOiByLegRef.current.set(key, tick.openInterest)
    }
    if (oiChangedAt) setLastOiChangeMs((prev) => Math.max(prev ?? 0, oiChangedAt))
    if (ce.length) setLiveCePoints((prev) => mergeLiveOptionTicks(prev, ce, liveIvRef.current.ce))
    if (pe.length) setLivePePoints((prev) => mergeLiveOptionTicks(prev, pe, liveIvRef.current.pe))
    setLatestLiveMs((prev) => Math.max(prev, newest))
  }
  const handleFuturesTicks = (batch) => {
    if (!isLive) return
    const mine = batch.filter((tick) => tick?.underlying === underlying)
    if (mine.length === 0) return
    lastTickAtRef.current = Date.now()
    setLiveFuturesPoints((prev) => mergeLiveFuturesTicks(prev, mine))
  }
  // Fresh IV from Dhan's option-chain snapshot: remembered for every new live point from here on,
  // and stamped onto each strike's current point right away so the ladder/Market Read update now.
  const handleRestSnapshot = (snapshot) => {
    if (!isLive || snapshot?.underlying !== underlying || snapshot?.expiryFlag !== liveExpiryFlag) return
    const ce = new Map(liveIvRef.current.ce)
    const pe = new Map(liveIvRef.current.pe)
    const ceNow = new Map()
    const peNow = new Map()
    for (const row of snapshot.strikes ?? []) {
      if (row.ceIv != null) { ce.set(row.strike, row.ceIv); ceNow.set(row.strike, row.ceIv) }
      if (row.peIv != null) { pe.set(row.strike, row.peIv); peNow.set(row.strike, row.peIv) }
    }
    liveIvRef.current = { ce, pe }
    if (ceNow.size) setLiveCePoints((prev) => applyIvSnapshot(prev, ceNow))
    if (peNow.size) setLivePePoints((prev) => applyIvSnapshot(prev, peNow))
  }

  // Carried onto each new live point - see lastIvByStrike. A ref so handlers always read the newest
  // IV known (seed, then each option-chain snapshot) without re-subscribing anything.
  const liveIvRef = useRef({ ce: new Map(), pe: new Map() })
  useEffect(() => {
    liveIvRef.current = { ce: lastIvByStrike(result?.cePoints), pe: lastIvByStrike(result?.pePoints) }
  }, [result])

  // Status only (no data is applied here any more): the "last tick", lag and spot-silence readouts.
  useEffect(() => {
    if (!isLive) return
    // Counts from now, so spot that never ticks at all after the page opens is caught too.
    if (lastSpotAtRef.current == null) lastSpotAtRef.current = Date.now()
    const id = setInterval(() => {
      if (lastTickAtRef.current != null) setLastTickAtMs(lastTickAtRef.current)
      const now = Date.now()
      const silent = lastSpotAtRef.current != null && isIndianMarketHours(now) ? now - lastSpotAtRef.current : 0
      // Whole seconds only, and 0 below the threshold, so a healthy feed never re-renders for this.
      setSpotSilentMs(silent >= SPOT_SILENCE_WARN_MS ? Math.floor(silent / 1000) * 1000 : 0)
    }, LIVE_STATUS_INTERVAL_MS)
    return () => clearInterval(id)
  }, [isLive])

  const handleLiveReconnected = () => { if (isLive) load() }
  const liveConnectionState = useOiReplayLiveFeed(handleSpotUpdate, handleOiReplayTicks, handleFuturesTicks, handleRestSnapshot, handleLiveReconnected, isLive ? feedLag.recordPainted : null, underlying, liveExpiryFlag, liveTradeActive ? applyLivePositions : null, liveExtraGroups)

  // A plain tick, unrelated to any live data - exists ONLY so feedStalled below re-evaluates on a
  // real clock instead of purely as a side effect of the next incoming tick (same reasoning as Live
  // OI Dashboard's own identical nowTick).
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 15_000)
    return () => clearInterval(id)
  }, [])

  // True when this page's own SignalR connection to the server says "connected" but nothing has
  // actually arrived through it in a long time - see FEED_STALL_WARNING_MS's own doc comment for why
  // that combination needs its own, separate signal from liveConnectionState.
  const feedStalled = isLive && liveConnectionState === 'connected'
    && lastTickAtMs != null && nowTick - lastTickAtMs > FEED_STALL_WARNING_MS

  // Edge-triggered (fires once per stall, not once per 15s tick while it persists) so this is
  // findable in the browser console without flooding it.
  const wasFeedStalledRef = useRef(false)
  useEffect(() => {
    if (feedStalled && !wasFeedStalledRef.current) {
      console.error(`OI Replay: no ticks received for ${underlying} in over ${FEED_STALL_WARNING_MS / 60_000} minutes despite an open connection - the server's own Dhan feed may have stalled.`)
    }
    wasFeedStalledRef.current = feedStalled
  }, [feedStalled, underlying])

  // Playback loop - a single interval that advances manualVisibleCount by one NATIVE MINUTE per
  // tick, self-stopping at the end of the day's own bars rather than needing a separate "are we
  // done" effect. Only relevant for a historical (non-today) day - see visibleCount's own comment
  // below on why today ignores manualVisibleCount entirely, so this loop is inert whenever isLive.
  useEffect(() => {
    if (!playing) return
    timerRef.current = setInterval(() => {
      setManualVisibleCount((c) => {
        if (c >= oneMinBars.length) { setPlaying(false); return c }
        return c + 1
      })
    }, speedMs)
    return () => clearInterval(timerRef.current)
  }, [playing, speedMs, oneMinBars.length])

  // The position actually shown everywhere on the page. TODAY IS ALWAYS oneMinBars.length -
  // unconditionally, with no toggle, no "following" flag, and no way for Start/Reset/the slider to
  // override it (see the Spot card's own JSX comment on why that used to be possible and what it
  // broke) - recomputed fresh on every render straight off however many bars have arrived so far, so
  // there is no separate piece of state that could ever fall behind and need a manual nudge to catch
  // up. A historical day uses the manually-chosen replay position instead, exactly as before.
  const visibleCount = isLive ? oneMinBars.length : manualVisibleCount

  const currentBar = oneMinBars[visibleCount - 1] ?? null
  // oneMinBars' own .time is chart time (shifted +5.5h by toChartTime, for the chart library's own
  // display trick) - ceByStrike/peByStrike's points are the RAW, unshifted times straight off the
  // wire. Comparing a shifted value against unshifted ones directly (as this used to) skews every
  // lookup forward by a fixed 5.5 hours - once real time-of-day passes 10:00 IST, that skew alone
  // pushes the lookup past 15:30 (market close), so every strike's "latest reading" permanently
  // resolves to the day's very last point from then on - the exact "ladder/chart goes static right
  // at 10:00 every time" bug. fromChartTime converts back to real time before use here.
  //
  // TODAY tracks real wall-clock time continuously instead - the "we shouldn't have to wait minute
  // by minute" bug: asOfMs used to be pinned to the last REVEALED bar's own bucket-START time, which
  // only advances once oneMinBars grows by a whole new bar (spotUpdate delivering the NEXT minute).
  // Every single thing gated on asOfMs - the ladder's latestAtOrBefore lookups, premium charts,
  // paper-trade entry/exit pricing, the SL/target touch-check - stayed frozen at that stale bucket
  // start for up to 59 seconds at a time, silently ignoring ticks that had ALREADY landed in
  // ceByStrike/peByStrike well before the next bar closed. A historical day still uses the scrubbed
  // replay position exactly as before - only "today, live" changes.
  // latestLiveMs covers a device clock running behind the server: ticks are stamped with the
  // server's receive time, so a plain Date.now() cutoff would hide the newest ones until this
  // device's clock caught up.
  const asOfMs = isLive ? Math.max(Date.now(), latestLiveMs) : (currentBar ? fromChartTime(currentBar.time) * 1000 : null)

  // Purely for the ladder's OWN "stale" flag below (ceStale/peStale) - NOT used for asOfMs itself,
  // which must keep tracking real wall-clock time for every other read on this page (paper-trade
  // exit pricing, the drilldown popup, etc). Once the market has closed for the day, ticks genuinely
  // stop while Date.now() keeps climbing - comparing OI_STALE_MS against the ever-advancing real
  // time would then mark EVERY strike stale forever a few minutes after 15:30 IST, which reads
  // exactly like a broken feed but only ever means "the trading day is over, nothing more is
  // coming". Capped at today's own market close instead, so a reading from the day's last few
  // trades still reads as fresh relative to that close, not "5+ hours stale" relative to right now.
  const staleReferenceMs = isLive ? Math.min(Date.now(), new Date(`${istDateKey(new Date())}T15:30:00+05:30`).getTime()) : asOfMs

  // The strike drill-down popup's own OI series - gated to asOfMs like every other derived read on
  // this page (the ladder, premium charts, Market Read), NOT the whole day's history regardless of
  // replay position. Used to deliberately show everything ("a look-back analysis popup, not part of
  // the live replay HUD") - a real report ("these graphs should work tick by tick, not all in one")
  // reversed that: the popup now plays back in step with the rest of the page instead of jumping
  // straight to the end of the day the moment it opens.
  const drilldownCeTotal = useMemo(() => {
    const raw = (ceByStrike.get(drilldownStrike) ?? []).filter((p) => asOfMs == null || new Date(p.time).getTime() <= asOfMs)
    return aggregateLinePoints(raw.map((p) => ({ time: toChartTime(p.time), value: p.openInterest })), 1)
  }, [ceByStrike, drilldownStrike, asOfMs])
  const drilldownPeTotal = useMemo(() => {
    const raw = (peByStrike.get(drilldownStrike) ?? []).filter((p) => asOfMs == null || new Date(p.time).getTime() <= asOfMs)
    return aggregateLinePoints(raw.map((p) => ({ time: toChartTime(p.time), value: p.openInterest })), 1)
  }, [peByStrike, drilldownStrike, asOfMs])
  const drilldownCeChange = useMemo(() => computeOiChangeSeries(drilldownCeTotal), [drilldownCeTotal])
  const drilldownPeChange = useMemo(() => computeOiChangeSeries(drilldownPeTotal), [drilldownPeTotal])
  const drilldownCeSinceOpen = useMemo(() => toSinceOpenSeries(drilldownCeTotal), [drilldownCeTotal])
  const drilldownPeSinceOpen = useMemo(() => toSinceOpenSeries(drilldownPeTotal), [drilldownPeTotal])

  // The chart's own displayed candles - the visible slice of 1-minute bars, re-aggregated to
  // whatever timeframe is selected, recomputed fresh each tick so the LAST (currently forming)
  // candle updates live exactly like a real charting terminal's current bar does.
  const displayBars = useMemo(
    () => aggregateBars(oneMinBars.slice(0, visibleCount), timeframe),
    [oneMinBars, visibleCount, timeframe],
  )
  const dayStartMs = oneMinBars[0] ? fromChartTime(oneMinBars[0].time) * 1000 : null

  // Futures - the REST snapshot from OiReplayService's own single live call, PLUS (while isLive)
  // the live tick tail from OiReplayLiveFeedService's own "futuresTick" broadcast (see
  // handleFuturesTick below) - same "today, live WS" merge shape as oneMinBars/ceByStrike/peByStrike
  // now use, closing what used to be a real gap: the Futures section never updated again after the
  // initial Load day/Go Live until now.
  //
  // Raw (unshifted) points, time-ascending, for latestAtOrBefore-style stat lookups - same
  // real-time-vs-chart-time distinction as ceByStrike/peByStrike above (see asOfMs's own comment).
  // Merged the same way oneMinBars merges liveBars: an exact same-minute match REPLACES the
  // existing point (the still-forming current bar keeps updating in place), a genuinely newer one
  // is appended.
  const futuresPointsRaw = useMemo(() => {
    const base = [...(result?.futuresBars ?? [])].sort((a, b) => new Date(a.time) - new Date(b.time))
    if (!isLive || liveFuturesPoints.length === 0) return base
    const merged = base.slice()
    for (const point of liveFuturesPoints) {
      if (merged.length > 0 && merged[merged.length - 1].time === point.time) merged[merged.length - 1] = point
      else if (merged.length === 0 || new Date(point.time) > new Date(merged[merged.length - 1].time)) merged.push(point)
    }
    return merged
  }, [result, liveFuturesPoints, isLive])
  const futuresBarsChart = useMemo(() => futuresPointsRaw.map(toBar), [futuresPointsRaw])
  // The futures' session VWAP from its 1-minute bars (they carry volume - toBar drops it), read at each
  // displayed candle - never past the replay clock (the last candle would otherwise take later VWAP).
  const futuresVwapMinutes = useMemo(() => sessionVwapFromBars(futuresPointsRaw.map((p) => ({
    time: toChartTime(p.time), high: p.high, low: p.low, close: p.close, volume: p.volume,
  }))) ?? [], [futuresPointsRaw])
  const displayFuturesBars = useMemo(() => {
    if (asOfMs == null) return []
    const cutoff = toChartTime(asOfMs)
    return aggregateBars(futuresBarsChart.filter((b) => b.time <= cutoff), futuresTimeframe)
  }, [futuresBarsChart, asOfMs, futuresTimeframe])
  const futuresVwap = useMemo(() => {
    if (!showVwap || asOfMs == null) return EMPTY_ARRAY
    const cutoff = toChartTime(asOfMs)
    return alignToBars(futuresVwapMinutes.filter((p) => p.time <= cutoff), displayFuturesBars)
  }, [showVwap, asOfMs, futuresVwapMinutes, displayFuturesBars])
  // The day's futures volume profile up to the replay time, from each minute's volume spread over its
  // range (FUTURES_PROFILE_ROWS-point rows).
  // The day's per-minute buy/sell from the order flow server - refreshed every minute while live.
  const flowDate = result?.date ?? null
  useEffect(() => {
    if (!futuresDeltaOn || !flowDate || !underlying) { setFuturesFlow(null); return undefined }
    let cancelled = false
    const load = () => fetch(`/api/order-flow/${underlying}/day/${flowDate}?rowSize=50&minTradeLots=100000&heatmapColumns=50`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => { if (!cancelled) setFuturesFlow(body ? { source: body.source, bars: body.bars.map((b) => ({ ms: new Date(b.time).getTime(), delta: b.buy - b.sell })) } : null) })
      .catch(() => { if (!cancelled) setFuturesFlow(null) })
    load()
    const id = isLive ? setInterval(load, 60_000) : null
    return () => { cancelled = true; if (id) clearInterval(id) }
  }, [futuresDeltaOn, flowDate, underlying, isLive])
  // Delta per futures candle (same buckets as the candles) up to the replay time, and its running sum.
  const futuresDeltaBars = useMemo(() => {
    if (!futuresDeltaOn || !futuresFlow?.bars?.length || asOfMs == null) return null
    const bucketSeconds = Math.max(1, futuresTimeframe) * 60
    const buckets = new Map()
    for (const b of futuresFlow.bars) {
      if (b.ms > asOfMs) continue // minutes revealed so far (a minute shows once the replay reaches its start, like the candles)
      const t = Math.floor(toChartTime(b.ms) / bucketSeconds) * bucketSeconds
      buckets.set(t, (buckets.get(t) ?? 0) + b.delta)
    }
    let cvd = 0
    return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([time, delta]) => { cvd += delta; return { time, delta, cvd } })
  }, [futuresDeltaOn, futuresFlow, asOfMs, futuresTimeframe])
  const futuresProfileRow = FUTURES_PROFILE_ROWS[underlying] ?? 5
  const futuresProfile = useMemo(() => {
    if (!futuresProfileOn || asOfMs == null) return null
    return volumeProfileFromCandles(futuresPointsRaw.filter((p) => new Date(p.time).getTime() <= asOfMs), futuresProfileRow)
  }, [futuresProfileOn, futuresPointsRaw, asOfMs, futuresProfileRow])
  const currentFutures = useMemo(
    () => (asOfMs != null ? latestAtOrBefore(futuresPointsRaw, asOfMs) : null),
    [futuresPointsRaw, asOfMs],
  )
  const futuresOpen = futuresPointsRaw[0] ?? null
  const futuresOiSinceOpen = currentFutures?.openInterest != null && futuresOpen?.openInterest != null
    ? currentFutures.openInterest - futuresOpen.openInterest
    : null
  const futuresVolumeSoFar = useMemo(() => {
    if (asOfMs == null) return null
    return futuresPointsRaw
      .filter((p) => new Date(p.time).getTime() <= asOfMs)
      .reduce((sum, p) => sum + (p.volume ?? 0), 0)
  }, [futuresPointsRaw, asOfMs])
  // Basis = futures price - spot price - positive ("premium") usually reads bullish sentiment,
  // negative ("discount") bearish, though on an index the gap is mostly just cost-of-carry drifting
  // toward zero as expiry nears, not a pure sentiment read the way it can be on an individual stock.
  // Both prices are already real (non-time) values, so no chart-time/real-time conversion applies.
  const futuresBasis = currentFutures?.close != null && currentBar?.close != null
    ? currentFutures.close - currentBar.close
    : null

  // The OI overlay line drawn on FuturesChart's own left price scale - one point per DISPLAYED
  // candle (not native 1-min), each carrying whatever OI was current as of that candle's own
  // close, so the line reveals in step with the candles rather than at a different resolution.
  // Plotted value is OI/1e6 (not the raw count) so the left axis itself reads in clean millions,
  // same "show all the tags in million" convention as every other OI figure on this page.
  const futuresOiLine = useMemo(() => {
    if (!result?.futuresOiAvailable) return []
    return displayFuturesBars
      .map((bar) => {
        const point = latestAtOrBefore(futuresPointsRaw, fromChartTime(bar.time) * 1000)
        return point?.openInterest != null ? { time: bar.time, value: point.openInterest / 1_000_000 } : null
      })
      .filter(Boolean)
  }, [displayFuturesBars, futuresPointsRaw, result])

  // Every row carries its OI both ONE MINUTE AGO (native resolution regardless of the chart's own
  // timeframe - "change every min" was explicit) AND at the DAY'S OPEN, alongside the current
  // reading - the ladder shows both a tick-to-tick delta and a since-open delta per strike, not
  // just the Day OI Accumulation card's own whole-band totals.
  const ladderRows = useMemo(() => {
    if (asOfMs == null) return []
    const priorMs = asOfMs - 60_000
    const strikes = new Set([...ceByStrike.keys(), ...peByStrike.keys()])
    const rows = [...strikes].map((strike) => {
      const ce = latestAtOrBefore(ceByStrike.get(strike) ?? [], asOfMs)
      const pe = latestAtOrBefore(peByStrike.get(strike) ?? [], asOfMs)
      const cePrior = latestAtOrBefore(ceByStrike.get(strike) ?? [], priorMs)
      const pePrior = latestAtOrBefore(peByStrike.get(strike) ?? [], priorMs)
      // See PRIOR_MINUTE_TOLERANCE_MS's own doc comment - a "prior" point found well before priorMs
      // means there was a real gap, so the resulting delta would actually span however long that gap
      // was, not one minute. Suppressed to null rather than shown as a misleadingly labeled figure.
      const cePriorFresh = cePrior != null && priorMs - new Date(cePrior.time).getTime() <= PRIOR_MINUTE_TOLERANCE_MS
      const pePriorFresh = pePrior != null && priorMs - new Date(pePrior.time).getTime() <= PRIOR_MINUTE_TOLERANCE_MS
      const ceOpen = dayStartMs != null ? latestAtOrBefore(ceByStrike.get(strike) ?? [], dayStartMs) : null
      const peOpen = dayStartMs != null ? latestAtOrBefore(peByStrike.get(strike) ?? [], dayStartMs) : null
      const ceAsOfMs = ce ? new Date(ce.time).getTime() : null
      const peAsOfMs = pe ? new Date(pe.time).getTime() : null
      return {
        strike,
        ceOi: ce?.openInterest ?? null, ceIv: ce?.impliedVolatility ?? null, cePrice: ce?.price ?? null,
        peOi: pe?.openInterest ?? null, peIv: pe?.impliedVolatility ?? null, pePrice: pe?.price ?? null,
        ceOiChange: ce?.openInterest != null && cePriorFresh && cePrior.openInterest != null ? ce.openInterest - cePrior.openInterest : null,
        peOiChange: pe?.openInterest != null && pePriorFresh && pePrior.openInterest != null ? pe.openInterest - pePrior.openInterest : null,
        ceOiSinceOpen: ce?.openInterest != null && ceOpen?.openInterest != null ? ce.openInterest - ceOpen.openInterest : null,
        peOiSinceOpen: pe?.openInterest != null && peOpen?.openInterest != null ? pe.openInterest - peOpen.openInterest : null,
        // "Stale" = the newest reading we have for this strike/side is already more than
        // OI_STALE_MS behind the replay's own current time - the stored data has stopped arriving,
        // not that the market itself has gone quiet (see OI_STALE_MS's own doc comment).
        ceAsOfMs, peAsOfMs,
        ceStale: ceAsOfMs != null && staleReferenceMs - ceAsOfMs > OI_STALE_MS,
        peStale: peAsOfMs != null && staleReferenceMs - peAsOfMs > OI_STALE_MS,
      }
    })
    return rows.sort((a, b) => b.strike - a.strike)
  }, [ceByStrike, peByStrike, asOfMs, staleReferenceMs, dayStartMs])

  // Same strike set/order as the ladder (descending, highest strike first) - derived straight from
  // ceByStrike/peByStrike rather than ladderRows itself: ladderRows' own useMemo also depends on
  // asOfMs, which ticks continuously in live mode (asOfMs = Date.now(), not gated on real data
  // arriving - see its own doc comment), so deriving from it would recompute the whole heatmap matrix
  // on every render even when no new OI actually landed. This only changes when the tracked strike
  // SET itself changes (a new strike enters the band), not on every tick.
  const heatmapStrikes = useMemo(
    () => [...new Set([...ceByStrike.keys(), ...peByStrike.keys()])].sort((a, b) => b - a),
    [ceByStrike, peByStrike],
  )

  const step = result?.step || 50
  const atmStrike = currentBar ? Math.round(currentBar.close / step) * step : null

  // Sudden OI walls as of the replay's current point (suddenOi.js - the same rule as the Order Flow
  // page and strategy #25): a strike adding 3%+ of its OI in 5 minutes at 3x+ its pace before. Read
  // once a minute; none in the session's first 10 minutes (the open reshuffles OI everywhere).
  const suddenMinute = asOfMs == null ? null : Math.floor(asOfMs / 60_000)
  const spotNow = currentBar?.close ?? null
  const suddenWalls = useMemo(() => {
    if (suddenMinute == null || !(spotNow > 0)) return []
    const ms = suddenMinute * 60_000 + 59_999
    if ((Math.floor(ms / 60_000) + 330) % 1440 < 9 * 60 + 25) return []
    const strikes = [...new Set([...ceByStrike.keys(), ...peByStrike.keys()])]
    const oiAt = (side, k, t) => latestAtOrBefore((side === 'CE' ? ceByStrike : peByStrike).get(k) ?? [], t)?.openInterest ?? null
    return findSuddenWalls({ strikes, oiAt, ms, spot: spotNow, step })
  }, [ceByStrike, peByStrike, suddenMinute, spotNow, step])

  // ATM OI change over the last N bars, bucketed to chart B's OWN timeframe (chartBTimeframe) - see
  // the state declaration above. Filtered to asOfMs first so this never reveals a tick beyond what
  // the rest of the replay has played up to.
  const ceOiLookbackLine = useMemo(() => aggregateLinePoints(
    (ceByStrike.get(atmStrike) ?? [])
      .filter((p) => asOfMs != null && new Date(p.time).getTime() <= asOfMs)
      .map((p) => ({ time: toChartTime(p.time), value: p.openInterest }))
      .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.value)),
    chartBTimeframe,
  ), [ceByStrike, atmStrike, chartBTimeframe, asOfMs])
  const peOiLookbackLine = useMemo(() => aggregateLinePoints(
    (peByStrike.get(atmStrike) ?? [])
      .filter((p) => asOfMs != null && new Date(p.time).getTime() <= asOfMs)
      .map((p) => ({ time: toChartTime(p.time), value: p.openInterest }))
      .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.value)),
    chartBTimeframe,
  ), [peByStrike, atmStrike, chartBTimeframe, asOfMs])
  const ceOiLookback = useMemo(() => computeOiLookbackChange(ceOiLookbackLine, oiLookbackBars), [ceOiLookbackLine, oiLookbackBars])
  const peOiLookback = useMemo(() => computeOiLookbackChange(peOiLookbackLine, oiLookbackBars), [peOiLookbackLine, oiLookbackBars])

  const cePremiumStrike = atmStrike != null ? atmStrike + cePremiumOffset * step : null
  const pePremiumStrike = atmStrike != null ? atmStrike + pePremiumOffset * step : null
  const cePremiumPoints = ceByStrike.get(cePremiumStrike)
  const pePremiumPoints = peByStrike.get(pePremiumStrike)
  // Whether the replay has revealed at least one premium reading as of the CURRENT replay position -
  // PremiumEmaChart does its own asOfMs filtering internally, but the Empty-state check here still
  // needs to know "as of now", not "ever, across the whole day", or it would render a chart that's
  // actually empty (every point still in the future) instead of the friendly empty message.
  const cePremiumRevealed = useMemo(
    () => asOfMs != null && (cePremiumPoints ?? []).some((p) => new Date(p.time).getTime() <= asOfMs),
    [cePremiumPoints, asOfMs],
  )
  const pePremiumRevealed = useMemo(
    () => asOfMs != null && (pePremiumPoints ?? []).some((p) => new Date(p.time).getTime() <= asOfMs),
    [pePremiumPoints, asOfMs],
  )

  const paperStrike = atmStrike != null ? atmStrike + paperStrikeOffset * step : null
  const paperEntryPreview = useMemo(() => {
    if (paperStrike == null || asOfMs == null) return null
    const series = (paperSide === 'CE' ? ceByStrike : peByStrike).get(paperStrike)
    return latestAtOrBefore(series ?? [], asOfMs)
  }, [paperSide, paperStrike, ceByStrike, peByStrike, asOfMs])

  // Paper trades are announced like real ones (Telegram only on today's live view, never a replay).
  const paperTradeText = (p, price) => `${p.direction} ${underlying} ${p.strike} ${p.side} x${p.qtyLots} lot${p.qtyLots === 1 ? '' : 's'} @ ${Number(price).toFixed(1)}`
  const handlePaperPunch = () => {
    if (paperStrike == null || paperEntryPreview?.price == null) return
    const text = paperTradeText({ direction: paperDirection, strike: paperStrike, side: paperSide, qtyLots: paperQtyLots }, paperEntryPreview.price)
    notifyTrade({ kind: 'entry', title: 'Paper order punched', text: `${text}${paperSlPoints > 0 ? ` · SL ${paperSlPoints} pts` : ''}${paperTargetPoints > 0 ? ` · target ${paperTargetPoints} pts` : ''}`,
      telegramText: isLive ? `Paper ${text}` : null })
    setPaperPositions((prev) => [...prev, {
      id: `${Date.now()}-${Math.random()}`,
      side: paperSide, direction: paperDirection, strike: paperStrike, qtyLots: paperQtyLots,
      lotSize: PAPER_TRADE_LOT_SIZE[underlying] ?? 1,
      entryPrice: paperEntryPreview.price, entryTime: asOfMs, status: 'OPEN', exitPrice: null, exitReason: null,
    }])
  }

  const announcePaperExit = (p, exitPrice, reason) => {
    const points = p.direction === 'SELL' ? p.entryPrice - exitPrice : exitPrice - p.entryPrice
    const rupees = points * p.qtyLots * p.lotSize
    const text = `${paperTradeText(p, p.entryPrice)} -> ${Number(exitPrice).toFixed(1)} = ${points >= 0 ? '+' : ''}${points.toFixed(1)} pts (Rs ${Math.round(rupees).toLocaleString('en-IN')})`
    const kind = reason === 'SL' ? 'stopLoss' : reason === 'Target' ? 'target' : 'exit'
    notifyTrade({ kind, good: points >= 0, key: `paper-exit-${p.id}`, title: reason === 'SL' ? 'Paper stop-loss hit' : reason === 'Target' ? 'Paper target hit' : reason === 'Trailing SL' ? 'Paper trailing SL hit' : 'Paper position exited',
      text, telegramText: isLive ? `Paper ${reason === 'SL' ? 'SL hit' : reason === 'Target' ? 'target hit' : 'exit'}: ${text}` : null })
  }
  const handlePaperExit = (id) => {
    const open = paperPositions.find((p) => p.id === id && p.status === 'OPEN')
    if (open) {
      const series = (open.side === 'CE' ? ceByStrike : peByStrike).get(open.strike)
      const point = asOfMs != null ? latestAtOrBefore(series ?? [], asOfMs) : null
      announcePaperExit(open, point?.price ?? open.entryPrice, 'Manual')
    }
    setPaperPositions((prev) => prev.map((p) => {
      if (p.id !== id || p.status !== 'OPEN') return p
      const series = (p.side === 'CE' ? ceByStrike : peByStrike).get(p.strike)
      const point = asOfMs != null ? latestAtOrBefore(series ?? [], asOfMs) : null
      return { ...p, status: 'CLOSED', exitPrice: point?.price ?? p.entryPrice, exitReason: 'Manual' }
    }))
  }

  const handlePaperClearAll = () => setPaperPositions([])

  // ---- Live mode (real Dhan orders) ----
  // The expiry the page is showing live (N1 = nearest listed, ...) as the date the order is for.
  const liveExpiryDate = resolvedExpiries.expiries[Number(liveExpiryFlag.slice(1)) - 1] ?? null
  const liveUnavailableReason = !isAdmin ? 'Live orders are for admins only.'
    : !isLive ? "Live orders need today's live view - press Go Live." : null

  useEffect(() => {
    if (!liveTradeActive) return
    let cancelled = false
    liveTradingApi.positions().then((snapshot) => { if (!cancelled && snapshot) applyLivePositions(snapshot) })
    return () => { cancelled = true }
  }, [liveTradeActive])

  // Leaving today's live view drops back to Paper - live orders only make sense against live prices.
  useEffect(() => {
    if (!isLive && tradeMode === 'live') setTradeMode('paper')
  }, [isLive, tradeMode])

  const handleTradeModeChange = (next) => {
    if (next !== 'live') { setTradeMode('paper'); return }
    Modal.confirm({
      title: 'Switch to LIVE trading?',
      content: 'Orders from this panel will be placed on your Dhan account with real money, as Super Orders with your SL and target. Positions and P&L shown are your real account.',
      okText: 'Yes, go live', okButtonProps: { danger: true }, cancelText: 'Stay on paper',
      onOk: () => {
        setTradeMode('live')
        // The live positions table needs more room than the paper one.
        setPaperPanelSize((size) => (size?.width >= 640 ? size : { ...(size ?? {}), width: 640 }))
      },
    })
  }

  // One live action at a time: a second click (or a second button) while one is still on its way to
  // Dhan is dropped - a double-clicked Place must never send two orders. (The server runs its actions
  // one at a time too.) `notify`: announce the result as a trade notification (and Telegram).
  const liveActionRef = useRef(false)
  const runLiveAction = async (action, notify = null) => {
    if (liveActionRef.current) { message.warning('The previous live action is still on its way to Dhan - wait for it.', 4); return }
    liveActionRef.current = true
    setLiveBusy(true)
    try {
      const result = await action()
      if (notify) notifyTrade({ kind: 'entry', title: notify.title, text: result.message, telegramText: `${notify.title}: ${result.message}` })
      else message.success(result.message, 6)
    } catch (err) {
      if (notify) notifyTrade({ kind: 'failed', title: `${notify.title} - FAILED`, text: err.message, duration: 0 })
      else message.error(err.message, 10)
    } finally {
      liveActionRef.current = false
      setLiveBusy(false)
      // Read Dhan's books straight away after any action (a partial exit, a cancel, a close) so every
      // open order shows - ready to cancel - without waiting for the next update.
      liveTradingApi.positions(true).then((snapshot) => { if (snapshot) applyLivePositions(snapshot) }).catch(() => {})
    }
  }

  const handleLivePunch = () => runLiveAction(() => liveTradingApi.place({
    underlying, expiry: liveExpiryDate, strike: paperStrike, side: paperSide, direction: paperDirection,
    lots: paperQtyLots, slippagePoints: liveSlippage, stopLossPoints: paperSlPoints, targetPoints: paperTargetPoints,
    trailStartPoints: paperTrailGap > 0 ? paperTrailStart ?? 0 : 0, trailGapPoints: paperTrailGap ?? 0,
  }), { title: 'LIVE order placed' })
  const handleLiveClose = (securityId) => runLiveAction(() => liveTradingApi.close(securityId, liveSlippage), { title: 'LIVE close sent' })
  const handleLiveProtect = (securityId, stopLossPrice, targetPrice) => runLiveAction(() => liveTradingApi.protect(securityId, stopLossPrice, targetPrice, liveSlippage))
  const handleLivePartialExit = (securityId, lots) => runLiveAction(() => liveTradingApi.partialExit(securityId, lots, liveSlippage))
  const handleLiveCancel = (orderId, isPlain, leg) => runLiveAction(() => liveTradingApi.cancel(orderId, isPlain, leg))
  const handleLiveExitAll = () => runLiveAction(() => liveTradingApi.exitAll(liveSlippage), { title: 'LIVE exit all sent' })
  const handleLiveEmergencyExitAll = () => runLiveAction(() => liveTradingApi.emergencyExitAll())
  const handleLiveCancelAll = () => runLiveAction(() => liveTradingApi.cancelAll())
  const handleLiveRefresh = () => liveTradingApi.positions(true).then((snapshot) => { if (snapshot) applyLivePositions(snapshot) })
  const liveBlockReason = paperStrike == null ? 'Waiting for the ATM strike.'
    : liveExpiryDate == null ? 'Waiting for the listed expiries.'
      : !(paperSlPoints > 0) || !(paperTargetPoints > 0) ? 'Set both SL and Target - a live order is a Super Order with both legs.'
        : paperTargetPoints <= liveSlippage ? 'Target must be further than the slippage.' : null
  const liveOrderSummary = paperStrike == null ? '' : `${paperDirection} ${underlying} ${paperStrike} ${paperSide}${liveExpiryDate ? ` (${fmtDateOnly(liveExpiryDate)})` : ''} x ${paperQtyLots} lot${paperQtyLots === 1 ? '' : 's'} - LIMIT at the live ${paperDirection === 'SELL' ? 'bid' : 'ask'} ${paperDirection === 'SELL' ? '-' : '+'} ${liveSlippage} pts, SL ${paperSlPoints} pts, target ${paperTargetPoints} pts${paperTrailGap > 0 ? `, trailing ${paperTrailGap} pts behind the best after +${paperTrailStart ?? 0} pts` : ''}.`

  // Exits every currently OPEN position at its own live (as-of-replay) price, rather than deleting
  // them the way Clear all does - a real "flatten everything" action whose exit prices/PnL stay in
  // the table afterward, distinct from Clear all's "wipe the list" ask.
  const handlePaperExitAll = () => {
    for (const p of paperPositions) {
      if (p.status !== 'OPEN') continue
      const series = (p.side === 'CE' ? ceByStrike : peByStrike).get(p.strike)
      const point = asOfMs != null ? latestAtOrBefore(series ?? [], asOfMs) : null
      announcePaperExit(p, point?.price ?? p.entryPrice, 'Manual')
    }
    setPaperPositions((prev) => prev.map((p) => {
      if (p.status !== 'OPEN') return p
      const series = (p.side === 'CE' ? ceByStrike : peByStrike).get(p.strike)
      const point = asOfMs != null ? latestAtOrBefore(series ?? [], asOfMs) : null
      return { ...p, status: 'CLOSED', exitPrice: point?.price ?? p.entryPrice, exitReason: 'Manual' }
    }))
  }

  // Live PnL for every position, OPEN or CLOSED - an OPEN one is marked to the replay's CURRENT
  // tick (so it moves as playback advances, exactly like a real open position would), a CLOSED one
  // is locked to whatever price Exit was clicked at. A SELL (short/write) position's PnL is the
  // mirror of a BUY's - the writer profits as the premium FALLS, not rises - so the ltp/entry delta
  // flips sign for it rather than sharing one formula both directions would get backwards for one.
  const enrichedPaperPositions = useMemo(() => paperPositions.map((p) => {
    const series = (p.side === 'CE' ? ceByStrike : peByStrike).get(p.strike)
    const livePoint = p.status === 'OPEN' && asOfMs != null ? latestAtOrBefore(series ?? [], asOfMs) : null
    const ltp = p.status === 'OPEN' ? (livePoint?.price ?? p.entryPrice) : p.exitPrice
    const priceDelta = p.direction === 'SELL' ? p.entryPrice - ltp : ltp - p.entryPrice
    return { ...p, ltp, priceDelta, pnl: priceDelta * p.qtyLots * p.lotSize }
  }), [paperPositions, ceByStrike, peByStrike, asOfMs])
  const paperOpenCount = enrichedPaperPositions.filter((p) => p.status === 'OPEN').length
  const paperTotalPnl = enrichedPaperPositions.reduce((sum, p) => sum + p.pnl, 0)

  // Auto stop-loss/target: scans every revealed minute bar's own high/low (or each live tick, once
  // today's live feed is ticking) since entry, up to but never past asOfMs, via computeStopTargetHit
  // - so an intra-bar touch that reverses before the next check still gets caught, and the replay
  // never "sees" a bar it hasn't played yet. The user's own "are you actually calculating SL... with
  // high low" correction - the stored rolling_option_bars_1m data genuinely has OHLC per minute, not
  // just a close, so a real touch-check is possible for historical days, not just live ticks.
  const paperAnnouncedRef = useRef(new Set())
  useEffect(() => {
    if ((!paperSlPoints || paperSlPoints <= 0) && (!paperTargetPoints || paperTargetPoints <= 0) && !(paperTrailGap > 0)) return
    const hits = new Map()
    for (const p of paperPositions) {
      if (p.status !== 'OPEN' || p.entryTime == null) continue
      const series = (p.side === 'CE' ? ceByStrike : peByStrike).get(p.strike)
      const hit = computeStopTargetHit(series, p.entryTime, asOfMs, p.entryPrice, p.direction, paperSlPoints, paperTargetPoints, paperTrailStart, paperTrailGap)
      if (hit) hits.set(p.id, hit)
    }
    if (hits.size === 0) return
    for (const p of paperPositions) {
      const hit = hits.get(p.id)
      if (!hit || paperAnnouncedRef.current.has(p.id)) continue
      paperAnnouncedRef.current.add(p.id)
      announcePaperExit(p, hit.fillPrice, hit.kind === 'sl' ? 'SL' : hit.kind === 'trail' ? 'Trailing SL' : 'Target')
    }
    setPaperPositions((prev) => prev.map((p) => {
      const hit = hits.get(p.id)
      return hit && p.status === 'OPEN' ? { ...p, status: 'CLOSED', exitPrice: hit.fillPrice, exitReason: hit.kind === 'sl' ? 'SL' : hit.kind === 'trail' ? 'Trailing SL' : 'Target' } : p
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paperPositions, ceByStrike, peByStrike, asOfMs, paperSlPoints, paperTargetPoints, paperTrailStart, paperTrailGap])

  // Regime-change markers stamped on the exact candle where a Long Buildup/Short Buildup/Short
  // Covering/Long Unwinding stretch actually started - "show me when what happened" on the chart
  // itself, not just a single end-of-day verdict. Compares each displayed candle against the PRIOR
  // one (not the day's open) so this reflects the CURRENT regime, and only emits a marker when the
  // classification actually changes (a run of 10 "still Long Buildup" candles in a row would
  // otherwise draw 10 markers on top of each other).
  const futuresRegimeMarkers = useMemo(() => {
    if (!result?.futuresOiAvailable || displayFuturesBars.length < 2) return []
    const priceThreshold = step * FUTURES_REGIME_PRICE_STEP_FACTOR
    const markers = []
    let prevRegime = 'Neutral'
    let prevClose = displayFuturesBars[0].close
    let prevOi = latestAtOrBefore(futuresPointsRaw, fromChartTime(displayFuturesBars[0].time) * 1000)?.openInterest ?? null

    for (let i = 1; i < displayFuturesBars.length; i++) {
      const bar = displayFuturesBars[i]
      const oi = latestAtOrBefore(futuresPointsRaw, fromChartTime(bar.time) * 1000)?.openInterest ?? null
      if (oi == null || prevOi == null) { prevClose = bar.close; prevOi = oi; continue }

      const regime = classifyFuturesRegime(bar.close - prevClose, oi - prevOi, priceThreshold, FUTURES_REGIME_OI_THRESHOLD)
      if (regime !== 'Neutral' && regime !== prevRegime) {
        const info = FUTURES_REGIME_INFO[regime]
        const bullish = info.bias === 'Bullish'
        markers.push({
          time: bar.time,
          position: bullish ? 'belowBar' : 'aboveBar',
          color: info.color,
          shape: bullish ? 'arrowUp' : 'arrowDown',
          text: regime,
        })
      }
      if (regime !== 'Neutral') prevRegime = regime
      prevClose = bar.close
      prevOi = oi
    }
    return markers
  }, [displayFuturesBars, futuresPointsRaw, step, result])

  // The single "as of right now" verdict for the table/read box - same 4-quadrant classification
  // as the chart markers, just measured since the DAY'S OPEN rather than the previous candle, so
  // it reads as "today's overall futures story so far" rather than "what just happened".
  const futuresRegimeSinceOpen = useMemo(() => {
    if (!result?.futuresOiAvailable || currentFutures?.close == null || futuresOpen?.close == null || futuresOiSinceOpen == null) return null
    const priceDelta = currentFutures.close - futuresOpen.close
    const regime = classifyFuturesRegime(priceDelta, futuresOiSinceOpen, step * FUTURES_REGIME_PRICE_STEP_FACTOR, FUTURES_REGIME_OI_THRESHOLD)
    return { regime, priceDelta, oiDelta: futuresOiSinceOpen, ...FUTURES_REGIME_INFO[regime] }
  }, [currentFutures, futuresOpen, futuresOiSinceOpen, step, result])

  // PCR (Put-Call Ratio, total PE OI / total CE OI across the whole fetched band) and Max Pain -
  // the two standard derived reads a real OI chain gets used for beyond "where's the wall" (per the
  // user's own "and other things whatever you want to deduce").
  const { pcr, totalCeOi, totalPeOi } = useMemo(() => {
    const totalCe = ladderRows.reduce((s, r) => s + (r.ceOi ?? 0), 0)
    const totalPe = ladderRows.reduce((s, r) => s + (r.peOi ?? 0), 0)
    return { pcr: totalCe > 0 ? totalPe / totalCe : null, totalCeOi: totalCe, totalPeOi: totalPe }
  }, [ladderRows])

  const maxPain = useMemo(() => computeMaxPain(ladderRows), [ladderRows])

  // Every strike/side's OI at the very first revealed bar of the day - the fixed reference point
  // "day accumulation" and the top-movers list below both compare the CURRENT ladder against, so
  // both read "since the open", not "since the last minute" (that's what OiChange already covers).
  // (dayStartMs itself is declared above, before ladderRows, since the ladder now also needs it.)
  const dayStartByStrike = useMemo(() => {
    if (dayStartMs == null) return new Map()
    const map = new Map()
    for (const strike of new Set([...ceByStrike.keys(), ...peByStrike.keys()])) {
      const ce = latestAtOrBefore(ceByStrike.get(strike) ?? [], dayStartMs)
      const pe = latestAtOrBefore(peByStrike.get(strike) ?? [], dayStartMs)
      map.set(strike, {
        ceOi: ce?.openInterest ?? null, peOi: pe?.openInterest ?? null,
        ceIv: ce?.impliedVolatility ?? null, peIv: pe?.impliedVolatility ?? null,
      })
    }
    return map
  }, [ceByStrike, peByStrike, dayStartMs])

  // Whole-day accumulation (same Price+OI combination logic as the per-tick "OI buildup" in
  // Market Read, just measured from the DAY'S OPEN to right now instead of the last single minute)
  // plus the two strike/side pairs that have added the most OI and the two that have shed the most,
  // across the whole fetched band - "continuously" read as "net change since the open", not a
  // strict every-single-minute streak (this app has no per-minute streak tracker, and a streak that
  // reverses for one minute then resumes is still the same real accumulation story).
  const dayOiSummary = useMemo(() => {
    if (!currentBar || oneMinBars.length === 0 || dayStartByStrike.size === 0) return null

    let ceStartTotal = 0
    let peStartTotal = 0
    const movers = []
    for (const row of ladderRows) {
      const start = dayStartByStrike.get(row.strike)
      if (row.ceOi != null && start?.ceOi != null) {
        ceStartTotal += start.ceOi
        movers.push({ strike: row.strike, side: 'CE', change: row.ceOi - start.ceOi })
      }
      if (row.peOi != null && start?.peOi != null) {
        peStartTotal += start.peOi
        movers.push({ strike: row.strike, side: 'PE', change: row.peOi - start.peOi })
      }
    }
    const ceDayChange = totalCeOi - ceStartTotal
    const peDayChange = totalPeOi - peStartTotal
    const dayPriceChange = currentBar.close - oneMinBars[0].open

    let dayBias = 'Neutral'
    let dayReason = 'No clear net accumulation pattern for the day so far'
    if (dayPriceChange > 0 && peDayChange > 0 && peDayChange >= ceDayChange) { dayBias = 'Bullish'; dayReason = `Net put writing since the open (${formatOiMillions(peDayChange, { signed: true })} PE OI) while price is up ${dayPriceChange.toFixed(0)} pts - support built through the day` }
    else if (dayPriceChange < 0 && ceDayChange > 0 && ceDayChange >= peDayChange) { dayBias = 'Bearish'; dayReason = `Net call writing since the open (${formatOiMillions(ceDayChange, { signed: true })} CE OI) while price is down ${Math.abs(dayPriceChange).toFixed(0)} pts - resistance built through the day` }
    else if (dayPriceChange > 0 && ceDayChange < 0) { dayBias = 'Bullish'; dayReason = `Net call unwinding since the open (${formatOiMillions(ceDayChange, { signed: true })} CE OI) as price rose ${dayPriceChange.toFixed(0)} pts - short covering, not fresh support` }
    else if (dayPriceChange < 0 && peDayChange < 0) { dayBias = 'Bearish'; dayReason = `Net put unwinding since the open (${formatOiMillions(peDayChange, { signed: true })} PE OI) as price fell ${Math.abs(dayPriceChange).toFixed(0)} pts - long unwinding, not fresh resistance` }

    const added = [...movers].filter((m) => m.change > 0).sort((a, b) => b.change - a.change).slice(0, 2)
    const removed = [...movers].filter((m) => m.change < 0).sort((a, b) => a.change - b.change).slice(0, 2)

    return { dayBias, dayReason, ceDayChange, peDayChange, added, removed }
  }, [currentBar, oneMinBars, ladderRows, dayStartByStrike, totalCeOi, totalPeOi])

  // One point per REVEALED 1-min bar, for the Total OI Lookback Table AND the Day OI Accumulation
  // card's own chain-wide chart below - total (chain-wide) CE/PE OI as of that bar's own close,
  // built the same way ladderRows/dayStartByStrike already read a single point in time, just
  // repeated across every bar instead of one. Bounded by visibleCount (Math.min against
  // oneMinBars.length as a safety clamp, isLive's own visibleCount already equals it exactly) -
  // NOT oneMinBars.length on its own, which used to build the whole day's history immediately
  // regardless of how far a historical replay had actually played to. A real report ("these graphs
  // should work tick by tick, not all in one") caught this: the chain-wide chart was showing the
  // WHOLE day the instant it loaded, while every other derived read on this page (the ladder,
  // premium charts, Market Read) correctly only reveals up to asOfMs/visibleCount.
  //
  // Deliberately keyed on oneMinBars.length rather than on ceByStrike/peByStrike themselves (which
  // get a new Map reference on every single live tick): a per-bar lookback table has no need for
  // sub-minute precision on its HISTORICAL points, and redoing this whole-day sum across every
  // strike on every tick (rather than once per completed minute) would be wasted work during a live
  // "today" replay. underlying/result.date/expiryFlag are in the deps purely so switching to a
  // different day/instrument that happens to produce the exact same bar count still forces a
  // recompute instead of reusing stale totals from the day just left.
  const completedOiHistory = useMemo(() => {
    const revealed = Math.min(visibleCount, oneMinBars.length)
    if (revealed < 2) return []
    const strikes = [...new Set([...ceByStrike.keys(), ...peByStrike.keys()])]
    // One forward sweep per series (bars and points are both time-ascending), each cursor only ever
    // moving forward - linear in the day's data, where a lookup per bar per strike grew with the
    // square of it and froze the page for over a second each minute by the afternoon.
    const cursorsFor = (byStrike) => strikes.map((s) => ({ series: byStrike.get(s) ?? [], next: 0, oi: 0 }))
    const ceCursors = cursorsFor(ceByStrike)
    const peCursors = cursorsFor(peByStrike)
    const totalAt = (cursors, barMs) => {
      let total = 0
      for (const c of cursors) {
        while (c.next < c.series.length && pointMs(c.series[c.next]) <= barMs) c.oi = c.series[c.next++].openInterest ?? 0
        total += c.oi
      }
      return total
    }
    const history = []
    for (let i = 0; i < revealed - 1; i++) {
      const bar = oneMinBars[i]
      const barMs = fromChartTime(bar.time) * 1000
      history.push({ time: bar.time, ceTotal: totalAt(ceCursors, barMs), peTotal: totalAt(peCursors, barMs) })
    }
    return history
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oneMinBars.length, visibleCount, underlying, result?.date, expiryFlag])

  // The still-forming/current REVEALED bar appended live, using the page's own already-ticking
  // (and already asOfMs-gated, via ladderRows) totalCeOi/totalPeOi rather than recomputing the
  // whole day above - "now" stays continuously live even though completedOiHistory only updates
  // once a minute. currentBar, not oneMinBars' own last bar - the latter is the DAY's final bar
  // regardless of replay position, which used to jump this chart's own last point straight to the
  // end of the day even mid-replay; currentBar is already exactly "the last REVEALED bar" (see its
  // own derivation above, oneMinBars[visibleCount - 1]).
  const totalOiHistory = useMemo(() => {
    if (!currentBar) return completedOiHistory
    return [...completedOiHistory, { time: currentBar.time, ceTotal: totalCeOi, peTotal: totalPeOi }]
  }, [completedOiHistory, currentBar, totalCeOi, totalPeOi])

  const ceTotalOiLine = useMemo(
    () => aggregateLinePoints(totalOiHistory.map((p) => ({ time: p.time, value: p.ceTotal })), totalOiLookbackTimeframe),
    [totalOiHistory, totalOiLookbackTimeframe],
  )
  const peTotalOiLine = useMemo(
    () => aggregateLinePoints(totalOiHistory.map((p) => ({ time: p.time, value: p.peTotal })), totalOiLookbackTimeframe),
    [totalOiHistory, totalOiLookbackTimeframe],
  )
  const totalOiLookbackRows = totalOiLookbackBars.map((n) => {
    const ce = computeOiLookbackChange(ceTotalOiLine, n)
    const pe = computeOiLookbackChange(peTotalOiLine, n)
    return { key: n, bars: n, ceDelta: ce.delta, cePercent: ce.percentChange, peDelta: pe.delta, pePercent: pe.percentChange }
  })
  // The whole-chain counterpart to the per-strike drilldown's own "Since open Δ" chart - same
  // toSinceOpenSeries re-basing, just fed the CHAIN-WIDE total lines above instead of one strike's
  // own. dayOiSummary's ceDayChange/peDayChange already give this as a single current number; this
  // is that same number's full trajectory through the day.
  const ceTotalSinceOpenLine = useMemo(() => toSinceOpenSeries(ceTotalOiLine), [ceTotalOiLine])
  const peTotalSinceOpenLine = useMemo(() => toSinceOpenSeries(peTotalOiLine), [peTotalOiLine])

  // Smart alert: whenever a strike NEAR ATM shows a one-minute OI shift past this threshold, flag
  // it and beep - the "someone just loaded/unwound a huge quantity" event this app can't otherwise
  // call out on its own. "Near ATM" is +-3 strike-steps (the same handful of strikes a real trader
  // actually watches tick to tick, not the whole +-10 band the ladder shows). Checked once PER
  // REPLAY TICK (native 1-minute), not once per render, so it beeps at most once per real minute
  // rather than repeatedly while a breach's own row re-renders for unrelated reasons.
  const [alertThreshold, setAlertThreshold] = useState(1_000_000)
  const [soundEnabled, setSoundEnabled] = useState(true)
  // Defaults to top-5-only (the chart's original, carefully-tuned-for-readability behavior) - the
  // user's own "switch ... if true show top 5 else all wall" ask, off shows every real wall in the
  // whole fetched band instead (see ReplayChart's own top5Only doc comment).
  const [top5WallsOnly, setTop5WallsOnly] = useState(true)

  const activeAlerts = useMemo(() => {
    if (atmStrike == null || ladderRows.length === 0) return []
    const nearAtm = ladderRows.filter((r) => Math.abs(r.strike - atmStrike) <= step * 3)
    const breaches = []
    for (const r of nearAtm) {
      if (r.ceOiChange != null && Math.abs(r.ceOiChange) >= alertThreshold) breaches.push({ strike: r.strike, side: 'CE', change: r.ceOiChange })
      if (r.peOiChange != null && Math.abs(r.peOiChange) >= alertThreshold) breaches.push({ strike: r.strike, side: 'PE', change: r.peOiChange })
    }
    return breaches
  }, [ladderRows, atmStrike, step, alertThreshold])

  // The beep is the one genuine side effect here (activeAlerts above is a plain derived value) -
  // fires at most once per NEW replay tick that has a breach, not once per render, so it doesn't
  // re-beep for the same tick if something unrelated causes a re-render.
  const lastAlertedTickRef = useRef(-1)
  useEffect(() => {
    if (visibleCount === lastAlertedTickRef.current) return
    lastAlertedTickRef.current = visibleCount
    if (activeAlerts.length > 0 && soundEnabled) playBeep()
  }, [visibleCount, activeAlerts, soundEnabled])

  // Synthesizes PCR + OI buildup + IV skew into one heuristic read - three independent votes
  // (Bullish/Bearish/Neutral), combined into an overall bias and a candidate strike/side. This is a
  // rule-of-thumb reading of the SAME numbers already shown above, not a prediction - all three
  // signals can (and often do) disagree, which is exactly what "Mixed" reports honestly rather than
  // forcing a call either way.
  const marketRead = useMemo(() => {
    if (!currentBar || ladderRows.length === 0 || atmStrike == null) return null

    // PCR: conventional NSE-desk reading - a high PCR means more puts written relative to calls,
    // which (writers being confident enough to sell there) reads as support/bullish; a low PCR the
    // mirror. Thresholds are naive, not calibrated against real outcomes - a starting point, not
    // a validated signal.
    const pcrBias = pcr == null ? 'Neutral' : pcr > 1.2 ? 'Bullish' : pcr < 0.8 ? 'Bearish' : 'Neutral'

    const resistance = ladderRows.reduce((best, r) => ((r.ceOi ?? 0) > (best?.ceOi ?? -1) ? r : best), null)
    const support = ladderRows.reduce((best, r) => ((r.peOi ?? 0) > (best?.peOi ?? -1) ? r : best), null)

    // OI buildup near ATM (+-2 steps), combined with the spot move over the last 5 revealed bars -
    // the classic "Price + OI" combination read: rising price + rising Put OI = fresh put WRITING
    // (bullish, support being defended); falling price + rising Call OI = fresh call writing
    // (bearish, resistance being defended); the two unwind variants are the same move without fresh
    // OI backing it - weaker, "covering" rather than a defended level.
    const nearAtm = ladderRows.filter((r) => Math.abs(r.strike - atmStrike) <= step * 2)
    const ceChangeSum = nearAtm.reduce((s, r) => s + (r.ceOiChange ?? 0), 0)
    const peChangeSum = nearAtm.reduce((s, r) => s + (r.peOiChange ?? 0), 0)
    const priorBar = oneMinBars[Math.max(0, visibleCount - 6)]
    const priceChange = priorBar ? currentBar.close - priorBar.close : 0

    let oiBuildup = 'No clear buildup pattern near ATM yet'
    let oiBias = 'Neutral'
    if (priceChange > 0 && peChangeSum > 0 && peChangeSum >= ceChangeSum) { oiBuildup = 'Put writing near ATM as price rises - support being defended'; oiBias = 'Bullish' }
    else if (priceChange < 0 && ceChangeSum > 0 && ceChangeSum >= peChangeSum) { oiBuildup = 'Call writing near ATM as price falls - resistance being defended'; oiBias = 'Bearish' }
    else if (priceChange > 0 && ceChangeSum < 0) { oiBuildup = 'Call unwinding as price rises - short covering, no fresh support built'; oiBias = 'Bullish' }
    else if (priceChange < 0 && peChangeSum < 0) { oiBuildup = 'Put unwinding as price falls - long unwinding, no fresh resistance built'; oiBias = 'Bearish' }

    // IV skew at ATM - read as a CHANGE since the day's open, not an absolute level. NIFTY/
    // BANKNIFTY (like almost every equity index) structurally has PE IV > CE IV almost all the
    // time - a permanent downside-protection premium baked into the vol surface, not a sentiment
    // signal. Thresholding the raw level (an earlier version of this did) reads "Bearish" on
    // nearly every normal day regardless of what's actually happening, which is exactly the bug
    // report this fixes. WIDENING skew (PE getting richer relative to CE as the day goes on) means
    // downside fear building - that is the real signal; narrowing means it is easing.
    const atmRow = ladderRows.find((r) => r.strike === atmStrike) ?? nearAtm[0] ?? null
    const skew = atmRow && atmRow.peIv != null && atmRow.ceIv != null ? atmRow.peIv - atmRow.ceIv : null
    const startAtm = dayStartByStrike.get(atmStrike)
    const skewAtOpen = startAtm && startAtm.peIv != null && startAtm.ceIv != null ? startAtm.peIv - startAtm.ceIv : null
    const skewChange = skew != null && skewAtOpen != null ? skew - skewAtOpen : null
    const ivBias = skewChange == null ? 'Neutral' : skewChange > 0.5 ? 'Bearish' : skewChange < -0.5 ? 'Bullish' : 'Neutral'

    const votes = [pcrBias, oiBias, ivBias]
    const bullCount = votes.filter((v) => v === 'Bullish').length
    const bearCount = votes.filter((v) => v === 'Bearish').length
    const overall = bullCount > bearCount ? 'Bullish' : bearCount > bullCount ? 'Bearish' : 'Mixed / Neutral'

    // BUY: direction-following - the nearest OTM strike in whichever way the overall vote leans.
    // SELL: the wall on the side the overall vote does NOT expect to be tested - selling premium
    // against a level the move is unlikely to reach is the safer side of that same read (sell CE at
    // resistance when the bias is bearish/mixed - upside isn't expected to be tested; sell PE at
    // support when bullish/mixed - downside isn't expected to be tested).
    const buySide = overall === 'Bullish' ? 'CE' : overall === 'Bearish' ? 'PE' : null
    const buyStrike = overall === 'Bullish' ? atmStrike + step : overall === 'Bearish' ? atmStrike - step : null
    const sellSide = overall === 'Bearish' ? 'CE' : 'PE'
    const sellStrike = sellSide === 'CE' ? resistance?.strike ?? null : support?.strike ?? null

    const suggestedStrike = buyStrike ?? atmStrike
    const suggestedSide = buySide ?? 'No clear edge - consider staying flat'

    // "Are we okay right now" - a plain proximity-to-wall check, independent of the bullish/bearish
    // vote above: even a clear directional read is riskier to act on right this second if price is
    // already sitting on top of a wall (the next tick either breaks it or gets rejected hard).
    // Threshold is half a strike-step - close enough to matter, not so tight it never fires.
    const wallThreshold = step * 0.5
    const distToResistance = resistance ? resistance.strike - currentBar.close : null
    const distToSupport = support ? currentBar.close - support.strike : null
    const nearResistance = distToResistance != null && distToResistance >= 0 && distToResistance <= wallThreshold
    const nearSupport = distToSupport != null && distToSupport >= 0 && distToSupport <= wallThreshold
    const safetyOk = !nearResistance && !nearSupport
    const safetyReason = nearResistance
      ? `Price is only ${distToResistance.toFixed(0)} pts below the resistance wall at ${resistance.strike} - a break needs conviction, a rejection is live risk right now.`
      : nearSupport
        ? `Price is only ${distToSupport.toFixed(0)} pts above the support wall at ${support.strike} - a break needs conviction, a bounce is live risk right now.`
        : `Price is clear of both the resistance wall (${resistance ? `${resistance.strike}, ${(resistance.strike - currentBar.close).toFixed(0)} pts away` : 'none'}) and the support wall (${support ? `${support.strike}, ${(currentBar.close - support.strike).toFixed(0)} pts away` : 'none'}) right now.`

    return {
      pcrBias, resistance, support, oiBuildup, oiBias, skew, skewChange, ivBias,
      atmCeIv: atmRow?.ceIv, atmPeIv: atmRow?.peIv, overall, suggestedStrike, suggestedSide,
      buySide, buyStrike, sellSide, sellStrike,
      safetyOk, safetyReason,
    }
  }, [currentBar, ladderRows, pcr, atmStrike, step, oneMinBars, visibleCount, dayStartByStrike])

  // ---- Sync with the Order Flow replay (another tab) - see replaySync.jsx. This replay moves a minute
  // bar at a time, so its clock is the END of the newest revealed minute (asOfMs + 1 minute), and its
  // speed (speedMs per minute) is 60000 / speedMs market seconds per second.
  const [syncEnabled, setSyncEnabled] = useReplaySyncEnabled()
  const [syncMismatch, setSyncMismatch] = useState(null)
  const pendingSyncRef = useRef(null)
  const syncClockMs = !isLive && currentBar ? fromChartTime(currentBar.time) * 1000 + 60_000 : null
  // Follows the other page onto its day: loads it here as a replay - switching the underlying first
  // (the pending message is applied again once it has switched) - or goes live with it. Once per day
  // asked: the re-applies while that day loads must not restart its load.
  const followRef = useRef(null)
  const followDay = (msg) => {
    if (msg.underlying !== underlying) {
      pendingSyncRef.current = msg
      selectUnderlying(msg.underlying)
      return
    }
    const key = msg.live ? `${msg.underlying}:live` : `${msg.underlying}:${msg.date}`
    if (followRef.current === key) return
    followRef.current = key
    setSyncMismatch(null)
    if (msg.live) { goLive(); return }
    const day = dayjs(msg.date)
    setTodayMode('replay')
    setDate(day)
    load(day, { live: false })
  }
  const applySync = (msg) => {
    pendingSyncRef.current = null
    if (!['NIFTY', 'BANKNIFTY', 'SENSEX'].includes(msg.underlying)) return
    if (msg.type === 'day') {
      // The other page went live: so does this one.
      if (msg.live) {
        if (!isLive || msg.underlying !== underlying) followDay(msg)
        return
      }
      if (!msg.date) return
      // The user picked (or reloaded) a day there: load it here too - the same day as well, so a Load
      // day refresh reaches both pages. Its clock follows once it has loaded.
      pendingSyncRef.current = { ...msg, type: 'state', reason: 'user', ms: null, playing: false }
      followDay(msg)
      return
    }
    if (!msg.date) return
    if (isLive || msg.underlying !== underlying || msg.date !== result?.date) {
      // A heartbeat never moves this page to another day - only the user's pick there (or the reply
      // when joining) does, so a heartbeat already in flight cannot pull it back to the old day.
      if (msg.reason === 'tick') return
      pendingSyncRef.current = msg
      followDay(msg)
      return
    }
    if (oneMinBars.length === 0) { pendingSyncRef.current = msg; return }
    followRef.current = null
    setSyncMismatch(null)
    if (msg.speed > 0) setSpeedMs(Math.max(20, Math.round(60_000 / msg.speed)))
    let count = manualVisibleCount
    if (msg.ms != null && (msg.reason !== 'tick' || syncClockMs == null || Math.abs(syncClockMs - msg.ms) > SYNC_DRIFT_MS)) {
      count = 0
      while (count < oneMinBars.length && fromChartTime(oneMinBars[count].time) * 1000 + 60_000 <= msg.ms) count++
      count = Math.max(1, count)
      setManualVisibleCount(count)
    }
    setPlaying(Boolean(msg.playing) && count < oneMinBars.length)
  }
  const sync = useReplaySync({
    enabled: syncEnabled, active: !isLive, kind: 'oi',
    // No day while one is loading: until it lands, `result` is still the previous day's.
    state: { underlying, date: isLive || loading ? null : result?.date ?? null, ms: syncClockMs, playing, speed: 60_000 / speedMs, live: isLive },
    onRemote: applySync,
  })
  // A sync that arrived before the matching day had loaded (`result` itself, not its date: reloading
  // the same day must count too).
  useEffect(() => {
    if (pendingSyncRef.current) applySync(pendingSyncRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, oneMinBars.length, underlying])
  // The day the other page is on could not be loaded here: say so, with a retry.
  useEffect(() => {
    const msg = pendingSyncRef.current
    if (error && msg?.date && followRef.current === `${msg.underlying}:${msg.date}`) setSyncMismatch({ underlying: msg.underlying, date: msg.date })
  }, [error])
  const loadSyncedDay = () => {
    if (!syncMismatch?.date) return
    followRef.current = null
    pendingSyncRef.current = { type: 'day', underlying: syncMismatch.underlying, date: syncMismatch.date }
    followDay(pendingSyncRef.current)
  }
  // The user picked a day here (or went live): the Order Flow page loads the same.
  const ownDay = () => { followRef.current = null; pendingSyncRef.current = null; setSyncMismatch(null) }
  const goLiveAndAnnounce = () => { ownDay(); goLive(); sync.announceDay({ underlying, live: true }) }
  const loadDayAndAnnounce = () => { ownDay(); loadForReplay(); sync.announceDay({ underlying, date: date?.format('YYYY-MM-DD') }) }
  // With Sync on, picking a date loads it straight away - here and on the Order Flow page.
  const pickDate = (d) => {
    setDate(d)
    if (!syncEnabled || !d || !underlying) return
    ownDay()
    setTodayMode('replay')
    load(d, { live: false })
    sync.announceDay({ underlying, date: d.format('YYYY-MM-DD') })
  }
  const syncControl = (
    <>
      <ReplaySyncControl
        enabled={syncEnabled} onChange={setSyncEnabled} sync={sync} kind="oi"
        mismatch={syncMismatch ? `Order Flow is on ${syncMismatch.underlying} ${syncMismatch.date} - could not load it here` : null}
      />
      {syncEnabled && syncMismatch && <Button size="small" onClick={loadSyncedDay}>Retry {syncMismatch.date}</Button>}
    </>
  )

  // Shared by the inline and floating placements of the replay controls (see replayControlsFloating).
  const replayButtons = (
    <>
      <Button
        icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
        onClick={() => { setPlaying((p) => !p); sync.userAction() }}
        disabled={oneMinBars.length === 0 || manualVisibleCount >= oneMinBars.length}
      >
        {playing ? 'Pause' : 'Start'}
      </Button>
      <Button
        icon={<ReloadOutlined />}
        onClick={() => { setPlaying(false); setManualVisibleCount(oneMinBars.length > 0 ? 1 : 0); sync.userAction() }}
      >
        Reset
      </Button>
      <Text type="secondary" style={{ fontSize: 12 }}>Speed</Text>
      <Select
        value={speedMs} onChange={(v) => { setSpeedMs(v); sync.userAction() }} style={{ width: 90 }}
        options={withSpeedOption(SPEED_OPTIONS, speedMs, (v) => ({ value: v, label: `${Math.round((1000 / v) * 100) / 100}x` }))}
      />
      {/* A label rather than a hover tooltip: in the compact floating panel a tooltip above the
          picker sat right over the Start button. */}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>Go to</Text>
        <TimePicker
          format="HH:mm" minuteStep={1} allowClear={false} needConfirm={false} showNow={false}
          placeholder="Go to time" style={{ width: 110 }} disabled={oneMinBars.length === 0}
          value={currentBar ? dayjs().hour(new Date(currentBar.time * 1000).getUTCHours()).minute(new Date(currentBar.time * 1000).getUTCMinutes()).second(0) : null}
          disabledTime={() => ({ disabledHours: () => [...Array(24).keys()].filter((h) => h < 9 || h > 15) })}
          onChange={(v) => {
            if (!v) return
            setPlaying(false)
            setManualVisibleCount(replayCountAt(oneMinBars, v.hour(), v.minute()))
            sync.userAction()
          }}
        />
      </span>
    </>
  )
  const replaySlider = (
    <Slider
      min={0} max={Math.max(0, oneMinBars.length - 1)} value={visibleCount - 1}
      onChange={(v) => { setPlaying(false); setManualVisibleCount(v + 1); sync.userAction() }}
      tooltip={{ formatter: (v) => oneMinBars[v] ? istTimeFormatter(oneMinBars[v].time) : '' }}
    />
  )

  // The Spot card's whole content, shared by its inline and floating placements (see spotFloating).
  // Built on every render now (it used to sit inside the page's own result-loaded branch), so it
  // must not assume a loaded day: live candles keep arriving while today's fetch is being redone
  // or has failed, and reading result.date then crashed the whole page.
  const spotChartHeight = spotFloating ? 440 : 560
  const spotCardContent = result && (
    <>
      {/* Playback controls, literally inside the same card as the chart, right above
          the canvas itself - the user's own "this bar should be near to chart just on
          top of chart, it is too far right now" (a separate card above it, even
          directly adjacent, still wasn't close enough). */}
      <Space align="center" size={16} wrap style={{ marginBottom: 8 }}>
        {/* TODAY IS ALWAYS LIVE, FULL STOP - no Start/Pause/Speed/Slider at all, and no
            way for any control here to drop out of following the tip. The previous
            design let Start/Reset/the slider each pause live-following (to "review an
            earlier point"), but that meant clicking Start out of habit - exactly what a
            button labelled "Start" invites - silently froze the page at whatever bar it
            was on, needing ANOTHER Start click to catch back up: the precise "I have to
            start it again" loop reported. There is nothing left here that can do that.
            Reviewing an earlier point in the day is still possible - pick that date with
            the DatePicker above and Load it, which gets the FULL replay scrubber below,
            just not live. */}
        {!isLive && !replayControlsFloating && (
          <>
            {replayButtons}
            <div style={{ flex: 1, minWidth: 160 }}>{replaySlider}</div>
            <Tooltip title="Pop the replay controls out into a panel you can drag anywhere">
              <Button size="small" icon={<ExportOutlined />} onClick={() => setReplayControlsFloating(true)}>Float</Button>
            </Tooltip>
          </>
        )}
        {!isLive && replayControlsFloating && (
          <>
            <Button size="small" onClick={() => setReplayControlsFloating(false)}>Dock replay controls</Button>
          </>
        )}
        <Text style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
          {currentBar ? `${istTimeFormatter(currentBar.time)} (${visibleCount}/${oneMinBars.length})` : '—'}
        </Text>
        {isLive && (
          <Tooltip title={
            liveConnectionState === 'connected' ? "Streaming live ticks from Dhan's WebSocket feed on top of today's snapshot (price + OI - IV stays at the last REST-fetched value)"
              : liveConnectionState === 'reconnecting' ? 'Connection dropped - automatically retrying.'
                : liveConnectionState === 'connecting' ? 'Connecting to the live feed…'
                  : 'Not connected - not receiving live ticks right now.'
          }>
            <Tag color={liveConnectionState === 'connected' ? 'success' : liveConnectionState === 'reconnecting' ? 'warning' : liveConnectionState === 'connecting' ? 'processing' : 'error'}>
              {liveConnectionState === 'connected' ? '● LIVE' : liveConnectionState === 'reconnecting' ? '● RECONNECTING' : liveConnectionState === 'connecting' ? '● CONNECTING' : '● OFFLINE'}
            </Tag>
          </Tooltip>
        )}
        {ladderRows.length > 0 && (
          // Chain-wide total OI, live, right where the trade is punched - same totals the
          // Snapshot card shows, with each side's change since the open. Red CE / green PE
          // by this page's option-selling OI convention (see StrikeOiDrilldownChart).
          <Tooltip title="Total open interest across every tracked strike, live, with the change since today's open.">
            <Text style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
              <span style={{ color: DOWN_COLOR }}>CE {formatOiMillions(totalCeOi)}{dayOiSummary ? ` (${formatOiMillions(dayOiSummary.ceDayChange, { signed: true })})` : ''}</span>
              <Text type="secondary" style={{ fontSize: 11 }}>{' · '}</Text>
              <span style={{ color: UP_COLOR }}>PE {formatOiMillions(totalPeOi)}{dayOiSummary ? ` (${formatOiMillions(dayOiSummary.peDayChange, { signed: true })})` : ''}</span>
              {pcr != null && <Text type="secondary" style={{ fontSize: 11 }}>{` · PCR ${pcr.toFixed(2)}`}</Text>}
            </Text>
          </Tooltip>
        )}
        {paperTotalPnl !== 0 || paperOpenCount > 0 ? (
          <Tag
            color={paperTotalPnl >= 0 ? 'success' : 'error'} style={{ cursor: 'pointer' }}
            onClick={() => setPaperPanelOpen((o) => !o)}
          >
            Paper PnL: {paperTotalPnl >= 0 ? '+' : ''}{paperTotalPnl.toFixed(0)}{paperOpenCount > 0 ? ` (${paperOpenCount} open)` : ''}
          </Tag>
        ) : (
          <Button size="small" onClick={() => setPaperPanelOpen((o) => !o)}>Paper Trade</Button>
        )}
      </Space>
      <Space align="center" size={12} wrap style={{ marginBottom: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>Alert when a strike near ATM shifts by</Text>
        <InputNumber
          value={alertThreshold} onChange={(v) => setAlertThreshold(v ?? 0)}
          min={0} step={100000} style={{ width: 140 }}
          formatter={(v) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}
          parser={(v) => v.replace(/,/g, '')}
        />
        <Text type="secondary" style={{ fontSize: 12 }}>OI in one minute</Text>
        <Switch
          checked={soundEnabled} onChange={setSoundEnabled}
          checkedChildren={<SoundOutlined />} unCheckedChildren="Muted"
        />
        <Text type="secondary" style={{ fontSize: 12 }}>Top 5 walls only</Text>
        <Switch checked={top5WallsOnly} onChange={setTop5WallsOnly} />
      </Space>
      {activeAlerts.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 8 }}
          message="Large OI shift near ATM"
          description={activeAlerts.map((a) => `${a.side} ${a.strike}: ${formatOiMillions(a.change, { signed: true })} in the last minute (${a.change >= 0 ? 'loading' : 'unwinding'})`).join(' · ')}
        />
      )}
      {oneMinBars.length > 0
        ? (
          <ChartErrorBoundary key={`${underlying}-${result?.date}-${timeframe}`}>
            <ReplayChart
              bars={displayBars}
              ladderRows={ladderRows}
              dayKey={`${underlying}-${result?.date}-${timeframe}`}
              atmStrike={atmStrike}
              step={step}
              top5Only={top5WallsOnly}
              vwapSeries={vwapSeries}
              showVwap={showVwap}
              onStrikeClick={setDrilldownStrike}
              height={spotChartHeight}
            />
          </ChartErrorBoundary>
        )
        : <Empty description="No spot candles for this day." />}
    </>
  )

  return (
    // Deliberately wider than every other page's own 1280 (see shared.jsx/App.jsx/etc.) - this is
    // the one page in the app carrying a chart, an OI/IV ladder, a whole-band liquidity table AND a
    // futures chart at once, all genuinely useful wider (more candles visible, more of the ladder's
    // own numbers readable without scrolling) rather than sitting centered in a narrow column with
    // large empty margins either side on any normal desktop monitor - the user's own "I see a lot of
    // space on left and right, it should fit, we can show a lot of thing in left and right". Raised
    // again to 2600 for the user's own "width more than 2500 trading monitor" - three chart columns
    // (Spot + Entry chart B + Entry chart C) side by side need real width each to stay readable, not
    // just technically fit.
    <div className="oi-mobile-page" style={{ maxWidth: 2600, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>

        <Card size="small" title="OI Replay">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Plays a trading day back candle by candle, with the nearest-expiry OI/IV ladder across the whole
              strike band alongside it. NIFTY/BANKNIFTY prefer your NiftyDataCollector database, falling back to a
              live Dhan call when it's stale or unconfigured; SENSEX and futures always call Dhan live - there is no
              stored source for either.
            </Text>
            <Space wrap size={12}>
              <Button
                type="primary" onClick={goLiveAndAnnounce} loading={loading} disabled={!underlying}
                style={isLive ? { background: UP_COLOR, borderColor: UP_COLOR } : undefined}
              >
                ● {isLive ? 'Live' : 'Go Live'}
              </Button>
              {isLive && (
                // The REAL SignalR connection state, not just "today is selected" - the button above
                // says "Live" purely from a date match, which used to give false confidence that
                // ticks were flowing even when this connection had failed, was stuck reconnecting, or
                // had given up after withAutomaticReconnect's own retries ran out. This is the one
                // place on the page that tells you whether data is ACTUALLY ticking right now.
                <Tag color={liveConnectionState === 'connected' ? 'success' : liveConnectionState === 'reconnecting' ? 'warning' : liveConnectionState === 'connecting' ? 'processing' : 'error'}>
                  {liveConnectionState === 'connected' ? '● Ticking live'
                    : liveConnectionState === 'reconnecting' ? '● Reconnecting…'
                      : liveConnectionState === 'connecting' ? '● Connecting…'
                        : '● Disconnected - not receiving live ticks'}
                </Tag>
              )}
              {isLive && liveConnectionState === 'connected' && <FeedLagTag delayMs={feedLag.delayMs} />}
              <Select
                value={underlying} onChange={selectUnderlying} style={{ width: 130 }}
                options={[{ value: 'NIFTY', label: 'NIFTY' }, { value: 'BANKNIFTY', label: 'BANKNIFTY' }, { value: 'SENSEX', label: 'SENSEX' }]}
              />
              {isLive ? (
                // Only meaningful once today is playing live - lists the real currently-listed
                // expiries (see resolvedExpiries' own doc comment) instead of an ambiguous Weekly/
                // Monthly toggle, so the exact contract being tracked is never in doubt.
                <Select
                  value={liveExpiryFlag} onChange={setLiveExpiryFlag} style={{ width: 220 }}
                  options={resolvedExpiries.expiries.map((d, i) => {
                    const tag = d === resolvedExpiries.week ? ' (Weekly)' : d === resolvedExpiries.month ? ' (Monthly)' : ''
                    return { value: `N${i + 1}`, label: `${fmtDateOnly(d)}${tag}` }
                  })}
                  placeholder="Loading expiries…"
                />
              ) : (
                <Select
                  value={expiryFlag} onChange={setExpiryFlag} style={{ width: 130 }}
                  options={[{ value: 'WEEK', label: 'Weekly', disabled: underlying === 'BANKNIFTY' }, { value: 'MONTH', label: 'Monthly' }]}
                />
              )}
              <DatePicker value={date} onChange={pickDate} format="DD MMM YYYY" placeholder="Trading day" />
              <Select value={timeframe} onChange={setTimeframe} style={{ width: 110 }} options={TIMEFRAME_OPTIONS} />
              <Tooltip title={isTodayDate ? "Replays today's session so far with the Start/Pause/slider - use Go Live to follow it live again" : undefined}>
                <Button type="primary" onClick={loadDayAndAnnounce} loading={loading} disabled={!canLoad}>Load day</Button>
              </Tooltip>
              {isTodayDate && !isLive && oneMinBars.length > 0 && (
                <Tag color="blue">Replaying today up to {istTimeFormatter(oneMinBars.at(-1).time)} - Load day again for the latest</Tag>
              )}
              <Tooltip title={isLive ? 'Session VWAP on the spot, EMA and futures charts.' : 'Session VWAP on the futures chart (its bars carry volume). The spot VWAP comes from the live feed - today only.'}>
                <Checkbox checked={showVwap} onChange={(e) => setShowVwap(e.target.checked)}>VWAP</Checkbox>
              </Tooltip>
              <Checkbox checked={showVolumeProfile} onChange={(e) => setShowVolumeProfile(e.target.checked)}>Volume Profile</Checkbox>
              {/* Sync with the Order Flow page in another tab - the day always; the replay clock while replaying. */}
              {syncControl}
              {isLive && (
                // Today's own run + live ticks are kept in this browser (see LIVE_DAY_CACHE_STORAGE_KEY's
                // own doc comment) so a reload doesn't have to re-fetch - this is the one way to force a
                // genuine re-fetch instead, for whenever the cached data looks wrong/stale. Popconfirm
                // rather than a bare click - clearing re-triggers a real Dhan-touching fetch right away,
                // not just a no-op reset, so an accidental click deserves one more step before it fires.
                <Popconfirm
                  title="Clear cached data and refetch?"
                  description="Removes today's cached run and live ticks from this browser, then re-fetches fresh from the server right now."
                  onConfirm={handleClearLiveCache}
                  okText="Clear & refetch"
                >
                  <Button danger>Clear cache</Button>
                </Popconfirm>
              )}
            </Space>
            <Space align="center" size={12} wrap>
              <Text type="secondary" style={{ fontSize: 12 }}>Sections shown</Text>
              <Select
                mode="multiple" value={visibleSections} onChange={setVisibleSections}
                style={{ minWidth: 'min(420px, 100%)', maxWidth: 900 }} maxTagCount={SECTION_OPTIONS.length}
                options={SECTION_OPTIONS}
              />
              <Button size="small" onClick={() => setVisibleSections(ALL_SECTION_VALUES)} disabled={visibleSections.length === ALL_SECTION_VALUES.length}>
                Show all
              </Button>
            </Space>
            {isLive && liveExpiryFlag !== 'N1' && (
              <Alert
                type="info" showIcon
                message="This expiry isn't the nearest one - its CE/PE data has no since-open history yet (Dhan's historical endpoint only reliably covers the nearest weekly/monthly), so it'll build up from live ticks starting now rather than showing the whole day. Click Load day/Go Live again after picking it if you haven't already."
              />
            )}
            {isLive && liveConnectionState === 'disconnected' && (
              <Alert
                type="error" showIcon
                message="Not receiving live ticks right now - the page will look frozen at whatever it last loaded until this reconnects. Check the browser console for a SignalR connection error, and confirm the backend's own Dhan market-feed connection is up."
              />
            )}
            {feedStalled && (
              <Alert
                type="warning" showIcon
                message={`Connected, but no live tick for ${underlying} in over ${Math.round((nowTick - lastTickAtMs) / 60_000)} min - the connection itself is fine, but the server's own Dhan feed may have stalled. Logged to the browser console; try reloading if this doesn't clear on its own.`}
              />
            )}
            {isLive && liveConnectionState === 'connected' && spotSilentMs > 0 && (
              <Alert
                type="warning" showIcon
                message={`${underlying} spot hasn't ticked for ${Math.round(spotSilentMs / 1000)}s during market hours - the spot chart is not live right now even though option ticks may still be arriving. The server re-subscribes a silent spot feed after 10s on its own (and restarts its stream after 30s).`}
              />
            )}
            {isLive && liveConnectionState === 'connected' && <FeedLagAlert delayMs={feedLag.delayMs} sourceDelayMs={feedLag.sourceDelayMs} />}
            {error && <Alert type="error" showIcon closable onClose={() => setError(null)} message={error} />}
          </Space>
        </Card>

        {result && (
          <>
            {visibleSections.includes('topStats') && (
              <LiveSection version={sectionVersion}>
              <Card size="small" title={<Space size={4}><CardDragHandle {...dragHandleProps('topStats')} />Snapshot</Space>} {...orderedDropProps('topStats')}>
                <Row gutter={24}>
                  <Col><Statistic title="Spot" value={currentBar?.close ?? '—'} precision={2} /></Col>
                  <Col><Statistic title="ATM" value={atmStrike ?? '—'} /></Col>
                  <Col><Statistic title="PCR (PE OI / CE OI)" value={pcr != null ? pcr : '—'} precision={2}
                    valueStyle={{ color: pcr == null ? undefined : pcr > 1 ? UP_COLOR : DOWN_COLOR }} /></Col>
                  <Col><Statistic title="Max Pain" value={maxPain ?? '—'} /></Col>
                  <Col><Statistic title="Total CE OI (M)" value={formatOiMillions(totalCeOi, { withUnit: false })} valueStyle={{ color: DOWN_COLOR }} /></Col>
                  <Col><Statistic title="Total PE OI (M)" value={formatOiMillions(totalPeOi, { withUnit: false })} valueStyle={{ color: UP_COLOR }} /></Col>
                </Row>
              </Card>
              </LiveSection>
            )}

            {visibleSections.includes('marketRead') && marketRead && (
              <LiveSection version={sectionVersion}>
              <Card size="small" title={<Space size={4}><CardDragHandle {...dragHandleProps('marketRead')} />Market Read</Space>} {...orderedDropProps('marketRead')}>
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Alert
                    type={marketRead.safetyOk ? 'success' : 'warning'}
                    showIcon
                    message={marketRead.safetyOk ? 'Are we okay right now? Yes - clear of major walls.' : 'Are we okay right now? Caution - sitting right at a wall.'}
                    description={marketRead.safetyReason}
                  />
                  <Row gutter={[24, 16]}>
                    <Col xs={24} md={8}>
                      <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>PCR read</Text>
                      <Tag color={biasColor(marketRead.pcrBias)} style={{ fontSize: 12 }}>{marketRead.pcrBias}</Tag>
                    </Col>
                    <Col xs={24} md={8}>
                      <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>OI buildup (near ATM)</Text>
                      <Tag color={biasColor(marketRead.oiBias)} style={{ fontSize: 12 }}>{marketRead.oiBias}</Tag>
                      <div style={{ fontSize: 11, color: AXIS_COLOR, marginTop: 2 }}>{marketRead.oiBuildup}</div>
                    </Col>
                    <Col xs={24} md={8}>
                      <Tooltip title={
                        <span>
                          Real use case: at 9:20am, say CE and PE at ATM both show IV 12% (skew 0). By 11am,
                          price hasn't moved much but PE IV has climbed to 14% while CE stays near 12%
                          (skew widened to +2). That means traders are actively bidding up PUT premiums -
                          buying downside protection or outright puts - even though price itself looks calm.
                          That is often an early warning of a selloff building BEFORE it shows in price. If
                          the widening continues, expect more downside volatility soon; if it reverses and
                          narrows back, the fear is fading and price is more likely to hold or rally.
                        </span>
                      }>
                        <Text type="secondary" style={{ fontSize: 11, display: 'block', textDecoration: 'underline dotted' }}>
                          IV skew trend (PE − CE, at ATM)
                        </Text>
                      </Tooltip>
                      <Tag color={biasColor(marketRead.ivBias)} style={{ fontSize: 12 }}>{marketRead.ivBias}</Tag>
                      <div style={{ fontSize: 11, color: AXIS_COLOR, marginTop: 2 }}>
                        {marketRead.skew != null
                          ? `Now ${marketRead.skew >= 0 ? '+' : ''}${marketRead.skew.toFixed(1)} (CE ${marketRead.atmCeIv?.toFixed(1)}, PE ${marketRead.atmPeIv?.toFixed(1)})${marketRead.skewChange != null ? `, ${marketRead.skewChange >= 0 ? 'widened' : 'narrowed'} ${Math.abs(marketRead.skewChange).toFixed(1)} since open` : ''}`
                          : 'IV not available at ATM yet'}
                      </div>
                    </Col>
                  </Row>
                  <Alert
                    type={marketRead.overall === 'Bullish' ? 'success' : marketRead.overall === 'Bearish' ? 'error' : 'info'}
                    showIcon
                    message={`Overall bias: ${marketRead.overall}`}
                    description={
                      marketRead.overall === 'Mixed / Neutral'
                        ? 'PCR, OI buildup and IV skew trend don’t agree right now - no clean directional edge to act on.'
                        : `Buy: ${marketRead.buyStrike} ${marketRead.buySide}. Sell: ${marketRead.sellStrike ?? '—'} ${marketRead.sellSide} (the wall on the side this move isn't expected to reach).`
                    }
                  />
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    Heuristic reading of the same PCR/OI/IV numbers shown above - three independent, naively-thresholded votes, not a signal or advice. Always cross-check against price action itself. IV skew is read as a CHANGE since the open, not its raw level - index options almost always price puts richer than calls (a permanent structural premium, not a daily sentiment signal), so only the trend is informative.
                  </Text>
                </Space>
              </Card>
              </LiveSection>
            )}

            {visibleSections.includes('dayOi') && dayOiSummary && (
              <LiveSection version={sectionVersion}>
              <Card size="small" title={<Space size={4}><CardDragHandle {...dragHandleProps('dayOi')} />Day OI Accumulation (since today's open)</Space>} {...orderedDropProps('dayOi')}>
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Alert
                    type={dayOiSummary.dayBias === 'Bullish' ? 'success' : dayOiSummary.dayBias === 'Bearish' ? 'error' : 'info'}
                    showIcon
                    message={`Day so far: ${dayOiSummary.dayBias}`}
                    description={dayOiSummary.dayReason}
                  />
                  <Row gutter={[24, 16]}>
                    <Col xs={12} md={6}>
                      <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>CE OI since open</Text>
                      <Text style={{ fontSize: 13, color: dayOiSummary.ceDayChange >= 0 ? DOWN_COLOR : UP_COLOR }}>
                        {formatOiMillions(dayOiSummary.ceDayChange, { signed: true })}
                      </Text>
                    </Col>
                    <Col xs={12} md={6}>
                      <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>PE OI since open</Text>
                      <Text style={{ fontSize: 13, color: dayOiSummary.peDayChange >= 0 ? UP_COLOR : DOWN_COLOR }}>
                        {formatOiMillions(dayOiSummary.peDayChange, { signed: true })}
                      </Text>
                    </Col>
                    <Col xs={12} md={6}>
                      <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>Top 2 OI added</Text>
                      {dayOiSummary.added.length === 0
                        ? <Text style={{ fontSize: 11, color: AXIS_COLOR }}>None yet</Text>
                        : dayOiSummary.added.map((m) => (
                          <div key={`${m.strike}-${m.side}`} style={{ fontSize: 11 }}>
                            <Tag color={m.side === 'CE' ? 'error' : 'success'} style={{ fontSize: 10, marginRight: 4 }}>{m.side}</Tag>
                            {m.strike} <span style={{ color: m.side === 'CE' ? DOWN_COLOR : UP_COLOR }}>{formatOiMillions(m.change, { signed: true })}</span>
                          </div>
                        ))}
                    </Col>
                    <Col xs={12} md={6}>
                      <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>Top 2 OI removed</Text>
                      {dayOiSummary.removed.length === 0
                        ? <Text style={{ fontSize: 11, color: AXIS_COLOR }}>None yet</Text>
                        : dayOiSummary.removed.map((m) => (
                          <div key={`${m.strike}-${m.side}`} style={{ fontSize: 11 }}>
                            <Tag color={m.side === 'CE' ? 'error' : 'success'} style={{ fontSize: 10, marginRight: 4 }}>{m.side}</Tag>
                            {m.strike} <span style={{ color: m.side === 'CE' ? UP_COLOR : DOWN_COLOR }}>{formatOiMillions(m.change, { signed: true })}</span>
                          </div>
                        ))}
                    </Col>
                  </Row>
                  <div>
                    <Space align="center" size={12} wrap style={{ marginBottom: 8 }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>Total OI lookback</Text>
                      <Select
                        value={totalOiLookbackTimeframe} onChange={setTotalOiLookbackTimeframe} size="small" style={{ width: 100 }}
                        options={TOTAL_OI_LOOKBACK_TIMEFRAME_OPTIONS}
                      />
                      <Select
                        mode="tags" size="small" value={totalOiLookbackBars.map(String)}
                        onChange={(vals) => {
                          const parsed = [...new Set(vals.map((v) => parseInt(v, 10)).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b)
                          setTotalOiLookbackBars(parsed.length > 0 ? parsed : DEFAULT_TOTAL_OI_LOOKBACK_BARS)
                        }}
                        style={{ minWidth: 180 }}
                        options={TOTAL_OI_LOOKBACK_BAR_OPTIONS.map((n) => ({ value: String(n), label: `${n} bars` }))}
                      />
                    </Space>
                    <Table
                      size="small"
                      pagination={false}
                      dataSource={totalOiLookbackRows}
                      locale={{ emptyText: 'No OI data yet today.' }}
                      scroll={{ x: 420 }}
                      columns={[
                        { title: 'Lookback', dataIndex: 'bars', key: 'bars', render: (b) => `${b} bars ago` },
                        { title: 'Total CE OI Δ', dataIndex: 'ceDelta', key: 'ceDelta', render: renderOiLookbackDelta },
                        { title: 'CE %', dataIndex: 'cePercent', key: 'cePercent', render: renderOiLookbackPercent },
                        { title: 'Total PE OI Δ', dataIndex: 'peDelta', key: 'peDelta', render: renderOiLookbackDelta },
                        { title: 'PE %', dataIndex: 'pePercent', key: 'pePercent', render: renderOiLookbackPercent },
                      ]}
                    />
                  </div>
                  {/* Whole-chain counterpart to the per-strike drill-down's own charts - a switch, not
                      stacked, since the numbers right above already give the current since-open
                      figure; this chart's own job is showing how it got there. */}
                  <div>
                    <Space align="center" size={12} wrap style={{ marginBottom: 8 }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>Chain-wide OI</Text>
                      <Segmented
                        size="small"
                        value={dayOiChartMode}
                        onChange={setDayOiChartMode}
                        options={[{ label: 'Total OI', value: 'total' }, { label: 'Since open Δ', value: 'sinceOpen' }]}
                      />
                      <Text style={{ color: DOWN_COLOR }}>● CE</Text>
                      <Text style={{ color: UP_COLOR }}>● PE</Text>
                    </Space>
                    <ChartErrorBoundary key={`day-oi-${dayOiChartMode}-${underlying}-${result?.date}`}>
                      <StrikeOiDrilldownChart
                        ceSeries={dayOiChartMode === 'total' ? ceTotalOiLine : ceTotalSinceOpenLine}
                        peSeries={dayOiChartMode === 'total' ? peTotalOiLine : peTotalSinceOpenLine}
                        mode={dayOiChartMode}
                        dayKey={`day-oi-${dayOiChartMode}-${underlying}-${result?.date}-${timeframe}`}
                        height={220}
                      />
                    </ChartErrorBoundary>
                  </div>
                </Space>
              </Card>
              </LiveSection>
            )}

            {visibleSections.includes('oiHeatmap') && (
              <LiveSection version={sectionVersion}>
              <Card size="small" title={<Space size={4}><CardDragHandle {...dragHandleProps('oiHeatmap')} />OI change heatmap (all strikes)</Space>} {...orderedDropProps('oiHeatmap')}>
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Every tracked strike's own OI change, bucketed to the timeframe below - color intensity is how much changed
                    (relative to this side's own typical large move today, so one outsized burst doesn't wash everything else
                    out), not an absolute scale, so a quiet day and a violent one both use the full range. Newest minute on
                    the left; while live, the outlined column is the one filling right now. Hover a cell for the exact number. Scroll
                    right for earlier in the day. Blue/orange here, not green/red - the chart's own R/S wall lines already use green/red for a
                    different meaning (which side, how heavy), so this uses its own separate color language for "added vs
                    removed."
                  </Text>
                  <Space size={16} wrap>
                    <Text style={{ color: OI_ADDED_COLOR }}>■ OI added</Text>
                    <Text style={{ color: OI_REMOVED_COLOR }}>■ OI removed</Text>
                    {isLive && (
                      <Tooltip title="When Dhan last reported a changed open interest on any tracked strike. Prices tick constantly; OI only moves when positions are opened or closed, so a column can sit empty for a while in a quiet market.">
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          OI last changed: {lastOiChangeMs ? `${istTimeWithSecondsFormatter(toChartTime(lastOiChangeMs))} (${Math.max(0, Math.round((nowTick - lastOiChangeMs) / 1000))}s ago)` : 'no live change yet'}
                        </Text>
                      </Tooltip>
                    )}
                    <Space size={4}>
                      <Text type="secondary" style={{ fontSize: 12 }}>Bucket</Text>
                      <Select
                        value={heatmapTimeframeMinutes} onChange={setHeatmapTimeframeMinutes} size="small" style={{ width: 90 }}
                        options={HEATMAP_TIMEFRAME_OPTIONS}
                      />
                    </Space>
                  </Space>
                  <div>
                    <Text strong style={{ fontSize: 12 }}>CE</Text>
                    <OiChangeHeatmapPlot label="CE" byStrike={ceByStrike} strikes={heatmapStrikes} atmStrike={atmStrike} asOfMs={asOfMs} timeframeMinutes={heatmapTimeframeMinutes} live={isLive} />
                  </div>
                  <div>
                    <Text strong style={{ fontSize: 12 }}>PE</Text>
                    <OiChangeHeatmapPlot label="PE" byStrike={peByStrike} strikes={heatmapStrikes} atmStrike={atmStrike} asOfMs={asOfMs} timeframeMinutes={heatmapTimeframeMinutes} live={isLive} />
                  </div>
                  <div>
                    <Tooltip title="Whole band summed per bucket. Δ = OI added (blue) or removed (orange) in that bucket; cumulative = running total since the first bucket. Net = CE − PE: blue means CE OI grew more than PE (call-heavy), orange means PE grew more (put-heavy).">
                      <Text strong style={{ fontSize: 12 }}>Totals: CE, PE and Net (CE − PE) — Δ and cumulative Δ</Text>
                    </Tooltip>
                    <OiTotalsHeatmap ceByStrike={ceByStrike} peByStrike={peByStrike} strikes={heatmapStrikes} asOfMs={asOfMs} timeframeMinutes={heatmapTimeframeMinutes} live={isLive} />
                  </div>
                </Space>
              </Card>
              </LiveSection>
            )}

            <LiveSection version={sectionVersion}>
            <div {...orderedDropProps('spotAndEntry')}>
              <Space size={4} style={{ marginBottom: 4 }}>
                <CardDragHandle {...dragHandleProps('spotAndEntry')} />
                <Text type="secondary" style={{ fontSize: 12 }}>Spot &amp; entry charts</Text>
              </Space>
              <Row gutter={[16, 16]}>
                <Col xs={24} md={visibleSections.includes('entryCharts') ? 8 : 24}>
                  <Card
                    size="small" title="Spot (replaying)"
                    extra={!spotFloating && (
                      <Tooltip title="Pop the whole spot chart out into a panel you can drag anywhere - e.g. next to the heatmap">
                        <Button size="small" icon={<ExportOutlined />} onClick={() => setSpotFloating(true)}>Float</Button>
                      </Tooltip>
                    )}
                  >
                  {spotFloating ? (
                    <Space direction="vertical" size={8} style={{ width: '100%', padding: '24px 0' }} align="center">
                      <Text type="secondary">The spot chart is in its own floating panel.</Text>
                      <Button size="small" onClick={() => setSpotFloating(false)}>Dock it back here</Button>
                    </Space>
                  ) : spotCardContent}
                </Card>
              </Col>
              {/* The user's own "width more than 2500... adjust all 3 charts in same row" ask - on a
                  wide enough monitor, the main chart and both fast-entry charts sit side by side in
                  ONE row instead of the main chart's own row plus a second row underneath. The OI/IV
                  ladder moves to its own full-width row below (see maxWidth's own doc comment on the
                  page container this depends on) rather than squeezing a 4th column in here - a
                  table full of numbers benefits from the extra width just as much as a chart does. */}
              {visibleSections.includes('entryCharts') && (
                <>
                  <Col xs={24} md={8}>
                    <Card
                      size="small"
                      title={`Entry chart B (independent timeframe + EMA) · ATM ${atmStrike ?? ''} OI Δ`}
                      extra={
                        <Select
                          value={oiLookbackBars} onChange={setOiLookbackBars} size="small" style={{ width: 110 }}
                          options={OI_LOOKBACK_N_OPTIONS.map((n) => ({ value: n, label: `${n} bars` }))}
                        />
                      }
                    >
                      {oneMinBars.length > 0
                        ? (
                          <div style={{ position: 'relative' }}>
                            <ChartErrorBoundary key={`emaB-${underlying}-${result.date}-${chartBTimeframe}`}>
                              <EmaChart
                                oneMinBars={oneMinBars}
                                visibleCount={visibleCount}
                                timeframe={chartBTimeframe} onTimeframeChange={setChartBTimeframe}
                                ema1Period={chartBEma1} onEma1PeriodChange={setChartBEma1}
                                ema2Period={chartBEma2} onEma2PeriodChange={setChartBEma2}
                                dayKey={`emaB-${underlying}-${result.date}`}
                                vwapSeries={vwapSeries} showVwap={showVwap}
                                height={560}
                                volumeProfile={volumeProfile} showVolumeProfile={showVolumeProfile}
                              />
                            </ChartErrorBoundary>
                            {atmStrike != null && (
                              <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', flexDirection: 'column', gap: 4, pointerEvents: 'none' }}>
                                <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: '#00000080', color: ceOiLookback.delta > 0 ? '#3ddc84' : ceOiLookback.delta < 0 ? '#ff5c5c' : AXIS_COLOR, border: `1px solid ${AXIS_COLOR}` }}>
                                  CE OI ({oiLookbackBars}×{chartBTimeframe}m) {fmtOiDelta(ceOiLookback.delta)}
                                </span>
                                <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: '#00000080', color: peOiLookback.delta > 0 ? '#3ddc84' : peOiLookback.delta < 0 ? '#ff5c5c' : AXIS_COLOR, border: `1px solid ${AXIS_COLOR}` }}>
                                  PE OI ({oiLookbackBars}×{chartBTimeframe}m) {fmtOiDelta(peOiLookback.delta)}
                                </span>
                              </div>
                            )}
                          </div>
                        )
                        : <Empty description="No spot candles for this day." />}
                    </Card>
                  </Col>
                  <Col xs={24} md={8}>
                    <Card size="small" title="Entry chart C (independent timeframe + EMA)">
                      {oneMinBars.length > 0
                        ? (
                          <ChartErrorBoundary key={`emaC-${underlying}-${result.date}-${chartCTimeframe}`}>
                            <EmaChart
                              oneMinBars={oneMinBars}
                              visibleCount={visibleCount}
                              timeframe={chartCTimeframe} onTimeframeChange={setChartCTimeframe}
                              ema1Period={chartCEma1} onEma1PeriodChange={setChartCEma1}
                              ema2Period={chartCEma2} onEma2PeriodChange={setChartCEma2}
                              dayKey={`emaC-${underlying}-${result.date}`}
                              vwapSeries={vwapSeries} showVwap={showVwap}
                              height={560}
                              volumeProfile={volumeProfile} showVolumeProfile={showVolumeProfile}
                            />
                          </ChartErrorBoundary>
                        )
                        : <Empty description="No spot candles for this day." />}
                    </Card>
                  </Col>
                </>
              )}
              </Row>
            </div>
            </LiveSection>

            {visibleSections.includes('optionPremium') && (
              <LiveSection version={sectionVersion}>
              <Row gutter={[16, 16]} style={{ marginTop: 16 }} {...orderedDropProps('optionPremium')}>
                <Col span={24} style={{ marginBottom: 8 }}>
                  <Space size={12} wrap>
                    <CardDragHandle {...dragHandleProps('optionPremium')} />
                    {/* Both legs at the same moneyness: 2 ITM is CE ATM-2 and PE ATM+2. */}
                    <Text type="secondary" style={{ fontSize: 12 }}>Both CE &amp; PE</Text>
                    <StrikePicker
                      atmStrike={atmStrike} step={step} side="CE" size="small" showStrike={false}
                      offset={cePremiumOffset === -pePremiumOffset ? cePremiumOffset : 0}
                      onChange={(v) => { setCePremiumOffset(v); setPePremiumOffset(-v) }}
                    />
                    {cePremiumOffset !== -pePremiumOffset && <Tag>Mixed</Tag>}
                  </Space>
                </Col>
                <Col xs={24} md={12}>
                  <Card
                    size="small"
                    title={`CE premium ${cePremiumStrike ?? ''} ${moneynessLabel(cePremiumOffset, 'CE')}`}
                    extra={<StrikePicker atmStrike={atmStrike} step={step} side="CE" size="small" showStrike={false} offset={cePremiumOffset} onChange={setCePremiumOffset} />}
                  >
                    {oneMinBars.length === 0
                      ? <Empty description="No spot candles for this day." />
                      : !cePremiumRevealed
                        ? <Empty description={`No CE ${cePremiumStrike ?? ''} premium data yet today.`} />
                        : (
                          <ChartErrorBoundary key={`premium-ce-${underlying}-${result.date}-${cePremiumOffset}`}>
                            <PremiumEmaChart
                              points={cePremiumPoints} asOfMs={asOfMs}
                              timeframe={cePremiumTimeframe} onTimeframeChange={setCePremiumTimeframe}
                              ema1Period={cePremiumEma1} onEma1PeriodChange={setCePremiumEma1}
                              ema2Period={cePremiumEma2} onEma2PeriodChange={setCePremiumEma2}
                              dayKey={`premium-ce-${underlying}-${result.date}-${cePremiumOffset}`}
                              showVwap={showVwap}
                              height={320}
                            />
                          </ChartErrorBoundary>
                        )}
                  </Card>
                </Col>
                <Col xs={24} md={12}>
                  <Card
                    size="small"
                    title={`PE premium ${pePremiumStrike ?? ''} ${moneynessLabel(pePremiumOffset, 'PE')}`}
                    extra={<StrikePicker atmStrike={atmStrike} step={step} side="PE" size="small" showStrike={false} offset={pePremiumOffset} onChange={setPePremiumOffset} />}
                  >
                    {oneMinBars.length === 0
                      ? <Empty description="No spot candles for this day." />
                      : !pePremiumRevealed
                        ? <Empty description={`No PE ${pePremiumStrike ?? ''} premium data yet today.`} />
                        : (
                          <ChartErrorBoundary key={`premium-pe-${underlying}-${result.date}-${pePremiumOffset}`}>
                            <PremiumEmaChart
                              points={pePremiumPoints} asOfMs={asOfMs}
                              timeframe={pePremiumTimeframe} onTimeframeChange={setPePremiumTimeframe}
                              ema1Period={pePremiumEma1} onEma1PeriodChange={setPePremiumEma1}
                              ema2Period={pePremiumEma2} onEma2PeriodChange={setPePremiumEma2}
                              dayKey={`premium-pe-${underlying}-${result.date}-${pePremiumOffset}`}
                              showVwap={showVwap}
                              height={320}
                            />
                          </ChartErrorBoundary>
                        )}
                  </Card>
                </Col>
              </Row>
              </LiveSection>
            )}

            <Row gutter={16} style={{ marginTop: 16 }} {...orderedDropProps('ladder')}>
              <Col span={24}>
                <Card
                  size="small"
                  title={<Space size={4}><CardDragHandle {...dragHandleProps('ladder')} />OI / IV ladder (nearest expiry, as of the current candle)</Space>}
                  bodyStyle={{ maxHeight: 460, overflowY: 'auto' }}
                >
                  <OiLadder rows={ladderRows} atmStrike={atmStrike} sudden={suddenWalls} />
                </Card>
              </Col>
            </Row>

            {visibleSections.includes('liquidityMap') && (
              <LiveSection version={sectionVersion}>
              <Row gutter={16} style={{ marginTop: 16 }} {...orderedDropProps('liquidityMap')}>
                <Col span={24}>
                  <Card size="small" title={<Space size={4}><CardDragHandle {...dragHandleProps('liquidityMap')} />Liquidity map (imbalance &amp; likely levels, whole band)</Space>}>
                    <LiquidityMapTable rows={ladderRows} atmStrike={atmStrike} currentPrice={currentBar?.close} sudden={suddenWalls} />
                  </Card>
                </Col>
              </Row>
              </LiveSection>
            )}

            {visibleSections.includes('futures') && (
              <LiveSection version={sectionVersion}>
              <Row gutter={16} style={{ marginTop: 16 }} {...orderedDropProps('futures')}>
                <Col span={24}>
                  <Card
                    size="small"
                    title={<Space size={4}><CardDragHandle {...dragHandleProps('futures')} />Futures (nearest listed contract - always live from Dhan, never stored)</Space>}
                    extra={
                      <Space size={8} wrap>
                        <Tooltip title="Depth of market: the futures' full 200-level book in a side panel">
                          <Button size="small" onClick={() => setDomOpen(true)}>DOM</Button>
                        </Tooltip>
                        <Select value={futuresTimeframe} onChange={setFuturesTimeframe} size="small" style={{ width: 90 }} options={TIMEFRAME_OPTIONS} />
                        <Tooltip title="Delta (buy - sell volume) per candle and cumulative delta under the candles - exact for a day the order flow server saw live, else estimated from 1-minute candles">
                          <Space size={4}><Switch size="small" checked={futuresDeltaOn} onChange={setFuturesDeltaOn} /><Text style={{ fontSize: 12 }}>Δ / ΣΔ</Text></Space>
                        </Tooltip>
                        <Tooltip title={`Volume profile of the session so far (${futuresProfileRow}-pt rows) with POC and the 70% value area (VAH/VAL)`}>
                          <Space size={4}><Switch size="small" checked={futuresProfileOn} onChange={setFuturesProfileOn} /><Text style={{ fontSize: 12 }}>Profile</Text></Space>
                        </Tooltip>
                        {futuresRegimeSinceOpen && futuresRegimeSinceOpen.regime !== 'Neutral' && (
                          <Tag color={futuresRegimeSinceOpen.bias === 'Bullish' ? 'success' : 'error'}>{futuresRegimeSinceOpen.regime}</Tag>
                        )}
                        {result.futuresExpiry ? <Tag>{result.futuresExpiry} expiry</Tag> : null}
                      </Space>
                    }
                  >
                    {result.futuresError && (
                      <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={result.futuresError} />
                    )}
                    {!result.futuresOiAvailable && result.futuresBars?.length > 0 && (
                      <Alert type="info" showIcon style={{ marginBottom: 12 }}
                        message="Dhan did not return an Open Interest series for this futures contract - the OI figures and Long/Short read below are unavailable, not zero/neutral." />
                    )}
                    {displayFuturesBars.length > 0 ? (
                      <>
                        {futuresRegimeSinceOpen && (
                          <Alert
                            style={{ marginBottom: 12 }}
                            type={futuresRegimeSinceOpen.bias === 'Bullish' ? 'success' : futuresRegimeSinceOpen.bias === 'Bearish' ? 'error' : 'info'}
                            showIcon
                            message={`Since open: ${futuresRegimeSinceOpen.regime} (${futuresRegimeSinceOpen.bias})`}
                            description={`${futuresRegimeSinceOpen.blurb} Price ${futuresRegimeSinceOpen.priceDelta >= 0 ? '+' : ''}${futuresRegimeSinceOpen.priceDelta.toFixed(1)} pts, OI ${formatOiMillions(futuresRegimeSinceOpen.oiDelta, { signed: true })} since today's open.`}
                          />
                        )}
                        <Row gutter={24} style={{ marginBottom: 12 }}>
                          <Col>
                            <Statistic title="Futures LTP" value={currentFutures?.close ?? '—'} precision={currentFutures?.close != null ? 2 : undefined} />
                          </Col>
                          <Col>
                            <Statistic
                              title="Basis (Fut - Spot)"
                              value={futuresBasis != null ? `${futuresBasis >= 0 ? '+' : ''}${futuresBasis.toFixed(2)}` : '—'}
                              valueStyle={{ color: futuresBasis == null ? undefined : futuresBasis >= 0 ? UP_COLOR : DOWN_COLOR }}
                            />
                          </Col>
                          <Col>
                            <Statistic title="Futures OI (M)" value={result.futuresOiAvailable ? formatOiMillions(currentFutures?.openInterest, { withUnit: false }) : 'N/A'} />
                          </Col>
                          <Col>
                            <Statistic
                              title="OI since open"
                              value={result.futuresOiAvailable ? formatOiMillions(futuresOiSinceOpen, { signed: true }) : 'N/A'}
                              valueStyle={{ color: futuresOiSinceOpen == null ? undefined : futuresOiSinceOpen >= 0 ? UP_COLOR : DOWN_COLOR }}
                            />
                          </Col>
                          <Col>
                            <Statistic title="Volume so far" value={futuresVolumeSoFar != null ? futuresVolumeSoFar.toLocaleString() : '—'} />
                          </Col>
                          <Col>
                            <Statistic
                              title="Regime (since open)"
                              value={result.futuresOiAvailable ? (futuresRegimeSinceOpen?.regime ?? '—') : 'N/A'}
                              valueStyle={{ fontSize: 16, color: futuresRegimeSinceOpen?.color }}
                            />
                          </Col>
                        </Row>
                        <ChartErrorBoundary key={`futures-${underlying}-${result.date}-${futuresTimeframe}`}>
                          <FuturesChart
                            bars={displayFuturesBars}
                            vwap={futuresVwap}
                            oiLine={futuresOiLine}
                            markers={futuresRegimeMarkers}
                            dayKey={`futures-${underlying}-${result.date}-${futuresTimeframe}`}
                            height={320}
                            profile={futuresProfile} profileRowSize={futuresProfileRow}
                            deltaBars={futuresDeltaBars}
                          />
                        </ChartErrorBoundary>
                        {futuresDeltaBars?.length > 0 && (
                          <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
                            Under the candles: delta per candle (green buying / red selling) and cumulative delta (yellow line, ΣΔ {futuresDeltaBars.at(-1).cvd >= 0 ? '+' : ''}{Math.round(futuresDeltaBars.at(-1).cvd).toLocaleString('en-IN')})
                            {futuresFlow?.source === 'estimated' ? ' - estimated from 1-minute candles (the order flow server did not see this day live)' : ' - from the live tick feed'}.
                          </Text>
                        )}
                        {futuresProfile?.poc != null && (
                          <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
                            Volume profile: POC {futuresProfile.poc + futuresProfileRow / 2} · value area {futuresProfile.val}–{futuresProfile.vah + futuresProfileRow} ·
                            {' '}each minute&apos;s volume is spread over its high-low range (a candle cannot say exactly where it traded - the Order Flow page has the exact profile).
                          </Text>
                        )}
                        {result.futuresOiAvailable && (
                          <Text type="secondary" style={{ fontSize: 11 }}>
                            Grey line (left axis) is Open Interest. Arrows mark where a Long Buildup/Short Buildup/Short Covering/Long Unwinding stretch began - green/up = bullish, red/down = bearish.
                          </Text>
                        )}
                      </>
                    ) : (
                      <Empty description={result.futuresError || 'No futures data for this day.'} />
                    )}
                  </Card>
                </Col>
              </Row>
              </LiveSection>
            )}
          </>
        )}

        {loading && (
          <Card size="small">
            <Alert
              type="info"
              showIcon
              message="Loading…"
              description={
                <Space direction="vertical" size={8}>
                  <Text>
                    Fetching each strike's OI/IV history directly from Dhan (no local cache is configured on this server) -
                    this can take up to 10-15 seconds for the full ATM±10 band, longer if Dhan itself is slow to respond right
                    now. Will cancel itself and show an error after {LOAD_TIMEOUT_MS / 1000}s if nothing comes back.
                  </Text>
                  <Button size="small" onClick={cancelLoad}>Cancel</Button>
                </Space>
              }
            />
          </Card>
        )}

        {!result && !loading && (
          <Card size="small">
            <Empty description="Pick a stored trading day and click Load day." />
          </Card>
        )}
      </Space>

      <Modal
        open={drilldownStrike != null}
        onCancel={() => setDrilldownStrike(null)}
        title={`${underlying} ${drilldownStrike?.toLocaleString() ?? ''} - OI history`}
        footer={null}
        width={760}
      >
        {drilldownCeTotal.length + drilldownPeTotal.length + drilldownCeChange.length + drilldownPeChange.length > 0 ? (
          <Space direction="vertical" size={20} style={{ width: '100%' }}>
            {/* Total OI (the level) stacked directly above its own per-minute change (the derivative) -
                shown together, not behind a tab switch, so a spike in the bottom chart can be read
                straight up against exactly where it left the top chart's own level - the "day change
                vs total" comparison this popup exists for. */}
            <div>
              <Space size={16} style={{ marginBottom: 4 }}>
                <Text strong style={{ fontSize: 12 }}>Total OI</Text>
                <Text style={{ color: DOWN_COLOR }}>● CE</Text>
                <Text style={{ color: UP_COLOR }}>● PE</Text>
              </Space>
              <ChartErrorBoundary key={`drilldown-total-${underlying}-${drilldownStrike}`}>
                <StrikeOiDrilldownChart
                  ceSeries={drilldownCeTotal}
                  peSeries={drilldownPeTotal}
                  mode="total"
                  dayKey={`drilldown-total-${underlying}-${result?.date}-${drilldownStrike}`}
                  height={220}
                />
              </ChartErrorBoundary>
            </div>
            <div>
              <Space size={16} wrap style={{ marginBottom: 4 }}>
                <Text strong style={{ fontSize: 12 }}>Per-minute change</Text>
                <Text type="secondary">CE on top, PE on bottom</Text>
                <Text style={{ color: OI_ADDED_COLOR }}>■ Added</Text>
                <Text style={{ color: OI_REMOVED_COLOR }}>■ Removed</Text>
              </Space>
              <ChartErrorBoundary key={`drilldown-change-${underlying}-${drilldownStrike}`}>
                <StrikeOiDrilldownChart
                  ceSeries={drilldownCeChange}
                  peSeries={drilldownPeChange}
                  mode="change"
                  dayKey={`drilldown-change-${underlying}-${result?.date}-${drilldownStrike}`}
                  height={220}
                />
              </ChartErrorBoundary>
            </div>
            {/* Same running-total idea as Total OI above, just re-based to start at zero (today's own
                open) instead of at the day's actual opening OI level - "how much has this ONE strike's
                own OI built up or unwound since the day started" as a continuous line, stacked below
                the other two for the same "read it straight up against the level/change" reason. */}
            <div>
              <Space size={16} style={{ marginBottom: 4 }}>
                <Text strong style={{ fontSize: 12 }}>Since open Δ</Text>
                <Text style={{ color: DOWN_COLOR }}>● CE</Text>
                <Text style={{ color: UP_COLOR }}>● PE</Text>
              </Space>
              <ChartErrorBoundary key={`drilldown-sinceopen-${underlying}-${drilldownStrike}`}>
                <StrikeOiDrilldownChart
                  ceSeries={drilldownCeSinceOpen}
                  peSeries={drilldownPeSinceOpen}
                  mode="sinceOpen"
                  dayKey={`drilldown-sinceopen-${underlying}-${result?.date}-${drilldownStrike}`}
                  height={220}
                />
              </ChartErrorBoundary>
            </div>
          </Space>
        ) : (
          <Empty description="No OI data yet for this strike." />
        )}
      </Modal>

      {/* Every floating panel lives here, outside the LiveSections: a section scrolled off-screen
          stops re-rendering (LiveSection), and a panel rendered from inside one froze with it - the
          floating spot chart while viewing the heatmap, Paper Trade's P&L, the replay clock. Each
          panel keeps its own open/position/size state, so opening or closing one never touches
          another. */}
      <DomDrawer open={domOpen} onClose={() => setDomOpen(false)} underlying={underlying} />
      {spotFloating && result && (
        <DraggableFloatingPanel
          title={`Spot - ${underlying}`} pos={spotPanelPos} onPosChange={setSpotPanelPos}
          size={spotPanelSize} onSizeChange={setSpotPanelSize}
          onClose={() => setSpotFloating(false)}
        >
          {spotCardContent}
        </DraggableFloatingPanel>
      )}
      {!isLive && replayControlsFloating && result && (
        <DraggableFloatingPanel
          title="Replay" pos={replayPanelPos} onPosChange={setReplayPanelPos}
          size={replayPanelSize} onSizeChange={setReplayPanelSize}
          onClose={() => setReplayControlsFloating(false)}
        >
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Space wrap size={8} align="center">{replayButtons}</Space>
            {replaySlider}
            <Text style={{ fontSize: 12 }}>
              {currentBar ? `${istTimeFormatter(currentBar.time)} (${visibleCount}/${oneMinBars.length})` : '—'}
            </Text>
          </Space>
        </DraggableFloatingPanel>
      )}
      {paperPanelOpen && (
        <DraggableFloatingPanel
          title={liveTradeActive ? 'Live trade - real orders' : 'Paper trade'} pos={paperPanelPos} onPosChange={setPaperPanelPos}
          size={paperPanelSize} onSizeChange={setPaperPanelSize}
          onClose={() => setPaperPanelOpen(false)}
        >
          <PaperTradePanel
            atmStrike={atmStrike} step={step}
            underlying={underlying} onUnderlyingChange={selectUnderlying}
            side={paperSide} onSideChange={setPaperSide}
            direction={paperDirection} onDirectionChange={setPaperDirection}
            strikeOffset={paperStrikeOffset} onStrikeOffsetChange={setPaperStrikeOffset}
            qtyLots={paperQtyLots} onQtyLotsChange={setPaperQtyLots}
            slPoints={paperSlPoints} onSlPointsChange={setPaperSlPoints}
            targetPoints={paperTargetPoints} onTargetPointsChange={setPaperTargetPoints}
            trailStart={paperTrailStart} onTrailStartChange={setPaperTrailStart} trailGap={paperTrailGap} onTrailGapChange={setPaperTrailGap}
            onPunch={handlePaperPunch} canPunch={atmStrike != null && paperEntryPreview?.price != null}
            positions={enrichedPaperPositions} onExit={handlePaperExit} onExitAll={handlePaperExitAll} onClearAll={handlePaperClearAll}
            mode={liveTradeActive ? 'live' : 'paper'} onModeChange={isAdmin ? handleTradeModeChange : null}
            liveAvailable={liveUnavailableReason == null} liveUnavailableReason={liveUnavailableReason}
            liveSlippage={liveSlippage} onLiveSlippageChange={setLiveSlippage}
            onLivePunch={handleLivePunch} canLivePunch={liveBlockReason == null}
            liveBlockReason={liveBlockReason}
            liveBusy={liveBusy} liveOrderSummary={liveOrderSummary}
            liveContent={(
              <LivePositionsView
                snapshot={livePositions} slippage={liveSlippage} busy={liveBusy}
                onClose={handleLiveClose} onProtect={handleLiveProtect} onPartialExit={handleLivePartialExit} onCancel={handleLiveCancel} onRefresh={handleLiveRefresh}
                onExitAll={handleLiveExitAll} onEmergencyExitAll={handleLiveEmergencyExitAll} onCancelAll={handleLiveCancelAll}
              />
            )}
          />
        </DraggableFloatingPanel>
      )}
    </div>
  )
}
