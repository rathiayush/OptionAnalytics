import { useEffect, useMemo, useState } from 'react'
import { Select, Space, Typography, Spin, Card, Button, Table, Tag, InputNumber, Statistic, Row, Col } from 'antd'
import { ReloadOutlined, PlayCircleOutlined } from '@ant-design/icons'
import { UP_COLOR, DOWN_COLOR, CE_COLOR, PE_COLOR, NavBar, DirectionTag, ALERT_KIND_LABEL, fmtIstDateTime, fmtIstTime, fmtPrice } from './shared.jsx'

const { Title, Text } = Typography

const TIMEFRAME_OPTIONS = [
  { value: 1, label: '1 min' },
  { value: 3, label: '3 min' },
  { value: 5, label: '5 min' },
  { value: 15, label: '15 min' },
]

// Buy/Sell deliberately aren't the up/down colors - a SOLD position is neither bullish nor
// bearish on its own leg's premium, and reusing green/red here would read as "profitable".
const BUY_COLOR = '#4dabf7'
const SELL_COLOR = '#c084fc'

const SIGNAL_KIND_LABEL = { ...ALERT_KIND_LABEL, Entry: 'ENTRY', Rejected: 'rejected' }

const EXIT_REASON_COLOR = { TakeProfit: UP_COLOR, StopLoss: DOWN_COLOR, EndOfDay: undefined, NoData: undefined }
const EXIT_REASON_LABEL = { TakeProfit: 'Take Profit', StopLoss: 'Stop Loss', EndOfDay: 'End of Day', NoData: 'No Data' }

function isConfluenceLabel(kind) {
  return kind === 'Confluence' ? 'CONFLUENCE' : (SIGNAL_KIND_LABEL[kind] ?? kind)
}

function fmtOption(row) {
  return `${row.strike} ${row.optionType}`
}

function renderPnl(v) {
  if (v == null) return <Text type="secondary">—</Text>
  const color = v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined
  return <Text strong style={{ color }}>{v > 0 ? '+' : ''}{v.toFixed(2)} pts</Text>
}

// Re-runs ConfluenceAlertService's exact leg-flip + confluence logic offline over whatever
// spot/ATM CE/PE candle history the backend currently holds in memory (see BacktestService) - lets
// you check what the live alert engine would have fired without waiting for it to happen live, and
// run any registered strategy (see the backend's Services/Backtesting/IBacktestStrategy) off those
// Confluence signals to see how it would have played out. The strategy picker and its parameter
// controls are both driven entirely by GET /api/backtest/strategies - a new backend strategy shows
// up here with no frontend change needed.
export default function BacktestPage() {
  const [underlyings, setUnderlyings] = useState([])
  const [selected, setSelected] = useState(null)
  const [timeframe, setTimeframe] = useState(1)

  const [signals, setSignals] = useState(null)
  const [signalsLoading, setSignalsLoading] = useState(false)

  const [strategies, setStrategies] = useState([])
  const [strategyKey, setStrategyKey] = useState(null)
  const [paramValues, setParamValues] = useState({})
  const [trades, setTrades] = useState(null)
  const [tradesLoading, setTradesLoading] = useState(false)

  const strategy = strategies.find((s) => s.key === strategyKey) ?? null

  useEffect(() => {
    fetch('/api/spot/underlyings')
      .then((r) => r.json())
      .then((list) => {
        setUnderlyings(list)
        if (list.length > 0) setSelected(list[0].underlying)
      })
      .catch((err) => console.error('Failed to load underlyings:', err))

    fetch('/api/backtest/strategies')
      .then((r) => r.json())
      .then((list) => {
        setStrategies(list ?? [])
        if (list?.length > 0) setStrategyKey(list[0].key)
      })
      .catch((err) => console.error('Failed to load backtest strategies:', err))
  }, [])

  // Reset every parameter to the newly-picked strategy's own declared defaults - each strategy's
  // parameters are independent (a different key set entirely), so values from the previous
  // strategy would be meaningless carried over.
  useEffect(() => {
    if (!strategy) return
    setParamValues(Object.fromEntries(strategy.parameters.map((p) => [p.key, p.default])))
  }, [strategy])

  // The signal table describes whichever strategy is selected - each strategy reports the signals
  // IT reasons about (see the backend's IBacktestStrategy.EntrySignals), so the table always
  // explains the trades listed under it instead of always describing the confluence rule.
  const loadSignals = () => {
    if (!selected || !strategyKey) return
    setSignalsLoading(true)
    const paramQuery = Object.entries(paramValues).map(([k, v]) => `${k}=${v}`).join('&')
    fetch(`/api/backtest/${selected}?strategy=${strategyKey}&timeframe=${timeframe}&${paramQuery}`)
      .then((r) => r.json())
      .then((data) => setSignals(data ?? []))
      .catch((err) => console.error('Failed to load backtest signals:', err))
      .finally(() => setSignalsLoading(false))
  }

  const runTrades = () => {
    if (!selected || !strategyKey) return
    setTradesLoading(true)
    const paramQuery = Object.entries(paramValues).map(([k, v]) => `${k}=${v}`).join('&')
    fetch(`/api/backtest/${selected}/trades?strategy=${strategyKey}&timeframe=${timeframe}&${paramQuery}`)
      .then((r) => r.json())
      .then((data) => setTrades(data ?? []))
      .catch((err) => console.error('Failed to load backtest trades:', err))
      .finally(() => setTradesLoading(false))
  }

  // Signals refresh automatically on underlying/timeframe - those are discrete dropdown choices,
  // not something typed. Strategy parameters only apply when "Run" is clicked, so adjusting them
  // doesn't fire a request on every keystroke.
  // Signals and trades both refresh together on underlying/timeframe/strategy - all discrete
  // dropdown choices. Strategy parameters only apply when "Run" is clicked, so adjusting them
  // doesn't fire a request on every keystroke.
  useEffect(() => {
    if (!strategy) return
    loadSignals()
    runTrades()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, timeframe, strategyKey, strategy])

  const summary = useMemo(() => {
    const closed = (trades ?? []).filter((t) => t.pnlPoints != null)
    if (closed.length === 0) return null
    const wins = closed.filter((t) => t.pnlPoints > 0).length
    const totalPnl = closed.reduce((sum, t) => sum + t.pnlPoints, 0)
    return {
      count: closed.length,
      wins,
      losses: closed.length - wins,
      winRate: (wins / closed.length) * 100,
      totalPnl,
      avgPnl: totalPnl / closed.length,
    }
  }, [trades])

  const signalColumns = [
    { title: 'Time', dataIndex: 'timeUtc', key: 'timeUtc', width: 200, render: (t) => fmtIstDateTime(t) },
    {
      title: 'Signal',
      dataIndex: 'kind',
      key: 'kind',
      width: 160,
      render: (kind, row) => {
        // A Confluence or an Entry is a signal that would actually be traded, so both get the
        // directional colour and bold; a Rejected one is deliberately muted - it is there to show
        // what the filters threw out and why, not to compete with the real signals.
        const isActionable = kind === 'Confluence' || kind === 'Entry'
        const isRejected = kind === 'Rejected'
        return (
          <Tag
            color={isActionable ? (row.direction === 'Bullish' ? UP_COLOR : DOWN_COLOR) : undefined}
            style={{ fontWeight: isActionable ? 700 : 400, opacity: isRejected ? 0.6 : 1 }}
          >
            {isConfluenceLabel(kind)}
          </Tag>
        )
      },
    },
    { title: 'Direction', dataIndex: 'direction', key: 'direction', width: 130, render: (direction) => <DirectionTag direction={direction} /> },
    { title: 'Summary', dataIndex: 'summary', key: 'summary' },
  ]

  const tradeColumns = [
    { title: 'Signal Time', dataIndex: 'signalTimeUtc', key: 'signalTimeUtc', width: 180, render: (t) => fmtIstDateTime(t) },
    { title: 'Direction', dataIndex: 'direction', key: 'direction', width: 110, render: (direction) => <DirectionTag direction={direction} /> },
    {
      title: 'Position',
      key: 'position',
      width: 170,
      render: (_, row) => (
        <Space size={6}>
          <Tag color={row.side === 'Sell' ? SELL_COLOR : BUY_COLOR}>{row.side === 'Sell' ? 'SELL' : 'BUY'}</Tag>
          <Text style={{ color: row.optionType === 'CE' ? CE_COLOR : PE_COLOR }}>{fmtOption(row)}</Text>
        </Space>
      ),
    },
    {
      title: 'Spot',
      dataIndex: 'spotPrice',
      key: 'spotPrice',
      width: 100,
      render: (v) => (v == null ? <Text type="secondary">—</Text> : fmtPrice(v)),
    },
    {
      title: 'Entry',
      key: 'entry',
      width: 170,
      render: (_, row) => row.entryTimeUtc ? <>{fmtIstTime(row.entryTimeUtc)} @ {row.entryPrice?.toFixed(2)}</> : <Text type="secondary">—</Text>,
    },
    {
      title: 'Exit',
      key: 'exit',
      width: 170,
      render: (_, row) => row.exitTimeUtc ? <>{fmtIstTime(row.exitTimeUtc)} @ {row.exitPrice?.toFixed(2)}</> : <Text type="secondary">—</Text>,
    },
    {
      title: 'Reason',
      dataIndex: 'exitReason',
      key: 'exitReason',
      width: 120,
      render: (reason) => <Tag color={EXIT_REASON_COLOR[reason]}>{EXIT_REASON_LABEL[reason] ?? reason}</Tag>,
    },
    { title: 'P&L', dataIndex: 'pnlPoints', key: 'pnlPoints', width: 100, render: renderPnl },
  ]

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
          <Select
            value={selected}
            onChange={setSelected}
            style={{ width: 160 }}
            options={underlyings.map((u) => ({ value: u.underlying, label: u.underlying }))}
          />
          <Select value={timeframe} onChange={setTimeframe} style={{ width: 120 }} options={TIMEFRAME_OPTIONS} />
          <Button icon={<ReloadOutlined />} onClick={loadSignals} loading={signalsLoading} disabled={!selected}>
            Re-run signals
          </Button>
        </Space>

        <Card
          size="small"
          title="Strategy Backtest"
          extra={<Text type="secondary" style={{ fontSize: 12 }}>{strategy?.description ?? 'Loading strategies…'}</Text>}
        >
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Space align="end" size={16} wrap>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Strategy</Text>
                <Select
                  value={strategyKey}
                  onChange={setStrategyKey}
                  style={{ width: 200 }}
                  options={strategies.map((s) => ({ value: s.key, label: s.name }))}
                />
              </Space>
              {/* A parameter that declares Options is a pick-one (rendered as a dropdown); one
                  that doesn't is a free number. Both still carry a plain numeric value, so the
                  request below is built the same way either way. */}
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
              <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => { loadSignals(); runTrades() }} loading={tradesLoading} disabled={!selected || !strategyKey}>
                Run
              </Button>
            </Space>

            {summary && (
              <Row gutter={24}>
                <Col><Statistic title="Trades" value={summary.count} /></Col>
                <Col><Statistic title="Wins / Losses" value={`${summary.wins} / ${summary.losses}`} /></Col>
                <Col><Statistic title="Win rate" value={summary.winRate} precision={1} suffix="%" /></Col>
                <Col><Statistic title="Total P&L" value={summary.totalPnl} precision={2} suffix="pts" styles={{ content: { color: summary.totalPnl >= 0 ? UP_COLOR : DOWN_COLOR } }} /></Col>
                <Col><Statistic title="Avg P&L / trade" value={summary.avgPnl} precision={2} suffix="pts" styles={{ content: { color: summary.avgPnl >= 0 ? UP_COLOR : DOWN_COLOR } }} /></Col>
              </Row>
            )}

            {tradesLoading && !trades ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
                <Spin size="large" />
              </div>
            ) : (
              <Table
                size="small"
                rowKey={(row) => `${row.signalTimeUtc}-${row.optionType}`}
                dataSource={trades ?? []}
                columns={tradeColumns}
                pagination={{ pageSize: 25, showSizeChanger: false }}
                locale={{ emptyText: 'No trades - no Confluence signals yet, or click Run to simulate with the current settings.' }}
              />
            )}
          </Space>
        </Card>

        <Card
          size="small"
          title={`Signals — ${strategy?.name ?? 'strategy'}`}
          extra={<Text type="secondary" style={{ fontSize: 12 }}>What the strategy above saw, newest first</Text>}
        >
          <Text type="secondary">
            Every signal the <b>{strategy?.name ?? 'selected strategy'}</b> rule examined across{' '}
            {selected ?? 'the selected underlying'}'s currently-backfilled candle history at the{' '}
            {timeframe}-minute timeframe, computed fresh from scratch - not the live alert log, so it also
            covers bars that closed before this session's alert engine started. Rows it would actually have
            traded are highlighted; the muted ones show what its filters rejected, and why.
          </Text>
        </Card>

        {signalsLoading && !signals ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
            <Spin size="large" />
          </div>
        ) : (
          <Table
            size="small"
            rowKey={(row) => `${row.timeUtc}-${row.kind}`}
            dataSource={signals ?? []}
            columns={signalColumns}
            pagination={{ pageSize: 25, showSizeChanger: false }}
            locale={{ emptyText: 'No signals - not enough closed-bar history yet, or the underlying has no backfilled candles.' }}
          />
        )}
      </Space>
    </div>
  )
}
