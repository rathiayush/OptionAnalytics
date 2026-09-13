import { Component, useEffect, useMemo, useRef, useState } from 'react'
import { Card, Select, InputNumber, Space, Typography, Table, Button, Statistic, Row, Col, Empty, Alert, Segmented, Tooltip } from 'antd'
import { ReloadOutlined, InfoCircleOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { createChart, createSeriesMarkers, CandlestickSeries, CrosshairMode } from 'lightweight-charts'
import {
  NavBar, STORED_UNDERLYING, usePersistedState, fmtPrice, fmtIstTime, fmtIstDateTime, istDateKey,
  CE_COLOR, PE_COLOR, UP_COLOR, DOWN_COLOR,
  AXIS_COLOR, GRID_COLOR, BORDER_COLOR, istTimeFormatter, istTickMarkFormatter, toBar, toChartTime, dayResetMarkers,
} from './shared.jsx'

const { Title, Text } = Typography

// Same restriction as Expired Backtest itself - Dhan's rolling-option docs only ever show
// "NSE_FNO" as the exchange segment, never a BSE one, so SENSEX has no rolling-option data to show
// here at all.
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY']

// Matches ExpiredOptionBacktestService.StrikeStepByUnderlying - only used here as the InputNumber
// step for an absolute strike, and as the fallback default when picking one blind.
const STRIKE_STEP_BY_UNDERLYING = { NIFTY: 50, BANKNIFTY: 100 }

// Same generous UI ceilings Expired Backtest itself uses - the backend computes and reports the
// ACTUAL usable window per request regardless of what this sends (see
// ExpiredOptionBacktestService.BuildFetchSegments).
const MAX_LOOKBACK_DAYS = { WEEK: 20, MONTH: 65 }
const DEFAULT_LOOKBACK_DAYS = { WEEK: 5, MONTH: 28 }

const STORED_SIDE = 'optionanalytics.rollingStrikeData.side'

// Splice markers use a different shape/color from the trade-entry markers other pages draw, so a
// splice reads as "here is where this app's own safety net found a suspicious jump" rather than
// looking like just another price event.
function spliceMarkers(splices) {
  return (splices ?? []).map((s) => ({
    time: toChartTime(s.time),
    position: 'aboveBar',
    color: '#faad14',
    shape: 'arrowDown',
    text: `splice ${fmtPrice(s.previousClose)}→${fmtPrice(s.thisOpen)}`,
  }))
}

// Plain candlestick chart of the raw rolling-option series, with a RESET marker at each new trading
// day (same convention StrikeDataPage/ExpiredBacktestPage's own charts use) plus a marker at every
// splice this app's own DetectPossibleSplices flagged - the whole point of this page is to let one
// of those be inspected directly against the real candle shape around it, not just read off a
// trade's own surprising exit price.
function RollingCandleChart({ bars, splices, height = 420 }) {
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
    // One chart instance per mount - series/marker data is (re)populated by the effects below.
  }, [height])

  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setData(bars)
    // A fresh load is a genuinely new series - always re-fit.
    if (bars.length > 0) chartRef.current?.timeScale().fitContent()
  }, [bars])

  useEffect(() => {
    markersRef.current?.setMarkers([...dayResetMarkers(bars), ...spliceMarkers(splices)].sort((a, b) => a.time - b.time))
  }, [bars, splices])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// Same reasoning as every other page's own chart error boundary here - a lightweight-charts
// assertion or bad data shape must show a small fallback instead of unmounting the whole page.
class ChartErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error('Rolling strike chart crashed:', error)
  }

  render() {
    if (this.state.error) {
      return <Alert type="warning" showIcon message="This chart could not be rendered - the data below is still available in the tables." />
    }
    return this.props.children
  }
}

// The raw Dhan rolling-option series for one relative strike/side, laid out for INSPECTION - the
// same "see literally every candle, corrupt or not" philosophy StrikeDataPage applies to a
// live-tracked contract, but for the reconstruction Expired Backtest's OWN option premium comes
// from (see ExpiredOptionBacktestService's top-of-file doc comment). Built specifically so a real
// anomaly this app already found once (a bar whose High/Low never actually traded) can be looked at
// directly - the exact bar, its neighbours, its own resolved strike, and whether this app's own
// splice detector caught it - rather than only inferred from a backtest trade's surprising exit.
export default function RollingStrikeDataPage() {
  const [underlying, setUnderlying] = usePersistedState(STORED_UNDERLYING, 'NIFTY')
  const [expiryFlag, setExpiryFlag] = useState('WEEK')
  const [expiryDate, setExpiryDate] = useState(null)
  const [expiries, setExpiries] = useState([])
  const [expiriesLoading, setExpiriesLoading] = useState(false)
  const [otmSteps, setOtmSteps] = useState(0)
  // An exact absolute strike (e.g. 56200) - takes priority over otmSteps when set (see the backend's
  // own GetRollingChart doc comment). null means "use the offset below instead".
  const [strike, setStrike] = useState(null)
  const [side, setSide] = usePersistedState(STORED_SIDE, 'CE')
  const [lookbackDays, setLookbackDays] = useState(DEFAULT_LOOKBACK_DAYS.WEEK)

  const [result, setResult] = useState(null) // null = never loaded yet
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(null)

  useEffect(() => {
    if (underlying && !UNDERLYINGS.includes(underlying)) setUnderlying('NIFTY')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // BANKNIFTY has no weekly contract at all (NSE discontinued it) - forced here so switching
  // underlying can never leave a stale WEEK selection in place, same as Expired Backtest itself.
  useEffect(() => {
    if (underlying === 'BANKNIFTY' && expiryFlag === 'WEEK') setExpiryFlag('MONTH')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underlying])

  useEffect(() => {
    setLookbackDays(DEFAULT_LOOKBACK_DAYS[expiryFlag] ?? DEFAULT_LOOKBACK_DAYS.WEEK)
  }, [expiryFlag])

  // Reuses Expired Backtest's own expiries endpoint - same real-listed-dates guarantee, past AND
  // not-yet-expired, since this page reads through the exact same fetch/anchor mechanism.
  useEffect(() => {
    if (!underlying) return
    setExpiryDate(null)
    setExpiriesLoading(true)
    fetch(`/api/expired-backtest/${underlying}/expiries?expiryFlag=${expiryFlag}`)
      .then((r) => r.json())
      .then((body) => {
        const list = body?.expiries ?? []
        setExpiries(list)
        setExpiryDate(list[0] ?? null)
      })
      .catch((err) => {
        console.error('Failed to load available expiries:', err)
        setExpiries([])
      })
      .finally(() => setExpiriesLoading(false))
  }, [underlying, expiryFlag])

  const canLoad = Boolean(underlying && expiryDate)

  const load = () => {
    if (!canLoad) return
    setLoading(true)
    setLoadError(null)
    const params = new URLSearchParams({
      expiryFlag,
      expiryDate,
      otmSteps: String(otmSteps),
      side,
      lookbackDays: String(lookbackDays),
    })
    // Absolute strike takes priority over the offset above - see the backend's own doc comment on
    // GetRollingChart for how it converts one to the other using current spot.
    if (strike != null) params.set('strike', String(strike))

    fetch(`/api/expired-backtest/${underlying}/rolling-chart?${params.toString()}`)
      .then(async (r) => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.error || `Request failed (HTTP ${r.status}).`)
        return body
      })
      .then((body) => setResult(body))
      .catch((err) => {
        console.error('Failed to load rolling-option chart data:', err)
        setResult(null)
        setLoadError(err.message || 'Failed to load this contract.')
      })
      .finally(() => setLoading(false))
  }

  // Memoized so `bars`/`splices` are stable references across renders that don't change `result` -
  // `result?.bars ?? []` alone would allocate a fresh empty array every render while result is
  // null, which the hooks below depend on.
  const bars = useMemo(() => result?.bars ?? [], [result])
  const splices = useMemo(() => result?.splices ?? [], [result])

  // Descending (newest first) - same convention every other table on this app already uses.
  const rows = useMemo(
    () => bars.map((b, i) => ({ ...b, key: i, day: istDateKey(b.time) })).reverse(),
    [bars],
  )

  const chartBars = useMemo(() => bars.map(toBar), [bars])

  const resolvedStrikes = useMemo(
    () => bars.map((b) => b.resolvedStrike).filter((s) => s != null),
    [bars],
  )
  const resolvedStrikeRange = resolvedStrikes.length > 0
    ? [Math.min(...resolvedStrikes), Math.max(...resolvedStrikes)]
    : null

  // One row per trading day actually present, most recent first - same shape StrikeDataPage's own
  // rollup uses, so a day with far fewer candles than its neighbours (or a day that stops well
  // before close) is just as visible here for the rolling reconstruction as it already is there
  // for a live-tracked contract.
  const dayRollup = useMemo(() => {
    const byDay = new Map()
    for (const row of rows) {
      const existing = byDay.get(row.day)
      if (existing) {
        existing.count += 1
        existing.firstTime = row.time < existing.firstTime ? row.time : existing.firstTime
        existing.lastTime = row.time > existing.lastTime ? row.time : existing.lastTime
      } else {
        byDay.set(row.day, { day: row.day, count: 1, firstTime: row.time, lastTime: row.time })
      }
    }
    return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1))
  }, [rows])

  const dayColumns = [
    { title: 'Trading day', dataIndex: 'day', key: 'day', width: 140 },
    { title: 'Candles', dataIndex: 'count', key: 'count', width: 100, align: 'right' },
    { title: 'First bar', dataIndex: 'firstTime', key: 'firstTime', width: 110, render: fmtIstTime },
    { title: 'Last bar', dataIndex: 'lastTime', key: 'lastTime', width: 110, render: fmtIstTime },
  ]

  const candleColumns = [
    { title: 'Day', dataIndex: 'day', key: 'day', width: 120 },
    { title: 'Time (IST)', dataIndex: 'time', key: 'time', width: 100, render: fmtIstTime },
    { title: 'Open', dataIndex: 'open', key: 'open', width: 90, align: 'right', render: fmtPrice },
    { title: 'High', dataIndex: 'high', key: 'high', width: 90, align: 'right', render: fmtPrice },
    { title: 'Low', dataIndex: 'low', key: 'low', width: 90, align: 'right', render: fmtPrice },
    { title: 'Close', dataIndex: 'close', key: 'close', width: 90, align: 'right', render: fmtPrice },
    { title: 'Volume', dataIndex: 'volume', key: 'volume', width: 100, align: 'right' },
    {
      title: 'Resolved strike', dataIndex: 'resolvedStrike', key: 'resolvedStrike', width: 130, align: 'right',
      render: (v) => (v == null ? <Text type="secondary">not reported</Text> : fmtPrice(v)),
    },
  ]

  const hasLoaded = result !== null

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>

        <Card size="small" title="Rolling Strike Data (Expired Contract Feed)">
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Space align="end" size={16} wrap>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Underlying</Text>
                <Select
                  value={underlying}
                  onChange={(v) => { setUnderlying(v); setStrike(null) }}
                  style={{ width: 140 }}
                  options={UNDERLYINGS.map((u) => ({ value: u, label: u }))}
                />
              </Space>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Strike (optional){' '}
                  <Tooltip title="Type the exact strike you want to inspect (e.g. 56200) and it's converted to a strike offset using CURRENT spot - an approximation of the offset a run on that historical date would have used, since spot has moved since. Leave empty to use the offset below directly instead.">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Text>
                <InputNumber
                  controls={false}
                  placeholder="e.g. 56200"
                  min={0}
                  step={STRIKE_STEP_BY_UNDERLYING[underlying] ?? 50}
                  value={strike}
                  onChange={setStrike}
                  style={{ width: 130 }}
                />
              </Space>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Expiry cadence</Text>
                <Segmented
                  value={expiryFlag}
                  onChange={setExpiryFlag}
                  options={[
                    { label: 'Weekly', value: 'WEEK', disabled: underlying === 'BANKNIFTY' },
                    { label: 'Monthly', value: 'MONTH' },
                  ]}
                />
              </Space>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Expiry date</Text>
                <Select
                  value={expiryDate}
                  onChange={setExpiryDate}
                  loading={expiriesLoading}
                  style={{ width: 160 }}
                  placeholder={expiriesLoading ? 'Loading…' : 'No expiries available'}
                  options={expiries.map((d) => ({ value: d, label: dayjs(d).format('DD MMM YYYY') }))}
                  notFoundContent={expiriesLoading ? 'Loading…' : 'None available'}
                />
              </Space>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Strike offset from ATM{' '}
                  <Tooltip title="Ignored when Strike above is filled in. Positive is OTM for the side picked below, negative is ITM, 0 is ATM itself - same convention every strategy's own otmSteps parameter uses. This is a RELATIVE token (Dhan resolves the actual absolute strike itself, re-centering as spot moves through the window), not a fixed price - see the Resolved strike column below for what it actually landed on.">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Text>
                <InputNumber min={-8} max={8} value={otmSteps} onChange={(v) => setOtmSteps(v ?? 0)} disabled={strike != null} style={{ width: 100 }} />
              </Space>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Side</Text>
                <Select
                  value={side}
                  onChange={setSide}
                  style={{ width: 90 }}
                  options={[
                    { value: 'CE', label: <Text style={{ color: CE_COLOR }}>CE</Text> },
                    { value: 'PE', label: <Text style={{ color: PE_COLOR }}>PE</Text> },
                  ]}
                />
              </Space>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Lookback (days)</Text>
                <InputNumber
                  min={1}
                  max={MAX_LOOKBACK_DAYS[expiryFlag] ?? MAX_LOOKBACK_DAYS.WEEK}
                  value={lookbackDays}
                  onChange={(v) => setLookbackDays(v ?? DEFAULT_LOOKBACK_DAYS[expiryFlag] ?? DEFAULT_LOOKBACK_DAYS.WEEK)}
                  style={{ width: 110 }}
                />
              </Space>
              <Button icon={<ReloadOutlined />} type="primary" onClick={load} loading={loading} disabled={!canLoad}>Load</Button>
            </Space>
          </Space>
        </Card>

        {loadError && <Alert type="error" showIcon message={loadError} />}

        {!hasLoaded ? (
          <Card size="small">
            <Empty description="Pick an underlying, expiry, strike offset and side above, then click Load." />
          </Card>
        ) : (
          <>
            {result?.error && (
              <Alert type="warning" showIcon message={`Dhan: ${result.error}`} description="A per-segment fetch error - the data below (if any) is whatever still came back." />
            )}

            {splices.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message="Possible splice(s) detected in this raw series"
                description={
                  <>
                    {splices.map((s, i) => (
                      <div key={i}>{fmtIstDateTime(s.time)}: {fmtPrice(s.previousClose)} → {fmtPrice(s.thisOpen)} (a large, sudden jump - marked on the chart below)</div>
                    ))}
                    A genuine contract-splice, or a single bad bar Dhan's own reconstruction produced - this page shows the RAW fetch (unlike a real backtest run, nothing here is trimmed away), so every bar around a marked splice is visible for direct inspection.
                  </>
                }
              />
            )}

            <Card size="small" title={`${underlying} ${result.strikeToken} ${result.optionType === 'CALL' ? 'CE' : 'PE'} — ${expiryDate}`}>
              <Row gutter={24}>
                <Col><Statistic title="Total bars" value={rows.length} /></Col>
                <Col><Statistic title="Trading days covered" value={dayRollup.length} /></Col>
                <Col><Statistic title="Effective lookback" value={result.effectiveLookbackDays} suffix="days" /></Col>
                <Col><Statistic title="Oldest bar" value={rows.length ? fmtIstDateTime(rows[rows.length - 1].time) : '—'} /></Col>
                <Col><Statistic title="Newest bar" value={rows.length ? fmtIstDateTime(rows[0].time) : '—'} /></Col>
                <Col>
                  <Statistic
                    title="Resolved strike range"
                    value={resolvedStrikeRange ? `${fmtPrice(resolvedStrikeRange[0])} – ${fmtPrice(resolvedStrikeRange[1])}` : 'not reported'}
                  />
                </Col>
              </Row>
              <Text type="secondary" style={{ fontSize: 12 }}>
                This is the RAW rolling-option fetch - the same data a real Expired Backtest run would use, before that page's own trimming picks one contiguous contract out of it. A resolved strike range spanning much more than a couple of steps, or a splice above, both mean this series may contain more than one real contract's premium.
              </Text>
            </Card>

            <Card size="small" title="Chart">
              {chartBars.length > 0 ? (
                <ChartErrorBoundary key={`${underlying}-${expiryDate}-${result.strikeToken}-${result.optionType}`}>
                  <RollingCandleChart bars={chartBars} splices={splices} height={420} />
                </ChartErrorBoundary>
              ) : (
                <Empty description={loading ? 'Loading…' : 'No bars to chart for this contract.'} />
              )}
            </Card>

            <Card size="small" title="Bars by trading day">
              <Table
                size="small"
                rowKey="day"
                dataSource={dayRollup}
                columns={dayColumns}
                pagination={false}
                loading={loading && !hasLoaded}
                locale={{ emptyText: 'No bars at all for this contract.' }}
              />
            </Card>

            <Card size="small" title="Every bar (raw fetch)">
              <Table
                size="small"
                rowKey="key"
                dataSource={rows}
                columns={candleColumns}
                loading={loading && !hasLoaded}
                pagination={{ pageSize: 100, showSizeChanger: true, pageSizeOptions: [50, 100, 250, 500] }}
                locale={{ emptyText: 'No bars at all for this contract.' }}
              />
            </Card>
          </>
        )}
      </Space>
    </div>
  )
}
