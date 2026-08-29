import { useEffect, useMemo, useRef, useState } from 'react'
import { Select, Space, Typography, Spin } from 'antd'
import { createChart, CandlestickSeries, CrosshairMode } from 'lightweight-charts'
import * as signalR from '@microsoft/signalr'
import './App.css'

const { Title, Text } = Typography

const UP_COLOR = '#26a69a'
const DOWN_COLOR = '#ef5350'
const AXIS_COLOR = '#9aa4b2'
const GRID_COLOR = '#ffffff14'
const BORDER_COLOR = '#ffffff22'

function toChartTime(isoOrDate) {
  return Math.floor(new Date(isoOrDate).getTime() / 1000)
}

function candleToBar(c) {
  return { time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close }
}

function fmtPrice(v) {
  return v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })
}

function useSpotHub(onSnapshot) {
  const handlerRef = useRef(onSnapshot)
  handlerRef.current = onSnapshot

  useEffect(() => {
    const connection = new signalR.HubConnectionBuilder()
      .withUrl('/hubs/spot')
      .withAutomaticReconnect()
      .build()

    connection.on('spotUpdate', (snapshot) => handlerRef.current(snapshot))
    connection.start().catch((err) => console.error('SignalR connection failed:', err))

    return () => { connection.stop() }
  }, [])
}

function Chart({ candles, liveBar }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)

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

    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth })
    }
    window.addEventListener('resize', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
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

  return <div ref={containerRef} style={{ width: '100%', height: 440 }} />
}

export default function App() {
  const [underlyings, setUnderlyings] = useState([])
  const [selected, setSelected] = useState(null)
  const [candles, setCandles] = useState([])
  const [snapshot, setSnapshot] = useState(null)
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

    return () => { cancelled = true }
  }, [selected])

  useSpotHub((incoming) => {
    if (incoming.underlying === selected) setSnapshot(incoming)
  })

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
          {candles.length > 0 ? (
            <Chart candles={candles} liveBar={snapshot?.currentBar} />
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
      </Space>
    </div>
  )
}
