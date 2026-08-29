import { useEffect, useMemo, useRef, useState } from 'react'
import { Select, Space, Typography, Spin, Card } from 'antd'
import { createChart, createSeriesMarkers, CandlestickSeries, LineSeries, CrosshairMode } from 'lightweight-charts'
import * as signalR from '@microsoft/signalr'
import './App.css'

const { Title, Text } = Typography

const UP_COLOR = '#26a69a'
const DOWN_COLOR = '#ef5350'
const CE_COLOR = '#3ddc84'
const PE_COLOR = '#ff5c5c'
const EMA_FAST_COLOR = '#ffb100'
const EMA_SLOW_COLOR = '#4dabf7'
const AXIS_COLOR = '#9aa4b2'
const GRID_COLOR = '#ffffff14'
const BORDER_COLOR = '#ffffff22'

function toChartTime(isoOrDate) {
  return Math.floor(new Date(isoOrDate).getTime() / 1000)
}

function candleToBar(c) {
  return { time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close }
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
// the "TradingView-style EMA crossover" overlay for the spot chart.
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
      const time = toChartTime(bars[i].time)
      if (ema9[i] != null) ema9Points.push({ time, value: ema9[i] })
      if (ema21[i] != null) ema21Points.push({ time, value: ema21[i] })

      if (ema9[i] != null && ema21[i] != null) {
        const diff = ema9[i] - ema21[i]
        if (prevDiff != null) {
          if (prevDiff <= 0 && diff > 0) {
            markers.push({ time, position: 'belowBar', color: UP_COLOR, shape: 'arrowUp', text: 'EMA 9/21' })
          } else if (prevDiff >= 0 && diff < 0) {
            markers.push({ time, position: 'aboveBar', color: DOWN_COLOR, shape: 'arrowDown', text: 'EMA 9/21' })
          }
        }
        prevDiff = diff
      }
    }

    return { ema9Points, ema21Points, markers }
  }, [bars])
}

function fmtPrice(v) {
  return v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })
}

function fmtCdv(v) {
  return v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })
}

// One SignalR connection shared by both the spot chart and the CDV chart - each just registers
// its own handler for the event it cares about ("spotUpdate" / "cdvUpdate").
function useHub(onSpotUpdate, onCdvUpdate) {
  const spotHandlerRef = useRef(onSpotUpdate)
  const cdvHandlerRef = useRef(onCdvUpdate)
  spotHandlerRef.current = onSpotUpdate
  cdvHandlerRef.current = onCdvUpdate

  useEffect(() => {
    const connection = new signalR.HubConnectionBuilder()
      .withUrl('/hubs/spot')
      .withAutomaticReconnect()
      .build()

    connection.on('spotUpdate', (snapshot) => spotHandlerRef.current(snapshot))
    connection.on('cdvUpdate', (snapshot) => cdvHandlerRef.current(snapshot))
    connection.start().catch((err) => console.error('SignalR connection failed:', err))

    return () => { connection.stop() }
  }, [])
}

function SpotChart({ candles, liveBar }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const ema9Ref = useRef(null)
  const ema21Ref = useRef(null)
  const markersRef = useRef(null)

  // The live-updating bar merged into the closed-bar list, so the EMA/crossover calculation
  // always includes the current forming bar - the same combined series the candlestick itself
  // effectively shows via setData + update().
  const bars = useMemo(() => {
    if (!liveBar) return candles
    return [...candles.filter((c) => c.time !== liveBar.time), liveBar]
  }, [candles, liveBar])

  const { ema9Points, ema21Points, markers } = useEmaCrossover(bars)

  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 440,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
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
    // recreating the chart, so switching the underlying doesn't flicker a fresh empty chart in.
  }, [])

  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setData(candles.map(candleToBar))
    chartRef.current?.timeScale().fitContent()
  }, [candles])

  useEffect(() => {
    if (!seriesRef.current || !liveBar) return
    seriesRef.current.update(candleToBar(liveBar))
  }, [liveBar])

  useEffect(() => {
    if (!ema9Ref.current || !ema21Ref.current) return
    ema9Ref.current.setData(ema9Points)
    ema21Ref.current.setData(ema21Points)
  }, [ema9Points, ema21Points])

  useEffect(() => {
    markersRef.current?.setMarkers(markers)
  }, [markers])

  return <div ref={containerRef} style={{ width: '100%', height: 440 }} />
}

function CdvChart({ series, liveBar }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const ceRef = useRef(null)
  const peRef = useRef(null)

  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 320,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Normal },
    })
    chartRef.current = chart
    ceRef.current = chart.addSeries(LineSeries, { color: CE_COLOR, lineWidth: 2, title: 'CE', priceLineVisible: false })
    peRef.current = chart.addSeries(LineSeries, { color: PE_COLOR, lineWidth: 2, title: 'PE', priceLineVisible: false })

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
    }
  }, [])

  useEffect(() => {
    if (!ceRef.current || !peRef.current) return
    ceRef.current.setData(series.map((p) => ({ time: toChartTime(p.time), value: p.ceCdv })))
    peRef.current.setData(series.map((p) => ({ time: toChartTime(p.time), value: p.peCdv })))
    chartRef.current?.timeScale().fitContent()
  }, [series])

  useEffect(() => {
    if (!ceRef.current || !peRef.current || !liveBar) return
    ceRef.current.update({ time: toChartTime(liveBar.time), value: liveBar.ceCdv })
    peRef.current.update({ time: toChartTime(liveBar.time), value: liveBar.peCdv })
  }, [liveBar])

  return <div ref={containerRef} style={{ width: '100%', height: 320 }} />
}

export default function App() {
  const [underlyings, setUnderlyings] = useState([])
  const [selected, setSelected] = useState(null)
  const [candles, setCandles] = useState([])
  const [snapshot, setSnapshot] = useState(null)
  const [cdvSeries, setCdvSeries] = useState([])
  const [cdvSnapshot, setCdvSnapshot] = useState(null)
  const [loading, setLoading] = useState(true)

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

  useEffect(() => {
    if (!selected) return
    let cancelled = false

    fetch(`/api/spot/${selected}/candles`)
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setCandles(data) })
      .catch((err) => console.error('Failed to load candles:', err))

    fetch(`/api/spot/${selected}/snapshot`)
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setSnapshot(data) })
      .catch((err) => console.error('Failed to load snapshot:', err))

    fetch(`/api/cdv/${selected}/series`)
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setCdvSeries(data) })
      .catch((err) => console.error('Failed to load CDV series:', err))

    fetch(`/api/cdv/${selected}/snapshot`)
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setCdvSnapshot(data) })
      .catch((err) => console.error('Failed to load CDV snapshot:', err))

    return () => { cancelled = true }
  }, [selected])

  useHub(
    (incoming) => { if (incoming.underlying === selected) setSnapshot(incoming) },
    (incoming) => { if (incoming.underlying === selected) setCdvSnapshot(incoming) },
  )

  const step = snapshot?.step
  const rounded = useMemo(() => snapshot?.roundedPrice ?? null, [snapshot])

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <Spin size="large" />
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16}>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <Select
            value={selected}
            onChange={setSelected}
            style={{ width: 180 }}
            options={underlyings.map((u) => ({ value: u.underlying, label: u.underlying }))}
          />
        </Space>

        <div style={{ border: `1px solid ${BORDER_COLOR}`, borderRadius: 8, padding: 12 }}>
          <Space size={16} style={{ marginBottom: 4 }}>
            <Text style={{ color: EMA_FAST_COLOR, fontSize: 12 }}>— EMA 9</Text>
            <Text style={{ color: EMA_SLOW_COLOR, fontSize: 12 }}>— EMA 21</Text>
          </Space>
          {candles.length > 0 ? (
            <SpotChart candles={candles} liveBar={snapshot?.currentBar} />
          ) : (
            <div style={{ height: 440, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Text type="secondary">Waiting for chart data - the Dhan feed may still be connecting.</Text>
            </div>
          )}
        </div>

        <Space direction="vertical" size={2} align="center" style={{ width: '100%' }}>
          <Text type="secondary">{selected} spot (rounded to nearest {step ?? '—'})</Text>
          <Text style={{ fontSize: 40, fontWeight: 600, lineHeight: 1.2 }}>{fmtPrice(rounded)}</Text>
          <Text type="secondary">Last traded: {fmtPrice(snapshot?.lastPrice)}</Text>
        </Space>

        <Card
          size="small"
          title="CE / PE Cumulative Delta Volume"
          extra={
            <Text type="secondary" style={{ fontSize: 12 }}>
              ATM {cdvSnapshot?.atmStrike ?? '—'} · Expiry {cdvSnapshot?.expiry ?? '—'}
            </Text>
          }
        >
          {cdvSeries.length > 0 ? (
            <CdvChart series={cdvSeries} liveBar={cdvSnapshot?.currentBar} />
          ) : (
            <div style={{ height: 320, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Text type="secondary">Waiting for option-chain data - strikes resolve once the spot price is known.</Text>
            </div>
          )}
          <Space size={24} style={{ marginTop: 8 }}>
            <Text style={{ color: CE_COLOR }}>CE {fmtCdv(cdvSnapshot?.ceCdv)}</Text>
            <Text style={{ color: PE_COLOR }}>PE {fmtCdv(cdvSnapshot?.peCdv)}</Text>
          </Space>
        </Card>
      </Space>
    </div>
  )
}
