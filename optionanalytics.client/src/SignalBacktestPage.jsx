import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, DatePicker, InputNumber, Progress, Segmented, Select, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd'
import { CloseOutlined, DownloadOutlined, PlayCircleOutlined, PlusOutlined, StopOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { LineSeries } from 'lightweight-charts'
import { AXIS_COLOR, BORDER_COLOR, DOWN_COLOR, GRID_COLOR, NavBar, UP_COLOR, usePersistedState } from './shared.jsx'
import { createZoomableChart } from './chartZoom.js'
import { PAPER_TRADE_LOT_SIZE } from './scannerCore.js'
import {
  BACKTEST_DEFAULTS, MAX_BACKTEST_DAYS, RULE_ACTIONS, RULE_CONDITIONS, TIMEFRAMES, WINDOW_CHOICES, backtestDays, cleanLine, istMinute, mirrorIsSame, mirrorLines,
  normalizeRule, prepareDay, ruleText, simulateRun, summarize, tradesCsv,
} from './signalBacktest.js'
import { FoldText } from './FoldText.jsx'

// The SIGNAL BACKTEST page: pick an index and a range of past days and BUILD ONE RULE - lines of conditions (an indicator,
// what it says, its number and look-back) joined by AND / OR, the trade it makes and, optionally, its mirror; each day is loaded as OI
// Replay loads it (the server keeps past days on disk - a day never loaded before comes from Dhan once), replayed through
// the rule (signalBacktest.js - each signal from data up to its candle's close only) and every signal's option trade
// simulated; the report sums them for the rule, its mirror and both, per day and trade by trade. A day is prepared once
// and kept for the tab's life, so changing the rule, the timeframe or the stop / target re-runs at once with no new load.

const { Text, Title } = Typography
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX']
const LOAD_TIMEOUT_MS = 240_000
const STORE = {
  underlying: 'optionanalytics.signalBacktest.underlying',
  range: 'optionanalytics.signalBacktest.range',
  moneyness: 'optionanalytics.signalBacktest.moneyness',
  slPct: 'optionanalytics.signalBacktest.slPct',
  targetPct: 'optionanalytics.signalBacktest.targetPct',
  timeStopMin: 'optionanalytics.signalBacktest.timeStopMin',
  maxTradesPerDay: 'optionanalytics.signalBacktest.maxTradesPerDay',
  cooldownMin: 'optionanalytics.signalBacktest.cooldownMin',
  lots: 'optionanalytics.signalBacktest.lots',
  charges: 'optionanalytics.signalBacktest.charges',
  timeframe: 'optionanalytics.signalBacktest.timeframe',
  rule: 'optionanalytics.signalBacktest.rule',
}
const SIDE = { rule: { name: 'Rule', color: '#4096ff' }, mirror: { name: 'Mirror', color: '#fa8c16' }, all: { name: 'Both', color: '#e6e6e6' } }
const GROUPS = [...new Set(RULE_CONDITIONS.map((c) => c.group))]
const GROUP_TITLE = { OI: 'OI (OI Replay)', GEX: 'GEX', Price: 'Price', Straddle: 'ATM straddle', Profile: "Today's volume & market profile", PrevProfile: "Previous day's volume profile" }
const CONDITION_OF = Object.fromEntries(RULE_CONDITIONS.map((c) => [c.id, c]))
const OPPOSITE_ACTION = Object.fromEntries(RULE_ACTIONS.map((a) => [a.value, a.opposite]))
// The indicator dropdown: the conditions under their group's title.
const INDICATOR_OPTIONS = GROUPS.map((g) => ({ label: GROUP_TITLE[g] ?? g, options: RULE_CONDITIONS.filter((c) => c.group === g).map((c) => ({ value: c.id, label: c.name })) }))
const POPUP = { popup: { root: 'oa-rule-popup' } }
// A new line for condition `id`: its first value, that value's own number and window.
const freshLine = (id, join = 'and') => cleanLine({ id, value: CONDITION_OF[id].options[0].value, join })

const pad = (v) => String(v).padStart(2, '0')
const clock = (ms) => { const m = istMinute(ms); return `${pad(Math.floor(m / 60))}:${pad(m % 60)}` }
const rupees = (v) => (Number.isFinite(v) ? `${v < 0 ? '−' : ''}₹${Math.round(Math.abs(v)).toLocaleString('en-IN')}` : '—')
const num = (v, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : '—')
const pnlColor = (v) => (v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined)
const runUrl = (u, date) => `/api/oi-replay/${u}/run?date=${date}&timeframeMinutes=1&expiryFlag=${u === 'BANKNIFTY' ? 'MONTH' : 'WEEK'}`
// The previous trading day's volume profile (spot's POC / VAH / VAL / HVN / LVN - OI Replay's entry chart lines).
const prevProfileUrl = (u, date) => `/api/oi-replay/${u}/previous-day-volume-profile?date=${date}`

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
    // The previous day's profile alongside the run - a day without one still runs (its previous-day lines never hold).
    const prevPromise = fetch(prevProfileUrl(underlying, date), { signal: timeout.signal }).then((x) => (x.ok ? x.json() : null)).catch(() => null)
    const r = await fetch(runUrl(underlying, date), { signal: timeout.signal })
    const body = await r.json().catch(() => null)
    if (!r.ok || !body?.success) return { day: { ok: false, date, reason: body?.error ?? `HTTP ${r.status}` } }
    // Let the page draw the progress before the day's minutes are worked through.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const day = prepareDay(body, { underlying, prevProfile: await prevPromise })
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

// The running net of the rule, its mirror and both at the end of each day.
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
  const [moneyness, setMoneyness] = usePersistedState(STORE.moneyness, BACKTEST_DEFAULTS.moneyness)
  const [slPct, setSlPct] = usePersistedState(STORE.slPct, BACKTEST_DEFAULTS.slPct)
  const [targetPct, setTargetPct] = usePersistedState(STORE.targetPct, BACKTEST_DEFAULTS.targetPct)
  const [timeStopMin, setTimeStopMin] = usePersistedState(STORE.timeStopMin, BACKTEST_DEFAULTS.timeStopMin)
  const [maxTradesPerDay, setMaxTradesPerDay] = usePersistedState(STORE.maxTradesPerDay, BACKTEST_DEFAULTS.maxTradesPerDay)
  const [cooldownMin, setCooldownMin] = usePersistedState(STORE.cooldownMin, BACKTEST_DEFAULTS.cooldownMin)
  const [lots, setLots] = usePersistedState(STORE.lots, BACKTEST_DEFAULTS.lots)
  const [charges, setCharges] = usePersistedState(STORE.charges, BACKTEST_DEFAULTS.charges)
  const [storedTimeframe, setTimeframe] = usePersistedState(STORE.timeframe, BACKTEST_DEFAULTS.timeframe)
  const timeframe = TIMEFRAMES.includes(storedTimeframe) ? storedTimeframe : BACKTEST_DEFAULTS.timeframe
  const [storedRule, setStoredRule] = usePersistedState(STORE.rule, BACKTEST_DEFAULTS.rule)
  const rule = useMemo(() => normalizeRule(storedRule), [storedRule])
  const setRule = (change) => setStoredRule({ ...rule, ...change })
  const setLine = (k, change) => setRule({
    lines: rule.lines.map((line, j) => {
      if (j !== k) return line
      const next = { ...line, ...change }
      // A new value keeps the number only when it is the same kind of number.
      if (change.value) {
        const before = CONDITION_OF[line.id].options.find((o) => o.value === line.value)
        const after = CONDITION_OF[line.id].options.find((o) => o.value === change.value)
        if (before?.param?.label !== after?.param?.label) delete next.param
      }
      return cleanLine(next) ?? line
    }),
  })
  const addLine = () => {
    const unused = RULE_CONDITIONS.find((c) => !rule.lines.some((l) => l.id === c.id)) ?? RULE_CONDITIONS[0]
    setRule({ lines: [...rule.lines, freshLine(unused.id)] })
  }
  const removeLine = (k) => setRule({ lines: rule.lines.filter((_, j) => j !== k) })
  const hasLines = rule.lines.length > 0
  const mirrorSame = hasLines && mirrorIsSame(rule.lines)
  const mirrorOn = rule.mirror && !mirrorSame
  const index = UNDERLYINGS.includes(underlying) ? underlying : 'NIFTY'
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

  // The report - worked out again, in an instant, whenever a setting or the rule changes.
  const settings = useMemo(() => ({
    rule, moneyness, slPct, targetPct, timeStopMin, maxTradesPerDay, cooldownMin, lots, charges, timeframe,
    lotSize: PAPER_TRADE_LOT_SIZE[run.underlying] ?? lotSize,
  }), [rule, moneyness, slPct, targetPct, timeStopMin, maxTradesPerDay, cooldownMin, lots, charges, timeframe, lotSize, run.underlying])
  const report = useMemo(() => {
    const okDays = run.results.filter((r) => r.day?.ok)
    const { trades, signals } = simulateRun(okDays.map((r) => r.day), settings)
    const sides = mirrorOn ? ['rule', 'mirror'] : ['rule']
    const rows = sides.map((id) => ({
      key: id, id, name: SIDE[id].name, what: ruleText(id === 'mirror' ? mirrorLines(rule.lines) : rule.lines, id === 'mirror' ? OPPOSITE_ACTION[rule.action] : rule.action),
      signals: signals.filter((x) => x.strategy === id).length, ...summarize(trades.filter((t) => t.strategy === id)),
    }))
    const all = { key: 'all', id: 'all', name: SIDE.all.name, what: 'the rule and its mirror together', signals: signals.length, ...summarize(trades) }
    const dayRows = run.results.map((r) => {
      const dayTrades = trades.filter((t) => t.date === r.date)
      const row = { key: r.date, date: r.date, ok: r.day?.ok, reason: r.day?.reason ?? null, trades: dayTrades.length, net: dayTrades.reduce((a, t) => a + t.net, 0) }
      for (const id of sides) row[id] = dayTrades.filter((t) => t.strategy === id).reduce((a, t) => a + t.net, 0)
      return row
    })
    // The running net at the end of each day.
    const lineOf = (id, pick) => {
      let total = 0
      return { id, name: SIDE[id].name, color: SIDE[id].color, points: okDays.map((r) => { total += pick(trades.filter((t) => t.date === r.date)); return { time: r.date, value: Math.round(total) } }) }
    }
    const lines = [
      ...(mirrorOn ? sides.map((id) => lineOf(id, (ts) => ts.filter((t) => t.strategy === id).reduce((a, t) => a + t.net, 0))) : []),
      lineOf('all', (ts) => ts.reduce((a, t) => a + t.net, 0)),
    ]
    return { trades, rows, all, dayRows, lines, okDays: okDays.length, sides }
  }, [run.results, settings, mirrorOn, rule])

  const [tradeFilter, setTradeFilter] = useState('all')
  const shownTrades = useMemo(() => (tradeFilter === 'all' ? report.trades : report.trades.filter((t) => t.strategy === tradeFilter)), [report.trades, tradeFilter])
  const downloadCsv = () => {
    const blob = new Blob([tradesCsv(report.trades)], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `signal-backtest-${run.underlying ?? index}-${run.dates[0] ?? ''}-${run.dates.at(-1) ?? ''}-${rule.action}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const running = run.status === 'running'
  const failed = run.results.filter((r) => !r.day?.ok)
  // Days run without the previous day's volume profile, when the rule reads it.
  const noPrev = rule.lines.some((l) => CONDITION_OF[l.id]?.group === 'PrevProfile') ? run.results.filter((r) => r.day?.ok && !r.day.prevVp) : []
  const sideTag = (id) => <Space size={6}><span style={{ width: 10, height: 10, borderRadius: 2, background: SIDE[id].color, display: 'inline-block' }} />{SIDE[id].name}</Space>
  const summaryColumns = [
    { title: '', dataIndex: 'name', key: 'name', fixed: 'left', width: 100, render: (v, r) => (r.id === 'all' ? <Text strong>{v}</Text> : <Tooltip title={r.what}>{sideTag(r.id)}</Tooltip>) },
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
    ...(report.sides.length > 1 ? report.sides.map((id) => ({
      title: SIDE[id].name, dataIndex: id, key: id, width: 100, align: 'right', render: (v, r) => (r.ok && v ? <span style={{ color: pnlColor(v) }}>{rupees(v)}</span> : ''),
    })) : []),
  ]
  const tradeColumns = [
    { title: 'Day', dataIndex: 'date', key: 'date', width: 100, render: (v) => dayjs(v).format('D MMM') },
    ...(report.sides.length > 1 ? [{ title: 'From', dataIndex: 'strategy', key: 'strategy', width: 90, render: (v) => sideTag(v) }] : []),
    { title: 'Signal', dataIndex: 'dir', key: 'dir', width: 80, render: (v) => <Tag color={v > 0 ? 'green' : 'red'} style={{ margin: 0 }}>{v > 0 ? 'bullish' : 'bearish'}</Tag> },
    { title: 'Trade', key: 'trade', width: 130, render: (_, t) => <Text>{t.action} {t.strike} {t.side}</Text> },
    { title: 'Entry', key: 'entry', width: 110, render: (_, t) => `${clock(t.entryTime)} · ${num(t.entry, 2)}` },
    { title: 'Exit', key: 'exit', width: 110, render: (_, t) => `${clock(t.exitTime)} · ${num(t.exit, 2)}` },
    { title: 'Why out', dataIndex: 'exitReason', key: 'reason', width: 150 },
    { title: 'Points', dataIndex: 'points', key: 'points', width: 80, align: 'right', render: (v) => <span style={{ color: pnlColor(v) }}>{num(v, 2)}</span> },
    { title: 'Net', dataIndex: 'net', key: 'net', width: 90, align: 'right', render: (v) => <Text strong style={{ color: pnlColor(v) }}>{rupees(v)}</Text> },
    { title: 'At the signal', dataIndex: 'why', key: 'why', width: 360, ellipsis: { showTitle: false }, render: (v) => <Tooltip title={v}><span>{v}</span></Tooltip> },
  ]
  const head = report.okDays ? `${run.underlying} · ${report.okDays} day${report.okDays === 1 ? '' : 's'} · ${timeframe}m candles · SL ${slPct}% · target ${targetPct}%` : ''

  return (
    <div style={{ padding: '16px 16px 32px' }}>
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>

        <Card size="small" title="Signal backtest - your rule over past days">
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

            <div className="oa-rule">
              <Space wrap size={[12, 8]} align="center" style={{ marginBottom: 8 }}>
                <Text strong>The rule</Text>
                <Text type="secondary" style={{ fontSize: 12 }}>read at each completed {timeframe}m candle - AND binds tighter than OR: A AND B OR C = (A AND B) OR C</Text>
              </Space>
              <div className="oa-rule-lines">
                {rule.lines.map((line, k) => {
                  const c = CONDITION_OF[line.id]
                  const o = c.options.find((x) => x.value === line.value)
                  return (
                    <div key={k} className={`oa-rule-line${k > 0 && line.join === 'or' ? ' oa-rule-line--or' : ''}`}>
                      <div className="oa-rule-join">
                        {k === 0
                          ? <Text strong style={{ fontSize: 12 }}>IF</Text>
                          : <Segmented size="small" value={line.join} onChange={(v) => setLine(k, { join: v })} options={[{ value: 'and', label: 'AND' }, { value: 'or', label: 'OR' }]} />}
                      </div>
                      <Select size="small" className="oa-rule-ind" value={line.id} onChange={(id) => setRule({ lines: rule.lines.map((l, j) => (j === k ? freshLine(id, l.join) : l)) })} options={INDICATOR_OPTIONS} popupMatchSelectWidth={false} classNames={POPUP} />
                      <Select size="small" className="oa-rule-val" value={line.value} onChange={(v) => setLine(k, { value: v })} options={c.options.map((x) => ({ value: x.value, label: x.label }))} popupMatchSelectWidth={false} classNames={POPUP} />
                      {o.param && (
                        <InputNumber
                          size="small" className="oa-rule-num" min={o.param.min} max={o.param.max} step={o.param.step} value={line.param}
                          onChange={(v) => setLine(k, { param: v ?? o.param.default })} addonBefore={o.param.label} addonAfter={o.param.unit}
                        />
                      )}
                      {o.windowed && (
                        <Select size="small" className="oa-rule-win" value={line.windowMin} onChange={(v) => setLine(k, { windowMin: v })} options={WINDOW_CHOICES.map((m) => ({ value: m, label: `last ${m} min` }))} />
                      )}
                      <Button size="small" type="text" icon={<CloseOutlined />} onClick={() => removeLine(k)} aria-label="Remove this condition" title="Remove" />
                    </div>
                  )
                })}
              </div>
              <Space wrap size={[8, 8]} style={{ marginTop: 8, display: 'flex' }}>
                <Button size="small" icon={<PlusOutlined />} onClick={addLine}>Add condition</Button>
                <Button size="small" onClick={() => setRule({ lines: [] })} disabled={!hasLines}>Clear all</Button>
              </Space>
              <Space wrap size={[16, 8]} align="center" style={{ marginTop: 10 }}>
                <Space size={4}>
                  <Text strong style={{ fontSize: 12 }}>Then</Text>
                  <Select size="small" value={rule.action} onChange={(v) => setRule({ action: v })} style={{ width: 100 }} options={RULE_ACTIONS.map((a) => ({ value: a.value, label: a.label }))} />
                </Space>
                <Tooltip title="Also trade the mirror: every line the other way (above ↔ below, support ↔ resistance, rising ↔ falling; GEX regime, the straddle, 'inside' and 'stable' stay as they are) - numbers, windows and AND / OR kept - and the opposite trade.">
                  <Space size={4}><Switch size="small" checked={rule.mirror} onChange={(v) => setRule({ mirror: v })} /><Text style={{ fontSize: 12 }}>Mirror (other side)</Text></Space>
                </Tooltip>
              </Space>
              <div style={{ marginTop: 8 }}>
                {hasLines
                  ? <Text style={{ fontSize: 12 }}><span style={{ color: SIDE.rule.color }}>■</span> {ruleText(rule.lines, rule.action)}</Text>
                  : <Alert type="info" showIcon message="Add a condition - with none the rule never signals." style={{ padding: '4px 10px' }} />}
                {hasLines && rule.mirror && (mirrorSame
                  ? <div><Text type="secondary" style={{ fontSize: 12 }}>No mirror: none of these lines has a side (add one that does - e.g. VWAP, OI, a wall).</Text></div>
                  : <div><Text style={{ fontSize: 12 }}><span style={{ color: SIDE.mirror.color }}>■</span> {ruleText(mirrorLines(rule.lines), OPPOSITE_ACTION[rule.action])}</Text></div>)}
              </div>
            </div>

            <Space wrap size={[16, 8]} align="center">
              <Tooltip title="The candles the rule reads: a signal only at a completed candle's close (candles from 09:15; the OI totals' breaks on buckets of the same size). Longer = fewer, steadier signals. The trade is still managed on the option's 1-minute bars.">
                <Space size={4}>
                  <Text type="secondary" style={{ fontSize: 12 }}>Timeframe</Text>
                  <Segmented size="small" value={timeframe} onChange={setTimeframe} options={TIMEFRAMES.map((m) => ({ value: m, label: `${m}m` }))} />
                </Space>
              </Tooltip>
              <Space size={4}>
                <Text type="secondary" style={{ fontSize: 12 }}>Strike</Text>
                <Select size="small" value={moneyness} onChange={setMoneyness} style={{ width: 100 }} options={[{ value: 0, label: 'ATM' }, { value: 1, label: '1 ITM' }, { value: -1, label: '1 OTM' }]} />
              </Space>
              <Tooltip title="Bought: out when the premium FALLS this much below the entry. Sold: out when it RISES this much above it.">
                <Space size={4}><Text type="secondary" style={{ fontSize: 12 }}>SL</Text><InputNumber size="small" min={1} max={500} value={slPct} onChange={(v) => setSlPct(v ?? BACKTEST_DEFAULTS.slPct)} addonAfter="%" style={{ width: 100 }} /></Space>
              </Tooltip>
              <Tooltip title="Bought: out when the premium RISES this much. Sold: out when it FALLS this much (the decay kept).">
                <Space size={4}><Text type="secondary" style={{ fontSize: 12 }}>Target</Text><InputNumber size="small" min={1} max={1000} value={targetPct} onChange={(v) => setTargetPct(v ?? BACKTEST_DEFAULTS.targetPct)} addonAfter="%" style={{ width: 100 }} /></Space>
              </Tooltip>
              <Tooltip title="Out at the bar's close this many minutes after the entry (0 = off). Every trade is out by 15:10 anyway.">
                <Space size={4}><Text type="secondary" style={{ fontSize: 12 }}>Time stop</Text><InputNumber size="small" min={0} max={360} value={timeStopMin} onChange={(v) => setTimeStopMin(v ?? 0)} addonAfter="min" style={{ width: 110 }} /></Space>
              </Tooltip>
              <Tooltip title="A day: at most this many trades (the rule and its mirror together), one open at a time, and this long after an exit before the next.">
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
                Build ONE rule from lines: each line is what an indicator says on the OI Replay or Volume & Market Profile page, with its
                number (a threshold %) and how far back it looks (crossed, turned, broke, near, a 🎯, spot&apos;s move - &quot;last N min&quot;; a
                cross / turn / break must still hold now), joined by AND / OR - AND first: A AND B OR C = (A AND B) OR C. The rule signals
                at a completed candle of the Timeframe (from 09:15) where it holds - once, when it becomes true (it has to stop holding
                before it signals again). The Mirror adds the same rule the other way round with the opposite trade. A signal uses only what was known at its candle&apos;s close - the end of its last minute (no look-ahead),
                and the times shown are that last minute (a 5m candle from 10:30 signals at 10:34). Its trade enters at that minute&apos;s
                option close and is managed from the next minute on the option&apos;s own 1-minute bars: a bar opening through the stop fills
                at its open, the stop before the target in the same bar, the time stop and the 15:10 square-off at the bar&apos;s close. No
                entries before 09:30 or after 14:45. Only the strikes OI Replay loads (ATM ± 10) and the near expiry. Change the rule after a
                run and the report follows at once - nothing is loaded again.
              </Text>
            </FoldText>
          </Space>
        </Card>

        {run.results.length > 0 && (
          <>
            {failed.length > 0 && (
              <Alert type="warning" showIcon message={`${failed.length} day${failed.length === 1 ? '' : 's'} not run`} description={failed.map((r) => `${dayjs(r.date).format('D MMM')}: ${r.day?.reason}`).join(' · ')} />
            )}
            {noPrev.length > 0 && (
              <Alert
                type="info" showIcon message={`No previous day's volume profile for ${noPrev.length} day${noPrev.length === 1 ? '' : 's'} - the rule's previous-day lines never hold on ${noPrev.length === 1 ? 'it' : 'them'}`}
                description={`${noPrev.map((r) => dayjs(r.date).format('D MMM')).join(' · ')} (the index has volume from January 2026 on).`}
              />
            )}
            <Card
              size="small" title={head}
              extra={<Text strong style={{ color: pnlColor(report.all.net) }}>{rupees(report.all.net)} · {report.all.trades} trades · {num(report.all.winRate, 0)}% win</Text>}
            >
              <Table size="small" pagination={false} scroll={{ x: 1200 }} columns={summaryColumns} dataSource={report.sides.length > 1 ? [report.all, ...report.rows] : report.rows} />
            </Card>
            <Card size="small" title="Running P&L, day by day">
              <EquityChart lines={report.lines} />
            </Card>
            <Card size="small" title="Day by day">
              <Table size="small" pagination={false} scroll={{ x: 300 + 100 * report.sides.length }} columns={dayColumns} dataSource={report.dayRows} />
            </Card>
            <Card
              size="small" title={`Trades (${shownTrades.length})`}
              extra={(
                <Space size={8}>
                  {report.sides.length > 1 && (
                    <Select size="small" value={tradeFilter} onChange={setTradeFilter} style={{ width: 120 }} options={[{ value: 'all', label: 'Both' }, { value: 'rule', label: 'Rule' }, { value: 'mirror', label: 'Mirror' }]} />
                  )}
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
