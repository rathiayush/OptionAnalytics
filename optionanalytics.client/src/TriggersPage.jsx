import { useEffect, useRef, useState } from 'react'
import { Select, Space, Typography, Card, Button, Table, Tag, InputNumber, Input, Switch, Popconfirm, message, TimePicker } from 'antd'
import dayjs from 'dayjs'
import { PlusOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons'
import { UP_COLOR, DOWN_COLOR, NavBar, fmtIstDateTime, TIMEFRAME_OPTIONS, STORED_UNDERLYING, STORED_TIMEFRAME, usePersistedState, pickUnderlying, useExpirySelector } from './shared.jsx'

const { Title, Text } = Typography

// Colours the order-history status Tag by outcome, grouped the same way a person reading it would:
// green once money has actually moved (placed, filled), amber for a partial/still-unresolved state,
// red for anything that means the order did NOT do what the trigger wanted, grey for a plain skip.
const ORDER_STATUS_COLOR = {
  'ORDER PLACED': UP_COLOR,
  'ORDER FILLED': UP_COLOR,
  'ORDER CANCELLED': 'default',
  'ORDER PARTIALLY FILLED': 'gold',
  'ORDER FAILED': DOWN_COLOR,
  'ORDER PIPELINE CRASHED': DOWN_COLOR,
  'ORDER REJECTED': DOWN_COLOR,
  'ORDER CANCEL FAILED': DOWN_COLOR,
  'ORDER UNMONITORED': DOWN_COLOR,
  'NO ORDER PLACED': 'default',
}
const orderStatusColor = (status) => ORDER_STATUS_COLOR[status] ?? (status?.includes('FAIL') || status?.includes('CRASH') ? DOWN_COLOR : 'default')

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

  // What actually happened to every order a trigger's tried to place - see TriggerOrderHistoryStore.
  // Polled rather than pushed: this is a look-it-up-when-you-want-it log, not a live feed, and every
  // other page-level list here already works the same way (loadTriggers below included).
  const [orderEvents, setOrderEvents] = useState([])
  const [orderHistoryTriggerId, setOrderHistoryTriggerId] = useState(null)

  // Which trigger the form is EDITING, or null when it is creating a new one. The same form serves
  // both on purpose: a separate edit dialog would duplicate every control here and the two would
  // drift the moment a field is added to one and not the other.
  const [editingId, setEditingId] = useState(null)

  const [name, setName] = useState('')
  // Shared with every other page and remembered across reloads - see usePersistedState.
  const [underlying, setUnderlying] = usePersistedState(STORED_UNDERLYING, null)
  const [timeframe, setTimeframe] = usePersistedState(STORED_TIMEFRAME, 1)
  const [strategyKey, setStrategyKey] = useState(null)
  const [paramValues, setParamValues] = useState({})

  // Whether an armed trigger also PLACES a real Dhan Super Order (LIMIT entry + target + stop-loss)
  // from its fired trade - a separate opt-in from "On" above, which only ever means "watch and
  // alert". This places real orders with real money - see StrategyTriggerHostedService's own doc
  // comment for exactly how the strategy's points-based SL/TP and these fields become the order.
  const [liveTradingEnabled, setLiveTradingEnabled] = useState(false)
  const [quantityLots, setQuantityLots] = useState(1)
  const [slippagePoints, setSlippagePoints] = useState(1)
  const [maxDeviationPercent, setMaxDeviationPercent] = useState(10)
  const [useLivePremiumEntry, setUseLivePremiumEntry] = useState(false)
  // Which expiry the ORDER goes in. null (the default) follows whatever expiry the app is tracking,
  // exactly as before; a date pins the order to that contract - a next-month one, say - while the
  // signals keep coming off the tracked expiry's chart. See StrategyTrigger.OrderExpiry.
  const [orderExpiry, setOrderExpiry] = useState(null)
  // Off (the default): a fresh signal while this trigger's earlier position is still open is
  // skipped outright, reported as [NO ORDER PLACED] - never a second order. On: instead of
  // skipping, the existing position's stop-loss is MODIFIED to the new signal's own entry price,
  // reported as [STOP LOSS UPDATED] - still never a second position. See
  // StrategyTrigger.AdjustStopLossOnOpenPosition.
  const [adjustStopLossOnOpenPosition, setAdjustStopLossOnOpenPosition] = useState(false)
  // 0 (the default): a fired Sell signal goes out naked, exactly as before this existed. > 0:
  // automatically also buys a cheaper, further-OTM option this many strike-steps beyond the sold
  // one - the classic "sell close, buy far" credit spread a real option seller uses to cap tail
  // risk - closed together the moment the sold leg's own position closes. Only ever applies to a
  // Sell-side trade; a Buy-side one has nothing to hedge. See StrategyTrigger.HedgeOtmSteps.
  const [hedgeOtmSteps, setHedgeOtmSteps] = useState(0)

  // How liquid the hedge strike has to be before it is bought, as a percentage of the SOLD strike's
  // own open interest - a far-OTM strike can be listed and still have essentially no book behind it.
  // Too thin and the hedge walks INWARD toward the sold leg to the first strike that qualifies
  // (down to half the requested distance), rather than buying something that can't be exited. 0
  // turns the check off. See StrategyTrigger.HedgeMinOpenInterestPercent.
  const [hedgeMinOiPercent, setHedgeMinOiPercent] = useState(5)

  // Read-only here: this page needs the list of TRACKED expiries to choose from, and the default so
  // the fallback option can name it. Every one of these is subscribed live, so a trigger pinned to
  // any of them is priced off the real feed rather than an option-chain snapshot.
  const { expiries, selectedExpiry } = useExpirySelector(underlying)

  const strategy = strategies.find((s) => s.key === strategyKey) ?? null

  const loadTriggers = () => {
    setLoading(true)
    fetch('/api/triggers')
      .then((r) => r.json())
      .then((data) => setTriggers(data ?? []))
      .catch((err) => console.error('Failed to load triggers:', err))
      .finally(() => setLoading(false))
  }

  const loadOrderHistory = () => {
    const url = orderHistoryTriggerId ? `/api/triggers/orders?triggerId=${orderHistoryTriggerId}&limit=200` : '/api/triggers/orders?limit=200'
    fetch(url)
      .then((r) => r.json())
      .then((data) => setOrderEvents(data ?? []))
      .catch((err) => console.error('Failed to load trigger order history:', err))
  }

  // Polled every 5s, same cadence ContractsPage uses for its own live-state table - this is an
  // activity log a person checks after wondering "did that fire", not something worth a SignalR
  // channel of its own.
  useEffect(() => {
    loadOrderHistory()
    const id = setInterval(loadOrderHistory, 5000)
    return () => clearInterval(id)
  }, [orderHistoryTriggerId])

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
  // Skipped while loading a trigger into the form: startEdit sets strategyKey and the saved
  // parameters together, and this effect would otherwise fire on the strategy change and stomp
  // those saved values back to the strategy's defaults - silently discarding the edit's whole point.
  const loadingEditRef = useRef(false)
  useEffect(() => {
    if (!strategy) return
    if (loadingEditRef.current) { loadingEditRef.current = false; return }
    setParamValues(Object.fromEntries(strategy.parameters.map((p) => [p.key, p.default])))
  }, [strategy])

  /// Loads an existing trigger back into the form.
  const startEdit = (row) => {
    loadingEditRef.current = true
    setEditingId(row.id)
    setName(row.name ?? '')
    setUnderlying(row.underlying)
    setTimeframe(row.timeframeMinutes)
    setStrategyKey(row.strategyKey)
    setParamValues(row.parameters ?? {})
    setLiveTradingEnabled(row.liveTradingEnabled)
    setQuantityLots(row.quantityLots)
    setSlippagePoints(row.slippagePoints)
    setMaxDeviationPercent(row.maxDeviationPercent)
    setUseLivePremiumEntry(row.useLivePremiumEntry)
    setOrderExpiry(row.orderExpiry ?? null)
    setAdjustStopLossOnOpenPosition(row.adjustStopLossOnOpenPosition)
    setHedgeOtmSteps(row.hedgeOtmSteps ?? 0)
    setHedgeMinOiPercent(row.hedgeMinOpenInterestPercent ?? 5)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const cancelEdit = () => {
    setEditingId(null)
    setName('')
  }

  const saveTrigger = () => {
    if (!underlying || !strategyKey) return
    setSaving(true)
    // The SAME body either way - the backend's PUT replaces every field, so an edit that omitted
    // one would reset it to its default rather than leave it alone (see StrategyTriggerStore.Update).
    fetch(editingId ? `/api/triggers/${editingId}` : '/api/triggers', {
      method: editingId ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim() || `${underlying} ${strategy?.name ?? strategyKey}`,
        underlying,
        strategyKey,
        timeframeMinutes: timeframe,
        parameters: paramValues,
        // A NEW trigger is armed on. An EDIT must keep whatever the row's own On switch is set to -
        // the PUT replaces every field, so hardcoding true here would silently re-arm a trigger the
        // user had deliberately paused, just because they corrected its quantity.
        enabled: editingId ? (triggers.find((t) => t.id === editingId)?.enabled ?? true) : true,
        liveTradingEnabled,
        quantityLots,
        slippagePoints,
        maxDeviationPercent,
        useLivePremiumEntry,
        orderExpiry,
        adjustStopLossOnOpenPosition,
        hedgeOtmSteps,
        hedgeMinOpenInterestPercent: hedgeMinOiPercent,
      }),
    })
      .then((r) => r.json())
      .then(() => {
        if (editingId) {
          message.success('Trigger updated')
          setEditingId(null)
        } else {
          message.success(liveTradingEnabled
            ? 'Trigger armed - a real Super Order will be placed on the next new signal'
            : 'Trigger armed - it will notify on the next new signal')
        }
        setName('')
        loadTriggers()
      })
      .catch((err) => {
        console.error('Failed to save trigger:', err)
        message.error(editingId ? 'Could not update the trigger' : 'Could not create the trigger')
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
        maxDeviationPercent: row.maxDeviationPercent,
        useLivePremiumEntry: row.useLivePremiumEntry,
        orderExpiry: row.orderExpiry,
        adjustStopLossOnOpenPosition: row.adjustStopLossOnOpenPosition,
        hedgeOtmSteps: row.hedgeOtmSteps,
        hedgeMinOpenInterestPercent: row.hedgeMinOpenInterestPercent,
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
      title: 'Live trading',
      key: 'liveTrading',
      width: 220,
      render: (_, row) => (
        <Space size={8}>
          <Switch size="small" checked={row.liveTradingEnabled} onChange={(v) => setLiveTrading(row, v)} />
          {row.liveTradingEnabled && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              {row.quantityLots} lot(s) · {row.slippagePoints}pt slip · {row.maxDeviationPercent}% max deviation
              {row.useLivePremiumEntry ? ' · live-premium entry' : ''}
              {row.adjustStopLossOnOpenPosition ? ' · SL update on re-signal' : ''}
              {row.orderExpiry ? ` · ${row.orderExpiry} expiry` : ''}
              {row.hedgeOtmSteps > 0 ? ` · hedged +${row.hedgeOtmSteps} OTM` : ''}
              {row.hedgeOtmSteps > 0 && row.hedgeMinOpenInterestPercent !== 0
                ? ` (min ${row.hedgeMinOpenInterestPercent ?? 5}% OI)`
                : ''}
            </Text>
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
      width: 90,
      render: (_, row) => (
        <Space size={0}>
          <Button
            size="small"
            type="text"
            icon={<EditOutlined />}
            onClick={() => startEdit(row)}
            title="Edit this trigger"
          />
          <Popconfirm title="Delete this trigger?" onConfirm={() => deleteTrigger(row.id)} okText="Delete" cancelText="Cancel">
            <Button size="small" type="text" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  // "did the order fire" answered by looking, not by hunting through Telegram - see
  // TriggerOrderHistoryStore. Message carries the full multi-line detail (contract, price, target/SL,
  // reason) NotifyFollowUpAsync already composes for Telegram; Status is just its own leading [TAG].
  const orderHistoryColumns = [
    { title: 'Time', dataIndex: 'timestampUtc', key: 'timestampUtc', width: 150, render: (v) => <Text style={{ fontSize: 12 }}>{fmtIstDateTime(v)}</Text> },
    { title: 'Trigger', dataIndex: 'triggerName', key: 'triggerName', width: 160 },
    { title: 'Status', dataIndex: 'status', key: 'status', width: 170, render: (v) => <Tag color={orderStatusColor(v)}>{v}</Tag> },
    {
      title: 'Detail',
      dataIndex: 'message',
      key: 'message',
      render: (v) => <Text style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{v}</Text>,
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
          title={editingId ? `Editing "${triggers.find((t) => t.id === editingId)?.name ?? editingId}"` : 'Arm a strategy'}
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
                  {p.key === 'squareOffMinutes' || p.key === 'signalStartMinutes' ? (
                    // Same time-of-day picker as the Backtrack page - these two keys are still
                    // plain minutes-past-midnight-IST numbers on the wire (see
                    // OptionTradeSimulator's own parameter builders), just picked as a time here
                    // instead of typed as a raw number. 12-hour with an explicit AM/PM selector,
                    // not 24-hour - a 24-hour-only field silently reads "03:10" as 3:10 AM when a
                    // trader means 3:10 PM, and for squareOffMinutes a cutoff that early is always
                    // in the past relative to any intraday entry, squaring every trade off on its
                    // very next bar.
                    <TimePicker
                      value={paramValues[p.key] ? dayjs().startOf('day').add(paramValues[p.key], 'minute') : null}
                      onChange={(v) => setParamValues((prev) => ({ ...prev, [p.key]: v ? v.hour() * 60 + v.minute() : 0 }))}
                      format="hh:mm A"
                      use12Hours
                      allowClear
                      placeholder="No cutoff"
                      style={{ width: 150 }}
                    />
                  ) : p.options?.length > 0 ? (
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
              <Space>
                <Button type="primary" icon={editingId ? <EditOutlined /> : <PlusOutlined />} onClick={saveTrigger} loading={saving} disabled={!underlying || !strategyKey}>
                  {editingId ? 'Save changes' : 'Arm trigger'}
                </Button>
                {editingId && <Button onClick={cancelEdit} disabled={saving}>Cancel</Button>}
              </Space>
            </Space>

            <Space align="end" size={16} wrap style={{ borderTop: '1px solid #ffffff1a', paddingTop: 16 }}>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Live trading</Text>
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
                  <Space direction="vertical" size={2}>
                    <Text type="secondary" style={{ fontSize: 12 }}>Max deviation (%)</Text>
                    <InputNumber controls={false} min={0} step={1} value={maxDeviationPercent}
                      onChange={(v) => setMaxDeviationPercent(v ?? 10)} style={{ width: 130 }} />
                  </Space>
                  <Space direction="vertical" size={2}>
                    <Text type="secondary" style={{ fontSize: 12 }}>Entry price</Text>
                    <Select
                      value={useLivePremiumEntry}
                      onChange={setUseLivePremiumEntry}
                      style={{ width: 230 }}
                      options={[
                        { value: false, label: "Next bar's open (matches backtest)" },
                        { value: true, label: 'Live premium when it fires' },
                      ]}
                    />
                  </Space>
                  <Space direction="vertical" size={2}>
                    <Text type="secondary" style={{ fontSize: 12 }}>On re-signal while a position is open</Text>
                    <Select
                      value={adjustStopLossOnOpenPosition}
                      onChange={setAdjustStopLossOnOpenPosition}
                      style={{ width: 230 }}
                      options={[
                        { value: false, label: 'Skip it (no second order)' },
                        { value: true, label: 'Update the open SL instead' },
                      ]}
                    />
                  </Space>
                  <Space direction="vertical" size={2}>
                    <Text type="secondary" style={{ fontSize: 12 }}>Order expiry</Text>
                    <Select
                      value={orderExpiry ?? ''}
                      onChange={(v) => setOrderExpiry(v === '' ? null : v)}
                      style={{ width: 230 }}
                      options={[
                        { value: '', label: `Default expiry${selectedExpiry ? ` (${selectedExpiry})` : ''}` },
                        ...expiries.map((e) => ({ value: e, label: e })),
                      ]}
                    />
                  </Space>
                  <Space direction="vertical" size={2}>
                    <Text type="secondary" style={{ fontSize: 12 }}>Hedge sold leg (OTM steps, 0 = off)</Text>
                    <InputNumber controls={false} min={0} step={1} value={hedgeOtmSteps}
                      onChange={(v) => setHedgeOtmSteps(v ?? 0)} style={{ width: 130 }} />
                  </Space>
                  {hedgeOtmSteps > 0 && (
                    <Space direction="vertical" size={2}>
                      <Text type="secondary" style={{ fontSize: 12 }}>Hedge min OI (% of sold strike, 0 = off)</Text>
                      <InputNumber controls={false} min={0} max={100} step={1} value={hedgeMinOiPercent}
                        onChange={(v) => setHedgeMinOiPercent(v ?? 0)} style={{ width: 130 }} />
                    </Space>
                  )}
                  <Text type="secondary" style={{ fontSize: 12, maxWidth: 460 }}>
                    Places a real Dhan Super Order (LIMIT entry + target + stop-loss) from every fired
                    trade. Slippage keeps the entry marketable. If it doesn&apos;t fill, it re-prices off the
                    latest live premium up to 3 times - but never if that premium has drifted more than
                    Max deviation from the signal&apos;s own price, and it cancels rather than fill at a bad
                    price if it runs out of attempts.
                    {useLivePremiumEntry
                      ? ' Live-premium entry fires the moment the signal bar closes, priced off the premium right then - no waiting for the next bar, but the fill will not match what Backtrack modelled for the same signal.'
                      : ' The order waits for the option’s next bar to close so it is priced off exactly what the backtest measured - which is why a 5-minute strategy alerts about five minutes after the price it quotes.'}
                    {orderExpiry
                      ? ` This trigger runs entirely on the ${orderExpiry} expiry - its signals, its entry price and its order all come from that chain, independently of what any page is looking at. The strategy's SL/target points apply to that expiry's premium, which is a different risk from the near month.`
                      : ''}
                    {' '}A signal that fires while this trigger's earlier position is still open at Dhan never opens a second one -
                    {adjustStopLossOnOpenPosition
                      ? ' this trigger instead moves that position’s stop-loss to the new signal’s own entry price, reported as [STOP LOSS UPDATED].'
                      : ' it is skipped instead, reported as [NO ORDER PLACED].'}
                    {hedgeOtmSteps > 0
                      ? ` Every Sell signal also buys a cheaper, further-OTM option ${hedgeOtmSteps} strike step(s) beyond the sold one first, as protection - a credit spread instead of a naked sell. If the hedge leg can't be placed or priced, the whole order is aborted rather than selling naked. The hedge is closed automatically the moment the sold leg's own position closes (its stop-loss, target, or a manual square-off) - it has no stop-loss/target of its own. Only ever applies to Sell; a Buy signal has nothing to hedge.${
                        hedgeMinOiPercent > 0
                          ? ` That far strike is only bought if its open interest is at least ${hedgeMinOiPercent}% of the sold strike's - far-OTM strikes thin out, and one with no real book behind it means crossing a wide spread to buy something you may not be able to sell back. A strike that's too thin moves the hedge inward toward the sold leg to the first one that qualifies (never closer than ${Math.max(1, Math.floor(hedgeOtmSteps / 2))} step(s)), and the order is abandoned if none does. Any such move is reported in the order message.`
                          : ' The liquidity check is off, so the hedge is bought at that distance however thin the strike is.'
                      }`
                      : ''}
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

        <Card
          size="small"
          title="Order history"
          extra={
            <Select
              value={orderHistoryTriggerId}
              onChange={setOrderHistoryTriggerId}
              style={{ width: 220 }}
              options={[{ value: null, label: 'All triggers' }, ...triggers.map((t) => ({ value: t.id, label: t.name }))]}
            />
          }
        >
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
            Every outcome a live-trading trigger's order pipeline has produced - placed, filled,
            re-priced, cancelled, failed, or skipped - the same detail each one sends to Telegram,
            kept here so you can check what actually happened without depending on catching that
            message. Refreshes every 5s.
          </Text>
          <Table
            size="small"
            rowKey="id"
            dataSource={orderEvents}
            columns={orderHistoryColumns}
            pagination={{ pageSize: 10, size: 'small' }}
            locale={{ emptyText: 'No order activity yet - this fills in once a live-trading trigger fires.' }}
          />
        </Card>
      </Space>
    </div>
  )
}
