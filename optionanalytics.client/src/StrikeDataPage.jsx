import { useEffect, useMemo, useState } from 'react'
import { Card, Select, InputNumber, Space, Typography, Table, Button, Statistic, Row, Col, Empty } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import {
  NavBar, STORED_UNDERLYING, usePersistedState, pickUnderlying,
  useExpirySelector, ExpirySelect, withExpiry, fmtPrice, fmtIstTime, fmtIstDateTime, istDateKey,
  CE_COLOR, PE_COLOR, UP_COLOR, DOWN_COLOR,
} from './shared.jsx'

const { Title, Text } = Typography

const STORED_STRIKE_TYPE = 'optionanalytics.strikeData.optionType'

// One specific option contract's own raw history, laid out for INSPECTION rather than trading -
// "does 24200PE actually have a candle at 1:30pm on 17 Aug, or is that a real gap" is a question
// every other page answers only indirectly (a chart is hard to read at 1-minute resolution, and
// Backtrack's own "No Data" row names a signal, not the underlying data that produced it). This
// page exists to answer it directly: pick a strike, and see literally every candle GetOptionCandles
// would ever hand a strategy for it, plus a day-by-day rollup that makes a mid-session gap (the
// PR that added forward-fill) or a frozen-since-some-date series (the PR that fixed a strike
// falling out of the ATM window) obvious without having to eyeball a chart or a raw JSON response.
export default function StrikeDataPage() {
  const [underlyings, setUnderlyings] = useState([])
  const [underlying, setUnderlying] = usePersistedState(STORED_UNDERLYING, null)
  const { expiries, selectedExpiry, expiryParam, isManual: expiryIsManual, loading: expiryLoading, selectExpiry } = useExpirySelector(underlying)
  const [strike, setStrike] = useState(null)
  const [optionType, setOptionType] = usePersistedState(STORED_STRIKE_TYPE, 'CE')
  const [candles, setCandles] = useState(null) // null = never loaded yet, distinct from [] = loaded and empty
  const [trackedStrikes, setTrackedStrikes] = useState([])
  const [loading, setLoading] = useState(false)

  const step = underlyings.find((u) => u.underlying === underlying)?.step || 50

  useEffect(() => {
    fetch('/api/spot/underlyings')
      .then((r) => r.json())
      .then((list) => {
        setUnderlyings(list ?? [])
        setUnderlying((current) => pickUnderlying(list, current))
      })
      .catch((err) => console.error('Failed to load underlyings:', err))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const load = () => {
    if (!underlying || !strike) return
    setLoading(true)
    Promise.all([
      fetch(withExpiry(`/api/cdv/${underlying}/option/candles?strike=${strike}&type=${optionType}`, expiryParam)).then((r) => r.json()),
      fetch(withExpiry(`/api/cdv/${underlying}/strikes`, expiryParam)).then((r) => r.json()),
    ])
      .then(([candleData, strikeList]) => {
        setCandles(candleData ?? [])
        setTrackedStrikes(strikeList ?? [])
      })
      .catch((err) => {
        console.error('Failed to load strike data:', err)
        setCandles([])
      })
      .finally(() => setLoading(false))
  }

  // Reloads whenever any part of "which contract" changes - the same auto-refresh-on-selection
  // convention every other page here already follows, so picking a new strike doesn't also need a
  // separate click on Refresh.
  useEffect(() => { load() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [underlying, strike, optionType, expiryParam])

  // Descending (newest first) - the convention every other table on this app already uses
  // (Backtrack's signals/trades), and the more useful default here too: "is today's data there"
  // is usually the first thing worth checking, not the oldest day in a 45-day window.
  const rows = useMemo(
    () => (candles ?? []).map((c, i) => ({ ...c, key: i, day: istDateKey(c.time) })).reverse(),
    [candles],
  )

  const trackedInfo = useMemo(
    () => trackedStrikes.find((s) => s.strike === strike && s.isCall === (optionType === 'CE')) ?? null,
    [trackedStrikes, strike, optionType],
  )

  // One row per trading day actually present, most recent first, with a candle count and its own
  // first/last bar - a day with far fewer candles than its neighbours, or one that stops well
  // before market close, is exactly what a frozen or partially-tracked series (see
  // BacktestService.IsTrackedSeriesComplete) looks like from here.
  const dayRollup = useMemo(() => {
    const byDay = new Map()
    for (const row of rows) {
      const existing = byDay.get(row.day)
      if (existing) {
        existing.count += 1
        existing.firstTime = row.time < existing.firstTime ? row.time : existing.firstTime
        existing.lastTime = row.time > existing.lastTime ? row.time : existing.lastTime
      } else {
        byDay.set(row.day, { day: row.day, count: 1, firstTime: row.time, lastTime: row.time })
      }
    }
    return [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1))
  }, [rows])

  const dayColumns = [
    { title: 'Trading day', dataIndex: 'day', key: 'day', width: 140 },
    { title: 'Candles', dataIndex: 'count', key: 'count', width: 100, align: 'right' },
    { title: 'First bar', dataIndex: 'firstTime', key: 'firstTime', width: 110, render: fmtIstTime },
    { title: 'Last bar', dataIndex: 'lastTime', key: 'lastTime', width: 110, render: fmtIstTime },
  ]

  const candleColumns = [
    { title: 'Day', dataIndex: 'day', key: 'day', width: 120 },
    { title: 'Time (IST)', dataIndex: 'time', key: 'time', width: 100, render: fmtIstTime },
    { title: 'Open', dataIndex: 'open', key: 'open', width: 100, align: 'right', render: fmtPrice },
    { title: 'High', dataIndex: 'high', key: 'high', width: 100, align: 'right', render: fmtPrice },
    { title: 'Low', dataIndex: 'low', key: 'low', width: 100, align: 'right', render: fmtPrice },
    { title: 'Close', dataIndex: 'close', key: 'close', width: 100, align: 'right', render: fmtPrice },
  ]

  const hasLoaded = candles !== null

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
          <Select
            value={underlying}
            onChange={(v) => { setUnderlying(v); setStrike(null) }}
            style={{ width: 140 }}
            options={underlyings.map((u) => ({ value: u.underlying, label: u.underlying }))}
          />
          <ExpirySelect expiries={expiries} value={selectedExpiry} isManual={expiryIsManual} loading={expiryLoading} onChange={selectExpiry} />
          <InputNumber
            controls={false}
            placeholder="Strike"
            min={0}
            step={step}
            value={strike}
            onChange={setStrike}
            style={{ width: 130 }}
          />
          <Select
            value={optionType}
            onChange={setOptionType}
            style={{ width: 90 }}
            options={[
              { value: 'CE', label: <Text style={{ color: CE_COLOR }}>CE</Text> },
              { value: 'PE', label: <Text style={{ color: PE_COLOR }}>PE</Text> },
            ]}
          />
          <Button icon={<ReloadOutlined />} onClick={load} loading={loading} disabled={!strike}>Refresh</Button>
        </Space>

        {!strike ? (
          <Card size="small">
            <Empty description="Pick an underlying, expiry and strike above to see every candle this app has for that contract." />
          </Card>
        ) : (
          <>
            <Card size="small" title={`${underlying} ${strike}${optionType} — ${selectedExpiry ?? 'expiry pending'}`}>
              <Row gutter={24}>
                <Col><Statistic title="Total candles" value={rows.length} /></Col>
                <Col><Statistic title="Trading days covered" value={dayRollup.length} /></Col>
                <Col><Statistic title="Oldest candle" value={rows.length ? fmtIstDateTime(rows[rows.length - 1].time) : '—'} /></Col>
                <Col><Statistic title="Newest candle" value={rows.length ? fmtIstDateTime(rows[0].time) : '—'} /></Col>
                <Col>
                  <Statistic
                    title="Currently tracked"
                    value={trackedInfo ? 'Yes' : 'No'}
                    styles={{ content: { color: trackedInfo ? UP_COLOR : DOWN_COLOR } }}
                  />
                </Col>
              </Row>
              <Text type="secondary" style={{ fontSize: 12 }}>
                {trackedInfo
                  ? `Tracked (SecurityId ${trackedInfo.securityId}) - this strike has been inside the live ATM+-16 window at some point today.`
                  : "Not in today's tracked-strikes list - either never inside the live ATM+-16 window today, or this is a different expiry/day. Its candles above (if any) came from Dhan's on-demand intraday history instead of the live feed."}
                {' '}A trading day below with far fewer candles than its neighbours, or one that stops well before market close, means this contract's own tracking was incomplete for that day.
              </Text>
            </Card>

            <Card size="small" title="Candles by trading day">
              <Table
                size="small"
                rowKey="day"
                dataSource={dayRollup}
                columns={dayColumns}
                pagination={false}
                loading={loading && !hasLoaded}
                locale={{ emptyText: 'No candles at all for this contract.' }}
              />
            </Card>

            <Card size="small" title="Every candle">
              <Table
                size="small"
                rowKey="key"
                dataSource={rows}
                columns={candleColumns}
                loading={loading && !hasLoaded}
                pagination={{ pageSize: 100, showSizeChanger: true, pageSizeOptions: [50, 100, 250, 500] }}
                locale={{ emptyText: 'No candles at all for this contract.' }}
              />
            </Card>
          </>
        )}
      </Space>
    </div>
  )
}
