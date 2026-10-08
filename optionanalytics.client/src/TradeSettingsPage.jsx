import { useEffect, useState } from 'react'
import { Alert, Button, Card, InputNumber, Segmented, Space, Switch, Table, Tag, Tooltip, Typography, message } from 'antd'
import { NavBar, useAuth } from './shared.jsx'
import { loadTradeDefaults, refreshTradeSettings, subscribeTradeLevels } from './tradeDefaults.js'

const { Title, Text } = Typography
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX']
const fromDefaults = (u) => {
  const d = loadTradeDefaults(u)
  return { underlying: u, lots: d.lots, slPoints: d.sl, targetPoints: d.target, trailStart: d.trailStart, trailGap: d.trailGap, slippagePoints: d.slippage, scannerEnabled: d.scannerEnabled, autoTrade: d.autoTrade }
}

/**
 * Trade settings, per index, in one place: the default lots, the option stop-loss / target and trailing
 * stop (premium points), the live order slippage, and the server scanner - whether it scans the index and
 * what it does on an alert. Saved on the server in trade-settings.csv (created with the defaults if it is
 * not there) and used by every page - the OI Replay trade panel and its keyboard ticket, the Order Flow
 * scanner - and by the server scanner, which runs these indices with no page open.
 */
export default function TradeSettingsPage() {
  const auth = useAuth()
  const isAdmin = auth?.user?.role === 'Admin'
  const [rows, setRows] = useState(() => UNDERLYINGS.map(fromDefaults))
  const [saved, setSaved] = useState(() => UNDERLYINGS.map(fromDefaults))
  const [file, setFile] = useState(null)
  const [saving, setSaving] = useState(null)

  const reload = async () => {
    const res = await fetch('/api/trade-settings').then((r) => (r.ok ? r.json() : null)).catch(() => null)
    if (res?.file) setFile(res.file)
    await refreshTradeSettings()
    const fresh = UNDERLYINGS.map(fromDefaults)
    setRows(fresh)
    setSaved(fresh)
  }
  useEffect(() => { reload() }, [])
  // A change made elsewhere (a page's SL / target box, another tab) shows here too.
  useEffect(() => subscribeTradeLevels(() => setSaved(UNDERLYINGS.map(fromDefaults))), [])

  const edit = (u, patch) => setRows((list) => list.map((r) => (r.underlying === u ? { ...r, ...patch } : r)))
  const changed = (r) => JSON.stringify(r) !== JSON.stringify(saved.find((s) => s.underlying === r.underlying))
  const save = async (r) => {
    setSaving(r.underlying)
    try {
      const res = await fetch(`/api/trade-settings/${r.underlying}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(r) })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
      message.success(`${r.underlying} saved`)
      await reload()
    } catch (err) {
      message.error(`${r.underlying} not saved: ${err.message}`)
    } finally {
      setSaving(null)
    }
  }

  const num = (key, props = {}) => (v, r) => (
    <InputNumber size="small" value={v} min={0} disabled={!isAdmin} style={{ width: 92 }} onChange={(x) => x != null && edit(r.underlying, { [key]: x })} aria-label={`${r.underlying} ${key}`} {...props} />
  )
  const columns = [
    { title: 'Index', dataIndex: 'underlying', width: 110, render: (u, r) => <Space size={4}><Text strong>{u}</Text>{changed(r) && <Tag color="gold">unsaved</Tag>}</Space> },
    { title: 'Lots', dataIndex: 'lots', width: 100, render: num('lots', { min: 1, max: 500, step: 1 }) },
    { title: <Tooltip title="Option premium points from the entry">Stop-loss pts</Tooltip>, dataIndex: 'slPoints', width: 110, render: num('slPoints', { step: 5 }) },
    { title: <Tooltip title="Option premium points from the entry">Target pts</Tooltip>, dataIndex: 'targetPoints', width: 110, render: num('targetPoints', { step: 5 }) },
    { title: <Tooltip title="Trailing stop: once this many points in profit... (0 with Follow 0 = off)">Trail after</Tooltip>, dataIndex: 'trailStart', width: 110, render: num('trailStart', { step: 5 }) },
    { title: <Tooltip title="...the stop follows the best premium this many points behind, only tightening. 0 = no trailing.">Trail follow</Tooltip>, dataIndex: 'trailGap', width: 110, render: num('trailGap', { step: 1 }) },
    { title: <Tooltip title="A live order's limit price is the bid / ask plus this many points">Slippage pts</Tooltip>, dataIndex: 'slippagePoints', width: 110, render: num('slippagePoints', { step: 0.5, max: 100 }) },
    {
      title: <Tooltip title="The server scans this index with the strategy scanner - with no page open">Server scanner</Tooltip>, dataIndex: 'scannerEnabled', width: 120,
      render: (v, r) => <Switch size="small" checked={v} disabled={!isAdmin} onChange={(x) => edit(r.underlying, { scannerEnabled: x })} aria-label={`${r.underlying} server scanner`} />,
    },
    {
      title: <Tooltip title="What the server scanner does on an alert: paper-sell or paper-buy the option, or only alert">On an alert</Tooltip>, dataIndex: 'autoTrade', width: 230,
      render: (v, r) => <Segmented size="small" value={v} disabled={!isAdmin} onChange={(x) => edit(r.underlying, { autoTrade: x })} options={[{ value: 'sell', label: 'Sell option' }, { value: 'buy', label: 'Buy option' }, { value: 'off', label: 'Alert only' }]} />,
    },
    { title: '', key: 'save', width: 90, render: (_, r) => isAdmin && <Button size="small" type="primary" disabled={!changed(r)} loading={saving === r.underlying} onClick={() => save(r)}>Save</Button> },
  ]

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>
        <Card size="small" title="Trade settings · per index">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              The defaults every trade starts from - the OI Replay trade panel and its keyboard ticket (B / S), the Order Flow scanner&apos;s paper and
              live trades - and what the server scanner runs with: it scans each index switched on here and trades it this way on every alert, whether
              or not any page is open. Changing a stop-loss / target here, or in any of those boxes on a page, changes it everywhere; open trades take a
              new stop-loss / target from the minute it changes. Saved on the server in {file ?? 'trade-settings.csv'} (written again with the defaults
              if it is missing).
            </Text>
            {!isAdmin && <Alert type="info" showIcon message="Only an admin can change these." />}
            <Table size="small" rowKey="underlying" columns={columns} dataSource={rows} pagination={false} scroll={{ x: 1150 }} />
            <Text type="secondary" style={{ fontSize: 12 }}>
              The server scanner is paper only: it alerts and paper-trades on Telegram (tagged [Server]) and never places a real order. Which
              strategies it alerts on, their filters and the trailing stop on the futures signal follow the Order Flow scanner&apos;s settings.
            </Text>
          </Space>
        </Card>
      </Space>
    </div>
  )
}
