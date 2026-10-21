import { Component, useEffect, useMemo, useRef, useState } from 'react'
import { Card, Select, InputNumber, Space, Typography, Table, Button, Statistic, Row, Col, Empty, Alert, DatePicker, Checkbox } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { createSeriesMarkers, CandlestickSeries, CrosshairMode, LineSeries } from 'lightweight-charts'
import { sessionVwapFromBars } from './chartVwap.js'
import { createZoomableChart } from './chartZoom.js'
import {
  NavBar, STORED_UNDERLYING, STORED_SHOW_VWAP, usePersistedState, pickUnderlying,
  useExpirySelector, ExpirySelect, withExpiry, fmtPrice, fmtIstTime, fmtIstDateTime, istDateKey,
  CE_COLOR, PE_COLOR, UP_COLOR, DOWN_COLOR,
  AXIS_COLOR, GRID_COLOR, BORDER_COLOR, istTimeFormatter, istTickMarkFormatter, toBar, dayResetMarkers,
} from './shared.jsx'

const { Title, Text } = Typography
const { RangePicker } = DatePicker

const STORED_STRIKE_TYPE = 'optionanalytics.strikeData.optionType'

// A plain candlestick chart of one contract's own history, with a RESET marker at each new trading
// day. Deliberately NOT App.jsx's own PriceChart: that one also plots EMA9/21 and joins a
// cross-chart pan/zoom sync group meant for several charts on the SAME page moving together, live-
// tick by live-tick - neither applies here (this page shows one static, already-complete series
// for one chart), so this is the plain shape lightweight-charts needs without that complexity.
function StrikeCandleChart({ bars, height = 420, showVwap = false }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const vwapRef = useRef(null)
  const seriesRef = useRef(null)
  const markersRef = useRef(null)
  const hasFitRef = useRef(false)

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
    vwapRef.current = chart.addSeries(LineSeries, { color: '#e072e8', lineWidth: 2, title: 'VWAP', priceLineVisible: false, crosshairMarkerVisible: false })
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
      vwapRef.current = null
      seriesRef.current = null
      markersRef.current = null
    }
    // One chart instance per mount, same reasoning as PriceChart - series data is (re)populated by
    // the effects below rather than by recreating the chart.
  }, [height])

  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setData(bars)
    // A fresh strike/expiry/type pick is a genuinely NEW series, not a live update to the same one
    // - always re-fit, unlike PriceChart's "only the first time" rule (which exists to not fight a
    // user's pan/zoom against a ticking feed; nothing here ever changes without a new selection).
    if (bars.length > 0) chartRef.current?.timeScale().fitContent()
    hasFitRef.current = bars.length > 0
  }, [bars])

  useEffect(() => {
    markersRef.current?.setMarkers(dayResetMarkers(bars))
  }, [bars])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// Same reasoning as App.jsx's own ChartErrorBoundary - a lightweight-charts assertion or bad data
// shape must show a small fallback instead of unmounting the whole page (the tables below the
// chart are still useful even if the chart itself can't render). Must be a class component; React
// has no hook equivalent for getDerivedStateFromError. Keyed by the caller on the same
// underlying/strike/type/expiry the chart itself is keyed on, so switching any of them also clears
// a previously-caught error rather than freezing on it.
class ChartErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error('Strike chart crashed:', error)
  }

  render() {
    if (this.state.error) {
      return <Alert type="warning" showIcon message="This chart could not be rendered - the data below is still available in the tables." />
    }
    return this.props.children
  }
}

// One specific option contract's own raw history, laid out for INSPECTION rather than trading -
// "does 24200PE actually have a candle at 1:30pm on 17 Aug, or is that a real gap" is a question
// every other page answers only indirectly (a chart is hard to read at 1-minute resolution, and
// Backtrack's own "No Data" row names a signal, not the underlying data that produced it). This
// page exists to answer it directly: pick a strike, and see literally every candle GetOptionCandles
// would ever hand a strategy for it, plus a day-by-day rollup that makes a mid-session gap (the
// PR that added forward-fill) or a frozen-since-some-date series (the PR that fixed a strike
// falling out of the ATM window) obvious without having to eyeball a chart or a raw JSON response.
export default function StrikeDataPage() {
  const [underlyings, setUnderlyings] = useState([])
  const [underlying, setUnderlying] = usePersistedState(STORED_UNDERLYING, null)
  const { expiries, selectedExpiry, expiryParam, isManual: expiryIsManual, loading: expiryLoading, selectExpiry } = useExpirySelector(underlying)
  const [strike, setStrike] = useState(null)
  const [optionType, setOptionType] = usePersistedState(STORED_STRIKE_TYPE, 'CE')
  const [showVwap, setShowVwap] = usePersistedState(STORED_SHOW_VWAP, true)
  const [candles, setCandles] = useState(null) // null = never loaded yet, distinct from [] = loaded and empty
  const [trackedStrikes, setTrackedStrikes] = useState([])
  // null = not fetched (or not yet known whether it's available) - distinct from [] = fetched and
  // genuinely empty (no stored OI/IV for this stretch). oiIvError explains WHY when it's null/empty
  // for a reason worth surfacing (SENSEX, no stored source configured) rather than just quietly
  // showing nothing - see StrikeOiIvHistoryService's own doc comment for the real limits here.
  const [oiIvPoints, setOiIvPoints] = useState(null)
  const [oiIvError, setOiIvError] = useState(null)
  const [loading, setLoading] = useState(false)
  // Purely a VIEW filter over whatever this contract's own history already came back with - never
  // re-fetched on a date change, same "narrow what's on screen, not what was asked for" philosophy
  // Backtrack's own date range already uses. Not persisted (unlike Backtrack's) - this page is a
  // one-off inspection tool, not a lasting preference someone tunes once and keeps.
  const [dateRange, setDateRange] = useState(null)

  const step = underlyings.find((u) => u.underlying === underlying)?.step || 50

  useEffect(() => {
    fetch('/api/spot/underlyings')
      .then((r) => r.json())
      .then((list) => {
        setUnderlyings(list ?? [])
        setUnderlying((current) => pickUnderlying(list, current))
      })
      .catch((err) => console.error('Failed to load underlyings:', err))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const load = () => {
    if (!underlying || !strike) return
    setLoading(true)
    setOiIvPoints(null)
    setOiIvError(null)
    Promise.all([
      fetch(withExpiry(`/api/cdv/${underlying}/option/candles?strike=${strike}&type=${optionType}`, expiryParam)).then((r) => r.json()),
      fetch(withExpiry(`/api/cdv/${underlying}/strikes`, expiryParam)).then((r) => r.json()),
    ])
      .then(([candleData, strikeList]) => {
        setCandles(candleData ?? [])
        setTrackedStrikes(strikeList ?? [])

        // OI/IV needs the SAME [from,to] window the candles themselves actually cover - chained
        // after candles resolve (rather than fetched in the same Promise.all with a guessed range)
        // so it exactly matches whatever range GetStrikeCandlesAsync decided to return, no matter
        // how that window is sized. Skipped entirely when there's nothing to match it against.
        if (!candleData || candleData.length === 0 || !expiryParam) return null
        const fromDay = istDateKey(candleData[0].time)
        const toDay = istDateKey(candleData[candleData.length - 1].time)
        return fetch(`/api/cdv/${underlying}/option/oi-iv?strike=${strike}&type=${optionType}&expiry=${expiryParam}&from=${fromDay}&to=${toDay}`)
          .then((r) => r.json())
          .then((body) => {
            setOiIvPoints(body?.points ?? [])
            setOiIvError(body?.error ?? null)
          })
      })
      .catch((err) => {
        console.error('Failed to load strike data:', err)
        setCandles([])
      })
      .finally(() => setLoading(false))
  }

  // Reloads whenever any part of "which contract" changes - the same auto-refresh-on-selection
  // convention every other page here already follows, so picking a new strike doesn't also need a
  // separate click on Refresh.
  useEffect(() => { load() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [underlying, strike, optionType, expiryParam])

  const [fromDay, toDay] = useMemo(() => {
    const from = dateRange?.[0] ? dateRange[0].format('YYYY-MM-DD') : null
    const to = dateRange?.[1] ? dateRange[1].format('YYYY-MM-DD') : null
    return [from, to]
  }, [dateRange])

  const inRange = (day) => (!fromDay || day >= fromDay) && (!toDay || day <= toDay)

  // Every candle for this contract, narrowed to the picked date range - filtered once, up front, so
  // the stats card, both tables and the chart all agree on "what's in view" instead of each
  // re-deriving it slightly differently.
  const visibleCandles = useMemo(() => {
    if (!fromDay && !toDay) return candles ?? []
    return (candles ?? []).filter((c) => inRange(istDateKey(c.time)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, fromDay, toDay])

  // Keyed by the raw ISO time string straight off the wire (same convention both endpoints already
  // share for every other per-minute series in this app) - a plain exact-match lookup, no parsing
  // needed, since both this page's candles and its OI/IV points come from the same 1-minute grid.
  const oiIvByTime = useMemo(() => {
    const map = new Map()
    for (const p of oiIvPoints ?? []) map.set(p.time, p)
    return map
  }, [oiIvPoints])

  // Descending (newest first) - the convention every other table on this app already uses
  // (Backtrack's signals/trades), and the more useful default here too: "is today's data there"
  // is usually the first thing worth checking, not the oldest day in a 45-day window.
  const rows = useMemo(
    () => visibleCandles.map((c, i) => {
      const oiIv = oiIvByTime.get(c.time)
      return { ...c, key: i, day: istDateKey(c.time), openInterest: oiIv?.openInterest ?? null, impliedVolatility: oiIv?.impliedVolatility ?? null }
    }).reverse(),
    [visibleCandles, oiIvByTime],
  )

  // Chart-ready shape (IST-shifted epoch seconds, ascending) - a separate conversion from `rows`
  // above rather than reusing it, since the chart wants chronological order and shifted time
  // while the tables want the reverse and a plain ISO string to format for display.
  //
  // Also filtered to a plausible premium range - the backend now rejects a candle this implausible
  // at the source (OptionPriceSanity), but this page exists specifically to inspect raw history
  // that may have been cached in memory since before that existed, so a stray leftover bar could
  // still reach here. The RAW table above is deliberately NOT filtered the same way - "see literally
  // every candle" is the whole point of that one, corrupt or not - only the chart's own axis scale
  // needs protecting from a single outlier making every real candle unreadably flat by comparison.
  const chartBars = useMemo(
    () => visibleCandles
      .filter((c) => c.open > 0 && c.open < 100000 && c.high > 0 && c.high < 100000 && c.low > 0 && c.low < 100000 && c.close > 0 && c.close < 100000)
      .map((c) => ({ ...toBar(c), volume: c.volume })), // volume: for the VWAP only
    [visibleCandles],
  )

  const trackedInfo = useMemo(
    () => trackedStrikes.find((s) => s.strike === strike && s.isCall === (optionType === 'CE')) ?? null,
    [trackedStrikes, strike, optionType],
  )

  // One row per trading day actually present, most recent first, with a candle count and its own
  // first/last bar - a day with far fewer candles than its neighbours, or one that stops well
  // before market close, is exactly what a frozen or partially-tracked series (see
  // BacktestService.IsTrackedSeriesComplete) looks like from here.
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
    { title: 'Open', dataIndex: 'open', key: 'open', width: 100, align: 'right', render: fmtPrice },
    { title: 'High', dataIndex: 'high', key: 'high', width: 100, align: 'right', render: fmtPrice },
    { title: 'Low', dataIndex: 'low', key: 'low', width: 100, align: 'right', render: fmtPrice },
    { title: 'Close', dataIndex: 'close', key: 'close', width: 100, align: 'right', render: fmtPrice },
    {
      title: 'OI', dataIndex: 'openInterest', key: 'openInterest', width: 110, align: 'right',
      render: (v) => (v == null ? '—' : v.toLocaleString()),
    },
    {
      title: 'IV', dataIndex: 'impliedVolatility', key: 'impliedVolatility', width: 90, align: 'right',
      render: (v) => (v == null ? '—' : v.toFixed(1)),
    },
  ]

  const hasLoaded = candles !== null

  // Session VWAP of this option from its own candles' volume (resets each IST day), on the candles' times.
  useEffect(() => { vwapRef.current?.setData(showVwap ? sessionVwapFromBars(bars) ?? [] : []) }, [bars, showVwap])

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
          <Select
            value={underlying}
            onChange={(v) => { setUnderlying(v); setStrike(null) }}
            style={{ width: 140 }}
            options={underlyings.map((u) => ({ value: u.underlying, label: u.underlying }))}
          />
          <ExpirySelect expiries={expiries} value={selectedExpiry} isManual={expiryIsManual} loading={expiryLoading} onChange={selectExpiry} />
          <InputNumber
            controls={false}
            placeholder="Strike"
            min={0}
            step={step}
            value={strike}
            onChange={setStrike}
            style={{ width: 130 }}
          />
          <Select
            value={optionType}
            onChange={setOptionType}
            style={{ width: 90 }}
            options={[
              { value: 'CE', label: <Text style={{ color: CE_COLOR }}>CE</Text> },
              { value: 'PE', label: <Text style={{ color: PE_COLOR }}>PE</Text> },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading} disabled={!strike}>Refresh</Button>
          <RangePicker
            value={dateRange}
            onChange={setDateRange}
            allowEmpty={[true, true]}
            format="DD MMM YYYY"
            placeholder={['From date', 'To date']}
            style={{ width: 260 }}
          />
        </Space>

        {!strike ? (
          <Card size="small">
            <Empty description="Pick an underlying, expiry and strike above to see every candle this app has for that contract." />
          </Card>
        ) : (
          <>
            <Card size="small" title={`${underlying} ${strike}${optionType} — ${selectedExpiry ?? 'expiry pending'}`}>
              <Row gutter={24}>
                <Col><Statistic title="Total candles" value={rows.length} /></Col>
                <Col><Statistic title="Trading days covered" value={dayRollup.length} /></Col>
                <Col><Statistic title="Oldest candle" value={rows.length ? fmtIstDateTime(rows[rows.length - 1].time) : '—'} /></Col>
                <Col><Statistic title="Newest candle" value={rows.length ? fmtIstDateTime(rows[0].time) : '—'} /></Col>
                <Col>
                  <Statistic
                    title="Currently tracked"
                    value={trackedInfo ? 'Yes' : 'No'}
                    styles={{ content: { color: trackedInfo ? UP_COLOR : DOWN_COLOR } }}
                  />
                </Col>
              </Row>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {trackedInfo
                  ? `Tracked (SecurityId ${trackedInfo.securityId}) - this strike has been inside the live ATM+-16 window at some point today.`
                  : "Not in today's tracked-strikes list - either never inside the live ATM+-16 window today, or this is a different expiry/day. Its candles above (if any) came from Dhan's on-demand intraday history instead of the live feed."}
                {' '}A trading day below with far fewer candles than its neighbours, or one that stops well before market close, means this contract's own tracking was incomplete for that day.
              </Text>
              {oiIvError && (
                <Alert type="info" showIcon style={{ marginTop: 8 }} message={oiIvError} />
              )}
              {!oiIvError && oiIvPoints !== null && (
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
                  OI/IV columns come from NiftyDataCollector's own stored rolling-option history, not
                  Dhan's candle API (which has neither) - only available where that's configured, and
                  only for the stretch this contract was actually the nearest weekly/monthly one, so
                  an OTM strike inspected long before it became current may show real candles with no
                  OI/IV alongside them.
                </Text>
              )}
            </Card>

            <Card size="small" title="Chart" extra={<Checkbox checked={showVwap} onChange={(e) => setShowVwap(e.target.checked)}>VWAP</Checkbox>}>
              {chartBars.length > 0 ? (
                <ChartErrorBoundary key={`${underlying}-${strike}-${optionType}-${selectedExpiry}`}>
                  <StrikeCandleChart bars={chartBars} height={420} showVwap={showVwap} />
                </ChartErrorBoundary>
              ) : (
                <Empty description={loading ? 'Loading…' : 'No candles to chart for this contract.'} />
              )}
            </Card>

            <Card size="small" title={fromDay || toDay ? `Candles by trading day (${fromDay ?? 'the start'} – ${toDay ?? 'the end'})` : 'Candles by trading day'}>
              <Table
                size="small"
                rowKey="day"
                dataSource={dayRollup}
                columns={dayColumns}
                pagination={false}
                loading={loading && !hasLoaded}
                locale={{ emptyText: fromDay || toDay ? 'No candles in this date range.' : 'No candles at all for this contract.' }}
              />
            </Card>

            <Card size="small" title={fromDay || toDay ? `Every candle (${fromDay ?? 'the start'} – ${toDay ?? 'the end'})` : 'Every candle'}>
              <Table
                size="small"
                rowKey="key"
                dataSource={rows}
                columns={candleColumns}
                loading={loading && !hasLoaded}
                pagination={{ pageSize: 100, showSizeChanger: true, pageSizeOptions: [50, 100, 250, 500] }}
                locale={{ emptyText: fromDay || toDay ? 'No candles in this date range.' : 'No candles at all for this contract.' }}
              />
            </Card>
          </>
        )}
      </Space>
    </div>
  )
}
