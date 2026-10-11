import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, InputNumber, Popconfirm, Segmented, Space, Switch, Table, Tag, Tooltip, Typography, message } from 'antd'
import { NavBar, useAuth } from './shared.jsx'
import { loadTradeDefaults, refreshTradeSettings, subscribeTradeLevels } from './tradeDefaults.js'
import { ServerLiveSwitch, ServerLiveTrades, useServerLive } from './ServerLive.jsx'

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
const rupees = (v) => (v == null ? '-' : `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`)
const istTime = (iso) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }) : '')

/**
 * The daily loss limit on the whole Dhan account (default ₹20,000) and its kill switch: set on Dhan every day
 * as its P&L based exit, and watched by the server - at the limit everything is exited, no new order goes
 * out and Dhan's kill switch is turned on for the day. Changed here once a day (risk-settings.csv).
 */
function KillSwitchCard({ isAdmin }) {
  const [st, setSt] = useState(null)
  const [limit, setLimit] = useState(null)
  const [enabled, setEnabled] = useState(true)
  const [saving, setSaving] = useState(false)
  // The boxes start from the server's values once; later polls only refresh the status (an unsaved edit stays).
  const loadedRef = useRef(false)
  const load = () => fetch('/api/risk').then((r) => (r.ok ? r.json() : null)).then((x) => {
    if (!x) return
    setSt(x)
    if (!loadedRef.current) { loadedRef.current = true; setLimit(x.dailyLossLimit); setEnabled(x.enabled) }
  }).catch(() => {})
  useEffect(() => {
    load()
    const id = setInterval(load, 10_000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const changed = st && (limit !== st.dailyLossLimit || enabled !== st.enabled)
  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/risk', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dailyLossLimit: limit, enabled }) })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
      setSt(body)
      setLimit(body.dailyLossLimit)
      setEnabled(body.enabled)
      message.success('Daily loss limit saved')
    } catch (err) {
      message.error(`Not saved: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }
  const locked = !isAdmin || !st?.canChangeToday || st?.trippedToday
  return (
    <Card size="small" title={<Space size={8}><span>Daily loss limit · kill switch</span>
      {st?.trippedToday ? <Tag color="error">TRIPPED{st.trippedAtUtc ? ` at ${istTime(st.trippedAtUtc)}` : ''}</Tag> : st?.enabled ? <Tag color="success">on</Tag> : st ? <Tag>off</Tag> : null}</Space>}>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          The whole Dhan account&apos;s loss for the day. Every morning it is set on Dhan as its P&amp;L based exit (with the kill switch), so Dhan itself
          exits everything at that loss even if this server is down; the server also watches the live P&amp;L - at the limit it exits every position,
          cancels every order, blocks new orders from this app and turns Dhan&apos;s kill switch on (no more trading today). It can be changed once a day.
        </Text>
        {st?.trippedToday && (
          <Alert type="error" showIcon message={`Daily loss limit hit${st.trippedPnl != null ? ` (P&L ${rupees(st.trippedPnl)})` : ''} - no more trading today.`}
            description={<>{st.exitResult && <div>Exit-all: {st.exitResult}</div>}<div>Dhan kill switch: {st.dhanKillSwitchOn ? 'ON' : `not on yet${st.dhanKillSwitchError ? ` - ${st.dhanKillSwitchError} (retrying)` : ' (retrying)'}`}</div></>} />
        )}
        <Space wrap size={16} align="center">
          <Space size={6}>
            <Text>Limit</Text>
            <InputNumber value={limit} min={1000} max={1000000} step={1000} disabled={locked} onChange={(v) => v != null && setLimit(v)} prefix="₹" style={{ width: 150 }} aria-label="Daily loss limit" />
          </Space>
          <Space size={6}><Switch checked={enabled} disabled={locked} onChange={setEnabled} aria-label="Kill switch on" /><Text>Kill switch on</Text></Space>
          {isAdmin && (
            <Popconfirm title="Save the daily loss limit?" description="It can be changed only once a day." okText="Save" onConfirm={save} disabled={!changed || locked}>
              <Button type="primary" size="small" disabled={!changed || locked} loading={saving}>Save</Button>
            </Popconfirm>
          )}
          {st && !st.canChangeToday && !st.trippedToday && <Text type="secondary" style={{ fontSize: 12 }}>Changed today - can be changed again tomorrow.</Text>}
        </Space>
        {st && (
          <Space wrap size={16} style={{ fontSize: 12 }}>
            <Text style={{ fontSize: 12 }}>Today&apos;s P&amp;L: <Text strong style={{ fontSize: 12, color: (st.dayPnl ?? 0) < 0 ? '#ff4d4f' : '#52c41a' }}>{rupees(st.dayPnl)}</Text>{st.dayPnl != null && st.enabled ? ` (limit -${rupees(st.dailyLossLimit)})` : ''}</Text>
            <Text style={{ fontSize: 12 }}>Set on Dhan today: {st.dhanPnlExitSet ? <Tag color="success">yes</Tag> : <Tag color={st.dhanPnlExitError ? 'warning' : 'default'}>{st.dhanPnlExitError ? `no - ${st.dhanPnlExitError}` : st.dhanLoggedIn ? 'not yet' : 'not logged in to Dhan'}</Tag>}</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>Saved in {st.file}</Text>
          </Space>
        )}
      </Space>
    </Card>
  )
}

/** The server scanner's Paper / Live choice per index - Live for today only, within each index's limits. */
function ServerLiveCard({ isAdmin }) {
  const { list, set } = useServerLive()
  const anyLive = list?.some((x) => x.live)
  return (
    <Card size="small" title={<Space size={8}><span>Server scanner · paper or live</span>{anyLive ? <Tag color="error">LIVE today: {list.filter((x) => x.live).map((x) => x.underlying).join(', ')}</Tag> : list ? <Tag>all on paper</Tag> : null}</Space>}>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Paper: the server scanner alerts and paper-trades (Telegram, tagged [Server]). <b>Live today</b>: on every alert it ALSO places a real Dhan super
          order by itself - no page needs to be open - with the index&apos;s lots, slippage and trailing below and the option SL / target its paper trade
          uses, and closes it when the trade ends (its stop, target, trailing SL, time stop, 15:10). Only one open live trade per index at a time, at most
          the max trades a day, no new order after the max loss or after 14:45, and the account&apos;s daily loss limit above always applies.
          Live lasts until the end of today - every morning each index starts on paper again. Also switchable on the Order Flow page.
        </Text>
        {!list && <Text type="secondary">loading…</Text>}
        {(list ?? []).map((st) => (
          <div key={st.underlying} style={{ borderTop: '1px solid #ffffff14', paddingTop: 8 }}>
            <Space wrap size={12} align="center">
              <Text strong style={{ minWidth: 90, display: 'inline-block' }}>{st.underlying}</Text>
              <ServerLiveSwitch underlying={st.underlying} st={st} isAdmin={isAdmin} set={set} />
            </Space>
            <div style={{ marginTop: 4 }}><ServerLiveTrades st={st} /></div>
          </div>
        ))}
      </Space>
    </Card>
  )
}

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
      title: <Tooltip title="What the server scanner does on an alert for this index: paper-sell or paper-buy the option (your choice here wins for every strategy), leave it to each strategy's own tuned setting, or only alert">On an alert</Tooltip>, dataIndex: 'autoTrade', width: 300,
      render: (v, r) => <Segmented size="small" value={v} disabled={!isAdmin} onChange={(x) => edit(r.underlying, { autoTrade: x })} options={[{ value: 'sell', label: 'Sell option' }, { value: 'buy', label: 'Buy option' },
        { value: 'strategy', label: <Tooltip title="Each strategy buys or sells what its own tuned setting says (Strategy tuning - Apply to the scanner), at its own strike and with its own option SL / target; one with no setting of its own sells.">Per strategy</Tooltip> }, { value: 'off', label: 'Alert only' }]} />,
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
        <KillSwitchCard isAdmin={isAdmin} />
        <ServerLiveCard isAdmin={isAdmin} />
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
              The server scanner paper-trades unless an index is switched to Live today (above). Which strategies it alerts on, their filters and
              the trailing stop on the futures signal follow the Order Flow scanner&apos;s settings.
            </Text>
          </Space>
        </Card>
      </Space>
    </div>
  )
}
