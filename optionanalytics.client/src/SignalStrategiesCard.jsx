import { useEffect, useState } from 'react'
import { Button, Card, Checkbox, Input, Modal, Popconfirm, Space, Switch, Table, Tabs, Tag, Tooltip, Typography, message } from 'antd'
import { DeleteOutlined, DownloadOutlined, HistoryOutlined, SaveOutlined, UploadOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { DOWN_COLOR, UP_COLOR, useAuth, useMediaQuery } from './shared.jsx'
import { RULE_ACTIONS, normalizeRule, ruleText } from './signalBacktest.js'
import { createStrategy, deleteStrategy, historyCsvUrl, strategyHistory, updateStrategy } from './signalStrategiesApi.js'

// The Signal backtest's SAVED STRATEGIES on the page: save the rule and its settings by name (on the server, CSV), load one
// back, update it with the page's settings, remove it - and its daily LIVE scan: "Live" scans it on every trading day on
// the server (the backtest's own trades, paper), "Alerts" sends each entry / exit to Telegram, "Daily report" the day's
// trades and P&L after the close; "History" shows what the live scan kept (and its CSV files).

const { Text } = Typography
const rupees = (v) => (Number.isFinite(v) ? `${v < 0 ? '−' : ''}₹${Math.round(Math.abs(v)).toLocaleString('en-IN')}` : '—')
const pnlColor = (v) => (v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined)
const num = (v) => (v === '' || v == null ? NaN : Number(v))
const ACTION_LABEL = Object.fromEntries(RULE_ACTIONS.map((a) => [a.value, a.label]))
const ruleOf = (s) => { const r = normalizeRule(s.settings?.rule); return ruleText(r.lines, r.action, r.logic) }
const LIVE_STATE = { running: 'Live scan running', missing: 'Live scan not installed on the server', off: 'Live scan turned off on the server', exited: 'Live scan restarting', failed: 'Live scan failed to start', starting: 'Live scan starting' }

/** "Save strategy": a name and the live switches for the rule and settings on the page. Mounted on open. */
export function SaveStrategyModal({ settings, ruleSummary, onClose, onSaved }) {
  const [name, setName] = useState(() => `${settings.underlying} · ${ACTION_LABEL[settings.rule?.action] ?? ''}${settings.rule?.mirror ? ' + mirror' : ''}`)
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
        <Text style={{ fontSize: 12 }}><Text strong style={{ fontSize: 12 }}>{settings.underlying}</Text> · {ruleSummary}</Text>
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
  { title: 'Day', dataIndex: 'date', key: 'date', width: 110, render: (v) => dayjs(v).format('ddd D MMM') },
  { title: 'Trades', dataIndex: 'trades', key: 'trades', width: 70, align: 'right' },
  { title: 'Win %', dataIndex: 'winRate', key: 'winRate', width: 70, align: 'right', render: (v) => (Number.isFinite(num(v)) ? Math.round(num(v)) : '—') },
  { title: 'Net', dataIndex: 'net', key: 'net', width: 100, align: 'right', render: (v) => <Text strong style={{ color: pnlColor(num(v)) }}>{rupees(num(v))}</Text> },
  { title: 'Charges', dataIndex: 'charges', key: 'charges', width: 90, align: 'right', render: (v) => rupees(num(v)) },
  { title: 'Signals', dataIndex: 'signals', key: 'signals', width: 70, align: 'right' },
]
const tradeColumns = [
  { title: 'Day', dataIndex: 'date', key: 'date', width: 90, render: (v) => dayjs(v).format('D MMM') },
  { title: 'Trade', key: 'trade', width: 150, render: (_, t) => `${t.action} ${t.option}${t.side === 'mirror' ? ' (mirror)' : ''}` },
  { title: 'Entry', key: 'entry', width: 110, render: (_, t) => `${t.entryTime} · ${t.entry}` },
  { title: 'Exit', key: 'exit', width: 110, render: (_, t) => `${t.exitTime} · ${t.exit}` },
  { title: 'Why out', dataIndex: 'exitReason', key: 'reason', width: 140 },
  { title: 'Net', dataIndex: 'net', key: 'net', width: 90, align: 'right', render: (v) => <Text strong style={{ color: pnlColor(num(v)) }}>{rupees(num(v))}</Text> },
  { title: 'At the signal', dataIndex: 'why', key: 'why', width: 320, ellipsis: { showTitle: false }, render: (v) => <Tooltip title={v}><span>{v}</span></Tooltip> },
]
const eventColumns = [
  { title: 'Sent', dataIndex: 'timeUtc', key: 'time', width: 120, render: (v) => dayjs(v).format('D MMM HH:mm') },
  { title: '', dataIndex: 'kind', key: 'kind', width: 70, render: (v) => <Tag color={v === 'entry' ? 'blue' : 'default'} style={{ margin: 0 }}>{v}</Tag> },
  { title: 'Message', dataIndex: 'text', key: 'text', render: (v) => <Text style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{v}</Text> },
]

/** What the live scan kept for a strategy: the days, their trades and the entries / exits sent - and the CSV files. */
export function StrategyHistoryModal({ strategy, onClose }) {
  const [history, setHistory] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let alive = true
    strategyHistory(strategy.id).then((h) => alive && setHistory(h)).catch((err) => alive && setError(err.message))
    return () => { alive = false }
  }, [strategy.id])
  const days = history?.days ?? []
  const total = days.reduce((a, d) => a + (num(d.net) || 0), 0)
  const csv = (kind, label) => <Button size="small" icon={<DownloadOutlined />} href={historyCsvUrl(strategy.id, kind)}>{label}</Button>
  return (
    <Modal open title={`History - ${strategy.name}`} onCancel={onClose} footer={null} width={Math.min(1000, typeof window === 'undefined' ? 1000 : window.innerWidth - 16)} destroyOnHidden>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {error && <Text type="danger">{error}</Text>}
        <Space wrap size={[12, 6]}>
          <Text>{days.length} day{days.length === 1 ? '' : 's'} scanned live · net <Text strong style={{ color: pnlColor(total) }}>{rupees(total)}</Text></Text>
          {csv('days', 'Days CSV')}{csv('trades', 'Trades CSV')}{csv('events', 'Alerts CSV')}
        </Space>
        <Tabs
          size="small"
          items={[
            { key: 'days', label: `Days (${days.length})`, children: <Table size="small" rowKey="date" columns={dayColumns} dataSource={days} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 520 }} loading={!history && !error} /> },
            { key: 'trades', label: `Trades (${history?.trades?.length ?? 0})`, children: <Table size="small" rowKey={(t, k) => `${t.date}|${t.entryTime}|${t.side}|${k}`} columns={tradeColumns} dataSource={history?.trades ?? []} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 1000 }} /> },
            { key: 'events', label: `Alerts (${history?.events?.length ?? 0})`, children: <Table size="small" rowKey={(e, k) => `${e.key}|${k}`} columns={eventColumns} dataSource={history?.events ?? []} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 600 }} /> },
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
  const act = async (id, fn, done) => {
    setBusyId(id)
    try { await fn(); if (done) message.success(done) } catch (err) { message.error(err.message) } finally { setBusyId(null); refresh() }
  }
  const toggle = (s, key, value) => act(s.id, () => updateStrategy(s.id, { [key]: value }),
    key === 'live' ? (value ? `"${s.name}" is scanned live from the next minute of a trading session.` : `"${s.name}" is no longer scanned live.`) : null)
  const switches = (s) => (
    <Space direction="vertical" size={2}>
      <Space size={6}><Switch size="small" checked={s.live} loading={busyId === s.id} onChange={(v) => toggle(s, 'live', v)} /><Text style={{ fontSize: 12 }}>Live</Text></Space>
      <Space size={12} style={{ paddingLeft: 2 }}>
        <Checkbox checked={s.alerts} disabled={!s.live} onChange={(e) => toggle(s, 'alerts', e.target.checked)}><Text style={{ fontSize: 12, whiteSpace: 'nowrap' }}>Alerts</Text></Checkbox>
        <Checkbox checked={s.dailyReport} disabled={!s.live} onChange={(e) => toggle(s, 'dailyReport', e.target.checked)}><Text style={{ fontSize: 12, whiteSpace: 'nowrap' }}>Daily report</Text></Checkbox>
      </Space>
    </Space>
  )
  const actions = (s) => (
    <Space size={4} wrap>
      <Tooltip title="Put this strategy's index, rule and settings on the page."><Button size="small" icon={<UploadOutlined />} onClick={() => onLoad(s)}>Load</Button></Tooltip>
      <Popconfirm title={`Replace "${s.name}" with the rule and settings on the page now?`} okText="Update" cancelText="No" onConfirm={() => act(s.id, () => updateStrategy(s.id, { settings: pageSettings }), `"${s.name}" updated - the live scan uses it from its next minute.`)}>
        <Button size="small" icon={<SaveOutlined />}>Update</Button>
      </Popconfirm>
      <Button size="small" icon={<HistoryOutlined />} onClick={() => setHistoryOf(s)}>History</Button>
      <Popconfirm title={`Remove "${s.name}" and its history?`} okText="Remove" cancelText="Keep" onConfirm={() => act(s.id, () => deleteStrategy(s.id), `"${s.name}" removed.`)}>
        <Button size="small" type="text" icon={<DeleteOutlined />} aria-label="Remove this strategy" title="Remove this strategy" />
      </Popconfirm>
    </Space>
  )
  const what = (s) => (
    <Space direction="vertical" size={0} style={{ maxWidth: '100%' }}>
      <Text strong style={{ fontSize: 13 }}>{s.name}</Text>
      <Text type="secondary" style={{ fontSize: 11 }}>
        {s.underlying} · {s.settings?.timeframe ?? 1}m{s.settings?.expiryDay && s.settings.expiryDay !== 'rule' ? ` · expiry day: ${s.settings.expiryDay}` : ''}{s.owner && s.owner.toLowerCase() !== me ? ` · ${s.owner}` : ''}
      </Text>
      <Text type="secondary" style={{ fontSize: 11 }} ellipsis={{ tooltip: ruleOf(s) }}>{ruleOf(s)}</Text>
    </Space>
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
        size="small" rowKey="id" dataSource={strategies} pagination={{ pageSize: 10, hideOnSinglePage: true, showSizeChanger: false }} scroll={{ x: 1100 }}
        columns={[
          { title: 'Strategy', key: 'what', render: (_, s) => what(s) },
          { title: 'Live scan', key: 'live', width: 230, render: (_, s) => switches(s) },
          { title: 'Last day', key: 'last', width: 260, render: (_, s) => <LastDay s={s} today={today} /> },
          { title: '', key: 'actions', width: 320, render: (_, s) => actions(s) },
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
