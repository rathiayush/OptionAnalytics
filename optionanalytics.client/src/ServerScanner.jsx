import { useEffect, useState } from 'react'
import { Alert, Card, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd'
import { UP_COLOR, DOWN_COLOR } from './shared.jsx'
import { refreshTradeSettings } from './tradeDefaults.js'

const { Text } = Typography
const POLL_MS = 10_000
const IST_HHMM = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })
const hhmm = (ms) => (ms ? IST_HHMM.format(new Date(ms)) : '-')
const rupee = (v) => `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v ?? 0)).toLocaleString('en-IN')}`

/**
 * The strategy scanner the SERVER runs for NIFTY, BANKNIFTY and SENSEX at once (scanner-runner, started by
 * the server itself - no browser needed): whether it is running, and per index today's signals and paper
 * trades. Paper only. It uses this page's scanner settings (an admin's are synced to it as they change).
 */
export function ServerScannerCard({ isAdmin, focus }) {
  const [state, setState] = useState(null)
  const [error, setError] = useState(null)
  const load = () => fetch('/api/scanner-runner/status')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((s) => { setState(s); setError(null) })
    .catch((err) => setError(err.message))
  useEffect(() => {
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [])

  const setEnabled = (underlying, on) => fetch('/api/scanner-runner/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: { [underlying]: on } }),
  }).then(() => { load(); refreshTradeSettings() }).catch(() => {})

  const process = state?.process
  const indices = state?.status?.indices ?? []
  const running = process?.state === 'running' && !state?.stale
  const headline = !state ? 'Loading…'
    : running ? `Running · live feed ${state.status?.connection ?? '?'} · reported ${hhmm(Date.parse(state.reportedUtc))}`
      : `Not running (${process?.state ?? 'unknown'}${process?.note ? `: ${process.note}` : ''})${state?.stale && process?.state === 'running' ? ' - no report in the last minute' : ''}`

  const signalColumns = [
    { title: 'Time', dataIndex: 't', width: 56, render: hhmm },
    { title: 'Strategy', key: 's', render: (_, s) => <span>#{s.no} {s.name}{!s.alerted && <Tag style={{ marginLeft: 4, fontSize: 10 }}>not alerted</Tag>}</span> },
    { title: 'Side', dataIndex: 'side', width: 62, render: (v) => <Text style={{ color: v === 'LONG' ? UP_COLOR : DOWN_COLOR, fontSize: 12 }}>{v}</Text> },
    { title: 'Entry', dataIndex: 'entry', width: 72, render: (v) => v?.toFixed(1) },
    { title: 'Result', key: 'r', width: 92, render: (_, s) => (s.status === 'open' ? <Tag color="processing">open</Tag> : <Text style={{ color: (s.r ?? 0) >= 0 ? UP_COLOR : DOWN_COLOR, fontSize: 12 }}>{s.status} {s.r != null ? `${s.r >= 0 ? '+' : ''}${s.r.toFixed(2)}R` : ''}</Text>) },
  ]
  const tradeColumns = [
    { title: 'Time', dataIndex: 'entryTime', width: 56, render: hhmm },
    { title: 'Paper trade', key: 't', render: (_, r) => <span>{r.action} {r.strike} {r.side} ×{r.lots} <Text type="secondary" style={{ fontSize: 11 }}>#{r.no}</Text></span> },
    { title: 'Premium', key: 'p', width: 110, render: (_, r) => `${r.premium?.toFixed(1)} → ${r.current != null ? r.current.toFixed(1) : '-'}` },
    { title: 'P&L', dataIndex: 'rupees', width: 84, render: (v) => <Text strong style={{ color: (v ?? 0) >= 0 ? UP_COLOR : DOWN_COLOR, fontSize: 12 }}>{rupee(v)}</Text> },
    { title: 'Exit', dataIndex: 'exitReason', width: 120, render: (v, r) => (r.exitTime ? <Text type="secondary" style={{ fontSize: 11 }}>{hhmm(r.exitTime)} {v}</Text> : <Tag color="processing">open</Tag>) },
  ]

  return (
    <Card
      size="small"
      title={<Space size={8}><span>Server scanner · NIFTY, BANKNIFTY, SENSEX</span><Tag color={running ? 'success' : 'default'}>{running ? '● running' : '○ off'}</Tag><Tag>paper only</Tag></Space>}
      extra={<Text type="secondary" style={{ fontSize: 11 }}>{headline}</Text>}
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          The same scanner as above, run by the server for all three indices - with no browser open. Which indices it scans, their lots,
          SL / target / trail and what it does on an alert are on the <a href="/trade-settings">Trade settings</a> page; the strategies, their
          filters and the futures trailing stop follow this page&apos;s scanner settings{isAdmin ? ', synced from here as you change them' : ''}. Its alerts and paper
          trades go to Telegram tagged [Server]; its record is kept apart from this page&apos;s (
          <a href="/api/scanner-log/server-signals">server-signals.csv</a>, <a href="/api/scanner-log/server-trades">server-trades.csv</a>) so the two can be compared.
          It places no real orders.
        </Text>
        {error && <Alert type="warning" showIcon message={`Server scanner status not available: ${error}`} />}
        {indices.map((ix) => (
          <div key={ix.underlying} style={{ border: `1px solid ${ix.underlying === focus ? '#1668dc' : '#ffffff1a'}`, borderRadius: 6, padding: 8 }}>
            <Space wrap size={10} style={{ marginBottom: 6 }}>
              <Text strong>{ix.underlying}</Text>
              {isAdmin
                ? <Tooltip title="Scan this index on the server"><Switch size="small" checked={ix.enabled} onChange={(v) => setEnabled(ix.underlying, v)} /></Tooltip>
                : <Tag>{ix.enabled ? 'on' : 'off'}</Tag>}
              {ix.enabled && (ix.ready ? <Tag color="success">data live{ix.clockUtc ? ` · ${hhmm(Date.parse(ix.clockUtc))}` : ''}</Tag> : <Tag color="warning">waiting for data</Tag>)}
              {ix.contract && <Text type="secondary" style={{ fontSize: 11 }}>{ix.contract}</Text>}
              <Text style={{ fontSize: 12 }}>{ix.signals?.length ?? 0} signal(s) · {ix.trades?.length ?? 0} paper trade(s) · <Text strong style={{ color: (ix.pnl ?? 0) >= 0 ? UP_COLOR : DOWN_COLOR }}>{rupee(ix.pnl)}</Text></Text>
              {ix.coolingOff > 0 && <Tag>{ix.coolingOff} cooling off</Tag>}
            </Space>
            {ix.error && <Text type="warning" style={{ fontSize: 11, display: 'block' }}>{ix.error}</Text>}
            {ix.signals?.length > 0 && <Table size="small" pagination={false} rowKey={(s) => `${s.id}-${s.t}`} columns={signalColumns} dataSource={[...ix.signals].reverse()} scroll={{ y: 180 }} />}
            {ix.trades?.length > 0 && <Table size="small" pagination={false} rowKey="key" columns={tradeColumns} dataSource={[...ix.trades].reverse()} scroll={{ y: 180 }} style={{ marginTop: 6 }} />}
          </div>
        ))}
      </Space>
    </Card>
  )
}

// What the server scanner runs with: this page's scanner settings, the SL / target / trail of each index
// and the strategies alerted - saved to the server (admins) whenever they change.
let lastSent = ''
let timer = null
export function syncServerScanner(payload) {
  const json = JSON.stringify(payload)
  if (json === lastSent) return
  clearTimeout(timer)
  timer = setTimeout(() => {
    fetch('/api/scanner-runner/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: json })
      .then((r) => { if (r.ok) lastSent = json })
      .catch(() => { /* sent again on the next change */ })
  }, 2000)
}
