import { useState } from 'react'
import { Alert, Card, Segmented, Space, Switch, Table, Tag, Tooltip, Typography } from 'antd'
import { STRATEGY_BY_ID } from './strategyEngine.js'
import { UP_COLOR, DOWN_COLOR } from './shared.jsx'
import { refreshTradeSettings } from './tradeDefaults.js'
import { useScannerStatus } from './scannerEvents.js'

const { Text } = Typography
const IST_HHMM = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })
const hhmm = (ms) => (ms ? IST_HHMM.format(new Date(ms)) : '-')
const rupee = (v) => `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v ?? 0)).toLocaleString('en-IN')}`

/**
 * The strategy scanner the SERVER runs for NIFTY, BANKNIFTY and SENSEX at once (scanner-runner, started by
 * the server itself - no browser needed): whether it is running, and per index today's signals and paper
 * trades. Paper only. It uses this page's scanner settings (an admin's are synced to it as they change).
 */
export function ServerScannerCard({ isAdmin, focus }) {
  // Pushed by the server the moment a signal fires or a trade opens / exits, and with the P&L every 5 s (scannerEvents.js).
  const { status: state, error, reload: load } = useScannerStatus()
  // Which kind of strategy to watch: the order-flow ones (futures + OI, the Order Flow page's) or the option ones
  // (spot + options). It filters the signals AND the trades of every index at once.
  const [kind, setKind] = useState('all')

  const setEnabled = (underlying, on) => fetch('/api/scanner-runner/config', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: { [underlying]: on } }),
  }).then(() => { load(); refreshTradeSettings() }).catch(() => {})

  const process = state?.process
  const indices = state?.status?.indices ?? []
  const running = process?.state === 'running' && !state?.stale
  const headline = !state ? 'Loading…'
    : running ? `Running · live feed ${state.status?.connection ?? '?'} · reported ${hhmm(Date.parse(state.reportedUtc))}`
      : `Not running (${process?.state ?? 'unknown'}${process?.note ? `: ${process.note}` : ''})${state?.stale && process?.state === 'running' ? ' - no report in the last minute' : ''}`

  // Newest FIRST, always - the signal that just fired is the one being looked at, and it is marked as the newest.
  const newestFirst = (rows, timeOf) => [...(rows ?? [])].sort((a, b) => (timeOf(b) ?? 0) - (timeOf(a) ?? 0))
  const isSpot = (id) => !!STRATEGY_BY_ID[id]?.spot
  const ofKind = (spot) => kind === 'all' || (kind === 'option') === !!spot
  const newestRow = { background: '#1668dc1f' }

  const signalColumns = [
    { title: 'Time', dataIndex: 't', width: 76, render: (v, _r, i) => <span>{hhmm(v)}{i === 0 && <Tag color="blue" style={{ marginLeft: 4, fontSize: 9, lineHeight: '14px', padding: '0 3px' }}>new</Tag>}</span> },
    { title: 'Strategy', key: 's', render: (_, s) => <span><Tag color={s.spot ? 'purple' : 'cyan'} style={{ fontSize: 9, marginRight: 4 }}>{s.spot ? 'option' : 'order flow'}</Tag>#{s.no} {s.name}{!s.alerted && <Tag style={{ marginLeft: 4, fontSize: 10 }}>not alerted</Tag>}</span> },
    { title: 'Side', dataIndex: 'side', width: 62, render: (v) => <Text style={{ color: v === 'LONG' ? UP_COLOR : DOWN_COLOR, fontSize: 12 }}>{v}</Text> },
    { title: 'Entry', dataIndex: 'entry', width: 72, render: (v) => v?.toFixed(1) },
    { title: 'Result', key: 'r', width: 92, render: (_, s) => (s.status === 'open' ? <Tag color="processing">open</Tag> : <Text style={{ color: (s.r ?? 0) >= 0 ? UP_COLOR : DOWN_COLOR, fontSize: 12 }}>{s.status} {s.r != null ? `${s.r >= 0 ? '+' : ''}${s.r.toFixed(2)}R` : ''}</Text>) },
  ]
  const tradeColumns = [
    { title: 'Time', dataIndex: 'entryTime', width: 76, render: (v, _r, i) => <span>{hhmm(v)}{i === 0 && <Tag color="blue" style={{ marginLeft: 4, fontSize: 9, lineHeight: '14px', padding: '0 3px' }}>new</Tag>}</span> },
    { title: 'Option trade', key: 't', render: (_, r) => <span>{r.live && <Tag color="volcano" style={{ marginRight: 4, fontSize: 10 }}>LIVE</Tag>}{r.action} {r.strike} {r.side} ×{r.lots} <Text type="secondary" style={{ fontSize: 11 }}>#{r.no}</Text></span> },
    { title: 'Premium', key: 'p', width: 110, render: (_, r) => `${r.premium?.toFixed(1)} → ${r.current != null ? r.current.toFixed(1) : '-'}` },
    { title: 'P&L', dataIndex: 'rupees', width: 84, render: (v) => <Text strong style={{ color: (v ?? 0) >= 0 ? UP_COLOR : DOWN_COLOR, fontSize: 12 }}>{rupee(v)}</Text> },
    { title: 'Exit', dataIndex: 'exitReason', width: 120, render: (v, r) => (r.exitTime ? <Text type="secondary" style={{ fontSize: 11 }}>{hhmm(r.exitTime)} {v}</Text> : <Tag color="processing">open</Tag>) },
  ]

  return (
    <Card
      size="small"
      title={<Space size={8}><span>Server scanner today · NIFTY, BANKNIFTY, SENSEX</span><Tag color={running ? 'success' : 'default'}>{running ? '● running' : '○ off'}</Tag></Space>}
      extra={(
        <Space size={8} wrap>
          <Tooltip title="Which strategies to watch: the order-flow ones (futures + OI) or the option ones (spot + options). It filters the signals and the trades of every index.">
            <Segmented
              size="small" value={kind} onChange={setKind} aria-label="Strategy kind"
              options={[{ value: 'all', label: 'All' }, { value: 'orderflow', label: 'Order flow' }, { value: 'option', label: 'Options' }]}
            />
          </Tooltip>
          <Text type="secondary" style={{ fontSize: 11 }}>{headline}</Text>
        </Space>
      )}
    >
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Every strategy, run by the server for all three indices - with no browser open: today&apos;s signals and the option trades it took (paper;
          live on an index switched to Live today, for the strategies on its live list). Which indices it scans, their lots, SL / target / trail and
          what an alert trades are on the <a href="/trade-settings">Trade settings</a> page; the strategies alerted, their filters and the trailing stop
          are the scanner settings on this page. Alerts and trades go to Telegram tagged [Server]; the record:
          {' '}<a href="/api/scanner-log/server-signals">server-signals.csv</a>, <a href="/api/scanner-log/server-trades">server-trades.csv</a> (Trades → Scanner record).
        </Text>
        {error && <Alert type="warning" showIcon message={`Server scanner status not available: ${error}`} />}
        {indices.map((ix) => {
          // The kind chosen, newest first - and the index's P&L for what is shown.
          const signals = newestFirst((ix.signals ?? []).filter((x) => ofKind(x.spot)), (x) => x.t)
          const trades = newestFirst((ix.trades ?? []).filter((r) => ofKind(isSpot(r.strategy))), (r) => r.entryTime)
          const pnl = kind === 'all' ? ix.pnl : trades.reduce((sum, r) => sum + (r.rupees ?? 0), 0)
          return (
          <div key={ix.underlying} style={{ border: `1px solid ${ix.underlying === focus ? '#1668dc' : '#ffffff1a'}`, borderRadius: 6, padding: 8 }}>
            <Space wrap size={10} style={{ marginBottom: 6 }}>
              <Text strong>{ix.underlying}</Text>
              {isAdmin
                ? <Tooltip title="Scan this index on the server"><Switch size="small" checked={ix.enabled} onChange={(v) => setEnabled(ix.underlying, v)} /></Tooltip>
                : <Tag>{ix.enabled ? 'on' : 'off'}</Tag>}
              {ix.enabled && (ix.ready ? <Tag color="success">data live{ix.clockUtc ? ` · ${hhmm(Date.parse(ix.clockUtc))}` : ''}</Tag> : <Tag color="warning">waiting for data</Tag>)}
              {ix.contract && <Text type="secondary" style={{ fontSize: 11 }}>{ix.contract}</Text>}
              <Text style={{ fontSize: 12 }}>{signals.length} signal(s) · {trades.length} option trade(s) · <Text strong style={{ color: (pnl ?? 0) >= 0 ? UP_COLOR : DOWN_COLOR }}>{rupee(pnl)}</Text>{kind !== 'all' && <Text type="secondary"> · {kind === 'option' ? 'option' : 'order flow'} only</Text>}</Text>
            </Space>
            {ix.error && <Text type="warning" style={{ fontSize: 11, display: 'block' }}>{ix.error}</Text>}
            {signals.length > 0 && <Table size="small" pagination={false} rowKey={(s) => `${s.id}-${s.t}`} columns={signalColumns} dataSource={signals} onRow={(_, i) => ({ style: i === 0 ? newestRow : undefined })} scroll={{ y: 180 }} />}
            {trades.length > 0 && <Table size="small" pagination={false} rowKey="key" columns={tradeColumns} dataSource={trades} onRow={(_, i) => ({ style: i === 0 ? newestRow : undefined })} scroll={{ y: 180 }} style={{ marginTop: 6 }} />}
            {!signals.length && !trades.length && ix.enabled && <Text type="secondary" style={{ fontSize: 11 }}>No {kind === 'option' ? 'option' : kind === 'orderflow' ? 'order-flow' : ''} signal yet today.</Text>}
          </div>
          )
        })}
      </Space>
    </Card>
  )
}

// What the server scanner runs with: this page's scanner settings, the SL / target / trail of each index
// and the strategies alerted - saved to the server (admins) whenever they change.
let lastSent = ''
let timer = null
/** The Order Flow page's row sizes and big-order setting into the server scanner's settings (the rest kept as they are),
 *  a couple of seconds after they last changed, only when they differ from what the server has. */
let orderFlowTimer = null
export function syncOrderFlowSettings(orderFlow) {
  clearTimeout(orderFlowTimer)
  orderFlowTimer = setTimeout(async () => {
    try {
      const cfg = await fetch('/api/scanner-runner/config').then((r) => (r.ok ? r.json() : null))
      if (!cfg || JSON.stringify(cfg.settings?.orderFlow ?? null) === JSON.stringify(orderFlow)) return
      await fetch('/api/scanner-runner/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: { ...(cfg.settings ?? {}), orderFlow } }) })
    } catch { /* sent again on the next change */ }
  }, 2000)
}

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
