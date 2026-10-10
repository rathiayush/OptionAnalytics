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

/** One trade sequence for every strategy: by entry date, then time (then index, strategy number). */
const byTime = (order, timeOf) => (a, b) => (order === 'desc' ? -1 : 1) * (String(a.date ?? '').localeCompare(String(b.date ?? '')) || (timeOf(a) ?? 0) - (timeOf(b) ?? 0)
  || String(a.index ?? a.underlying ?? '').localeCompare(String(b.index ?? b.underlying ?? '')) || (Number(a.no ?? a.strategy_no) || 0) - (Number(b.no ?? b.strategy_no) || 0))
const OrderToggle = ({ value, onChange }) => <Segmented value={value} onChange={onChange} options={[{ value: 'asc', label: 'Oldest first' }, { value: 'desc', label: 'Newest first' }]} />
const istMs = (s) => (s ? Date.parse(`${String(s).replace(' ', 'T')}+05:30`) : null) // "yyyy-MM-dd HH:mm:ss" (IST) -> ms

const inDates = (date, range) => (!range?.[0] || date >= range[0].format('YYYY-MM-DD')) && (!range?.[1] || date <= range[1].format('YYYY-MM-DD'))
const strategyOptions = (rows, idOf, label) => [...new Map(rows.map((r) => [idOf(r), label(r)])).entries()].filter(([id]) => id).sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'en', { numeric: true })).map(([value, l]) => ({ value, label: l }))

// ---- Backtest: the tuning HISTORY - every run kept as CSV, the picked runs' trades clubbed by date and time -------
const runLabel = (r) => `${r.index}${r.data === 'spot' ? ' spot' : ''} · ${r.finished_ist?.slice(8, 10)}/${r.finished_ist?.slice(5, 7)} ${r.finished_ist?.slice(11, 16)} · ${r.days_used}d · ${r.tuned}`
/** The newest run of each index (for the data mode) - what the page shows until runs are picked. */
const latestPerIndex = (runs, data) => {
  const seen = new Map()
  for (const r of runs.filter((x) => x.data === data)) if (!seen.has(r.index)) seen.set(r.index, r.run_id) // runs come newest first
  return [...seen.values()]
}

function BacktestTrades() {
  const [data, setData] = useState('futures')
  const [runs, setRuns] = useState(null)
  const [picked, setPicked] = useState([])
  const [touched, setTouched] = useState(false) // the trader chose the runs themselves
  const [loaded, setLoaded] = useState({}) // run_id -> rows
  const [error, setError] = useState(null)
  const [view, setView] = useState('trades')
  const [setting, setSetting] = useState('all')
  const [order, setOrder] = useState('asc')
  const [ids, setIds] = useState([])
  const [side, setSide] = useState('all')
  const [outcome, setOutcome] = useState('all')
  const [range, setRange] = useState(null)
  const [optionsOnly, setOptionsOnly] = useState(null) // null: follow the data mode

  useEffect(() => {
    fetch('/api/strategy-tuning/history').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setRuns).catch((e) => setError(e.message))
  }, [])
  // Until runs are picked by hand, show the newest run of each index.
  useEffect(() => { if (runs && !touched) setPicked(latestPerIndex(runs, data)) }, [runs, data, touched])
  // Each picked run's file is read once and kept (a run never changes).
  useEffect(() => {
    for (const id of picked) {
      for (const kind of ['trades', 'settings']) {
        const key = `${id}:${kind}`
        if (loaded[key]) continue
        setLoaded((m) => ({ ...m, [key]: 'loading' }))
        fetch(`/api/strategy-tuning/history/${id}/${kind}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((rows) => setLoaded((m) => ({ ...m, [key]: rows })))
          .catch(() => setLoaded((m) => ({ ...m, [key]: [] })))
      }
    }
  }, [picked]) // eslint-disable-line react-hooks/exhaustive-deps

  const pickedRuns = useMemo(() => (runs ?? []).filter((r) => picked.includes(r.run_id)), [runs, picked])
  const rowsOf = (kind) => picked.flatMap((id) => (Array.isArray(loaded[`${id}:${kind}`]) ? loaded[`${id}:${kind}`] : []))
  const waiting = picked.some((id) => loaded[`${id}:trades`] === 'loading')
  const all = useMemo(() => rowsOf('trades'), [picked, loaded]) // eslint-disable-line react-hooks/exhaustive-deps
  const settings = useMemo(() => rowsOf('settings'), [picked, loaded]) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => all
    .filter((t) => (setting === 'all' || t.setting === setting) && (!ids.length || ids.includes(t.strategy_id))
      && (side === 'all' || t.side === side)
      && (outcome === 'all' || (outcome === 'win' ? num(t.points) > 0 : outcome === 'loss' ? num(t.points) < 0 : /stop|SL/i.test(t.closed_by)))
      && inDates(t.date, range))
    .map((t) => ({ ...t, _t: istMs(t.entry_time_ist), _p: num(t.points) }))
    .sort(byTime(order, (t) => t._t)), [all, setting, ids, side, outcome, range, order])

  const csvColumns = Object.keys(all[0] ?? {}).map((k) => ({ title: k, value: (r) => r[k] }))
  // Trading options only: the index entry / stop / target are what the signal was, not what was traded - they can be
  // put away. On by default for Spot + options, off for Futures + OI (where the futures trade is the trade).
  const justOptions = optionsOnly ?? (data === 'spot')
  // An option leg: what it was, the premium in and out, the net on it, and what closed it - its own SL, its own
  // target, or the index trade's exit.
  const leg = (label, inp, out, p, sl, target, closedBy) => {
    if (!label) return <Text type="secondary">-</Text>
    const net = num(p)
    const by = closedBy === 'its SL' ? <Tag color="red" style={{ marginInlineEnd: 0 }}>SL hit</Tag>
      : closedBy === 'its target' ? <Tag color="green" style={{ marginInlineEnd: 0 }}>target hit</Tag>
      : closedBy ? <Tag style={{ marginInlineEnd: 0 }}>index exit</Tag> : null
    return (
      <span style={{ fontSize: 12 }}>
        {label} {f1(num(inp))} → {num(out) == null ? <Tooltip title="that strike had no traded price near the exit minute"><Text type="secondary">?</Text></Tooltip> : f1(num(out))}
        {' '}<b style={{ color: col(net) }}>{pts(net)}</b> {by}
        {(num(sl) || num(target)) ? <><br /><Text type="secondary" style={{ fontSize: 11 }}>SL {f1(num(sl))} · target {f1(num(target))}</Text></> : null}
      </span>
    )
  }
  const spot = data === 'spot'

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Row gutter={[12, 8]} align="middle">
        <Col><Segmented value={data} onChange={(v) => { setData(v); setTouched(false); setIds([]) }} options={[{ value: 'futures', label: 'Futures + OI' }, { value: 'spot', label: 'Spot + options' }]} /></Col>
        <Col flex="1 1 420px">
          <Tooltip title="Every tuning run is kept. Pick any - of any index - and their trades are listed together by date and time.">
            <Select mode="multiple" allowClear value={picked} onChange={(v) => { setPicked(v); setTouched(true) }} style={{ width: '100%' }} maxTagCount="responsive"
              placeholder="Tuning runs" options={(runs ?? []).filter((r) => r.data === data).map((r) => ({ value: r.run_id, label: runLabel(r) }))} />
          </Tooltip>
        </Col>
        <Col><Segmented value={view} onChange={setView} options={[{ value: 'trades', label: 'Trades' }, { value: 'settings', label: <Tooltip title="What each strategy was tuned to in these runs - every parameter, and what it scored">Tuned settings</Tooltip> }]} /></Col>
        {!touched && runs?.length > 0 && <Col><Text type="secondary" style={{ fontSize: 12 }}>showing the newest run of each index</Text></Col>}
      </Row>
      {error && <Alert type="error" showIcon message={`The tuning history could not be read: ${error}`} />}
      {runs?.length === 0 && <Alert type="info" showIcon message="No tuning run yet - run one on the Strategy tuning page. Every run is kept here afterwards: its trades and the settings it found." />}
      {pickedRuns.length > 0 && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {pickedRuns.map((r) => `${r.index}: ${r.finished_ist?.slice(0, 16)}, ${r.days_used} day(s) ${r.first_day} to ${r.last_day}${Number(r.days_skipped) ? `, ${r.days_skipped} left out` : ''}${Number(r.days_estimated) ? `, ${r.days_estimated} estimated` : ''}`).join(' · ')}
        </Text>
      )}
      {view === 'trades' ? (
        <>
          <Row gutter={[12, 8]} align="middle">
            <Col><Segmented value={setting} onChange={setSetting} options={[{ value: 'all', label: 'All trades' }, { value: 'as written', label: 'As written' }, { value: 'fine-tuned', label: 'Fine-tuned' }]} /></Col>
            <Col><OrderToggle value={order} onChange={setOrder} /></Col>
            <Col flex="1 1 240px"><Select mode="multiple" allowClear value={ids} onChange={setIds} placeholder="All strategies" style={{ width: '100%' }} maxTagCount="responsive"
              options={strategyOptions(all, (t) => t.strategy_id, (t) => `#${t.strategy_no} ${t.strategy}`)} /></Col>
            <Col><Segmented value={side} onChange={setSide} options={[{ value: 'all', label: 'Both sides' }, { value: 'LONG', label: 'Long' }, { value: 'SHORT', label: 'Short' }]} /></Col>
            <Col><Segmented value={outcome} onChange={setOutcome} options={[{ value: 'all', label: 'All' }, { value: 'win', label: 'Winners' }, { value: 'loss', label: 'Losers' }, { value: 'sl', label: 'SL hit' }]} /></Col>
            <Col><DatePicker.RangePicker value={range} onChange={setRange} format="DD MMM YYYY" allowEmpty={[true, true]} /></Col>
            <Col><Tooltip title="Show only what an option trade did - the index entry, stop, target and exit are the signal behind it, not the trade"><Segmented value={justOptions ? 'options' : 'both'} onChange={(v) => setOptionsOnly(v === 'options')} options={[{ value: 'options', label: 'Options only' }, { value: 'both', label: `With the ${spot ? 'index' : 'futures'}` }]} /></Tooltip></Col>
            <Col><Button onClick={() => downloadCsv(`tuning-trades.csv`, csvColumns, shown)} disabled={!shown.length}>Download CSV</Button></Col>
          </Row>
          <Totals rows={shown} points={(t) => t._p} r={(t) => num(t.r)} />
          <Table size="small" loading={waiting} rowKey={(t) => `${t.run_id}-${t.strategy_id}-${t.setting}-${t.date}-${t.entry_time_ist}`} dataSource={shown}
            pagination={{ pageSize: 50, size: 'small', showSizeChanger: true, pageSizeOptions: [50, 100, 500] }} scroll={{ x: 1500 }}
            expandable={{ rowExpandable: (t) => !!t.why, expandedRowRender: (t) => (
              <Space direction="vertical" size={2} style={{ fontSize: 12 }}>
                {t.setting_text && <Text style={{ fontSize: 12 }}><b>Setting:</b> {t.setting_text}</Text>}
                {t.why.split(' · ').map((w, i) => <Text key={i} style={{ fontSize: 12 }}>{w}</Text>)}
              </Space>
            ) }}
            columns={[
              { title: 'Date', dataIndex: 'date', width: 105, fixed: 'left' },
              { title: 'In → out (IST)', key: 'time', width: 120, render: (_, t) => `${t.entry_time_ist?.slice(11, 16)} → ${t.exit_time_ist ? t.exit_time_ist.slice(11, 16) : 'end'}` },
              { title: 'Index', dataIndex: 'index', width: 110 },
              { title: 'Strategy', key: 's', width: 220, render: (_, t) => <span style={{ fontSize: 12 }}>#{t.strategy_no} {t.strategy}
                {t.setting === 'fine-tuned' && <Tooltip title={t.setting_text}><Tag color="blue" style={{ marginLeft: 4 }}>fine-tuned</Tag></Tooltip>}
                {t.estimated_day === 'yes' && <Tooltip title="A day rebuilt from 1-minute candles (no tape / depth)"><Tag style={{ marginLeft: 4 }}>est.</Tag></Tooltip>}</span> },
              { title: 'Side', dataIndex: 'side', width: 70, render: sideTag },
              ...(justOptions ? [] : [
              { title: `${spot ? 'Index' : 'Futures'} in`, dataIndex: 'entry', width: 90, render: (v) => f1(num(v)) },
              { title: 'SL', key: 'sl', width: 95, render: (_, t) => <span style={{ fontSize: 12 }}>{f1(num(t.stop))}<br /><Text type="secondary" style={{ fontSize: 11 }}>{f1(num(t.sl_points))} pts{t.trailed_stop ? ` · trailed ${f1(num(t.trailed_stop))}` : ''}</Text></span> },
              { title: 'Target', key: 'tg', width: 95, render: (_, t) => <span style={{ fontSize: 12 }}>{f1(num(t.target))}<br /><Text type="secondary" style={{ fontSize: 11 }}>{f1(num(t.target_points))} pts</Text></span> },
              { title: `${spot ? 'Index' : 'Futures'} out`, dataIndex: 'exit', width: 90, render: (v) => f1(num(v)) },
              { title: 'Closed by', dataIndex: 'closed_by', width: 105 },
              { title: 'Points', key: 'points', width: 80, sorter: (a, b) => a._p - b._p, render: (_, t) => <b style={{ color: col(t._p) }}>{pts(t._p)}</b> },
              { title: 'R', dataIndex: 'r', width: 75, sorter: (a, b) => num(a.r) - num(b.r), render: (v) => <span style={{ color: col(num(v)) }}>{fmtR(num(v))}</span> },
              ]),
              { title: 'Option traded', key: 'ot', width: 250, render: (_, t) => (t.option_traded ? leg(t.option_traded, t.option_in, t.option_out, t.option_points, t.option_sl, t.option_target, t.option_closed_by) : <Text type="secondary">-</Text>) },
              { title: 'If I BOUGHT the option', key: 'b', width: 260, render: (_, t) => leg(t.option_bought, t.bought_in, t.bought_out, t.bought_points, t.bought_sl, t.bought_target, t.bought_closed_by) },
              { title: 'If I SOLD the option', key: 'so', width: 260, render: (_, t) => leg(t.option_sold, t.sold_in, t.sold_out, t.sold_points, t.sold_sl, t.sold_target, t.sold_closed_by) },
            ]} />
        </>
      ) : (
        <>
          <Row gutter={[12, 8]} align="middle">
            <Col flex="1 1 240px"><Select mode="multiple" allowClear value={ids} onChange={setIds} placeholder="All strategies" style={{ width: '100%' }} maxTagCount="responsive"
              options={strategyOptions(settings, (r) => r.strategy_id, (r) => `#${r.strategy_no} ${r.strategy}`)} /></Col>
            <Col><Button onClick={() => downloadCsv('tuning-settings.csv', Object.keys(settings[0] ?? {}).map((k) => ({ title: k, value: (r) => r[k] })), settings.filter((r) => !ids.length || ids.includes(r.strategy_id)))} disabled={!settings.length}>Download CSV</Button></Col>
          </Row>
          <Text type="secondary" style={{ fontSize: 12 }}>What each strategy was tuned to in the runs above, and what it scored - the strategy as written beside the setting the tuning chose. Every run is kept, so the same strategy can be compared run by run.</Text>
          <Table size="small" rowKey={(r) => `${r.run_id}-${r.strategy_id}-${r.which}`} dataSource={settings.filter((r) => !ids.length || ids.includes(r.strategy_id))}
            pagination={{ pageSize: 25, size: 'small', hideOnSinglePage: true }} scroll={{ x: 1200 }}
            expandable={{ expandedRowRender: (r) => (
              <Space size={[6, 4]} wrap>
                {Object.entries(r).filter(([k]) => k.startsWith('trade') || k.startsWith('opt')).filter(([, v]) => v !== '').map(([k, v]) => <Tag key={k} style={{ fontSize: 11 }}>{k}: <b>{v}</b></Tag>)}
              </Space>
            ) }}
            columns={[
              { title: 'Run', key: 'run', width: 150, render: (_, r) => <span style={{ fontSize: 12 }}>{r.index}<br /><Text type="secondary" style={{ fontSize: 11 }}>{r.finished_ist?.slice(0, 16)}</Text></span> },
              { title: 'Strategy', key: 's', width: 210, render: (_, r) => <span style={{ fontSize: 12 }}>#{r.strategy_no} {r.strategy}</span> },
              { title: 'Which', dataIndex: 'which', width: 110, render: (v, r) => (v === 'fine-tuned' ? <Tag color={r.recommended === 'yes' ? 'success' : 'blue'}>{r.recommended === 'yes' ? 'recommended' : 'fine-tuned'}</Tag> : <Tag>as written</Tag>) },
              { title: 'Setting', key: 'p', render: (_, r) => <span style={{ fontSize: 12 }}>{r.setting_text || <Text type="secondary">the strategy as written</Text>}</span> },
              { title: 'Train (older days)', key: 'tr', width: 190, render: (_, r) => <Text style={{ fontSize: 12 }}>{r.train_trades || 0} trades · <b style={{ color: col(num(r.train_avg)) }}>{num(r.train_avg) == null ? '-' : `${pts(num(r.train_avg))}${r.unit === 'pts' ? ' pts' : 'R'}`}</b>/trade · win {r.train_win_pct || '-'}%</Text> },
              { title: 'Test (newest days)', key: 'te', width: 190, render: (_, r) => <Text style={{ fontSize: 12 }}>{r.test_trades || 0} trades · <b style={{ color: col(num(r.test_avg)) }}>{num(r.test_avg) == null ? '-' : `${pts(num(r.test_avg))}${r.unit === 'pts' ? ' pts' : 'R'}`}</b>/trade · win {r.test_win_pct || '-'}%</Text> },
              { title: 'Points (all days)', key: 'pt', width: 200, render: (_, r) => <Text style={{ fontSize: 12 }}>net <b style={{ color: col(num(r.points_net)) }}>{pts(num(r.points_net))}</b> · {r.wins}W {r.losses}L{Number(r.sl_hits) ? ` · ${r.sl_hits} SL ${pts(num(r.sl_points))}` : ''}</Text> },
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
  const [order, setOrder] = useState('asc')
  const file = `${source === 'server' ? 'server-' : ''}${kind}`
  const reset = (fn) => (v) => { setRows(null); setError(null); setIds([]); fn(v) }
  useEffect(() => {
    fetch(`/api/scanner-log/rows/${file}`).then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then(setRows).catch((e) => setError(e.message))
  }, [file])
  const signals = kind === 'signals'
  const shown = useMemo(() => (rows ?? []).filter((r) => (underlying === 'all' || r.underlying === underlying) && (!ids.length || ids.includes(r.strategy_id))
    && (signals || mode === 'all' || (mode === 'live') === (r.live === 'true')) && inDates(r.date, range))
    .sort(byTime(order, (r) => istMs(signals ? r.time_ist : r.entry_time_ist))), [rows, underlying, ids, mode, range, signals, order])
  const nameOf = (r) => r.strategy || STRATEGY_BY_ID[r.strategy_id]?.name || r.strategy_id
  const signalColumns = [
    { title: 'Date', dataIndex: 'date', width: 105, fixed: 'left' },
    { title: 'In → out (IST)', key: 't', width: 120, render: (_, r) => `${hhmm(r.time_ist)} → ${r.exit_time_ist ? hhmm(r.exit_time_ist) : (r.status === 'open' || !r.status ? 'open' : '-')}` },
    { title: 'Index', dataIndex: 'underlying', width: 110 },
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
    { title: 'Index', dataIndex: 'underlying', width: 110 },
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
        <Col><OrderToggle value={order} onChange={setOrder} /></Col>
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
