import { useEffect, useMemo, useState } from 'react'
import { Select, Space, Typography, Card, Table, Tag, Button, Statistic, Row, Col, Alert, Input, Switch, message } from 'antd'
import { ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { UP_COLOR, DOWN_COLOR, CE_COLOR, PE_COLOR, NavBar, fmtPrice, fmtIstTime, STORED_UNDERLYING, usePersistedState, pickUnderlying } from './shared.jsx'

const { Title, Text } = Typography

// How stale a tick may be before the row stops counting as live. Generous enough that an illiquid
// far strike between trades still reads as live, short enough that a feed that has actually stopped
// shows up as a screen of grey rather than one or two odd rows.
const LIVE_TICK_MAX_AGE_MS = 5 * 60 * 1000

// Single source of truth for a row's state, shared by the State column and the Live-only filter -
// so filtering and what the column displays can never disagree with each other.
function rowState(row, now) {
  if (!row.subscribed) return 'listed'
  const age = row.lastTickUtc ? now - new Date(row.lastTickUtc).getTime() : null
  if (age === null) return 'no-tick'
  if (age > LIVE_TICK_MAX_AGE_MS) return 'stale'
  return 'live'
}

// "What does this app actually know about the option chain, right now?"
//
// Every other page shows what the app CONCLUDED - candles, CDV, signals, trades. When something is
// wrong upstream, all of them degrade into the same unhelpful "No Data", and three completely
// different failures look identical:
//
//   1. The scrip master lists nothing. A refresh that parsed to zero rows used to wipe a working
//      chain, after which every strike read as "not listed" and every live order was silently
//      skipped - visible nowhere except a Telegram message hours later.
//   2. Listed, but not subscribed: the strike is outside the tracked ATM+-8 window, or its expiry
//      is not one of the tracked ones.
//   3. Subscribed, but never ticked: an authorisation or feed problem (Dhan authorises a socket
//      AFTER the handshake, so a subscription sent too early is silently ignored).
//
// This page separates them. Each has a different fix, and guessing between them is what made the
// last outage take a day to find.
export default function ContractsPage() {
  const [underlyings, setUnderlyings] = useState([])
  const [underlying, setUnderlying] = usePersistedState(STORED_UNDERLYING, null)
  const [expiry, setExpiry] = useState(null)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [now, setNow] = useState(Date.now())
  const [refreshingMaster, setRefreshingMaster] = useState(false)
  // Defaults to on: the question this page answers is almost always "is this actually ticking
  // right now", and a full listing of every strike Dhan lists (hundreds, mostly irrelevant) buries
  // that. Off switches back to the full diagnostic view - every listed contract, live or not -
  // which is what distinguishing "not subscribed" from "no tick" needs.
  const [liveOnly, setLiveOnly] = useState(true)

  useEffect(() => {
    fetch('/api/spot/underlyings')
      .then((r) => r.json())
      .then((list) => {
        setUnderlyings(list ?? [])
        setUnderlying((current) => pickUnderlying(list, current))
      })
      .catch((err) => console.error('Failed to load underlyings:', err))
  }, [])

  const load = (picked = expiry) => {
    if (!underlying) return
    setLoading(true)
    const url = `/api/cdv/${underlying}/contracts${picked ? `?expiry=${encodeURIComponent(picked)}` : ''}`
    fetch(url)
      .then((r) => r.json())
      .then((payload) => {
        setData(payload)
        // Adopt whichever expiry the server resolved, so the dropdown shows what is actually being
        // listed rather than a blank while it defaults to the nearest tracked one.
        if (payload?.expiry && !picked) setExpiry(payload.expiry)
        setNow(Date.now())
      })
      .catch((err) => console.error('Failed to load contracts:', err))
      .finally(() => setLoading(false))
  }

  // Forces the scrip master to re-download right now (bypassing its normal 12-hour cache and the
  // automatic 1-minute empty-retry throttle) and re-centers every underlying, so any contract that
  // could not be resolved before is subscribed and backfilled straight away - see
  // CdvHostedService.ForceRefreshMasterAsync. This is the self-serve fix for "the master is empty":
  // it can take a genuine while (re-centering may re-backfill everything if the master was truly
  // empty before), so it gets its own loading state rather than piggybacking on the table's.
  const refreshMaster = () => {
    setRefreshingMaster(true)
    fetch('/api/cdv/master/refresh', { method: 'POST' })
      .then((r) => r.json())
      .then((result) => {
        if (result?.error) {
          message.error(`Master refresh: ${result.error}`, 8)
        } else {
          message.success(`Master refreshed - ${result?.contractCount ?? 0} contracts loaded.`)
        }
        load(expiry)
      })
      .catch((err) => {
        console.error('Failed to refresh the scrip master:', err)
        message.error('Master refresh failed - see console/server logs.')
      })
      .finally(() => setRefreshingMaster(false))
  }

  // Reload on underlying/expiry change.
  useEffect(() => { load(expiry) /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [underlying, expiry])

  // Ticks arrive continuously but this table is a snapshot, so it polls. 5s is fast enough to watch
  // a feed come alive after a restart without being a load on anything.
  useEffect(() => {
    if (!autoRefresh || !underlying) return
    const id = setInterval(() => load(expiry), 5000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, underlying, expiry])

  const rows = useMemo(() => {
    const all = data?.contracts ?? []
    const term = search.trim()
    let filtered = term ? all.filter((c) => String(c.strike).includes(term) || c.tradingSymbol?.includes(term.toUpperCase())) : all
    if (liveOnly) filtered = filtered.filter((c) => rowState(c, now) === 'live')
    return filtered.map((c) => ({ ...c, key: c.securityId }))
  }, [data, search, liveOnly, now])

  const stats = useMemo(() => {
    const all = data?.contracts ?? []
    const subscribed = all.filter((c) => c.subscribed).length
    const ticking = all.filter((c) => c.lastTickUtc && now - new Date(c.lastTickUtc).getTime() < LIVE_TICK_MAX_AGE_MS).length
    return { listed: all.length, subscribed, ticking }
  }, [data, now])

  const masterBroken = data && data.masterContractCount === 0

  const columns = [
    {
      title: 'Strike',
      dataIndex: 'strike',
      key: 'strike',
      width: 110,
      sorter: (a, b) => a.strike - b.strike,
      render: (v) => <Text strong>{fmtPrice(v)}</Text>,
    },
    {
      title: 'Type',
      dataIndex: 'optionType',
      key: 'optionType',
      width: 80,
      filters: [{ text: 'CE', value: 'CE' }, { text: 'PE', value: 'PE' }],
      onFilter: (value, row) => row.optionType === value,
      render: (type) => <Tag color={type === 'CE' ? CE_COLOR : PE_COLOR}>{type}</Tag>,
    },
    { title: 'Symbol', dataIndex: 'tradingSymbol', key: 'tradingSymbol', ellipsis: true },
    { title: 'Security ID', dataIndex: 'securityId', key: 'securityId', width: 120 },
    {
      // The three states this page exists to tell apart, as one column so a screen of them reads at
      // a glance: a wall of "Listed only" is a tracking-window answer, a wall of "No tick" is a
      // feed answer.
      title: 'State',
      key: 'state',
      width: 150,
      render: (_, row) => {
        const state = rowState(row, now)
        if (state === 'listed') return <Tag>Listed only</Tag>
        if (state === 'no-tick') return <Tag color={DOWN_COLOR}>No tick</Tag>
        if (state === 'stale') return <Tag color="orange">Stale</Tag>
        return <Tag color={UP_COLOR}>Live</Tag>
      },
    },
    { title: 'Tracked', dataIndex: 'tracked', key: 'tracked', width: 90, render: (v) => (v ? <Tag color={UP_COLOR}>Yes</Tag> : <Tag>No</Tag>) },
    { title: 'LTP', dataIndex: 'lastPrice', key: 'lastPrice', width: 110, align: 'right', render: (v) => fmtPrice(v) },
    { title: 'Volume', dataIndex: 'volume', key: 'volume', width: 120, align: 'right', render: (v) => (v == null ? '—' : Number(v).toLocaleString('en-IN')) },
    { title: 'Last tick', dataIndex: 'lastTickUtc', key: 'lastTickUtc', width: 110, render: (v) => (v ? fmtIstTime(v) : '—') },
    { title: 'Lot', dataIndex: 'lotSize', key: 'lotSize', width: 80, align: 'right' },
  ]

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
          <Select
            value={underlying}
            onChange={(v) => { setUnderlying(v); setExpiry(null) }}
            style={{ width: 160 }}
            options={underlyings.map((u) => ({ value: u.underlying, label: u.underlying }))}
          />
          <Select
            value={expiry}
            onChange={setExpiry}
            style={{ width: 190 }}
            placeholder="Expiry"
            options={(data?.listedExpiries ?? []).map((e) => ({
              value: e,
              // Tracked expiries are the ones with a live subscription behind them; the rest are
              // listed by Dhan but carry no feed, and saying so here prevents the obvious
              // misreading of an all-grey table as "the feed is broken".
              label: (data?.trackedExpiries ?? []).includes(e) ? `${e} · tracked` : e,
            }))}
          />
          <Button icon={<ReloadOutlined />} onClick={() => load(expiry)} loading={loading}>Refresh</Button>
          <Space size={6}>
            <Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} />
            <Text type="secondary" style={{ fontSize: 12 }}>Auto (5s)</Text>
          </Space>
        </Space>

        {masterBroken && (
          <Alert
            type="error"
            showIcon
            message="The scrip master is empty - no contract can be resolved and no live order can be placed."
            description="Nothing here will work until it reloads: every strike will read as 'not listed', and armed triggers will alert but place nothing. Click Refresh master to force it right now instead of waiting for the automatic retry."
            action={
              <Button size="small" danger loading={refreshingMaster} onClick={refreshMaster}>
                Refresh master
              </Button>
            }
          />
        )}

        <Card
          size="small"
          title="Feed and scrip master"
          extra={
            <Button
              size="small"
              icon={<ThunderboltOutlined />}
              danger={masterBroken}
              loading={refreshingMaster}
              onClick={refreshMaster}
            >
              Refresh master
            </Button>
          }
        >
          <Row gutter={24}>
            <Col><Statistic title="Master contracts" value={data?.masterContractCount ?? 0} styles={{ content: { color: masterBroken ? DOWN_COLOR : UP_COLOR } }} /></Col>
            <Col><Statistic title="Subscribed (all expiries)" value={data?.subscribedCount ?? 0} /></Col>
            <Col><Statistic title="Listed here" value={stats.listed} /></Col>
            <Col><Statistic title="Subscribed here" value={stats.subscribed} /></Col>
            <Col><Statistic title="Ticking here" value={stats.ticking} styles={{ content: { color: stats.ticking > 0 ? UP_COLOR : undefined } }} /></Col>
          </Row>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Tracked expiries: {(data?.trackedExpiries ?? []).join(', ') || '—'} · master loaded{' '}
            {data?.masterLoadedUtc ? fmtIstTime(data.masterLoadedUtc) : 'never'} IST.{' '}
            <b>Listed only</b> means the contract exists but carries no live subscription (outside the tracked strike window, or an untracked expiry).{' '}
            <b>No tick</b> means it IS subscribed and the feed has never sent anything for it — that one is a feed or authorisation problem, not a strike problem.
          </Text>
        </Card>

        <Card
          size="small"
          title={`Contracts — ${underlying ?? ''} ${data?.expiry ?? ''}`}
          extra={
            <Space size={16}>
              <Space size={6}>
                <Switch size="small" checked={liveOnly} onChange={setLiveOnly} />
                <Text type="secondary" style={{ fontSize: 12 }}>Live only</Text>
              </Space>
              <Input.Search allowClear placeholder="Filter by strike or symbol" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 260 }} />
            </Space>
          }
        >
          <Table
            size="small"
            rowKey="key"
            dataSource={rows}
            columns={columns}
            loading={loading && !data}
            pagination={{ pageSize: 50, showSizeChanger: false }}
            locale={{ emptyText: masterBroken
              ? 'The scrip master holds no contracts at all - nothing can be listed.'
              : liveOnly
                ? 'Nothing is ticking right now for this expiry - switch off Live only to see the full listing and check subscription state.'
                : 'No contracts listed for this expiry.' }}
          />
        </Card>
      </Space>
    </div>
  )
}
