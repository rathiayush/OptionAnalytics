import { Component, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Select, Space, Typography, Button, Row, Col, Tooltip, Tag, InputNumber, Table, Segmented, Empty, Alert } from 'antd'
import { createChart, CandlestickSeries, LineSeries, CrosshairMode } from 'lightweight-charts'
import * as signalR from '@microsoft/signalr'
import {
  UP_COLOR, DOWN_COLOR, AXIS_COLOR, GRID_COLOR, BORDER_COLOR,
  istTimeFormatter, istTickMarkFormatter, toChartTime, TIMEFRAME_OPTIONS,
} from './shared.jsx'

const { Text } = Typography

// Pure helpers and chart/table components shared between OiReplayPage.jsx (historical replay) and
// OiLiveDashboardPage.jsx (always-live) - originally all lived inside OiReplayPage.jsx, extracted
// here UNCHANGED so both pages get one tested implementation. OiReplayPage.jsx keeps its own
// separate replay-clock machinery (visibleCount/asOfMs) entirely to itself; nothing in this file
// depends on that, which is exactly why it was safe to lift out - every function/component below
// takes its data via plain arguments/props.

// Modeled directly on App.jsx's own useHub: ONE connection, opened on mount and never torn down or
// rebuilt - no `enabled` gate, no dependency on underlying/expiryFlag (the SAME hub broadcasts ticks
// for every underlying; each caller just filters client-side in its own handlers, same as every
// consumer of oiReplayTick/futuresTick already does). This is the exact fix for the "reconnect churn"
// OiReplayPage's own useOiReplayLiveFeed was exposed to (its effect depends on `[enabled]`, which can
// flip during a fetch and tear the socket down at the worst moment) - this hook has no such flag.
// Originally local to OiLiveDashboardPage.jsx, moved here so a second live page (LiveStrikeDataPage)
// can share the identical connection logic rather than a third bespoke copy - OiReplayPage.jsx does
// not use this and is unaffected either way.
export function useOiLiveHub(onSpotUpdate, onOiReplayTick, onReconnected, onCdvUpdate, onCdvBarClosed) {
  const spotRef = useRef(onSpotUpdate)
  const tickRef = useRef(onOiReplayTick)
  const reconnectedRef = useRef(onReconnected)
  const cdvRef = useRef(onCdvUpdate)
  const cdvBarClosedRef = useRef(onCdvBarClosed)
  spotRef.current = onSpotUpdate
  tickRef.current = onOiReplayTick
  reconnectedRef.current = onReconnected
  cdvRef.current = onCdvUpdate
  cdvBarClosedRef.current = onCdvBarClosed

  const [connectionState, setConnectionState] = useState('connecting')

  useEffect(() => {
    const connection = new signalR.HubConnectionBuilder()
      .withUrl('/hubs/spot')
      .withAutomaticReconnect()
      .build()

    // Optional chaining on every one of these - unlike OiLiveDashboardPage (the original, only
    // caller until now), a caller like LiveStrikeDataPage genuinely has no use for some of these
    // events and passes null for them; calling a null ref directly would throw the moment that
    // event arrives, which for spotUpdate/oiReplayTick is roughly every second.
    connection.on('spotUpdate', (snapshot) => spotRef.current?.(snapshot))
    connection.on('oiReplayTick', (tick) => tickRef.current?.(tick))
    // Same CDV/OBV events App.jsx's own useHub already listens for, off the SAME shared hub -
    // CdvHostedService broadcasts these regardless of which page is open, so nothing extra needs
    // subscribing server-side for this page to receive them too.
    connection.on('cdvUpdate', (snapshot) => cdvRef.current?.(snapshot))
    connection.on('cdvBarClosed', (point) => cdvBarClosedRef.current?.(point))
    connection.onreconnecting(() => setConnectionState('reconnecting'))
    connection.onreconnected(() => { setConnectionState('connected'); reconnectedRef.current?.() })
    connection.onclose(() => setConnectionState('disconnected'))
    connection.start()
      .then(() => setConnectionState('connected'))
      .catch((err) => {
        // React StrictMode double-mounts every effect once in development - the first connection's
        // start() gets aborted by this effect's own cleanup before negotiation finishes on the
        // second mount. Not a real failure.
        if (err?.name === 'AbortError') return
        console.error('Live hub connection failed:', err)
        setConnectionState('disconnected')
      })

    return () => { connection.stop() }
  }, [])

  return connectionState
}

// One entry per distinct strike this side ever reported, its own points sorted ascending by time.
export function groupByStrike(points) {
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
// yet as of this point. Linear scan from the end: a real day's own per-strike series is at most a
// few hundred points, nowhere near hot enough to need a binary search.
export function latestAtOrBefore(sortedPoints, asOfMs) {
  for (let i = sortedPoints.length - 1; i >= 0; i--) {
    const t = new Date(sortedPoints[i].time).getTime()
    if (t <= asOfMs) return sortedPoints[i]
  }
  return null
}

// Buckets native 1-minute bars (already chart-time-shifted) into timeframeMinutes candles.
// Deliberately does NOT drop a trailing incomplete bucket - the whole point is to show the
// CURRENTLY FORMING candle live as 1-minute ticks keep arriving.
export function aggregateBars(oneMinBars, timeframeMinutes) {
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

// Standard EMA over already-aggregated bars' own closes - SMA-seeded, then smoothed forward with
// k = 2/(period+1). One point per bar from index period-1 onward.
export function computeEma(bars, period) {
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
// the currently-drifting ATM - an offset rather than an absolute strike, so "the default stays ATM"
// holds true all through the session even as ATM itself moves.
export function buildStrikeOffsetOptions(atmStrike, step) {
  if (atmStrike == null || !step) return []
  return Array.from({ length: 21 }, (_, i) => i - 10).map((offset) => ({
    value: offset,
    label: offset === 0 ? `ATM (${atmStrike})` : `ATM${offset > 0 ? '+' : ''}${offset} (${atmStrike + offset * step})`,
  }))
}

// One strike/side's own premium as a lightweight-charts line-series dataset, clipped to
// asOfMs. toChartTime already does its own new Date(...).getTime()/1000 internally - passing it a
// value already divided by 1000 double-converts every point's time down near the Unix epoch, which
// used to crash this chart once enough live ticks piled up (duplicate/out-of-order timestamps).
// Passing p.time straight through (ms number or ISO string, toChartTime accepts either) is correct.
export function buildPremiumLine(points, asOfMs) {
  if (!points || asOfMs == null) return []
  const mapped = points
    .filter((p) => new Date(p.time).getTime() <= asOfMs)
    .map((p) => ({ time: toChartTime(p.time), value: p.price }))
    // A malformed p.time (toChartTime returns NaN for it) or a missing p.price would otherwise
    // produce a non-finite point lightweight-charts throws on - see sanitizeCandles' own doc
    // comment for the exact same reasoning applied to the candle-shaped chart alongside this one.
    .filter((p) => Number.isFinite(p.time) && Number.isFinite(p.value))
  // Sort first rather than assume input is already time-ascending - a confirmed real crash
  // ("data must be asc ordered by time... prev time" later than the current one) showed that
  // assumption does not always hold for a live tick stream, not just a theoretical concern.
  const sorted = [...mapped].sort((a, b) => a.time - b.time)
  // De-duplicate same-second points, keeping the LAST value for that second rather than rejecting it.
  const deduped = []
  for (const point of sorted) {
    if (deduped.length > 0 && deduped[deduped.length - 1].time === point.time) deduped[deduped.length - 1] = point
    else deduped.push(point)
  }
  return deduped
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// Linear interpolation between a light and a dark shade, t in [0,1].
function shade(lightHex, darkHex, t) {
  const [lr, lg, lb] = hexToRgb(lightHex)
  const [dr, dg, db] = hexToRgb(darkHex)
  const r = Math.round(lr + (dr - lr) * t)
  const g = Math.round(lg + (dg - lg) * t)
  const b = Math.round(lb + (db - lb) * t)
  return `rgb(${r}, ${g}, ${b})`
}

// lightweight-charts' price-line `title` label auto-sizes to its own text, not to any data value -
// block characters baked into the title text are the only way to get a genuinely variable-length
// visual: "R ██████░░░░ 23400 (11.94M OI)".
const OI_BAR_BLOCKS = 10
function oiBarText(t, maxBlocks = OI_BAR_BLOCKS) {
  const filled = Math.max(1, Math.min(maxBlocks, Math.round(t * maxBlocks)))
  return '█'.repeat(filled) + '░'.repeat(maxBlocks - filled)
}

// OI, everywhere, always in millions - one comparable unit everywhere on the page.
export function formatOiMillions(n, { signed = false, withUnit = true } = {}) {
  if (n == null) return '—'
  const millions = n / 1_000_000
  const sign = signed && millions > 0 ? '+' : ''
  return `${sign}${millions.toFixed(2)}${withUnit ? 'M' : ''}`
}

const RESISTANCE_LIGHT = '#ffb3b3'
const RESISTANCE_DARK = '#7a0000'
const SUPPORT_LIGHT = '#b3f0c2'
const SUPPORT_DARK = '#0a5c1f'

// How many strikes on EACH side get an actual line drawn on the chart - only the strongest few (by
// OI) per side earn a line; the ladder already shows every strike.
const CHART_LEVELS_PER_SIDE = 5
// The widest ReplayChart's own candidate window is ever allowed to grow to hunt for
// CHART_LEVELS_PER_SIDE strikes with real OI.
const CHART_MAX_WINDOW_STEPS = 10

// Anything older than this, relative to "now", is flagged stale (dimmed + tooltip) instead of shown
// as if live - a real stored-data gap, not a rendering bug.
const OI_STALE_MS = 5 * 60_000

// Candlestick chart that draws the strongest OI levels on each side as horizontal price lines
// directly on the chart (darker = heavier OI = a "harder" level).
export function ReplayChart({ bars, ladderRows, dayKey, atmStrike, step, top5Only = true, height = 440 }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const priceLinesRef = useRef([])

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

    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      priceLinesRef.current = []
    }
  }, [height])

  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setData(bars)
  }, [bars])

  useEffect(() => {
    if (bars.length > 0) chartRef.current?.timeScale().fitContent()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey])

  useEffect(() => {
    if (!seriesRef.current) return
    for (const line of priceLinesRef.current) seriesRef.current.removePriceLine(line)
    priceLinesRef.current = []
    if (topRows.length === 0) return

    const allOi = [...topRows.map((r) => r.ceOi ?? 0), ...topRows.map((r) => r.peOi ?? 0)]
    const maxOi = allOi.length > 0 ? Math.max(...allOi) : 0

    const drawSide = (rows, key, ivKey, staleKey, sinceOpenKey, lightColor, darkColor, labelPrefix) => {
      for (const row of rows) {
        if ((row[key] ?? 0) <= 0) continue
        const t = maxOi > 0 ? row[key] / maxOi : 1
        const stale = row[staleKey]
        const sinceOpen = row[sinceOpenKey]
        const srDiff = (row.peOi ?? 0) - (row.ceOi ?? 0)
        const line = seriesRef.current.createPriceLine({
          price: row.strike,
          color: stale ? `${shade(lightColor, darkColor, t)}80` : shade(lightColor, darkColor, t),
          lineWidth: 1 + Math.round(t * 2),
          lineStyle: stale ? 1 : 2,
          axisLabelVisible: true,
          title: `${labelPrefix} ${oiBarText(t)} ${row.strike} (${formatOiMillions(row[key])} OI${row[ivKey] != null ? `, IV ${row[ivKey].toFixed(1)}` : ''}${sinceOpen != null ? `, Δ ${formatOiMillions(sinceOpen, { signed: true })}` : ''}, S-R ${formatOiMillions(srDiff, { signed: true })})${stale ? ' [STALE]' : ''}`,
        })
        priceLinesRef.current.push(line)
      }
    }

    drawSide(topRows, 'ceOi', 'ceIv', 'ceStale', 'ceOiSinceOpen', RESISTANCE_LIGHT, RESISTANCE_DARK, 'R')
    drawSide(topRows, 'peOi', 'peIv', 'peStale', 'peOiSinceOpen', SUPPORT_LIGHT, SUPPORT_DARK, 'S')
  }, [topRows])

  const ceLead = ceTop[0] ?? null
  const peLead = peTop[0] ?? null
  const ceDelta = ceLead?.ceOiSinceOpen ?? null
  const peDelta = peLead?.peOiSinceOpen ?? null
  const ceBias = ceDelta ? (ceDelta > 0 ? 'bearish' : 'bullish') : null
  const peBias = peDelta ? (peDelta > 0 ? 'bullish' : 'bearish') : null
  const tagBiasColor = (bias) => (bias === 'bullish' ? UP_COLOR : bias === 'bearish' ? DOWN_COLOR : AXIS_COLOR)
  const deltaTagStyle = (bias) => ({
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 6px',
    borderRadius: 4,
    background: '#00000080',
    color: tagBiasColor(bias),
    border: `1px solid ${tagBiasColor(bias)}`,
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

const EMA1_COLOR = '#f0b429'
const EMA2_COLOR = '#38bdf8'
// A subset of the shared TIMEFRAME_OPTIONS (1/3/5 min only) - the whole point of the fast entry
// charts is a faster read than the main chart's own coarser timeframe.
export const FAST_TIMEFRAME_OPTIONS = TIMEFRAME_OPTIONS.filter((o) => o.value <= 5)

// A second, independently-timeframed candlestick chart with two EMA overlays, driven by the SAME
// oneMinBars/visibleCount the caller owns - never fetches or replays anything on its own.
export function EmaChart({ oneMinBars, visibleCount, timeframe, onTimeframeChange, ema1Period, onEma1PeriodChange, ema2Period, onEma2PeriodChange, dayKey, height = 320 }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const ema1SeriesRef = useRef(null)
  const ema2SeriesRef = useRef(null)

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

    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      ema1SeriesRef.current = null
      ema2SeriesRef.current = null
    }
  }, [height])

  useEffect(() => { ema1SeriesRef.current?.applyOptions({ title: `EMA ${ema1Period}` }) }, [ema1Period])
  useEffect(() => { ema2SeriesRef.current?.applyOptions({ title: `EMA ${ema2Period}` }) }, [ema2Period])

  useEffect(() => { if (seriesRef.current) seriesRef.current.setData(displayBars) }, [displayBars])
  useEffect(() => { if (ema1SeriesRef.current) ema1SeriesRef.current.setData(ema1Points) }, [ema1Points])
  useEffect(() => { if (ema2SeriesRef.current) ema2SeriesRef.current.setData(ema2Points) }, [ema2Points])

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

// A single leg's own premium as its own chart, with its own auto-scaled price axis - two of these
// (CE and PE) render side by side rather than one chart with both as overlaid lines, since a far
// OTM leg's premium can be a small fraction of ATM's and would otherwise flatten to a useless sliver.
export function PremiumLineChart({ points, dayKey, color, height = 320 }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const sanitizedPoints = useMemo(() => sanitizeLinePoints(points), [points])

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
    seriesRef.current = chart.addSeries(LineSeries, { color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true })

    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [height, color])

  useEffect(() => { if (seriesRef.current) seriesRef.current.setData(sanitizedPoints) }, [sanitizedPoints])

  useEffect(() => {
    if (sanitizedPoints.length > 0) chartRef.current?.timeScale().fitContent()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// Buckets one strike/side's own raw points into real per-minute OHLC bars, the same way a genuine
// tick-driven candlestick chart is built anywhere else in this app (e.g. CdvStrikeRuntime's own
// ApplyPriceTick on the backend). Naturally handles BOTH the backfilled portion of the day (one
// point per minute from the rolling-option collector, so each becomes its own flat open=high=low=
// close candle - an honest "we only know the per-minute closing print" read for anything before this
// page was open) AND the live-ticked portion (several raw points landing in the same minute get
// properly folded into open/high/low/close as they arrive) with the SAME bucketing logic - no need
// to special-case which regime a given point came from.
export function buildPremiumCandles(points) {
  if (!points) return []
  const buckets = new Map()
  for (const p of points) {
    const minute = Math.floor(toChartTime(p.time) / 60) * 60
    // A malformed/unparseable p.time (toChartTime returns NaN for it) or a missing/non-numeric
    // p.price would otherwise silently produce a NaN-valued or NaN-keyed bucket - lightweight-charts
    // throws an UNCAUGHT error on a non-finite candle value, which is exactly the "this chart could
    // not be rendered" crash ChartErrorBoundary exists to catch, not something worth risking when a
    // single bad point can be dropped here instead with no visible loss (this page already tolerates
    // gaps - see OI_STALE_MS).
    if (!Number.isFinite(minute) || !Number.isFinite(p.price)) continue
    const existing = buckets.get(minute)
    if (existing) {
      existing.high = Math.max(existing.high, p.price)
      existing.low = Math.min(existing.low, p.price)
      existing.close = p.price
    } else {
      buckets.set(minute, { time: minute, open: p.price, high: p.price, low: p.price, close: p.price })
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time)
}

// Last line of defense before handing candles to lightweight-charts, which throws an UNCAUGHT error
// on a non-finite value, a duplicate time, or non-ascending order - same reasoning as App.jsx's own
// sanitizeSeries (this page's equivalent for a candle shape, not a plain line point). buildPremiumCa
// ndles above already filters/sorts its own output, but this is a second, independent guard so a
// crash here can never happen regardless of what future caller might pass to PremiumCandleChart.
function sanitizeCandles(bars) {
  const finite = bars.filter((b) => Number.isFinite(b.time) && Number.isFinite(b.open) && Number.isFinite(b.high) && Number.isFinite(b.low) && Number.isFinite(b.close))
  const sorted = [...finite].sort((a, b) => a.time - b.time)
  const result = []
  for (const b of sorted) {
    if (result.length > 0 && result[result.length - 1].time === b.time) result[result.length - 1] = b
    else result.push(b)
  }
  return result
}

// Same "last line of defense" reasoning as sanitizeCandles above, for a plain {time, value} line
// point instead of a candle - used by PremiumLineChart just below.
function sanitizeLinePoints(points) {
  const finite = points.filter((p) => Number.isFinite(p.time) && Number.isFinite(p.value))
  const sorted = [...finite].sort((a, b) => a.time - b.time)
  const result = []
  for (const p of sorted) {
    if (result.length > 0 && result[result.length - 1].time === p.time) result[result.length - 1] = p
    else result.push(p)
  }
  return result
}

// A single leg's own premium as a genuine candlestick chart, with its own auto-scaled price axis -
// two of these (CE and PE) render side by side rather than one chart with both overlaid, for the
// same reason PremiumLineChart above does (a far OTM leg's premium can be a small fraction of ATM's
// and would otherwise flatten to a useless sliver against the other leg's own scale). Mirrors how
// the Dashboard page (App.jsx) shows its own ATM CE/PE charts as real candles, not a line - unlike
// OiReplayPage's own single-price-per-minute rolling-collector data (which genuinely has no OHLC to
// show, hence PremiumLineChart's own line), this page also has the raw tick stream, so it can build
// real OHLC itself - see buildPremiumCandles above.
export function PremiumCandleChart({ bars, dayKey, height = 320 }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const sanitizedBars = useMemo(() => sanitizeCandles(bars), [bars])

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

    const onResize = () => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
    }
  }, [height])

  useEffect(() => { if (seriesRef.current) seriesRef.current.setData(sanitizedBars) }, [sanitizedBars])

  useEffect(() => {
    if (sanitizedBars.length > 0) chartRef.current?.timeScale().fitContent()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayKey])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// SEBI periodically revises each index's own lot size - update this if it changes. This feature is
// paper trading only (no real order is ever placed), so a stale value here only skews the SIMULATED
// PnL's scale, not anything real.
export const PAPER_TRADE_LOT_SIZE = { NIFTY: 75, BANKNIFTY: 35, SENSEX: 20 }

// One simulated position: Buy (long) or Sell (short/write) CE/PE at whatever the live premium series
// shows right now, then Exit later - entirely client-side, no backend call, no real order.
export function PaperTradePanel({
  atmStrike, step, side, onSideChange, direction, onDirectionChange, strikeOffset, onStrikeOffsetChange,
  qtyLots, onQtyLotsChange, onPunch, canPunch, positions, onExit, onClearAll,
}) {
  const strikeOptions = useMemo(() => buildStrikeOffsetOptions(atmStrike, step), [atmStrike, step])

  const totalPnl = positions.reduce((sum, p) => sum + p.pnl, 0)

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
      title: '', key: 'action', width: 55,
      render: (_, r) => (r.status === 'OPEN' ? <Button size="small" onClick={() => onExit(r.id)}>Exit</Button> : <Tag>Closed</Tag>),
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
          <Button type="primary" size="small" onClick={onPunch} disabled={!canPunch}>
            {direction === 'SELL' ? 'Sell' : 'Buy'}
          </Button>
        </Space>
        {positions.length > 0 && (
          <>
            <Table dataSource={positions} columns={columns} rowKey="id" size="small" pagination={false} scroll={{ y: 220 }} />
            <Space style={{ width: '100%', justifyContent: 'space-between' }}>
              <Text strong style={{ color: totalPnl >= 0 ? UP_COLOR : DOWN_COLOR }}>
                Total PnL: {totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(0)}
              </Text>
              <Button size="small" danger onClick={onClearAll}>Clear all</Button>
            </Space>
          </>
        )}
        <Text type="secondary" style={{ fontSize: 10 }}>
          Paper trade only - simulated against the live premium series, no real order is ever placed. Buy (long) or Sell (short/write),
          then Exit; lot size is a fixed per-underlying constant, not fetched live.
        </Text>
      </Space>
    </div>
  )
}

// A genuinely draggable floating panel, rendered into a portal on document.body so it sits above
// every other element regardless of where its trigger lives in the tree. Position is tracked as a
// plain {x,y} in the PARENT's own state so it survives closing and reopening the panel.
export function DraggableFloatingPanel({ title, pos, onPosChange, onClose, children }) {
  const dragRef = useRef(null)

  const onHeaderMouseDown = (e) => {
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y }
    const onMouseMove = (moveEvent) => {
      if (!dragRef.current) return
      const dx = moveEvent.clientX - dragRef.current.startX
      const dy = moveEvent.clientY - dragRef.current.startY
      const maxX = Math.max(0, window.innerWidth - 80)
      const maxY = Math.max(0, window.innerHeight - 40)
      onPosChange({
        x: Math.min(Math.max(0, dragRef.current.origX + dx), maxX),
        y: Math.min(Math.max(0, dragRef.current.origY + dy), maxY),
      })
    }
    const onMouseUp = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  return createPortal(
    <div style={{
      position: 'fixed', left: pos.x, top: pos.y, zIndex: 1000, width: 440,
      background: '#1f1f1f', border: `1px solid ${BORDER_COLOR}`, borderRadius: 8,
      boxShadow: '0 8px 28px rgba(0, 0, 0, 0.55)',
    }}
    >
      <div
        onMouseDown={onHeaderMouseDown}
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '8px 12px', cursor: 'move', borderBottom: `1px solid ${BORDER_COLOR}`, userSelect: 'none',
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

// A small colored delta label for a one-minute OI change.
function OiChange({ value }) {
  if (value == null || value === 0) return <Text style={{ fontSize: 9, color: AXIS_COLOR }}>·</Text>
  const up = value > 0
  return (
    <Text style={{ fontSize: 9, color: up ? UP_COLOR : DOWN_COLOR }}>
      {up ? '▲' : '▼'}{formatOiMillions(Math.abs(value))}
    </Text>
  )
}

// Cumulative OI change since the day's very first revealed point.
function SinceOpenChange({ value }) {
  if (value == null) return null
  if (value === 0) return <Text style={{ fontSize: 8, color: AXIS_COLOR }}>open ·</Text>
  const up = value > 0
  return (
    <Tooltip title={`${up ? '+' : ''}${value.toLocaleString()} since today's open`}>
      <Text style={{ fontSize: 8, color: up ? UP_COLOR : DOWN_COLOR, whiteSpace: 'nowrap' }}>
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

// The right-hand OI/IV ladder: every strike in the fetched band gets its own row, a CE bar
// extending right and a PE bar extending left from a shared center scale, both sides' IV printed
// alongside. The row(s) carrying the MOST OI on each side are called out as the current
// resistance (CE)/support (PE) read.
export function OiLadder({ rows, atmStrike }) {
  if (rows.length === 0) return <Empty description="No OI/IV data yet." />

  const maxOi = Math.max(1, ...rows.map((r) => r.ceOi ?? 0), ...rows.map((r) => r.peOi ?? 0))
  const resistanceStrike = rows.reduce((best, r) => ((r.ceOi ?? 0) > (best?.ceOi ?? -1) ? r : best), null)?.strike
  const supportStrike = rows.reduce((best, r) => ((r.peOi ?? 0) > (best?.peOi ?? -1) ? r : best), null)?.strike

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Row style={{ fontSize: 11, color: AXIS_COLOR, marginBottom: 4 }}>
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
              <Text style={{ fontSize: 10, color: AXIS_COLOR, whiteSpace: 'nowrap' }}>
                {row.pePrice != null ? `${row.pePrice.toFixed(2)}` : ''}
                {row.peIv != null ? ` · IV ${row.peIv.toFixed(1)}` : ''}
                {row.peStale ? ' ⚠' : ''}
              </Text>
              <Text style={{ fontSize: 9, color: AXIS_COLOR, width: 34, textAlign: 'right', whiteSpace: 'nowrap' }}>
                {row.peOi != null ? formatOiMillions(row.peOi) : ''}
              </Text>
              <div style={{ width: 70, display: 'flex', justifyContent: 'flex-end' }}>
                <Tooltip title={row.peOi != null ? `PE OI: ${row.peOi.toLocaleString()}${row.pePrice != null ? `, LTP ${row.pePrice.toFixed(2)}` : ''}${row.peOiChange != null ? ` (${row.peOiChange >= 0 ? '+' : ''}${row.peOiChange.toLocaleString()} in the last min)` : ''}${row.peOiSinceOpen != null ? ` (${row.peOiSinceOpen >= 0 ? '+' : ''}${row.peOiSinceOpen.toLocaleString()} since open)` : ''}${row.peStale && row.peAsOfMs != null ? ` — STALE, no update since ${istTimeFormatter(toChartTime(row.peAsOfMs))}` : ''}` : 'No data'}>
                  <div style={{
                    width: `${((row.peOi ?? 0) / maxOi) * 100}%`, minWidth: row.peOi ? 2 : 0, height: 14,
                    background: isSupport ? UP_COLOR : `${UP_COLOR}99`,
                  }} />
                </Tooltip>
              </div>
            </Col>
            <Col span={4} style={{ textAlign: 'center' }}>
              <Text strong={isAtm} style={{ fontSize: 12, color: isAtm ? '#fff' : undefined }}>{row.strike.toLocaleString()}</Text>
            </Col>
            <Col span={10} style={{ display: 'flex', alignItems: 'center', gap: 4, opacity: row.ceStale ? 0.45 : 1 }}>
              <div style={{ width: 70 }}>
                <Tooltip title={row.ceOi != null ? `CE OI: ${row.ceOi.toLocaleString()}${row.cePrice != null ? `, LTP ${row.cePrice.toFixed(2)}` : ''}${row.ceOiChange != null ? ` (${row.ceOiChange >= 0 ? '+' : ''}${row.ceOiChange.toLocaleString()} in the last min)` : ''}${row.ceOiSinceOpen != null ? ` (${row.ceOiSinceOpen >= 0 ? '+' : ''}${row.ceOiSinceOpen.toLocaleString()} since open)` : ''}${row.ceStale && row.ceAsOfMs != null ? ` — STALE, no update since ${istTimeFormatter(toChartTime(row.ceAsOfMs))}` : ''}` : 'No data'}>
                  <div style={{
                    width: `${((row.ceOi ?? 0) / maxOi) * 100}%`, minWidth: row.ceOi ? 2 : 0, height: 14,
                    background: isResistance ? DOWN_COLOR : `${DOWN_COLOR}99`,
                  }} />
                </Tooltip>
              </div>
              <Text style={{ fontSize: 9, color: AXIS_COLOR, width: 34, whiteSpace: 'nowrap' }}>
                {row.ceOi != null ? formatOiMillions(row.ceOi) : ''}
              </Text>
              <OiChangeStack changeValue={row.ceOiChange} sinceOpenValue={row.ceOiSinceOpen} />
              <Text style={{ fontSize: 10, color: AXIS_COLOR, whiteSpace: 'nowrap' }}>
                {row.cePrice != null ? `${row.cePrice.toFixed(2)}` : ''}
                {row.ceIv != null ? ` · IV ${row.ceIv.toFixed(1)}` : ''}
                {row.ceStale ? ' ⚠' : ''}
              </Text>
            </Col>
          </Row>
        )
      })}
    </div>
  )
}

// Same reasoning as OiReplayPage's own ChartErrorBoundary - a lightweight-charts assertion or bad
// data shape should degrade to a message, not blank the whole page.
export class ChartErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error('Live OI Dashboard chart crashed:', error)
  }

  render() {
    if (this.state.error) {
      return <Alert type="warning" showIcon message="This chart could not be rendered - the ladder and stats above are still available." />
    }
    return this.props.children
  }
}

export { OI_STALE_MS }
