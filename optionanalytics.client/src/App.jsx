import { Component, useEffect, useMemo, useRef, useState } from 'react'
import { Select, Space, Typography, Spin, Card, Button, Modal, Table, Tag } from 'antd'
import { createChart, createSeriesMarkers, CandlestickSeries, LineSeries, CrosshairMode, LineStyle, TickMarkType } from 'lightweight-charts'
import * as signalR from '@microsoft/signalr'
import { Routes, Route } from 'react-router-dom'
import BacktestPage from './BacktestPage.jsx'
import TriggersPage from './TriggersPage.jsx'
import { UP_COLOR, DOWN_COLOR, CE_COLOR, PE_COLOR, ALERT_KIND_LABEL, fmtPrice, fmtIstTime, DirectionTag, NavBar, TIMEFRAME_OPTIONS, STORED_UNDERLYING, STORED_TIMEFRAME, usePersistedState, pickUnderlying } from './shared.jsx'
import './App.css'

const { Title, Text } = Typography

const EMA_FAST_COLOR = '#ffb100'
const EMA_SLOW_COLOR = '#4dabf7'
const AXIS_COLOR = '#9aa4b2'
const GRID_COLOR = '#ffffff14'
const BORDER_COLOR = '#ffffff22'
const RESET_MARKER_COLOR = '#ffd54f'

// CDV and OBV are raw traded-quantity running totals, so they reach into the hundreds of millions
// - at full precision the axis labels are an unreadable wall of digits. Both charts divide their
// values by one of these first; millions is the default since that's the magnitude these two
// actually sit at for NIFTY/BANKNIFTY.
const VALUE_UNITS = {
  M: { divisor: 1_000_000, suffix: 'M' },
  K: { divisor: 1_000, suffix: 'K' },
}

const VALUE_UNIT_OPTIONS = [
  { value: 'M', label: 'Millions (M)' },
  { value: 'K', label: 'Thousands (K)' },
]

function useScaledLine(points, unitKey) {
  const { divisor } = VALUE_UNITS[unitKey]
  return useMemo(() => points.map((p) => ({ ...p, value: p.value / divisor })), [points, divisor])
}

// Chart times are already IST-shifted (see IST_OFFSET_SECONDS), so reading the shifted value AS
// UTC gives the IST calendar day directly - the same trick the axis formatters use.
function istDayKey(chartTime) {
  return new Date(chartTime * 1000).toISOString().slice(0, 10)
}

// A "RESET" marker on the first bar of each new IST trading day - the point where CDV resets
// outright and OBV re-baselines, so a level after it is not comparable with one before it. Mirrors
// the Pine indicators' own daily-reset marker. The very first day in view gets no marker: there is
// no transition to see there, just the left edge of the loaded history.
function dayResetMarkers(points) {
  const markers = []
  let previousDay = null

  for (const point of points) {
    const day = istDayKey(point.time)
    if (previousDay !== null && day !== previousDay) {
      markers.push({ time: point.time, position: 'aboveBar', color: RESET_MARKER_COLOR, shape: 'square', text: 'RESET' })
    }
    previousDay = day
  }
  return markers
}

// CDV gets today's line solid and the previous trading day dashed underneath it, because the
// backend serves those as two separate series. OBV comes back as ONE continuous multi-day series
// instead, so it was drawing every day as one solid line with no way to tell them apart - this
// splits it the same way so both charts read identically: the most recent IST day solid, the day
// before it dashed, anything older dropped (CDV never showed more than those two either).
function useTodayAndPreviousDay(points) {
  return useMemo(() => {
    if (points.length === 0) return { today: [], previous: [] }

    const days = [...new Set(points.map((p) => istDayKey(p.time)))].sort()
    const todayKey = days[days.length - 1]
    const previousKey = days.length > 1 ? days[days.length - 2] : null

    return {
      today: points.filter((p) => istDayKey(p.time) === todayKey),
      previous: previousKey ? points.filter((p) => istDayKey(p.time) === previousKey) : [],
    }
  }, [points])
}

// The running CE/PE totals printed under the CDV chart, in whatever unit that chart is showing.
function fmtScaled(v, unitKey) {
  if (v == null) return '—'
  const { divisor, suffix } = VALUE_UNITS[unitKey]
  return `${(v / divisor).toLocaleString('en-IN', { maximumFractionDigits: 2 })} ${suffix}`
}

// lightweight-charts has no built-in timezone support - every chart always formats its time axis
// using the browser's own local timezone. To make every chart show true IST (India, fixed
// UTC+5:30 - the market this whole app is about) regardless of which timezone the VIEWER's own
// browser happens to be in, every timestamp fed to a chart is shifted forward by this fixed
// offset up front, and istTimeFormatter/istTickMarkFormatter below then format that shifted value
// AS IF it were UTC - which, because of the shift, is exactly its real IST wall-clock value.
const IST_OFFSET_SECONDS = 5.5 * 3600

function toChartTime(isoOrDate) {
  return Math.floor(new Date(isoOrDate).getTime() / 1000) + IST_OFFSET_SECONDS
}

const IST_TIME_FORMAT = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'UTC' })
const IST_TICK_DATE_FORMAT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })

// The crosshair's time-axis label - see IST_OFFSET_SECONDS above for why timeZone: 'UTC' here is
// correct despite this being IST.
function istTimeFormatter(time) {
  return IST_TIME_FORMAT.format(new Date(time * 1000))
}

// The time axis's own tick labels - a date ("27 Aug") at day/month/year granularity, a time
// ("09:15 am") at the finer granularities the intraday charts here actually zoom to.
function istTickMarkFormatter(time, tickMarkType) {
  const date = new Date(time * 1000)
  return tickMarkType >= TickMarkType.Time ? IST_TIME_FORMAT.format(date) : IST_TICK_DATE_FORMAT.format(date)
}

// Every bar/point coming off the wire (ISO time strings) is converted to this one shape - epoch
// seconds for `time`, exactly what lightweight-charts wants - the instant it's received, so every
// downstream step (merging the live bar, timeframe aggregation, EMA/OBV math, charting) works on
// plain numbers with no repeated re-parsing.
function toBar(c) {
  return { time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close }
}

function toLinePoint(p, valueKeys) {
  const point = { time: toChartTime(p.time) }
  for (const key of valueKeys) point[key] = p[key]
  return point
}

function mergeLiveBar(bars, liveBar) {
  if (!liveBar) return bars
  return [...bars.filter((b) => b.time !== liveBar.time), liveBar].sort((a, b) => a.time - b.time)
}

// Bucketing for the 1/3/5-minute timeframe switcher - everything server-side stays at native
// 1-minute resolution (that's what the live feed naturally produces); coarser timeframes are just
// a view over the same 1-minute bars, computed client-side so switching timeframe is instant and
// needs no extra round trip.
function aggregateCandles(bars, minutes) {
  if (minutes <= 1 || bars.length === 0) return bars
  const bucketSeconds = minutes * 60
  const buckets = new Map()
  for (const b of bars) {
    const bucketTime = Math.floor(b.time / bucketSeconds) * bucketSeconds
    const existing = buckets.get(bucketTime)
    if (!existing) {
      buckets.set(bucketTime, { time: bucketTime, open: b.open, high: b.high, low: b.low, close: b.close })
    } else {
      existing.high = Math.max(existing.high, b.high)
      existing.low = Math.min(existing.low, b.low)
      existing.close = b.close
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time)
}

// Same bucketing for a running-total line series (CDV/OBV) - the meaningful value for a coarser
// bucket is the LAST sample in it (Map.set on a repeated key keeps overwriting, and points arrive
// time-ascending, so this naturally ends up holding each bucket's latest value).
function aggregateLine(points, minutes) {
  if (minutes <= 1 || points.length === 0) return points
  const bucketSeconds = minutes * 60
  const buckets = new Map()
  for (const p of points) {
    const bucketTime = Math.floor(p.time / bucketSeconds) * bucketSeconds
    buckets.set(bucketTime, { ...p, time: bucketTime })
  }
  return Array.from(buckets.values()).sort((a, b) => a.time - b.time)
}

// Last line of defense before handing data to lightweight-charts, which throws an UNCAUGHT error
// (no recoverable state - see ChartErrorBoundary below for why that matters) if two consecutive
// points share a time or aren't strictly ascending. The backend already dedupes its series at the
// source (see SpotUnderlyingState.ApplyTick and friends), but this makes any future stray
// duplicate/out-of-order point - a backend edge case not yet found, a network replay, anything - a
// silent no-op here instead of a chart-breaking crash. Sorts ascending; for a duplicate time, keeps
// the LAST occurrence (the more complete/recent value, same preference the backend fix uses).
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

// Every chart on the dashboard pans/zooms as one: each registers itself here on mount, and
// dragging or zooming any of them pushes the same window to all the others.
//
// The window is synced as a TIME range, not lightweight-charts' logical (bar-index) range - the
// charts hold completely different series (spot has every 1-minute bar of 5 days, an ATM CE
// contract only has bars from whenever that strike started being tracked, CDV/OBV have their own
// counts again), so index N is a different instant on each one and only real timestamps line up.
//
// isApplyingSync is the guard for the obvious feedback loop: applying a range to another chart
// fires that chart's own range-change handler, which would otherwise bounce straight back.
const chartSyncRegistry = new Set()
let isApplyingSync = false

function registerChartForSync(chart) {
  const onVisibleRangeChange = () => {
    if (isApplyingSync) return
    const range = chart.timeScale().getVisibleRange()
    if (!range) return

    isApplyingSync = true
    try {
      for (const other of chartSyncRegistry) {
        if (other === chart) continue
        // A chart whose own data doesn't reach into this window can reject the range - that's a
        // "nothing to show there", not an error worth breaking the drag over.
        try { other.timeScale().setVisibleRange(range) } catch { /* empty */ }
      }
    } finally {
      isApplyingSync = false
    }
  }

  chartSyncRegistry.add(chart)
  chart.timeScale().subscribeVisibleTimeRangeChange(onVisibleRangeChange)

  return () => {
    chart.timeScale().unsubscribeVisibleTimeRangeChange(onVisibleRangeChange)
    chartSyncRegistry.delete(chart)
  }
}

function useAggregatedCandles(candles, liveBarRaw, timeframeMinutes) {
  return useMemo(() => {
    const bars = mergeLiveBar(candles.map(toBar), liveBarRaw ? toBar(liveBarRaw) : null)
    return aggregateCandles(bars, timeframeMinutes)
  }, [candles, liveBarRaw, timeframeMinutes])
}

function useAggregatedLine(points, liveBarRaw, timeframeMinutes, valueKeys) {
  return useMemo(() => {
    const mapped = points.map((p) => toLinePoint(p, valueKeys))
    const merged = liveBarRaw ? mergeLiveBar(mapped, toLinePoint(liveBarRaw, valueKeys)) : mapped
    return aggregateLine(merged, timeframeMinutes)
  }, [points, liveBarRaw, timeframeMinutes])
}

// Standard EMA: seeded with a plain average of the first `period` closes, then the usual
// exponential recurrence. Returns one value per input bar, null before the seed window fills.
function computeEma(closes, period) {
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

// EMA9/EMA21 line points plus crossover markers (bullish: 9 crosses above 21, bearish: below) -
// the "TradingView-style EMA crossover" overlay used on every candlestick chart on this page.
function useEmaCrossover(bars) {
  return useMemo(() => {
    const closes = bars.map((b) => b.close)
    const ema9 = computeEma(closes, 9)
    const ema21 = computeEma(closes, 21)

    const ema9Points = []
    const ema21Points = []
    const markers = []
    let prevDiff = null

    for (let i = 0; i < bars.length; i++) {
      const time = bars[i].time
      if (ema9[i] != null) ema9Points.push({ time, value: ema9[i] })
      if (ema21[i] != null) ema21Points.push({ time, value: ema21[i] })

      if (ema9[i] != null && ema21[i] != null) {
        const diff = ema9[i] - ema21[i]
        if (prevDiff != null) {
          if (prevDiff <= 0 && diff > 0) {
            markers.push({ time, position: 'belowBar', color: UP_COLOR, shape: 'arrowUp', text: 'Breakup' })
          } else if (prevDiff >= 0 && diff < 0) {
            markers.push({ time, position: 'aboveBar', color: DOWN_COLOR, shape: 'arrowDown', text: 'Breakdown' })
          }
        }
        prevDiff = diff
      }
    }

    return { ema9Points, ema21Points, markers }
  }, [bars])
}

// Just the CURRENT relationship between EMA9/EMA21 (not the crossover event history) - what the
// chart card's header badge shows, so "is this bullish or bearish right now" reads at a glance
// without hunting through the marker clutter on the chart body itself.
function useCrossoverState(bars) {
  return useMemo(() => {
    const closes = bars.map((b) => b.close)
    const ema9 = computeEma(closes, 9)
    const ema21 = computeEma(closes, 21)
    for (let i = closes.length - 1; i >= 0; i--) {
      if (ema9[i] != null && ema21[i] != null) return ema9[i] >= ema21[i] ? 'up' : 'down'
    }
    return null
  }, [bars])
}

function fmtNum(v) {
  return v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })
}

// One SignalR connection shared by every chart on the page - each just registers its own handler
// for the event it cares about ("spotUpdate" / "cdvUpdate", the latter also carrying the ATM
// CE/PE premium bars, and "confluenceAlert" for the notification engine's live pushes).
//
// onReconnected exists because withAutomaticReconnect() only repairs the SOCKET, not the state
// built from it. Every piece of state this page holds - crossoverStates (the Confluence Alerts
// panel's Bullish/Bearish tags) especially - is either fetched once on mount or updated purely by
// incrementally folding in live events; neither self-heals across a connection gap. A server
// restart (a redeploy, most concretely) resets its own EMA-direction memory too, so the NEXT
// confluenceAlert it sends only fires on a fresh CHANGE from a state it no longer remembers, which
// can take several bars to arrive - meanwhile crossoverStates keeps showing whatever was true
// before the gap, silently disagreeing with the live chart underneath it (which stays roughly
// current because it's fed by frequent tick-level spotUpdate/cdvUpdate pushes, not the rarer
// confluenceAlert ones). On a page showing live trading signals, a stale Bullish/Bearish tag next
// to a fresh candle showing the opposite is a correctness bug, not a cosmetic one - onReconnected
// is the hook a caller uses to fully re-fetch from REST (the source of truth) rather than trust
// whatever incremental state survived the gap.
function useHub(onSpotUpdate, onCdvUpdate, onConfluenceAlert, onReconnected) {
  const spotHandlerRef = useRef(onSpotUpdate)
  const cdvHandlerRef = useRef(onCdvUpdate)
  const alertHandlerRef = useRef(onConfluenceAlert)
  const reconnectedHandlerRef = useRef(onReconnected)
  spotHandlerRef.current = onSpotUpdate
  cdvHandlerRef.current = onCdvUpdate
  alertHandlerRef.current = onConfluenceAlert
  reconnectedHandlerRef.current = onReconnected

  useEffect(() => {
    const connection = new signalR.HubConnectionBuilder()
      .withUrl('/hubs/spot')
      .withAutomaticReconnect()
      .build()

    connection.on('spotUpdate', (snapshot) => spotHandlerRef.current(snapshot))
    connection.on('cdvUpdate', (snapshot) => cdvHandlerRef.current(snapshot))
    connection.on('confluenceAlert', (alert) => alertHandlerRef.current(alert))
    // Fires after automatic reconnect actually succeeds (not on the initial connect, which the
    // page's own mount-time fetches already cover) - see this function's own doc comment for why
    // a resync here, not just letting new events trickle in, is what a correctness-sensitive page
    // needs.
    connection.onreconnected(() => reconnectedHandlerRef.current?.())
    connection.start().catch((err) => {
      // React StrictMode mounts this effect, runs its cleanup, then mounts it again - the first
      // connection's start() gets aborted by that cleanup's stop() before negotiation finishes,
      // which is expected and harmless (the second mount's connection succeeds normally), not a
      // real connection failure worth alarming about.
      if (err?.name === 'AbortError') return
      console.error('SignalR connection failed:', err)
    })

    return () => { connection.stop() }
  }, [])
}

// Candlestick + EMA9/EMA21 overlay + crossover markers - the one chart shape reused for the spot
// price and both ATM option premium charts.
function PriceChart({ bars, height = 360 }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const ema9Ref = useRef(null)
  const ema21Ref = useRef(null)
  const markersRef = useRef(null)
  // Only auto-fit the visible range once, the first time this chart instance gets data - a live
  // tick updates `bars` (a new array reference) many times a minute, and calling fitContent() on
  // every one of those updates was yanking the view back to "fit everything" mid-drag/zoom, undoing
  // any panning or zooming the moment new data arrived. App.jsx also keys this component on
  // underlying+timeframe, so switching either remounts it fresh (this flag resets to false) rather
  // than silently reusing the old pan/zoom position for a completely different dataset.
  const hasFitRef = useRef(false)

  const sanitizedBars = useMemo(() => sanitizeSeries(bars), [bars])
  const { ema9Points, ema21Points, markers } = useEmaCrossover(sanitizedBars)
  // EMA crossover markers plus a RESET marker at each new trading day, merged into the one
  // marker list this series can hold - lightweight-charts wants them time-ascending.
  const allMarkers = useMemo(
    () => [...markers, ...dayResetMarkers(sanitizedBars)].sort((a, b) => a.time - b.time),
    [markers, sanitizedBars],
  )

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
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      borderVisible: false,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
    })
    ema9Ref.current = chart.addSeries(LineSeries, { color: EMA_FAST_COLOR, lineWidth: 1, title: 'EMA 9', priceLineVisible: false, crosshairMarkerVisible: false })
    ema21Ref.current = chart.addSeries(LineSeries, { color: EMA_SLOW_COLOR, lineWidth: 1, title: 'EMA 21', priceLineVisible: false, crosshairMarkerVisible: false })
    markersRef.current = createSeriesMarkers(seriesRef.current, [])
    hasFitRef.current = false

    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth })
    }
    window.addEventListener('resize', onResize)
    const unregisterSync = registerChartForSync(chart)

    return () => {
      window.removeEventListener('resize', onResize)
      unregisterSync()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      ema9Ref.current = null
      ema21Ref.current = null
      markersRef.current = null
    }
    // One chart instance per mount - series data is (re)populated by the effects below, not by
    // recreating the chart, so switching the underlying/timeframe doesn't flicker an empty chart in.
  }, [height])

  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setData(sanitizedBars)
    if (!hasFitRef.current && sanitizedBars.length > 0) {
      chartRef.current?.timeScale().fitContent()
      hasFitRef.current = true
    }
  }, [sanitizedBars])

  useEffect(() => {
    if (!ema9Ref.current || !ema21Ref.current) return
    ema9Ref.current.setData(ema9Points)
    ema21Ref.current.setData(ema21Points)
  }, [ema9Points, ema21Points])

  useEffect(() => {
    markersRef.current?.setMarkers(allMarkers)
  }, [allMarkers])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// Two-line running-total chart shape reused for CDV (cumulative delta volume) and OBV
// (on-balance volume, via Skender.Stock.Indicators) - a CE line and a PE line. prevCeSeries/
// prevPeSeries are optional - CDV passes the previous trading day's reconstructed curve (dashed,
// lighter) as a reference alongside today's live line, at its own real timestamps (so it shows up
// as an earlier, visually distinct segment rather than overlaid on today's); OBV never passes
// them, since it has no equivalent "previous day" concept.
function CeVsPeChart({ ceSeries, peSeries, prevCeSeries = [], prevPeSeries = [], height = 280 }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const ceRef = useRef(null)
  const peRef = useRef(null)
  const prevCeRef = useRef(null)
  const prevPeRef = useRef(null)
  const markersRef = useRef(null)
  // See PriceChart's identical hasFitRef for why this only fits once per mount, not on every live update.
  const hasFitRef = useRef(false)
  const sanitizedCe = useMemo(() => sanitizeSeries(ceSeries), [ceSeries])
  const sanitizedPe = useMemo(() => sanitizeSeries(peSeries), [peSeries])
  const sanitizedPrevCe = useMemo(() => sanitizeSeries(prevCeSeries), [prevCeSeries])
  const sanitizedPrevPe = useMemo(() => sanitizeSeries(prevPeSeries), [prevPeSeries])

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
    prevCeRef.current = chart.addSeries(LineSeries, { color: CE_COLOR, lineWidth: 1, lineStyle: LineStyle.Dashed, title: 'CE (prev day)', priceLineVisible: false, crosshairMarkerVisible: false })
    prevPeRef.current = chart.addSeries(LineSeries, { color: PE_COLOR, lineWidth: 1, lineStyle: LineStyle.Dashed, title: 'PE (prev day)', priceLineVisible: false, crosshairMarkerVisible: false })
    ceRef.current = chart.addSeries(LineSeries, { color: CE_COLOR, lineWidth: 2, title: 'CE', priceLineVisible: false })
    peRef.current = chart.addSeries(LineSeries, { color: PE_COLOR, lineWidth: 2, title: 'PE', priceLineVisible: false })
    markersRef.current = createSeriesMarkers(ceRef.current, [])
    hasFitRef.current = false

    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth })
    }
    window.addEventListener('resize', onResize)
    const unregisterSync = registerChartForSync(chart)

    return () => {
      window.removeEventListener('resize', onResize)
      unregisterSync()
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
    prevCeRef.current.setData(sanitizedPrevCe)
    prevPeRef.current.setData(sanitizedPrevPe)
    ceRef.current.setData(sanitizedCe)
    peRef.current.setData(sanitizedPe)
    const hasAnyData = sanitizedCe.length > 0 || sanitizedPe.length > 0 || sanitizedPrevCe.length > 0 || sanitizedPrevPe.length > 0
    if (!hasFitRef.current && hasAnyData) {
      chartRef.current?.timeScale().fitContent()
      hasFitRef.current = true
    }
  }, [sanitizedCe, sanitizedPe, sanitizedPrevCe, sanitizedPrevPe])

  // The day boundary is the seam between the previous-day series and today's, so the markers come
  // off the two concatenated - and they hang on the CE series, which is the one that has a point
  // at that instant.
  const resetMarkers = useMemo(
    () => dayResetMarkers([...sanitizedPrevCe, ...sanitizedCe]),
    [sanitizedPrevCe, sanitizedCe],
  )

  useEffect(() => {
    markersRef.current?.setMarkers(resetMarkers)
  }, [resetMarkers])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// Catches a render/lifecycle error anywhere in its subtree and shows a small fallback instead of
// letting it propagate up and unmount the WHOLE page - a bug in one chart (bad data, a
// charting-library assertion, anything neither sanitizeSeries nor the backend caught) must never
// take every other chart, the alerts panel, and the dropdowns down with it. Must be a class
// component - React has no hook equivalent for getDerivedStateFromError/componentDidCatch. App.jsx
// keys each usage on the same underlying+timeframe (+ATM strike where relevant) the chart itself
// is keyed on, so switching either also clears a previously-caught error, not just stale data.
class ChartErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('Chart failed to render:', error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ height: this.props.height ?? 280, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Text type="secondary">This chart hit an error and couldn't render. The rest of the page is unaffected.</Text>
        </div>
      )
    }
    return this.props.children
  }
}

// The picker's "follow the ATM" choice. A sentinel rather than null so it survives antd's Select
// round-trip cleanly and reads as a deliberate choice everywhere it is compared against.
const ATM_STRIKE = 'atm'

// Chooses which strike the two option charts show. Defaults to following the ATM, which is what
// this page has always done; picking a strike pins both charts to it.
//
// Strikes the app tracks live (the CDV ATM+-8 window) are labelled as such: those charts update as
// ticks arrive, while any other strike is served from Dhan's intraday history and only advances
// when the page refetches it - a minute-by-minute beat rather than tick-by-tick. Premium and open
// interest come from Dhan's Option Chain API and are simply absent when that call isn't available,
// which is why they are only ever suffixes on a label that stands on its own without them.
function StrikePicker({ chain, value, onChange, live }) {
  const strikes = chain?.strikes ?? []

  const describe = (row) => {
    const parts = []
    if (row.ceLastPrice != null) parts.push(`CE ${fmtPrice(row.ceLastPrice)}`)
    if (row.peLastPrice != null) parts.push(`PE ${fmtPrice(row.peLastPrice)}`)
    return parts.join(' · ')
  }

  const options = [
    { value: ATM_STRIKE, label: 'ATM (follows spot)' },
    ...strikes.map((row) => ({
      value: row.strike,
      label: (
        <Space size={8}>
          <span>{row.strike}</span>
          {row.isAtm && <Tag color={UP_COLOR} style={{ marginInlineEnd: 0 }}>ATM</Tag>}
          {describe(row) && <Text type="secondary" style={{ fontSize: 12 }}>{describe(row)}</Text>}
        </Space>
      ),
    })),
  ]

  return (
    <Card size="small">
      <Space size={16} wrap align="center">
        <Text type="secondary" style={{ fontSize: 12 }}>Option charts</Text>
        <Select
          value={value}
          onChange={onChange}
          style={{ width: 280 }}
          options={options}
          disabled={strikes.length === 0}
          optionLabelProp="label"
          showSearch
          filterOption={(input, option) => String(option.value).includes(input)}
        />
        {live
          ? <Tag color={UP_COLOR}>Live - updates on every tick</Tag>
          : <Tag>History - refreshes each minute</Tag>}
        {chain && !chain.quotesAvailable && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            Premiums unavailable - Dhan&apos;s option chain quote is rate-limited to one call every 3 seconds and returns nothing outside market hours.
          </Text>
        )}
      </Space>
    </Card>
  )
}

function ChartCard({ title, extra, children, empty }) {
  return (
    <Card size="small" title={title} extra={extra}>
      {children ?? (
        <div style={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Text type="secondary">{empty}</Text>
        </div>
      )}
    </Card>
  )
}

// state: 'up' (EMA9 currently above EMA21 - bullish) | 'down' (below - bearish) | null (not enough
// bars yet) - see useCrossoverState. Shown as a colored "Crossover"/"Crossdown" badge next to the
// EMA legend on every chart card, so the current bias reads at a glance.
const EmaLegend = ({ state }) => (
  <Space size={16}>
    <Text style={{ color: EMA_FAST_COLOR, fontSize: 12 }}>— EMA 9</Text>
    <Text style={{ color: EMA_SLOW_COLOR, fontSize: 12 }}>— EMA 21</Text>
    {state === 'up' && <Text style={{ color: UP_COLOR, fontSize: 12, fontWeight: 600 }}>▲ Crossover</Text>}
    {state === 'down' && <Text style={{ color: DOWN_COLOR, fontSize: 12, fontWeight: 600 }}>▼ Crossdown</Text>}
  </Space>
)

const STRIKE_COLUMNS = [
  { title: 'Strike', dataIndex: 'strike', key: 'strike', sorter: (a, b) => a.strike - b.strike },
  {
    title: 'Side', dataIndex: 'isCall', key: 'isCall', width: 70,
    filters: [{ text: 'CE', value: true }, { text: 'PE', value: false }],
    onFilter: (value, record) => record.isCall === value,
    render: (isCall) => <Tag color={isCall ? CE_COLOR : PE_COLOR}>{isCall ? 'CE' : 'PE'}</Tag>,
  },
  {
    title: 'Status', dataIndex: 'isActive', key: 'isActive', width: 140,
    render: (isActive) => (isActive
      ? <Tag color="blue">In ATM ±8 window</Tag>
      : <Tag>Rolled out today</Tag>),
  },
  {
    title: 'Running CDV contribution', dataIndex: 'runningCdv', key: 'runningCdv',
    sorter: (a, b) => a.runningCdv - b.runningCdv,
    render: (v) => fmtNum(v),
  },
]

// "For verification purposes" per-strike breakdown of what the CDV chart actually sums - a plain
// GET on demand (not wired to SignalR) since this is a one-off check, not something that needs to
// track every tick live.
function StrikesButton({ underlying }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [rows, setRows] = useState([])

  const load = () => {
    setLoading(true)
    fetch(`/api/cdv/${underlying}/strikes`)
      .then((r) => r.json())
      .then((data) => setRows((data ?? []).map((s, i) => ({ ...s, key: `${s.securityId}-${i}` }))))
      .catch((err) => console.error('Failed to load CDV strikes:', err))
      .finally(() => setLoading(false))
  }

  return (
    <>
      <Button size="small" onClick={() => { setOpen(true); load() }}>Strikes</Button>
      <Modal
        title={`${underlying} - strikes summed into CDV`}
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width={640}
      >
        <Table
          size="small"
          loading={loading}
          columns={STRIKE_COLUMNS}
          dataSource={rows}
          pagination={false}
          scroll={{ y: 420 }}
        />
      </Modal>
    </>
  )
}

const ALERT_DISPLAY_LIMIT = 20

// The notification engine's live feed. Two tiers, both from the backend's ConfluenceAlertService:
// a status board showing each underlying's CURRENT spot/ATM-CE/ATM-PE EMA9/21 bias (continuously
// kept up to date, not just on a crossover), and below it every alert that's fired - a lightweight
// one the moment any single leg's bias flips, plus a stronger CONFLUENCE alert when all three
// confirm the same move at once. Kept visible on the page at all times (not a toast that
// disappears) since the whole point is catching a signal even if nobody was looking when it fired.
function AlertsPanel({ alerts, states }) {
  return (
    <Card size="small" title="Confluence Alerts" extra={<Text type="secondary" style={{ fontSize: 12 }}>Spot + ATM CE/PE EMA 9/21</Text>}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {states.length > 0 && (
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            {states.map((s) => (
              <Space key={s.underlying} size={6} wrap>
                <Text strong>{s.underlying}</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>Spot</Text>
                <DirectionTag direction={s.spot} />
                <Text type="secondary" style={{ fontSize: 12 }}>ATM CE</Text>
                <DirectionTag direction={s.atmCe} />
                <Text type="secondary" style={{ fontSize: 12 }}>ATM PE</Text>
                <DirectionTag direction={s.atmPe} />
              </Space>
            ))}
          </div>
        )}

        {alerts.length === 0 ? (
          <Text type="secondary">
            No alerts yet - a leg flip (spot, ATM CE, or ATM PE turning bullish/bearish) shows here as it happens, plus a stronger CONFLUENCE alert when all three confirm the same move.
          </Text>
        ) : (
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            <Space direction="vertical" size={8} style={{ width: '100%' }}>
              {alerts.slice(0, ALERT_DISPLAY_LIMIT).map((a, i) => {
                const isConfluence = a.kind === 'Confluence'
                const arrow = a.direction === 'Bullish' ? '▲' : '▼'
                return (
                  <div key={`${a.underlying}-${a.kind}-${a.timeUtc}-${i}`} style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <Tag
                      color={isConfluence ? (a.direction === 'Bullish' ? UP_COLOR : DOWN_COLOR) : undefined}
                      style={{ minWidth: 110, textAlign: 'center', fontWeight: isConfluence ? 700 : 400 }}
                    >
                      {isConfluence ? `${arrow} CONFLUENCE` : `${ALERT_KIND_LABEL[a.kind] ?? a.kind} ${arrow}`}
                    </Tag>
                    <Text strong>{a.underlying}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      Spot {fmtPrice(a.spotPrice)} · ATM {a.atmStrike ?? '—'} · {fmtIstTime(a.timeUtc)}
                    </Text>
                  </div>
                )
              })}
            </Space>
          </div>
        )}
      </Space>
    </Card>
  )
}

const DEFAULT_LOOKBACK_BARS = [3, 5, 7]

function renderPercent(v) {
  if (v == null) return <Text type="secondary">—</Text>
  const color = v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined
  return <Text style={{ color }}>{v > 0 ? '+' : ''}{v.toFixed(2)}%</Text>
}

// CE/PE %-change over configurable lookback windows, off the backend's EMA-smoothed series -
// mirrors the "Multi-Lookback" table in the Pine indicators these are ported from, and is used for
// both CDV (endpoint "lookback", default 3/5/7 bars) and OBV (endpoint "obv-lookback", default
// 20/25/30 - the periods that Pine's own OBV multi-lookback table defaults to). The bars selector
// accepts free-form numbers (antd's tags mode), not just the preset options, so "configurable"
// isn't limited to a fixed list.
function LookbackTable({ underlying, cdvSnapshot, endpoint = 'lookback', title = 'CE / PE Lookback % Change', defaultBars = DEFAULT_LOOKBACK_BARS }) {
  const [bars, setBars] = useState(defaultBars)
  const [table, setTable] = useState(null)
  const lastBarTimeRef = useRef(null)

  const load = (barsToUse) => {
    fetch(`/api/cdv/${underlying}/${endpoint}?bars=${barsToUse.join(',')}`)
      .then((r) => r.json())
      .then(setTable)
      .catch((err) => console.error(`Failed to load ${endpoint} table:`, err))
  }

  useEffect(() => { load(bars) }, [underlying, bars.join(',')])

  // Refetch whenever the CDV bar closes - same "new minute" trigger the OBV refetch elsewhere uses.
  useEffect(() => {
    const barTime = cdvSnapshot?.currentBar?.time ?? null
    if (barTime === lastBarTimeRef.current) return
    lastBarTimeRef.current = barTime
    load(bars)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cdvSnapshot?.currentBar?.time])

  const rows = table
    ? table.ce.map((c, i) => ({ key: c.bars, bars: c.bars, cePercent: c.percentChange, pePercent: table.pe[i]?.percentChange }))
    : []

  return (
    <Card
      size="small"
      title={title}
      extra={
        <Select
          mode="tags"
          size="small"
          value={bars.map(String)}
          onChange={(vals) => {
            const parsed = [...new Set(vals.map((v) => parseInt(v, 10)).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b)
            setBars(parsed.length > 0 ? parsed : defaultBars)
          }}
          style={{ minWidth: 180 }}
          options={[3, 5, 7, 10, 15, 20, 25, 30].map((n) => ({ value: String(n), label: `${n} bars` }))}
        />
      }
    >
      {!table ? (
        <Text type="secondary">Loading…</Text>
      ) : (
        <Table
          size="small"
          pagination={false}
          dataSource={rows}
          columns={[
            { title: 'Lookback', dataIndex: 'bars', key: 'bars', render: (b) => `${b} bars ago` },
            { title: 'CE % Change', dataIndex: 'cePercent', key: 'cePercent', render: renderPercent },
            { title: 'PE % Change', dataIndex: 'pePercent', key: 'pePercent', render: renderPercent },
          ]}
        />
      )}
    </Card>
  )
}

function DashboardPage() {
  const [underlyings, setUnderlyings] = useState([])
  // Shared with every other page and remembered across reloads - see usePersistedState.
  const [selected, setSelected] = usePersistedState(STORED_UNDERLYING, null)
  const [timeframe, setTimeframe] = usePersistedState(STORED_TIMEFRAME, 1)
  // Per-chart so either can be read at its own natural magnitude - CDV and OBV don't always sit
  // in the same range as each other.
  const [cdvUnit, setCdvUnit] = useState('M')
  const [obvUnit, setObvUnit] = useState('M')
  const [loading, setLoading] = useState(true)

  const [candles, setCandles] = useState([])
  const [snapshot, setSnapshot] = useState(null)

  // Confluence alerts are a combined feed across every underlying, not scoped to `selected` -
  // fetched once on load (so alerts that fired before this tab connected still show up) and then
  // grown live via useHub's "confluenceAlert" push below.
  const [alerts, setAlerts] = useState([])
  useEffect(() => {
    fetch('/api/alerts')
      .then((r) => r.json())
      .then((data) => setAlerts(data ?? []))
      .catch((err) => console.error('Failed to load alerts:', err))
  }, [])

  // Each underlying's CURRENT spot/ATM-CE/ATM-PE bias - fetched once (the backend seeds this from
  // already-closed bars on its own startup, so it's meaningful immediately) and then kept live by
  // folding in each individual leg alert as it arrives over the same SignalR stream, rather than
  // re-fetching the whole snapshot on every update.
  const [crossoverStates, setCrossoverStates] = useState([])
  // Shared by the mount-time fetch below and useHub's reconnect resync further down (see useHub's
  // own doc comment for why a reconnect needs this re-run rather than trusting incremental state).
  const refetchCrossoverStates = () => {
    fetch('/api/alerts/state')
      .then((r) => r.json())
      .then((data) => setCrossoverStates(data ?? []))
      .catch((err) => console.error('Failed to load crossover state:', err))
  }
  useEffect(refetchCrossoverStates, [])

  const [cdvSeries, setCdvSeries] = useState([])
  const [cdvSnapshot, setCdvSnapshot] = useState(null)
  const [cdvPrevDaySeries, setCdvPrevDaySeries] = useState([])

  const [atmCeCandles, setAtmCeCandles] = useState([])
  const [atmPeCandles, setAtmPeCandles] = useState([])

  // Which strike the two option charts show. ATM_STRIKE means "whichever is ATM right now", which
  // is what this page did before the picker existed and stays the default - the charts then follow
  // the ATM as it rolls. Any other value pins them to that strike.
  const [strikeChain, setStrikeChain] = useState(null)
  const [selectedStrike, setSelectedStrike] = useState(ATM_STRIKE)

  const [obvCe, setObvCe] = useState([])
  const [obvPe, setObvPe] = useState([])

  const lastObvBarTimeRef = useRef({ ce: null, pe: null })

  useEffect(() => {
    fetch('/api/spot/underlyings')
      .then((r) => r.json())
      .then((list) => {
        setUnderlyings(list)
        setSelected((current) => pickUnderlying(list, current))
      })
      .catch((err) => console.error('Failed to load underlyings:', err))
      .finally(() => setLoading(false))
  }, [])

  // Fetches the two option charts' candles + OBV - shared by the main [selected] load, the
  // ATM-rollover effect below, the strike picker, and the manual Refresh button, all of which need
  // the exact same "wholesale replace" fetch. Returns a settled-promise so callers that care when
  // it's done (the Refresh button) can await it; callers that don't (the effects) just fire it.
  //
  // On ATM_STRIKE this hits the atm-ce/atm-pe endpoints, which resolve the ATM contract server-side;
  // a pinned strike goes to the per-strike endpoint instead, which also covers strikes this app
  // never subscribed to (it fetches their history from Dhan on demand).
  const fetchAtmAndObv = (underlying, cancelledRef, strike = selectedStrike) => {
    const url = (type) => (strike === ATM_STRIKE
      ? `/api/cdv/${underlying}/atm-${type.toLowerCase()}/candles`
      : `/api/cdv/${underlying}/option/candles?strike=${strike}&type=${type}`)

    const ce = fetch(url('CE'))
      .then((r) => r.json())
      .then((data) => { if (!cancelledRef.cancelled) setAtmCeCandles(data ?? []) })
      .catch((err) => console.error('Failed to load CE candles:', err))

    const pe = fetch(url('PE'))
      .then((r) => r.json())
      .then((data) => { if (!cancelledRef.cancelled) setAtmPeCandles(data ?? []) })
      .catch((err) => console.error('Failed to load PE candles:', err))

    const obv = fetch(`/api/cdv/${underlying}/obv-series`)
      .then((r) => r.json())
      .then((data) => { if (!cancelledRef.cancelled) { setObvCe(data.ce ?? []); setObvPe(data.pe ?? []) } })
      .catch((err) => console.error('Failed to load OBV series:', err))

    return Promise.allSettled([ce, pe, obv])
  }

  // Everything the page shows for one underlying, fetched fresh - the initial [selected] load and
  // the manual Refresh button both just call this with a no-op-on-unmount cancelledRef.
  const fetchAllData = (underlying, cancelledRef, strike = selectedStrike) => {
    const candlesP = fetch(`/api/spot/${underlying}/candles`)
      .then((r) => r.json())
      .then((data) => { if (!cancelledRef.cancelled) setCandles(data) })
      .catch((err) => console.error('Failed to load candles:', err))

    const snapshotP = fetch(`/api/spot/${underlying}/snapshot`)
      .then((r) => r.json())
      .then((data) => { if (!cancelledRef.cancelled) setSnapshot(data) })
      .catch((err) => console.error('Failed to load snapshot:', err))

    const cdvSeriesP = fetch(`/api/cdv/${underlying}/series`)
      .then((r) => r.json())
      .then((data) => { if (!cancelledRef.cancelled) setCdvSeries(data) })
      .catch((err) => console.error('Failed to load CDV series:', err))

    const cdvSnapshotP = fetch(`/api/cdv/${underlying}/snapshot`)
      .then((r) => r.json())
      .then((data) => { if (!cancelledRef.cancelled) setCdvSnapshot(data) })
      .catch((err) => console.error('Failed to load CDV snapshot:', err))

    const cdvPrevDayP = fetch(`/api/cdv/${underlying}/previous-day-series`)
      .then((r) => r.json())
      .then((data) => { if (!cancelledRef.cancelled) setCdvPrevDaySeries(data ?? []) })
      .catch((err) => console.error('Failed to load CDV previous-day series:', err))

    return Promise.allSettled([candlesP, snapshotP, cdvSeriesP, cdvSnapshotP, cdvPrevDayP, fetchAtmAndObv(underlying, cancelledRef)])
  }

  useEffect(() => {
    if (!selected) return
    const cancelledRef = { cancelled: false }
    // Explicitly ATM rather than whatever strike is pinned: the reset effect below is about to drop
    // back to ATM anyway, and a pinned NIFTY strike requested against BANKNIFTY is a wasted call.
    previousStrikeRef.current = ATM_STRIKE
    fetchAllData(selected, cancelledRef, ATM_STRIKE)
    return () => { cancelledRef.cancelled = true }
  }, [selected])

  // The strike picker's own list. Refreshed when the ATM rolls too, since it is centred on ATM and
  // carries live premium/OI that goes stale.
  useEffect(() => {
    if (!selected) return
    const cancelledRef = { cancelled: false }
    fetch(`/api/cdv/${selected}/chain`)
      .then((r) => r.json())
      .then((data) => { if (!cancelledRef.cancelled) setStrikeChain(data) })
      .catch((err) => console.error('Failed to load the option chain:', err))
    return () => { cancelledRef.cancelled = true }
  }, [selected, cdvSnapshot?.atmStrike])

  // A strike number means nothing across underlyings (a NIFTY strike is not a BANKNIFTY one), so
  // switching underlying always drops back to following the ATM.
  useEffect(() => { setSelectedStrike(ATM_STRIKE) }, [selected])

  // Re-fetch when the pinned strike changes. ATM_STRIKE is left to the ATM-rollover effect below,
  // which already refetches on exactly the event that changes what "ATM" means.
  const previousStrikeRef = useRef(ATM_STRIKE)
  useEffect(() => {
    if (!selected) return
    if (previousStrikeRef.current === selectedStrike) return
    previousStrikeRef.current = selectedStrike
    const cancelledRef = { cancelled: false }
    fetchAtmAndObv(selected, cancelledRef, selectedStrike)
    return () => { cancelledRef.cancelled = true }
  }, [selected, selectedStrike])

  const [refreshing, setRefreshing] = useState(false)
  const handleRefresh = () => {
    if (!selected || refreshing) return
    setRefreshing(true)
    fetchAllData(selected, { cancelled: false }).finally(() => setRefreshing(false))
  }

  useHub(
    (incoming) => { if (incoming.underlying === selected) setSnapshot(incoming) },
    (incoming) => {
      if (incoming.underlying !== selected) return
      setCdvSnapshot(incoming)
    },
    (alert) => {
      setAlerts((prev) => [alert, ...prev].slice(0, 50))

      const legKey = alert.kind === 'Spot' ? 'spot' : alert.kind === 'AtmCe' ? 'atmCe' : alert.kind === 'AtmPe' ? 'atmPe' : null
      if (!legKey) return // Confluence alerts don't change any leg's own state, just confirm it
      setCrossoverStates((prev) => {
        const existing = prev.find((s) => s.underlying === alert.underlying)
        if (existing) return prev.map((s) => (s.underlying === alert.underlying ? { ...s, [legKey]: alert.direction, updatedUtc: alert.timeUtc } : s))
        return [...prev, { underlying: alert.underlying, spot: null, atmCe: null, atmPe: null, [legKey]: alert.direction, updatedUtc: alert.timeUtc }]
      })
    },
    // The reconnect resync - see useHub's doc comment. Re-fetches everything this page shows from
    // REST rather than trusting whatever the incremental SignalR handlers above accumulated across
    // the gap, since a server restart resets the state those handlers were incrementally patching.
    () => {
      if (!selected) return
      refetchCrossoverStates()
      fetchAllData(selected, { cancelled: false })
    },
  )

  // ATM CE/PE bars only change value on every tick (the premium moves), but OBV is a per-bar
  // indicator - only worth recomputing when a bar actually closes. Refetch the (small) OBV series
  // whenever either side's current-bar time moves to a new minute, not on every tick.
  //
  // A PINNED strike has no live current bar of its own coming down the SignalR snapshot (only the
  // ATM contracts do), so this same once-a-minute beat is what keeps its chart moving - it refetches
  // the strike's candles too rather than just the OBV series.
  useEffect(() => {
    if (!selected || !cdvSnapshot) return
    const ceTime = cdvSnapshot.atmCeCurrentBar?.time ?? null
    const peTime = cdvSnapshot.atmPeCurrentBar?.time ?? null
    const prev = lastObvBarTimeRef.current
    if (ceTime === prev.ce && peTime === prev.pe) return
    lastObvBarTimeRef.current = { ce: ceTime, pe: peTime }

    if (selectedStrike !== ATM_STRIKE) {
      fetchAtmAndObv(selected, { cancelled: false }, selectedStrike)
      return
    }

    fetch(`/api/cdv/${selected}/obv-series`)
      .then((r) => r.json())
      .then((data) => { setObvCe(data.ce ?? []); setObvPe(data.pe ?? []) })
      .catch((err) => console.error('Failed to refresh OBV series:', err))
  }, [selected, selectedStrike, cdvSnapshot?.atmCeCurrentBar?.time, cdvSnapshot?.atmPeCurrentBar?.time])

  // ATM strike rolling (every 30 minutes, or whenever spot crosses a strike-step boundary) means
  // the ATM CE/PE contracts themselves changed identity - the previously-fetched candle history
  // belongs to the old contract and must be replaced wholesale, not live-merged.
  const lastAtmStrikeRef = useRef(null)
  useEffect(() => {
    if (!selected || cdvSnapshot?.atmStrike == null) return
    if (lastAtmStrikeRef.current === cdvSnapshot.atmStrike) return
    lastAtmStrikeRef.current = cdvSnapshot.atmStrike
    fetchAtmAndObv(selected, { cancelled: false })
  }, [selected, cdvSnapshot?.atmStrike])

  const step = snapshot?.step
  const rounded = snapshot?.roundedPrice ?? null

  // The live current bar in the CDV snapshot belongs to the ATM contract specifically, so it may
  // only be spliced onto these charts while they ARE the ATM contract - splicing it onto a pinned
  // strike would graft one contract's forming bar onto another contract's series.
  const chartedStrike = selectedStrike === ATM_STRIKE ? (cdvSnapshot?.atmStrike ?? null) : selectedStrike
  const showsAtmContract = chartedStrike != null && chartedStrike === cdvSnapshot?.atmStrike

  const spotBars = useAggregatedCandles(candles, snapshot?.currentBar, timeframe)
  const atmCeBars = useAggregatedCandles(atmCeCandles, showsAtmContract ? cdvSnapshot?.atmCeCurrentBar : null, timeframe)
  const atmPeBars = useAggregatedCandles(atmPeCandles, showsAtmContract ? cdvSnapshot?.atmPeCurrentBar : null, timeframe)

  const spotCrossState = useCrossoverState(spotBars)
  const atmCeCrossState = useCrossoverState(atmCeBars)
  const atmPeCrossState = useCrossoverState(atmPeBars)

  const cdvCe = useAggregatedLine(cdvSeries, cdvSnapshot?.currentBar, timeframe, ['ceCdv']).map((p) => ({ time: p.time, value: p.ceCdv }))
  const cdvPe = useAggregatedLine(cdvSeries, cdvSnapshot?.currentBar, timeframe, ['peCdv']).map((p) => ({ time: p.time, value: p.peCdv }))
  // No live bar to merge - previous-day is a fixed historical reference, not something ticks update.
  const cdvPrevCe = useAggregatedLine(cdvPrevDaySeries, null, timeframe, ['ceCdv']).map((p) => ({ time: p.time, value: p.ceCdv }))
  const cdvPrevPe = useAggregatedLine(cdvPrevDaySeries, null, timeframe, ['peCdv']).map((p) => ({ time: p.time, value: p.peCdv }))

  const obvCePoints = useMemo(() => aggregateLine(obvCe.map((p) => toLinePoint(p, ['obv'])), timeframe).map((p) => ({ time: p.time, value: p.obv })), [obvCe, timeframe])
  const obvPePoints = useMemo(() => aggregateLine(obvPe.map((p) => toLinePoint(p, ['obv'])), timeframe).map((p) => ({ time: p.time, value: p.obv })), [obvPe, timeframe])

  // Scaled to the unit each chart is set to, right before charting - everything upstream (and the
  // snapshot totals printed under the CDV chart) stays in raw units.
  const cdvCeScaled = useScaledLine(cdvCe, cdvUnit)
  const cdvPeScaled = useScaledLine(cdvPe, cdvUnit)
  const cdvPrevCeScaled = useScaledLine(cdvPrevCe, cdvUnit)
  const cdvPrevPeScaled = useScaledLine(cdvPrevPe, cdvUnit)
  const obvCeScaled = useScaledLine(obvCePoints, obvUnit)
  const obvPeScaled = useScaledLine(obvPePoints, obvUnit)
  const obvCeSplit = useTodayAndPreviousDay(obvCeScaled)
  const obvPeSplit = useTodayAndPreviousDay(obvPeScaled)

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <Spin size="large" />
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
          <Select
            value={selected}
            onChange={setSelected}
            style={{ width: 160 }}
            options={underlyings.map((u) => ({ value: u.underlying, label: u.underlying }))}
          />
          <Select
            value={timeframe}
            onChange={setTimeframe}
            style={{ width: 120 }}
            options={TIMEFRAME_OPTIONS}
          />
          <Button onClick={handleRefresh} loading={refreshing} disabled={!selected}>Refresh</Button>
        </Space>

        <Space direction="vertical" size={2} align="center" style={{ width: '100%' }}>
          <Text type="secondary">{selected} spot (rounded to nearest {step ?? '—'})</Text>
          <Text style={{ fontSize: 40, fontWeight: 600, lineHeight: 1.2 }}>{fmtPrice(rounded)}</Text>
          <Text type="secondary">Last traded: {fmtPrice(snapshot?.lastPrice)}</Text>
        </Space>

        <AlertsPanel alerts={alerts} states={crossoverStates} />

        <ChartCard
          title={`${selected} spot`}
          extra={<EmaLegend state={spotCrossState} />}
          empty="Waiting for chart data - the Dhan feed may still be connecting."
        >
          {spotBars.length > 0 && (
            <ChartErrorBoundary key={`${selected}-${timeframe}`} height={420}>
              <PriceChart bars={spotBars} height={420} />
            </ChartErrorBoundary>
          )}
        </ChartCard>

        <StrikePicker chain={strikeChain} value={selectedStrike} onChange={setSelectedStrike} live={showsAtmContract} />

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 400px', minWidth: 0 }}>
            <ChartCard
              title={`${showsAtmContract ? 'ATM ' : ''}CE ${chartedStrike ?? ''}`}
              extra={<EmaLegend state={atmCeCrossState} />}
              empty="Waiting for the CE contract to resolve and tick."
            >
              {atmCeBars.length > 0 && (
                <ChartErrorBoundary key={`${selected}-${timeframe}-${chartedStrike}`} height={320}>
                  <PriceChart bars={atmCeBars} height={320} />
                </ChartErrorBoundary>
              )}
            </ChartCard>
          </div>
          <div style={{ flex: '1 1 400px', minWidth: 0 }}>
            <ChartCard
              title={`${showsAtmContract ? 'ATM ' : ''}PE ${chartedStrike ?? ''}`}
              extra={<EmaLegend state={atmPeCrossState} />}
              empty="Waiting for the PE contract to resolve and tick."
            >
              {atmPeBars.length > 0 && (
                <ChartErrorBoundary key={`${selected}-${timeframe}-${chartedStrike}`} height={320}>
                  <PriceChart bars={atmPeBars} height={320} />
                </ChartErrorBoundary>
              )}
            </ChartCard>
          </div>
        </div>

        <ChartCard
          title="CE / PE Cumulative Delta Volume"
          extra={
            <Space size={12}>
              <Text type="secondary" style={{ fontSize: 12 }}>ATM {cdvSnapshot?.atmStrike ?? '—'} · Expiry {cdvSnapshot?.expiry ?? '—'}</Text>
              <Select value={cdvUnit} onChange={setCdvUnit} size="small" style={{ width: 140 }} options={VALUE_UNIT_OPTIONS} />
              <StrikesButton underlying={selected} />
            </Space>
          }
          empty="Waiting for option-chain data - strikes resolve once the spot price is known."
        >
          {cdvCe.length > 0 && (
            <>
              <ChartErrorBoundary key={`${selected}-${timeframe}`} height={280}>
                <CeVsPeChart ceSeries={cdvCeScaled} peSeries={cdvPeScaled} prevCeSeries={cdvPrevCeScaled} prevPeSeries={cdvPrevPeScaled} height={280} />
              </ChartErrorBoundary>
              <Space size={24} style={{ marginTop: 8 }}>
                <Text style={{ color: CE_COLOR }}>CE {fmtScaled(cdvSnapshot?.ceCdv, cdvUnit)}</Text>
                <Text style={{ color: PE_COLOR }}>PE {fmtScaled(cdvSnapshot?.peCdv, cdvUnit)}</Text>
              </Space>
            </>
          )}
        </ChartCard>

        {selected && <LookbackTable underlying={selected} cdvSnapshot={cdvSnapshot} />}

        <ChartCard
          title="CE / PE On-Balance Volume (delta-weighted, all tracked strikes)"
          extra={
            <Space size={12}>
              <Text type="secondary" style={{ fontSize: 12 }}>Skender.Stock.Indicators</Text>
              <Select value={obvUnit} onChange={setObvUnit} size="small" style={{ width: 140 }} options={VALUE_UNIT_OPTIONS} />
            </Space>
          }
          empty="Waiting for enough CE/PE bars to compute OBV."
        >
          {(obvCePoints.length > 0 || obvPePoints.length > 0) && (
            <ChartErrorBoundary key={`${selected}-${timeframe}-${cdvSnapshot?.atmStrike}`} height={280}>
              <CeVsPeChart ceSeries={obvCeSplit.today} peSeries={obvPeSplit.today} prevCeSeries={obvCeSplit.previous} prevPeSeries={obvPeSplit.previous} height={280} />
            </ChartErrorBoundary>
          )}
        </ChartCard>

        {selected && (
          <LookbackTable
            underlying={selected}
            cdvSnapshot={cdvSnapshot}
            endpoint="obv-lookback"
            title="OBV Multi-Lookback % Change"
            defaultBars={DEFAULT_LOOKBACK_BARS}
          />
        )}
      </Space>
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<DashboardPage />} />
      <Route path="/backtest" element={<BacktestPage />} />
      <Route path="/triggers" element={<TriggersPage />} />
    </Routes>
  )
}
