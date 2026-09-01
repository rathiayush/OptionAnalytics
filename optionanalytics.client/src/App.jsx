import { Component, useEffect, useMemo, useRef, useState } from 'react'
import { Select, Space, Typography, Spin, Card, Button, Modal, Table, Tag } from 'antd'
import { createChart, createSeriesMarkers, CandlestickSeries, LineSeries, CrosshairMode, LineStyle, TickMarkType } from 'lightweight-charts'
import * as signalR from '@microsoft/signalr'
import { Routes, Route } from 'react-router-dom'
import BacktestPage from './BacktestPage.jsx'
import { UP_COLOR, DOWN_COLOR, CE_COLOR, PE_COLOR, ALERT_KIND_LABEL, fmtPrice, fmtIstTime, DirectionTag, NavBar } from './shared.jsx'
import './App.css'

const { Title, Text } = Typography

const EMA_FAST_COLOR = '#ffb100'
const EMA_SLOW_COLOR = '#4dabf7'
const AXIS_COLOR = '#9aa4b2'
const GRID_COLOR = '#ffffff14'
const BORDER_COLOR = '#ffffff22'

const TIMEFRAME_OPTIONS = [
  { value: 1, label: '1 min' },
  { value: 3, label: '3 min' },
  { value: 5, label: '5 min' },
]

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
function useHub(onSpotUpdate, onCdvUpdate, onConfluenceAlert) {
  const spotHandlerRef = useRef(onSpotUpdate)
  const cdvHandlerRef = useRef(onCdvUpdate)
  const alertHandlerRef = useRef(onConfluenceAlert)
  spotHandlerRef.current = onSpotUpdate
  cdvHandlerRef.current = onCdvUpdate
  alertHandlerRef.current = onConfluenceAlert

  useEffect(() => {
    const connection = new signalR.HubConnectionBuilder()
      .withUrl('/hubs/spot')
      .withAutomaticReconnect()
      .build()

    connection.on('spotUpdate', (snapshot) => spotHandlerRef.current(snapshot))
    connection.on('cdvUpdate', (snapshot) => cdvHandlerRef.current(snapshot))
    connection.on('confluenceAlert', (alert) => alertHandlerRef.current(alert))
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

    return () => {
      window.removeEventListener('resize', onResize)
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
    markersRef.current?.setMarkers(markers)
  }, [markers])

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
    hasFitRef.current = false

    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth })
    }
    window.addEventListener('resize', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
      chart.remove()
      chartRef.current = null
      ceRef.current = null
      peRef.current = null
      prevCeRef.current = null
      prevPeRef.current = null
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

// CE/PE %-change over configurable lookback windows (default 3/5/7 bars), off the backend's
// EMA-smoothed CDV series - mirrors LiveSpreadCalculator's own "Multi-Lookback" table for the same
// Pine indicator. The bars selector accepts free-form numbers (antd's tags mode), not just the
// preset options, so "configurable" isn't limited to a fixed list.
function LookbackTable({ underlying, cdvSnapshot }) {
  const [bars, setBars] = useState(DEFAULT_LOOKBACK_BARS)
  const [table, setTable] = useState(null)
  const lastBarTimeRef = useRef(null)

  const load = (barsToUse) => {
    fetch(`/api/cdv/${underlying}/lookback?bars=${barsToUse.join(',')}`)
      .then((r) => r.json())
      .then(setTable)
      .catch((err) => console.error('Failed to load lookback table:', err))
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
      title="CE / PE Lookback % Change"
      extra={
        <Select
          mode="tags"
          size="small"
          value={bars.map(String)}
          onChange={(vals) => {
            const parsed = [...new Set(vals.map((v) => parseInt(v, 10)).filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b)
            setBars(parsed.length > 0 ? parsed : DEFAULT_LOOKBACK_BARS)
          }}
          style={{ minWidth: 180 }}
          options={[3, 5, 7, 10, 15, 20].map((n) => ({ value: String(n), label: `${n} bars` }))}
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
  const [selected, setSelected] = useState(null)
  const [timeframe, setTimeframe] = useState(1)
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
  useEffect(() => {
    fetch('/api/alerts/state')
      .then((r) => r.json())
      .then((data) => setCrossoverStates(data ?? []))
      .catch((err) => console.error('Failed to load crossover state:', err))
  }, [])

  const [cdvSeries, setCdvSeries] = useState([])
  const [cdvSnapshot, setCdvSnapshot] = useState(null)
  const [cdvPrevDaySeries, setCdvPrevDaySeries] = useState([])

  const [atmCeCandles, setAtmCeCandles] = useState([])
  const [atmPeCandles, setAtmPeCandles] = useState([])

  const [obvCe, setObvCe] = useState([])
  const [obvPe, setObvPe] = useState([])

  const lastObvBarTimeRef = useRef({ ce: null, pe: null })

  useEffect(() => {
    fetch('/api/spot/underlyings')
      .then((r) => r.json())
      .then((list) => {
        setUnderlyings(list)
        if (list.length > 0) setSelected(list[0].underlying)
      })
      .catch((err) => console.error('Failed to load underlyings:', err))
      .finally(() => setLoading(false))
  }, [])

  // Fetches ATM CE/PE candles + OBV - shared by the main [selected] load, the ATM-rollover effect
  // below, and the manual Refresh button, all of which need the exact same "wholesale replace"
  // fetch. Returns a settled-promise so callers that care when it's done (the Refresh button) can
  // await it; callers that don't (the effects) just fire it.
  const fetchAtmAndObv = (underlying, cancelledRef) => {
    const ce = fetch(`/api/cdv/${underlying}/atm-ce/candles`)
      .then((r) => r.json())
      .then((data) => { if (!cancelledRef.cancelled) setAtmCeCandles(data) })
      .catch((err) => console.error('Failed to load ATM CE candles:', err))

    const pe = fetch(`/api/cdv/${underlying}/atm-pe/candles`)
      .then((r) => r.json())
      .then((data) => { if (!cancelledRef.cancelled) setAtmPeCandles(data) })
      .catch((err) => console.error('Failed to load ATM PE candles:', err))

    const obv = fetch(`/api/cdv/${underlying}/obv-series`)
      .then((r) => r.json())
      .then((data) => { if (!cancelledRef.cancelled) { setObvCe(data.ce ?? []); setObvPe(data.pe ?? []) } })
      .catch((err) => console.error('Failed to load OBV series:', err))

    return Promise.allSettled([ce, pe, obv])
  }

  // Everything the page shows for one underlying, fetched fresh - the initial [selected] load and
  // the manual Refresh button both just call this with a no-op-on-unmount cancelledRef.
  const fetchAllData = (underlying, cancelledRef) => {
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
    fetchAllData(selected, cancelledRef)
    return () => { cancelledRef.cancelled = true }
  }, [selected])

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
  )

  // ATM CE/PE bars only change value on every tick (the premium moves), but OBV is a per-bar
  // indicator - only worth recomputing when a bar actually closes. Refetch the (small) OBV series
  // whenever either side's current-bar time moves to a new minute, not on every tick.
  useEffect(() => {
    if (!selected || !cdvSnapshot) return
    const ceTime = cdvSnapshot.atmCeCurrentBar?.time ?? null
    const peTime = cdvSnapshot.atmPeCurrentBar?.time ?? null
    const prev = lastObvBarTimeRef.current
    if (ceTime === prev.ce && peTime === prev.pe) return
    lastObvBarTimeRef.current = { ce: ceTime, pe: peTime }

    fetch(`/api/cdv/${selected}/obv-series`)
      .then((r) => r.json())
      .then((data) => { setObvCe(data.ce ?? []); setObvPe(data.pe ?? []) })
      .catch((err) => console.error('Failed to refresh OBV series:', err))
  }, [selected, cdvSnapshot?.atmCeCurrentBar?.time, cdvSnapshot?.atmPeCurrentBar?.time])

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

  const spotBars = useAggregatedCandles(candles, snapshot?.currentBar, timeframe)
  const atmCeBars = useAggregatedCandles(atmCeCandles, cdvSnapshot?.atmCeCurrentBar, timeframe)
  const atmPeBars = useAggregatedCandles(atmPeCandles, cdvSnapshot?.atmPeCurrentBar, timeframe)

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

        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 400px', minWidth: 0 }}>
            <ChartCard
              title={`ATM CE ${cdvSnapshot?.atmStrike ?? ''}`}
              extra={<EmaLegend state={atmCeCrossState} />}
              empty="Waiting for the ATM CE contract to resolve and tick."
            >
              {atmCeBars.length > 0 && (
                <ChartErrorBoundary key={`${selected}-${timeframe}-${cdvSnapshot?.atmStrike}`} height={320}>
                  <PriceChart bars={atmCeBars} height={320} />
                </ChartErrorBoundary>
              )}
            </ChartCard>
          </div>
          <div style={{ flex: '1 1 400px', minWidth: 0 }}>
            <ChartCard
              title={`ATM PE ${cdvSnapshot?.atmStrike ?? ''}`}
              extra={<EmaLegend state={atmPeCrossState} />}
              empty="Waiting for the ATM PE contract to resolve and tick."
            >
              {atmPeBars.length > 0 && (
                <ChartErrorBoundary key={`${selected}-${timeframe}-${cdvSnapshot?.atmStrike}`} height={320}>
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
              <StrikesButton underlying={selected} />
            </Space>
          }
          empty="Waiting for option-chain data - strikes resolve once the spot price is known."
        >
          {cdvCe.length > 0 && (
            <>
              <ChartErrorBoundary key={`${selected}-${timeframe}`} height={280}>
                <CeVsPeChart ceSeries={cdvCe} peSeries={cdvPe} prevCeSeries={cdvPrevCe} prevPeSeries={cdvPrevPe} height={280} />
              </ChartErrorBoundary>
              <Space size={24} style={{ marginTop: 8 }}>
                <Text style={{ color: CE_COLOR }}>CE {fmtNum(cdvSnapshot?.ceCdv)}</Text>
                <Text style={{ color: PE_COLOR }}>PE {fmtNum(cdvSnapshot?.peCdv)}</Text>
              </Space>
            </>
          )}
        </ChartCard>

        {selected && <LookbackTable underlying={selected} cdvSnapshot={cdvSnapshot} />}

        <ChartCard
          title="CE / PE On-Balance Volume (ATM)"
          extra={<Text type="secondary" style={{ fontSize: 12 }}>Skender.Stock.Indicators</Text>}
          empty="Waiting for enough ATM CE/PE bars to compute OBV."
        >
          {(obvCePoints.length > 0 || obvPePoints.length > 0) && (
            <ChartErrorBoundary key={`${selected}-${timeframe}-${cdvSnapshot?.atmStrike}`} height={280}>
              <CeVsPeChart ceSeries={obvCePoints} peSeries={obvPePoints} height={280} />
            </ChartErrorBoundary>
          )}
        </ChartCard>
      </Space>
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<DashboardPage />} />
      <Route path="/backtest" element={<BacktestPage />} />
    </Routes>
  )
}
