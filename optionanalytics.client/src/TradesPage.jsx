import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Col, DatePicker, Row, Segmented, Select, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { NavBar, UP_COLOR, DOWN_COLOR } from './shared.jsx'
import { STRATEGY_BY_ID } from './strategyEngine.js'

const { Title, Text } = Typography
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX']
const num = (v) => (v == null || v === '' ? null : Number(v))
const f1 = (v) => (v == null || !Number.isFinite(v) ? '-' : v.toFixed(1))
const pts = (v) => (v == null || !Number.isFinite(v) ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}`)
const fmtR = (v) => (v == null || !Number.isFinite(v) ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`)
const col = (v) => (v == null || !Number.isFinite(v) ? undefined : v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined)
const ist = (ms) => (ms ? new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit' }) : '-')
const hhmm = (s) => (s ? String(s).slice(11, 16) : '-') // "yyyy-MM-dd HH:mm:ss" (IST) -> HH:mm
const sideTag = (s) => <span style={{ color: s === 'LONG' ? UP_COLOR : DOWN_COLOR }}>{s}</span>

/** Rows -> a CSV file the browser saves. */
function downloadCsv(name, columns, rows) {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const text = [columns.map((c) => c.title).join(','), ...rows.map((r) => columns.map((c) => esc(c.value(r))).join(','))].join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

/** Totals over the rows shown: trades, wins / losses, win %, net points (and R when there is one). */
function Totals({ rows, points, r, extra }) {
  const p = rows.map(points).filter(Number.isFinite)
  const rs = r ? rows.map(r).filter(Number.isFinite) : []
  const wins = p.filter((x) => x > 0).length
  const losses = p.filter((x) => x < 0).length
  const net = p.reduce((a, b) => a + b, 0)
  const captured = p.filter((x) => x > 0).reduce((a, b) => a + b, 0)
  const lost = p.filter((x) => x < 0).reduce((a, b) => a + b, 0)
  return (
    <Space size={16} wrap style={{ fontSize: 13 }}>
      <span><b>{rows.length}</b> trades</span>
      <span>{wins}W / {losses}L{p.length ? ` · win ${Math.round((wins / p.length) * 100)}%` : ''}</span>
      <span>captured <b style={{ color: UP_COLOR }}>{pts(captured)}</b></span>
      <span>lost <b style={{ color: DOWN_COLOR }}>{pts(lost)}</b></span>
      <span>net <b style={{ color: col(net) }}>{pts(net)}</b> pts</span>
      {rs.length > 0 && <span>total <b style={{ color: col(rs.reduce((a, b) => a + b, 0)) }}>{fmtR(rs.reduce((a, b) => a + b, 0))}</b></span>}
      {extra}
    </Space>
  )
}

const inDates = (date, range) => (!range?.[0] || date >= range[0].format('YYYY-MM-DD')) && (!range?.[1] || date <= range[1].format('YYYY-MM-DD'))
const strategyOptions = (rows, idOf, label) => [...new Map(rows.map((r) => [idOf(r), label(r)])).entries()].filter(([id]) => id).sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'en', { numeric: true })).map(([value, l]) => ({ value, label: l }))

// ---- Backtest: every trade of the latest tuning run ---------------------------------------------------------------
function BacktestTrades() {
  const [underlying, setUnderlying] = useState('NIFTY')
  const [data, setData] = useState('futures')
  const [body, setBody] = useState(null)
  const [error, setError] = useState(null)
  const [setting, setSetting] = useState('as written')
  const [ids, setIds] = useState([])
  const [side, setSide] = useState('all')
  const [outcome, setOutcome] = useState('all')
  const [range, setRange] = useState(null)
  // A new index / data mode: clear what was shown, then load its trades.
  const reset = (fn) => (v) => { setBody(null); setError(null); setIds([]); fn(v) }
  useEffect(() => {
    fetch(`/api/strategy-tuning/trades/${underlying}${data === 'spot' ? '?data=spot' : ''}`)
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`))))
      .then(setBody).catch((e) => setError(e.message))
  }, [underlying, data])
  const all = useMemo(() => body?.trades ?? [], [body])
  const rows = useMemo(() => all.filter((t) => (setting === 'all' || t.setting === setting) && (!ids.length || ids.includes(t.id))
    && (side === 'all' || t.side === side) && (outcome === 'all' || (outcome === 'win' ? t.points > 0 : outcome === 'loss' ? t.points < 0 : t.stopHit))
    && inDates(t.date, range)).sort((a, b) => b.t - a.t), [all, setting, ids, side, outcome, range])
  const priceLabel = data === 'spot' ? 'Index' : 'Futures'
  const csvColumns = [
    { title: 'date', value: (t) => t.date }, { title: 'entry_time_ist', value: (t) => ist(t.t) }, { title: 'exit_time_ist', value: (t) => (t.exitT ? ist(t.exitT) : 'day end') },
    { title: 'index', value: (t) => t.index }, { title: 'strategy_no', value: (t) => t.no }, { title: 'strategy', value: (t) => t.name }, { title: 'setting', value: (t) => t.setting === 'best' ? `best: ${t.settingText}` : 'as written' },
    { title: 'side', value: (t) => t.side }, { title: 'entry', value: (t) => t.entry }, { title: 'stop', value: (t) => t.stop }, { title: 'target', value: (t) => t.target },
    { title: 'exit', value: (t) => t.exit }, { title: 'closed_by', value: (t) => t.exitReason }, { title: 'points', value: (t) => t.points?.toFixed(2) }, { title: 'r', value: (t) => t.r?.toFixed(3) },
    { title: 'option_bought', value: (t) => t.buy ? `${t.buy.label} ${f1(t.buy.entry)}->${f1(t.buy.exit)}` : '' }, { title: 'bought_points', value: (t) => t.buy?.points?.toFixed(2) ?? '' },
    { title: 'option_sold', value: (t) => t.sell ? `${t.sell.label} ${f1(t.sell.entry)}->${f1(t.sell.exit)}` : '' }, { title: 'sold_points', value: (t) => t.sell?.points?.toFixed(2) ?? '' },
    { title: 'estimated_day', value: (t) => (t.estimated ? 'yes' : '') },
  ]
  const leg = (l) => (l ? <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{l.label} {f1(l.entry)} → {l.exit == null ? '?' : f1(l.exit)} <b style={{ color: col(l.points) }}>{pts(l.points)}</b></span> : <Text type="secondary">-</Text>)
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Row gutter={[12, 8]} align="middle">
        <Col><Select value={underlying} onChange={reset(setUnderlying)} options={UNDERLYINGS.map((u) => ({ value: u, label: u }))} style={{ width: 130 }} /></Col>
        <Col><Segmented value={data} onChange={reset(setData)} options={[{ value: 'futures', label: 'Futures + OI' }, { value: 'spot', label: 'Spot + options' }]} /></Col>
        <Col><Segmented value={setting} onChange={setSetting} options={[{ value: 'as written', label: <Tooltip title="Every strategy with its rules as written, on every day the run scanned">As written</Tooltip> }, { value: 'best', label: <Tooltip title="The tuned strategies with their best setting">Best setting</Tooltip> }, { value: 'all', label: 'Both' }]} /></Col>
        <Col flex="1 1 260px"><Select mode="multiple" allowClear value={ids} onChange={setIds} placeholder="All strategies" style={{ width: '100%' }} maxTagCount="responsive" options={strategyOptions(all, (t) => t.id, (t) => `#${t.no} ${t.name}`)} /></Col>
        <Col><Segmented value={side} onChange={setSide} options={[{ value: 'all', label: 'Both sides' }, { value: 'LONG', label: 'Long' }, { value: 'SHORT', label: 'Short' }]} /></Col>
        <Col><Segmented value={outcome} onChange={setOutcome} options={[{ value: 'all', label: 'All' }, { value: 'win', label: 'Winners' }, { value: 'loss', label: 'Losers' }, { value: 'sl', label: 'SL hit' }]} /></Col>
        <Col><DatePicker.RangePicker value={range} onChange={setRange} format="DD MMM YYYY" allowEmpty={[true, true]} /></Col>
        <Col><Button onClick={() => downloadCsv(`${underlying}${data === 'spot' ? '-spot' : ''}-backtest-trades.csv`, csvColumns, rows)} disabled={!rows.length}>Download CSV</Button></Col>
      </Row>
      {error && <Alert type="info" showIcon message={error} />}
      {body && (
        <>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Tuning run of {new Date(body.finishedUtc).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })} ·
            {' '}{body.days?.length ?? 0} day(s) scanned ({body.days?.at(-1)?.date} to {body.days?.[0]?.date}){body.days?.some((d) => d.estimated) ? `, ${body.days.filter((d) => d.estimated).length} estimated from 1-minute candles` : ''}
            {body.skipped?.length ? ` · ${body.skipped.length} day(s) could not be scanned` : ''}. Each trade is taken exactly as the scanner would: first per cooldown, its stop / target / trailing stop on the minute bars, the 15:10 square-off.
          </Text>
          {body.skipped?.length > 0 && <Alert type="warning" showIcon message={`${body.skipped.length} day(s) skipped`} description={body.skipped.map((s) => `${s.date}: ${s.reason}`).join(' · ')} />}
          <Totals rows={rows} points={(t) => t.points} r={(t) => t.r} />
          <Table size="small" rowKey={(t) => `${t.setting}-${t.id}-${t.date}-${t.t}`} dataSource={rows} pagination={{ pageSize: 50, size: 'small', showSizeChanger: true, pageSizeOptions: [50, 100, 500] }} scroll={{ x: 1500 }}
            expandable={{ rowExpandable: (t) => !!t.checks, expandedRowRender: (t) => (
              <Space direction="vertical" size={2} style={{ fontSize: 12 }}>
                {t.setting === 'best' && <Text style={{ fontSize: 12 }}><b>Setting:</b> {t.settingText}</Text>}
                {Object.entries(t.checks ?? {}).map(([k, v]) => <Text key={k} style={{ fontSize: 12 }}><b>{k}:</b> {String(v)}</Text>)}
              </Space>
            ) }}
            columns={[
              { title: 'Date', dataIndex: 'date', width: 105, fixed: 'left' },
              { title: 'In → out (IST)', key: 'time', width: 120, render: (_, t) => `${ist(t.t)} → ${t.exitT ? ist(t.exitT) : 'end'}` },
              { title: 'Index', dataIndex: 'index', width: 90 },
              { title: 'Strategy', key: 's', width: 220, render: (_, t) => <span style={{ fontSize: 12 }}>#{t.no} {t.name}{t.setting === 'best' && <Tag color="blue" style={{ marginLeft: 4 }}>best</Tag>}{t.estimated && <Tooltip title="A day rebuilt from 1-minute candles (no tape / depth)"><Tag style={{ marginLeft: 4 }}>est.</Tag></Tooltip>}</span> },
              { title: 'Side', dataIndex: 'side', width: 70, render: sideTag },
              { title: `${priceLabel} in`, dataIndex: 'entry', width: 90, render: f1 },
              { title: 'SL', dataIndex: 'stop', width: 90, render: (v, t) => <span style={{ fontSize: 12 }}>{f1(v)}<br /><Text type="secondary" style={{ fontSize: 11 }}>{f1(t.slPts)} pts{t.trailed ? ` · trailed ${f1(t.finalStop)}` : ''}</Text></span> },
              { title: 'Target', dataIndex: 'target', width: 90, render: (v, t) => <span style={{ fontSize: 12 }}>{f1(v)}<br /><Text type="secondary" style={{ fontSize: 11 }}>{f1(t.targetPts)} pts</Text></span> },
              { title: `${priceLabel} out`, dataIndex: 'exit', width: 90, render: f1 },
              { title: 'Closed by', dataIndex: 'exitReason', width: 105 },
              { title: 'Points', dataIndex: 'points', width: 80, sorter: (a, b) => a.points - b.points, render: (v) => <b style={{ color: col(v) }}>{pts(v)}</b> },
              { title: 'R', dataIndex: 'r', width: 75, sorter: (a, b) => a.r - b.r, render: (v) => <span style={{ color: col(v) }}>{fmtR(v)}</span> },
              { title: 'Option bought: in → out', key: 'b', width: 230, render: (_, t) => leg(t.buy) },
              { title: 'Option sold: in → out', key: 'sl', width: 230, render: (_, t) => leg(t.sell) },
            ]} />
        </>
      )}
    </Space>
  )
}

// ---- The scanner's record: its signals (futures trades) and option trades, live and paper -----------------------
function ScannerRecord() {
  const [source, setSource] = useState('server')
  const [kind, setKind] = useState('signals')
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [underlying, setUnderlying] = useState('all')
  const [ids, setIds] = useState([])
  const [mode, setMode] = useState('all')
  const [range, setRange] = useState(null)
  const file = `${source === 'server' ? 'server-' : ''}${kind}`
  const reset = (fn) => (v) => { setRows(null); setError(null); setIds([]); fn(v) }
  useEffect(() => {
    fetch(`/api/scanner-log/rows/${file}`).then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then(setRows).catch((e) => setError(e.message))
  }, [file])
  const signals = kind === 'signals'
  const shown = useMemo(() => (rows ?? []).filter((r) => (underlying === 'all' || r.underlying === underlying) && (!ids.length || ids.includes(r.strategy_id))
    && (signals || mode === 'all' || (mode === 'live') === (r.live === 'true')) && inDates(r.date, range))
    .sort((a, b) => ((signals ? b.time_ist : b.entry_time_ist) ?? '').localeCompare((signals ? a.time_ist : a.entry_time_ist) ?? '')), [rows, underlying, ids, mode, range, signals])
  const nameOf = (r) => r.strategy || STRATEGY_BY_ID[r.strategy_id]?.name || r.strategy_id
  const signalColumns = [
    { title: 'Date', dataIndex: 'date', width: 105, fixed: 'left' },
    { title: 'In → out (IST)', key: 't', width: 120, render: (_, r) => `${hhmm(r.time_ist)} → ${r.exit_time_ist ? hhmm(r.exit_time_ist) : (r.status === 'open' || !r.status ? 'open' : '-')}` },
    { title: 'Index', dataIndex: 'underlying', width: 90 },
    { title: 'Strategy', key: 's', width: 230, render: (_, r) => <span style={{ fontSize: 12 }}>#{r.strategy_no} {nameOf(r)}{r.estimated === 'true' && <Tag style={{ marginLeft: 4 }}>est.</Tag>}</span> },
    { title: 'Side', dataIndex: 'side', width: 70, render: sideTag },
    { title: 'Entry', dataIndex: 'entry', width: 85, render: (v) => f1(num(v)) },
    { title: 'SL', dataIndex: 'stop', width: 85, render: (v) => f1(num(v)) },
    { title: 'Target', dataIndex: 'target', width: 85, render: (v) => f1(num(v)) },
    { title: 'Exit', dataIndex: 'exit_price', width: 85, render: (v) => f1(num(v)) },
    { title: 'Closed by', dataIndex: 'exit_reason', width: 120, render: (v, r) => v || r.status || '-' },
    { title: 'Points', dataIndex: 'points', width: 80, render: (v) => <b style={{ color: col(num(v)) }}>{pts(num(v))}</b> },
    { title: 'R', dataIndex: 'r', width: 75, render: (v) => <span style={{ color: col(num(v)) }}>{fmtR(num(v))}</span> },
    { title: 'Day type', dataIndex: 'day_type', width: 110 },
    { title: 'Adaptive', dataIndex: 'adaptive_take', width: 90, render: (v, r) => (v ? <Tooltip title={r.adaptive_reason}>{v === 'true' ? 'take' : v === 'false' ? 'skip' : v}</Tooltip> : '-') },
  ]
  const tradeColumns = [
    { title: 'Date', dataIndex: 'date', width: 105, fixed: 'left' },
    { title: 'In → out (IST)', key: 't', width: 120, render: (_, r) => `${hhmm(r.entry_time_ist)} → ${r.exit_time_ist ? hhmm(r.exit_time_ist) : 'open'}` },
    { title: 'Index', dataIndex: 'underlying', width: 90 },
    { title: 'Mode', dataIndex: 'live', width: 75, render: (v) => (v === 'true' ? <Tag color="red">LIVE</Tag> : <Tag>paper</Tag>) },
    { title: 'Strategy', key: 's', width: 210, render: (_, r) => <span style={{ fontSize: 12 }}>#{r.strategy_no} {nameOf(r)}{r.signal_side ? ` · ${r.signal_side}` : ''}</span> },
    { title: 'Option', key: 'o', width: 170, render: (_, r) => `${r.action} ${r.strike} ${r.option}` },
    { title: 'Lots', key: 'l', width: 80, render: (_, r) => `${r.lots} × ${r.lot_size}` },
    { title: 'Premium in → out', key: 'p', width: 140, render: (_, r) => `${f1(num(r.entry_premium))} → ${r.exit_premium ? f1(num(r.exit_premium)) : '-'}` },
    { title: 'Points', dataIndex: 'points', width: 80, render: (v) => <b style={{ color: col(num(v)) }}>{pts(num(v))}</b> },
    { title: 'Net ₹', dataIndex: 'net_rupees', width: 100, render: (v) => <b style={{ color: col(num(v)) }}>{num(v) == null ? '-' : Math.round(num(v)).toLocaleString('en-IN')}</b> },
    { title: 'Closed by', dataIndex: 'exit_reason', width: 130 },
  ]
  const columns = signals ? signalColumns : tradeColumns
  const csvColumns = columns.map((c) => ({ title: typeof c.title === 'string' ? c.title : c.key, value: (r) => (c.dataIndex ? r[c.dataIndex] : c.key === 't' ? `${(signals ? r.time_ist : r.entry_time_ist) ?? ''} -> ${r.exit_time_ist ?? ''}` : c.key === 's' ? nameOf(r) : c.key === 'o' ? `${r.action} ${r.strike} ${r.option}` : c.key === 'l' ? `${r.lots}x${r.lot_size}` : c.key === 'p' ? `${r.entry_premium}->${r.exit_premium}` : '') }))
  const rupees = shown.map((r) => num(r.net_rupees)).filter(Number.isFinite).reduce((a, b) => a + b, 0)
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Row gutter={[12, 8]} align="middle">
        <Col><Segmented value={source} onChange={reset(setSource)} options={[{ value: 'server', label: <Tooltip title="The server's scanner (runs without the page open)">Server scanner</Tooltip> }, { value: 'page', label: <Tooltip title="The Order Flow page's scanner (what the browser saved)">Order Flow page</Tooltip> }]} /></Col>
        <Col><Segmented value={kind} onChange={reset(setKind)} options={[{ value: 'signals', label: 'Signals (futures)' }, { value: 'trades', label: 'Option trades' }]} /></Col>
        <Col><Select value={underlying} onChange={setUnderlying} options={[{ value: 'all', label: 'All indices' }, ...UNDERLYINGS.map((u) => ({ value: u, label: u }))]} style={{ width: 130 }} /></Col>
        <Col flex="1 1 260px"><Select mode="multiple" allowClear value={ids} onChange={setIds} placeholder="All strategies" style={{ width: '100%' }} maxTagCount="responsive" options={strategyOptions(rows ?? [], (r) => r.strategy_id, (r) => `#${r.strategy_no} ${nameOf(r)}`)} /></Col>
        {!signals && <Col><Segmented value={mode} onChange={setMode} options={[{ value: 'all', label: 'Live + paper' }, { value: 'live', label: 'Live' }, { value: 'paper', label: 'Paper' }]} /></Col>}
        <Col><DatePicker.RangePicker value={range} onChange={setRange} format="DD MMM YYYY" allowEmpty={[true, true]} /></Col>
        <Col><Button onClick={() => downloadCsv(`${file}-filtered.csv`, csvColumns, shown)} disabled={!shown.length}>Download CSV</Button></Col>
      </Row>
      {error && <Alert type="error" showIcon message={`The record could not be loaded: ${error}`} />}
      {rows && (
        <>
          <Totals rows={shown} points={(r) => num(r.points)} r={signals ? (r) => num(r.r) : null} extra={!signals && <span>net <b style={{ color: col(rupees) }}>₹{Math.round(rupees).toLocaleString('en-IN')}</b> after charges</span>} />
          <Table size="small" rowKey="key" dataSource={shown} columns={columns} pagination={{ pageSize: 50, size: 'small', showSizeChanger: true, pageSizeOptions: [50, 100, 500] }} scroll={{ x: 1400 }} />
          <Text type="secondary" style={{ fontSize: 12 }}>The whole file: <a href={`/api/scanner-log/${file}`} download>{file}.csv</a>.</Text>
        </>
      )}
    </Space>
  )
}

/** Trades: every trade with its date and time in one place - the backtest (each strategy on every day of the latest
 *  tuning run) and the scanner's own record (its signals and the live / paper option trades it took). */
export default function TradesPage() {
  const [tab, setTab] = useState('backtest')
  return (
    <div style={{ maxWidth: 1600, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>
        <Card size="small" title="Trades" extra={<Segmented value={tab} onChange={setTab} options={[{ value: 'backtest', label: 'Backtest (tuning run)' }, { value: 'record', label: 'Scanner record (live & paper)' }]} />}>
          {tab === 'backtest' ? <BacktestTrades /> : <ScannerRecord />}
        </Card>
      </Space>
    </div>
  )
}
