import { useEffect, useMemo, useRef, useState } from 'react'
import { Select, Space, Typography, Card, Button, Table, Tag, InputNumber, Statistic, Row, Col, DatePicker, TimePicker, Segmented, Alert, Empty, Tooltip } from 'antd'
import dayjs from 'dayjs'
import { PlayCircleOutlined, InfoCircleOutlined } from '@ant-design/icons'
import {
  UP_COLOR, DOWN_COLOR, CE_COLOR, PE_COLOR, NavBar, DirectionTag, fmtIstDateTime, fmtIstTime, fmtPrice,
  TIMEFRAME_OPTIONS, STORED_UNDERLYING, STORED_TIMEFRAME, usePersistedState,
} from './shared.jsx'

const { Title, Text } = Typography

// Only NIFTY/BANKNIFTY - Dhan's rolling-option docs only ever show "NSE_FNO" as the exchange
// segment, never a BSE one, so SENSEX is left out (see ExpiredOptionBacktestService's own comment).
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY']

const STORED_STRATEGY_KEY = 'optionanalytics.expiredBacktest.strategyKey'
const STORED_PARAM_VALUES = 'optionanalytics.expiredBacktest.paramValues'

const BUY_COLOR = '#4dabf7'
const SELL_COLOR = '#c084fc'
const OPEN_COLOR = '#ffb100'
const EXIT_REASON_COLOR = { TakeProfit: UP_COLOR, StopLoss: DOWN_COLOR, EndOfDay: undefined, NoData: undefined, SignalExit: undefined, SquareOff: undefined, Open: OPEN_COLOR }
const EXIT_REASON_LABEL = { TakeProfit: 'Take Profit', StopLoss: 'Stop Loss', EndOfDay: 'End of Day', NoData: 'No Data', SignalExit: 'Strategy Exit', SquareOff: 'Square Off', Open: 'Open' }

function fmtOption(row) {
  return `${row.strike} ${row.optionType}`
}

function renderPnl(v, isOpen) {
  if (v == null) return <Text type="secondary">—</Text>
  const color = v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined
  return (
    <Text strong style={{ color }}>
      {v > 0 ? '+' : ''}{v.toFixed(2)} pts{isOpen && <Text type="secondary" style={{ fontWeight: 400 }}> (unrealized)</Text>}
    </Text>
  )
}

// Runs a real strategy (trades, P&L, signals - not just a chart) against an EXPIRED contract, given
// an actual calendar expiry date instead of BacktestPage's "whatever is currently live". Only two
// strategies can run here at all (see /api/expired-backtest/strategies) - the rest need order-flow
// data across the whole surrounding strike chain that Dhan's rolling-option endpoint cannot supply
// from a single relative-strike call. Deliberately a separate page/engine from Backtrack: that one
// always reads this app's own in-memory live/backfilled history, which has no way to reach an
// expiry that has already rolled off.
export default function ExpiredBacktestPage() {
  const [underlying, setUnderlying] = usePersistedState(STORED_UNDERLYING, 'NIFTY')
  const [timeframe, setTimeframe] = usePersistedState(STORED_TIMEFRAME, 5)
  const [expiryFlag, setExpiryFlag] = useState('WEEK')
  const [expiryDate, setExpiryDate] = useState(null)
  const [lookbackDays, setLookbackDays] = useState(30)
  const [expiryCodeAdjust, setExpiryCodeAdjust] = useState(0)

  const [strategies, setStrategies] = useState([])
  const [strategyKey, setStrategyKey] = usePersistedState(STORED_STRATEGY_KEY, null)
  const [paramValues, setParamValues] = usePersistedState(STORED_PARAM_VALUES, {})
  const paramsForStrategyRef = useRef(strategyKey)

  const [result, setResult] = useState(null) // null = never run yet
  const [loading, setLoading] = useState(false)
  const [runError, setRunError] = useState(null)

  const strategy = strategies.find((s) => s.key === strategyKey) ?? null

  useEffect(() => {
    if (underlying && !UNDERLYINGS.includes(underlying)) setUnderlying('NIFTY')
    fetch('/api/expired-backtest/strategies')
      .then((r) => r.json())
      .then((list) => {
        setStrategies(list ?? [])
        setStrategyKey((current) => (list?.some((s) => s.key === current) ? current : list?.[0]?.key ?? null))
      })
      .catch((err) => console.error('Failed to load expired-backtest strategies:', err))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reset every parameter to the newly-picked strategy's own declared defaults - same rule
  // BacktestPage uses, skipped when paramValues already belongs to this exact strategy (the restore-
  // from-storage case on first load).
  useEffect(() => {
    if (!strategy) return
    if (paramsForStrategyRef.current === strategy.key) return
    setParamValues(Object.fromEntries(strategy.parameters.map((p) => [p.key, p.default])))
    paramsForStrategyRef.current = strategy.key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy])

  const canRun = Boolean(underlying && expiryDate && strategyKey)

  const run = () => {
    if (!canRun) return
    setLoading(true)
    setRunError(null)
    const params = new URLSearchParams({
      expiryFlag,
      expiryDate: expiryDate.format('YYYY-MM-DD'),
      lookbackDays: String(lookbackDays),
      strategy: strategyKey,
      timeframe: String(timeframe),
      expiryCodeAdjust: String(expiryCodeAdjust),
    })
    for (const [k, v] of Object.entries(paramValues)) params.set(k, String(v))

    fetch(`/api/expired-backtest/${underlying}/run?${params.toString()}`)
      .then(async (r) => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.error || `Request failed (HTTP ${r.status}).`)
        return body
      })
      .then((body) => setResult(body))
      .catch((err) => {
        console.error('Failed to run expired-option backtest:', err)
        setResult(null)
        setRunError(err.message || 'Failed to run this backtest.')
      })
      .finally(() => setLoading(false))
  }

  const trades = result?.trades ?? []
  const signals = result?.signals ?? []

  const summary = useMemo(() => {
    const openCount = trades.filter((t) => t.exitReason === 'Open').length
    const closed = trades.filter((t) => t.pnlPoints != null && t.exitReason !== 'Open')
    if (closed.length === 0) return openCount > 0 ? { count: 0, openCount } : null
    const wins = closed.filter((t) => t.pnlPoints > 0).length
    const totalPnl = closed.reduce((sum, t) => sum + t.pnlPoints, 0)
    return { count: closed.length, openCount, wins, losses: closed.length - wins, winRate: (wins / closed.length) * 100, totalPnl, avgPnl: totalPnl / closed.length }
    // trades is a fresh [] literal whenever result is null, so depending on `result` instead keeps
    // this memoized across renders that don't actually change the data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result])

  const tradeColumns = [
    { title: 'Signal Time', dataIndex: 'signalTimeUtc', key: 'signalTimeUtc', width: 180, render: (t) => fmtIstDateTime(t) },
    { title: 'Direction', dataIndex: 'direction', key: 'direction', width: 110, render: (direction) => <DirectionTag direction={direction} /> },
    {
      title: 'Position', key: 'position', width: 170,
      render: (_, row) => (
        <Space size={6}>
          <Tag color={row.side === 'Sell' ? SELL_COLOR : BUY_COLOR}>{row.side === 'Sell' ? 'SELL' : 'BUY'}</Tag>
          <Text style={{ color: row.optionType === 'CE' ? CE_COLOR : PE_COLOR }}>{fmtOption(row)}</Text>
        </Space>
      ),
    },
    { title: 'Spot', dataIndex: 'spotPrice', key: 'spotPrice', width: 100, render: (v) => (v == null ? <Text type="secondary">—</Text> : fmtPrice(v)) },
    {
      title: 'Entry', key: 'entry', width: 170,
      render: (_, row) => row.entryTimeUtc ? <>{fmtIstTime(row.entryTimeUtc)} @ {row.entryPrice?.toFixed(2)}</> : <Text type="secondary">—</Text>,
    },
    {
      title: 'Exit', key: 'exit', width: 170,
      render: (_, row) => {
        if (!row.exitTimeUtc) return <Text type="secondary">—</Text>
        const price = row.exitPrice?.toFixed(2)
        return row.exitReason === 'Open'
          ? <><Text type="secondary" style={{ fontSize: 11 }}>as of </Text>{fmtIstTime(row.exitTimeUtc)} @ {price}</>
          : <>{fmtIstTime(row.exitTimeUtc)} @ {price}</>
      },
    },
    { title: 'Reason', dataIndex: 'exitReason', key: 'exitReason', width: 120, render: (reason) => <Tag color={EXIT_REASON_COLOR[reason]}>{EXIT_REASON_LABEL[reason] ?? reason}</Tag> },
    { title: 'P&L', dataIndex: 'pnlPoints', key: 'pnlPoints', width: 130, render: (v, row) => renderPnl(v, row.exitReason === 'Open') },
  ]

  const signalColumns = [
    { title: 'Time', dataIndex: 'timeUtc', key: 'timeUtc', width: 200, render: (t) => fmtIstDateTime(t) },
    {
      title: 'Signal', dataIndex: 'kind', key: 'kind', width: 130,
      render: (kind, row) => (
        <Tag color={kind === 'Entry' ? (row.direction === 'Bullish' ? UP_COLOR : DOWN_COLOR) : undefined} style={{ fontWeight: kind === 'Entry' ? 700 : 400, opacity: kind === 'Rejected' ? 0.6 : 1 }}>
          {kind === 'Rejected' ? 'rejected' : kind.toUpperCase()}
        </Tag>
      ),
    },
    { title: 'Direction', dataIndex: 'direction', key: 'direction', width: 130, render: (direction) => <DirectionTag direction={direction} /> },
    { title: 'Summary', dataIndex: 'summary', key: 'summary' },
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
          title="Expired Contract Backtest"
          extra={<Text type="secondary" style={{ fontSize: 12 }}>{strategy?.description ?? 'Loading strategies…'}</Text>}
        >
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Space align="end" size={16} wrap>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Underlying</Text>
                <Select value={underlying} onChange={setUnderlying} style={{ width: 140 }} options={UNDERLYINGS.map((u) => ({ value: u, label: u }))} />
              </Space>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Expiry cadence</Text>
                <Segmented value={expiryFlag} onChange={setExpiryFlag} options={[{ label: 'Weekly', value: 'WEEK' }, { label: 'Monthly', value: 'MONTH' }]} />
              </Space>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Expiry date</Text>
                <DatePicker value={expiryDate} onChange={setExpiryDate} format="DD MMM YYYY" placeholder="Contract's expiry" style={{ width: 160 }} />
              </Space>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Lookback (days)</Text>
                <InputNumber min={5} max={180} value={lookbackDays} onChange={(v) => setLookbackDays(v ?? 30)} style={{ width: 110 }} />
              </Space>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Timeframe</Text>
                <Select value={timeframe} onChange={setTimeframe} style={{ width: 110 }} options={TIMEFRAME_OPTIONS} />
              </Space>
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>Strategy</Text>
                <Select value={strategyKey} onChange={setStrategyKey} style={{ width: 220 }} options={strategies.map((s) => ({ value: s.key, label: s.name }))} />
              </Space>
            </Space>

            <Space align="end" size={16} wrap>
              {strategy?.parameters.map((p) => (
                <Space direction="vertical" size={2} key={p.key}>
                  <Text type="secondary" style={{ fontSize: 12 }}>{p.label}</Text>
                  {p.key === 'squareOffMinutes' || p.key === 'signalStartMinutes' ? (
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
              <Space direction="vertical" size={2}>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Expiry cycle nudge <Tooltip title="Which contract this resolves to is derived, not stated by Dhan directly - if the results below don't look like the right contract, nudge this up/down and re-run."><InfoCircleOutlined /></Tooltip>
                </Text>
                <InputNumber min={-5} max={5} value={expiryCodeAdjust} onChange={(v) => setExpiryCodeAdjust(v ?? 0)} style={{ width: 90 }} />
              </Space>
              <Button type="primary" icon={<PlayCircleOutlined />} onClick={run} loading={loading} disabled={!canRun}>Run</Button>
            </Space>
          </Space>
        </Card>

        {runError && <Alert type="error" showIcon message={runError} />}

        {result && (() => {
          const spliceCount = (result.ceSpliceTimes?.length ?? 0) + (result.peSpliceTimes?.length ?? 0)
          const hasWarning = Boolean(result.ceError || result.peError || spliceCount > 0)
          return (
            <Alert
              type={hasWarning ? 'warning' : 'info'}
              showIcon
              message={
                <Space direction="vertical" size={2}>
                  <Text>
                    Resolved to expiryCode {result.expiryCode} ({expiryFlag === 'WEEK' ? 'weekly' : 'monthly'}) - CE at {result.ceStrike}, PE at {result.peStrike}.
                    {' '}{result.spotBarCount} spot bar(s) fetched; {result.ceBarCount} CE bar(s), {result.peBarCount} PE bar(s) actually used for the backtest.
                  </Text>
                  {result.ceError && <Text type="warning">CE: {result.ceError}</Text>}
                  {result.peError && <Text type="warning">PE: {result.peError}</Text>}
                  {spliceCount > 0 && (
                    <Text type="warning">
                      A contract splice was detected at{' '}
                      {[...(result.ceSpliceTimes ?? []).map((t) => `CE ${fmtIstDateTime(t)}`), ...(result.peSpliceTimes ?? []).map((t) => `PE ${fmtIstDateTime(t)}`)].join(', ')}
                      {' '}(a large, sudden premium jump - the lookback window was wide enough to reach an earlier contract before this one). The data before that point has already been trimmed away automatically - only the bars after the last splice were used above, so the backtest still ran against just the single contract nearest your chosen expiry.
                    </Text>
                  )}
                </Space>
              }
            />
          )
        })()}

        {result && summary && (
          <Card size="small">
            <Row gutter={24}>
              <Col><Statistic title="Closed trades" value={summary.count} /></Col>
              {summary.openCount > 0 && <Col><Statistic title="Still open" value={summary.openCount} valueStyle={{ color: OPEN_COLOR }} /></Col>}
              {summary.count > 0 && <>
                <Col><Statistic title="Win rate" value={summary.winRate} precision={1} suffix="%" /></Col>
                <Col><Statistic title="Wins / Losses" value={`${summary.wins} / ${summary.losses}`} /></Col>
                <Col><Statistic title="Total P&L" value={summary.totalPnl} precision={2} suffix="pts" valueStyle={{ color: summary.totalPnl >= 0 ? UP_COLOR : DOWN_COLOR }} /></Col>
                <Col><Statistic title="Avg P&L / trade" value={summary.avgPnl} precision={2} suffix="pts" valueStyle={{ color: summary.avgPnl >= 0 ? UP_COLOR : DOWN_COLOR }} /></Col>
              </>}
            </Row>
          </Card>
        )}

        {!result ? (
          <Card size="small">
            <Empty description="Pick an expiry date and strategy above, then click Run." />
          </Card>
        ) : (
          <>
            <Card size="small" title="Trades">
              <Table
                size="small"
                rowKey={(r, i) => `${r.signalTimeUtc}-${i}`}
                dataSource={trades}
                columns={tradeColumns}
                pagination={{ pageSize: 50, showSizeChanger: true, pageSizeOptions: [25, 50, 100] }}
                locale={{ emptyText: 'No trades - no entry signals over this window, or click Run to try different settings.' }}
              />
            </Card>

            <Card size="small" title="Signals">
              <Table
                size="small"
                rowKey={(r, i) => `${r.timeUtc}-${i}`}
                dataSource={signals}
                columns={signalColumns}
                pagination={{ pageSize: 50, showSizeChanger: true, pageSizeOptions: [25, 50, 100] }}
                locale={{ emptyText: 'No signals over this window.' }}
              />
            </Card>
          </>
        )}
      </Space>
    </div>
  )
}
