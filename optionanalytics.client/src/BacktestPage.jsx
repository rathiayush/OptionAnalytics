import { useEffect, useMemo, useState } from 'react'
import { Select, Space, Typography, Spin, Card, Button, Table, Tag, InputNumber, Statistic, Row, Col } from 'antd'
import { ReloadOutlined, PlayCircleOutlined } from '@ant-design/icons'
import { UP_COLOR, DOWN_COLOR, CE_COLOR, PE_COLOR, NavBar, DirectionTag, ALERT_KIND_LABEL } from './shared.jsx'

const { Title, Text } = Typography

const TIMEFRAME_OPTIONS = [
  { value: 1, label: '1 min' },
  { value: 2, label: '2 min' },
  { value: 5, label: '5 min' },
]

const EXIT_REASON_COLOR = { TakeProfit: UP_COLOR, StopLoss: DOWN_COLOR, EndOfDay: undefined, NoData: undefined }
const EXIT_REASON_LABEL = { TakeProfit: 'Take Profit', StopLoss: 'Stop Loss', EndOfDay: 'End of Day', NoData: 'No Data' }

function fmtOption(row) {
  return `${row.strike} ${row.optionType}`
}

function renderPnl(v) {
  if (v == null) return <Text type="secondary">—</Text>
  const color = v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined
  return <Text strong style={{ color }}>{v > 0 ? '+' : ''}{v.toFixed(2)}%</Text>
}

// Re-runs ConfluenceAlertService's exact leg-flip + confluence logic offline over whatever
// spot/ATM CE/PE candle history the backend currently holds in memory (see BacktestService) - lets
// you check what the live alert engine would have fired without waiting for it to happen live, and
// simulate a simple OTM CE/PE trade (configurable strike offset + SL/TP%) off each Confluence
// signal to see how that strategy would have played out.
export default function BacktestPage() {
  const [underlyings, setUnderlyings] = useState([])
  const [selected, setSelected] = useState(null)
  const [timeframe, setTimeframe] = useState(1)

  const [signals, setSignals] = useState(null)
  const [signalsLoading, setSignalsLoading] = useState(false)

  const [otmSteps, setOtmSteps] = useState(1)
  const [slPercent, setSlPercent] = useState(20)
  const [tpPercent, setTpPercent] = useState(40)
  const [trades, setTrades] = useState(null)
  const [tradesLoading, setTradesLoading] = useState(false)

  useEffect(() => {
    fetch('/api/spot/underlyings')
      .then((r) => r.json())
      .then((list) => {
        setUnderlyings(list)
        if (list.length > 0) setSelected(list[0].underlying)
      })
      .catch((err) => console.error('Failed to load underlyings:', err))
  }, [])

  const loadSignals = (underlying, tf) => {
    if (!underlying) return
    setSignalsLoading(true)
    fetch(`/api/backtest/${underlying}?timeframe=${tf}`)
      .then((r) => r.json())
      .then((data) => setSignals(data ?? []))
      .catch((err) => console.error('Failed to load backtest signals:', err))
      .finally(() => setSignalsLoading(false))
  }

  const runTrades = () => {
    if (!selected) return
    setTradesLoading(true)
    fetch(`/api/backtest/${selected}/trades?timeframe=${timeframe}&otmSteps=${otmSteps}&slPercent=${slPercent}&tpPercent=${tpPercent}`)
      .then((r) => r.json())
      .then((data) => setTrades(data ?? []))
      .catch((err) => console.error('Failed to load backtest trades:', err))
      .finally(() => setTradesLoading(false))
  }

  // Signals (and a first trade run) refresh automatically on underlying/timeframe - those are
  // discrete dropdown choices, not something typed. otmSteps/SL%/TP% only apply when "Run" is
  // clicked, so adjusting them doesn't fire a request on every keystroke.
  useEffect(() => {
    loadSignals(selected, timeframe)
    runTrades()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, timeframe])

  const summary = useMemo(() => {
    const closed = (trades ?? []).filter((t) => t.pnlPercent != null)
    if (closed.length === 0) return null
    const wins = closed.filter((t) => t.pnlPercent > 0).length
    const totalPnl = closed.reduce((sum, t) => sum + t.pnlPercent, 0)
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
    { title: 'Time', dataIndex: 'timeUtc', key: 'timeUtc', width: 200, render: (t) => new Date(t).toLocaleString() },
    {
      title: 'Signal',
      dataIndex: 'kind',
      key: 'kind',
      width: 160,
      render: (kind, row) => {
        const isConfluence = kind === 'Confluence'
        return (
          <Tag color={isConfluence ? (row.direction === 'Bullish' ? UP_COLOR : DOWN_COLOR) : undefined} style={{ fontWeight: isConfluence ? 700 : 400 }}>
            {isConfluence ? 'CONFLUENCE' : (ALERT_KIND_LABEL[kind] ?? kind)}
          </Tag>
        )
      },
    },
    { title: 'Direction', dataIndex: 'direction', key: 'direction', width: 130, render: (direction) => <DirectionTag direction={direction} /> },
    { title: 'Summary', dataIndex: 'summary', key: 'summary' },
  ]

  const tradeColumns = [
    { title: 'Signal Time', dataIndex: 'signalTimeUtc', key: 'signalTimeUtc', width: 180, render: (t) => new Date(t).toLocaleString() },
    { title: 'Direction', dataIndex: 'direction', key: 'direction', width: 110, render: (direction) => <DirectionTag direction={direction} /> },
    {
      title: 'Option',
      key: 'option',
      width: 110,
      render: (_, row) => <Text style={{ color: row.optionType === 'CE' ? CE_COLOR : PE_COLOR }}>{fmtOption(row)}</Text>,
    },
    {
      title: 'Entry',
      key: 'entry',
      width: 170,
      render: (_, row) => row.entryTimeUtc ? <>{new Date(row.entryTimeUtc).toLocaleTimeString()} @ {row.entryPrice?.toFixed(2)}</> : <Text type="secondary">—</Text>,
    },
    {
      title: 'Exit',
      key: 'exit',
      width: 170,
      render: (_, row) => row.exitTimeUtc ? <>{new Date(row.exitTimeUtc).toLocaleTimeString()} @ {row.exitPrice?.toFixed(2)}</> : <Text type="secondary">—</Text>,
    },
    {
      title: 'Reason',
      dataIndex: 'exitReason',
      key: 'exitReason',
      width: 120,
      render: (reason) => <Tag color={EXIT_REASON_COLOR[reason]}>{EXIT_REASON_LABEL[reason] ?? reason}</Tag>,
    },
    { title: 'P&L', dataIndex: 'pnlPercent', key: 'pnlPercent', width: 100, render: renderPnl },
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
          <Button icon={<ReloadOutlined />} onClick={() => loadSignals(selected, timeframe)} loading={signalsLoading} disabled={!selected}>
            Re-run signals
          </Button>
        </Space>

        <Card
          size="small"
          title="Backtrack — Signal Replay"
          extra={<Text type="secondary" style={{ fontSize: 12 }}>Replays EMA 9/21 + confluence logic over in-memory history</Text>}
        >
          <Text type="secondary">
            Every spot / ATM CE / ATM PE EMA 9/21 flip and three-way CONFLUENCE alignment that would have
            fired across {selected ?? 'the selected underlying'}'s currently-backfilled candle history at
            the {timeframe}-minute timeframe, computed fresh from scratch - not the live alert log, so it
            also covers bars that closed before this session's alert engine started.
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

        <Card
          size="small"
          title="Simulated OTM Trade — every Confluence signal"
          extra={<Text type="secondary" style={{ fontSize: 12 }}>Buy CE/PE on Confluence, exit on SL/TP or day close</Text>}
        >
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Space align="end" size={16} wrap>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>OTM steps from ATM</Text>
                <InputNumber min={0} max={8} value={otmSteps} onChange={(v) => setOtmSteps(v ?? 0)} style={{ width: 110 }} />
              </Space>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Stop loss %</Text>
                <InputNumber min={0.1} max={100} value={slPercent} onChange={(v) => setSlPercent(v ?? 20)} style={{ width: 110 }} />
              </Space>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Take profit %</Text>
                <InputNumber min={0.1} max={500} value={tpPercent} onChange={(v) => setTpPercent(v ?? 40)} style={{ width: 110 }} />
              </Space>
              <Button type="primary" icon={<PlayCircleOutlined />} onClick={runTrades} loading={tradesLoading} disabled={!selected}>
                Run
              </Button>
            </Space>

            {summary && (
              <Row gutter={24}>
                <Col><Statistic title="Trades" value={summary.count} /></Col>
                <Col><Statistic title="Wins / Losses" value={`${summary.wins} / ${summary.losses}`} /></Col>
                <Col><Statistic title="Win rate" value={summary.winRate} precision={1} suffix="%" /></Col>
                <Col><Statistic title="Total P&L" value={summary.totalPnl} precision={2} suffix="%" styles={{ content: { color: summary.totalPnl >= 0 ? UP_COLOR : DOWN_COLOR } }} /></Col>
                <Col><Statistic title="Avg P&L / trade" value={summary.avgPnl} precision={2} suffix="%" styles={{ content: { color: summary.avgPnl >= 0 ? UP_COLOR : DOWN_COLOR } }} /></Col>
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
      </Space>
    </div>
  )
}
