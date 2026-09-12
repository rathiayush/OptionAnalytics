import { Component, useEffect, useMemo, useRef, useState } from 'react'
import { Card, Select, InputNumber, Space, Typography, Button, Statistic, Row, Col, Empty, Alert, DatePicker, Segmented } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { createChart, createSeriesMarkers, CandlestickSeries, CrosshairMode } from 'lightweight-charts'
import {
  NavBar, fmtPrice, fmtIstDateTime,
  CE_COLOR, PE_COLOR, UP_COLOR, DOWN_COLOR,
  AXIS_COLOR, GRID_COLOR, BORDER_COLOR, istTimeFormatter, istTickMarkFormatter, toBar, dayResetMarkers,
} from './shared.jsx'

const { Title, Text } = Typography
const { RangePicker } = DatePicker

// Only NIFTY/BANKNIFTY - Dhan's rolling-option docs only ever show "NSE_FNO" as the exchange
// segment, never a BSE one, so SENSEX is left out rather than guessed at (see
// RollingOptionController's own doc comment on the backend).
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY']
const INTERVALS = [1, 5, 15, 25, 60]
const OFFSET_OPTIONS = Array.from({ length: 21 }, (_, i) => i - 10) // ATM-10 .. ATM+10

// Same plain candlestick chart as StrikeDataPage's own StrikeCandleChart, duplicated rather than
// imported - see that file's own comment on why this is deliberately NOT App.jsx's PriceChart
// (no live ticks, no cross-chart sync, nothing to fight over here either).
function RollingOptionChart({ bars, height = 360 }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const markersRef = useRef(null)

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
      markersRef.current = null
    }
  }, [height])

  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setData(bars)
    if (bars.length > 0) chartRef.current?.timeScale().fitContent()
  }, [bars])

  useEffect(() => {
    markersRef.current?.setMarkers(dayResetMarkers(bars))
  }, [bars])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// Same reasoning as StrikeDataPage's own ChartErrorBoundary - a rolling contract can splice
// together bars from several distinct real contracts, and one of them producing a shape
// lightweight-charts rejects (e.g. a duplicate/out-of-order timestamp right at a splice point)
// must not take the rest of the page down with it.
class ChartErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error('Rolling option chart crashed:', error)
  }

  render() {
    if (this.state.error) {
      return <Alert type="warning" showIcon message="This chart could not be rendered - the data below is still available in the tables." />
    }
    return this.props.children
  }
}

function toChartBars(candles) {
  return (candles ?? [])
    .filter((c) => c.open > 0 && c.open < 100000 && c.high > 0 && c.high < 100000 && c.low > 0 && c.low < 100000 && c.close > 0 && c.close < 100000)
    .map(toBar)
}

// One CE or PE side: its own chart, stats and error banner (a side can fail or come back empty
// independently of the other - Dhan resolves each with its own call).
function SidePanel({ label, color, candles, error, loading }) {
  const bars = useMemo(() => toChartBars(candles), [candles])
  const rows = candles ?? []

  return (
    <Card
      size="small"
      title={<Text style={{ color }}>{label}</Text>}
      extra={rows.length > 0 && <Text type="secondary" style={{ fontSize: 12 }}>{rows.length} candles</Text>}
    >
      {error && <Alert type="warning" showIcon message={error} style={{ marginBottom: 12 }} />}
      {bars.length > 0 ? (
        <ChartErrorBoundary key={label}>
          <RollingOptionChart bars={bars} height={340} />
        </ChartErrorBoundary>
      ) : (
        <Empty description={loading ? 'Loading…' : 'No candles for this contract/range.'} />
      )}
      {rows.length > 0 && (
        <Row gutter={24} style={{ marginTop: 12 }}>
          <Col><Statistic title="Oldest" value={fmtIstDateTime(rows[0].time)} valueStyle={{ fontSize: 13 }} /></Col>
          <Col><Statistic title="Newest" value={fmtIstDateTime(rows[rows.length - 1].time)} valueStyle={{ fontSize: 13 }} /></Col>
          <Col><Statistic title="Last close" value={fmtPrice(rows[rows.length - 1].close)} valueStyle={{ fontSize: 13 }} /></Col>
        </Row>
      )}
    </Card>
  )
}

// Backtests against Dhan's rolling/expired-option history (POST /v2/charts/rollingoption) rather
// than this app's own live-tracked strikes, so a strategy - or just a human eyeballing the chart -
// can compare how a NEAR expiry reacted to a move against how a FAR one did, over any past date
// range. Deliberately a separate page from Backtrack: that one always reads THIS app's own live/
// backfilled strike history (whatever is currently in memory), which has no way to reach back past
// an expiry that has already rolled off - this page instead asks Dhan directly for a series defined
// RELATIVE to the date range itself ("the Nth weekly/monthly expiry out, ATM+-K strike, as of each
// day in range"), which is what lets it answer "how did the far-month contract behave back then" at
// all.
export default function ExpiredOptionsPage() {
  const [underlying, setUnderlying] = useState('NIFTY')
  const [expiryFlag, setExpiryFlag] = useState('WEEK')
  const [expiryCode, setExpiryCode] = useState(0)
  const [strikeOffset, setStrikeOffset] = useState(0)
  const [interval, setInterval] = useState(5)
  const [dateRange, setDateRange] = useState(null)
  const [series, setSeries] = useState(null) // null = never loaded, distinct from a loaded response
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(null)

  const [fromDay, toDay] = useMemo(() => {
    const from = dateRange?.[0] ? dateRange[0].format('YYYY-MM-DD') : null
    const to = dateRange?.[1] ? dateRange[1].format('YYYY-MM-DD') : null
    return [from, to]
  }, [dateRange])

  const canLoad = Boolean(underlying && fromDay && toDay)

  const load = () => {
    if (!canLoad) return
    setLoading(true)
    setLoadError(null)
    const params = new URLSearchParams({
      expiryFlag,
      expiryCode: String(expiryCode),
      strikeOffset: String(strikeOffset),
      fromDate: fromDay,
      toDate: toDay,
      interval: String(interval),
    })
    fetch(`/api/rolling-option/${underlying}/series?${params.toString()}`)
      .then(async (r) => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.error || `Request failed (HTTP ${r.status}).`)
        return body
      })
      .then((body) => setSeries(body))
      .catch((err) => {
        console.error('Failed to load rolling option series:', err)
        setSeries(null)
        setLoadError(err.message || 'Failed to load this series.')
      })
      .finally(() => setLoading(false))
  }

  // Deliberately NOT auto-loaded on every control change (unlike StrikeDataPage) - each load is a
  // real Dhan call chunked across the whole date range, potentially several requests for a wide
  // range, so it waits for an explicit Load rather than firing on every intermediate click while
  // someone is still picking a strike offset.
  useEffect(() => {
    if (canLoad) load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const strikeLabel = strikeOffset === 0 ? 'ATM' : `ATM${strikeOffset > 0 ? '+' : ''}${strikeOffset}`

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>

        <Card size="small" title="Expired / rolling contract">
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Space align="center" size={16} wrap>
              <Select
                value={underlying}
                onChange={setUnderlying}
                style={{ width: 140 }}
                options={UNDERLYINGS.map((u) => ({ value: u, label: u }))}
              />
              <Segmented
                value={expiryFlag}
                onChange={setExpiryFlag}
                options={[{ label: 'Weekly', value: 'WEEK' }, { label: 'Monthly', value: 'MONTH' }]}
              />
              <Space size={8} align="center">
                <Text type="secondary">Expiries out</Text>
                <InputNumber min={0} max={10} value={expiryCode} onChange={(v) => setExpiryCode(v ?? 0)} style={{ width: 80 }} />
              </Space>
              <Space size={8} align="center">
                <Text type="secondary">Strike</Text>
                <Select
                  value={strikeOffset}
                  onChange={setStrikeOffset}
                  style={{ width: 110 }}
                  options={OFFSET_OPTIONS.map((o) => ({ value: o, label: o === 0 ? 'ATM' : `ATM${o > 0 ? '+' : ''}${o}` }))}
                />
              </Space>
              <Select
                value={interval}
                onChange={setInterval}
                style={{ width: 110 }}
                options={INTERVALS.map((m) => ({ value: m, label: `${m} min` }))}
              />
              <RangePicker
                value={dateRange}
                onChange={setDateRange}
                format="DD MMM YYYY"
                placeholder={['From date', 'To date']}
                style={{ width: 260 }}
              />
              <Button type="primary" icon={<ReloadOutlined />} onClick={load} loading={loading} disabled={!canLoad}>Load</Button>
            </Space>
            <Text type="secondary" style={{ fontSize: 12 }}>
              {expiryFlag === 'WEEK' ? 'Weekly' : 'Monthly'} expiry #{expiryCode} ({expiryCode === 0 ? 'nearest' : `${expiryCode} out`}) at {strikeLabel},
              as of each day in the picked range. Dhan splices in the next contract at the same relative position whenever the range crosses an expiry
              - the far-expiry/near-expiry reaction comparison this page exists for is just picking a bigger "expiries out" number and reloading.
            </Text>
          </Space>
        </Card>

        {loadError && <Alert type="error" showIcon message={loadError} />}

        {!series && !loading ? (
          <Card size="small">
            <Empty description="Pick a date range above and click Load to fetch this contract's rolling history." />
          </Card>
        ) : (
          <Row gutter={16}>
            <Col xs={24} lg={12}>
              <SidePanel label={`${underlying} ${strikeLabel} CE`} color={CE_COLOR} candles={series?.ce?.candles} error={series?.ce?.error} loading={loading} />
            </Col>
            <Col xs={24} lg={12}>
              <SidePanel label={`${underlying} ${strikeLabel} PE`} color={PE_COLOR} candles={series?.pe?.candles} error={series?.pe?.error} loading={loading} />
            </Col>
          </Row>
        )}
      </Space>
    </div>
  )
}
