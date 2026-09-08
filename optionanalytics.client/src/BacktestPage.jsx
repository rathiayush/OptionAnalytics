import { useEffect, useMemo, useRef, useState } from 'react'
import { Select, Space, Typography, Spin, Card, Button, Table, Tag, InputNumber, Statistic, Row, Col, DatePicker, TimePicker } from 'antd'
import dayjs from 'dayjs'
import { ReloadOutlined, PlayCircleOutlined } from '@ant-design/icons'
import { UP_COLOR, DOWN_COLOR, CE_COLOR, PE_COLOR, NavBar, DirectionTag, ALERT_KIND_LABEL, fmtIstDateTime, fmtIstTime, fmtPrice, istDateKey, TIMEFRAME_OPTIONS, STORED_UNDERLYING, STORED_TIMEFRAME, usePersistedState, pickUnderlying, useExpirySelector, ExpirySelect, withExpiry } from './shared.jsx'

// This page's own persisted keys - underlying/timeframe are shared across every page (see
// STORED_UNDERLYING/STORED_TIMEFRAME above), but strategy/parameters/date-range only mean
// anything here, so they get their own Backtrack-specific storage keys instead.
const STORED_STRATEGY_KEY = 'optionanalytics.backtest.strategyKey'
const STORED_PARAM_VALUES = 'optionanalytics.backtest.paramValues'
const STORED_DATE_RANGE = 'optionanalytics.backtest.dateRange'

const { Title, Text } = Typography
const { RangePicker } = DatePicker

// Buy/Sell deliberately aren't the up/down colors - a SOLD position is neither bullish nor
// bearish on its own leg's premium, and reusing green/red here would read as "profitable".
const BUY_COLOR = '#4dabf7'
const SELL_COLOR = '#c084fc'

const SIGNAL_KIND_LABEL = { ...ALERT_KIND_LABEL, Entry: 'ENTRY', Rejected: 'rejected' }

// Amber, not green/red/neutral - Open is neither a win nor a loss yet, and reusing a settled
// color would misread as a finished result on a row that can still move.
const OPEN_COLOR = '#ffb100'
const EXIT_REASON_COLOR = { TakeProfit: UP_COLOR, StopLoss: DOWN_COLOR, EndOfDay: undefined, NoData: undefined, SignalExit: undefined, SquareOff: undefined, Open: OPEN_COLOR }
// SignalExit is a strategy's own exit rule firing rather than a price level being hit - the 5 EMA
// strategy's "get out when spot comes back and touches the EMA" is the one that uses it today.
// SquareOff is the user-configured daily cutoff (OptionTradeSimulator.SquareOffTimeParameter) -
// also rule-based rather than a price level, so it shares SignalExit's neutral, undefined color.
//
// Open is NOT a completed trade: it is a position opened TODAY that has not yet hit its stop,
// target, or a strategy exit rule, and today's session has not finished - so there is no real exit
// to report. Its Exit column shows the last known price, not a fill, and its P&L is unrealized (see
// renderPnl) - both can still change before this row would ever legitimately read "End of Day".
const EXIT_REASON_LABEL = { TakeProfit: 'Take Profit', StopLoss: 'Stop Loss', EndOfDay: 'End of Day', NoData: 'No Data', SignalExit: 'Strategy Exit', SquareOff: 'Square Off', Open: 'Open' }

function isConfluenceLabel(kind) {
  return kind === 'Confluence' ? 'CONFLUENCE' : (SIGNAL_KIND_LABEL[kind] ?? kind)
}

function fmtOption(row) {
  return `${row.strike} ${row.optionType}`
}

function renderCrossState(v) {
  if (!v) return <Text type="secondary">—</Text>
  const isUp = v === 'Up'
  return <Tag color={isUp ? UP_COLOR : DOWN_COLOR}>{isUp ? '▲ Up' : '▼ Down'}</Tag>
}

// isOpen marks the figure as unrealized - a still-running position's P&L is marked to the last
// known price, not a real fill, and can still move before the position actually closes.
function renderPnl(v, isOpen) {
  if (v == null) return <Text type="secondary">—</Text>
  const color = v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined
  return (
    <Text strong style={{ color }}>
      {v > 0 ? '+' : ''}{v.toFixed(2)} pts{isOpen && <Text type="secondary" style={{ fontWeight: 400 }}> (unrealized)</Text>}
    </Text>
  )
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
  // Shared with every other page and remembered across reloads - see usePersistedState.
  const [selected, setSelected] = usePersistedState(STORED_UNDERLYING, null)
  const [timeframe, setTimeframe] = usePersistedState(STORED_TIMEFRAME, 1)

  const [signals, setSignals] = useState(null)
  const [signalsLoading, setSignalsLoading] = useState(false)

  const [strategies, setStrategies] = useState([])
  // Persisted like underlying/timeframe, so a refresh comes back to the same strategy and the same
  // tuned parameters rather than resetting to the first strategy's defaults every time.
  const [strategyKey, setStrategyKey] = usePersistedState(STORED_STRATEGY_KEY, null)
  const [paramValues, setParamValues] = usePersistedState(STORED_PARAM_VALUES, {})
  const [trades, setTrades] = useState(null)
  const [tradesLoading, setTradesLoading] = useState(false)

  // Which strategy key paramValues currently reflects - seeded from the RESTORED strategyKey so a
  // page load that finds matching stored parameters keeps them, rather than the defaults-reset
  // effect below immediately overwriting them before the user ever sees them. Only a genuine
  // strategy SWITCH (this ref no longer matching strategy.key) resets to that strategy's own
  // declared defaults.
  const paramsForStrategyRef = useRef(strategyKey)

  // Which IST days to show. Purely a VIEW filter applied after the run - the backtest itself always
  // runs over the whole backfilled window, because a strategy needs the bars before a day to have
  // its EMAs (and the simulator its one-position-at-a-time state) right on that day. Narrowing what
  // is fed to the strategy would change the answers rather than just the rows on screen.
  // Persisted as plain ISO date strings (dayjs instances themselves are not JSON-safe - see
  // usePersistedState) rather than through that hook directly.
  const [dateRange, setDateRangeState] = useState(() => {
    try {
      const raw = window.localStorage.getItem(STORED_DATE_RANGE)
      if (!raw) return null
      const [from, to] = JSON.parse(raw)
      return [from ? dayjs(from) : null, to ? dayjs(to) : null]
    } catch {
      return null
    }
  })
  const setDateRange = (range) => {
    setDateRangeState(range)
    try {
      window.localStorage.setItem(STORED_DATE_RANGE, JSON.stringify([
        range?.[0] ? range[0].format('YYYY-MM-DD') : null,
        range?.[1] ? range[1].format('YYYY-MM-DD') : null,
      ]))
    } catch {
      // Remembering the date filter is a convenience, never a requirement - see usePersistedState.
    }
  }

  const strategy = strategies.find((s) => s.key === strategyKey) ?? null

  // Which expiry THIS PAGE backtests against - see useExpirySelector. Every tracked expiry is held
  // live server-side, so this is just a different ?expiry= on this page's own requests: backtesting
  // next month here leaves the Dashboard and every armed trigger exactly where they were.
  const { expiries, selectedExpiry, expiryParam, isManual: expiryIsManual, loading: expiryLoading, selectExpiry } = useExpirySelector(selected)
  const handleExpiryChange = (expiry) => {
    selectExpiry(expiry).then(() => {
      loadSignals()
      runTrades()
    })
  }

  useEffect(() => {
    fetch('/api/spot/underlyings')
      .then((r) => r.json())
      .then((list) => {
        setUnderlyings(list)
        setSelected((current) => pickUnderlying(list, current))
      })
      .catch((err) => console.error('Failed to load underlyings:', err))

    fetch('/api/backtest/strategies')
      .then((r) => r.json())
      .then((list) => {
        setStrategies(list ?? [])
        // Keep a restored strategyKey if the backend still offers it (same stale-value protection
        // pickUnderlying gives the underlying selector); only fall back to the first strategy when
        // there is nothing valid already selected.
        setStrategyKey((current) => (list?.some((s) => s.key === current) ? current : list?.[0]?.key ?? null))
      })
      .catch((err) => console.error('Failed to load backtest strategies:', err))
  }, [])

  // Reset every parameter to the newly-picked strategy's own declared defaults - each strategy's
  // parameters are independent (a different key set entirely), so values from the previous
  // strategy would be meaningless carried over. Skipped when paramValues already belongs to this
  // exact strategy (paramsForStrategyRef) - the case right after a page load that restored both a
  // strategyKey and matching paramValues from storage, which must survive this effect's first run
  // rather than being immediately overwritten by fresh defaults.
  useEffect(() => {
    if (!strategy) return
    if (paramsForStrategyRef.current === strategy.key) return
    setParamValues(Object.fromEntries(strategy.parameters.map((p) => [p.key, p.default])))
    paramsForStrategyRef.current = strategy.key
  }, [strategy])

  // The signal table describes whichever strategy is selected - each strategy reports the signals
  // IT reasons about (see the backend's IBacktestStrategy.EntrySignals), so the table always
  // explains the trades listed under it instead of always describing the confluence rule.
  const loadSignals = () => {
    if (!selected || !strategyKey) return
    setSignalsLoading(true)
    const paramQuery = Object.entries(paramValues).map(([k, v]) => `${k}=${v}`).join('&')
    fetch(withExpiry(`/api/backtest/${selected}?strategy=${strategyKey}&timeframe=${timeframe}&${paramQuery}`, expiryParam))
      .then((r) => r.json())
      .then((data) => setSignals(data ?? []))
      .catch((err) => console.error('Failed to load backtest signals:', err))
      .finally(() => setSignalsLoading(false))
  }

  const runTrades = () => {
    if (!selected || !strategyKey) return
    setTradesLoading(true)
    const paramQuery = Object.entries(paramValues).map(([k, v]) => `${k}=${v}`).join('&')
    fetch(withExpiry(`/api/backtest/${selected}/trades?strategy=${strategyKey}&timeframe=${timeframe}&${paramQuery}`, expiryParam))
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
  }, [selected, timeframe, strategyKey, strategy, expiryParam])

  const [fromDay, toDay] = useMemo(() => {
    const from = dateRange?.[0] ? dateRange[0].format('YYYY-MM-DD') : null
    const to = dateRange?.[1] ? dateRange[1].format('YYYY-MM-DD') : null
    return [from, to]
  }, [dateRange])

  // Both tables filter on the SIGNAL's own IST day - the day the strategy decided to act. A trade
  // entered late and exited the next morning therefore stays under the day that produced it, which
  // is the day you are looking at when you filter.
  const inRange = (iso) => {
    if (!fromDay && !toDay) return true
    const day = istDateKey(iso)
    return (!fromDay || day >= fromDay) && (!toDay || day <= toDay)
  }

  const visibleTrades = useMemo(
    () => (trades ?? []).filter((t) => inRange(t.signalTimeUtc)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trades, fromDay, toDay])

  const visibleSignals = useMemo(
    () => (signals ?? []).filter((sig) => inRange(sig.timeUtc)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [signals, fromDay, toDay])

  const summary = useMemo(() => {
    // Open positions are excluded from every stat below - they haven't actually closed, so folding
    // their unrealized P&L into Win rate/Total P&L would overstate a backtest whose most recent
    // position simply hasn't finished yet. openCount surfaces them separately instead of silently
    // dropping them from the summary entirely.
    const openCount = visibleTrades.filter((t) => t.exitReason === 'Open').length
    const closed = visibleTrades.filter((t) => t.pnlPoints != null && t.exitReason !== 'Open')
    if (closed.length === 0) return openCount > 0 ? { count: 0, openCount } : null
    const wins = closed.filter((t) => t.pnlPoints > 0).length
    const totalPnl = closed.reduce((sum, t) => sum + t.pnlPoints, 0)
    return {
      count: closed.length,
      openCount,
      wins,
      losses: closed.length - wins,
      winRate: (wins / closed.length) * 100,
      totalPnl,
      avgPnl: totalPnl / closed.length,
    }
  }, [visibleTrades])

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
    // Where each OBV line sits relative to the other at that signal - CE above PE is the bullish
    // arrangement, so the two are always mirrors of each other.
    { title: 'CE OBV', dataIndex: 'ceObvCross', key: 'ceObvCross', width: 100, render: renderCrossState },
    { title: 'PE OBV', dataIndex: 'peObvCross', key: 'peObvCross', width: 100, render: renderCrossState },
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
      render: (_, row) => {
        if (!row.exitTimeUtc) return <Text type="secondary">—</Text>
        const price = row.exitPrice?.toFixed(2)
        // Open has no real fill yet - this is where the position currently marks, not an exit.
        return row.exitReason === 'Open'
          ? <><Text type="secondary" style={{ fontSize: 11 }}>as of </Text>{fmtIstTime(row.exitTimeUtc)} @ {price}</>
          : <>{fmtIstTime(row.exitTimeUtc)} @ {price}</>
      },
    },
    {
      title: 'Reason',
      dataIndex: 'exitReason',
      key: 'exitReason',
      width: 120,
      render: (reason) => <Tag color={EXIT_REASON_COLOR[reason]}>{EXIT_REASON_LABEL[reason] ?? reason}</Tag>,
    },
    { title: 'P&L', dataIndex: 'pnlPoints', key: 'pnlPoints', width: 130, render: (v, row) => renderPnl(v, row.exitReason === 'Open') },
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
          <ExpirySelect expiries={expiries} value={selectedExpiry} isManual={expiryIsManual} loading={expiryLoading} onChange={handleExpiryChange} />
          <Select value={timeframe} onChange={setTimeframe} style={{ width: 120 }} options={TIMEFRAME_OPTIONS} />
          <RangePicker
            value={dateRange}
            onChange={setDateRange}
            allowEmpty={[true, true]}
            format="DD MMM YYYY"
            placeholder={['From date', 'To date']}
            style={{ width: 280 }}
          />
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
                  request below is built the same way either way. squareOffMinutes/
                  signalStartMinutes are the exception - still plain minutes-past-midnight-IST
                  numbers on the wire (see OptionTradeSimulator's own parameter builders), but
                  picking an exact minute on a bare number spinner is painful, so these two keys
                  render a time-of-day picker instead and do the minutes<->time conversion
                  themselves. */}
              {strategy?.parameters.map((p) => (
                <Space direction="vertical" size={2} key={p.key}>
                  <Text type="secondary" style={{ fontSize: 12 }}>{p.label}</Text>
                  {p.key === 'squareOffMinutes' || p.key === 'signalStartMinutes' ? (
                    // 12-hour with an explicit AM/PM selector, not 24-hour - a 24-hour-only field
                    // silently reads "03:10" as 3:10 AM when the trader meant 3:10 PM near market
                    // close, and (for squareOffMinutes) a cutoff that early is always in the past
                    // relative to any intraday entry, squaring every trade off on its very next
                    // bar. AM/PM makes that ambiguity impossible to enter by accident.
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
              <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => { loadSignals(); runTrades() }} loading={tradesLoading} disabled={!selected || !strategyKey}>
                Run
              </Button>
            </Space>

            {summary && (
              <Row gutter={24}>
                <Col><Statistic title="Trades" value={summary.count} /></Col>
                {/* Open positions are shown separately, not folded into the stats to their left -
                    see the summary computation for why (they have no realized P&L yet). */}
                {summary.openCount > 0 && (
                  <Col><Statistic title="Open" value={summary.openCount} styles={{ content: { color: OPEN_COLOR } }} /></Col>
                )}
                {summary.count > 0 && <>
                  <Col><Statistic title="Wins / Losses" value={`${summary.wins} / ${summary.losses}`} /></Col>
                  <Col><Statistic title="Win rate" value={summary.winRate} precision={1} suffix="%" /></Col>
                  <Col><Statistic title="Total P&L" value={summary.totalPnl} precision={2} suffix="pts" styles={{ content: { color: summary.totalPnl >= 0 ? UP_COLOR : DOWN_COLOR } }} /></Col>
                  <Col><Statistic title="Avg P&L / trade" value={summary.avgPnl} precision={2} suffix="pts" styles={{ content: { color: summary.avgPnl >= 0 ? UP_COLOR : DOWN_COLOR } }} /></Col>
                </>}
              </Row>
            )}

            {(fromDay || toDay) && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                Showing {visibleTrades.length} of {(trades ?? []).length} trades, filtered to{' '}
                {fromDay ?? 'the start'} – {toDay ?? 'the end'} (IST). The backtest still ran over the
                whole window; the stats above cover the filtered rows only.
              </Text>
            )}

            {tradesLoading && !trades ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
                <Spin size="large" />
              </div>
            ) : (
              <Table
                size="small"
                rowKey={(row) => `${row.signalTimeUtc}-${row.optionType}`}
                dataSource={visibleTrades}
                columns={tradeColumns}
                pagination={{ pageSize: 25, showSizeChanger: false }}
                locale={{ emptyText: (fromDay || toDay)
                  ? 'No trades on the selected dates - widen or clear the date filter.'
                  : 'No trades - no Confluence signals yet, or click Run to simulate with the current settings.' }}
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

        {(fromDay || toDay) && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            Showing {visibleSignals.length} of {(signals ?? []).length} signals, filtered to{' '}
            {fromDay ?? 'the start'} – {toDay ?? 'the end'} (IST).
          </Text>
        )}

        {signalsLoading && !signals ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
            <Spin size="large" />
          </div>
        ) : (
          <Table
            size="small"
            rowKey={(row) => `${row.timeUtc}-${row.kind}`}
            dataSource={visibleSignals}
            columns={signalColumns}
            pagination={{ pageSize: 25, showSizeChanger: false }}
            locale={{ emptyText: (fromDay || toDay)
              ? 'No signals on the selected dates - widen or clear the date filter.'
              : 'No signals - not enough closed-bar history yet, or the underlying has no backfilled candles.' }}
          />
        )}
      </Space>
    </div>
  )
}
