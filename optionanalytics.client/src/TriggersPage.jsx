import { useEffect, useState } from 'react'
import { Select, Space, Typography, Card, Button, Table, Tag, InputNumber, Input, Switch, Popconfirm, message } from 'antd'
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import { UP_COLOR, DOWN_COLOR, NavBar, fmtIstDateTime, TIMEFRAME_OPTIONS, STORED_UNDERLYING, STORED_TIMEFRAME, usePersistedState, pickUnderlying } from './shared.jsx'

const { Title, Text } = Typography

// Arm a strategy to notify over Telegram when it fires. A trigger takes exactly the inputs a
// Backtrack run takes - underlying, strategy, timeframe and that strategy's own parameters - and
// the backend evaluates it with the same code the backtest uses, so a rule tuned on that page
// behaves identically here. The parameter controls are generated from the strategy metadata, so a
// new backend strategy is armable with no change to this page.
export default function TriggersPage() {
  const [underlyings, setUnderlyings] = useState([])
  const [strategies, setStrategies] = useState([])
  const [triggers, setTriggers] = useState([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  const [name, setName] = useState('')
  // Shared with every other page and remembered across reloads - see usePersistedState.
  const [underlying, setUnderlying] = usePersistedState(STORED_UNDERLYING, null)
  const [timeframe, setTimeframe] = usePersistedState(STORED_TIMEFRAME, 1)
  const [strategyKey, setStrategyKey] = useState(null)
  const [paramValues, setParamValues] = useState({})

  // Whether an armed trigger also builds a Dhan Super Order from its fired trade - a separate
  // opt-in from "On" above, which only ever means "watch and alert". DRY RUN ONLY right now: the
  // backend computes and logs the order (and shows it in the Telegram message) but never actually
  // places it - see StrategyTriggerHostedService's own doc comment.
  const [liveTradingEnabled, setLiveTradingEnabled] = useState(false)
  const [quantityLots, setQuantityLots] = useState(1)
  const [slippagePoints, setSlippagePoints] = useState(1)

  const strategy = strategies.find((s) => s.key === strategyKey) ?? null

  const loadTriggers = () => {
    setLoading(true)
    fetch('/api/triggers')
      .then((r) => r.json())
      .then((data) => setTriggers(data ?? []))
      .catch((err) => console.error('Failed to load triggers:', err))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    fetch('/api/spot/underlyings')
      .then((r) => r.json())
      .then((list) => {
        setUnderlyings(list ?? [])
        setUnderlying((current) => pickUnderlying(list, current))
      })
      .catch((err) => console.error('Failed to load underlyings:', err))

    fetch('/api/backtest/strategies')
      .then((r) => r.json())
      .then((list) => {
        setStrategies(list ?? [])
        if (list?.length > 0) setStrategyKey(list[0].key)
      })
      .catch((err) => console.error('Failed to load strategies:', err))

    loadTriggers()
  }, [])

  // Each strategy has its own parameter set, so switching resets to that strategy's defaults
  // rather than carrying meaningless values across.
  useEffect(() => {
    if (!strategy) return
    setParamValues(Object.fromEntries(strategy.parameters.map((p) => [p.key, p.default])))
  }, [strategy])

  const createTrigger = () => {
    if (!underlying || !strategyKey) return
    setSaving(true)
    fetch('/api/triggers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim() || `${underlying} ${strategy?.name ?? strategyKey}`,
        underlying,
        strategyKey,
        timeframeMinutes: timeframe,
        parameters: paramValues,
        enabled: true,
        liveTradingEnabled,
        quantityLots,
        slippagePoints,
      }),
    })
      .then((r) => r.json())
      .then(() => {
        message.success(liveTradingEnabled
          ? 'Trigger armed - Super Order preview will be logged (dry run) on the next new signal'
          : 'Trigger armed - it will notify on the next new signal')
        setName('')
        loadTriggers()
      })
      .catch((err) => {
        console.error('Failed to create trigger:', err)
        message.error('Could not create the trigger')
      })
      .finally(() => setSaving(false))
  }

  // Used for both the "On" switch and the "Live" switch - either one PUTs the whole trigger back,
  // so every field row already holds (parameters, live-trading settings included) must be carried
  // through unchanged or this would silently reset whichever one isn't being toggled right now.
  const updateTrigger = (row, changes) => {
    fetch(`/api/triggers/${row.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: row.name,
        underlying: row.underlying,
        strategyKey: row.strategyKey,
        timeframeMinutes: row.timeframeMinutes,
        parameters: row.parameters,
        enabled: row.enabled,
        liveTradingEnabled: row.liveTradingEnabled,
        quantityLots: row.quantityLots,
        slippagePoints: row.slippagePoints,
        ...changes,
      }),
    })
      .then(() => loadTriggers())
      .catch((err) => console.error('Failed to update trigger:', err))
  }

  const setEnabled = (row, enabled) => updateTrigger(row, { enabled })
  const setLiveTrading = (row, liveTradingEnabled) => updateTrigger(row, { liveTradingEnabled })

  const deleteTrigger = (id) => {
    fetch(`/api/triggers/${id}`, { method: 'DELETE' })
      .then(() => loadTriggers())
      .catch((err) => console.error('Failed to delete trigger:', err))
  }

  const strategyName = (key) => strategies.find((s) => s.key === key)?.name ?? key

  const columns = [
    { title: 'Name', dataIndex: 'name', key: 'name', render: (v) => <Text strong>{v}</Text> },
    { title: 'Underlying', dataIndex: 'underlying', key: 'underlying', width: 120 },
    { title: 'Strategy', dataIndex: 'strategyKey', key: 'strategyKey', render: (v) => strategyName(v) },
    { title: 'Timeframe', dataIndex: 'timeframeMinutes', key: 'timeframeMinutes', width: 110, render: (v) => `${v} min` },
    {
      title: 'Settings',
      key: 'parameters',
      render: (_, row) => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {Object.entries(row.parameters ?? {}).map(([k, v]) => `${k}=${v}`).join(' · ') || '—'}
        </Text>
      ),
    },
    {
      title: 'Last fired',
      key: 'lastFired',
      width: 260,
      render: (_, row) => (row.lastFiredUtc
        ? (
          <Space direction="vertical" size={0}>
            <Text style={{ fontSize: 12 }}>{fmtIstDateTime(row.lastFiredUtc)}</Text>
            <Text type="secondary" style={{ fontSize: 11 }}>{row.lastFiredSummary}</Text>
          </Space>
        )
        : <Text type="secondary">{row.lastSignalUtc ? 'Armed - waiting for a new signal' : 'Arming…'}</Text>),
    },
    {
      title: 'Live (dry run)',
      key: 'liveTrading',
      width: 170,
      render: (_, row) => (
        <Space size={8}>
          <Switch size="small" checked={row.liveTradingEnabled} onChange={(v) => setLiveTrading(row, v)} />
          {row.liveTradingEnabled && (
            <Text type="secondary" style={{ fontSize: 12 }}>{row.quantityLots} lot(s) · {row.slippagePoints}pt slip</Text>
          )}
        </Space>
      ),
    },
    {
      title: 'On',
      key: 'enabled',
      width: 80,
      render: (_, row) => <Switch size="small" checked={row.enabled} onChange={(v) => setEnabled(row, v)} />,
    },
    {
      title: '',
      key: 'actions',
      width: 60,
      render: (_, row) => (
        <Popconfirm title="Delete this trigger?" onConfirm={() => deleteTrigger(row.id)} okText="Delete" cancelText="Cancel">
          <Button size="small" type="text" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ]

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>

        <Card
          size="small"
          title="Arm a strategy"
          extra={<Text type="secondary" style={{ fontSize: 12 }}>{strategy?.description ?? 'Loading strategies…'}</Text>}
        >
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Text type="secondary">
              An armed trigger is evaluated every 30 seconds with the same code the Backtrack page runs,
              so whatever you tuned there fires identically here. A new trigger only records where the
              strategy currently stands - it notifies on signals that happen after it is armed, never on
              the existing backlog.
            </Text>

            <Space align="end" size={16} wrap>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Name</Text>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="optional" style={{ width: 180 }} />
              </Space>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Underlying</Text>
                <Select value={underlying} onChange={setUnderlying} style={{ width: 140 }}
                  options={underlyings.map((u) => ({ value: u.underlying, label: u.underlying }))} />
              </Space>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Strategy</Text>
                <Select value={strategyKey} onChange={setStrategyKey} style={{ width: 220 }}
                  options={strategies.map((s) => ({ value: s.key, label: s.name }))} />
              </Space>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Timeframe</Text>
                <Select value={timeframe} onChange={setTimeframe} style={{ width: 120 }} options={TIMEFRAME_OPTIONS} />
              </Space>
            </Space>

            <Space align="end" size={16} wrap>
              {strategy?.parameters.map((p) => (
                <Space direction="vertical" size={2} key={p.key}>
                  <Text type="secondary" style={{ fontSize: 12 }}>{p.label}</Text>
                  {p.options?.length > 0 ? (
                    <Select
                      value={paramValues[p.key] ?? p.default}
                      onChange={(v) => setParamValues((prev) => ({ ...prev, [p.key]: v }))}
                      style={{ width: 200 }}
                      options={p.options.map((o) => ({ value: o.value, label: o.label }))}
                    />
                  ) : (
                    <InputNumber
                      controls={false}
                      min={p.min}
                      max={p.max}
                      step={p.step}
                      value={paramValues[p.key] ?? p.default}
                      onChange={(v) => setParamValues((prev) => ({ ...prev, [p.key]: v ?? p.default }))}
                      style={{ width: 130 }}
                    />
                  )}
                </Space>
              ))}
              <Button type="primary" icon={<PlusOutlined />} onClick={createTrigger} loading={saving} disabled={!underlying || !strategyKey}>
                Arm trigger
              </Button>
            </Space>

            <Space align="end" size={16} wrap style={{ borderTop: '1px solid #ffffff1a', paddingTop: 16 }}>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Live trading (dry run)</Text>
                <Switch checked={liveTradingEnabled} onChange={setLiveTradingEnabled} />
              </Space>
              {liveTradingEnabled && (
                <>
                  <Space direction="vertical" size={2}>
                    <Text type="secondary" style={{ fontSize: 12 }}>Quantity (lots)</Text>
                    <InputNumber controls={false} min={1} step={1} value={quantityLots}
                      onChange={(v) => setQuantityLots(v ?? 1)} style={{ width: 110 }} />
                  </Space>
                  <Space direction="vertical" size={2}>
                    <Text type="secondary" style={{ fontSize: 12 }}>Slippage (points)</Text>
                    <InputNumber controls={false} min={0} step={0.5} value={slippagePoints}
                      onChange={(v) => setSlippagePoints(v ?? 0)} style={{ width: 130 }} />
                  </Space>
                  <Text type="secondary" style={{ fontSize: 12, maxWidth: 420 }}>
                    Builds a Dhan Super Order (LIMIT entry + target + stop-loss) from every fired trade and
                    logs it - it is not placed yet. Slippage is added to (a buy) or subtracted from (a sell)
                    the entry price to keep the LIMIT order fillable.
                  </Text>
                </>
              )}
            </Space>
          </Space>
        </Card>

        <Card
          size="small"
          title="Armed triggers"
          extra={
            <Tag color={triggers.some((t) => t.enabled) ? UP_COLOR : DOWN_COLOR}>
              {triggers.filter((t) => t.enabled).length} active
            </Tag>
          }
        >
          <Table
            size="small"
            rowKey="id"
            loading={loading}
            dataSource={triggers}
            columns={columns}
            pagination={false}
            locale={{ emptyText: 'No triggers yet - arm one above and it will notify over Telegram when its strategy fires.' }}
          />
        </Card>
      </Space>
    </div>
  )
}
