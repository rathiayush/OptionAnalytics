import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, DatePicker, InputNumber, Progress, Segmented, Select, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd'
import { DownloadOutlined, PlayCircleOutlined, StopOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { LineSeries } from 'lightweight-charts'
import { AXIS_COLOR, BORDER_COLOR, DOWN_COLOR, GRID_COLOR, NavBar, UP_COLOR, usePersistedState } from './shared.jsx'
import { createZoomableChart } from './chartZoom.js'
import { PAPER_TRADE_LOT_SIZE } from './scannerCore.js'
import {
  BACKTEST_DEFAULTS, INDICATORS, MAX_BACKTEST_DAYS, SIGNAL_STRATEGIES, SIGNAL_STRATEGY_IDS, backtestDays, istMinute, prepareDay, simulateRun, summarize, tradesCsv,
} from './signalBacktest.js'
import { FoldText } from './FoldText.jsx'

// The SIGNAL BACKTEST page: pick an index, a range of past days and option BUYING or SELLING; each day is loaded as OI
// Replay loads it (the server keeps past days on disk - a day never loaded before comes from Dhan once), replayed minute
// by minute through the strategies (signalBacktest.js - each signal from data up to its minute only) and every signal's
// option trade simulated; the report sums them per strategy, per day and trade by trade. A day is prepared once and
// kept for the tab's life, so changing the mode, the stop / target or the strategies re-runs at once with no new load.

const { Text, Title } = Typography
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX']
const LOAD_TIMEOUT_MS = 240_000
const STORE = {
  underlying: 'optionanalytics.signalBacktest.underlying',
  range: 'optionanalytics.signalBacktest.range',
  mode: 'optionanalytics.signalBacktest.mode',
  moneyness: 'optionanalytics.signalBacktest.moneyness',
  slPct: 'optionanalytics.signalBacktest.slPct',
  targetPct: 'optionanalytics.signalBacktest.targetPct',
  timeStopMin: 'optionanalytics.signalBacktest.timeStopMin',
  maxTradesPerDay: 'optionanalytics.signalBacktest.maxTradesPerDay',
  cooldownMin: 'optionanalytics.signalBacktest.cooldownMin',
  lots: 'optionanalytics.signalBacktest.lots',
  charges: 'optionanalytics.signalBacktest.charges',
  strategies: 'optionanalytics.signalBacktest.strategies',
  voteThreshold: 'optionanalytics.signalBacktest.voteThreshold',
  equity: 'optionanalytics.signalBacktest.equityView',
}
const COLORS = ['#4096ff', '#fa8c16', '#36cfc9', '#f759ab', '#9254de', '#fadb14', '#73d13d', '#ff7875', '#69c0ff']
const colorOf = (id) => COLORS[SIGNAL_STRATEGY_IDS.indexOf(id) % COLORS.length]
const nameOf = Object.fromEntries(SIGNAL_STRATEGIES.map((s) => [s.id, s.name]))

const pad = (v) => String(v).padStart(2, '0')
const clock = (ms) => { const m = istMinute(ms); return `${pad(Math.floor(m / 60))}:${pad(m % 60)}` }
const rupees = (v) => (Number.isFinite(v) ? `${v < 0 ? '−' : ''}₹${Math.round(Math.abs(v)).toLocaleString('en-IN')}` : '—')
const num = (v, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : '—')
const pnlColor = (v) => (v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined)
const runUrl = (u, date) => `/api/oi-replay/${u}/run?date=${date}&timeframeMinutes=1&expiryFlag=${u === 'BANKNIFTY' ? 'MONTH' : 'WEEK'}`

// The days prepared, for the tab's life (a past day never changes; a failed load is not kept - it is asked again next run).
const PREPARED = new Map()
const PREPARED_MAX = 150
function remember(key, day) {
  PREPARED.set(key, day)
  while (PREPARED.size > PREPARED_MAX) PREPARED.delete(PREPARED.keys().next().value)
}

async function loadDay(underlying, date, signal) {
  const key = `${underlying}|${date}`
  if (PREPARED.has(key)) return { day: PREPARED.get(key), cached: true }
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort('timeout'), LOAD_TIMEOUT_MS)
  const abort = () => timeout.abort('stopped')
  signal.addEventListener('abort', abort)
  try {
    const r = await fetch(runUrl(underlying, date), { signal: timeout.signal })
    const body = await r.json().catch(() => null)
    if (!r.ok || !body?.success) return { day: { ok: false, date, reason: body?.error ?? `HTTP ${r.status}` } }
    // Let the page draw the progress before the day's minutes are worked through.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const day = prepareDay(body, { underlying })
    const kept = day.ok ? day : { ok: false, date, reason: day.reason }
    remember(key, kept)
    return { day: kept }
  } catch (err) {
    if (signal.aborted) throw err
    return { day: { ok: false, date, reason: timeout.signal.aborted ? 'took too long to load' : String(err?.message ?? err) } }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

// The running net of each strategy (and all of them) at the end of each day.
function EquityChart({ lines, height = 280 }) {
  const ref = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(new Map())
  useEffect(() => {
    if (!ref.current) return undefined
    const chart = createZoomableChart(ref.current, {
      width: ref.current.clientWidth, height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR }, timeScale: { borderColor: BORDER_COLOR },
      handleScroll: { vertTouchDrag: false },
    })
    chartRef.current = chart
    const series = seriesRef.current
    const resize = new ResizeObserver(() => { if (ref.current) chart.applyOptions({ width: ref.current.clientWidth }) })
    resize.observe(ref.current)
    return () => { resize.disconnect(); chart.remove(); chartRef.current = null; series.clear() }
  }, [height])
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    for (const s of seriesRef.current.values()) chart.removeSeries(s)
    seriesRef.current.clear()
    for (const line of lines) {
      const s = chart.addSeries(LineSeries, { color: line.color, lineWidth: line.id === 'all' ? 3 : 2, title: line.name, priceLineVisible: false, priceFormat: { type: 'price', precision: 0, minMove: 1 } })
      s.setData(line.points)
      seriesRef.current.set(line.id, s)
    }
    chart.timeScale().fitContent()
  }, [lines])
  return <div ref={ref} style={{ width: '100%', height }} />
}

export default function SignalBacktestPage() {
  const [underlying, setUnderlying] = usePersistedState(STORE.underlying, 'NIFTY')
  const [range, setRange] = usePersistedState(STORE.range, [dayjs().subtract(14, 'day').format('YYYY-MM-DD'), dayjs().subtract(1, 'day').format('YYYY-MM-DD')])
  const [mode, setMode] = usePersistedState(STORE.mode, BACKTEST_DEFAULTS.mode)
  const [moneyness, setMoneyness] = usePersistedState(STORE.moneyness, BACKTEST_DEFAULTS.moneyness)
  const [slPct, setSlPct] = usePersistedState(STORE.slPct, BACKTEST_DEFAULTS.slPct)
  const [targetPct, setTargetPct] = usePersistedState(STORE.targetPct, BACKTEST_DEFAULTS.targetPct)
  const [timeStopMin, setTimeStopMin] = usePersistedState(STORE.timeStopMin, BACKTEST_DEFAULTS.timeStopMin)
  const [maxTradesPerDay, setMaxTradesPerDay] = usePersistedState(STORE.maxTradesPerDay, BACKTEST_DEFAULTS.maxTradesPerDay)
  const [cooldownMin, setCooldownMin] = usePersistedState(STORE.cooldownMin, BACKTEST_DEFAULTS.cooldownMin)
  const [lots, setLots] = usePersistedState(STORE.lots, BACKTEST_DEFAULTS.lots)
  const [charges, setCharges] = usePersistedState(STORE.charges, BACKTEST_DEFAULTS.charges)
  const [chosen, setChosen] = usePersistedState(STORE.strategies, SIGNAL_STRATEGY_IDS)
  const [voteThreshold, setVoteThreshold] = usePersistedState(STORE.voteThreshold, BACKTEST_DEFAULTS.voteThreshold)
  const [equityView, setEquityView] = usePersistedState(STORE.equity, 'each')
  const index = UNDERLYINGS.includes(underlying) ? underlying : 'NIFTY'
  const strategies = (Array.isArray(chosen) ? chosen : SIGNAL_STRATEGY_IDS).filter((id) => SIGNAL_STRATEGY_IDS.includes(id))
  const lotSize = PAPER_TRADE_LOT_SIZE[index] ?? 1

  // The run: the days asked for, each loaded and prepared in turn.
  const [run, setRun] = useState({ status: 'idle', underlying: null, dates: [], done: 0, current: null, results: [] })
  const abortRef = useRef(null)
  const dates = useMemo(() => backtestDays(range?.[0], range?.[1], dayjs().format('YYYY-MM-DD')), [range])
  const start = async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const u = index
    const list = dates
    setRun({ status: 'running', underlying: u, dates: list, done: 0, current: list[0] ?? null, results: [] })
    const results = []
    for (let k = 0; k < list.length; k++) {
      setRun((r) => ({ ...r, current: list[k], done: k }))
      try {
        const { day, cached } = await loadDay(u, list[k], controller.signal)
        results.push({ date: list[k], day, cached: Boolean(cached) })
      } catch {
        setRun((r) => ({ ...r, status: 'stopped', current: null, results: [...results] }))
        return
      }
      setRun((r) => ({ ...r, results: [...results] }))
    }
    setRun((r) => ({ ...r, status: 'done', done: list.length, current: null, results: [...results] }))
  }
  const stop = () => abortRef.current?.abort()
  useEffect(() => () => abortRef.current?.abort(), [])

  // The report - worked out again, in an instant, whenever a setting changes.
  const settings = useMemo(() => ({
    mode, moneyness, slPct, targetPct, timeStopMin, maxTradesPerDay, cooldownMin, lots, charges, strategies, voteThreshold,
    lotSize: PAPER_TRADE_LOT_SIZE[run.underlying] ?? lotSize,
  }), [mode, moneyness, slPct, targetPct, timeStopMin, maxTradesPerDay, cooldownMin, lots, charges, strategies, voteThreshold, lotSize, run.underlying])
  const report = useMemo(() => {
    const okDays = run.results.filter((r) => r.day?.ok)
    // Day by day in date order - the weighted vote learning each indicator's accuracy from the days before (simulateRun).
    const { trades, signals, accuracy } = simulateRun(okDays.map((r) => r.day), settings)
    const accuracyRows = INDICATORS.map((k) => ({ key: k.id, name: k.name, ...accuracy[k.id] }))
      .sort((a, b) => b.weight - a.weight || (b.accuracy ?? 0) - (a.accuracy ?? 0))
    const rows = SIGNAL_STRATEGIES.filter((s) => strategies.includes(s.id)).map((s) => ({
      key: s.id, id: s.id, name: s.name, signals: signals.filter((x) => x.strategy === s.id).length, ...summarize(trades.filter((t) => t.strategy === s.id)),
    })).sort((a, b) => (b.trades > 0) - (a.trades > 0) || b.net - a.net)   // the best first; those with no trade last
    const all = { key: 'all', id: 'all', name: 'All strategies', signals: signals.length, ...summarize(trades) }
    // Per day: each strategy's net.
    const dayRows = run.results.map((r) => {
      const dayTrades = trades.filter((t) => t.date === r.date)
      const row = { key: r.date, date: r.date, ok: r.day?.ok, reason: r.day?.reason ?? null, source: r.day?.priceSource ?? null, trades: dayTrades.length, net: dayTrades.reduce((a, t) => a + t.net, 0) }
      for (const s of SIGNAL_STRATEGY_IDS) row[s] = dayTrades.filter((t) => t.strategy === s).reduce((a, t) => a + t.net, 0)
      return row
    })
    // The running net at the end of each day.
    const lineOf = (id, name, color, pick) => {
      let total = 0
      return { id, name, color, points: okDays.map((r) => { total += pick(trades.filter((t) => t.date === r.date)); return { time: r.date, value: Math.round(total) } }) }
    }
    const lines = equityView === 'all'
      ? [lineOf('all', 'All', '#e6e6e6', (ts) => ts.reduce((a, t) => a + t.net, 0))]
      : rows.filter((s) => s.trades > 0).map((s) => lineOf(s.id, s.name, colorOf(s.id), (ts) => ts.filter((t) => t.strategy === s.id).reduce((a, t) => a + t.net, 0)))
    return { trades, rows, all, dayRows, lines, okDays: okDays.length, accuracyRows }
  }, [run.results, settings, strategies, equityView])

  const [tradeFilter, setTradeFilter] = useState('all')
  const shownTrades = useMemo(() => (tradeFilter === 'all' ? report.trades : report.trades.filter((t) => t.strategy === tradeFilter)), [report.trades, tradeFilter])
  const downloadCsv = () => {
    const blob = new Blob([tradesCsv(report.trades)], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `signal-backtest-${run.underlying ?? index}-${run.dates[0] ?? ''}-${run.dates.at(-1) ?? ''}-${mode}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const running = run.status === 'running'
  const failed = run.results.filter((r) => !r.day?.ok)
  const summaryColumns = [
    { title: 'Strategy', dataIndex: 'name', key: 'name', fixed: 'left', width: 200, render: (v, r) => (r.id === 'all' ? <Text strong>{v}</Text> : <Space size={6}><span style={{ width: 10, height: 10, borderRadius: 2, background: colorOf(r.id), display: 'inline-block' }} />{v}</Space>) },
    { title: 'Signals', dataIndex: 'signals', key: 'signals', width: 70, align: 'right' },
    { title: 'Trades', dataIndex: 'trades', key: 'trades', width: 70, align: 'right' },
    { title: 'Win %', dataIndex: 'winRate', key: 'winRate', width: 70, align: 'right', render: (v) => num(v, 0) },
    { title: 'Net P&L', dataIndex: 'net', key: 'net', width: 100, align: 'right', render: (v) => <Text strong style={{ color: pnlColor(v) }}>{rupees(v)}</Text> },
    { title: 'Points', dataIndex: 'points', key: 'points', width: 80, align: 'right', render: (v) => num(v) },
    { title: 'Avg win', dataIndex: 'avgWin', key: 'avgWin', width: 90, align: 'right', render: (v) => rupees(v) },
    { title: 'Avg loss', dataIndex: 'avgLoss', key: 'avgLoss', width: 90, align: 'right', render: (v) => rupees(v) },
    { title: 'Profit factor', dataIndex: 'profitFactor', key: 'pf', width: 90, align: 'right', render: (v) => (v === Infinity ? '∞' : num(v, 2)) },
    { title: 'Max drawdown', dataIndex: 'maxDrawdown', key: 'dd', width: 100, align: 'right', render: (v) => rupees(-v) },
    { title: 'Per trade', dataIndex: 'expectancy', key: 'exp', width: 90, align: 'right', render: (v) => <span style={{ color: pnlColor(v) }}>{rupees(v)}</span> },
    { title: 'Green days', key: 'days', width: 90, align: 'right', render: (_, r) => (r.days ? `${r.winningDays} / ${r.days}` : '—') },
    { title: 'Avg hold', dataIndex: 'avgHoldMin', key: 'hold', width: 80, align: 'right', render: (v) => (Number.isFinite(v) ? `${Math.round(v)} min` : '—') },
    { title: 'Charges', dataIndex: 'charges', key: 'charges', width: 90, align: 'right', render: (v) => rupees(v) },
  ]
  const dayColumns = [
    { title: 'Day', dataIndex: 'date', key: 'date', fixed: 'left', width: 110, render: (v) => dayjs(v).format('ddd D MMM') },
    { title: 'Trades', dataIndex: 'trades', key: 'trades', width: 70, align: 'right', render: (v, r) => (r.ok ? v : <Tooltip title={r.reason}><Tag style={{ margin: 0 }}>no data</Tag></Tooltip>) },
    { title: 'Net', dataIndex: 'net', key: 'net', width: 100, align: 'right', render: (v, r) => (r.ok ? <Text strong style={{ color: pnlColor(v) }}>{rupees(v)}</Text> : '') },
    ...SIGNAL_STRATEGIES.filter((s) => strategies.includes(s.id)).map((s) => ({
      title: s.name, dataIndex: s.id, key: s.id, width: 110, align: 'right', render: (v, r) => (r.ok && v ? <span style={{ color: pnlColor(v) }}>{rupees(v)}</span> : ''),
    })),
  ]
  const tradeColumns = [
    { title: 'Day', dataIndex: 'date', key: 'date', width: 100, render: (v) => dayjs(v).format('D MMM') },
    { title: 'Strategy', dataIndex: 'strategy', key: 'strategy', width: 150, render: (v) => <Space size={6}><span style={{ width: 8, height: 8, borderRadius: 2, background: colorOf(v), display: 'inline-block' }} />{nameOf[v]}</Space> },
    { title: 'Signal', dataIndex: 'dir', key: 'dir', width: 80, render: (v) => <Tag color={v > 0 ? 'green' : 'red'} style={{ margin: 0 }}>{v > 0 ? 'bullish' : 'bearish'}</Tag> },
    { title: 'Trade', key: 'trade', width: 130, render: (_, t) => <Text>{t.action} {t.strike} {t.side}</Text> },
    { title: 'Entry', key: 'entry', width: 110, render: (_, t) => `${clock(t.entryTime)} · ${num(t.entry, 2)}` },
    { title: 'Exit', key: 'exit', width: 110, render: (_, t) => `${clock(t.exitTime)} · ${num(t.exit, 2)}` },
    { title: 'Why out', dataIndex: 'exitReason', key: 'reason', width: 150 },
    { title: 'Points', dataIndex: 'points', key: 'points', width: 80, align: 'right', render: (v) => <span style={{ color: pnlColor(v) }}>{num(v, 2)}</span> },
    { title: 'Net', dataIndex: 'net', key: 'net', width: 90, align: 'right', render: (v) => <Text strong style={{ color: pnlColor(v) }}>{rupees(v)}</Text> },
    { title: 'Why in', dataIndex: 'why', key: 'why', width: 320, ellipsis: { showTitle: false }, render: (v) => <Tooltip title={v}><span>{v}</span></Tooltip> },
  ]

  return (
    <div style={{ padding: '16px 16px 32px' }}>
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>

        <Card size="small" title="Signal backtest - OI Replay and profile signals, past days">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Space wrap size={[12, 8]} align="center">
              <Segmented size="small" value={index} options={UNDERLYINGS} onChange={setUnderlying} disabled={running} />
              <DatePicker.RangePicker
                size="small" allowClear={false} disabled={running}
                value={[dayjs(range?.[0]), dayjs(range?.[1])]}
                disabledDate={(d) => !d.isBefore(dayjs(), 'day')}
                onChange={(v) => v && setRange([v[0].format('YYYY-MM-DD'), v[1].format('YYYY-MM-DD')])}
              />
              <Text type="secondary" style={{ fontSize: 12 }}>{dates.length} trading day{dates.length === 1 ? '' : 's'} (weekdays; at most {MAX_BACKTEST_DAYS})</Text>
              {running
                ? <Button size="small" danger icon={<StopOutlined />} onClick={stop}>Stop</Button>
                : <Button size="small" type="primary" icon={<PlayCircleOutlined />} onClick={start} disabled={!dates.length}>Run backtest</Button>}
            </Space>
            <Space wrap size={[16, 8]} align="center">
              <Tooltip title="BUY: a bullish signal buys the call, a bearish one the put. SELL: a bullish signal sells the put, a bearish one the call (premium collected).">
                <Segmented size="small" value={mode} onChange={setMode} options={[{ value: 'buy', label: 'Option BUY' }, { value: 'sell', label: 'Option SELL' }]} />
              </Tooltip>
              <Space size={4}>
                <Text type="secondary" style={{ fontSize: 12 }}>Strike</Text>
                <Select size="small" value={moneyness} onChange={setMoneyness} style={{ width: 100 }} options={[{ value: 0, label: 'ATM' }, { value: 1, label: '1 ITM' }, { value: -1, label: '1 OTM' }]} />
              </Space>
              <Tooltip title={mode === 'sell' ? 'Out when the premium RISES this much above the entry (sold).' : 'Out when the premium FALLS this much below the entry.'}>
                <Space size={4}><Text type="secondary" style={{ fontSize: 12 }}>SL</Text><InputNumber size="small" min={1} max={500} value={slPct} onChange={(v) => setSlPct(v ?? BACKTEST_DEFAULTS.slPct)} addonAfter="%" style={{ width: 100 }} /></Space>
              </Tooltip>
              <Tooltip title={mode === 'sell' ? 'Out when the premium FALLS this much (the decay kept).' : 'Out when the premium RISES this much.'}>
                <Space size={4}><Text type="secondary" style={{ fontSize: 12 }}>Target</Text><InputNumber size="small" min={1} max={1000} value={targetPct} onChange={(v) => setTargetPct(v ?? BACKTEST_DEFAULTS.targetPct)} addonAfter="%" style={{ width: 100 }} /></Space>
              </Tooltip>
              <Tooltip title="Out at the bar's close this many minutes after the entry (0 = off). Every trade is out by 15:10 anyway.">
                <Space size={4}><Text type="secondary" style={{ fontSize: 12 }}>Time stop</Text><InputNumber size="small" min={0} max={360} value={timeStopMin} onChange={(v) => setTimeStopMin(v ?? 0)} addonAfter="min" style={{ width: 110 }} /></Space>
              </Tooltip>
              <Tooltip title="Per strategy and day: at most this many trades, one open at a time, and this long after an exit before the next.">
                <Space size={4}>
                  <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>Max</Text><InputNumber size="small" min={1} max={20} value={maxTradesPerDay} onChange={(v) => setMaxTradesPerDay(v ?? BACKTEST_DEFAULTS.maxTradesPerDay)} style={{ width: 60 }} />
                  <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>a day · cooldown</Text><InputNumber size="small" min={0} max={120} value={cooldownMin} onChange={(v) => setCooldownMin(v ?? 0)} addonAfter="min" style={{ width: 100 }} />
                </Space>
              </Tooltip>
              <Space size={4}><Text type="secondary" style={{ fontSize: 12 }}>Lots</Text><InputNumber size="small" min={1} max={100} value={lots} onChange={(v) => setLots(v ?? 1)} style={{ width: 60 }} /><Text type="secondary" style={{ fontSize: 12 }}>× {lotSize}</Text></Space>
              <Tooltip title="Net of STT on the sell side, ₹20 brokerage an order and ₹7 other a trade (the scanner's default charges).">
                <Space size={4}><Switch size="small" checked={charges} onChange={setCharges} /><Text style={{ fontSize: 12 }}>Charges</Text></Space>
              </Tooltip>
            </Space>
            <Space wrap size={[12, 6]} align="center">
              <Tooltip title="The weighted vote: a signal when the votes, each weighted by its indicator's accuracy on the earlier days, add up to at least this share of all the weight one way. Lower = more signals.">
                <Space size={4}><Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>Weighted vote ≥</Text><InputNumber size="small" min={5} max={100} step={5} value={Math.round(voteThreshold * 100)} onChange={(v) => setVoteThreshold((v ?? 30) / 100)} addonAfter="%" style={{ width: 100 }} /></Space>
              </Tooltip>
            </Space>
            <Checkbox.Group
              value={strategies}
              onChange={(v) => setChosen(v.length ? v : SIGNAL_STRATEGY_IDS)}
              options={SIGNAL_STRATEGIES.map((s) => ({ value: s.id, label: <Tooltip title={s.rule}>{s.name}</Tooltip> }))}
            />
            {(running || run.status === 'stopped') && (
              <Space direction="vertical" size={2} style={{ width: '100%' }}>
                <Progress percent={run.dates.length ? Math.round((run.done / run.dates.length) * 100) : 0} size="small" status={run.status === 'stopped' ? 'exception' : 'active'} />
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {run.status === 'stopped' ? `Stopped after ${run.results.length} of ${run.dates.length} days.` : `Day ${run.done + 1} of ${run.dates.length}: ${run.current ? dayjs(run.current).format('ddd D MMM') : ''} - a day the server has not kept yet comes from Dhan once (up to a minute or two).`}
                </Text>
              </Space>
            )}
            <FoldText id="signalBacktest.how" label="how it works" className="oa-note">
              <Text type="secondary" style={{ fontSize: 12 }}>
                Each day is replayed minute by minute: a strategy&apos;s signal at a minute uses only what was known at the end of that minute
                (no look-ahead). Its trade enters at that minute&apos;s option close - BUY the call / put in the signal&apos;s direction, or SELL the put /
                call against it - and is managed from the next minute on the option&apos;s own 1-minute bars: a bar opening through the stop
                fills at its open, the stop before the target in the same bar, the time stop and the 15:10 square-off at the bar&apos;s close. No
                entries before 09:30 or after 14:45. Only the strikes OI Replay loads (ATM ± 10) and the near expiry. A condition that stays
                true signals once, on the minute it becomes true. Hover a strategy for its rule.
              </Text>
            </FoldText>
          </Space>
        </Card>

        {run.results.length > 0 && (
          <>
            {failed.length > 0 && (
              <Alert type="warning" showIcon message={`${failed.length} day${failed.length === 1 ? '' : 's'} not run`} description={failed.map((r) => `${dayjs(r.date).format('D MMM')}: ${r.day?.reason}`).join(' · ')} />
            )}
            <Card
              size="small"
              title={`${run.underlying} · ${report.okDays} day${report.okDays === 1 ? '' : 's'} · option ${mode === 'sell' ? 'SELL' : 'BUY'} · SL ${slPct}% · target ${targetPct}%`}
              extra={<Text strong style={{ color: pnlColor(report.all.net) }}>{rupees(report.all.net)} · {report.all.trades} trades · {num(report.all.winRate, 0)}% win</Text>}
            >
              <Table size="small" pagination={false} scroll={{ x: 1300 }} columns={summaryColumns} dataSource={[report.all, ...report.rows]} />
            </Card>
            <Card size="small" title="Indicator accuracy - who has the say in the weighted vote">
              <Table
                size="small" pagination={false} scroll={{ x: 560 }} dataSource={report.accuracyRows}
                columns={[
                  { title: 'Indicator', dataIndex: 'name', key: 'name', width: 170 },
                  { title: 'Right', dataIndex: 'right', key: 'right', width: 80, align: 'right' },
                  { title: 'Wrong', dataIndex: 'wrong', key: 'wrong', width: 80, align: 'right' },
                  { title: 'Accuracy', dataIndex: 'accuracy', key: 'accuracy', width: 90, align: 'right', render: (v) => (v == null ? '—' : <span style={{ color: v > 0.5 ? UP_COLOR : v < 0.5 ? DOWN_COLOR : undefined }}>{(v * 100).toFixed(1)}%</span>) },
                  { title: 'Weight', dataIndex: 'weight', key: 'weight', width: 140, render: (v) => <Space size={6}><div style={{ width: Math.round(Math.min(1, v * 2) * 80), height: 8, background: '#4096ff', borderRadius: 2 }} /><Text style={{ fontSize: 12 }}>{v > 0 ? (v * 100).toFixed(1) : 'no say'}</Text></Space> },
                ]}
              />
              <FoldText id="signalBacktest.accuracy" label="how it is measured" className="oa-note">
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Each indicator&apos;s direction every minute from 09:30, judged by where spot went over the next 15 minutes (a move under
                  0.05% counts neither way). Weight = how far its accuracy is above 50% (smoothed toward 50% while it has few votes) - an
                  indicator no better than a coin has no say. Shown over all the days run; each day itself was traded with the weights of
                  only the days BEFORE it (the first day: all equal), so a day is never weighted by its own outcome.
                </Text>
              </FoldText>
            </Card>
            <Card
              size="small" title="Running P&L, day by day"
              extra={<Segmented size="small" value={equityView} onChange={setEquityView} options={[{ value: 'each', label: 'Each strategy' }, { value: 'all', label: 'All together' }]} />}
            >
              <EquityChart lines={report.lines} />
            </Card>
            <Card size="small" title="Day by day">
              <Table size="small" pagination={false} scroll={{ x: 400 + 110 * strategies.length }} columns={dayColumns} dataSource={report.dayRows} />
            </Card>
            <Card
              size="small" title={`Trades (${shownTrades.length})`}
              extra={(
                <Space size={8}>
                  <Select size="small" value={tradeFilter} onChange={setTradeFilter} style={{ width: 190 }} options={[{ value: 'all', label: 'All strategies' }, ...SIGNAL_STRATEGIES.filter((s) => strategies.includes(s.id)).map((s) => ({ value: s.id, label: s.name }))]} />
                  <Button size="small" icon={<DownloadOutlined />} onClick={downloadCsv} disabled={!report.trades.length}>CSV</Button>
                </Space>
              )}
            >
              <Table size="small" rowKey={(t) => `${t.strategy}|${t.entryTime}`} scroll={{ x: 1300 }} columns={tradeColumns} dataSource={shownTrades} pagination={{ pageSize: 25, showSizeChanger: false }} />
            </Card>
          </>
        )}
      </Space>
    </div>
  )
}
