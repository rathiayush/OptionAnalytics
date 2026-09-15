import { Component, useEffect, useMemo, useRef, useState } from 'react'
import { Select, Space, Typography, Card, Button, Table, Tag, InputNumber, Statistic, Row, Col, DatePicker, TimePicker, Segmented, Alert, Empty, Tooltip, Checkbox } from 'antd'
import dayjs from 'dayjs'
import { PlayCircleOutlined, InfoCircleOutlined } from '@ant-design/icons'
import { createChart, createSeriesMarkers, CandlestickSeries, LineSeries, CrosshairMode } from 'lightweight-charts'
import {
  UP_COLOR, DOWN_COLOR, CE_COLOR, PE_COLOR, EMA_COLOR, computeEma, NavBar, DirectionTag, fmtIstDateTime, fmtIstTime, fmtPrice, istDateKey,
  TIMEFRAME_OPTIONS, STORED_UNDERLYING, STORED_TIMEFRAME, usePersistedState,
  AXIS_COLOR, GRID_COLOR, BORDER_COLOR, istTimeFormatter, istTickMarkFormatter, toBar, toChartTime, dayResetMarkers,
  CeVsPeChart, VolumeVwapChart, scrollChartToTime,
} from './shared.jsx'

const { Title, Text } = Typography
const { RangePicker } = DatePicker

// Only NIFTY/BANKNIFTY - Dhan's rolling-option docs only ever show "NSE_FNO" as the exchange
// segment, never a BSE one, so SENSEX is left out (see ExpiredOptionBacktestService's own comment).
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY']

// Matches ExpiredOptionBacktestService.StrikeStepByUnderlying - only used here to judge how far off
// a "resolved vs expected strike" comparison has to be before it reads as a real mismatch rather
// than harmless rounding.
const STRIKE_STEP_BY_UNDERLYING = { NIFTY: 50, BANKNIFTY: 100 }

// Neither cadence has a single fixed backend cap any more (see
// ExpiredOptionBacktestService.BuildFetchSegments) - a lookback reaching past the immediately
// preceding real expiry (of the SAME cadence) now fetches an OLDER second segment instead of just
// getting clamped away, up to 2 real cycles back for either one (roughly 14-20 days for Weekly,
// 56-70 for Monthly, depending on the calendar). These are just generous UI maxes for the control,
// not enforced boundaries; the backend computes and reports the ACTUAL usable window per request
// from ExpiryCalendar's own real expiry dates regardless of what this sends.
const MAX_LOOKBACK_DAYS = { WEEK: 20, MONTH: 65 }

// The lookback each cadence resets to on its own (a fresh cadence pick, or the initial load) -
// deliberately the single-segment mechanism's own natural range (each cadence's TYPICAL single-
// cycle length), not MAX_LOOKBACK_DAYS' wider ceiling: reaching into the older, not-yet-confirmed
// second segment (see MAX_LOOKBACK_DAYS' own comment) should always be a deliberate choice to type
// a bigger number, never a silent default.
const DEFAULT_LOOKBACK_DAYS = { WEEK: 5, MONTH: 28 }

const STORED_STRATEGY_KEY = 'optionanalytics.expiredBacktest.strategyKey'
const STORED_PARAM_VALUES = 'optionanalytics.expiredBacktest.paramValues'
const STORED_DATE_RANGE = 'optionanalytics.expiredBacktest.dateRange'

const BUY_COLOR = '#4dabf7'
const SELL_COLOR = '#c084fc'
const OPEN_COLOR = '#ffb100'
const EXIT_REASON_COLOR = { TakeProfit: UP_COLOR, StopLoss: DOWN_COLOR, SpotTakeProfit: UP_COLOR, SpotStopLoss: DOWN_COLOR, EndOfDay: undefined, NoData: undefined, SignalExit: undefined, SquareOff: undefined, Open: OPEN_COLOR }
// SpotTakeProfit/SpotStopLoss are FiveEmaAsTaughtStrategy's own stop/target - a level on the
// underlying's spot (the alert candle's own high/low, taught 1:3), not the option's premium - but
// still a real win/loss exit, so they share TakeProfit/StopLoss's own colors.
const EXIT_REASON_LABEL = {
  TakeProfit: 'Take Profit', StopLoss: 'Stop Loss', SpotTakeProfit: 'Take Profit (spot)', SpotStopLoss: 'Stop Loss (spot)',
  EndOfDay: 'End of Day', NoData: 'No Data', SignalExit: 'Strategy Exit', SquareOff: 'Square Off', Open: 'Open',
}

function fmtOption(row) {
  return `${row.strike} ${row.optionType}`
}

function renderPnl(v, isOpen) {
  if (v == null) return <Text type="secondary">—</Text>
  const color = v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined
  return (
    <Text strong style={{ color }}>
      {v > 0 ? '+' : ''}{v.toFixed(2)} pts{isOpen && <Text type="secondary" style={{ fontWeight: 400 }}> (unrealized)</Text>}
    </Text>
  )
}

// One arrow per trade at its own entry (falling back to the signal time for a NoData trade, which
// has no entry of its own) - direction decides the arrow's side/color/shape, the same convention
// every other chart on this app uses for a bullish/bearish event. The label text uses the trade's
// own actual SIDE (Buy/Sell), not its direction - matching BacktestPage's own tradeEntryMarkers:
// with "Sell option (opposite leg)" selected, a Bullish signal really does SELL the PE (see
// OptionTradeSimulator's own doc comment), so labeling it "BUY" off the signal's direction word
// would say the opposite of what was actually traded. Sorted ascending: createSeriesMarkers
// requires it, and trades already come back in that order but this stays correct even if that changes.
function tradeEntryMarkers(trades) {
  return trades
    .map((t) => ({
      time: toChartTime(t.entryTimeUtc ?? t.signalTimeUtc),
      position: t.direction === 'Bullish' ? 'belowBar' : 'aboveBar',
      color: t.direction === 'Bullish' ? UP_COLOR : DOWN_COLOR,
      shape: t.direction === 'Bullish' ? 'arrowUp' : 'arrowDown',
      text: `${t.side === 'Sell' ? 'SELL' : 'BUY'} ${t.strike}${t.optionType}`,
    }))
    .sort((a, b) => a.time - b.time)
}

// Plain candlestick chart of the spot history around the run's own lookback window (the backend
// pads it a few days on each side purely for visual context - see ExpiredOptionBacktestService.
// ChartPaddingDays), with the strategy's own trade entries marked on it so a signal can be checked
// against the real price action rather than only read off the Trades table below. Same plain shape
// as StrikeDataPage's own StrikeCandleChart, plus an optional 5 EMA overlay (see the "Show 5 EMA"
// checkbox below) - this is one static, already-complete series for one run, not a live-ticking feed.
//
// emaPoints is already pre-computed (or empty) by the caller - this component only ever calls
// setData with whatever it is handed, so unticking the checkbox (which then passes []) clears the
// line without this component needing to know WHY it's empty.
function ExpiredSpotChart({ bars, trades, emaPoints, height = 420, focusTime }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const emaRef = useRef(null)
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
    emaRef.current = chart.addSeries(LineSeries, { color: EMA_COLOR, lineWidth: 2, title: '5 EMA', priceLineVisible: false, crosshairMarkerVisible: false })
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
      emaRef.current = null
      markersRef.current = null
    }
    // One chart instance per mount, same reasoning as every other page's own chart - series/marker
    // data is (re)populated by the effects below rather than by recreating the chart.
  }, [height])

  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setData(bars)
    // A fresh run is a genuinely NEW series - always re-fit rather than preserve a stale pan/zoom
    // from a previous run's very different date range.
    if (bars.length > 0) chartRef.current?.timeScale().fitContent()
  }, [bars])

  useEffect(() => {
    emaRef.current?.setData(emaPoints ?? [])
  }, [emaPoints])

  useEffect(() => {
    if (!markersRef.current) return
    markersRef.current.setMarkers([...dayResetMarkers(bars), ...tradeEntryMarkers(trades)].sort((a, b) => a.time - b.time))
  }, [bars, trades])

  // A Trades/Signals row click elsewhere on the page sets focusTime to that row's own time.
  useEffect(() => {
    scrollChartToTime(chartRef.current, focusTime)
  }, [focusTime])

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// Same reasoning as StrikeDataPage's own ChartErrorBoundary - a lightweight-charts assertion or bad
// data shape must show a small fallback instead of unmounting the whole page (the tables below are
// still useful even if the chart itself can't render). Must be a class component; React has no hook
// equivalent for getDerivedStateFromError.
class ChartErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    console.error('Expired Backtest chart crashed:', error)
  }

  render() {
    if (this.state.error) {
      return <Alert type="warning" showIcon message="This chart could not be rendered - the data below is still available in the tables." />
    }
    return this.props.children
  }
}

// Runs a real strategy (trades, P&L, signals - not just a chart) against an EXPIRED contract, given
// an actual calendar expiry date instead of BacktestPage's "whatever is currently live". Only two
// strategies can run here at all (see /api/expired-backtest/strategies) - the rest need order-flow
// data across the whole surrounding strike chain that Dhan's rolling-option endpoint cannot supply
// from a single relative-strike call. Deliberately a separate page/engine from Backtrack: that one
// always reads this app's own in-memory live/backfilled history, which has no way to reach an
// expiry that has already rolled off.
export default function ExpiredBacktestPage() {
  const [underlying, setUnderlying] = usePersistedState(STORED_UNDERLYING, 'NIFTY')
  const [timeframe, setTimeframe] = usePersistedState(STORED_TIMEFRAME, 5)
  const [expiryFlag, setExpiryFlag] = useState('WEEK')
  // A plain "yyyy-MM-dd" string, not a dayjs object - this is now a closed choice from
  // /api/expired-backtest/{underlying}/expiries (see the effect below), never freely typed. That
  // endpoint only ever offers REAL listed expiries (past AND not-yet-expired/future ones, both -
  // see ExpiredOptionBacktestService.GetAvailableExpiries) - a typed date that wasn't an actual
  // expiry once let the fetch window cross into a different contract and splice their premiums
  // together, which is what showed this page needed to enforce a closed list rather than leave it
  // to a free date picker.
  const [expiryDate, setExpiryDate] = useState(null)
  const [expiries, setExpiries] = useState([])
  const [expiriesLoading, setExpiriesLoading] = useState(false)
  // Defaults to the single-segment mechanism's own natural range (see DEFAULT_LOOKBACK_DAYS) -
  // reset whenever the cadence changes, since WEEK's and MONTH's are very different.
  const [lookbackDays, setLookbackDays] = useState(DEFAULT_LOOKBACK_DAYS.WEEK)

  const [strategies, setStrategies] = useState([])
  const [strategyKey, setStrategyKey] = usePersistedState(STORED_STRATEGY_KEY, null)
  const [paramValues, setParamValues] = usePersistedState(STORED_PARAM_VALUES, {})
  const paramsForStrategyRef = useRef(strategyKey)

  const [result, setResult] = useState(null) // null = never run yet
  const [loading, setLoading] = useState(false)
  const [runError, setRunError] = useState(null)

  // Set by clicking a Trades/Signals row - every chart on this page (spot, OBV, CDV, Volume+VWAP)
  // recenters on this same moment, at whatever zoom level it already had - see shared.jsx's
  // scrollChartToTime.
  const [focusTime, setFocusTime] = useState(null)

  // Off by default - see ExpiredOptionBacktestService.RunAsync's own doc comment on why: computing
  // OBV/CDV for a strategy that doesn't otherwise need them means a much wider (and slower, more
  // Dhan-rate-limit-exposed) option-chain fetch, so a run only pays for it when this is ticked.
  // Always effectively on for "EMA Crossover + ATM Cross + Flow Confirmation" itself, since that strategy
  // computes them anyway for its own signal logic regardless of this checkbox.
  const [includeObvCdv, setIncludeObvCdv] = useState(false)

  const strategy = strategies.find((s) => s.key === strategyKey) ?? null

  // Purely a display toggle, not a run parameter - unticking it never changes the backtest itself,
  // only whether the chart below draws the line. Off by default so the chart stays uncluttered for
  // a strategy that has nothing to do with the 5 EMA.
  const [showEma, setShowEma] = useState(false)

  // Which IST days to show - a VIEW filter applied AFTER the run, same as BacktestPage's own date
  // range: narrows the trades/signals/chart to a slice of the lookback window this run already
  // fetched, without re-running against Dhan. Widening or clearing it never re-fetches anything -
  // the full run's own data is already sitting in `result`, this just decides what's shown from it.
  // Persisted as plain ISO date strings (dayjs instances themselves are not JSON-safe - see
  // usePersistedState) rather than through that hook directly.
  const [dateRange, setDateRangeState] = useState(() => {
    try {
      const raw = window.localStorage.getItem(STORED_DATE_RANGE)
      if (!raw) return null
      const [from, to] = JSON.parse(raw)
      return [from ? dayjs(from) : null, to ? dayjs(to) : null]
    } catch {
      return null
    }
  })
  const setDateRange = (range) => {
    setDateRangeState(range)
    try {
      window.localStorage.setItem(STORED_DATE_RANGE, JSON.stringify([
        range?.[0] ? range[0].format('YYYY-MM-DD') : null,
        range?.[1] ? range[1].format('YYYY-MM-DD') : null,
      ]))
    } catch {
      // Remembering the date filter is a convenience, never a requirement - see usePersistedState.
    }
  }

  // BANKNIFTY's weekly options were discontinued by NSE - there is no such contract to backtest,
  // so WEEK is not just a bad default for it, it is not a legal choice at all. Forced here (not
  // just hidden below) so switching underlying can never leave a stale WEEK selection in place.
  useEffect(() => {
    if (underlying === 'BANKNIFTY' && expiryFlag === 'WEEK') setExpiryFlag('MONTH')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underlying])

  // Resets the lookback to the new cadence's own default whenever the cadence changes - WEEK's and
  // MONTH's are very different, so a value that made sense for one is usually meaningless (or
  // silently clamped away) for the other. See DEFAULT_LOOKBACK_DAYS for why this is deliberately
  // NOT MAX_LOOKBACK_DAYS.
  useEffect(() => {
    setLookbackDays(DEFAULT_LOOKBACK_DAYS[expiryFlag] ?? DEFAULT_LOOKBACK_DAYS.WEEK)
  }, [expiryFlag])

  // Reloads the list of real, actually-usable expiries whenever underlying/cadence changes -
  // newest first (see the backend's own GetAvailableExpiries), so the most recent listed expiry
  // is the natural default. Clears the current selection first so a stale date from a different
  // underlying/cadence can never briefly be submitted.
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

  useEffect(() => {
    if (underlying && !UNDERLYINGS.includes(underlying)) setUnderlying('NIFTY')
    fetch('/api/expired-backtest/strategies')
      .then((r) => r.json())
      .then((list) => {
        setStrategies(list ?? [])
        setStrategyKey((current) => (list?.some((s) => s.key === current) ? current : list?.[0]?.key ?? null))
      })
      .catch((err) => console.error('Failed to load expired-backtest strategies:', err))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reset every parameter to the newly-picked strategy's own declared defaults - same rule
  // BacktestPage uses, skipped when paramValues already belongs to this exact strategy (the restore-
  // from-storage case on first load).
  useEffect(() => {
    if (!strategy) return
    if (paramsForStrategyRef.current === strategy.key) return
    setParamValues(Object.fromEntries(strategy.parameters.map((p) => [p.key, p.default])))
    paramsForStrategyRef.current = strategy.key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy])

  const canRun = Boolean(underlying && expiryDate && strategyKey)

  const run = () => {
    if (!canRun) return
    setLoading(true)
    setRunError(null)
    const params = new URLSearchParams({
      expiryFlag,
      expiryDate,
      lookbackDays: String(lookbackDays),
      strategy: strategyKey,
      timeframe: String(timeframe),
      includeObvCdv: String(includeObvCdv),
    })
    for (const [k, v] of Object.entries(paramValues)) params.set(k, String(v))

    fetch(`/api/expired-backtest/${underlying}/run?${params.toString()}`)
      .then(async (r) => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.error || `Request failed (HTTP ${r.status}).`)
        return body
      })
      .then((body) => setResult(body))
      .catch((err) => {
        console.error('Failed to run expired-option backtest:', err)
        setResult(null)
        setRunError(err.message || 'Failed to run this backtest.')
      })
      .finally(() => setLoading(false))
  }

  const trades = result?.trades ?? []
  const signals = result?.signals ?? []

  const [fromDay, toDay] = useMemo(() => {
    const from = dateRange?.[0] ? dateRange[0].format('YYYY-MM-DD') : null
    const to = dateRange?.[1] ? dateRange[1].format('YYYY-MM-DD') : null
    return [from, to]
  }, [dateRange])

  // Both tables filter on the SIGNAL's own IST day - the day the strategy decided to act. A trade
  // entered late and exited the next morning therefore stays under the day that produced it, same
  // convention BacktestPage's own date filter uses.
  const inRange = (iso) => {
    if (!fromDay && !toDay) return true
    const day = istDateKey(iso)
    return (!fromDay || day >= fromDay) && (!toDay || day <= toDay)
  }

  const visibleTrades = useMemo(
    () => trades.filter((t) => inRange(t.signalTimeUtc)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trades, fromDay, toDay])

  const visibleSignals = useMemo(
    () => signals.filter((sig) => inRange(sig.timeUtc)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signals, fromDay, toDay])

  // The chart's own candles - same date-range filter as the tables above, so a narrowed date range
  // narrows the chart too.
  const chartBars = useMemo(
    () => (result?.spotChartBars ?? []).filter((c) => inRange(c.time)).map(toBar),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result, fromDay, toDay])

  // The 5 EMA line for the chart's own "Show 5 EMA" toggle - computed off the SAME bars the chart
  // itself plots, using whichever emaPeriod the current strategy is actually running with when it
  // has one (the five-ema family), falling back to the classic 5 otherwise. [] when unticked -
  // ExpiredSpotChart just clears the line on an empty series, it does not need to know why.
  const emaPoints = useMemo(() => {
    if (!showEma || chartBars.length === 0) return []
    const emaPeriodSpec = strategy?.parameters?.find((p) => p.key === 'emaPeriod')
    const emaPeriod = paramValues.emaPeriod ?? emaPeriodSpec?.default ?? 5
    const values = computeEma(chartBars.map((b) => b.close), emaPeriod)
    return chartBars.reduce((points, b, i) => {
      if (values[i] != null) points.push({ time: b.time, value: values[i] })
      return points
    }, [])
  }, [showEma, chartBars, paramValues.emaPeriod, strategy])

  const summary = useMemo(() => {
    // Computed off visibleTrades (the date-filtered set), not the raw run - narrowing the date
    // filter narrows these stats too, same convention BacktestPage's own summary uses.
    const openCount = visibleTrades.filter((t) => t.exitReason === 'Open').length
    const closed = visibleTrades.filter((t) => t.pnlPoints != null && t.exitReason !== 'Open')
    if (closed.length === 0) return openCount > 0 ? { count: 0, openCount } : null
    const wins = closed.filter((t) => t.pnlPoints > 0).length
    const totalPnl = closed.reduce((sum, t) => sum + t.pnlPoints, 0)
    return { count: closed.length, openCount, wins, losses: closed.length - wins, winRate: (wins / closed.length) * 100, totalPnl, avgPnl: totalPnl / closed.length }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleTrades])

  const tradeColumns = [
    { title: 'Signal Time', dataIndex: 'signalTimeUtc', key: 'signalTimeUtc', width: 180, render: (t) => fmtIstDateTime(t) },
    { title: 'Direction', dataIndex: 'direction', key: 'direction', width: 110, render: (direction) => <DirectionTag direction={direction} /> },
    {
      title: 'Position', key: 'position', width: 170,
      render: (_, row) => (
        <Space size={6}>
          <Tag color={row.side === 'Sell' ? SELL_COLOR : BUY_COLOR}>{row.side === 'Sell' ? 'SELL' : 'BUY'}</Tag>
          <Text style={{ color: row.optionType === 'CE' ? CE_COLOR : PE_COLOR }}>{fmtOption(row)}</Text>
        </Space>
      ),
    },
    { title: 'Spot', dataIndex: 'spotPrice', key: 'spotPrice', width: 100, render: (v) => (v == null ? <Text type="secondary">—</Text> : fmtPrice(v)) },
    {
      title: 'Entry', key: 'entry', width: 170,
      render: (_, row) => row.entryTimeUtc ? <>{fmtIstTime(row.entryTimeUtc)} @ {row.entryPrice?.toFixed(2)}</> : <Text type="secondary">—</Text>,
    },
    {
      title: 'Exit', key: 'exit', width: 170,
      render: (_, row) => {
        if (!row.exitTimeUtc) return <Text type="secondary">—</Text>
        const price = row.exitPrice?.toFixed(2)
        return row.exitReason === 'Open'
          ? <><Text type="secondary" style={{ fontSize: 11 }}>as of </Text>{fmtIstTime(row.exitTimeUtc)} @ {price}</>
          : <>{fmtIstTime(row.exitTimeUtc)} @ {price}</>
      },
    },
    { title: 'Reason', dataIndex: 'exitReason', key: 'exitReason', width: 120, render: (reason) => <Tag color={EXIT_REASON_COLOR[reason]}>{EXIT_REASON_LABEL[reason] ?? reason}</Tag> },
    { title: 'P&L', dataIndex: 'pnlPoints', key: 'pnlPoints', width: 130, render: (v, row) => renderPnl(v, row.exitReason === 'Open') },
  ]

  const signalColumns = [
    { title: 'Time', dataIndex: 'timeUtc', key: 'timeUtc', width: 200, render: (t) => fmtIstDateTime(t) },
    {
      title: 'Signal', dataIndex: 'kind', key: 'kind', width: 130,
      render: (kind, row) => (
        <Tag color={kind === 'Entry' ? (row.direction === 'Bullish' ? UP_COLOR : DOWN_COLOR) : undefined} style={{ fontWeight: kind === 'Entry' ? 700 : 400, opacity: kind === 'Rejected' ? 0.6 : 1 }}>
          {kind === 'Rejected' ? 'rejected' : kind.toUpperCase()}
        </Tag>
      ),
    },
    { title: 'Direction', dataIndex: 'direction', key: 'direction', width: 130, render: (direction) => <DirectionTag direction={direction} /> },
    { title: 'Summary', dataIndex: 'summary', key: 'summary' },
  ]

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>

        <Card
          size="small"
          title="Expired Contract Backtest"
          extra={<Text type="secondary" style={{ fontSize: 12 }}>{strategy?.description ?? 'Loading strategies…'}</Text>}
        >
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Space align="end" size={16} wrap>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Underlying</Text>
                <Select value={underlying} onChange={setUnderlying} style={{ width: 140 }} options={UNDERLYINGS.map((u) => ({ value: u, label: u }))} />
              </Space>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Expiry cadence</Text>
                <Segmented
                  value={expiryFlag}
                  onChange={setExpiryFlag}
                  options={[
                    // BANKNIFTY has no weekly contract at all (NSE discontinued it) - disabled
                    // rather than removed, so the control doesn't visibly jump around when
                    // switching underlying.
                    { label: 'Weekly', value: 'WEEK', disabled: underlying === 'BANKNIFTY' },
                    { label: 'Monthly', value: 'MONTH' },
                  ]}
                />
              </Space>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Expiry date{' '}
                  <Tooltip title="Only real listed expiries are offered - a typed date that wasn't a genuine expiry previously let the fetch window cross into a different contract and splice their premiums together. Keep Lookback (days) within this contract's own life to avoid overlapping Backtrack's own live-tracked history for this underlying.">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Text>
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
                  Lookback (days){' '}
                  <Tooltip title="Reaching past the immediately preceding real expiry (Weekly or Monthly) now fetches an OLDER, second segment instead of getting clamped away (e.g. selecting August's monthly expiry with a 45-day lookback also reaches into July's own contract). This older segment is a newer capability and hasn't been confirmed against real data the way the rest of this feature has, so check the diagnostics banner (splice warnings, resolved-vs-expected strike) below after running a lookback this long.">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Text>
                <InputNumber
                  min={1}
                  max={MAX_LOOKBACK_DAYS[expiryFlag] ?? MAX_LOOKBACK_DAYS.WEEK}
                  value={lookbackDays}
                  onChange={(v) => setLookbackDays(v ?? DEFAULT_LOOKBACK_DAYS[expiryFlag] ?? DEFAULT_LOOKBACK_DAYS.WEEK)}
                  style={{ width: 110 }}
                />
              </Space>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Timeframe</Text>
                <Select value={timeframe} onChange={setTimeframe} style={{ width: 110 }} options={TIMEFRAME_OPTIONS} />
              </Space>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Strategy</Text>
                <Select value={strategyKey} onChange={setStrategyKey} style={{ width: 220 }} options={strategies.map((s) => ({ value: s.key, label: s.name }))} />
              </Space>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Date filter{' '}
                  <Tooltip title="Narrows the trades/signals/chart below to a slice of this run's own lookback window - a VIEW filter only, applied after the fact. It never re-fetches from Dhan; widen or clear it to see the rest of the same run.">
                    <InfoCircleOutlined />
                  </Tooltip>
                </Text>
                <RangePicker
                  value={dateRange}
                  onChange={setDateRange}
                  allowEmpty={[true, true]}
                  format="DD MMM YYYY"
                  placeholder={['From date', 'To date']}
                  style={{ width: 260 }}
                />
              </Space>
            </Space>

            <Space align="end" size={16} wrap>
              {strategy?.parameters.map((p) => (
                <Space direction="vertical" size={2} key={p.key}>
                  <Text type="secondary" style={{ fontSize: 12 }}>{p.label}</Text>
                  {p.key === 'squareOffMinutes' || p.key === 'signalStartMinutes' ? (
                    <TimePicker
                      value={paramValues[p.key] ? dayjs().startOf('day').add(paramValues[p.key], 'minute') : null}
                      onChange={(v) => setParamValues((prev) => ({ ...prev, [p.key]: v ? v.hour() * 60 + v.minute() : 0 }))}
                      format="hh:mm A"
                      use12Hours
                      allowClear
                      placeholder="No cutoff"
                      style={{ width: 150 }}
                    />
                  ) : p.options?.length > 0 ? (
                    <Select
                      value={paramValues[p.key] ?? p.default}
                      onChange={(v) => setParamValues((prev) => ({ ...prev, [p.key]: v }))}
                      style={{ width: 200 }}
                      options={p.options.map((o) => ({ value: o.value, label: o.label }))}
                    />
                  ) : (
                    <InputNumber
                      controls={false}
                      min={p.min}
                      max={p.max}
                      step={p.step}
                      value={paramValues[p.key] ?? p.default}
                      onChange={(v) => setParamValues((prev) => ({ ...prev, [p.key]: v ?? p.default }))}
                      style={{ width: 130 }}
                    />
                  )}
                </Space>
              ))}
              <Button type="primary" icon={<PlayCircleOutlined />} onClick={run} loading={loading} disabled={!canRun}>Run</Button>
            </Space>
            <Checkbox checked={includeObvCdv} onChange={(e) => setIncludeObvCdv(e.target.checked)}>
              Also compute CDV / OBV for this run{' '}
              <Tooltip title="Off by default: reconstructing order-flow (CDV/OBV) across the whole surrounding strike chain needs a much wider option-chain fetch (about 1.6x the calls), so it's opt-in for a strategy other than 'EMA Crossover + ATM Cross + Flow Confirmation' (which always computes it anyway). Tick this to plot the CDV/OBV/Volume charts below and visually check they look right for the strategy you're actually running.">
                <InfoCircleOutlined />
              </Tooltip>
            </Checkbox>
          </Space>
        </Card>

        {runError && <Alert type="error" showIcon message={runError} />}

        {result && (() => {
          const spliceCount = (result.ceSplices?.length ?? 0) + (result.peSplices?.length ?? 0)
          const step = STRIKE_STEP_BY_UNDERLYING[underlying] ?? 50
          // Dhan's own resolved strike vs what this app expected from its own real spot - a gap
          // wider than one strike step means the contract resolution itself landed somewhere this
          // run did not ask for, which is the direct, checkable explanation for an implausible
          // premium rather than that premium being genuine.
          const ceMismatch = result.ceResolvedStrike != null && Math.abs(result.ceResolvedStrike - result.ceExpectedStrike) > step
          const peMismatch = result.peResolvedStrike != null && Math.abs(result.peResolvedStrike - result.peExpectedStrike) > step
          const hasWarning = Boolean(result.ceError || result.peError || spliceCount > 0 || ceMismatch || peMismatch)
          return (
            <Alert
              type={hasWarning ? 'warning' : 'info'}
              showIcon
              message={
                <Space direction="vertical" size={2}>
                  <Text>
                    Used the last {result.effectiveLookbackDays} day(s) before expiry ({expiryFlag === 'WEEK' ? 'weekly' : 'monthly'}) - reference token CE at {result.ceStrike}, PE at {result.peStrike}.
                    {' '}{result.spotBarCount} spot bar(s) fetched; {result.ceBarCount} CE bar(s), {result.peBarCount} PE bar(s) for that reference token.
                    {result.effectiveLookbackDays < lookbackDays && ` (your requested ${lookbackDays}-day lookback was capped to keep the window on this one contract)`}
                  </Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    Each trade below is priced off the EXACT strike it entered at (see its own Strike column), tracked from a band of 13 strikes (6 either side of this reference) fetched around it - so a trade stays on the same contract from entry to exit even if the index has since moved, not necessarily this reference token's own bars above.
                  </Text>
                  <Text type={ceMismatch ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>
                    CE reference strike - Dhan resolved: {result.ceResolvedStrike != null ? fmtPrice(result.ceResolvedStrike) : 'not reported'}, this app expected: ~{fmtPrice(result.ceExpectedStrike)}
                    {ceMismatch && ' — MISMATCH, do not trust these trades'}
                  </Text>
                  <Text type={peMismatch ? 'warning' : 'secondary'} style={{ fontSize: 12 }}>
                    PE reference strike - Dhan resolved: {result.peResolvedStrike != null ? fmtPrice(result.peResolvedStrike) : 'not reported'}, this app expected: ~{fmtPrice(result.peExpectedStrike)}
                    {peMismatch && ' — MISMATCH, do not trust these trades'}
                  </Text>
                  {result.ceError && <Text type="warning">CE: {result.ceError}</Text>}
                  {result.peError && <Text type="warning">PE: {result.peError}</Text>}
                  {spliceCount > 0 && (
                    <Text type="warning">
                      Unexpected: a contract splice was detected at{' '}
                      {[
                        ...(result.ceSplices ?? []).map((s) => `CE ${fmtIstDateTime(s.time)} (${fmtPrice(s.previousClose)} → ${fmtPrice(s.thisOpen)})`),
                        ...(result.peSplices ?? []).map((s) => `PE ${fmtIstDateTime(s.time)} (${fmtPrice(s.previousClose)} → ${fmtPrice(s.thisOpen)})`),
                      ].join(', ')}
                      {' '}(a large, sudden premium jump). The window has been automatically trimmed to the larger, single-contract side of that jump (whichever side of it has more bars) - a signal falling in the trimmed-away side simply finds no option data (shown as "No Data" below), rather than being priced off the wrong contract.
                    </Text>
                  )}
                </Space>
              }
            />
          )
        })()}

        {result && summary && (
          <Card size="small">
            <Row gutter={24}>
              <Col><Statistic title="Closed trades" value={summary.count} /></Col>
              {summary.openCount > 0 && <Col><Statistic title="Still open" value={summary.openCount} valueStyle={{ color: OPEN_COLOR }} /></Col>}
              {summary.count > 0 && <>
                <Col><Statistic title="Win rate" value={summary.winRate} precision={1} suffix="%" /></Col>
                <Col><Statistic title="Wins / Losses" value={`${summary.wins} / ${summary.losses}`} /></Col>
                <Col><Statistic title="Total P&L" value={summary.totalPnl} precision={2} suffix="pts" valueStyle={{ color: summary.totalPnl >= 0 ? UP_COLOR : DOWN_COLOR }} /></Col>
                <Col><Statistic title="Avg P&L / trade" value={summary.avgPnl} precision={2} suffix="pts" valueStyle={{ color: summary.avgPnl >= 0 ? UP_COLOR : DOWN_COLOR }} /></Col>
              </>}
            </Row>
          </Card>
        )}

        {!result ? (
          <Card size="small">
            <Empty description="Pick an expiry date and strategy above, then click Run." />
          </Card>
        ) : (
          <>
            <Card
              size="small"
              title="Spot Chart"
              extra={<Text type="secondary" style={{ fontSize: 12 }}>Lookback window, plus a couple of days of context on each side - arrows mark this run's own trade entries</Text>}
            >
              {chartBars.length > 0 ? (
                <>
                  <Checkbox checked={showEma} onChange={(e) => setShowEma(e.target.checked)}>
                    <Text style={{ color: EMA_COLOR }}>Show 5 EMA</Text>
                  </Checkbox>
                  <ChartErrorBoundary key={`${underlying}-${expiryDate}-${timeframe}-${fromDay}-${toDay}`}>
                    <ExpiredSpotChart bars={chartBars} trades={visibleTrades} emaPoints={emaPoints} height={420} focusTime={focusTime} />
                  </ChartErrorBoundary>
                </>
              ) : (
                <Empty description={(fromDay || toDay) ? 'No spot candles on the selected dates - widen or clear the date filter.' : 'No spot candles to chart for this run.'} />
              )}
            </Card>

            <Card
              size="small"
              title="Order Flow — verify CDV / OBV / Volume"
              extra={<Text type="secondary" style={{ fontSize: 12 }}>Reconstructed from this run's own fetched history, over the same lookback window as the spot chart above - click a row in Trades/Signals below to jump every chart here (and the spot chart above) to that moment</Text>}
            >
              <Space direction="vertical" size={16} style={{ width: '100%' }}>
                <div>
                  <Text type="secondary" style={{ fontSize: 12 }}>Spot Volume + Session VWAP</Text>
                  <ChartErrorBoundary key={`vol-${underlying}-${expiryDate}`}>
                    <VolumeVwapChart volumeBars={result.spotVolumeChartBars ?? []} vwapSeries={result.spotVwapSeries ?? []} height={180} focusTime={focusTime} />
                  </ChartErrorBoundary>
                </div>
                {(result.obvCeSeries?.length > 0 || result.cdvCeSeries?.length > 0) ? (
                  <>
                    <div>
                      <Text type="secondary" style={{ fontSize: 12 }}>OBV (delta-weighted, CE vs PE)</Text>
                      <ChartErrorBoundary key={`obv-${underlying}-${expiryDate}`}>
                        <CeVsPeChart ceSeries={result.obvCeSeries ?? []} peSeries={result.obvPeSeries ?? []} valueKey="obv" height={220} focusTime={focusTime} />
                      </ChartErrorBoundary>
                    </div>
                    <div>
                      <Text type="secondary" style={{ fontSize: 12 }}>CDV (session, resets daily)</Text>
                      <ChartErrorBoundary key={`cdv-${underlying}-${expiryDate}`}>
                        <CeVsPeChart ceSeries={result.cdvCeSeries ?? []} peSeries={result.cdvPeSeries ?? []} valueKey="obv" height={220} focusTime={focusTime} />
                      </ChartErrorBoundary>
                    </div>
                  </>
                ) : (
                  <Empty description={
                    strategyKey === 'ema-cross-atm-flow'
                      ? 'No CDV/OBV data for this run.'
                      : "No CDV/OBV data - tick 'Also compute CDV / OBV for this run' above and Run again."
                  } />
                )}
              </Space>
            </Card>

            <Card size="small" title="Trades">
              {(fromDay || toDay) && (
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
                  Showing {visibleTrades.length} of {trades.length} trades, filtered to{' '}
                  {fromDay ?? 'the start'} – {toDay ?? 'the end'} (IST). The run itself still covers the
                  whole lookback window; this only narrows what's shown.
                </Text>
              )}
              <Table
                size="small"
                rowKey={(r, i) => `${r.signalTimeUtc}-${i}`}
                dataSource={visibleTrades}
                columns={tradeColumns}
                pagination={{ pageSize: 50, showSizeChanger: true, pageSizeOptions: [25, 50, 100] }}
                onRow={(row) => ({ onClick: () => setFocusTime(row.entryTimeUtc ?? row.signalTimeUtc), style: { cursor: 'pointer' } })}
                locale={{ emptyText: (fromDay || toDay)
                  ? 'No trades on the selected dates - widen or clear the date filter.'
                  : 'No trades - no entry signals over this window, or click Run to try different settings.' }}
              />
            </Card>

            <Card size="small" title="Signals">
              {(fromDay || toDay) && (
                <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
                  Showing {visibleSignals.length} of {signals.length} signals, filtered to{' '}
                  {fromDay ?? 'the start'} – {toDay ?? 'the end'} (IST).
                </Text>
              )}
              <Table
                size="small"
                rowKey={(r, i) => `${r.timeUtc}-${i}`}
                dataSource={visibleSignals}
                columns={signalColumns}
                pagination={{ pageSize: 50, showSizeChanger: true, pageSizeOptions: [25, 50, 100] }}
                onRow={(row) => ({ onClick: () => setFocusTime(row.timeUtc), style: { cursor: 'pointer' } })}
                locale={{ emptyText: (fromDay || toDay)
                  ? 'No signals on the selected dates - widen or clear the date filter.'
                  : 'No signals over this window.' }}
              />
            </Card>
          </>
        )}
      </Space>
    </div>
  )
}
