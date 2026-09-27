import { Component, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import dayjs from 'dayjs'
import { Select, Space, Typography, Card, Button, Statistic, Row, Col, DatePicker, Alert, Empty, Tooltip, Slider, Tag, InputNumber, Switch, Table, Segmented, Checkbox, Modal } from 'antd'
import { PlayCircleOutlined, PauseCircleOutlined, ReloadOutlined, SoundOutlined } from '@ant-design/icons'
import { createChart, createSeriesMarkers, CandlestickSeries, LineSeries, HistogramSeries, CrosshairMode } from 'lightweight-charts'
import * as signalR from '@microsoft/signalr'
import './oiMobile.css'
import {
  UP_COLOR, DOWN_COLOR, AXIS_COLOR, GRID_COLOR, BORDER_COLOR,
  istTimeFormatter, istTickMarkFormatter, toBar, toChartTime, fromChartTime, istDateKey,
  NavBar, TIMEFRAME_OPTIONS, STORED_UNDERLYING, STORED_TIMEFRAME, STORED_SHOW_VWAP, usePersistedState,
} from './shared.jsx'
import { PremiumEmaChart } from './oiShared.jsx'

const { Text, Title } = Typography

// A stable default for an optional array prop (ReplayChart/EmaChart's own vwapSeries) - a plain `[]`
// literal default is a NEW array every render, which would re-trigger any effect keyed on it even
// when the caller never actually passes one.
const EMPTY_ARRAY = []

// The (underlying, expiryFlag) combos OiReplayLiveFeedService actually tracks live on the backend -
// BANKNIFTY has no weekly expiry (same rule the rest of this page and Expired Backtest enforce), so
// a live feed for that combo will simply never arrive; kept in sync with that service's own list by
// hand since the two sides have no shared source of truth to derive it from automatically.
const LIVE_FEED_COMBOS = new Set(['NIFTY:WEEK', 'NIFTY:MONTH', 'BANKNIFTY:MONTH', 'SENSEX:WEEK', 'SENSEX:MONTH'])

// How long today's replay can go without ANY tick (spot, OI, or futures) before this page treats it
// as suspicious rather than trusting the "● LIVE" tag - that tag only reflects the browser's own
// SignalR connection to OUR server, never whether the SERVER's own upstream Dhan feed is actually
// flowing (see DhanMarketFeedClient's own stall detector for how THAT gets diagnosed, server-side,
// from logs this page cannot see). A silently stalled upstream feed would otherwise look identical,
// from here, to a page working correctly during a genuinely quiet market moment - the exact "are we
// not receiving live ticks from Dhan, flag us" gap the Live OI Dashboard already closes for itself
// but this page never did. Same threshold as that page's own identical FEED_STALL_WARNING_MS.
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
// three events: "spotUpdate" (SpotFeedHostedService's existing push - the underlying's own
// currently-forming 1-minute bar, reused as-is rather than building a second live-spot pipeline),
// "oiReplayTick" (OiReplayLiveFeedService's push - one option leg's live price/OI), and
// "futuresTick" (that same service's push for the underlying's own nearest futures contract - the
// user's own "make sure ALL functionality of this page should work [live]" ask: the Futures section
// used to be a one-time REST snapshot that never updated again until the next full reload). All
// callbacks are read through refs (same pattern as App.jsx's useHub) so the connection itself only
// needs to open/close when `enabled` changes, never when underlying/expiryFlag/the callbacks
// themselves change identity across a re-render.
function useOiReplayLiveFeed(enabled, onSpotUpdate, onOiReplayTick, onFuturesTick, onReconnected) {
  const spotRef = useRef(onSpotUpdate)
  const tickRef = useRef(onOiReplayTick)
  const futuresRef = useRef(onFuturesTick)
  const reconnectedRef = useRef(onReconnected)
  spotRef.current = onSpotUpdate
  tickRef.current = onOiReplayTick
  futuresRef.current = onFuturesTick
  reconnectedRef.current = onReconnected

  // The actual SignalR connection state, not just "isToday" - the page's own "Live" badge used to be
  // purely a date comparison, so it read "Live" (green) even when this connection had failed to
  // negotiate, was stuck reconnecting, or had given up entirely after withAutomaticReconnect's own
  // retry budget ran out - exactly the "everything is stuck but it still says Live" confusion the
  // user hit. 'connecting' while start() is in flight, 'connected' once it resolves (or after
  // onreconnected), 'reconnecting' while the client is retrying a dropped connection on its own,
  // 'disconnected' once onclose fires (retries exhausted, or the connection was never enabled).
  const [connectionState, setConnectionState] = useState('disconnected')

  useEffect(() => {
    if (!enabled) return
    setConnectionState('connecting')
    const connection = new signalR.HubConnectionBuilder()
      .withUrl('/hubs/spot')
      .withAutomaticReconnect(RECONNECT_RETRY_POLICY)
      .build()

    connection.on('spotUpdate', (snapshot) => spotRef.current(snapshot))
    connection.on('oiReplayTick', (tick) => tickRef.current(tick))
    connection.on('futuresTick', (tick) => futuresRef.current?.(tick))
    connection.onreconnecting(() => setConnectionState('reconnecting'))
    connection.onreconnected(() => { setConnectionState('connected'); reconnectedRef.current?.() })
    connection.onclose(() => setConnectionState('disconnected'))
    connection.start()
      .then(() => setConnectionState('connected'))
      .catch((err) => {
        // Same StrictMode double-mount as App.jsx's useHub - the first connection's start() gets
        // aborted by this effect's own cleanup before negotiation finishes on the second mount.
        if (err?.name === 'AbortError') return
        console.error('OI Replay live feed connection failed:', err)
        setConnectionState('disconnected')
      })

    return () => { connection.stop() }
  }, [enabled])

  // Derived rather than set from inside the effect's own !enabled branch - "disabled" isn't really a
  // connection STATE this hook transitions through, it's the absence of one, so it belongs here as a
  // plain fallback rather than as a setState a disabled render would otherwise redundantly re-fire.
  return enabled ? connectionState : 'disconnected'
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
  for (const list of byStrike.values()) list.sort((a, b) => new Date(a.time) - new Date(b.time))
  return byStrike
}

// The last point at or before asOfMs in a time-ascending list - null if the series hasn't started
// yet as of this point in the replay. Linear scan from the end: a real day's own per-strike series
// is at most a few hundred points, and this runs once per strike per tick, so this is nowhere near
// hot enough to need a binary search.
function latestAtOrBefore(sortedPoints, asOfMs) {
  for (let i = sortedPoints.length - 1; i >= 0; i--) {
    const t = new Date(sortedPoints[i].time).getTime()
    if (t <= asOfMs) return sortedPoints[i]
  }
  return null
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
// Table), mirroring the Live OI Dashboard's own identical helper.
function aggregateLinePoints(points, minutes) {
  if (minutes <= 1 || points.length === 0) return points
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

// The all-strikes counterpart to the single-strike drill-down's own change tab - "where, across the
// WHOLE tracked band, has OI actually been added or removed" at a glance, which reading one strike
// at a time can't give. Builds a strike x minute matrix for one side (CE or PE): each strike gets
// its own computeOiChangeSeries off its own 1-minute-bucketed level series, keyed by bucket time in
// a Map for O(1) lookup per cell. The column set is the UNION of every bucket ANY strike in the band
// has touched (not just the first strike's own), so a strike that only started ticking partway
// through the day still lines up against the correct real time rather than sliding left.
function buildOiChangeMatrix(byStrike, strikes) {
  const perStrikeChange = new Map()
  const bucketSet = new Set()
  for (const strike of strikes) {
    const total = aggregateLinePoints((byStrike.get(strike) ?? []).map((p) => ({ time: toChartTime(p.time), value: p.openInterest })), 1)
    const change = computeOiChangeSeries(total)
    perStrikeChange.set(strike, new Map(change.map((p) => [p.time, p.value])))
    for (const p of change) bucketSet.add(p.time)
  }
  return { buckets: [...bucketSet].sort((a, b) => a - b), perStrikeChange }
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
  return <Text style={{ color }}>{v > 0 ? '+' : ''}{v.toLocaleString()}</Text>
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

// ATM+-10 offset dropdown options, shared by anything that lets the user pick a strike RELATIVE to
// the currently-drifting ATM (PaperTradePanel's own strike selector, and the option premium
// chart's CE/PE strike pickers below) - an offset rather than an absolute strike, so "the default
// stays ATM" holds true all through the session even as ATM itself moves, matching
// PaperTradePanel's own original reasoning for the same choice.
function buildStrikeOffsetOptions(atmStrike, step) {
  if (atmStrike == null || !step) return []
  return Array.from({ length: 21 }, (_, i) => i - 10).map((offset) => ({
    value: offset,
    label: offset === 0 ? `ATM (${atmStrike})` : `ATM${offset > 0 ? '+' : ''}${offset} (${atmStrike + offset * step})`,
  }))
}

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
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      // A bigger fontSize than the page's other charts - the OI-wall price-line labels here carry
      // the strike, OI, IV and now separate Δ/S-R badges, all crammed against the right axis, and
      // the user's own "labels bit bigger, [I] can see it" ask was specifically about this chart.
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 13 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
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
    chart.subscribeClick((param) => {
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
      onStrikeClickRef.current?.(strike)
    })

    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
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

  // Fed only while checked, empty otherwise - see EmaChart's own identical effect for why VWAP is
  // shown at its own native cadence rather than re-aggregated to match this chart's timeframe.
  useEffect(() => {
    vwapSeriesRef.current?.setData(showVwap ? vwapSeries : EMPTY_ARRAY)
  }, [vwapSeries, showVwap])

  // Re-fit once when a brand new day/timeframe first loads (dayKey changes) - deliberately NOT on
  // every tick (bars itself is a fresh array reference every tick as the replay reveals/reaggregates
  // more of it), which would fight the user's own pan/zoom/scroll during playback - the actual
  // "should be able to zoom in/out" ask depends on this NOT resetting the view underneath them.
  useEffect(() => {
    if (bars.length > 0) chartRef.current?.timeScale().fitContent()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey])

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
    const chart = createChart(containerRef.current, {
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
    if (mode === 'total') {
      ceSeriesRef.current = chart.addSeries(LineSeries, { color: CE_COLOR, lineWidth: 2, title: 'CE OI', priceLineVisible: false })
      peSeriesRef.current = chart.addSeries(LineSeries, { color: PE_COLOR, lineWidth: 2, title: 'PE OI', priceLineVisible: false })
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
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.remove()
      chartRef.current = null
      ceSeriesRef.current = null
      peSeriesRef.current = null
    }
  }, [height, mode])

  useEffect(() => {
    if (!ceSeriesRef.current || !peSeriesRef.current) return
    // 'total' is a plain level - the series' own flat CE_COLOR/PE_COLOR (set at series-creation time
    // above) already applies with no per-point override needed. 'change' colors each bar by its OWN
    // sign - added (OI grew that minute) vs removed (OI shrank) - see this component's own doc
    // comment on why that, not a flat per-series color, is what actually answers "where is it being
    // added/removed."
    const withDirectionColor = (series) => mode === 'change' ? series.map((p) => ({ ...p, color: p.value >= 0 ? OI_ADDED_COLOR : OI_REMOVED_COLOR })) : series
    ceSeriesRef.current.setData(withDirectionColor(ceSeries))
    peSeriesRef.current.setData(withDirectionColor(peSeries))
    if (ceSeries.length > 0 || peSeries.length > 0) chartRef.current?.timeScale().fitContent()
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
// alpha for a small change, ramping toward full alpha at the grid's OWN largest |change| this side
// has seen anywhere - so intensity is always relative to what this specific view is actually
// showing, not some fixed absolute scale that would wash out on a quiet day and clip on a violent
// one. OI_REMOVED_COLOR mirrors it for OI being removed.
const HEATMAP_MIN_ALPHA = 0.12
const HEATMAP_MAX_ALPHA = 0.9

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
function OiChangeHeatmapPlot({ label, byStrike, strikes, atmStrike }) {
  const canvasRef = useRef(null)
  const scrollRef = useRef(null)
  const [hover, setHover] = useState(null)
  const { buckets, perStrikeChange } = useMemo(() => buildOiChangeMatrix(byStrike, strikes), [byStrike, strikes])

  const maxAbs = useMemo(() => {
    let max = 0
    for (const byBucket of perStrikeChange.values())
      for (const v of byBucket.values())
        if (Number.isFinite(v)) max = Math.max(max, Math.abs(v))
    return max
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
      buckets.forEach((t, col) => {
        const v = byBucket?.get(t)
        if (v == null || v === 0 || maxAbs === 0) return
        const alpha = HEATMAP_MIN_ALPHA + (Math.abs(v) / maxAbs) * (HEATMAP_MAX_ALPHA - HEATMAP_MIN_ALPHA)
        ctx.fillStyle = hexToRgba(v > 0 ? OI_ADDED_COLOR : OI_REMOVED_COLOR, alpha)
        ctx.fillRect(col * HEATMAP_CELL_WIDTH, y, HEATMAP_CELL_WIDTH - 1, HEATMAP_ROW_HEIGHT - 1)
      })
    })

    // Time axis along the bottom - one label roughly every 60px regardless of cell width, so it
    // never crowds even at the full 375-column width of a whole session.
    ctx.fillStyle = AXIS_COLOR
    ctx.font = '10px system-ui, -apple-system, sans-serif'
    ctx.textAlign = 'center'
    const labelEvery = Math.max(1, Math.round(60 / HEATMAP_CELL_WIDTH))
    buckets.forEach((t, col) => {
      if (col % labelEvery !== 0) return
      ctx.fillText(istTimeFormatter(t), col * HEATMAP_CELL_WIDTH + HEATMAP_CELL_WIDTH / 2, plotHeight + 14)
    })
  }, [buckets, perStrikeChange, strikes, maxAbs, plotWidth, plotHeight])

  // Scrolls to the newest minute once a fresh bucket set first appears (a new day loaded, or the
  // very first live buckets) - not on every subsequent tick, which would otherwise yank a reader's
  // own scroll-back position to the right edge on every single update.
  const bucketCountRef = useRef(0)
  useEffect(() => {
    if (buckets.length === 0 || buckets.length === bucketCountRef.current) return
    bucketCountRef.current = buckets.length
    if (scrollRef.current) scrollRef.current.scrollLeft = scrollRef.current.scrollWidth
  }, [buckets.length])

  const handleMouseMove = (e) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const col = Math.floor(x / HEATMAP_CELL_WIDTH)
    const row = Math.floor(y / HEATMAP_ROW_HEIGHT)
    if (y >= plotHeight || col < 0 || col >= buckets.length || row < 0 || row >= strikes.length) { setHover(null); return }
    const strike = strikes[row]
    const t = buckets[col]
    setHover({ clientX: e.clientX, clientY: e.clientY, strike, time: t, value: perStrikeChange.get(strike)?.get(t) })
  }

  if (buckets.length === 0) return <Empty description={`No ${label} OI data yet.`} />

  return (
    <div style={{ display: 'flex', border: `1px solid ${BORDER_COLOR}`, borderRadius: 4, overflow: 'hidden' }}>
      <div style={{ flexShrink: 0, width: HEATMAP_LABEL_WIDTH, background: '#161a22' }}>
        <div style={{ height: HEATMAP_AXIS_HEIGHT }} />
        {strikes.map((strike) => (
          <div
            key={strike}
            style={{
              height: HEATMAP_ROW_HEIGHT, lineHeight: `${HEATMAP_ROW_HEIGHT}px`, textAlign: 'right', paddingRight: 8,
              fontSize: 11, whiteSpace: 'nowrap', fontWeight: strike === atmStrike ? 700 : 400,
              color: strike === atmStrike ? '#fff' : AXIS_COLOR,
            }}
          >
            {strike.toLocaleString()}
          </div>
        ))}
      </div>
      <div ref={scrollRef} style={{ overflowX: 'auto', overflowY: 'hidden' }} onMouseLeave={() => setHover(null)}>
        <canvas ref={canvasRef} onMouseMove={handleMouseMove} style={{ display: 'block' }} />
      </div>
      {hover && (
        <div
          style={{
            position: 'fixed', left: hover.clientX + 14, top: hover.clientY + 14, zIndex: 1000,
            background: '#161a22', border: `1px solid ${BORDER_COLOR}`, borderRadius: 4, padding: '4px 8px',
            fontSize: 11, color: '#fff', pointerEvents: 'none', whiteSpace: 'nowrap',
          }}
        >
          {label} {hover.strike.toLocaleString()} @ {istTimeFormatter(hover.time)}:{' '}
          <Text strong style={{ color: hover.value == null ? '#fff' : hover.value > 0 ? OI_ADDED_COLOR : hover.value < 0 ? OI_REMOVED_COLOR : '#fff' }}>
            {hover.value == null ? '—' : `${hover.value > 0 ? '+' : ''}${hover.value.toLocaleString()}`}
          </Text>
        </div>
      )}
    </div>
  )
}

const EMA1_COLOR = '#f0b429'
const EMA2_COLOR = '#38bdf8'
const VWAP_COLOR = '#e072e8'

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
function EmaChart({ oneMinBars, visibleCount, timeframe, onTimeframeChange, ema1Period, onEma1PeriodChange, ema2Period, onEma2PeriodChange, dayKey, vwapSeries = EMPTY_ARRAY, showVwap = false, height = 320 }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const ema1SeriesRef = useRef(null)
  const ema2SeriesRef = useRef(null)
  const vwapSeriesRef = useRef(null)

  const displayBars = useMemo(
    () => aggregateBars(oneMinBars.slice(0, visibleCount), timeframe),
    [oneMinBars, visibleCount, timeframe],
  )
  const ema1Points = useMemo(() => computeEma(displayBars, ema1Period), [displayBars, ema1Period])
  const ema2Points = useMemo(() => computeEma(displayBars, ema2Period), [displayBars, ema2Period])

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
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
    seriesRef.current = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
    })
    ema1SeriesRef.current = chart.addSeries(LineSeries, { color: EMA1_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: true })
    ema2SeriesRef.current = chart.addSeries(LineSeries, { color: EMA2_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: true })
    vwapSeriesRef.current = chart.addSeries(LineSeries, { color: VWAP_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'VWAP' })

    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      ema1SeriesRef.current = null
      ema2SeriesRef.current = null
      vwapSeriesRef.current = null
    }
  }, [height])

  useEffect(() => { ema1SeriesRef.current?.applyOptions({ title: `EMA ${ema1Period}` }) }, [ema1Period])
  useEffect(() => { ema2SeriesRef.current?.applyOptions({ title: `EMA ${ema2Period}` }) }, [ema2Period])

  useEffect(() => { if (seriesRef.current) seriesRef.current.setData(displayBars) }, [displayBars])
  useEffect(() => { if (ema1SeriesRef.current) ema1SeriesRef.current.setData(ema1Points) }, [ema1Points])
  useEffect(() => { if (ema2SeriesRef.current) ema2SeriesRef.current.setData(ema2Points) }, [ema2Points])
  // Own native 1-minute cadence, not re-aggregated to this chart's own timeframe - VWAP is a
  // session-cumulative value, not a moving average of the visible candles (exactly how TradingView
  // shows it too).
  useEffect(() => {
    vwapSeriesRef.current?.setData(showVwap ? vwapSeries : EMPTY_ARRAY)
  }, [vwapSeries, showVwap])

  // Re-fit on a brand new day AND whenever this chart's OWN timeframe changes (unlike the main
  // chart, which only re-fits on dayKey) - switching from 5min to 1min here goes from ~75 candles to
  // ~375 for the same revealed stretch, and leaving the old zoom level in place would show only a
  // sliver of that much denser series rather than the whole thing.
  useEffect(() => {
    if (displayBars.length > 0) chartRef.current?.timeScale().fitContent()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey, timeframe])

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
function FuturesChart({ bars, oiLine, markers, dayKey, height = 320 }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const oiSeriesRef = useRef(null)
  const markersRef = useRef(null)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
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
    // Own (left) price scale and a thin, semi-transparent line - OI's own numbers (lakhs/crores)
    // are a totally different scale than price, so sharing the right-hand axis with candles would
    // otherwise squash one or the other into a flat line.
    oiSeriesRef.current = chart.addSeries(LineSeries, {
      color: `${AXIS_COLOR}cc`, lineWidth: 2, priceScaleId: 'left', priceLineVisible: false, lastValueVisible: true,
      title: 'OI (M)',
    })
    // The plotted values are already OI/1e6 (see the caller's own futuresOiLine) - format the axis
    // itself to 2 decimals instead of lightweight-charts' own default (which would otherwise round
    // a value like 12.34 down to whole numbers and make small OI moves invisible on the axis).
    chart.priceScale('left').applyOptions({ mode: 0 })
    oiSeriesRef.current.applyOptions({ priceFormat: { type: 'custom', formatter: (v) => v.toFixed(2) } })

    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      oiSeriesRef.current = null
      markersRef.current = null
    }
  }, [height])

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

  useEffect(() => {
    if (bars.length > 0) chartRef.current?.timeScale().fitContent()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// A genuinely draggable floating panel - antd's own Popover only ever anchors next to its trigger,
// even when manually controlled to stay open, which isn't what "floating, I should be able to move
// it anywhere on screen" means. Rendered into a portal on document.body so it sits above every other
// element regardless of where its trigger lives in the tree, and tracked as a plain {x,y} in the
// PARENT's own state (not local state here) so the position survives closing and reopening the
// panel, not just drags within one open session. Dragged via native mouse events on the header - no
// drag library needed for something this small.
function DraggableFloatingPanel({ title, pos, onPosChange, onClose, children }) {
  const dragRef = useRef(null)
  const panelRef = useRef(null)

  // A fixed 440px panel is wider than most phone screens, and the caller's own initial `pos` is
  // computed once against whatever window.innerWidth happened to be at that moment - stale the
  // instant the viewport changes (device rotation, a resized browser window, or just a caller doing
  // its own math against a narrow screen). Re-clamping against this panel's OWN actual rendered
  // width/height (which the CSS width below already keeps within the viewport) on mount and resize
  // means it's never left partly or fully off-screen regardless of what `pos` it was handed.
  useEffect(() => {
    const clamp = () => {
      if (!panelRef.current) return
      const rect = panelRef.current.getBoundingClientRect()
      const maxX = Math.max(0, window.innerWidth - rect.width)
      const maxY = Math.max(0, window.innerHeight - rect.height)
      const clampedX = Math.min(Math.max(0, pos.x), maxX)
      const clampedY = Math.min(Math.max(0, pos.y), maxY)
      if (clampedX !== pos.x || clampedY !== pos.y) onPosChange({ x: clampedX, y: clampedY })
    }
    clamp()
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos.x, pos.y])

  const beginDrag = (clientX, clientY) => {
    dragRef.current = { startX: clientX, startY: clientY, origX: pos.x, origY: pos.y }
  }
  const dragTo = (clientX, clientY) => {
    if (!dragRef.current) return
    const dx = clientX - dragRef.current.startX
    const dy = clientY - dragRef.current.startY
    // Deliberately looser than the mount/resize clamp above (a fixed 80px/40px slack rather than the
    // panel's own full width/height) - lets the panel be dragged mostly off an edge and tucked out of
    // the way, same as before this fix, rather than only ever settling flush against the viewport.
    const maxX = Math.max(0, window.innerWidth - 80)
    const maxY = Math.max(0, window.innerHeight - 40)
    onPosChange({
      x: Math.min(Math.max(0, dragRef.current.origX + dx), maxX),
      y: Math.min(Math.max(0, dragRef.current.origY + dy), maxY),
    })
  }
  const endDrag = () => { dragRef.current = null }

  const onHeaderMouseDown = (e) => {
    beginDrag(e.clientX, e.clientY)
    const onMouseMove = (moveEvent) => dragTo(moveEvent.clientX, moveEvent.clientY)
    const onMouseUp = () => {
      endDrag()
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  // Touch's own counterpart to onHeaderMouseDown above - a phone/tablet never fires mouse events for
  // a finger drag, so without this the panel would be readable on mobile but simply un-repositionable.
  const onHeaderTouchStart = (e) => {
    const touch = e.touches[0]
    if (!touch) return
    beginDrag(touch.clientX, touch.clientY)
    const onTouchMove = (moveEvent) => {
      if (!dragRef.current) return
      moveEvent.preventDefault()
      const moveTouch = moveEvent.touches[0]
      if (moveTouch) dragTo(moveTouch.clientX, moveTouch.clientY)
    }
    const onTouchEnd = () => {
      endDrag()
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
    }
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', onTouchEnd)
  }

  return createPortal(
    <div
      ref={panelRef}
      style={{
        position: 'fixed', left: pos.x, top: pos.y, zIndex: 1000, width: 'min(440px, calc(100vw - 24px))',
        background: '#1f1f1f', border: `1px solid ${BORDER_COLOR}`, borderRadius: 8,
        boxShadow: '0 8px 28px rgba(0, 0, 0, 0.55)',
      }}
    >
      <div
        onMouseDown={onHeaderMouseDown}
        onTouchStart={onHeaderTouchStart}
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '8px 12px', cursor: 'move', touchAction: 'none', userSelect: 'none',
          borderBottom: `1px solid ${BORDER_COLOR}`,
        }}
      >
        <Text strong style={{ fontSize: 13 }}>{title}</Text>
        <Button type="text" size="small" onClick={onClose} style={{ padding: '0 4px' }}>✕</Button>
      </div>
      <div style={{ padding: 12 }}>{children}</div>
    </div>,
    document.body,
  )
}

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
function computeStopTargetHit(series, entryTimeMs, asOfMs, entryPrice, direction, slPoints, targetPoints) {
  const hasSl = slPoints > 0
  const hasTarget = targetPoints > 0
  if ((!hasSl && !hasTarget) || !series) return null
  const slLevel = direction === 'SELL' ? entryPrice + slPoints : entryPrice - slPoints
  const targetLevel = direction === 'SELL' ? entryPrice - targetPoints : entryPrice + targetPoints
  for (const p of series) {
    const t = new Date(p.time).getTime()
    if (t <= entryTimeMs) continue
    if (asOfMs != null && t > asOfMs) break
    const high = p.high ?? p.price
    const low = p.low ?? p.price
    if (high == null || low == null) continue
    const slHit = hasSl && (direction === 'SELL' ? high >= slLevel : low <= slLevel)
    const targetHit = hasTarget && (direction === 'SELL' ? low <= targetLevel : high >= targetLevel)
    if (slHit) return { kind: 'sl', fillPrice: slLevel }
    if (targetHit) return { kind: 'target', fillPrice: targetLevel }
  }
  return null
}

// SEBI periodically revises each index's own lot size - update this if it changes. This feature is
// paper trading only (no real order is ever placed - see PaperTradePanel's own doc comment), so a
// stale value here only skews the SIMULATED PnL's scale, not anything real.
const PAPER_TRADE_LOT_SIZE = { NIFTY: 75, BANKNIFTY: 35, SENSEX: 20 }

// One simulated position: Buy (long) or Sell (short/write) CE/PE at whatever this replay's own
// premium series shows as of the CURRENT replay tick, then Exit later (again at whatever the series
// shows as of the tick Exit is clicked) - entirely client-side, no backend call, no real order.
// Punching multiple positions in one session, CE and PE both, is the point (the user's own "I can
// trade multiple things ce and pe both") - each is tracked independently, so several positions (any
// mix of Buy/Sell, CE/PE) can be open at once with their own live PnL. A Sell position's PnL is the
// mirror of a Buy's (entryPrice - ltp instead of ltp - entryPrice, since the writer profits as the
// premium falls) - see the PnL calc in the caller's own enrichedPaperPositions.
function PaperTradePanel({
  atmStrike, step, side, onSideChange, direction, onDirectionChange, strikeOffset, onStrikeOffsetChange,
  qtyLots, onQtyLotsChange, slPoints, onSlPointsChange, targetPoints, onTargetPointsChange,
  onPunch, canPunch, positions, onExit, onExitAll, onClearAll,
}) {
  const strikeOptions = useMemo(() => buildStrikeOffsetOptions(atmStrike, step), [atmStrike, step])

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
        <Space wrap size={8}>
          <Segmented value={direction} onChange={onDirectionChange} options={[{ label: 'Buy', value: 'BUY' }, { label: 'Sell', value: 'SELL' }]} />
          <Segmented value={side} onChange={onSideChange} options={[{ label: 'CE', value: 'CE' }, { label: 'PE', value: 'PE' }]} />
          <Select value={strikeOffset} onChange={onStrikeOffsetChange} style={{ width: 160 }} options={strikeOptions} disabled={atmStrike == null} />
          <InputNumber value={qtyLots} onChange={(v) => onQtyLotsChange(v ?? 1)} min={1} step={1} style={{ width: 100 }} addonAfter="lots" />
          <InputNumber
            value={slPoints} onChange={(v) => onSlPointsChange(v ?? 0)} min={0} step={5} style={{ width: 110 }}
            addonBefore="SL" addonAfter="pts"
          />
          <InputNumber
            value={targetPoints} onChange={(v) => onTargetPointsChange(v ?? 0)} min={0} step={5} style={{ width: 130 }}
            addonBefore="Target" addonAfter="pts"
          />
          <Button type="primary" size="small" onClick={onPunch} disabled={!canPunch}>
            {direction === 'SELL' ? 'Sell' : 'Buy'}
          </Button>
        </Space>
        {positions.length > 0 && (
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
        <Text type="secondary" style={{ fontSize: 10 }}>
          Paper trade only - simulated against this replay's own premium series, no real order is ever placed. Buy (long) or Sell (short/write),
          then Exit; lot size is a fixed per-underlying constant, not fetched live. SL/Target auto-exit an
          open position once its own premium has moved that many points against/in its favor (0 disables
          either), checked against every revealed minute bar's own high-low since entry (or each live
          tick, once today's live feed is ticking) - not just the latest price - so a real intra-bar touch
          is caught even if price reverses before the next check. Exit all closes every open position
          right now at its current price, without clearing the table the way Clear all does. Resets when
          a new day is loaded, or click Clear all.
        </Text>
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
function OiLadder({ rows, atmStrike }) {
  if (rows.length === 0) return <Empty description="No stored OI/IV data yet at this point in the replay." />

  // ONE shared max across BOTH sides, not one independently computed per side - the exact same bug
  // just fixed on the chart's own R/S lines (see ReplayChart's own doc comment): a 33M PE bar and a
  // 17M CE bar rendering at the SAME width because each was only ever measured against its own
  // side's own max would give exactly the "false impression" the user's own screenshots caught.
  // Bar width now means the same thing everywhere in this ladder, CE or PE.
  const maxOi = Math.max(1, ...rows.map((r) => r.ceOi ?? 0), ...rows.map((r) => r.peOi ?? 0))
  const resistanceStrike = rows.reduce((best, r) => ((r.ceOi ?? 0) > (best?.ceOi ?? -1) ? r : best), null)?.strike
  const supportStrike = rows.reduce((best, r) => ((r.peOi ?? 0) > (best?.peOi ?? -1) ? r : best), null)?.strike

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
              <Text strong={isAtm} style={{ fontSize: 'clamp(10px, 2.8vw, 12px)', color: isAtm ? '#fff' : undefined }}>{row.strike.toLocaleString()}</Text>
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
function LiquidityMapTable({ rows, atmStrike, currentPrice }) {
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
      {/* scroll.x - these columns' own widths sum past a phone's viewport, so the table needs to
          scroll horizontally there rather than squash columns or overflow the page. */}
      <Table
        dataSource={enriched} columns={columns} rowKey="strike" size="small" pagination={false}
        scroll={{ x: 770, y: 360 }}
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
  const [expiryFlag, setExpiryFlag] = useState('WEEK')
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
  // directly on chart B's own Card (not a separate panel), same feature as the Live OI Dashboard's
  // own Entry chart B, added here for parity - the replay clock (asOfMs) keeps this from ever
  // revealing more than the rest of the page has "played" up to, unlike the live page's own version.
  const [oiLookbackBars, setOiLookbackBars] = useState(3)
  // Total OI Lookback Table's own state (Day OI Accumulation card, below) - deliberately separate
  // from chart B's own oiLookbackBars above: several bar counts at once, against the WHOLE chain's
  // total OI rather than one strike, with its own independent timeframe (default 1-minute bars).
  const [totalOiLookbackBars, setTotalOiLookbackBars] = useState(DEFAULT_TOTAL_OI_LOOKBACK_BARS)
  const [totalOiLookbackTimeframe, setTotalOiLookbackTimeframe] = useState(1)
  const [chartCTimeframe, setChartCTimeframe] = useState(1)
  const [chartCEma1, setChartCEma1] = useState(9)
  const [chartCEma2, setChartCEma2] = useState(15)

  // Option premium chart's own CE/PE strike pickers - offsets from ATM (see
  // buildStrikeOffsetOptions' own doc comment), independently selectable, both defaulting to ATM
  // itself. The user's own "I should be able to choose it +- from dropdown" ask.
  const [cePremiumOffset, setCePremiumOffset] = useState(0)
  const [pePremiumOffset, setPePremiumOffset] = useState(0)
  const [cePremiumTimeframe, setCePremiumTimeframe] = useState(1)
  const [cePremiumEma1, setCePremiumEma1] = useState(9)
  const [cePremiumEma2, setCePremiumEma2] = useState(15)
  const [pePremiumTimeframe, setPePremiumTimeframe] = useState(1)
  const [pePremiumEma1, setPePremiumEma1] = useState(9)
  const [pePremiumEma2, setPePremiumEma2] = useState(15)

  const [visibleSections, setVisibleSections] = useState(ALL_SECTION_VALUES)

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
  // isToday is true (see below), reset on every fresh load() so switching days never carries a
  // previous day's live ticks forward.
  const [liveBars, setLiveBars] = useState([])
  const [liveCePoints, setLiveCePoints] = useState([])
  const [livePePoints, setLivePePoints] = useState([])
  const [liveFuturesPoints, setLiveFuturesPoints] = useState([])

  // Session VWAP - only meaningful for isToday (see oneMinBars' own identical isToday split just
  // below): the live GET .../vwap-series endpoint reflects SpotUnderlyingState's own in-memory
  // volume bars, i.e. recent/current days, not whatever historical day this page might otherwise be
  // replaying. A genuinely historical day's own spotCandlesOneMinute carries no volume at all (see
  // OiReplayResult), so VWAP simply isn't shown while replaying one - reset on every load() like
  // liveBars above, seeded once isToday in load()'s own .then(), grown live by handleSpotUpdate.
  const [vwapSeries, setVwapSeries] = useState([])
  const [showVwap, setShowVwap] = usePersistedState(STORED_SHOW_VWAP, false)

  // Paper trade panel state - see PaperTradePanel's own doc comment. strikeOffset defaults to 0
  // (ATM) and stays an OFFSET rather than an absolute strike, so "the default is ATM" holds true
  // all through the session even as ATM itself drifts with price - the user never has to re-pick it
  // unless they actually want an OTM/ITM strike instead. Positions reset on every fresh load() (see
  // below), same as the live feed's own tail - a paper position only means something against the
  // ONE day's premium series it was punched into.
  const [paperSide, setPaperSide] = useState('CE')
  const [paperDirection, setPaperDirection] = useState('BUY')
  const [paperStrikeOffset, setPaperStrikeOffset] = useState(0)
  const [paperQtyLots, setPaperQtyLots] = useState(10)
  // Auto stop-loss/target, in premium points - SL defaults to 30 (the user's own explicit ask),
  // target has no natural default so it starts disabled; both editable per session. 0/blank
  // disables either one (see the effect that reads these below).
  const [paperSlPoints, setPaperSlPoints] = useState(30)
  const [paperTargetPoints, setPaperTargetPoints] = useState(0)
  const [paperPositions, setPaperPositions] = useState([])
  // Toggled by the trigger button/tag and the panel's own close button only - never by clicking
  // elsewhere (it's a portal-rendered DraggableFloatingPanel, not an antd Popover, so there is no
  // click-outside-to-dismiss behavior to fight in the first place). Position lives here, not inside
  // the panel component, so it survives closing and reopening rather than resetting every time.
  const [paperPanelOpen, setPaperPanelOpen] = useState(false)
  const [paperPanelPos, setPaperPanelPos] = useState(() => ({
    x: Math.max(24, window.innerWidth - 480), y: 140,
  }))

  // BANKNIFTY has no weekly expiry - NSE discontinued it (same rule Expired Backtest enforces).
  // Corrected right in the underlying picker's own onChange below, not a separate effect - this
  // is a direct response to that one user action, not a value derived from external state.
  const selectUnderlying = (value) => {
    setUnderlying(value)
    if (value === 'BANKNIFTY' && expiryFlag === 'WEEK') setExpiryFlag('MONTH')
  }

  const canLoad = Boolean(underlying && date)
  const isToday = Boolean(date && date.format('YYYY-MM-DD') === istDateKey(new Date()))
  const liveFeedSupported = LIVE_FEED_COMBOS.has(`${underlying}:${expiryFlag}`)

  // Takes an optional explicit date rather than only ever reading the `date` state, so goLive below
  // can set today's date AND kick off the fetch in one click - setDate(today) followed immediately
  // by load() would still read the OLD `date` from this closure (React state updates aren't
  // synchronous), so the caller passes the date it just set instead of relying on it having landed.
  const load = (overrideDate) => {
    const effectiveDate = overrideDate ?? date
    if (!underlying || !effectiveDate) return
    // Abort whatever run fetch might still be pending from a previous click - otherwise a stale
    // response landing late could clobber the result of THIS load with an older day's data.
    activeLoadController.current?.abort('superseded')
    const controller = new AbortController()
    activeLoadController.current = controller
    setPlaying(false)
    setLoading(true)
    setError(null)
    setLiveBars([])
    setLiveCePoints([])
    setLivePePoints([])
    setLiveFuturesPoints([])
    setPaperPositions([])
    setVwapSeries([])
    // Only for today - see vwapSeries' own doc comment on why a historical day has no VWAP to show
    // at all (its own spotCandlesOneMinute carries no volume, and the live endpoint below reflects
    // only recent/in-memory days). Independent of the main run fetch below so a slow/failed VWAP
    // fetch never blocks or fails the actual replay load.
    if (effectiveDate.format('YYYY-MM-DD') === istDateKey(new Date())) {
      fetch(`/api/spot/${underlying}/vwap-series`)
        .then((r) => r.json())
        .then((vwap) => setVwapSeries((vwap ?? []).map((p) => ({ time: toChartTime(p.time), value: p.obv }))))
        .catch((err) => console.error('Failed to load VWAP series:', err))
    }
    const params = new URLSearchParams({
      date: effectiveDate.format('YYYY-MM-DD'),
      timeframeMinutes: String(timeframe),
      expiryFlag,
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
        setResult(body)
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

  // One click for "switch to today and start following it live" - the user's own "if tomorrow
  // markets opens and if select live this will work on live data" ask, rather than needing to open
  // the date picker and find today's date by hand every single morning. Whatever underlying/
  // expiryFlag/timeframe are already selected stay as they are - this only ever changes the date.
  // isToday + liveFeedSupported (see below) is what actually keeps it updating tick by tick once
  // loaded; this button just gets there in one step instead of several.
  const goLive = () => {
    const today = dayjs()
    setDate(today)
    load(today)
  }

  // The TRUE replay clock - native 1-minute bars, so every derived read (ladder, OI change, Market
  // Read, Day Accumulation, alerts) advances one real minute per tick regardless of which timeframe
  // the CHART itself displays. The chart's own candles are a re-aggregation of a slice of this,
  // computed separately below - the two used to be the same array, which meant everything on the
  // page only updated once per whole displayed candle (once every 5 or 15 real minutes on a coarser
  // timeframe) instead of continuously. While isToday, this also folds in liveBars - the initial
  // REST snapshot's own bars, with the live feed's tail merged on top (replacing the still-forming
  // final minute in place as it updates, appending once a new minute actually starts).
  const oneMinBars = useMemo(() => {
    const base = (result?.spotCandlesOneMinute ?? []).map(toBar)
    if (!isToday || liveBars.length === 0) return base
    const merged = base.slice()
    for (const bar of liveBars) {
      if (merged.length > 0 && merged[merged.length - 1].time === bar.time) merged[merged.length - 1] = bar
      else if (merged.length === 0 || bar.time > merged[merged.length - 1].time) merged.push(bar)
    }
    return merged
  }, [result, liveBars, isToday])
  const ceByStrike = useMemo(
    () => groupByStrike(isToday ? [...(result?.cePoints ?? []), ...liveCePoints] : (result?.cePoints ?? [])),
    [result, liveCePoints, isToday],
  )
  const peByStrike = useMemo(
    () => groupByStrike(isToday ? [...(result?.pePoints ?? []), ...livePePoints] : (result?.pePoints ?? [])),
    [result, livePePoints, isToday],
  )

  // The strike drill-down popup - opened by clicking anywhere on the main chart (see ReplayChart's
  // own onStrikeClick), answering the "how can I see per-minute OI change AND total OI for one
  // strike, not just its since-open number" ask. Shows both together (see the Modal's own JSX
  // further down), not behind a tab switch, so the two can be read against each other directly -
  // that comparison is the whole point. null strike means the popup is closed.
  const [drilldownStrike, setDrilldownStrike] = useState(null)
  // Whole day's own history, not asOfMs-gated - this is a look-back analysis popup, not part of the
  // live replay HUD, so it always shows everything currently loaded for the strike regardless of
  // where a historical day's own scrub position sits.
  const drilldownCeTotal = useMemo(
    () => aggregateLinePoints((ceByStrike.get(drilldownStrike) ?? []).map((p) => ({ time: toChartTime(p.time), value: p.openInterest })), 1),
    [ceByStrike, drilldownStrike],
  )
  const drilldownPeTotal = useMemo(
    () => aggregateLinePoints((peByStrike.get(drilldownStrike) ?? []).map((p) => ({ time: toChartTime(p.time), value: p.openInterest })), 1),
    [peByStrike, drilldownStrike],
  )
  const drilldownCeChange = useMemo(() => computeOiChangeSeries(drilldownCeTotal), [drilldownCeTotal])
  const drilldownPeChange = useMemo(() => computeOiChangeSeries(drilldownPeTotal), [drilldownPeTotal])

  // See FEED_STALL_WARNING_MS's own doc comment - set on every live tick that actually matches
  // today/the current underlying/expiryFlag, so this tracks "last time THIS page's own feed
  // genuinely advanced", not just "last time any tick arrived for anything".
  const [lastTickAtMs, setLastTickAtMs] = useState(null)

  // Live feed wiring - see useOiReplayLiveFeed's own doc comment. Only connects once an initial
  // snapshot has actually loaded (this is a "keep it fresh from here" layer on top of that fetch,
  // not a replacement for it) and only for a combo OiReplayLiveFeedService actually tracks.
  const handleSpotUpdate = (snapshot) => {
    if (!isToday || snapshot?.underlying !== underlying || !snapshot?.currentBar) return
    setLastTickAtMs(Date.now())
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
  const handleOiReplayTick = (tick) => {
    if (!isToday || tick?.underlying !== underlying || tick?.expiryFlag !== expiryFlag) return
    setLastTickAtMs(Date.now())
    const isCall = tick.side === 'CE'
    // The live feed carries no IV (Dhan's tick stream doesn't - see OiReplayLiveFeedService's own
    // doc comment) - carry forward whatever the initial REST fetch last saw for this strike/side
    // rather than showing a blank once live ticks start arriving.
    const sourcePoints = isCall ? result?.cePoints : result?.pePoints
    const known = (sourcePoints ?? []).filter((p) => p.strike === tick.strike && p.impliedVolatility != null)
    const lastKnownIv = known.length > 0 ? known[known.length - 1].impliedVolatility : null
    const point = { time: tick.time, strike: tick.strike, openInterest: tick.openInterest, impliedVolatility: lastKnownIv, price: tick.price }
    if (isCall) setLiveCePoints((prev) => [...prev, point])
    else setLivePePoints((prev) => [...prev, point])
  }
  // Buckets each raw tick into its own current MINUTE (unlike handleSpotUpdate, which gets an
  // already-bucketed "current bar" straight from SpotFeedHostedService - OiReplayLiveFeedService's
  // own futuresTick broadcast is a raw tick, so the bucketing happens here instead). volume is
  // deliberately left null for every live-ticked point: SpotTick.Volume is Dhan's CUMULATIVE volume
  // for the whole day, not a per-minute figure the way the REST-sourced FuturesBar.Volume is - and
  // reconciling those two units would need knowing the cumulative total as of the last REST bar,
  // which this page doesn't have. futuresVolumeSoFar's own sum already treats a null as 0, so this
  // slightly under-counts the live tail rather than risk wildly over-counting it.
  const handleFuturesTick = (tick) => {
    if (!isToday || tick?.underlying !== underlying) return
    setLastTickAtMs(Date.now())
    const bucketIso = new Date(Math.floor(new Date(tick.time).getTime() / 60_000) * 60_000).toISOString()
    setLiveFuturesPoints((prev) => {
      if (prev.length > 0 && prev[prev.length - 1].time === bucketIso) {
        const last = prev[prev.length - 1]
        const next = prev.slice()
        next[next.length - 1] = { ...last, high: Math.max(last.high, tick.price), low: Math.min(last.low, tick.price), close: tick.price, openInterest: tick.openInterest }
        return next
      }
      return [...prev, { time: bucketIso, open: tick.price, high: tick.price, low: tick.price, close: tick.price, volume: null, openInterest: tick.openInterest }]
    })
  }

  const handleLiveReconnected = () => { if (isToday) load() }
  const liveConnectionState = useOiReplayLiveFeed(isToday && liveFeedSupported && Boolean(result), handleSpotUpdate, handleOiReplayTick, handleFuturesTick, handleLiveReconnected)

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
  const feedStalled = isToday && liveFeedSupported && liveConnectionState === 'connected'
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
  // below on why today ignores manualVisibleCount entirely, so this loop is inert whenever isToday.
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
  const visibleCount = isToday ? oneMinBars.length : manualVisibleCount

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
  // ceByStrike/peByStrike well before the next bar closed. Live OI Dashboard never had this problem
  // (it just reads Date.now()/the array's own last entry, no bucket concept at all). A historical
  // day still uses the scrubbed replay position exactly as before - only "today, live" changes.
  const asOfMs = isToday ? Date.now() : (currentBar ? fromChartTime(currentBar.time) * 1000 : null)

  // The chart's own displayed candles - the visible slice of 1-minute bars, re-aggregated to
  // whatever timeframe is selected, recomputed fresh each tick so the LAST (currently forming)
  // candle updates live exactly like a real charting terminal's current bar does.
  const displayBars = useMemo(
    () => aggregateBars(oneMinBars.slice(0, visibleCount), timeframe),
    [oneMinBars, visibleCount, timeframe],
  )
  const dayStartMs = oneMinBars[0] ? fromChartTime(oneMinBars[0].time) * 1000 : null

  // Futures - the REST snapshot from OiReplayService's own single live call, PLUS (while isToday)
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
    if (!isToday || liveFuturesPoints.length === 0) return base
    const merged = base.slice()
    for (const point of liveFuturesPoints) {
      if (merged.length > 0 && merged[merged.length - 1].time === point.time) merged[merged.length - 1] = point
      else if (merged.length === 0 || new Date(point.time) > new Date(merged[merged.length - 1].time)) merged.push(point)
    }
    return merged
  }, [result, liveFuturesPoints, isToday])
  const futuresBarsChart = useMemo(() => futuresPointsRaw.map(toBar), [futuresPointsRaw])
  const displayFuturesBars = useMemo(() => {
    if (asOfMs == null) return []
    const cutoff = toChartTime(asOfMs)
    return aggregateBars(futuresBarsChart.filter((b) => b.time <= cutoff), timeframe)
  }, [futuresBarsChart, asOfMs, timeframe])
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
        ceStale: ceAsOfMs != null && asOfMs - ceAsOfMs > OI_STALE_MS,
        peStale: peAsOfMs != null && asOfMs - peAsOfMs > OI_STALE_MS,
      }
    })
    return rows.sort((a, b) => b.strike - a.strike)
  }, [ceByStrike, peByStrike, asOfMs, dayStartMs])

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

  // ATM OI change over the last N bars, bucketed to chart B's OWN timeframe (chartBTimeframe) - see
  // the state declaration above. Filtered to asOfMs first (unlike the Live OI Dashboard's identical
  // feature, which needs no cutoff) so this never reveals a tick beyond what the rest of the replay
  // has played up to.
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
  const premiumStrikeOptions = useMemo(() => buildStrikeOffsetOptions(atmStrike, step), [atmStrike, step])

  const paperStrike = atmStrike != null ? atmStrike + paperStrikeOffset * step : null
  const paperEntryPreview = useMemo(() => {
    if (paperStrike == null || asOfMs == null) return null
    const series = (paperSide === 'CE' ? ceByStrike : peByStrike).get(paperStrike)
    return latestAtOrBefore(series ?? [], asOfMs)
  }, [paperSide, paperStrike, ceByStrike, peByStrike, asOfMs])

  const handlePaperPunch = () => {
    if (paperStrike == null || paperEntryPreview?.price == null) return
    setPaperPositions((prev) => [...prev, {
      id: `${Date.now()}-${Math.random()}`,
      side: paperSide, direction: paperDirection, strike: paperStrike, qtyLots: paperQtyLots,
      lotSize: PAPER_TRADE_LOT_SIZE[underlying] ?? 1,
      entryPrice: paperEntryPreview.price, entryTime: asOfMs, status: 'OPEN', exitPrice: null, exitReason: null,
    }])
  }

  const handlePaperExit = (id) => {
    setPaperPositions((prev) => prev.map((p) => {
      if (p.id !== id || p.status !== 'OPEN') return p
      const series = (p.side === 'CE' ? ceByStrike : peByStrike).get(p.strike)
      const point = asOfMs != null ? latestAtOrBefore(series ?? [], asOfMs) : null
      return { ...p, status: 'CLOSED', exitPrice: point?.price ?? p.entryPrice, exitReason: 'Manual' }
    }))
  }

  const handlePaperClearAll = () => setPaperPositions([])

  // Exits every currently OPEN position at its own live (as-of-replay) price, rather than deleting
  // them the way Clear all does - a real "flatten everything" action whose exit prices/PnL stay in
  // the table afterward, distinct from Clear all's "wipe the list" ask.
  const handlePaperExitAll = () => {
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
  useEffect(() => {
    if ((!paperSlPoints || paperSlPoints <= 0) && (!paperTargetPoints || paperTargetPoints <= 0)) return
    const hits = new Map()
    for (const p of paperPositions) {
      if (p.status !== 'OPEN' || p.entryTime == null) continue
      const series = (p.side === 'CE' ? ceByStrike : peByStrike).get(p.strike)
      const hit = computeStopTargetHit(series, p.entryTime, asOfMs, p.entryPrice, p.direction, paperSlPoints, paperTargetPoints)
      if (hit) hits.set(p.id, hit)
    }
    if (hits.size === 0) return
    setPaperPositions((prev) => prev.map((p) => {
      const hit = hits.get(p.id)
      return hit && p.status === 'OPEN' ? { ...p, status: 'CLOSED', exitPrice: hit.fillPrice, exitReason: hit.kind === 'sl' ? 'SL' : 'Target' } : p
    }))
  }, [paperPositions, ceByStrike, peByStrike, asOfMs, paperSlPoints, paperTargetPoints])

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

  // One point per REVEALED 1-min bar, for the Total OI Lookback Table below - total (chain-wide)
  // CE/PE OI as of that bar's own close, built the same way ladderRows/dayStartByStrike already read
  // a single point in time, just repeated across every bar instead of one. Deliberately keyed on
  // oneMinBars.length rather than on ceByStrike/peByStrike themselves (which get a new Map reference
  // on every single live tick): a per-bar lookback table has no need for sub-minute precision on its
  // HISTORICAL points, and redoing this whole-day sum across every strike on every tick (rather than
  // once per completed minute) would be wasted work during a live "today" replay. underlying/
  // result.date/expiryFlag are in the deps purely so switching to a different day/instrument that
  // happens to produce the exact same bar count still forces a recompute instead of reusing stale
  // totals from the day just left.
  const completedOiHistory = useMemo(() => {
    if (oneMinBars.length < 2) return []
    const strikes = [...new Set([...ceByStrike.keys(), ...peByStrike.keys()])]
    const ceSeriesList = strikes.map((s) => ceByStrike.get(s) ?? [])
    const peSeriesList = strikes.map((s) => peByStrike.get(s) ?? [])
    const history = []
    for (let i = 0; i < oneMinBars.length - 1; i++) {
      const bar = oneMinBars[i]
      const barMs = fromChartTime(bar.time) * 1000
      let ceTotal = 0
      let peTotal = 0
      for (const series of ceSeriesList) ceTotal += latestAtOrBefore(series, barMs)?.openInterest ?? 0
      for (const series of peSeriesList) peTotal += latestAtOrBefore(series, barMs)?.openInterest ?? 0
      history.push({ time: bar.time, ceTotal, peTotal })
    }
    return history
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [oneMinBars.length, underlying, result?.date, expiryFlag])

  // The still-forming/current bar appended live, using the page's own already-ticking
  // totalCeOi/totalPeOi rather than recomputing the whole day above - "now" stays continuously live
  // even though completedOiHistory only updates once a minute.
  const totalOiHistory = useMemo(() => {
    if (oneMinBars.length === 0) return completedOiHistory
    return [...completedOiHistory, { time: oneMinBars[oneMinBars.length - 1].time, ceTotal: totalCeOi, peTotal: totalPeOi }]
  }, [completedOiHistory, oneMinBars, totalCeOi, totalPeOi])

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
                type="primary" onClick={goLive} loading={loading} disabled={!underlying}
                style={isToday ? { background: UP_COLOR, borderColor: UP_COLOR } : undefined}
              >
                ● {isToday ? 'Live' : 'Go Live'}
              </Button>
              {isToday && liveFeedSupported && (
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
              <Select
                value={underlying} onChange={selectUnderlying} style={{ width: 130 }}
                options={[{ value: 'NIFTY', label: 'NIFTY' }, { value: 'BANKNIFTY', label: 'BANKNIFTY' }, { value: 'SENSEX', label: 'SENSEX' }]}
              />
              <Select
                value={expiryFlag} onChange={setExpiryFlag} style={{ width: 130 }}
                options={[{ value: 'WEEK', label: 'Weekly', disabled: underlying === 'BANKNIFTY' }, { value: 'MONTH', label: 'Monthly' }]}
              />
              <DatePicker value={date} onChange={setDate} format="DD MMM YYYY" placeholder="Trading day" />
              <Select value={timeframe} onChange={setTimeframe} style={{ width: 110 }} options={TIMEFRAME_OPTIONS} />
              <Button type="primary" onClick={() => load()} loading={loading} disabled={!canLoad}>Load day</Button>
              {isToday && <Checkbox checked={showVwap} onChange={(e) => setShowVwap(e.target.checked)}>VWAP</Checkbox>}
            </Space>
            <Space align="center" size={12} wrap>
              <Text type="secondary" style={{ fontSize: 12 }}>Sections shown</Text>
              <Select
                mode="multiple" value={visibleSections} onChange={setVisibleSections}
                style={{ minWidth: 420, maxWidth: 900 }} maxTagCount={SECTION_OPTIONS.length}
                options={SECTION_OPTIONS}
              />
              <Button size="small" onClick={() => setVisibleSections(ALL_SECTION_VALUES)} disabled={visibleSections.length === ALL_SECTION_VALUES.length}>
                Show all
              </Button>
            </Space>
            {isToday && !liveFeedSupported && (
              <Alert
                type="info" showIcon
                message={`Today's data will load, but live tick-by-tick updates aren't wired up for ${underlying} ${expiryFlag === 'WEEK' ? 'Weekly' : 'Monthly'} - you'll see a snapshot as of Load day/Go Live, not a continuously ticking feed. NIFTY (Weekly/Monthly), BANKNIFTY (Monthly) and SENSEX (Weekly/Monthly) all stay live.`}
              />
            )}
            {isToday && liveFeedSupported && liveConnectionState === 'disconnected' && (
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
            {error && <Alert type="error" showIcon closable onClose={() => setError(null)} message={error} />}
          </Space>
        </Card>

        {result && (
          <>
            {visibleSections.includes('topStats') && (
              <Card size="small">
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
            )}

            {visibleSections.includes('marketRead') && marketRead && (
              <Card size="small" title="Market Read">
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
            )}

            {visibleSections.includes('dayOi') && dayOiSummary && (
              <Card size="small" title="Day OI Accumulation (since today's open)">
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
                </Space>
              </Card>
            )}

            {visibleSections.includes('oiHeatmap') && (
              <Card size="small" title="OI change heatmap (all strikes, per minute)">
                <Space direction="vertical" size={12} style={{ width: '100%' }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Every tracked strike's own OI change, minute by minute - color intensity is how much changed (scaled to the
                    heaviest change this side has shown today), not an absolute scale, so a quiet day and a violent one both
                    use the full range. Hover a cell for the exact number. Scroll horizontally for earlier in the day. Blue/orange
                    here, not green/red - the chart's own R/S wall lines already use green/red for a different meaning (which
                    side, how heavy), so this uses its own separate color language for "added vs removed."
                  </Text>
                  <Space size={16}>
                    <Text style={{ color: OI_ADDED_COLOR }}>■ OI added</Text>
                    <Text style={{ color: OI_REMOVED_COLOR }}>■ OI removed</Text>
                  </Space>
                  <div>
                    <Text strong style={{ fontSize: 12 }}>CE</Text>
                    <OiChangeHeatmapPlot label="CE" byStrike={ceByStrike} strikes={heatmapStrikes} atmStrike={atmStrike} />
                  </div>
                  <div>
                    <Text strong style={{ fontSize: 12 }}>PE</Text>
                    <OiChangeHeatmapPlot label="PE" byStrike={peByStrike} strikes={heatmapStrikes} atmStrike={atmStrike} />
                  </div>
                </Space>
              </Card>
            )}

            <Row gutter={[16, 16]}>
              <Col xs={24} md={visibleSections.includes('entryCharts') ? 8 : 24}>
                <Card size="small" title="Spot (replaying)">
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
                    {!isToday && (
                      <>
                        <Button
                          icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                          onClick={() => setPlaying((p) => !p)}
                          disabled={oneMinBars.length === 0 || manualVisibleCount >= oneMinBars.length}
                        >
                          {playing ? 'Pause' : 'Start'}
                        </Button>
                        <Button
                          icon={<ReloadOutlined />}
                          onClick={() => { setPlaying(false); setManualVisibleCount(oneMinBars.length > 0 ? 1 : 0) }}
                        >
                          Reset
                        </Button>
                        <Text type="secondary" style={{ fontSize: 12 }}>Speed</Text>
                        <Select value={speedMs} onChange={setSpeedMs} style={{ width: 90 }} options={SPEED_OPTIONS} />
                        <div style={{ flex: 1, minWidth: 160 }}>
                          <Slider
                            min={0} max={Math.max(0, oneMinBars.length - 1)} value={visibleCount - 1}
                            onChange={(v) => { setPlaying(false); setManualVisibleCount(v + 1) }}
                            tooltip={{ formatter: (v) => oneMinBars[v] ? istTimeFormatter(oneMinBars[v].time) : '' }}
                          />
                        </div>
                      </>
                    )}
                    <Text style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                      {currentBar ? `${istTimeFormatter(currentBar.time)} (${visibleCount}/${oneMinBars.length})` : '—'}
                    </Text>
                    {isToday && liveFeedSupported && (
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
                  {paperPanelOpen && (
                    <DraggableFloatingPanel
                      title="Paper trade" pos={paperPanelPos} onPosChange={setPaperPanelPos}
                      onClose={() => setPaperPanelOpen(false)}
                    >
                      <PaperTradePanel
                        atmStrike={atmStrike} step={step}
                        side={paperSide} onSideChange={setPaperSide}
                        direction={paperDirection} onDirectionChange={setPaperDirection}
                        strikeOffset={paperStrikeOffset} onStrikeOffsetChange={setPaperStrikeOffset}
                        qtyLots={paperQtyLots} onQtyLotsChange={setPaperQtyLots}
                        slPoints={paperSlPoints} onSlPointsChange={setPaperSlPoints}
                        targetPoints={paperTargetPoints} onTargetPointsChange={setPaperTargetPoints}
                        onPunch={handlePaperPunch} canPunch={atmStrike != null && paperEntryPreview?.price != null}
                        positions={enrichedPaperPositions} onExit={handlePaperExit} onExitAll={handlePaperExitAll} onClearAll={handlePaperClearAll}
                      />
                    </DraggableFloatingPanel>
                  )}
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
                      <ChartErrorBoundary key={`${underlying}-${result.date}-${timeframe}`}>
                        <ReplayChart
                          bars={displayBars}
                          ladderRows={ladderRows}
                          dayKey={`${underlying}-${result.date}-${timeframe}`}
                          atmStrike={atmStrike}
                          step={step}
                          top5Only={top5WallsOnly}
                          vwapSeries={vwapSeries}
                          showVwap={showVwap}
                          onStrikeClick={setDrilldownStrike}
                          height={560}
                        />
                      </ChartErrorBoundary>
                    )
                    : <Empty description="No spot candles for this day." />}
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
                            />
                          </ChartErrorBoundary>
                        )
                        : <Empty description="No spot candles for this day." />}
                    </Card>
                  </Col>
                </>
              )}
            </Row>

            {visibleSections.includes('optionPremium') && (
              <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
                <Col span={24} style={{ marginBottom: 8 }}>
                  <Space size={12} wrap>
                    <Text type="secondary" style={{ fontSize: 12 }}>Shift ATM (both)</Text>
                    <Select
                      value={cePremiumOffset === pePremiumOffset ? cePremiumOffset : null}
                      placeholder="Mixed"
                      onChange={(v) => { setCePremiumOffset(v); setPePremiumOffset(v) }}
                      style={{ width: 160 }} options={premiumStrikeOptions} disabled={atmStrike == null}
                    />
                  </Space>
                </Col>
                <Col xs={24} md={12}>
                  <Card
                    size="small"
                    title={`CE premium ${cePremiumStrike ?? ''}`}
                    extra={<Select value={cePremiumOffset} onChange={setCePremiumOffset} style={{ width: 150 }} options={premiumStrikeOptions} disabled={atmStrike == null} />}
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
                              height={320}
                            />
                          </ChartErrorBoundary>
                        )}
                  </Card>
                </Col>
                <Col xs={24} md={12}>
                  <Card
                    size="small"
                    title={`PE premium ${pePremiumStrike ?? ''}`}
                    extra={<Select value={pePremiumOffset} onChange={setPePremiumOffset} style={{ width: 150 }} options={premiumStrikeOptions} disabled={atmStrike == null} />}
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
                              height={320}
                            />
                          </ChartErrorBoundary>
                        )}
                  </Card>
                </Col>
              </Row>
            )}

            <Row gutter={16} style={{ marginTop: 16 }}>
              <Col span={24}>
                <Card size="small" title="OI / IV ladder (nearest expiry, as of the current candle)" bodyStyle={{ maxHeight: 460, overflowY: 'auto' }}>
                  <OiLadder rows={ladderRows} atmStrike={atmStrike} />
                </Card>
              </Col>
            </Row>

            {visibleSections.includes('liquidityMap') && (
              <Row gutter={16} style={{ marginTop: 16 }}>
                <Col span={24}>
                  <Card size="small" title="Liquidity map (imbalance & likely levels, whole band)">
                    <LiquidityMapTable rows={ladderRows} atmStrike={atmStrike} currentPrice={currentBar?.close} />
                  </Card>
                </Col>
              </Row>
            )}

            {visibleSections.includes('futures') && (
              <Row gutter={16} style={{ marginTop: 16 }}>
                <Col span={24}>
                  <Card
                    size="small"
                    title="Futures (nearest listed contract - always live from Dhan, never stored)"
                    extra={
                      <Space size={8}>
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
                        <ChartErrorBoundary key={`futures-${underlying}-${result.date}-${timeframe}`}>
                          <FuturesChart
                            bars={displayFuturesBars}
                            oiLine={futuresOiLine}
                            markers={futuresRegimeMarkers}
                            dayKey={`futures-${underlying}-${result.date}-${timeframe}`}
                            height={320}
                          />
                        </ChartErrorBoundary>
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
                <Text style={{ color: CE_COLOR }}>● CE</Text>
                <Text style={{ color: PE_COLOR }}>● PE</Text>
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
          </Space>
        ) : (
          <Empty description="No OI data yet for this strike." />
        )}
      </Modal>
    </div>
  )
}
