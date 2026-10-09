import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Collapse, Space, Table, Tag, Typography, message } from 'antd'
import { UP_COLOR, DOWN_COLOR } from './shared.jsx'
import { formatVolume } from './OrderFlowCharts.jsx'
import { goChartingByBar, goChartingScale } from './goCharting.js'

const { Text, Paragraph } = Typography
const POLL_MS = 15_000
const IST_HHMM = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })

/** GoCharting's 1-minute bars for the index's day (polled while live), and how to scale them to our units. */
export function useGoCharting(underlying, date, enabled, live, minuteBars, lotSize) {
  const [state, setState] = useState({ bars: [], lastReceivedUtc: null, error: null })
  useEffect(() => {
    if (!enabled || !underlying || !date) return undefined
    let cancelled = false
    const load = () => fetch(`/api/gocharting/${underlying}/day/${date}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body) => { if (!cancelled) setState({ bars: body.bars ?? [], lastReceivedUtc: body.lastReceivedUtc ?? null, error: null }) })
      .catch((err) => { if (!cancelled) setState((s) => ({ ...s, error: err.message })) })
    load()
    const id = live ? setInterval(load, POLL_MS) : null
    return () => { cancelled = true; if (id) clearInterval(id) }
  }, [underlying, date, enabled, live])
  const scale = useMemo(() => goChartingScale(minuteBars, state.bars, lotSize), [minuteBars, state.bars, lotSize])
  return enabled ? { ...state, scale } : { bars: [], lastReceivedUtc: null, error: null, scale: 1 }
}

/** Ours vs GoCharting per footprint bar (newest first), and the setup for an admin. */
export function GoChartingPanel({ gc, bars, timeframe, lotSize, showLots, isAdmin, underlying }) {
  const byBar = useMemo(() => goChartingByBar(bars, gc.bars, timeframe, gc.scale), [bars, gc.bars, timeframe, gc.scale])
  const rows = useMemo(() => (bars ?? []).slice(-30).reverse().map((b) => {
    const t = Math.floor(new Date(b.time).getTime() / 60_000) * 60_000
    return { key: t, t, ours: b, g: byBar.get(t) ?? null }
  }), [bars, byBar])
  const fmt = (v) => (v == null ? '-' : `${v > 0 ? '+' : ''}${formatVolume(v, lotSize, showLots)}`)
  const col = (v) => (v == null ? undefined : v >= 0 ? UP_COLOR : DOWN_COLOR)
  const columns = [
    { title: 'Time', dataIndex: 't', width: 56, render: (t) => IST_HHMM.format(new Date(t)) },
    { title: 'Δ ours', key: 'd', render: (_, r) => <span style={{ color: col(r.ours.delta) }}>{fmt(r.ours.delta)}</span> },
    { title: 'Δ GoCharting', key: 'gd', render: (_, r) => <b style={{ color: col(r.g?.delta) }}>{fmt(r.g?.delta)}</b> },
    { title: 'ΣΔ ours', key: 'c', render: (_, r) => <span style={{ color: col(r.ours.cvd) }}>{fmt(r.ours.cvd)}</span> },
    { title: 'ΣΔ GoCharting', key: 'gc', render: (_, r) => <b style={{ color: col(r.g?.cvd) }}>{fmt(r.g?.cvd)}</b> },
    { title: 'Buy / sell (GoCharting)', key: 'bs', render: (_, r) => (r.g ? `${formatVolume(r.g.buy ?? 0, lotSize, showLots)} / ${formatVolume(r.g.sell ?? 0, lotSize, showLots)}` : '-') },
    { title: 'Vol ours / GC', key: 'v', render: (_, r) => `${formatVolume(r.ours.volume ?? 0, lotSize, showLots)} / ${r.g?.volume != null ? formatVolume(r.g.volume, lotSize, showLots) : '-'}` },
  ]
  const have = rows.filter((r) => r.g).length
  return (
    <Space direction="vertical" size={6} style={{ width: '100%', marginTop: 8 }}>
      <Space wrap size={8}>
        <Tag color={gc.bars.length ? 'success' : 'default'}>GoCharting: {gc.bars.length} bar(s) today</Tag>
        {gc.lastReceivedUtc && <Text type="secondary" style={{ fontSize: 11 }}>last message {IST_HHMM.format(new Date(gc.lastReceivedUtc))}</Text>}
        {gc.scale > 1 && <Text type="secondary" style={{ fontSize: 11 }}>GoCharting counts lots - scaled ×{gc.scale}</Text>}
        {gc.error && <Text type="warning" style={{ fontSize: 11 }}>{gc.error}</Text>}
      </Space>
      {gc.bars.length === 0
        ? <Alert type="info" showIcon message="No GoCharting bars for this day yet" description="They arrive once the bridge script runs as a GoCharting alert with the webhook below - one message per finished 1-minute bar. GoCharting sends only live bars (no history)." />
        : <Table size="small" pagination={false} columns={columns} dataSource={rows} scroll={{ y: 260 }} locale={{ emptyText: 'No bars' }}
            footer={() => <Text type="secondary" style={{ fontSize: 11 }}>{have} of the last {rows.length} bars have GoCharting figures. GoCharting gives per-bar totals from its tick-by-tick feed; its per-price footprint cells and volume profile are not available outside GoCharting.</Text>} />}
      {isAdmin && <GoChartingSetup underlying={underlying} />}
    </Space>
  )
}

function GoChartingSetup({ underlying }) {
  const [setup, setSetup] = useState(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    fetch(`/api/gocharting/setup?underlying=${underlying}`).then((r) => (r.ok ? r.json() : null)).then(setSetup).catch(() => {})
  }, [open, underlying])
  const url = setup ? `${window.location.origin}${setup.webhookPath}` : ''
  const copy = (text, what) => navigator.clipboard?.writeText(text).then(() => message.success(`${what} copied`)).catch(() => message.error('Could not copy'))
  return (
    <Collapse size="small" onChange={(keys) => setOpen(keys.length > 0)} items={[{
      key: 'setup', label: 'Set up GoCharting (once per index)',
      children: !setup ? <Text type="secondary">Loading…</Text> : (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Text style={{ fontSize: 12 }}>1. In GoCharting open a <b>1-minute</b> chart of the {underlying} future. 2. Scripts → new script → paste this script → add it to the chart.
            3. Create an alert on the script (it raises one per bar), and under Delivery → Webhook paste the URL below. Keep the alert running.</Text>
          <Space wrap>
            <Text code style={{ fontSize: 11, wordBreak: 'break-all' }}>{url}</Text>
            <Button size="small" onClick={() => copy(url, 'Webhook URL')}>Copy URL</Button>
            <Button size="small" onClick={() => copy(setup.script, 'Script')}>Copy script</Button>
          </Space>
          <Paragraph code style={{ fontSize: 11, whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto', margin: 0 }}>{setup.script}</Paragraph>
          <Text type="secondary" style={{ fontSize: 11 }}>
            The URL holds a secret - do not share it. This server must be reachable from the internet over HTTPS for GoCharting to post to it.
            {setup.lastReceivedUtc ? ` Last message ${new Date(setup.lastReceivedUtc).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}${setup.lastError ? ` - not understood: ${setup.lastError}` : ' - OK'}.` : ' Nothing received yet.'}
          </Text>
        </Space>
      ),
    }]} />
  )
}
