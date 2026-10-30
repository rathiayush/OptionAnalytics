import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, Col, DatePicker, Empty, InputNumber, Row, Segmented, Select, Slider, Space, Switch, Tag, TimePicker, Tooltip, Typography } from 'antd'
import { PauseCircleOutlined, PlayCircleOutlined, ReloadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import * as signalR from '@microsoft/signalr'
import { CandlestickSeries, CrosshairMode, LineSeries } from 'lightweight-charts'
import {
  NavBar, usePersistedState, POLL_HEADERS, UP_COLOR, DOWN_COLOR, AXIS_COLOR, GRID_COLOR, BORDER_COLOR,
  toChartTime, istTimeFormatter, istTickMarkFormatter, istDateKey,
  RECONNECT_RETRY_POLICY, joinAllSignalRGroups, onLiveBatch, syncSignalRGroups,
} from './shared.jsx'
import { mergeFuturesLive, mergeLiveFuturesTicks } from './futuresLive.js'
import { inMarketSession } from './marketSession.js'
import { createZoomableChart } from './chartZoom.js'
import { VolumeProfilePrimitive } from './volumeProfilePrimitive.js'
import { TpoProfilePrimitive, ZoneBoxesPrimitive } from './profilePrimitives.js'
import {
  FETCH_ROWS, MAX_PROFILE_DAYS, PROFILE_ROWS, PROFILE_ROW_CHOICES, barsKnownAt, candlesOf, compositeMarketProfile, dayVolumeProfile,
  lastPeriodRunningAt, marketProfileZones, mergeSpotLive, pastSessionsNeeded, profileSessions, volumeZones, withBackfillBars,
} from './profileZones.js'
import { useFollowReplayClock } from './replaySync.jsx'
import { FoldText } from './FoldText.jsx'
import { chartGrow } from './dashboardLayout.js'
import { alignToBars, sessionVwapFromBars } from './chartVwap.js'

// The Profiles page: a whole page for the volume profile and the market profile (TPO) of an index - its SPOT in
// the top row and its near FUTURES below, one card each, over that instrument's candles in the timeframe picked,
// with the profile's levels and its ZONES drawn as boxes (profileZones.js) and, ticked, the day's VWAP:
//   Volume profile - POC, VAH / VAL; boxes where the most volume traded (each with its HVN) and where it was
//     thin (each with its LVN); the profile's bars at the right edge (buy / sell).
//   Market profile - the TPO letters at the right edge (A = 09:15, a letter each 30 minutes); boxes where the
//     market accepted price (the value area and its busiest rows) and where it did not (single prints inside
//     the range, buying / selling tails at its extremes); POC, VAH / VAL and the initial balance.
//
// LIVE (today, kept up to date by the same pushes OI Replay takes - useLiveIndexFeed) or a PAST DAY at a clock - and by default it FOLLOWS OI Replay in
// another tab (replaySync.jsx's clock channel, one way): the same index and day, live or at OI Replay's replay
// clock, so the profiles replay along with it; with no OI Replay running (a phone: one tab, or OI Replay's frozen in
// the background) it opens where OI Replay was last left (replayClockStore.js). Nothing after the clock is in either
// profile (barsKnownAt).
// The futures are the Order Flow server's futures day (footprint rows - the buy and sell at each price), the same
// the Order Flow page replays; a past day the server did not record comes estimated from 1-minute candles. The
// spot is the index's 1-minute bars with its own volume (GET /api/oi-replay/{u}/spot-day - today the spot feed's
// memory, a past day kept on disk). Index volume has no buy / sell side: the spot's bars are one colour.

const { Text } = Typography
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX']
const TIMEFRAMES = [1, 3, 5, 15, 30]
// The right part of the time axis left empty for the profile drawn there (a share of the plot).
const PROFILE_ROOM = { vp: 0.3, tpo: 0.28 }
const fmt = (v) => (v == null || !Number.isFinite(v) ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }))
const fmtClock = (ms) => (ms == null ? '' : istTimeFormatter(toChartTime(ms)))

const STORE = {
  underlying: 'optionanalytics.profiles.underlying',
  timeframe: 'optionanalytics.profiles.timeframe',
  rows: 'optionanalytics.profiles.rows',
  of: 'optionanalytics.profiles.of',
  days: 'optionanalytics.profiles.days',
  follow: 'optionanalytics.profiles.followOiReplay',
  vwap: 'optionanalytics.profiles.vwap',
  speed: 'optionanalytics.profiles.speedMs',
}
// A past day's replay, as OI Replay's: milliseconds per market minute.
const SPEED_OPTIONS = [
  { value: 2000, label: '0.5x' },
  { value: 1000, label: '1x' },
  { value: 500, label: '2x' },
  { value: 250, label: '4x' },
  { value: 100, label: '10x' },
]

// The boxes' colours: the volume profile's busy areas green, thin ones red; the market profile's accepted
// areas teal, single prints orange, tails magenta. The value area is a faint dashed frame on both.
const BOX = {
  value: { fill: 'rgba(155,140,255,0.045)', stroke: 'rgba(155,140,255,0.55)', dashed: true, labelColor: '#b9adff' },
  high: { fill: 'rgba(82,196,26,0.15)', stroke: 'rgba(115,209,61,0.75)', labelColor: '#95de64' },
  low: { fill: 'rgba(245,34,45,0.14)', stroke: 'rgba(255,77,79,0.75)', labelColor: '#ff7875' },
  accepted: { fill: 'rgba(54,207,201,0.18)', stroke: 'rgba(54,207,201,0.8)', labelColor: '#5cdbd3' },
  acceptedValue: { fill: 'rgba(54,207,201,0.05)', stroke: 'rgba(54,207,201,0.5)', dashed: true, labelColor: '#87e8de' },
  single: { fill: 'rgba(255,122,69,0.2)', stroke: 'rgba(255,122,69,0.85)', labelColor: '#ff9c6e' },
  tail: { fill: 'rgba(235,47,150,0.18)', stroke: 'rgba(235,47,150,0.85)', labelColor: '#ff85c0' },
}
const LINE = { poc: '#fadb14', va: '#9b8cff', ib: '#faad14', hvn: '#73d13d', lvn: '#ff4d4f' }
const VWAP_COLOR = '#e072e8'

// ---- data ------------------------------------------------------------------------------------------------

const dayUrl = {
  // backfillBars: a day the server recorded only from part way (a restart) comes with the minutes before as estimated bars.
  futures: (u, d) => `/api/order-flow/${u}/day/${d}?rowSize=${FETCH_ROWS[u] ?? 1}&minTradeLots=100000&heatmapColumns=50&backfillBars=true`,
  spot: (u, d) => `/api/oi-replay/${u}/spot-day?date=${d}`,
}

/** One instrument's day ("futures" | "spot"), loaded once: { loading, error, day: { key, bars, source, contract }, retry }.
 *  Nothing here refreshes it on a timer - live, the pushes carry it on (useLiveIndexFeed); `reload` loads it again
 *  (after the live connection was lost, for the minutes it missed).
 *  A load that FAILED is asked again once by itself, 10 s later, and then only by `retry()` (the card's Retry, or OI
 *  Replay having just loaded the same day): a past futures day can fail while the server is still fetching it from
 *  Dhan / NSE - for OI Replay at the same moment - and without asking again the futures stayed on the error while the
 *  spot had moved on. Once a day, never a loop of a failing request. */
function useInstrumentDay(kind, underlying, dateKey, reload = 0) {
  const [state, setState] = useState({ loading: false, error: null, day: null })
  const [attempt, setAttempt] = useState(0)
  const autoRetriedRef = useRef(null)
  const retry = useCallback(() => setAttempt((a) => a + 1), [])
  useEffect(() => {
    const key = `${kind}|${underlying}|${dateKey}`
    if (!state.error || autoRetriedRef.current === key) return undefined
    const id = setTimeout(() => { autoRetriedRef.current = key; setAttempt((a) => a + 1) }, 10_000)
    return () => clearTimeout(id)
  }, [state.error, kind, underlying, dateKey])
  useEffect(() => {
    if (!underlying || !dateKey) return undefined
    let cancelled = false
    const key = `${kind}|${underlying}|${dateKey}`
    setState((s) => ({ loading: true, error: null, day: s.day?.key === key ? s.day : null }))
    fetch(dayUrl[kind](underlying, dateKey))
      .then((r) => (r.ok ? r.json() : r.json().catch(() => ({})).then((b) => Promise.reject(new Error(b?.error ?? `HTTP ${r.status}`)))))
      .then((body) => {
        if (cancelled) return
        if (kind === 'spot' && !body.success) throw new Error(body.error ?? 'no spot candles')
        setState({ loading: false, error: null, day: { key, ...dayBars(kind, body), source: body.source, contract: body.meta?.contractSymbol } })
      })
      .catch((err) => { if (!cancelled) setState((s) => ({ ...s, loading: false, error: err.message })) })
    return () => { cancelled = true }
  }, [kind, underlying, dateKey, reload, attempt])
  return useMemo(() => ({ ...state, retry }), [state, retry])
}

/** The live feed OI Replay listens to: the "/hubs/spot" connection, group "u:{index}" while `enabled` (live), and its
 *  conflated "liveBatch" (shared.jsx onLiveBatch - the newest state only, acknowledged after paint, so the page never
 *  falls behind): "spotUpdate" (the index's forming minute - OHLC; Dhan's index ticks carry no volume) and
 *  "futuresTicks" (the near futures, with Dhan's day volume). One connection for the page's life; only the group
 *  follows the index. A reconnect joins again and says so (onReconnected - the day is loaded again for what it missed). */
function useLiveIndexFeed(underlying, enabled, handlers) {
  const handlersRef = useRef(handlers)
  handlersRef.current = handlers
  const connectionRef = useRef(null)
  const groupsRef = useRef([])
  useEffect(() => {
    const connection = new signalR.HubConnectionBuilder().withUrl('/hubs/spot').withAutomaticReconnect(RECONNECT_RETRY_POLICY).build()
    connectionRef.current = connection
    onLiveBatch(connection, {
      spotUpdate: (snapshot) => handlersRef.current.onSpot?.(snapshot),
      futuresTicks: (ticks) => handlersRef.current.onFutures?.(ticks ?? []),
    })
    connection.onreconnected(() => { joinAllSignalRGroups(connection, groupsRef.current); handlersRef.current.onReconnected?.() })
    connection.start()
      .then(() => joinAllSignalRGroups(connection, groupsRef.current))
      .catch((err) => { if (err?.name !== 'AbortError') console.error('Profiles live feed connection failed:', err) })
    return () => { connectionRef.current = null; connection.stop() }
  }, [])
  useEffect(() => {
    const groups = enabled && underlying ? [`u:${underlying}`] : []
    syncSignalRGroups(connectionRef.current, groupsRef.current, groups)
    groupsRef.current = groups
  }, [underlying, enabled])
}

/** A day's bars from its answer: the futures' recorded minutes with, where the server only recorded from part way (it
 *  restarted), the minutes before filled from its estimate - `estimatedBefore` then says from when it recorded. */
function dayBars(kind, body) {
  const backfill = kind === 'futures' ? body.backfillBars ?? [] : []
  return { bars: withBackfillBars(body.bars ?? [], backfill), estimatedBefore: backfill.length ? body.recordedFrom ?? null : null }
}

// A past day never changes: kept here once fetched (this tab only), so changing "Days", the row or "Profile of" asks
// the server nothing again. Only what came back is kept - a failure is asked again next time.
const PAST_DAY_CACHE = new Map()
const PAST_DAY_CACHE_MAX = 120
async function fetchPastDay(kind, underlying, dateKey) {
  const key = `${kind}|${underlying}|${dateKey}`
  if (PAST_DAY_CACHE.has(key)) return PAST_DAY_CACHE.get(key)
  const r = await fetch(dayUrl[kind](underlying, dateKey))
  let day = null
  if (r.ok) {
    const body = await r.json()
    // The spot answers 200 with success false for a day with no candles (a holiday - or a failure: not kept).
    if (kind === 'spot' && !body.success) return { date: dateKey, bars: [], source: null }
    const { bars, estimatedBefore } = dayBars(kind, body)
    day = { date: dateKey, bars: barsKnownAt(bars, null), source: estimatedBefore ? 'estimated' : body.source }
  } else if (r.status === 404) {
    // No futures day there (a holiday) is an answer too: an empty session.
    day = { date: dateKey, bars: [], source: null }
  } else {
    throw new Error(`HTTP ${r.status}`)
  }
  PAST_DAY_CACHE.set(key, day)
  if (PAST_DAY_CACHE.size > PAST_DAY_CACHE_MAX) PAST_DAY_CACHE.delete(PAST_DAY_CACHE.keys().next().value)
  return day
}

/** The `count` trading sessions of one instrument before `dateKey`, oldest first: weekdays walked back one at a time
 *  (one request at a time - a past day the server does not hold is fetched from Dhan the first time), a day with no
 *  minutes (a holiday) stepped over, `count` + 10 weekdays at most. Sessions come in as they load. */
function usePastSessions(kind, underlying, dateKey, count) {
  const [state, setState] = useState({ key: null, loading: false, sessions: [], error: null })
  const want = `${kind}|${underlying}|${dateKey}|${count}`
  useEffect(() => {
    if (!underlying || !dateKey || count <= 0) return undefined
    let cancelled = false
    setState({ key: want, loading: true, sessions: [], error: null })
    ;(async () => {
      const found = []
      let day = dayjs(dateKey)
      let error = null
      for (let tries = 0; found.length < count && tries < count + 10;) {
        day = day.subtract(1, 'day')
        if (day.day() === 0 || day.day() === 6) continue
        tries++
        try {
          const session = await fetchPastDay(kind, underlying, day.format('YYYY-MM-DD'))
          if (cancelled) return
          if (session.bars.length) {
            found.unshift(session)
            setState({ key: want, loading: found.length < count, sessions: [...found], error: null })
          }
        } catch (err) {
          if (cancelled) return
          error = err.message
        }
      }
      if (!cancelled) setState({ key: want, loading: false, sessions: found, error: found.length < count ? error : null })
    })()
    return () => { cancelled = true }
  }, [want]) // eslint-disable-line react-hooks/exhaustive-deps
  return state.key === want ? state : { loading: count > 0, sessions: [], error: null }
}

// ---- the chart -------------------------------------------------------------------------------------------

/** Candles with a profile drawn at the right edge (`drawProfile(primitive)` sets it), zone boxes and
 *  price lines. The time axis keeps `room` of the plot empty on the right, so the newest candles never sit
 *  under the profile; a drag, a pinch, the wheel, the zoom buttons or the price axis take over the view - live updates
 *  leave it where it was put - and a double-click (a double tap, ⟲) hands it back. */
function ProfileChart({ candles, vwap = null, makePrimitive, drawProfile, zones, lines, priceRange, room, height, resetKey }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const vwapRef = useRef(null)
  const profileRef = useRef(null)
  const boxesRef = useRef(null)
  const linesRef = useRef([])
  const rangeRef = useRef(priceRange)
  rangeRef.current = priceRange
  const userMovedRef = useRef(false)
  // The pointers down on the chart now (a finger, two for a pinch, the mouse): while any is, an update does not fit the
  // view. Live, a push came every second and put the chart back under the finger - it could not be dragged at all.
  const pointersRef = useRef(new Set())
  const countRef = useRef(0)

  const fit = useCallback(() => {
    const chart = chartRef.current
    const n = countRef.current
    if (!chart || n === 0) return
    chart.timeScale().setVisibleLogicalRange({ from: -0.5, to: n - 0.5 + Math.max(6, Math.ceil(n * room / (1 - room))) })
  }, [room])

  useEffect(() => {
    const element = containerRef.current
    if (!element) return undefined
    const chart = createZoomableChart(element, {
      width: element.clientWidth,
      height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR, scaleMargins: { top: 0.06, bottom: 0.06 } },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter, shiftVisibleRangeOnNewBar: false },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
      // A finger moving UP or DOWN on a chart scrolls the page (a phone's page is nearly all chart - four of them);
      // sideways still pans the time axis, and pinch zooms.
      handleScroll: { vertTouchDrag: false },
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
      // The price scale holds the whole profile too - a previous session's can reach past today's candles.
      autoscaleInfoProvider: (original) => {
        const base = original()
        const r = rangeRef.current
        if (!r) return base
        const lo = Math.min(base?.priceRange?.minValue ?? r.low, r.low)
        const hi = Math.max(base?.priceRange?.maxValue ?? r.high, r.high)
        return { ...(base ?? {}), priceRange: { minValue: lo, maxValue: hi } }
      },
    })
    // The day's VWAP - its points are the candles' own times (alignToBars), so it adds nothing to the time axis.
    vwapRef.current = chart.addSeries(LineSeries, { color: VWAP_COLOR, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'VWAP', crosshairMarkerVisible: false })
    boxesRef.current = new ZoneBoxesPrimitive()
    series.attachPrimitive(boxesRef.current)
    profileRef.current = makePrimitive()
    series.attachPrimitive(profileRef.current)
    chartRef.current = chart
    seriesRef.current = series

    const observer = new ResizeObserver(([entry]) => chart.applyOptions({ width: Math.floor(entry.contentRect.width) }))
    observer.observe(element)
    // The viewer moved the view - the time axis dragged, pinched or zoomed, or the prices zoomed / dragged (their
    // auto-scale off): leave it there, live updates included. A double-click (a double tap, ⟲) fits the day again.
    const visible = () => chart.timeScale().getVisibleLogicalRange()
    const pointers = pointersRef.current
    let before = null, moved = false, resetSincePress = false
    const onRange = () => { if (pointers.size) moved = true }
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)
    const press = (e) => {
      if (!pointers.size) { before = visible(); moved = false; resetSincePress = false }
      pointers.add(e.pointerId)
    }
    const release = (e) => {
      if (!pointers.delete(e.pointerId) || pointers.size) return
      const after = visible()
      const shifted = before && after && (Math.abs(after.from - before.from) > 0.5 || Math.abs(after.to - before.to) > 0.5)
      if (!resetSincePress && (moved || shifted || chart.priceScale('right').options().autoScale === false)) userMovedRef.current = true
      before = null
    }
    const wheel = () => { userMovedRef.current = true }
    const reset = () => {
      userMovedRef.current = false
      resetSincePress = true
      requestAnimationFrame(() => { chart.priceScale('right').applyOptions({ autoScale: true }); fit() })
    }
    element.addEventListener('pointerdown', press, true)
    // A finger's gesture the browser takes over (scrolling the page) ends in pointercancel, not pointerup.
    window.addEventListener('pointerup', release, true)
    window.addEventListener('pointercancel', release, true)
    element.addEventListener('wheel', wheel, { passive: true, capture: true })
    element.addEventListener('dblclick', reset, true)
    return () => {
      observer.disconnect()
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange)
      pointers.clear()
      element.removeEventListener('pointerdown', press, true)
      window.removeEventListener('pointerup', release, true)
      window.removeEventListener('pointercancel', release, true)
      element.removeEventListener('wheel', wheel, { capture: true })
      element.removeEventListener('dblclick', reset, true)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      vwapRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => { chartRef.current?.applyOptions({ height }) }, [height])
  // A new day, index or timeframe: the view is the chart's again.
  useEffect(() => { userMovedRef.current = false }, [resetKey])

  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    series.setData(candles.map((c) => ({ time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close })))
    countRef.current = candles.length
    if (!userMovedRef.current && !pointersRef.current.size) fit()
  }, [candles, fit])

  useEffect(() => { vwapRef.current?.setData(vwap ?? []) }, [vwap])
  useEffect(() => { if (profileRef.current) drawProfile(profileRef.current) }, [drawProfile])
  useEffect(() => { boxesRef.current?.setZones(zones) }, [zones])
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    for (const line of linesRef.current) series.removePriceLine(line)
    linesRef.current = (lines ?? []).filter((l) => Number.isFinite(l.price)).map((l) => series.createPriceLine({
      price: l.price, color: l.color, title: l.title, lineWidth: l.width ?? 1, lineStyle: l.style ?? 0, axisLabelVisible: true,
    }))
  }, [lines])
  // A new profile range: fit the prices to it again (unless the viewer took the view, or has a finger on it).
  useEffect(() => {
    if (!userMovedRef.current && !pointersRef.current.size) chartRef.current?.priceScale('right').applyOptions({ autoScale: true })
  }, [priceRange])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}


// ---- one instrument's two cards --------------------------------------------------------------------------

const zoneLabel = {
  high: (z) => `${z.poc ? 'POC area' : 'HVN'} ${fmt(z.node)} · ${Math.round(z.share * 100)}% of volume`,
  low: (z) => `LVN ${fmt(z.node)} · thin volume`,
  single: (z) => `Single prints${z.forming ? ' (forming)' : ''}`,
  tail: (z) => `${z.side === 'selling' ? 'Selling' : 'Buying'} tail${z.forming ? ' (forming)' : ''}`,
  accepted: (z) => (z.poc ? 'Most time spent (POC)' : 'Time spent - accepted'),
}

function Legend({ items }) {
  return (
    <Space size={[10, 4]} wrap>
      {items.map(([key, label]) => (
        <span key={label} style={{ fontSize: 11, color: AXIS_COLOR, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 14, height: 10, background: BOX[key].fill, border: `1px ${BOX[key].dashed ? 'dashed' : 'solid'} ${BOX[key].stroke}`, display: 'inline-block' }} />
          {label}
        </span>
      ))}
    </Space>
  )
}

const volumeOf = (b) => b.volume ?? (b.buy ?? 0) + (b.sell ?? 0)
const NO_BARS = []

/** The charts' height: 62% of the window, 360 - 560 px (OI Replay's own cap, chartGrow) - a phone sees a whole chart
 *  and a bit of its card. The window's height is read again on a new WIDTH only: a phone's browser bar coming and
 *  going must not make the charts jump. */
function useChartHeight() {
  const [height, setHeight] = useState(() => chartGrow(window.innerHeight).cap)
  useEffect(() => {
    let width = window.innerWidth
    const onResize = () => {
      if (window.innerWidth === width) return
      width = window.innerWidth
      setHeight(chartGrow(window.innerHeight).cap)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return height
}

/** The volume profile card and the market profile card of ONE instrument (the spot, or the futures): `known` - its
 *  bars of the day known at the clock; `past` - its sessions before the day ({ date, bars }, oldest first). `neutral`:
 *  the volume has no buy / sell side (the index's) - its bars are one colour. */
function ProfilePair({ name, known, past, dayCount, profileOf, clock, live, row, timeframe, showVwap, resetKey, neutral = false, empty = null, dayError = null }) {
  const sessions = useMemo(
    () => profileSessions({ today: known, past: past.map((d) => d.bars), days: dayCount, of: profileOf }),
    [known, past, dayCount, profileOf],
  )
  const profileBars = useMemo(() => sessions.flat(), [sessions])
  const chartHeight = useChartHeight()
  // LIVE, no minute of today yet (before the open, a holiday) while the profile is built from earlier sessions: a chart
  // with no candles has no price scale, so the profile and its boxes could not be drawn at all. The latest earlier
  // session's candles stand in until today's first minute, and the card says so. Never for a past day replayed: that
  // day starts fresh, its own first minute, like OI Replay's.
  const standIn = live && !known.length ? past.at(-1) ?? null : null
  const candleBars = known.length ? known : standIn?.bars ?? NO_BARS
  const candles = useMemo(() => candlesOf(candleBars, timeframe), [candleBars, timeframe])
  // The VWAP of the day drawn (VwapCalculator's way): typical price x volume over the 1-minute bars, then each candle's
  // value at its last minute.
  const vwap = useMemo(() => {
    if (!showVwap || !candles.length) return null
    const minute = sessionVwapFromBars(candleBars.map((b) => ({ time: toChartTime(b.time), high: b.high, low: b.low, close: b.close, volume: volumeOf(b) })))
    return minute ? alignToBars(minute, candles.map((c) => ({ time: toChartTime(c.time) }))) : null
  }, [showVwap, candleBars, candles])
  const standInNote = standIn && !empty && (
    <Text type="secondary" style={{ fontSize: 11 }}>No minute of the day yet{dayError ? ` (${dayError})` : ''} - the candles are {standIn.date}&apos;s, the last session in the profile.</Text>
  )

  const vp = useMemo(() => dayVolumeProfile(profileBars, row), [profileBars, row])
  const hasVolume = vp.rows.length > 0
  const vz = useMemo(() => volumeZones(vp, row), [vp, row])
  const tpo = useMemo(() => compositeMarketProfile(sessions, row), [sessions, row])
  // "Forming" is read for a profile of the day alone - in a composite an older session's letter is the same letter.
  const running = profileOf === 'today' && sessions.length === 1 && lastPeriodRunningAt(known, clock)
  const mz = useMemo(() => marketProfileZones(tpo, { lastPeriodRunning: running }), [tpo, running])

  const vpZones = useMemo(() => {
    const out = []
    if (vp.val != null) out.push({ ...BOX.value, low: vp.val, high: vp.vah + row, label: 'Value area (70% of volume)' })
    for (const z of vz.high) out.push({ ...BOX.high, low: z.low, high: z.high, label: zoneLabel.high(z) })
    for (const z of vz.low) out.push({ ...BOX.low, low: z.low, high: z.high, label: zoneLabel.low(z) })
    return out
  }, [vp, vz, row])
  const mpZones = useMemo(() => {
    const out = []
    if (mz.value) out.push({ ...BOX.acceptedValue, low: mz.value.low, high: mz.value.high, label: 'Value area - accepted (70% of TPOs)' })
    for (const z of mz.accepted) out.push({ ...BOX.accepted, low: z.low, high: z.high, label: zoneLabel.accepted(z) })
    for (const z of mz.singles) out.push({ ...BOX.single, low: z.low, high: z.high, label: zoneLabel.single(z) })
    for (const z of mz.tails) out.push({ ...BOX.tail, low: z.low, high: z.high, label: zoneLabel.tail(z) })
    return out
  }, [mz])
  // POC, VAH / VAL - and ONE line for the HVN (the busiest row of the busy boxes, the POC's own aside) and ONE for the LVN
  // (the thinnest row of the thin boxes), labelled on the price axis like the others; the boxes still show every area.
  const vpLines = useMemo(() => (vp.poc == null ? [] : [
    { price: vp.poc + row / 2, color: LINE.poc, title: 'POC', width: 2 },
    { price: vp.vah + row, color: LINE.va, title: 'VAH', style: 2 },
    { price: vp.val, color: LINE.va, title: 'VAL', style: 2 },
    ...(vz.topHvn != null ? [{ price: vz.topHvn, color: LINE.hvn, title: 'HVN', style: 3 }] : []),
    ...(vz.thinLvn != null ? [{ price: vz.thinLvn, color: LINE.lvn, title: 'LVN', style: 3 }] : []),
  ]), [vp, vz, row])
  const mpLines = useMemo(() => (!tpo ? [] : [
    { price: tpo.poc + row / 2, color: LINE.poc, title: 'TPO POC', width: 2 },
    { price: tpo.vah + row, color: LINE.va, title: 'VAH', style: 2 },
    { price: tpo.val, color: LINE.va, title: 'VAL', style: 2 },
    ...(tpo.ib ? [{ price: tpo.ib.high, color: LINE.ib, title: 'IB high', style: 1 }, { price: tpo.ib.low, color: LINE.ib, title: 'IB low', style: 1 }] : []),
  ]), [tpo, row])
  const vpRange = useMemo(() => (hasVolume ? { low: vp.rows[0].price, high: vp.rows.at(-1).price + row } : null), [vp, row, hasVolume])
  const tpoRange = useMemo(() => (tpo?.rows?.length ? { low: tpo.rows[0].price, high: tpo.rows.at(-1).price + row } : null), [tpo, row])
  // The index's volume has no side: its rows drawn as one neutral bar each.
  const drawVp = useCallback((p) => p.setProfile(hasVolume ? (neutral ? { ...vp, rows: vp.rows.map((r) => ({ price: r.price, buy: 0, sell: 0, total: r.total })) } : vp) : null, row), [vp, row, neutral, hasVolume])
  const singlePrices = useMemo(() => {
    const set = []
    for (const z of [...mz.singles, ...mz.tails]) for (let p = z.low; p < z.high - 1e-9; p = Math.round((p + row) * 100) / 100) set.push(p)
    return set
  }, [mz, row])
  const drawTpo = useCallback((p) => p.setProfile(tpo, singlePrices), [tpo, singlePrices])
  const makeVp = useCallback(() => new VolumeProfilePrimitive(), [])
  const makeTpo = useCallback(() => new TpoProfilePrimitive(), [])
  const many = sessions.length > 1 ? ` · ${sessions.length} sessions` : ''
  const extra = <Text type="secondary" style={{ fontSize: 11 }}>double-click: fit</Text>

  return (
    <Row gutter={[14, 14]}>
      <Col xs={24} xl={12}>
        <Card size="small" title={`${name} · Volume profile${many}`} extra={extra}>
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            <Space size={[12, 2]} wrap style={{ fontSize: 12 }}>
              <span style={{ color: LINE.poc }}>POC {fmt(vp.poc == null ? null : vp.poc + row / 2)}</span>
              <span style={{ color: LINE.va }}>VAH {fmt(vp.vah == null ? null : vp.vah + row)} · VAL {fmt(vp.val)}</span>
              <span style={{ color: BOX.high.labelColor }}>HVN {fmt(vz.topHvn)}</span>
              <span style={{ color: BOX.low.labelColor }}>LVN {fmt(vz.thinLvn)}</span>
            </Space>
            <Legend items={[['high', 'Highest volume (HVN area)'], ['low', 'Thin volume (LVN area)'], ['value', 'Value area']]} />
            {empty ?? (!hasVolume && profileBars.length > 0 && (
              <Alert type="info" showIcon message={`No ${name.toLowerCase()} volume for ${sessions.length > 1 ? 'these sessions' : 'this day'} - Dhan sends the index's own volume from January 2026. The market profile (time, not volume) still shows.`} />
            ))}
            {standInNote}
            {empty ? null : (
              <ProfileChart
                candles={candles} vwap={vwap} makePrimitive={makeVp} drawProfile={drawVp} zones={vpZones} lines={vpLines}
                priceRange={vpRange} room={PROFILE_ROOM.vp} height={chartHeight} resetKey={resetKey}
              />
            )}
            <FoldText id="profiles.vp" label="how to read the volume profile" className="oa-note">
              <Text type="secondary" style={{ fontSize: 11 }}>
                The bars at the right are the volume traded at each price ({row}-point rows; on the futures green bought at the
                offer, red sold at the bid - the index&apos;s own volume has no side, so the spot&apos;s are one colour). POC = the
                price that traded the most; VAH / VAL = the band holding 70% of the volume. GREEN boxes are where the most volume
                traded - prices the market agreed on, which tend to hold price (support / resistance, a magnet when price is near);
                each names its HVN, its busiest row; the green dashed HVN line marks the busiest of them (the POC aside). RED boxes are where volume was thin inside the range - prices the market moved
                through fast, which it tends to cross fast again: a break into one often runs to the far side; the red dashed LVN line marks the thinnest row of them. A thin edge at the
                day&apos;s high or low is not a box (price only got there briefly). Busy = at least 1.3x the average row, thin = 0.6x
                or less (smoothed over three rows). With Days above 1 it is every session&apos;s volume at each price added up - the
                levels several days agreed on. The pink line is the day&apos;s VWAP (the &quot;VWAP&quot; tick).
              </Text>
            </FoldText>
          </Space>
        </Card>
      </Col>
      <Col xs={24} xl={12}>
        <Card size="small" title={`${name} · Market profile (TPO)${many}`} extra={extra}>
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            <Space size={[12, 2]} wrap style={{ fontSize: 12 }}>
              <span style={{ color: LINE.poc }}>POC {fmt(tpo ? tpo.poc + row / 2 : null)}</span>
              <span style={{ color: LINE.va }}>VAH {fmt(tpo ? tpo.vah + row : null)} · VAL {fmt(tpo?.val)}</span>
              <span style={{ color: LINE.ib }}>IB {tpo?.ib ? `${fmt(tpo.ib.low)} – ${fmt(tpo.ib.high)}` : '—'}</span>
              <span style={{ color: BOX.single.labelColor }}>Single prints {mz.singles.length ? mz.singles.map((z) => `${fmt(z.low)}–${fmt(z.high)}`).join(', ') : '—'}</span>
              <span style={{ color: BOX.tail.labelColor }}>Tails {mz.tails.length ? mz.tails.map((z) => `${z.side} ${fmt(z.low)}–${fmt(z.high)}`).join(', ') : '—'}</span>
            </Space>
            <Legend items={[['accepted', 'Most time spent - accepted'], ['acceptedValue', 'Value area'], ['single', 'Single prints'], ['tail', 'Tail (rejected)']]} />
            {standInNote}
            {empty ?? (
              <ProfileChart
                candles={candles} vwap={vwap} makePrimitive={makeTpo} drawProfile={drawTpo} zones={mpZones} lines={mpLines}
                priceRange={tpoRange} room={PROFILE_ROOM.tpo} height={chartHeight} resetKey={resetKey}
              />
            )}
            <FoldText id="profiles.tpo" label="how to read the market profile" className="oa-note">
              <Text type="secondary" style={{ fontSize: 11 }}>
                Each letter at the right is a 30-minute period that traded at that price ({row}-point rows): A = 09:15, B = 09:45, C =
                10:15 and so on (A and B, the initial balance, in amber; blocks instead of letters when the rows are too thin to read).
                The more letters on a row, the more TIME the market spent there. TEAL boxes are where it spent the most - prices it
                accepted (the busiest rows, with the value area, 70% of the TPOs, as a dashed frame): expect rotation there. ORANGE
                boxes are single prints inside the range - one period only, a fast one-sided move; price often comes back to fill
                them, and they act as support / resistance until it does. MAGENTA boxes are tails - single prints at the day&apos;s
                high (selling tail) or low (buying tail), where the auction was rejected. &quot;Forming&quot; = made by the period
                still running: it can still be filled in. With Days above 1 every session&apos;s TPOs are added up (each session
                lettered from A; blocks instead of letters once a row holds too many to read) and the initial balance is the latest
                session&apos;s.
              </Text>
            </FoldText>
          </Space>
        </Card>
      </Col>
    </Row>
  )
}

// ---- the page --------------------------------------------------------------------------------------------

const msOf = (t) => new Date(t).getTime()
// What OI Replay is on, for the "following" tag.
const followClockText = (c) => {
  if (!c) return ''
  if (c.live) return 'live'
  if (c.date) return `${c.date}${c.ms ? ` ${fmtClock(c.ms - 60_000)}` : ''}`
  if (c.loadingDate) return `loading ${c.loadingDate}…`
  if (c.failedDate) return `${c.failedDate} did not load there - shown from this page's own data`
  return 'no day loaded'
}
// OI Replay's last clock, kept in this browser, that the page opened on (no OI Replay running to follow).
const keptClockText = (c) => {
  if (c.live) return 'live'
  const day = c.date ?? c.loadingDate ?? c.failedDate
  return day ? `${day}${c.date && c.ms ? ` ${fmtClock(c.ms - 60_000)}` : ''}` : 'no day loaded'
}
const updatedAt = (at) => new Date(at).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false })

export default function ProfilesPage() {
  const [underlying, setUnderlying] = usePersistedState(STORE.underlying, 'NIFTY')
  const [timeframe, setTimeframe] = usePersistedState(STORE.timeframe, 5)
  const [rows, setRows] = usePersistedState(STORE.rows, PROFILE_ROWS)
  const [profileOf, setProfileOf] = usePersistedState(STORE.of, 'today')
  // How many sessions the profiles cover - 1 is the day itself (or the one session before it).
  const [days, setDays] = usePersistedState(STORE.days, 1)
  const [follow, setFollow] = usePersistedState(STORE.follow, true)
  const [showVwap, setShowVwap] = usePersistedState(STORE.vwap, true)
  const todayKey = istDateKey(new Date())
  const [live, setLive] = useState(true)
  const [dateKey, setDateKey] = useState(todayKey)
  // A past day's replay clock (epoch ms: the END of the newest minute shown) - null = the day's FIRST minute, a fresh
  // day as OI Replay loads one; OI Replay's own clock while following it.
  const [clockMs, setClockMs] = useState(null)
  const [playing, setPlaying] = useState(false)
  const [speedMs, setSpeedMs] = usePersistedState(STORE.speed, 500)

  const index = UNDERLYINGS.includes(underlying) ? underlying : 'NIFTY'
  const row = rows?.[index] > 0 ? rows[index] : PROFILE_ROWS[index]

  // Following OI Replay: its index, its day, its clock.
  const onClock = useCallback((msg) => {
    if (!UNDERLYINGS.includes(msg.underlying)) return
    setUnderlying(msg.underlying)
    if (msg.live) { setLive(true); setDateKey(istDateKey(new Date())); setClockMs(null); setPlaying(false); return }
    if (!msg.date) {
      // OI Replay is loading a past day: this page starts the same day fresh at once - never the old day kept on
      // screen until that load is done. Its clock follows once the day is there.
      // Its load failed: the same day here, as far as this page's own data goes - fresh, like any day opened.
      const day = msg.loadingDate ?? msg.failedDate
      if (day) { setLive(false); setDateKey(day); setClockMs(null); setPlaying(false) }
      return
    }
    setLive(false)
    setDateKey(msg.date)
    setClockMs(msg.ms ?? null)
    setPlaying(false)
  }, [setUnderlying])
  const followed = useFollowReplayClock(follow, onClock)
  const following = follow && followed.connected

  const effectiveDate = live ? todayKey : dateKey
  const dayCount = Math.max(1, Math.min(MAX_PROFILE_DAYS, Math.round(days) || 1))
  const pastCount = pastSessionsNeeded(dayCount, profileOf)
  // Live: what the pushes brought since the day loaded, for this index, day and mode only.
  const liveKey = live ? `${index}|${effectiveDate}` : null
  const [reload, setReload] = useState(0)
  const futures = useInstrumentDay('futures', index, effectiveDate, reload)
  const spot = useInstrumentDay('spot', index, effectiveDate, reload)
  const [liveData, setLiveData] = useState({ key: null, spot: [], feed: [], futures: [], at: null })
  const pushed = liveData.key === liveKey ? liveData : { spot: [], feed: [], futures: [], at: null }
  const updateLive = (change) => setLiveData((d) => {
    const base = d.key === liveKey ? d : { key: liveKey, spot: [], feed: [], futures: [], at: null }
    return { ...base, ...change(base), at: Date.now() }
  })
  // The index's volume is in no tick: the spot feed re-reads each finished minute's from Dhan. So when the push turns
  // to a new minute, the volumes the feed holds are read from its memory - once a minute, never from Dhan.
  const spotMinuteRef = useRef({ key: null, minute: null })
  const readingFeedRef = useRef(false)
  const readSpotFeed = () => {
    if (readingFeedRef.current) return
    readingFeedRef.current = true
    const key = liveKey
    fetch(`/api/spot/${index}/volume-candles`, { headers: POLL_HEADERS })
      .then((r) => (r.ok ? r.json() : []))
      .then((bars) => {
        const day = (bars ?? []).filter((b) => istDateKey(b.time) === effectiveDate && inMarketSession(b.time))
        setLiveData((d) => (d.key === key ? { ...d, feed: day } : d))
      })
      .catch(() => { /* the next minute reads it again; what was loaded stays */ })
      .finally(() => { readingFeedRef.current = false })
  }
  useLiveIndexFeed(index, live, {
    onSpot: (snapshot) => {
      const bar = snapshot?.currentBar
      if (!live || snapshot?.underlying !== index || !bar || !inMarketSession(bar.time)) return
      const minute = Math.floor(new Date(bar.time).getTime() / 60_000)
      const seen = spotMinuteRef.current
      if (seen.key === liveKey && seen.minute != null && minute > seen.minute) readSpotFeed()
      spotMinuteRef.current = { key: liveKey, minute }
      updateLive((d) => ({ spot: [...d.spot.filter((b) => b.time !== bar.time), bar] }))
    },
    onFutures: (ticks) => {
      const mine = ticks.filter((t) => t?.underlying === index)
      if (live && mine.length) updateLive((d) => ({ futures: mergeLiveFuturesTicks(d.futures, mine) }))
    },
    onReconnected: () => setReload((r) => r + 1),
  })
  // OI Replay has just loaded the day this page failed on: the server has fetched it now - ask once more.
  const retriedForRef = useRef(null)
  const oiDay = following ? followed.clock?.date ?? null : null
  useEffect(() => {
    if (!oiDay || oiDay !== effectiveDate || retriedForRef.current === oiDay || (!futures.error && !spot.error)) return
    retriedForRef.current = oiDay
    if (futures.error) futures.retry()
    if (spot.error) spot.retry()
  }, [oiDay, effectiveDate, futures, spot])
  const futuresPast = usePastSessions('futures', index, effectiveDate, pastCount)
  const spotPast = usePastSessions('spot', index, effectiveDate, pastCount)
  const loadedFutures = futures.day?.key === `futures|${index}|${effectiveDate}` ? futures.day : null
  const loadedSpot = spot.day?.key === `spot|${index}|${effectiveDate}` ? spot.day : null
  // The day as it stands: loaded, plus - live - the pushes since (the futures' minutes after the load are candles, their
  // volume spread over their range like OI Replay's futures profile; the loaded minutes keep their buy / sell rows).
  const futuresDay = useMemo(() => (loadedFutures && live && pushed.futures.length ? { ...loadedFutures, bars: mergeFuturesLive(loadedFutures.bars, pushed.futures) } : loadedFutures), [loadedFutures, live, pushed.futures])
  const spotDay = useMemo(() => (loadedSpot && live && (pushed.spot.length || pushed.feed.length) ? { ...loadedSpot, bars: mergeSpotLive(loadedSpot.bars, pushed.feed, pushed.spot) } : loadedSpot), [loadedSpot, live, pushed.spot, pushed.feed])

  // The span a past day's own slider runs over: the first minute's start to the last minute's end, of either.
  const futuresSession = useMemo(() => barsKnownAt(futuresDay?.bars, null), [futuresDay])
  const spotSession = useMemo(() => barsKnownAt(spotDay?.bars, null), [spotDay])
  const ends = [futuresSession, spotSession].filter((b) => b.length)
  const span = ends.length ? { start: Math.min(...ends.map((b) => msOf(b[0].time))) + 60_000, end: Math.max(...ends.map((b) => msOf(b.at(-1).time))) + 60_000 } : null
  // A past day opens FRESH, as OI Replay's does: its first minute only, then played forward - nothing of the day after
  // the clock is on any chart.
  const clock = live ? null : clockMs ?? span?.start ?? null
  const atEnd = !span || (clock ?? span.start) >= span.end

  // Its own replay, as OI Replay's: one market minute every speedMs, stopping at the day's last minute.
  useEffect(() => {
    if (!playing || live || following || !span) return undefined
    const id = setInterval(() => setClockMs((ms) => {
      const next = (ms ?? span.start) + 60_000
      if (next >= span.end) { setPlaying(false); return span.end }
      return next
    }), speedMs)
    return () => clearInterval(id)
  }, [playing, live, following, span?.start, span?.end, speedMs]) // eslint-disable-line react-hooks/exhaustive-deps
  // "Go to": the end of that minute (it shown), held inside the day.
  const goTo = (v) => {
    if (!v || !span) return
    const day = new Date(span.start - 60_000)
    const ist = new Date(day.getTime() + 330 * 60_000)
    const minuteStart = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), v.hour(), v.minute()) - 330 * 60_000
    setPlaying(false)
    setClockMs(Math.max(span.start, Math.min(span.end, minuteStart + 60_000)))
  }

  const futuresKnown = useMemo(() => barsKnownAt(futuresDay?.bars, clock), [futuresDay, clock])
  const spotKnown = useMemo(() => barsKnownAt(spotDay?.bars, clock), [spotDay, clock])
  const resetKey = `${index}|${effectiveDate}|${timeframe}|${profileOf}|${dayCount}`

  // What the profiles cover, in words: "2026-09-28 → 2026-10-02 (5 sessions)" - the futures' sessions (the spot's
  // are the same trading days).
  const usedPast = futuresPast.sessions.slice(-pastCount)
  const coverDates = [...usedPast.map((d) => d.date), ...(profileOf === 'today' && (futuresKnown.length || spotKnown.length) ? [effectiveDate] : [])]
  const coverText = coverDates.length === 0 ? '' : coverDates.length === 1 ? coverDates[0] : `${coverDates[0]} → ${coverDates.at(-1)} (${coverDates.length} sessions)`
  const estimated = (profileOf === 'today' && futuresDay?.source === 'estimated') || usedPast.some((d) => d.source === 'estimated')
  // A replay is named by the minute it shows (as OI Replay's): the clock is that minute's END.
  const asOf = live ? `live${pushed.at ? ` · last tick ${updatedAt(pushed.at)}` : ''}` : clock ? `replay · ${fmtClock(clock - 60_000)} candle` : ''
  const loadingPast = futuresPast.loading || spotPast.loading
  // Nothing of the day yet: the cards say so - unless, live, the profile holds earlier sessions ("Previous", or Days
  // above 1), which they show over the latest one's candles until today's first minute (ProfilePair's stand-in).
  const emptyFor = (state, session, past, what) => {
    if (session.length || (live && pastCount > 0 && past.sessions.length)) return null
    if (state.loading) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`Loading the ${what} of ${effectiveDate}…`} />
    if (state.error) return <Alert type="warning" showIcon message={`The ${what} of ${effectiveDate} is not available: ${state.error}`} action={<Button size="small" onClick={state.retry}>Retry</Button>} />
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={live ? 'No trading today yet - the profiles start with the first minute after 09:15.' : `No ${what} minutes for this day.`} />
  }
  const pair = { dayCount, profileOf, clock, live, row, timeframe, showVwap, resetKey }

  return (
    <div style={{ padding: '16px 16px 32px' }}>
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Typography.Title level={3} style={{ margin: 0 }}>Option Analytics</Typography.Title>
          <NavBar />
        </Space>

        <Card size="small" title="Volume & market profile">
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Space wrap size={[12, 8]} align="center">
              <Tooltip title={following ? 'Following OI Replay - turn Follow off to pick here' : null}>
                <Segmented size="small" value={index} disabled={following} options={UNDERLYINGS} onChange={(v) => { setUnderlying(v); setPlaying(false) }} />
              </Tooltip>
              <Space size={4}>
                <Button size="small" type={live ? 'primary' : 'default'} disabled={following} onClick={() => { setLive(true); setClockMs(null); setPlaying(false) }}>Live</Button>
                <DatePicker
                  size="small" allowClear={false} disabled={following} value={dayjs(effectiveDate)}
                  disabledDate={(d) => d.isAfter(dayjs(), 'day') || d.day() === 0 || d.day() === 6}
                  onChange={(d) => { if (!d) return; setDateKey(d.format('YYYY-MM-DD')); setLive(false); setClockMs(null); setPlaying(false) }}
                />
              </Space>
              <Space size={4}>
                <Text type="secondary" style={{ fontSize: 12 }}>Candles</Text>
                <Select size="small" value={timeframe} onChange={setTimeframe} style={{ width: 84 }} options={TIMEFRAMES.map((t) => ({ value: t, label: `${t} min` }))} />
              </Space>
              <Space size={4}>
                <Text type="secondary" style={{ fontSize: 12 }}>Row</Text>
                <Select size="small" value={row} onChange={(v) => setRows({ ...(rows ?? PROFILE_ROWS), [index]: v })} style={{ width: 84 }} options={(PROFILE_ROW_CHOICES[index] ?? [5]).map((r) => ({ value: r, label: `${r} pts` }))} />
              </Space>
              <Space size={4}>
                <Text type="secondary" style={{ fontSize: 12 }}>Profile of</Text>
                <Segmented size="small" value={profileOf} onChange={setProfileOf} options={[{ value: 'today', label: live ? 'Today so far' : 'This day so far' }, { value: 'previous', label: dayCount > 1 ? 'Previous sessions' : 'Previous session' }]} />
              </Space>
              <Tooltip title={`How many sessions the profiles are built from (a composite). 1 = the day alone. With "${live ? 'Today so far' : 'This day so far'}", the day so far and the sessions before it; with "Previous session", that many sessions before the day.`}>
                <Space size={4}>
                  <Text type="secondary" style={{ fontSize: 12 }}>Days</Text>
                  <InputNumber size="small" min={1} max={MAX_PROFILE_DAYS} value={dayCount} onChange={(v) => { if (v >= 1) setDays(Math.round(v)) }} style={{ width: 64 }} />
                </Space>
              </Tooltip>
              <Tooltip title="The day's VWAP on every chart - typical price x volume over the 1-minute bars, as the server works it out (the spot's on the index's own volume).">
                <Checkbox checked={showVwap} onChange={(e) => setShowVwap(e.target.checked)}>VWAP</Checkbox>
              </Tooltip>
              <Tooltip title="Follow the OI Replay page open in another tab: the same index and day - live, or at its replay clock - so the profiles replay along with it. With no OI Replay running (a phone: one tab, or OI Replay's tab in the background) this page opens where OI Replay was last left, and its own controls play on from there. Nothing you do here moves OI Replay.">
                <Space size={4}>
                  <Switch size="small" checked={follow} onChange={setFollow} />
                  <Text style={{ fontSize: 12 }}>Follow OI Replay</Text>
                </Space>
              </Tooltip>
              {follow && (following
                ? <Tag color={followed.clock?.failedDate ? 'warning' : 'cyan'} style={{ margin: 0 }}>⇄ OI Replay · {followed.clock?.underlying} {followClockText(followed.clock)}</Tag>
                : followed.kept
                  ? <Tag color="blue" style={{ margin: 0, whiteSpace: 'normal' }}>Opened where OI Replay was left · {followed.kept.underlying} {keptClockText(followed.kept)} · it is not running - play on here</Tag>
                  : <Tag style={{ margin: 0 }}>OI Replay is not open - showing this page&apos;s own choice</Tag>)}
            </Space>
            {!live && !following && span && (
              <Space direction="vertical" size={6} style={{ width: '100%' }}>
                <Space size={8} wrap align="center">
                  <Button size="small" icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />} disabled={!playing && atEnd} onClick={() => setPlaying((p) => !p)}>
                    {playing ? 'Pause' : 'Start'}
                  </Button>
                  <Button size="small" icon={<ReloadOutlined />} onClick={() => { setPlaying(false); setClockMs(span.start) }}>Reset</Button>
                  <Text type="secondary" style={{ fontSize: 12 }}>Speed</Text>
                  <Select size="small" value={speedMs} onChange={setSpeedMs} style={{ width: 80 }} options={SPEED_OPTIONS} />
                  <Text type="secondary" style={{ fontSize: 12 }}>Go to</Text>
                  <TimePicker
                    size="small" format="HH:mm" minuteStep={1} allowClear={false} needConfirm={false} showNow={false} style={{ width: 96 }}
                    value={clock ? dayjs(`2000-01-01T${new Date(clock - 60_000 + 330 * 60_000).toISOString().slice(11, 16)}`) : null}
                    disabledTime={() => ({ disabledHours: () => [...Array(24).keys()].filter((h) => h < 9 || h > 15) })}
                    onChange={goTo}
                  />
                  <Text strong style={{ fontSize: 12 }}>{clock ? fmtClock(clock - 60_000) : ''}</Text>
                </Space>
                <Slider
                  style={{ margin: '0 8px' }} min={span.start} max={span.end} step={60_000} value={clock ?? span.start}
                  tooltip={{ formatter: (v) => fmtClock(v - 60_000) }} onChange={(v) => { setPlaying(false); setClockMs(v) }}
                />
              </Space>
            )}
            <Space size={8} wrap>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {index} spot and futures{futuresDay?.contract ? ` (${futuresDay.contract})` : ''} · {effectiveDate} {asOf && `· ${asOf}`}
                {(dayCount > 1 || profileOf === 'previous') && (coverText ? ` · profile of ${coverText}` : '')}
                {loadingPast && ` · loading sessions… ${usedPast.length} of ${pastCount}`}
                {!loadingPast && pastCount > usedPast.length && ` · only ${usedPast.length} earlier session${usedPast.length === 1 ? '' : 's'} found`}
              </Text>
              {estimated && <Tag color="orange" style={{ margin: 0 }}>futures {dayCount > 1 ? 'of some days ' : ''}estimated from 1-minute candles</Tag>}
              {futuresDay?.estimatedBefore && (
                <Tooltip title="The server started recording this day's futures order flow part way - a restart or a deploy - so the minutes before are estimated from Dhan's 1-minute candles (each minute's volume spread over its range), as the Order Flow page's delta does.">
                  <Tag color="orange" style={{ margin: 0 }}>
                    {inMarketSession(futuresDay.estimatedBefore)
                      ? `futures before ${fmtClock(new Date(futuresDay.estimatedBefore).getTime())} estimated from 1-minute candles`
                      : 'futures of the whole session estimated from 1-minute candles (the server restarted after the close)'}
                  </Tag>
                </Tooltip>
              )}
              {(futures.loading || spot.loading) && <Tag style={{ margin: 0 }}>loading…</Tag>}
            </Space>
            {(futuresPast.error || spotPast.error) && <Alert type="warning" showIcon message={`Not every earlier session could be loaded: ${futuresPast.error ?? spotPast.error}`} />}
          </Space>
        </Card>

        <Text strong style={{ fontSize: 13 }}>Spot · {index} index · {spotDay ? effectiveDate : spot.loading ? `loading ${effectiveDate}…` : effectiveDate}</Text>
        <ProfilePair {...pair} name="Spot" known={spotKnown} past={pastCount ? spotPast.sessions.slice(-pastCount) : NO_BARS} neutral empty={emptyFor(spot, spotSession, spotPast, 'spot')} dayError={spot.error} />
        <Text strong style={{ fontSize: 13 }}>Futures · {futuresDay?.contract ?? `${index} near futures`} · {futuresDay ? effectiveDate : futures.loading ? `loading ${effectiveDate}…` : effectiveDate}</Text>
        <ProfilePair {...pair} name="Futures" known={futuresKnown} past={pastCount ? futuresPast.sessions.slice(-pastCount) : NO_BARS} empty={emptyFor(futures, futuresSession, futuresPast, 'futures day')} dayError={futures.error} />
      </Space>
    </div>
  )
}
