import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Card, Checkbox, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tabs, Tag, Tooltip, Typography, message } from 'antd'
import { DeleteOutlined, DownloadOutlined, HistoryOutlined, RocketOutlined, SaveOutlined, UploadOutlined } from '@ant-design/icons'
import { Link } from 'react-router-dom'
import dayjs from 'dayjs'
import { DOWN_COLOR, UP_COLOR, useAuth, useMediaQuery } from './shared.jsx'
import { RULE_ACTIONS, normalizeRule, ruleText } from './signalBacktest.js'
import { createStrategy, deleteStrategy, historyCsvUrl, strategyHistory, updateStrategy } from './signalStrategiesApi.js'
import { orderTrades, sortStrategies, sortTrades, totalOf } from './signalStrategyHistory.js'

// The Signal backtest's SAVED STRATEGIES on the page: save the rule and its settings by name (on the server, CSV), load one
// back, update it with the page's settings, remove it - and its daily LIVE scan: "Live" scans it on every trading day on
// the server (the backtest's own trades, paper), "Alerts" sends each entry / exit to Telegram, "Daily report" the day's
// trades and P&L after the close; "History" shows what the live scan kept (and its CSV files). "LIVE ORDERS (Dhan)" - an
// ADMIN's switch, off by default, confirmed (real money): the server places a Dhan super order for each fresh entry of the
// live scan (the rule's and the mirror's - the traded index's option, the lots on Trade settings) and closes it on the
// strategy's own exit (SignalLiveOrders on the server); the History's "Live orders" tab lists each order and why one
// was not placed.

const { Paragraph, Text } = Typography
const rupees = (v) => (Number.isFinite(v) ? `${v < 0 ? '−' : ''}₹${Math.round(Math.abs(v)).toLocaleString('en-IN')}` : '—')
const pnlColor = (v) => (v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined)
const num = (v) => (v === '' || v == null ? NaN : Number(v))
const ACTION_LABEL = Object.fromEntries(RULE_ACTIONS.map((a) => [a.value, a.label]))
const ruleOf = (s) => { const r = normalizeRule(s.settings?.rule); return ruleText(r.lines, r.action, r.logic) }
const LIVE_STATE = { running: 'Live scan running', missing: 'Live scan not installed on the server', off: 'Live scan turned off on the server', exited: 'Live scan restarting', failed: 'Live scan failed to start', starting: 'Live scan starting' }

const DANGER = '#cf1322'
const ORDER_STATUS = { placed: 'green', 'partly placed': 'orange', 'not placed': 'red', skipped: 'default', exited: 'blue', 'exit failed': 'red' }

/** "Save strategy": a name and the live switches for the rule and settings on the page. Mounted on open. */
export function SaveStrategyModal({ settings, ruleSummary, onClose, onSaved }) {
  // The strategy's own name when the page has one (a template loaded, or typed), else the index and the trade.
  const [name, setName] = useState(() => settings.strategyName || `${settings.underlying} · ${ACTION_LABEL[settings.rule?.action] ?? ''}${settings.rule?.mirror ? ' + mirror' : ''}`)
  const [live, setLive] = useState(true)
  const [alerts, setAlerts] = useState(true)
  const [dailyReport, setDailyReport] = useState(true)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    try {
      const s = await createStrategy({ name: name.trim(), settings, live, alerts, dailyReport })
      message.success(live ? `"${s.name}" saved - scanned live from the next minute of a trading session.` : `"${s.name}" saved.`)
      onSaved(s)
    } catch (err) {
      message.error(`Not saved: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open title="Save strategy" onCancel={onClose} onOk={save} okText="Save" confirmLoading={busy} okButtonProps={{ disabled: !name.trim() }} destroyOnHidden>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Text style={{ fontSize: 12 }}><Text strong style={{ fontSize: 12 }}>{settings.underlying}{settings.tradeIn ? ` → traded in ${settings.tradeIn}` : ''}</Text> · {ruleSummary}</Text>
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>Name</Text>
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Space>
        <Space direction="vertical" size={6}>
          <Space size={8}><Switch size="small" checked={live} onChange={setLive} /><Text>Scan it live every trading day (on the server, paper)</Text></Space>
          <Space size={8} style={{ paddingLeft: 24 }}><Checkbox checked={alerts} disabled={!live} onChange={(e) => setAlerts(e.target.checked)}>Telegram each entry and exit</Checkbox></Space>
          <Space size={8} style={{ paddingLeft: 24 }}><Checkbox checked={dailyReport} disabled={!live} onChange={(e) => setDailyReport(e.target.checked)}>Telegram the daily report after the close</Checkbox></Space>
        </Space>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Saved with every setting on the page - the rule, Then / Mirror, timeframe, strike, SL / target / trail, time stop, trades a day,
          cooldown, lots, charges and Expiry day. The live scan trades it exactly as a backtest of the day would; each day&apos;s trades are
          kept as history (CSV).
        </Text>
      </Space>
    </Modal>
  )
}

const dayColumns = [
  {
    title: 'Day', dataIndex: 'date', key: 'date', width: 150,
    render: (v, r) => <span style={{ whiteSpace: 'nowrap' }}>{dayjs(v).format('ddd D MMM')}{r.limit ? <Tag color={r.limit === 'loss' ? 'red' : 'green'} style={{ marginLeft: 6 }}>max {r.limit}</Tag> : null}</span>,
  },
  { title: 'Trades', dataIndex: 'trades', key: 'trades', width: 70, align: 'right' },
  { title: 'Win %', dataIndex: 'winRate', key: 'winRate', width: 70, align: 'right', render: (v) => (Number.isFinite(num(v)) ? Math.round(num(v)) : '—') },
  { title: 'Net', dataIndex: 'net', key: 'net', width: 100, align: 'right', render: (v) => <Text strong style={{ color: pnlColor(num(v)) }}>{rupees(num(v))}</Text> },
  { title: 'Charges', dataIndex: 'charges', key: 'charges', width: 90, align: 'right', render: (v) => rupees(num(v)) },
  { title: 'Signals', dataIndex: 'signals', key: 'signals', width: 70, align: 'right' },
]
const price = (v) => (Number.isFinite(num(v)) ? num(v).toFixed(2) : '—')
const stamp = (t) => `${t.date ?? ''} ${t.entryTime ?? ''}`
const OPEN_TAG = <Tag color="processing" style={{ margin: 0 }}>open</Tag>
// A signal NOT TAKEN (another strategy's trade was open) or a trade shown live that the end-of-day read does not have: kept, tagged.
const NOT_TAKEN_TAG = <Tag color="warning" style={{ margin: 0 }}>not taken</Tag>
const UNCONFIRMED_TAG = <Tag color="orange" style={{ margin: 0 }}>unconfirmed</Tag>
const apartTag = (t) => (t.status === 'unconfirmed' ? UNCONFIRMED_TAG : NOT_TAKEN_TAG)
const isOpen = (t) => t.status === 'open'
const notTaken = (t) => t.status === 'not taken' || t.status === 'unconfirmed'
// An open trade's RUNNING P&L at the option's current price (the server marks the row each minute).
const running = (t) => (isOpen(t) && Number.isFinite(num(t.net)) ? <Text strong style={{ color: pnlColor(num(t.net)), fontSize: 12 }}>{rupees(num(t.net))} <Text type="secondary" style={{ fontSize: 11 }}>running</Text></Text> : null)
// The strategy's trades AS EACH SIGNAL CAME (the server keeps a row at the entry - open - and fills it in at the exit):
// entry time and premium, its stop-loss and target prices, the exit's time, price and reason, the P&L.
const tradeColumns = [
  { title: 'Day', dataIndex: 'date', key: 'date', width: 80, render: (v) => dayjs(v).format('D MMM'), sorter: (a, b) => stamp(a).localeCompare(stamp(b)), defaultSortOrder: 'descend', sortDirections: ['descend', 'ascend'] },
  { title: 'Trade', key: 'trade', width: 160, render: (_, t) => (notTaken(t) ? <Space direction="vertical" size={0}><span>{t.signal}</span>{apartTag(t)}</Space> : `${t.action} ${t.option}${t.side === 'mirror' ? ' (mirror)' : ''}`) },
  { title: 'Entry', key: 'entry', width: 110, render: (_, t) => (notTaken(t) ? t.entryTime : `${t.entryTime} · ${price(t.entry)}`) },
  { title: 'SL', dataIndex: 'sl', key: 'sl', width: 70, align: 'right', render: price },
  { title: 'Target', dataIndex: 'target', key: 'target', width: 70, align: 'right', render: price },
  { title: 'Exit', key: 'exit', width: 110, render: (_, t) => (notTaken(t) ? '—' : isOpen(t) ? <Space direction="vertical" size={0}>{OPEN_TAG}<span style={{ fontSize: 12 }}>now {price(t.exit)}</span></Space> : (!t.exitTime && !t.exit) ? OPEN_TAG : `${t.exitTime} · ${price(t.exit)}`) },
  { title: 'Why out', dataIndex: 'exitReason', key: 'reason', width: 130 },
  { title: 'Gross', dataIndex: 'gross', key: 'gross', width: 90, align: 'right', render: (v) => <span style={{ color: pnlColor(num(v)) }}>{rupees(num(v))}</span> },
  { title: 'Charges', dataIndex: 'charges', key: 'charges', width: 80, align: 'right', render: (v) => rupees(num(v)) },
  { title: 'Net', key: 'net', width: 100, align: 'right', render: (_, t) => (isOpen(t) ? running(t) : notTaken(t) ? '—' : <Text strong style={{ color: pnlColor(num(t.net)) }}>{rupees(num(t.net))}</Text>) },
  { title: 'At the signal', dataIndex: 'why', key: 'why', width: 320, ellipsis: { showTitle: false }, render: (v) => <Tooltip title={v}><span>{v}</span></Tooltip> },
]
// The LIVE Dhan orders, ONE ROW A TRADE (orderTrades): punched when, at what LIMIT, its super order's stop-loss and target,
// closed when, at what price and why; Dhan's own text on hover.
const at = (v) => (v ? dayjs(v).format('D MMM HH:mm:ss') : '—')
const statusTag = (v) => (v ? <Tag color={ORDER_STATUS[v] ?? (v.startsWith('closed by') ? 'blue' : 'default')} style={{ margin: 0 }}>{v}</Tag> : null)
const orderColumns = [
  {
    title: 'Trade', key: 'trade', width: 190,
    render: (_, o) => (
      <span>{o.action} {o.option}{o.lots > 0 ? ` x${o.lots} lot${o.lots === 1 ? '' : 's'}` : ''}{o.side === 'mirror' ? <Text type="secondary" style={{ fontSize: 11 }}> (mirror)</Text> : null}</span>
    ),
  },
  { title: 'Punched', key: 'placed', width: 150, render: (_, o) => <Space direction="vertical" size={2}><span style={{ whiteSpace: 'nowrap' }}>{at(o.placedAt)}</span>{statusTag(o.status)}</Space> },
  { title: 'Entry', dataIndex: 'price', key: 'price', width: 75, align: 'right', render: price },
  { title: 'SL', dataIndex: 'sl', key: 'sl', width: 70, align: 'right', render: price },
  { title: 'Target', dataIndex: 'target', key: 'target', width: 70, align: 'right', render: price },
  {
    title: 'Exit', key: 'exit', width: 160,
    render: (_, o) => (o.open ? OPEN_TAG : o.exitStatus ? <Space direction="vertical" size={2}><span style={{ whiteSpace: 'nowrap' }}>{at(o.exitAt)}</span>{statusTag(o.exitStatus)}</Space> : '—'),
  },
  { title: 'Exit price', dataIndex: 'exitPrice', key: 'exitPrice', width: 80, align: 'right', render: price },
  { title: 'Why', key: 'why', width: 200, render: (_, o) => <Text style={{ fontSize: 12 }}>{o.exitReason || o.reason || '—'}</Text> },
  { title: 'Dhan orders', dataIndex: 'orderIds', key: 'ids', width: 110, render: (v) => <Text style={{ fontSize: 12 }} copyable={Boolean(v)}>{v || '—'}</Text> },
  {
    title: 'Dhan said', key: 'message', width: 220, ellipsis: { showTitle: false },
    render: (_, o) => { const m = [o.message, o.exitMessage].filter(Boolean).join(' · '); return m ? <Tooltip title={m}><span style={{ fontSize: 12 }}>{m}</span></Tooltip> : '—' },
  },
]
const eventColumns = [
  { title: 'Sent', dataIndex: 'timeUtc', key: 'time', width: 120, render: (v) => dayjs(v).format('D MMM HH:mm') },
  { title: '', dataIndex: 'kind', key: 'kind', width: 80, render: (v) => <Tag color={v === 'entry' ? 'blue' : v === 'skipped' ? 'warning' : 'default'} style={{ margin: 0 }}>{v === 'skipped' ? 'not taken' : v}</Tag> },
  { title: 'Message', dataIndex: 'text', key: 'text', render: (v) => <Text style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{v}</Text> },
]

/** What the live scan kept for a strategy: the days, their trades and the entries / exits sent - and the CSV files. */
// On a phone a block a trade (a table hid the prices off its right edge): what, in / SL / target, out and why.
const small = { fontSize: 12 }
function TradeBlocks({ rows }) {
  if (!rows.length) return <Text type="secondary" style={small}>No trades yet.</Text>
  return rows.map((t, k) => (
    <div key={`${t.date}|${t.entryTime}|${t.side}|${k}`} className="oa-bg-run">
      <Space size={6} wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Text strong style={{ fontSize: 13 }}>{dayjs(t.date).format('D MMM')} · {notTaken(t) ? `${t.signal} signal` : `${t.action} ${t.option}`}{t.side === 'mirror' ? <Text type="secondary" style={small}> (mirror)</Text> : null}</Text>
        {notTaken(t) ? apartTag(t) : isOpen(t) ? <Space size={4}>{OPEN_TAG}{running(t)}</Space> : (!t.exitTime && !t.exit) ? OPEN_TAG : <Text strong style={{ color: pnlColor(num(t.net)) }}>{rupees(num(t.net))}</Text>}
      </Space>
      {notTaken(t)
        ? <Text style={small}>{t.entryTime} · {t.exitReason}</Text>
        : <Text style={small}>In {t.entryTime} @ {price(t.entry)} · SL {price(t.sl)} · Target {price(t.target)}</Text>}
      {isOpen(t) && Number.isFinite(num(t.exit)) && <Text style={small}>Now @ {price(t.exit)} (the option's current price)</Text>}
      {!isOpen(t) && !notTaken(t) && (t.exitTime || t.exit) && <Text style={small}>Out {t.exitTime} @ {price(t.exit)} · {t.exitReason}{num(t.charges) > 0 ? ` · charges ${rupees(num(t.charges))}` : ''}</Text>}
    </div>
  ))
}
function OrderBlocks({ rows }) {
  if (!rows.length) return <Text type="secondary" style={small}>No live orders yet.</Text>
  return rows.map((o) => (
    <div key={o.key} className="oa-bg-run">
      <Space size={6} wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Text strong style={{ fontSize: 13 }}>{o.action} {o.option}{o.lots > 0 ? ` x${o.lots}` : ''}{o.side === 'mirror' ? <Text type="secondary" style={small}> (mirror)</Text> : null}</Text>
        {statusTag(o.status)}
      </Space>
      <Text style={small}>Punched {at(o.placedAt)}{o.price != null ? ` @ ${price(o.price)}` : ''}{o.sl != null || o.target != null ? ` · SL ${price(o.sl)} · Target ${price(o.target)}` : ''}</Text>
      {o.open && <span>{OPEN_TAG}</span>}
      {o.exitStatus && <Space size={6} wrap><Text style={small}>Out {at(o.exitAt)}{o.exitPrice != null ? ` @ ${price(o.exitPrice)}` : ''}{o.exitReason ? ` · ${o.exitReason}` : ''}</Text>{statusTag(o.exitStatus)}</Space>}
      {!o.orderIds && o.reason && <Text type="secondary" style={small}>{o.reason}</Text>}
      {o.orderIds && <Text type="secondary" style={{ fontSize: 11 }} copyable={{ text: o.orderIds }}>Dhan orders {o.orderIds}</Text>}
    </div>
  ))
}

export function StrategyHistoryModal({ strategy, onClose }) {
  const narrow = useMediaQuery('(max-width: 768px)')
  const [history, setHistory] = useState(null)
  const [error, setError] = useState(null)
  // Loaded on opening and - while the strategy is scanned live - again each minute (a page TIMER, POLL_HEADERS; the server
  // reads its CSV files only): the server writes each signal's trade / order the moment it comes, so the tables follow it.
  useEffect(() => {
    let alive = true
    const load = (timer) => strategyHistory(strategy.id, timer).then((h) => { if (alive) { setHistory(h); setError(null) } }).catch((err) => alive && setError(err.message))
    load(false)
    const id = strategy.live ? setInterval(() => { if (document.visibilityState !== 'hidden') load(true) }, 60_000) : null
    return () => { alive = false; if (id) clearInterval(id) }
  }, [strategy.id, strategy.live])
  const days = history?.days ?? []
  const total = days.reduce((a, d) => a + (num(d.net) || 0), 0)
  const liveTrades = useMemo(() => orderTrades(history?.orders), [history])
  const csv = (kind, label) => <Button size="small" icon={<DownloadOutlined />} href={historyCsvUrl(strategy.id, kind)}>{label}</Button>
  return (
    <Modal open title={`History - ${strategy.name}`} onCancel={onClose} footer={null} width={Math.min(1000, typeof window === 'undefined' ? 1000 : window.innerWidth - 16)} destroyOnHidden>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {error && <Text type="danger">{error}</Text>}
        <Space wrap size={[12, 6]}>
          <Text>{days.length} day{days.length === 1 ? '' : 's'} scanned live · net <Text strong style={{ color: pnlColor(total) }}>{rupees(total)}</Text></Text>
          {csv('days', 'Days CSV')}{csv('trades', 'Trades CSV')}{csv('events', 'Alerts CSV')}{(strategy.liveOrders || history?.orders?.length > 0) && csv('orders', 'Live orders CSV')}
        </Space>
        <Tabs
          size="small"
          items={[
            { key: 'days', label: `Days (${days.length})`, children: <Table size="small" rowKey="date" columns={dayColumns} dataSource={days} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 520 }} loading={!history && !error} /> },
            { key: 'trades', label: `Trades (${history?.trades?.length ?? 0})`, children: narrow ? <TradeBlocks rows={sortTrades(history?.trades)} /> : <Table size="small" rowKey={(t, k) => `${t.date}|${t.entryTime}|${t.side}|${k}`} columns={tradeColumns} dataSource={sortTrades(history?.trades)} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 1320 }} /> },
            { key: 'events', label: `Alerts (${history?.events?.length ?? 0})`, children: <Table size="small" rowKey={(e, k) => `${e.key}|${k}`} columns={eventColumns} dataSource={history?.events ?? []} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 600 }} /> },
            ...(strategy.liveOrders || history?.orders?.length > 0
              ? [{ key: 'orders', label: `Live orders (${liveTrades.length})`, children: narrow ? <OrderBlocks rows={liveTrades} /> : <Table size="small" rowKey="key" columns={orderColumns} dataSource={liveTrades} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 1350 }} /> }]
              : []),
          ]}
        />
      </Space>
    </Modal>
  )
}

/** TODAY'S trades (asked for - "last day should show current day trades, not last day"): the server's summary of the
 *  strategy's trades of today (`todayTrades` - its trades file, written as each signal comes): the closed trades' net, how
 *  many, how many still open, won / lost - and today's alerts. Refreshed with the list (each minute while one is live). */
/** The strategy's TOTAL profit (the list's sort key): every reported day plus today's closed and running, and how many days it has been scanned. */
function TotalCell({ s }) {
  const v = totalOf(s)
  return (
    <Space direction="vertical" size={0}>
      <Text strong style={{ color: pnlColor(v), fontSize: 13 }}>{rupees(v)}</Text>
      <Text type="secondary" style={{ fontSize: 11 }}>{s.daysScanned > 0 ? `${s.daysScanned} day${s.daysScanned === 1 ? '' : 's'} + today` : 'today only'}</Text>
    </Space>
  )
}

function TodayCell({ s, today }) {
  const t = s.todayTrades
  const label = `Today (${dayjs(today ?? undefined).format('ddd D MMM')})`
  const alerts = s.eventsToday > 0 ? `${s.eventsToday} alert${s.eventsToday === 1 ? '' : 's'}` : null
  if (!t?.trades) {
    return (
      <Space direction="vertical" size={0}>
        <Text type="secondary" style={{ fontSize: 12 }}>{s.live ? `${label}: no trades yet` : 'Not scanned live'}</Text>
        {s.live && alerts && <Text type="secondary" style={{ fontSize: 11 }}>{alerts} so far</Text>}
      </Space>
    )
  }
  const detail = [t.closed > 0 ? `${t.wins} won · ${t.losses} lost` : null, alerts].filter(Boolean).join(' · ')
  return (
    <Space direction="vertical" size={0}>
      <Text style={{ fontSize: 12 }}>
        {label}: {t.closed > 0 ? <Text strong style={{ color: pnlColor(t.net) }}>{rupees(t.net)}</Text> : <Text type="secondary">₹0 closed</Text>}
        {' · '}{t.trades} trade{t.trades === 1 ? '' : 's'}{t.open > 0 ? <Text style={{ color: '#faad14' }}> · {t.open} open{Number.isFinite(t.openNet) && t.openNet !== 0 ? <Text style={{ color: pnlColor(t.openNet) }}> ({rupees(t.openNet)} running)</Text> : null}</Text> : null}
        {t.notTaken > 0 ? <Text type="secondary"> · {t.notTaken} not taken</Text> : null}
      </Text>
      {detail && <Text type="secondary" style={{ fontSize: 11 }}>{detail}</Text>}
      {/* Each open trade: the option, its entry and the option's CURRENT price with the running P&L (marked every minute by the scan). */}
      {(t.running ?? []).map((r, k) => (
        <Text key={k} style={{ fontSize: 11 }}>
          {r.action} {r.option} {price(r.entry)} → <Text strong style={{ fontSize: 11 }}>{price(r.now)}</Text>{' '}
          <Text strong style={{ fontSize: 11, color: pnlColor(num(r.net)) }}>{Number.isFinite(num(r.net)) ? rupees(num(r.net)) : ''}</Text>
        </Text>
      ))}
    </Space>
  )
}

/** The saved strategies: what each is, its live switches, today's trades, and Load / Update / History / Remove. */
/** The saved strategies and their LIVE scan - the Live strategies page's card (`LiveStrategiesPage`). `onLoad` puts one on the Signal
 *  backtest page; `pageSettings` / `onSave` (the backtest page's settings) add Update / Save strategy where there are any. */
export function SavedStrategiesCard({ strategies, today, liveScan, refresh, pageSettings = null, onLoad = null, onSave = null }) {
  const auth = useAuth()
  const narrow = useMediaQuery('(max-width: 768px)')
  const [busyId, setBusyId] = useState(null)
  const [historyOf, setHistoryOf] = useState(null)
  const me = (auth?.user?.email ?? '').toLowerCase()
  const isAdmin = auth?.user?.role === 'Admin'
  const act = async (id, fn, done) => {
    setBusyId(id)
    try { await fn(); if (done) message.success(done) } catch (err) { message.error(err.message) } finally { setBusyId(null); refresh() }
  }
  const toggle = (s, key, value) => act(s.id, () => updateStrategy(s.id, { [key]: value }),
    key === 'live' ? (value ? `"${s.name}" is scanned live from the next minute of a trading session.` : `"${s.name}" is no longer scanned live.`) : null)
  // REAL Dhan orders: an admin's switch only, confirmed - off needs no confirming (an open order is still closed).
  const setLiveOrders = (s, value) => {
    if (!value) return act(s.id, () => updateStrategy(s.id, { liveOrders: false }), `"${s.name}" places no new live order - one already open is still closed by its exit.`)
    const traded = s.settings?.tradeIn && s.settings.tradeIn !== s.underlying ? s.settings.tradeIn : s.underlying
    const max = s.settings?.maxTradesPerDay ?? 2
    Modal.confirm({
      title: `Place REAL Dhan orders for "${s.name}"?`,
      content: (
        <Space direction="vertical" size={6} style={{ fontSize: 13 }}>
          <span>Every fresh entry of its live scan - the rule's and the mirror's - places a live <b>super order</b> on Dhan for the {traded} option it trades: {s.liveLots > 0 ? <b>{s.liveLots} lot{s.liveLots === 1 ? '' : 's'} (its own lots)</b> : <>the lots set for {traded} on <b>Trade settings</b></>}, its stop-loss / target as the legs (Trade settings' where it has none), at the Trade settings' slippage.</span>
          <span>Its own exits - trailing stop, cost SL, time stop, the day's limits, SL / target, 15:10 - cancel the legs and close it.</span>
          <span>At most {max} a day, one at a time; an entry seen over 3 minutes late is not placed. The daily loss kill switch applies.</span>
        </Space>
      ),
      okText: 'Turn on', okButtonProps: { danger: true }, cancelText: 'Keep off',
      onOk: () => act(s.id, () => updateStrategy(s.id, { liveOrders: true }), `"${s.name}" now places LIVE orders on Dhan from its next entry.`),
    })
    return undefined
  }
  const switches = (s) => (
    <Space direction="vertical" size={2}>
      <Space size={6}><Switch size="small" checked={s.live} loading={busyId === s.id} onChange={(v) => toggle(s, 'live', v)} /><Text style={{ fontSize: 12 }}>Live</Text></Space>
      <Space size={12} style={{ paddingLeft: 2 }}>
        <Checkbox checked={s.alerts} disabled={!s.live} onChange={(e) => toggle(s, 'alerts', e.target.checked)}><Text style={{ fontSize: 12, whiteSpace: 'nowrap' }}>Alerts</Text></Checkbox>
        <Checkbox checked={s.dailyReport} disabled={!s.live} onChange={(e) => toggle(s, 'dailyReport', e.target.checked)}><Text style={{ fontSize: 12, whiteSpace: 'nowrap' }}>Daily report</Text></Checkbox>
      </Space>
      <LotsInput s={s} busy={busyId === s.id} locked={Boolean(s.liveOrders) && !isAdmin}
        onSet={(lots) => act(s.id, () => updateStrategy(s.id, { liveLots: lots }), lots > 0 ? `"${s.name}" trades ${lots} lot${lots === 1 ? '' : 's'} live from its next entry.` : `"${s.name}" is back to its default lots.`)} />
      {isAdmin
        ? (
          <Space size={6}>
            <Switch size="small" checked={Boolean(s.liveOrders)} disabled={!s.live && !s.liveOrders} loading={busyId === s.id} onChange={(v) => setLiveOrders(s, v)}
              style={s.liveOrders ? { background: DANGER } : undefined} aria-label="Live orders (Dhan)" />
            <Tooltip title={s.live ? 'Real Dhan orders from this strategy\'s live scan - off by default.' : 'Turn Live on first - the live scan is what places them.'}>
              <Text style={{ fontSize: 12, whiteSpace: 'nowrap', color: s.liveOrders ? DANGER : undefined, fontWeight: s.liveOrders ? 600 : undefined }}>Live orders (Dhan)</Text>
            </Tooltip>
          </Space>
        )
        : s.liveOrders && <Tag color="red" style={{ margin: 0, width: 'fit-content' }}>Live orders (Dhan) on</Tag>}
    </Space>
  )
  const actions = (s) => (
    <Space size={4} wrap>
      {onLoad && <Tooltip title="Open this strategy's index, rule and settings on the Signal backtest page."><Button size="small" icon={<UploadOutlined />} onClick={() => onLoad(s)}>Load</Button></Tooltip>}
      {pageSettings && <Popconfirm title={s.liveOrders
        ? (isAdmin ? `"${s.name}" places LIVE orders - replace it with the rule and settings on the page now? The new rule trades real money from its next minute.` : `Replace "${s.name}" with the page's rule and settings? Its live orders are turned off (an admin turns them on again).`)
        : `Replace "${s.name}" with the rule and settings on the page now?`} okText="Update" cancelText="No" onConfirm={() => act(s.id, () => updateStrategy(s.id, { settings: pageSettings }), `"${s.name}" updated - the live scan uses it from its next minute.`)}>
        <Button size="small" icon={<SaveOutlined />}>Update</Button>
      </Popconfirm>}
      <Button size="small" icon={<HistoryOutlined />} onClick={() => setHistoryOf(s)}>History</Button>
      <Popconfirm title={`Remove "${s.name}" from the list? Its history stays on the server (nothing is deleted).`} okText="Remove" cancelText="Keep" onConfirm={() => act(s.id, () => deleteStrategy(s.id), `"${s.name}" removed.`)}>
        <Button size="small" type="text" icon={<DeleteOutlined />} aria-label="Remove this strategy" title="Remove this strategy" />
      </Popconfirm>
    </Space>
  )
  // A plain block, not a flex Space: the rule's text must be held to the column's width to wrap / cut (in a flex item it
  // kept its whole length on one line and stretched the column thousands of pixels wide).
  const what = (s) => (
    <div style={{ minWidth: 0, maxWidth: '100%' }}>
      <div><Space size={6} wrap><Text strong style={{ fontSize: 13 }}>{s.name}</Text>{s.liveOrders && s.live && <Tag color="red" style={{ margin: 0 }}>LIVE orders</Tag>}</Space></div>
      <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
        {s.underlying}{s.settings?.tradeIn && s.settings.tradeIn !== s.underlying ? ` → traded in ${s.settings.tradeIn}` : ''} · {s.settings?.timeframe ?? 1}m{s.settings?.expiryDay === 'skip' ? ' · expiry day: not traded' : s.settings?.expiryDay && s.settings.expiryDay !== 'rule' ? ` · expiry day: ${s.settings.expiryDay}` : ''}{s.owner && s.owner.toLowerCase() !== me ? ` · ${s.owner}` : ''}
      </Text>
      <Paragraph type="secondary" style={{ fontSize: 11, margin: 0 }} ellipsis={{ rows: 2, tooltip: narrow ? false : ruleOf(s) }}>{ruleOf(s)}</Paragraph>
    </div>
  )
  const sorted = useMemo(() => sortStrategies(strategies), [strategies])
  const anyLive = strategies.some((s) => s.live)
  const title = (
    <Space size={8} wrap>
      <span>Saved strategies ({strategies.length})</span>
      {anyLive && liveScan && <Tag color={liveScan === 'running' ? 'green' : 'orange'} style={{ margin: 0 }}>{LIVE_STATE[liveScan] ?? liveScan}</Tag>}
    </Space>
  )
  const extra = onSave ? <Button size="small" type="primary" icon={<SaveOutlined />} onClick={onSave}>Save strategy</Button> : null
  let body
  if (!strategies.length) {
    body = <Text type="secondary" style={{ fontSize: 12 }}>No saved strategy yet - build a rule on the <Link to="/signal-backtest">Signal backtest</Link> page and save it there; it is scanned live from here every trading day, with Telegram alerts and a daily report.</Text>
  } else if (narrow) {
    body = sorted.map((s) => (
      <div key={s.id} className="oa-bg-run">
        {what(s)}
        {switches(s)}
        <TotalCell s={s} />
        <TodayCell s={s} today={today} />
        {actions(s)}
      </div>
    ))
  } else {
    body = (
      <Table
        size="small" rowKey="id" dataSource={sorted} pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
        // FIXED layout: the columns keep their widths and the strategy takes the rest - with the auto layout a long rule
        // stretched it and squeezed "Today" to a letter a line.
        tableLayout="fixed" scroll={{ x: 1000 }}
        columns={[
          { title: 'Strategy', key: 'what', render: (_, s) => what(s) },
          { title: 'Live scan', key: 'live', width: 230, render: (_, s) => switches(s) },
          { title: 'Total', key: 'total', width: 130, sorter: (a, b) => totalOf(a) - totalOf(b), defaultSortOrder: 'descend', sortDirections: ['descend', 'ascend'], render: (_, s) => <TotalCell s={s} /> },
          { title: 'Today', key: 'today', width: 260, render: (_, s) => <TodayCell s={s} today={today} /> },
          { title: '', key: 'actions', width: 300, render: (_, s) => actions(s) },
        ]}
      />
    )
  }
  return (
    <Card size="small" title={title} extra={extra}>
      {body}
      {historyOf && <StrategyHistoryModal strategy={historyOf} onClose={() => setHistoryOf(null)} />}
    </Card>
  )
}

/** A strategy's OWN LOTS for its live scan (`liveLots` on the server): its paper trades and P&L, and - with Live orders on - its Dhan
 *  orders. Empty = as before: the strategy's saved lots for the paper trades, the traded index's Trade settings lots for Dhan. Saved
 *  on Enter / leaving the box; a strategy placing live orders is changed by an admin only. */
export function LotsInput({ s, busy, locked, onSet }) {
  const [value, setValue] = useState(s.liveLots > 0 ? s.liveLots : null)
  useEffect(() => { setValue(s.liveLots > 0 ? s.liveLots : null) }, [s.liveLots])
  // The last lots sent, so Enter and the blur that follows it send one change, not two.
  const sent = useRef(s.liveLots > 0 ? s.liveLots : 0)
  useEffect(() => { sent.current = s.liveLots > 0 ? s.liveLots : 0 }, [s.liveLots])
  const commit = () => { const next = value > 0 ? Math.round(value) : 0; if (next !== sent.current) { sent.current = next; onSet(next) } }
  const fallback = s.settings?.lots ?? 1
  return (
    <Space size={6}>
      <Tooltip title={locked ? 'This strategy places live Dhan orders - an admin changes its lots.'
        : `Lots it trades live: its paper trades and P&L, and its Dhan orders when Live orders is on. Empty = as before (${fallback} lot${fallback === 1 ? '' : 's'} for the paper trades, Trade settings' lots for Dhan).`}>
        <Text style={{ fontSize: 12, whiteSpace: 'nowrap' }}>Lots</Text>
      </Tooltip>
      <InputNumber size="small" min={1} max={100} precision={0} value={value} placeholder={`default (${fallback})`} disabled={busy || locked}
        onChange={(v) => setValue(v)} onBlur={commit} onPressEnter={commit} style={{ width: 110 }} aria-label={`Lots for ${s.name}`} />
    </Space>
  )
}

/** The Signal backtest page's SAVED STRATEGIES BAR (the strategies and their live scan moved to the Live strategies page): save the
 *  page's rule and settings, put a saved one on the page, or update one with the page's - and a link to the Live strategies page. */
export function SavedStrategiesBar({ strategies, onSave, onLoad, pageSettings, refresh }) {
  const [picked, setPicked] = useState(null)
  const [busy, setBusy] = useState(false)
  const st = strategies.find((x) => x.id === picked) ?? null
  const update = async () => {
    if (!st) return
    setBusy(true)
    try { await updateStrategy(st.id, { settings: pageSettings }); message.success(`"${st.name}" updated - the live scan uses it from its next minute.`) }
    catch (err) { message.error(err.message) } finally { setBusy(false); refresh() }
  }
  return (
    <Card size="small" title={`Saved strategies (${strategies.length})`} extra={<Link to="/live-strategies"><Button size="small" icon={<RocketOutlined />}>Live strategies</Button></Link>}>
      <Space wrap size={[8, 8]} align="center">
        <Button size="small" type="primary" icon={<SaveOutlined />} onClick={onSave}>Save strategy</Button>
        <Select size="small" showSearch optionFilterProp="label" placeholder="A saved strategy" value={picked} onChange={setPicked} style={{ width: 240 }}
          options={sortStrategies(strategies).map((x) => ({ value: x.id, label: x.name }))} aria-label="A saved strategy" />
        <Button size="small" icon={<UploadOutlined />} disabled={!st} onClick={() => onLoad(st)}>Load</Button>
        <Popconfirm disabled={!st} okText="Update" cancelText="No" onConfirm={update}
          title={st?.liveOrders ? `"${st.name}" places LIVE orders - replace it with the rule and settings on the page now? Its live orders are turned off unless you are an admin.` : `Replace "${st?.name}" with the rule and settings on the page now?`}>
          <Button size="small" icon={<SaveOutlined />} disabled={!st} loading={busy}>Update with this page</Button>
        </Popconfirm>
        <Text type="secondary" style={{ fontSize: 12 }}>Live scan, lots, alerts, live orders and history: the <Link to="/live-strategies">Live strategies</Link> page.</Text>
      </Space>
    </Card>
  )
}
