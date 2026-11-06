import { useEffect, useMemo, useState } from 'react'
import { Button, Card, Checkbox, Input, Modal, Popconfirm, Space, Switch, Table, Tabs, Tag, Tooltip, Typography, message } from 'antd'
import { DeleteOutlined, DownloadOutlined, HistoryOutlined, SaveOutlined, UploadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { DOWN_COLOR, UP_COLOR, useAuth, useMediaQuery } from './shared.jsx'
import { RULE_ACTIONS, normalizeRule, ruleText } from './signalBacktest.js'
import { createStrategy, deleteStrategy, historyCsvUrl, strategyHistory, updateStrategy } from './signalStrategiesApi.js'
import { orderTrades } from './signalStrategyHistory.js'

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
const OPEN_TAG = <Tag color="processing" style={{ margin: 0 }}>open</Tag>
// The strategy's trades AS EACH SIGNAL CAME (the server keeps a row at the entry - open - and fills it in at the exit):
// entry time and premium, its stop-loss and target prices, the exit's time, price and reason, the P&L.
const tradeColumns = [
  { title: 'Day', dataIndex: 'date', key: 'date', width: 80, render: (v) => dayjs(v).format('D MMM') },
  { title: 'Trade', key: 'trade', width: 160, render: (_, t) => `${t.action} ${t.option}${t.side === 'mirror' ? ' (mirror)' : ''}` },
  { title: 'Entry', key: 'entry', width: 110, render: (_, t) => `${t.entryTime} · ${price(t.entry)}` },
  { title: 'SL', dataIndex: 'sl', key: 'sl', width: 70, align: 'right', render: price },
  { title: 'Target', dataIndex: 'target', key: 'target', width: 70, align: 'right', render: price },
  { title: 'Exit', key: 'exit', width: 110, render: (_, t) => (t.status === 'open' || (!t.exitTime && !t.exit) ? OPEN_TAG : `${t.exitTime} · ${price(t.exit)}`) },
  { title: 'Why out', dataIndex: 'exitReason', key: 'reason', width: 130 },
  { title: 'Gross', dataIndex: 'gross', key: 'gross', width: 90, align: 'right', render: (v) => <span style={{ color: pnlColor(num(v)) }}>{rupees(num(v))}</span> },
  { title: 'Charges', dataIndex: 'charges', key: 'charges', width: 80, align: 'right', render: (v) => rupees(num(v)) },
  { title: 'Net', dataIndex: 'net', key: 'net', width: 90, align: 'right', render: (v) => <Text strong style={{ color: pnlColor(num(v)) }}>{rupees(num(v))}</Text> },
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
  { title: '', dataIndex: 'kind', key: 'kind', width: 70, render: (v) => <Tag color={v === 'entry' ? 'blue' : 'default'} style={{ margin: 0 }}>{v}</Tag> },
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
        <Text strong style={{ fontSize: 13 }}>{dayjs(t.date).format('D MMM')} · {t.action} {t.option}{t.side === 'mirror' ? <Text type="secondary" style={small}> (mirror)</Text> : null}</Text>
        {t.status === 'open' || (!t.exitTime && !t.exit) ? OPEN_TAG : <Text strong style={{ color: pnlColor(num(t.net)) }}>{rupees(num(t.net))}</Text>}
      </Space>
      <Text style={small}>In {t.entryTime} @ {price(t.entry)} · SL {price(t.sl)} · Target {price(t.target)}</Text>
      {(t.exitTime || t.exit) && <Text style={small}>Out {t.exitTime} @ {price(t.exit)} · {t.exitReason}{num(t.charges) > 0 ? ` · charges ${rupees(num(t.charges))}` : ''}</Text>}
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
            { key: 'trades', label: `Trades (${history?.trades?.length ?? 0})`, children: narrow ? <TradeBlocks rows={history?.trades ?? []} /> : <Table size="small" rowKey={(t, k) => `${t.date}|${t.entryTime}|${t.side}|${k}`} columns={tradeColumns} dataSource={history?.trades ?? []} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 1320 }} /> },
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

function LastDay({ s, today }) {
  const d = s.lastDay
  return (
    <Space direction="vertical" size={0}>
      {d
        ? <Text style={{ fontSize: 12 }}>{dayjs(d.date).format('ddd D MMM')}: <Text strong style={{ color: pnlColor(num(d.net)) }}>{rupees(num(d.net))}</Text> · {d.trades} trade{d.trades === '1' ? '' : 's'}</Text>
        : <Text type="secondary" style={{ fontSize: 12 }}>{s.live ? 'No day reported yet' : 'Not scanned live'}</Text>}
      {s.live && s.eventsToday > 0 && <Text type="secondary" style={{ fontSize: 11 }}>Today ({dayjs(today).format('D MMM')}): {s.eventsToday} alert{s.eventsToday === 1 ? '' : 's'} so far</Text>}
    </Space>
  )
}

/** The saved strategies: what each is, its live switches, its last day, and Load / Update / History / Remove. */
export function SavedStrategiesCard({ strategies, today, liveScan, refresh, pageSettings, onLoad, onSave }) {
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
          <span>Every fresh entry of its live scan - the rule's and the mirror's - places a live <b>super order</b> on Dhan for the {traded} option it trades: the lots set for {traded} on <b>Trade settings</b>, its stop-loss / target as the legs (Trade settings' where it has none), at the Trade settings' slippage.</span>
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
      <Tooltip title="Put this strategy's index, rule and settings on the page."><Button size="small" icon={<UploadOutlined />} onClick={() => onLoad(s)}>Load</Button></Tooltip>
      <Popconfirm title={s.liveOrders
        ? (isAdmin ? `"${s.name}" places LIVE orders - replace it with the rule and settings on the page now? The new rule trades real money from its next minute.` : `Replace "${s.name}" with the page's rule and settings? Its live orders are turned off (an admin turns them on again).`)
        : `Replace "${s.name}" with the rule and settings on the page now?`} okText="Update" cancelText="No" onConfirm={() => act(s.id, () => updateStrategy(s.id, { settings: pageSettings }), `"${s.name}" updated - the live scan uses it from its next minute.`)}>
        <Button size="small" icon={<SaveOutlined />}>Update</Button>
      </Popconfirm>
      <Button size="small" icon={<HistoryOutlined />} onClick={() => setHistoryOf(s)}>History</Button>
      <Popconfirm title={`Remove "${s.name}" and its history?`} okText="Remove" cancelText="Keep" onConfirm={() => act(s.id, () => deleteStrategy(s.id), `"${s.name}" removed.`)}>
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
  const anyLive = strategies.some((s) => s.live)
  const title = (
    <Space size={8} wrap>
      <span>Saved strategies ({strategies.length})</span>
      {anyLive && liveScan && <Tag color={liveScan === 'running' ? 'green' : 'orange'} style={{ margin: 0 }}>{LIVE_STATE[liveScan] ?? liveScan}</Tag>}
    </Space>
  )
  const extra = <Button size="small" type="primary" icon={<SaveOutlined />} onClick={onSave}>Save strategy</Button>
  let body
  if (!strategies.length) {
    body = <Text type="secondary" style={{ fontSize: 12 }}>Save the rule and settings on the page as a strategy - load it back any time, run it in the background, and scan it live every trading day with Telegram alerts and a daily report.</Text>
  } else if (narrow) {
    body = strategies.map((s) => (
      <div key={s.id} className="oa-bg-run">
        {what(s)}
        {switches(s)}
        <LastDay s={s} today={today} />
        {actions(s)}
      </div>
    ))
  } else {
    body = (
      <Table
        size="small" rowKey="id" dataSource={strategies} pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }}
        // FIXED layout: the columns keep their widths and the strategy takes the rest - with the auto layout a long rule
        // stretched it and squeezed "Last day" to a letter a line.
        tableLayout="fixed" scroll={{ x: 1000 }}
        columns={[
          { title: 'Strategy', key: 'what', render: (_, s) => what(s) },
          { title: 'Live scan', key: 'live', width: 210, render: (_, s) => switches(s) },
          { title: 'Last day', key: 'last', width: 230, render: (_, s) => <LastDay s={s} today={today} /> },
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
