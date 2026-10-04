import { Component, useEffect, useMemo, useRef, useState } from 'react'
import { Select, Space, Typography, Spin, Card, Button, Table, Tag, InputNumber, Statistic, Row, Col, DatePicker, TimePicker, Alert, Empty, Checkbox } from 'antd'
import dayjs from 'dayjs'
import { ReloadOutlined, PlayCircleOutlined } from '@ant-design/icons'
import { createSeriesMarkers, CandlestickSeries, LineSeries, CrosshairMode } from 'lightweight-charts'
import { createZoomableChart } from './chartZoom.js'
import {
  UP_COLOR, DOWN_COLOR, CE_COLOR, PE_COLOR, EMA_COLOR, emaLine, srLevelLine, NavBar, DirectionTag, ALERT_KIND_LABEL, fmtIstDateTime, fmtIstTime, fmtPrice, istDateKey,
  TIMEFRAME_OPTIONS, STORED_UNDERLYING, STORED_TIMEFRAME, usePersistedState, pickUnderlying, useExpirySelector, ExpirySelect, withExpiry,
  AXIS_COLOR, GRID_COLOR, BORDER_COLOR, istTimeFormatter, istTickMarkFormatter, toBar, toChartTime, dayResetMarkers,
  CeVsPeChart, VolumeVwapChart, scrollChartToTime, highlightChartAtTime, lastValueAtOrBeforeChartTime,
  useChartSyncGroup, registerChartForSyncAfterSettling,
} from './shared.jsx'

// This page's own persisted keys - underlying/timeframe are shared across every page (see
// STORED_UNDERLYING/STORED_TIMEFRAME above), but strategy/parameters/date-range only mean
// anything here, so they get their own Backtrack-specific storage keys instead.
const STORED_STRATEGY_KEY = 'optionanalytics.backtest.strategyKey'
const STORED_PARAM_VALUES = 'optionanalytics.backtest.paramValues'
const STORED_DATE_RANGE = 'optionanalytics.backtest.dateRange'

const { Title, Text } = Typography
const { RangePicker } = DatePicker

// Buy/Sell deliberately aren't the up/down colors - a SOLD position is neither bullish nor
// bearish on its own leg's premium, and reusing green/red here would read as "profitable".
const BUY_COLOR = '#4dabf7'
const SELL_COLOR = '#c084fc'

const SIGNAL_KIND_LABEL = { ...ALERT_KIND_LABEL, Entry: 'ENTRY', Rejected: 'rejected' }

// Amber, not green/red/neutral - Open is neither a win nor a loss yet, and reusing a settled
// color would misread as a finished result on a row that can still move.
const OPEN_COLOR = '#ffb100'
const EXIT_REASON_COLOR = { TakeProfit: UP_COLOR, StopLoss: DOWN_COLOR, SpotTakeProfit: UP_COLOR, SpotStopLoss: DOWN_COLOR, FlowStopLoss: DOWN_COLOR, EndOfDay: undefined, NoData: undefined, SignalExit: undefined, SquareOff: undefined, MaxHoldingTime: undefined, Open: OPEN_COLOR }
// SignalExit is a strategy's own exit rule firing rather than a price level being hit - the 5 EMA
// strategy's "get out when spot comes back and touches the EMA" is the one that uses it today.
// SquareOff is the user-configured daily cutoff (OptionTradeSimulator.SquareOffTimeParameter) -
// also rule-based rather than a price level, so it shares SignalExit's neutral, undefined color.
// MaxHoldingTime (OptionTradeSimulator.MaxHoldingTimeParameter) is the same idea but a per-trade
// duration cap since ENTRY rather than a shared daily clock cutoff - same neutral color.
// FlowStopLoss (CdvObvFlowStrategy's own FlowReversalExitBars) is CdvObvFlowStrategy's entry thesis
// breaking (the leg that was rising reverses) rather than a premium level being hit - still a real
// loss-cutting exit like StopLoss/SpotStopLoss, so it shares their color, not SignalExit's neutral one.
// SpotTakeProfit/SpotStopLoss are FiveEmaAsTaughtStrategy's own stop/target - a level on the
// UNDERLYING's spot (the alert candle's own high/low, taught 1:3) rather than on the option's
// premium, but still an exit that made/lost money exactly like TakeProfit/StopLoss, so they share
// those same colors rather than SignalExit's neutral one.
//
// Open is NOT a completed trade: it is a position opened TODAY that has not yet hit its stop,
// target, or a strategy exit rule, and today's session has not finished - so there is no real exit
// to report. Its Exit column shows the last known price, not a fill, and its P&L is unrealized (see
// renderPnl) - both can still change before this row would ever legitimately read "End of Day".
const EXIT_REASON_LABEL = {
  TakeProfit: 'Take Profit', StopLoss: 'Stop Loss', SpotTakeProfit: 'Take Profit (spot)', SpotStopLoss: 'Stop Loss (spot)', FlowStopLoss: 'Stop Loss (flow)',
  EndOfDay: 'End of Day', NoData: 'No Data', SignalExit: 'Strategy Exit', SquareOff: 'Square Off', MaxHoldingTime: 'Max Holding Time', Open: 'Open',
}

function isConfluenceLabel(kind) {
  return kind === 'Confluence' ? 'CONFLUENCE' : (SIGNAL_KIND_LABEL[kind] ?? kind)
}

function fmtOption(row) {
  return `${row.strike} ${row.optionType}`
}

function renderCrossState(v) {
  if (!v) return <Text type="secondary">—</Text>
  const isUp = v === 'Up'
  return <Tag color={isUp ? UP_COLOR : DOWN_COLOR}>{isUp ? '▲ Up' : '▼ Down'}</Tag>
}

// isOpen marks the figure as unrealized - a still-running position's P&L is marked to the last
// known price, not a real fill, and can still move before the position actually closes.
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
// every other chart on this app uses for a bullish/bearish event. Sorted ascending:
// createSeriesMarkers requires it.
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

// Plain candlestick chart of the underlying's own currently-backfilled/live spot history, with this
// run's own trade entries marked on it - lets a signal be checked against the real price action
// rather than only read off the Trades table below. Same plain shape as StrikeDataPage's own
// StrikeCandleChart/ExpiredBacktestPage's own ExpiredSpotChart, plus an optional 5 EMA overlay (see
// the "Show 5 EMA" checkbox below) - deliberately NOT App.jsx's own live-ticking PriceChart, since
// this page's own data (trades/signals) only ever refreshes on a deliberate Run, not bar-by-bar.
//
// indicatorLines is an array of { key, label, color, points } - already pre-computed (or omitted
// entirely) by the caller for whichever indicators the CURRENT strategy exposes and the user has
// ticked on; this component just keeps one lightweight-charts line series per key in sync with
// that array (added when a new key appears, removed when one drops out, setData'd on every
// change), so it needs no knowledge of what any of these lines actually mean.
function SpotCandleChart({ bars, trades, indicatorLines, height = 420, focusTime, syncGroup }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const indicatorSeriesRef = useRef(new Map())
  const markersRef = useRef(null)
  // Only auto-fit (and join the sync group) once per mount - a later `bars` update (a fresh Run,
  // not a remount: the page keys this component on underlying/timeframe/date-range, see its own
  // call site) should not re-fit over a pan/zoom the user has since set, nor re-register for sync.
  const hasFitRef = useRef(false)
  const syncCleanupRef = useRef(null)

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
    indicatorSeriesRef.current = new Map()
    markersRef.current = createSeriesMarkers(seriesRef.current, [])
    hasFitRef.current = false
    syncCleanupRef.current = null

    const onResize = () => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth })
    }
    window.addEventListener('resize', onResize)

    return () => {
      window.removeEventListener('resize', onResize)
      syncCleanupRef.current?.()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      indicatorSeriesRef.current = new Map()
      markersRef.current = null
    }
    // One chart instance per mount - series/marker data is (re)populated by the effects below.
  }, [height])

  useEffect(() => {
    if (!seriesRef.current) return
    const preservedRange = hasFitRef.current ? chartRef.current?.timeScale().getVisibleRange() : null
    seriesRef.current.setData(bars)
    if (!hasFitRef.current && bars.length > 0) {
      chartRef.current?.timeScale().fitContent()
      hasFitRef.current = true
      const chartAtFit = chartRef.current
      registerChartForSyncAfterSettling(syncGroup, chartAtFit, () => chartRef.current !== chartAtFit, (cleanup) => { syncCleanupRef.current = cleanup })
    } else if (preservedRange) {
      try { chartRef.current?.timeScale().setVisibleRange(preservedRange) } catch { /* empty */ }
    }
  }, [bars])

  useEffect(() => {
    if (!chartRef.current) return
    const chart = chartRef.current
    const existing = indicatorSeriesRef.current
    const next = indicatorLines ?? []
    const nextKeys = new Set(next.map((l) => l.key))

    for (const [key, series] of existing) {
      if (!nextKeys.has(key)) {
        chart.removeSeries(series)
        existing.delete(key)
      }
    }
    for (const line of next) {
      let series = existing.get(line.key)
      if (!series) {
        series = chart.addSeries(LineSeries, { color: line.color, lineWidth: 2, title: line.label, priceLineVisible: false, crosshairMarkerVisible: false })
        existing.set(line.key, series)
      }
      series.setData(line.points ?? [])
    }
  }, [indicatorLines])

  useEffect(() => {
    if (!markersRef.current) return
    markersRef.current.setMarkers([...dayResetMarkers(bars), ...tradeEntryMarkers(trades)].sort((a, b) => a.time - b.time))
  }, [bars, trades])

  // A Trades/Signals row click elsewhere on the page sets focusTime to that row's own time -
  // recenter AND drop a persistent crosshair on the candlestick series at that exact bar, so the
  // signal is actually marked, not just somewhere in the visible window.
  useEffect(() => {
    scrollChartToTime(chartRef.current, focusTime)
    const target = focusTime ? toChartTime(focusTime) : null
    const price = target != null ? lastValueAtOrBeforeChartTime(bars, target, 'close') : null
    highlightChartAtTime(chartRef.current, seriesRef.current, target, price)
  }, [focusTime, bars])

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
    console.error('Backtrack chart crashed:', error)
  }

  render() {
    if (this.state.error) {
      return <Alert type="warning" showIcon message="This chart could not be rendered - the data below is still available in the tables." />
    }
    return this.props.children
  }
}

// Re-runs ConfluenceAlertService's exact leg-flip + confluence logic offline over whatever
// spot/ATM CE/PE candle history the backend currently holds in memory (see BacktestService) - lets
// you check what the live alert engine would have fired without waiting for it to happen live, and
// run any registered strategy (see the backend's Services/Backtesting/IBacktestStrategy) off those
// Confluence signals to see how it would have played out. The strategy picker and its parameter
// controls are both driven entirely by GET /api/backtest/strategies - a new backend strategy shows
// up here with no frontend change needed.
export default function BacktestPage() {
  const [underlyings, setUnderlyings] = useState([])
  // Shared with every other page and remembered across reloads - see usePersistedState.
  const [selected, setSelected] = usePersistedState(STORED_UNDERLYING, null)
  const [timeframe, setTimeframe] = usePersistedState(STORED_TIMEFRAME, 1)

  const [signals, setSignals] = useState(null)
  const [signalsLoading, setSignalsLoading] = useState(false)

  const [strategies, setStrategies] = useState([])
  // Persisted like underlying/timeframe, so a refresh comes back to the same strategy and the same
  // tuned parameters rather than resetting to the first strategy's defaults every time.
  const [strategyKey, setStrategyKey] = usePersistedState(STORED_STRATEGY_KEY, null)
  const [paramValues, setParamValues] = usePersistedState(STORED_PARAM_VALUES, {})
  const [trades, setTrades] = useState(null)
  const [tradesLoading, setTradesLoading] = useState(false)

  // The underlying's own currently-backfilled/live spot history - what the chart below plots.
  // Fetched alongside signals/trades (see loadSpotCandles' own call sites) rather than kept
  // continuously live-ticking (unlike App.jsx's own Dashboard chart): this page's trades/signals
  // are themselves a point-in-time snapshot from the last Run, so the chart matches that same
  // cadence rather than drifting ahead of the data it is annotating.
  const [spotCandles, setSpotCandles] = useState([])

  // Order-flow verification charts - the SAME live CDV/OBV state the Dashboard's own charts read
  // (GET /api/cdv/{underlying}/...), plus real spot/index volume and its session VWAP - fetched
  // alongside the run itself so a signal on the Signals table can be checked against what CDV/OBV/
  // volume actually looked like at that moment, not just trusted. Purely a display concern: nothing
  // here feeds back into the strategy run.
  const [obvCe, setObvCe] = useState([])
  const [obvPe, setObvPe] = useState([])
  const [cdvCe, setCdvCe] = useState([])
  const [cdvPe, setCdvPe] = useState([])
  const [cdvPrevCe, setCdvPrevCe] = useState([])
  const [cdvPrevPe, setCdvPrevPe] = useState([])
  const [spotVolumeBars, setSpotVolumeBars] = useState([])
  const [spotVwapSeries, setSpotVwapSeries] = useState([])

  // Set by clicking a Trades/Signals row - every chart on this page (spot, OBV, CDV, Volume+VWAP)
  // recenters on this same moment, at whatever zoom level it already had (see
  // shared.jsx's scrollChartToTime). A plain ISO string, the same shape every row's own time field
  // already is, so no conversion is needed between "the row I clicked" and "the time to scroll to".
  const [focusTime, setFocusTime] = useState(null)

  // All four charts below (spot, Volume+VWAP, OBV, CDV) pan/zoom together - dragging or zooming any
  // one of them pushes the same window to the rest. See shared.jsx's useChartSyncGroup for why this
  // is scoped to this page's own charts rather than a global registry.
  const chartSyncGroup = useChartSyncGroup()

  // Which (strategy key, timeframe) pair paramValues currently reflects - seeded from the RESTORED
  // strategyKey/timeframe so a page load that finds matching stored parameters keeps them, rather
  // than the defaults-reset effect below immediately overwriting them before the user ever sees
  // them. Only a genuine strategy switch OR timeframe change (this ref no longer matching) resets
  // to that (strategy, timeframe) pair's own declared defaults.
  const paramsForStrategyRef = useRef(`${strategyKey}:${timeframe}`)

  // Which IST days to show. Purely a VIEW filter applied after the run - the backtest itself always
  // runs over the whole backfilled window, because a strategy needs the bars before a day to have
  // its EMAs (and the simulator its one-position-at-a-time state) right on that day. Narrowing what
  // is fed to the strategy would change the answers rather than just the rows on screen.
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

  const strategy = strategies.find((s) => s.key === strategyKey) ?? null

  // Which of the CURRENT strategy's own indicator lines (see indicatorDefs below) are ticked on -
  // purely a display toggle, not a run parameter: unticking one never changes the backtest itself,
  // only whether the chart below draws that line. Keyed by indicator key so a strategy switch
  // naturally shows nothing ticked for indicators it has never heard of, without needing an explicit
  // reset effect.
  const [visibleIndicators, setVisibleIndicators] = useState({})

  // Which expiry THIS PAGE backtests against - see useExpirySelector. Every tracked expiry is held
  // live server-side, so this is just a different ?expiry= on this page's own requests: backtesting
  // next month here leaves the Dashboard and every armed trigger exactly where they were.
  const { expiries, selectedExpiry, expiryParam, isManual: expiryIsManual, loading: expiryLoading, selectExpiry } = useExpirySelector(selected)
  const handleExpiryChange = (expiry) => {
    selectExpiry(expiry).then(() => {
      loadSignals()
      runTrades()
      loadSpotCandles()
      loadFlowCharts()
    })
  }

  useEffect(() => {
    fetch('/api/spot/underlyings')
      .then((r) => r.json())
      .then((list) => {
        setUnderlyings(list)
        setSelected((current) => pickUnderlying(list, current))
      })
      .catch((err) => console.error('Failed to load underlyings:', err))

  }, [])

  // Re-fetched whenever the page's own timeframe changes, not just once on mount: a strategy's
  // Default for a points-based parameter (stop/target, and a couple of strategies' own extra
  // buffer/tolerance points) can differ per timeframe (see IBacktestStrategy.DefaultsForTimeframe on
  // the backend) - a 1-minute-tuned default reads as too tight once bars widen to 5 minutes. Passing
  // ?timeframe= is what lets the backend apply those overrides before this even reaches the page.
  useEffect(() => {
    fetch(`/api/backtest/strategies?timeframe=${timeframe}`)
      .then((r) => r.json())
      .then((list) => {
        setStrategies(list ?? [])
        // Keep a restored strategyKey if the backend still offers it (same stale-value protection
        // pickUnderlying gives the underlying selector); only fall back to the first strategy when
        // there is nothing valid already selected.
        setStrategyKey((current) => (list?.some((s) => s.key === current) ? current : list?.[0]?.key ?? null))
      })
      .catch((err) => console.error('Failed to load backtest strategies:', err))
  }, [timeframe])

  // Reset every parameter to the newly-picked strategy's own declared defaults (already timeframe-
  // adjusted - see the fetch above) - each strategy's parameters are independent (a different key
  // set entirely), so values from the previous strategy would be meaningless carried over, and a
  // timeframe switch is treated the same way (paramsForStrategyRef keyed on BOTH), since its whole
  // point is to start the form over from values suited to the newly-selected timeframe rather than
  // silently leaving stale 1-minute-tuned numbers in place at 5 minutes. Skipped only when
  // paramValues already belongs to this exact (strategy, timeframe) pair - the case right after a
  // page load that restored both a strategyKey and matching paramValues from storage, which must
  // survive this effect's first run rather than being immediately overwritten by fresh defaults.
  useEffect(() => {
    if (!strategy) return
    const key = `${strategy.key}:${timeframe}`
    if (paramsForStrategyRef.current === key) return
    setParamValues(Object.fromEntries(strategy.parameters.map((p) => [p.key, p.default])))
    paramsForStrategyRef.current = key
  }, [strategy, timeframe])

  // The signal table describes whichever strategy is selected - each strategy reports the signals
  // IT reasons about (see the backend's IBacktestStrategy.EntrySignals), so the table always
  // explains the trades listed under it instead of always describing the confluence rule.
  const loadSignals = () => {
    if (!selected || !strategyKey) return
    setSignalsLoading(true)
    const paramQuery = Object.entries(paramValues).map(([k, v]) => `${k}=${v}`).join('&')
    fetch(withExpiry(`/api/backtest/${selected}?strategy=${strategyKey}&timeframe=${timeframe}&${paramQuery}`, expiryParam))
      .then((r) => r.json())
      .then((data) => setSignals(data ?? []))
      .catch((err) => console.error('Failed to load backtest signals:', err))
      .finally(() => setSignalsLoading(false))
  }

  const runTrades = () => {
    if (!selected || !strategyKey) return
    setTradesLoading(true)
    const paramQuery = Object.entries(paramValues).map(([k, v]) => `${k}=${v}`).join('&')
    fetch(withExpiry(`/api/backtest/${selected}/trades?strategy=${strategyKey}&timeframe=${timeframe}&${paramQuery}`, expiryParam))
      .then((r) => r.json())
      .then((data) => setTrades(data ?? []))
      .catch((err) => console.error('Failed to load backtest trades:', err))
      .finally(() => setTradesLoading(false))
  }

  // Same GET /api/spot/{underlying}/candles the Dashboard's own chart reads - this page's whole
  // currently-backfilled/live spot history, at native 1-minute resolution (aggregated to the
  // selected timeframe client-side below, same as the Dashboard's own timeframe switcher).
  const loadSpotCandles = () => {
    if (!selected) return
    fetch(`/api/spot/${selected}/candles`)
      .then((r) => r.json())
      .then((data) => setSpotCandles(data ?? []))
      .catch((err) => console.error('Failed to load spot candles:', err))
  }

  // The three verification charts (OBV, CDV, spot Volume+VWAP) - see the state above's own comment.
  // CDV/OBV honor ?expiry= like every other CDV read on this page; spot volume/VWAP don't (spot has
  // no expiry of its own).
  const loadFlowCharts = () => {
    if (!selected) return
    fetch(withExpiry(`/api/cdv/${selected}/obv-series`, expiryParam))
      .then((r) => r.json())
      .then((data) => { setObvCe(data?.ce ?? []); setObvPe(data?.pe ?? []) })
      .catch((err) => console.error('Failed to load OBV series:', err))
    fetch(withExpiry(`/api/cdv/${selected}/series`, expiryParam))
      .then((r) => r.json())
      .then((data) => { setCdvCe(data?.map((p) => ({ time: p.time, obv: p.ceCdv })) ?? []); setCdvPe(data?.map((p) => ({ time: p.time, obv: p.peCdv })) ?? []) })
      .catch((err) => console.error('Failed to load CDV series:', err))
    fetch(withExpiry(`/api/cdv/${selected}/previous-day-series`, expiryParam))
      .then((r) => r.json())
      .then((data) => { setCdvPrevCe(data?.map((p) => ({ time: p.time, obv: p.ceCdv })) ?? []); setCdvPrevPe(data?.map((p) => ({ time: p.time, obv: p.peCdv })) ?? []) })
      .catch((err) => console.error('Failed to load CDV previous-day series:', err))
    fetch(`/api/spot/${selected}/volume-candles`)
      .then((r) => r.json())
      .then((data) => setSpotVolumeBars(data ?? []))
      .catch((err) => console.error('Failed to load spot volume candles:', err))
    fetch(`/api/spot/${selected}/vwap-series`)
      .then((r) => r.json())
      .then((data) => setSpotVwapSeries(data ?? []))
      .catch((err) => console.error('Failed to load spot VWAP series:', err))
  }

  // Signals refresh automatically on underlying/timeframe - those are discrete dropdown choices,
  // not something typed. Strategy parameters only apply when "Run" is clicked, so adjusting them
  // doesn't fire a request on every keystroke.
  // Signals and trades both refresh together on underlying/timeframe/strategy - all discrete
  // dropdown choices. Strategy parameters only apply when "Run" is clicked, so adjusting them
  // doesn't fire a request on every keystroke.
  useEffect(() => {
    if (!strategy) return
    loadSignals()
    runTrades()
    loadSpotCandles()
    loadFlowCharts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, timeframe, strategyKey, strategy, expiryParam])

  const [fromDay, toDay] = useMemo(() => {
    const from = dateRange?.[0] ? dateRange[0].format('YYYY-MM-DD') : null
    const to = dateRange?.[1] ? dateRange[1].format('YYYY-MM-DD') : null
    return [from, to]
  }, [dateRange])

  // Both tables filter on the SIGNAL's own IST day - the day the strategy decided to act. A trade
  // entered late and exited the next morning therefore stays under the day that produced it, which
  // is the day you are looking at when you filter.
  const inRange = (iso) => {
    if (!fromDay && !toDay) return true
    const day = istDateKey(iso)
    return (!fromDay || day >= fromDay) && (!toDay || day <= toDay)
  }

  const visibleTrades = useMemo(
    () => (trades ?? []).filter((t) => inRange(t.signalTimeUtc)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trades, fromDay, toDay])

  const visibleSignals = useMemo(
    () => (signals ?? []).filter((sig) => inRange(sig.timeUtc)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signals, fromDay, toDay])

  // The chart's own candles - same date-range filter as the tables above (so a narrowed date range
  // narrows the chart too), converted to chart bars and bucketed to the selected timeframe
  // client-side, same as App.jsx's own Dashboard chart does for its timeframe switcher (everything
  // server-side stays at native 1-minute resolution).
  const chartBars = useMemo(() => {
    const bars = (spotCandles ?? []).filter((c) => inRange(c.time)).map(toBar)
    if (timeframe <= 1 || bars.length === 0) return bars
    const bucketSeconds = timeframe * 60
    const buckets = new Map()
    for (const b of bars) {
      const bucketTime = Math.floor(b.time / bucketSeconds) * bucketSeconds
      const existing = buckets.get(bucketTime)
      if (!existing) buckets.set(bucketTime, { time: bucketTime, open: b.open, high: b.high, low: b.low, close: b.close })
      else { existing.high = Math.max(existing.high, b.high); existing.low = Math.min(existing.low, b.low); existing.close = b.close }
    }
    return Array.from(buckets.values()).sort((a, b) => a.time - b.time)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotCandles, fromDay, toDay, timeframe])

  // Which indicator line(s) the CURRENT strategy exposes - one checkbox per entry, replacing the
  // old single hardcoded "Show 5 EMA" toggle. Each entry's own `compute` reads whatever THIS
  // strategy's own tuned parameter values currently are, so the plotted line always matches what a
  // Run would actually use, not a stale default. A strategy with no descriptor here (a future one
  // that ships before this list is updated for it) simply shows no checkboxes - never a crash.
  const indicatorDefs = useMemo(() => {
    if (!strategy) return []
    const paramDefault = (key, fallback) => paramValues[key] ?? strategy.parameters?.find((p) => p.key === key)?.default ?? fallback

    if (strategy.key === 'ema-crossover-retest') {
      const fastPeriod = paramDefault('fastEmaPeriod', 20)
      const slowPeriod = paramDefault('slowEmaPeriod', 50)
      return [
        { key: 'fastEma', label: `Fast EMA (${fastPeriod})`, color: '#f0a020', compute: (bars) => emaLine(bars, fastPeriod) },
        { key: 'slowEma', label: `Slow EMA (${slowPeriod})`, color: EMA_COLOR, compute: (bars) => emaLine(bars, slowPeriod) },
      ]
    }
    if (strategy.key === 'kathy-lien-ema20-ema200-pullback') {
      const fastPeriod = paramDefault('fastEmaPeriod', 20)
      const slowPeriod = paramDefault('slowEmaPeriod', 200)
      return [
        { key: 'fastEma', label: `Fast EMA (${fastPeriod})`, color: '#f0a020', compute: (bars) => emaLine(bars, fastPeriod) },
        { key: 'slowEma', label: `Slow EMA (${slowPeriod})`, color: EMA_COLOR, compute: (bars) => emaLine(bars, slowPeriod) },
      ]
    }
    if (strategy.key === 'five-ema') {
      const period = paramDefault('emaPeriod', 5)
      return [
        { key: 'ema', label: `${period} EMA`, color: EMA_COLOR, compute: (bars) => emaLine(bars, period) },
      ]
    }
    if (strategy.key === 'sr-flow-sell') {
      const srTimeframeMinutes = paramDefault('srTimeframeMinutes', 30)
      const srLookbackBars = paramDefault('srLookbackBars', 20)
      const oneMinuteBars = (spotCandles ?? []).map(toBar)
      return [
        { key: 'resistance', label: `Resistance (${srTimeframeMinutes}m x${srLookbackBars})`, color: DOWN_COLOR, compute: (bars) => srLevelLine(oneMinuteBars, bars, srTimeframeMinutes, srLookbackBars, 'high') },
        { key: 'support', label: `Support (${srTimeframeMinutes}m x${srLookbackBars})`, color: UP_COLOR, compute: (bars) => srLevelLine(oneMinuteBars, bars, srTimeframeMinutes, srLookbackBars, 'low') },
      ]
    }
    return []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy, paramValues.fastEmaPeriod, paramValues.slowEmaPeriod, paramValues.emaPeriod, paramValues.srTimeframeMinutes, paramValues.srLookbackBars, spotCandles])

  // The actual plotted line data - only for whichever of the above are ticked on in
  // visibleIndicators, and only once there is something to plot them against.
  const indicatorLines = useMemo(() => {
    if (chartBars.length === 0) return []
    return indicatorDefs
      .filter((def) => visibleIndicators[def.key])
      .map((def) => ({ key: def.key, label: def.label, color: def.color, points: def.compute(chartBars) }))
  }, [indicatorDefs, visibleIndicators, chartBars])

  const summary = useMemo(() => {
    // Open positions are excluded from every stat below - they haven't actually closed, so folding
    // their unrealized P&L into Win rate/Total P&L would overstate a backtest whose most recent
    // position simply hasn't finished yet. openCount surfaces them separately instead of silently
    // dropping them from the summary entirely.
    const openCount = visibleTrades.filter((t) => t.exitReason === 'Open').length
    const closed = visibleTrades.filter((t) => t.pnlPoints != null && t.exitReason !== 'Open')
    if (closed.length === 0) return openCount > 0 ? { count: 0, openCount } : null
    const wins = closed.filter((t) => t.pnlPoints > 0).length
    const totalPnl = closed.reduce((sum, t) => sum + t.pnlPoints, 0)
    return {
      count: closed.length,
      openCount,
      wins,
      losses: closed.length - wins,
      winRate: (wins / closed.length) * 100,
      totalPnl,
      avgPnl: totalPnl / closed.length,
    }
  }, [visibleTrades])

  const signalColumns = [
    { title: 'Time', dataIndex: 'timeUtc', key: 'timeUtc', width: 200, render: (t) => fmtIstDateTime(t) },
    {
      title: 'Signal',
      dataIndex: 'kind',
      key: 'kind',
      width: 160,
      render: (kind, row) => {
        // A Confluence or an Entry is a signal that would actually be traded, so both get the
        // directional colour and bold; a Rejected one is deliberately muted - it is there to show
        // what the filters threw out and why, not to compete with the real signals.
        const isActionable = kind === 'Confluence' || kind === 'Entry'
        const isRejected = kind === 'Rejected'
        return (
          <Tag
            color={isActionable ? (row.direction === 'Bullish' ? UP_COLOR : DOWN_COLOR) : undefined}
            style={{ fontWeight: isActionable ? 700 : 400, opacity: isRejected ? 0.6 : 1 }}
          >
            {isConfluenceLabel(kind)}
          </Tag>
        )
      },
    },
    { title: 'Direction', dataIndex: 'direction', key: 'direction', width: 130, render: (direction) => <DirectionTag direction={direction} /> },
    // Where each OBV line sits relative to the other at that signal - CE above PE is the bullish
    // arrangement, so the two are always mirrors of each other.
    { title: 'CE OBV', dataIndex: 'ceObvCross', key: 'ceObvCross', width: 100, render: renderCrossState },
    { title: 'PE OBV', dataIndex: 'peObvCross', key: 'peObvCross', width: 100, render: renderCrossState },
    { title: 'Summary', dataIndex: 'summary', key: 'summary' },
  ]

  const tradeColumns = [
    { title: 'Signal Time', dataIndex: 'signalTimeUtc', key: 'signalTimeUtc', width: 180, render: (t) => fmtIstDateTime(t) },
    { title: 'Direction', dataIndex: 'direction', key: 'direction', width: 110, render: (direction) => <DirectionTag direction={direction} /> },
    {
      title: 'Position',
      key: 'position',
      width: 170,
      render: (_, row) => (
        <Space size={6}>
          <Tag color={row.side === 'Sell' ? SELL_COLOR : BUY_COLOR}>{row.side === 'Sell' ? 'SELL' : 'BUY'}</Tag>
          <Text style={{ color: row.optionType === 'CE' ? CE_COLOR : PE_COLOR }}>{fmtOption(row)}</Text>
        </Space>
      ),
    },
    {
      title: 'Spot',
      dataIndex: 'spotPrice',
      key: 'spotPrice',
      width: 100,
      render: (v) => (v == null ? <Text type="secondary">—</Text> : fmtPrice(v)),
    },
    {
      title: 'Entry',
      key: 'entry',
      width: 170,
      render: (_, row) => row.entryTimeUtc ? <>{fmtIstTime(row.entryTimeUtc)} @ {row.entryPrice?.toFixed(2)}</> : <Text type="secondary">—</Text>,
    },
    {
      title: 'Exit',
      key: 'exit',
      width: 170,
      render: (_, row) => {
        if (!row.exitTimeUtc) return <Text type="secondary">—</Text>
        const price = row.exitPrice?.toFixed(2)
        // Open has no real fill yet - this is where the position currently marks, not an exit.
        return row.exitReason === 'Open'
          ? <><Text type="secondary" style={{ fontSize: 11 }}>as of </Text>{fmtIstTime(row.exitTimeUtc)} @ {price}</>
          : <>{fmtIstTime(row.exitTimeUtc)} @ {price}</>
      },
    },
    {
      title: 'Reason',
      dataIndex: 'exitReason',
      key: 'exitReason',
      width: 120,
      render: (reason) => <Tag color={EXIT_REASON_COLOR[reason]}>{EXIT_REASON_LABEL[reason] ?? reason}</Tag>,
    },
    { title: 'P&L', dataIndex: 'pnlPoints', key: 'pnlPoints', width: 130, render: (v, row) => renderPnl(v, row.exitReason === 'Open') },
  ]

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
          <ExpirySelect expiries={expiries} value={selectedExpiry} isManual={expiryIsManual} loading={expiryLoading} onChange={handleExpiryChange} />
          <Select value={timeframe} onChange={setTimeframe} style={{ width: 120 }} options={TIMEFRAME_OPTIONS} />
          <RangePicker
            value={dateRange}
            onChange={setDateRange}
            allowEmpty={[true, true]}
            format="DD MMM YYYY"
            placeholder={['From date', 'To date']}
            style={{ width: 280 }}
          />
          <Button icon={<ReloadOutlined />} onClick={loadSignals} loading={signalsLoading} disabled={!selected}>
            Re-run signals
          </Button>
        </Space>

        <Card
          size="small"
          title="Strategy Backtest"
          extra={<Text type="secondary" style={{ fontSize: 12 }}>{strategy?.description ?? 'Loading strategies…'}</Text>}
        >
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Space align="end" size={16} wrap>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Strategy</Text>
                <Select
                  value={strategyKey}
                  onChange={setStrategyKey}
                  style={{ width: 200 }}
                  options={strategies.map((s) => ({ value: s.key, label: s.name }))}
                />
              </Space>
              {/* A parameter that declares Options is a pick-one (rendered as a dropdown); one
                  that doesn't is a free number. Both still carry a plain numeric value, so the
                  request below is built the same way either way. squareOffMinutes/
                  signalStartMinutes are the exception - still plain minutes-past-midnight-IST
                  numbers on the wire (see OptionTradeSimulator's own parameter builders), but
                  picking an exact minute on a bare number spinner is painful, so these two keys
                  render a time-of-day picker instead and do the minutes<->time conversion
                  themselves. */}
              {strategy?.parameters.map((p) => (
                <Space direction="vertical" size={2} key={p.key}>
                  <Text type="secondary" style={{ fontSize: 12 }}>{p.label}</Text>
                  {p.key === 'squareOffMinutes' || p.key === 'signalStartMinutes' ? (
                    // 12-hour with an explicit AM/PM selector, not 24-hour - a 24-hour-only field
                    // silently reads "03:10" as 3:10 AM when the trader meant 3:10 PM near market
                    // close, and (for squareOffMinutes) a cutoff that early is always in the past
                    // relative to any intraday entry, squaring every trade off on its very next
                    // bar. AM/PM makes that ambiguity impossible to enter by accident.
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
              <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => { loadSignals(); runTrades(); loadSpotCandles(); loadFlowCharts() }} loading={tradesLoading} disabled={!selected || !strategyKey}>
                Run
              </Button>
            </Space>

            {summary && (
              <Row gutter={24}>
                <Col><Statistic title="Trades" value={summary.count} /></Col>
                {/* Open positions are shown separately, not folded into the stats to their left -
                    see the summary computation for why (they have no realized P&L yet). */}
                {summary.openCount > 0 && (
                  <Col><Statistic title="Open" value={summary.openCount} styles={{ content: { color: OPEN_COLOR } }} /></Col>
                )}
                {summary.count > 0 && <>
                  <Col><Statistic title="Wins / Losses" value={`${summary.wins} / ${summary.losses}`} /></Col>
                  <Col><Statistic title="Win rate" value={summary.winRate} precision={1} suffix="%" /></Col>
                  <Col><Statistic title="Total P&L" value={summary.totalPnl} precision={2} suffix="pts" styles={{ content: { color: summary.totalPnl >= 0 ? UP_COLOR : DOWN_COLOR } }} /></Col>
                  <Col><Statistic title="Avg P&L / trade" value={summary.avgPnl} precision={2} suffix="pts" styles={{ content: { color: summary.avgPnl >= 0 ? UP_COLOR : DOWN_COLOR } }} /></Col>
                </>}
              </Row>
            )}

            {(fromDay || toDay) && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                Showing {visibleTrades.length} of {(trades ?? []).length} trades, filtered to{' '}
                {fromDay ?? 'the start'} – {toDay ?? 'the end'} (IST). The backtest still ran over the
                whole window; the stats above cover the filtered rows only.
              </Text>
            )}
          </Space>
        </Card>

        <Card
          size="small"
          title="Charts — Spot, CDV, OBV, Volume"
          extra={<Text type="secondary" style={{ fontSize: 12 }}>Click a row in Trades/Signals below to jump every chart here to that exact moment, marked with a crosshair</Text>}
        >
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {chartBars.length > 0 ? (
              <div>
                {indicatorDefs.map((def) => (
                  <Checkbox
                    key={def.key}
                    checked={!!visibleIndicators[def.key]}
                    onChange={(e) => setVisibleIndicators((v) => ({ ...v, [def.key]: e.target.checked }))}
                  >
                    <Text style={{ color: def.color }}>{def.label}</Text>
                  </Checkbox>
                ))}
                <ChartErrorBoundary key={`${selected}-${expiryParam}-${timeframe}-${fromDay}-${toDay}`}>
                  <SpotCandleChart bars={chartBars} trades={visibleTrades} indicatorLines={indicatorLines} height={420} focusTime={focusTime} syncGroup={chartSyncGroup} />
                </ChartErrorBoundary>
              </div>
            ) : (
              <Empty description="No spot candles to chart yet." />
            )}
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>Spot Volume + Session VWAP</Text>
              <ChartErrorBoundary key={`vol-${selected}-${expiryParam}`}>
                <VolumeVwapChart volumeBars={spotVolumeBars} vwapSeries={spotVwapSeries} height={180} focusTime={focusTime} syncGroup={chartSyncGroup} />
              </ChartErrorBoundary>
            </div>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>OBV (delta-weighted, CE vs PE)</Text>
              <ChartErrorBoundary key={`obv-${selected}-${expiryParam}`}>
                <CeVsPeChart ceSeries={obvCe} peSeries={obvPe} valueKey="obv" height={220} focusTime={focusTime} syncGroup={chartSyncGroup} />
              </ChartErrorBoundary>
            </div>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>CDV (session, resets daily — dashed line is the previous trading day)</Text>
              <ChartErrorBoundary key={`cdv-${selected}-${expiryParam}`}>
                <CeVsPeChart ceSeries={cdvCe} peSeries={cdvPe} prevCeSeries={cdvPrevCe} prevPeSeries={cdvPrevPe} valueKey="obv" height={220} focusTime={focusTime} syncGroup={chartSyncGroup} />
              </ChartErrorBoundary>
            </div>
          </Space>
        </Card>

        <Card size="small" title="Trades">
          {tradesLoading && !trades ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
              <Spin size="large" />
            </div>
          ) : (
            <Table
              size="small"
              rowKey={(row) => `${row.signalTimeUtc}-${row.optionType}`}
              dataSource={visibleTrades}
              columns={tradeColumns}
              pagination={{ pageSize: 25, showSizeChanger: false }}
              scroll={{ x: 'max-content' }}
              onRow={(row) => ({ onClick: () => setFocusTime(row.entryTimeUtc ?? row.signalTimeUtc), style: { cursor: 'pointer' } })}
              locale={{ emptyText: (fromDay || toDay)
                ? 'No trades on the selected dates - widen or clear the date filter.'
                : 'No trades - no Confluence signals yet, or click Run to simulate with the current settings.' }}
            />
          )}
        </Card>

        <Card
          size="small"
          title={`Signals — ${strategy?.name ?? 'strategy'}`}
          extra={<Text type="secondary" style={{ fontSize: 12 }}>What the strategy above saw, newest first</Text>}
        >
          <Text type="secondary">
            Every signal the <b>{strategy?.name ?? 'selected strategy'}</b> rule examined across{' '}
            {selected ?? 'the selected underlying'}'s currently-backfilled candle history at the{' '}
            {timeframe}-minute timeframe, computed fresh from scratch - not the live alert log, so it also
            covers bars that closed before this session's alert engine started. Rows it would actually have
            traded are highlighted; the muted ones show what its filters rejected, and why.
          </Text>
        </Card>

        {(fromDay || toDay) && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            Showing {visibleSignals.length} of {(signals ?? []).length} signals, filtered to{' '}
            {fromDay ?? 'the start'} – {toDay ?? 'the end'} (IST).
          </Text>
        )}

        {signalsLoading && !signals ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
            <Spin size="large" />
          </div>
        ) : (
          <Table
            size="small"
            rowKey={(row) => `${row.timeUtc}-${row.kind}`}
            dataSource={visibleSignals}
            columns={signalColumns}
            pagination={{ pageSize: 25, showSizeChanger: false }}
            scroll={{ x: 'max-content' }}
            onRow={(row) => ({ onClick: () => setFocusTime(row.timeUtc), style: { cursor: 'pointer' } })}
            locale={{ emptyText: (fromDay || toDay)
              ? 'No signals on the selected dates - widen or clear the date filter.'
              : 'No signals - not enough closed-bar history yet, or the underlying has no backfilled candles.' }}
          />
        )}
      </Space>
    </div>
  )
}
