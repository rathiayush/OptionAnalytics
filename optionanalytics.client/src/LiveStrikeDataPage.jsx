import { useEffect, useState } from 'react'
import { Select, Space, Typography, Card, Button, Row, Col, Tag, Tooltip, Table, Alert } from 'antd'
import { NavBar, STORED_UNDERLYING, usePersistedState, istDateKey, fmtDateOnly } from './shared.jsx'
import { useOiLiveHub } from './oiShared.jsx'

const { Text, Title } = Typography

// "Live Strike Data" - a raw tick TAPE, deliberately different from the Live OI Dashboard's own
// ladder (which only ever shows the LATEST reading per strike, folded into a Map). This page shows
// literally every individual oiReplayTick as its own row, newest first, capped so the browser tab
// never grows unbounded - for answering "is this strike's OI actually updating, and with what values,
// tick by tick" directly, without any aggregation standing between the raw feed and what's on screen.
const LIVE_FEED_COMBOS = new Set(['NIFTY:WEEK', 'NIFTY:MONTH', 'BANKNIFTY:MONTH', 'SENSEX:WEEK', 'SENSEX:MONTH'])
const MAX_ROWS = 500

function fmtTickTime(iso) {
  return new Date(iso).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export default function LiveStrikeDataPage() {
  const [underlying, setUnderlying] = usePersistedState(STORED_UNDERLYING, 'NIFTY')
  const [expiryFlag, setExpiryFlag] = useState('WEEK')
  // The REAL calendar date "Weekly"/"Monthly" currently resolve to server-side - see
  // OiLiveDashboardPage's own identical state for why this is shown rather than left implicit.
  const [resolvedExpiries, setResolvedExpiries] = useState({ week: null, month: null })
  const [strikeFilter, setStrikeFilter] = useState('ALL')
  const [sideFilter, setSideFilter] = useState('ALL')
  const [paused, setPaused] = useState(false)

  // IV per strike/side - seeded once from the SAME forceLive REST call the Live OI Dashboard uses,
  // never updated from live ticks afterward, because live ticks never carry IV at all (Dhan's live
  // feed has no IV field - see OiReplayLiveFeedService's own doc comment). A row ticked before this
  // seed lands simply shows IV as "-" rather than blocking the tape on it - "tick by tick, as it
  // actually happens" is the whole point of this page, including the honest gaps.
  const [ivByKey, setIvByKey] = useState(new Map())
  const [seedError, setSeedError] = useState(null)
  const [knownStrikes, setKnownStrikes] = useState([])
  // Previous OI per strike/side, used only to compute each NEW tick's own OI Δ - not shown itself.
  const [lastOiByKey, setLastOiByKey] = useState(new Map())
  const [ticks, setTicks] = useState([])

  const liveFeedSupported = LIVE_FEED_COMBOS.has(`${underlying}:${expiryFlag}`)

  // Re-seeds IV/the known-strikes list only - never clears the tape itself. A dropped-then-restored
  // connection (this is also handleReconnected, below) should resync IV, not wipe out ticks the page
  // already showed; switching underlying/expiryFlag is different (those rows are for a DIFFERENT
  // instrument entirely) and is handled by the effect just below this, which clears the tape itself
  // before calling this same function.
  const loadSeed = () => {
    if (!underlying) return
    setSeedError(null)
    const params = new URLSearchParams({ date: istDateKey(new Date()), timeframeMinutes: '1', expiryFlag, forceLive: 'true' })
    fetch(`/api/oi-replay/${underlying}/run?${params.toString()}`)
      .then(async (r) => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.error || `Request failed (HTTP ${r.status}).`)
        return body
      })
      .then((body) => {
        if (!body?.success) throw new Error(body?.error || 'This run did not succeed.')
        const iv = new Map()
        const strikes = new Set()
        for (const p of body.cePoints ?? []) {
          strikes.add(p.strike)
          if (p.impliedVolatility != null) iv.set(`${p.strike}:CE`, p.impliedVolatility)
        }
        for (const p of body.pePoints ?? []) {
          strikes.add(p.strike)
          if (p.impliedVolatility != null) iv.set(`${p.strike}:PE`, p.impliedVolatility)
        }
        setIvByKey(iv)
        setKnownStrikes([...strikes].sort((a, b) => a - b))
      })
      .catch((err) => {
        console.error('Failed to seed IV for the live tick tape:', err)
        setSeedError(err.message || 'Failed to load IV seed - ticks will still show, without IV.')
      })
  }

  // A fresh underlying/expiryFlag means every row already on screen is for a different instrument -
  // clear the tape and OI-delta baseline outright rather than let old rows linger mixed in with new
  // ones (handleTick's own underlying/expiryFlag guard only stops FUTURE mismatched ticks, it does
  // nothing about rows already added before the switch).
  useEffect(() => {
    setTicks([])
    setLastOiByKey(new Map())
    loadSeed()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underlying, expiryFlag])

  // Only follows `underlying`, not `expiryFlag` - see OiLiveDashboardPage's own identical effect.
  useEffect(() => {
    if (!underlying) return
    let cancelled = false
    fetch(`/api/oi-replay/${underlying}/expiries`)
      .then((r) => r.json())
      .then((body) => { if (!cancelled) setResolvedExpiries({ week: body?.week ?? null, month: body?.month ?? null }) })
      .catch((err) => { if (!cancelled) console.error('Failed to load resolved expiry dates:', err) })
    return () => { cancelled = true }
  }, [underlying])

  const handleTick = (tick) => {
    if (tick?.underlying !== underlying || tick?.expiryFlag !== expiryFlag) return
    const key = `${tick.strike}:${tick.side}`
    setKnownStrikes((prev) => (prev.includes(tick.strike) ? prev : [...prev, tick.strike].sort((a, b) => a - b)))

    // Read lastOiByKey from this render's own closure rather than nesting setTicks inside
    // setLastOiByKey's own updater - an updater function must be pure (React can invoke it more
    // than once, e.g. under StrictMode's dev double-invoke), so a side effect like another setState
    // call inside one risks firing twice and duplicating a row. The trade-off: under a genuine burst
    // of several ticks for the SAME key landing in one React batch, oiDelta for those could read a
    // very slightly stale prior value - a cosmetic edge case for a tape, not a correctness bug.
    const priorOi = lastOiByKey.get(key) ?? null
    if (!paused) {
      const row = {
        key: `${tick.time}-${key}-${Math.random()}`,
        time: tick.time,
        strike: tick.strike,
        side: tick.side,
        price: tick.price,
        openInterest: tick.openInterest,
        oiDelta: priorOi != null && tick.openInterest != null ? tick.openInterest - priorOi : null,
        impliedVolatility: ivByKey.get(key) ?? null,
        // Everything else Dhan's own Full packet carries for this leg, forwarded as-is by
        // OiReplayLiveFeedService - see its own doc comment on why dayOpen/dayHigh/dayLow are named
        // that way (the CONTRACT's cumulative day-so-far O/H/L, not a per-minute range) and why
        // bestBidPrice/bestAskPrice read 0 rather than null before the first Full packet lands.
        volume: tick.volume,
        bestBidPrice: tick.bestBidPrice,
        bestAskPrice: tick.bestAskPrice,
        dayOpen: tick.dayOpen,
        dayHigh: tick.dayHigh,
        dayLow: tick.dayLow,
      }
      setTicks((prevTicks) => {
        const next = [row, ...prevTicks]
        return next.length > MAX_ROWS ? next.slice(0, MAX_ROWS) : next
      })
    }
    setLastOiByKey((prevOi) => {
      const next = new Map(prevOi)
      next.set(key, tick.openInterest)
      return next
    })
  }

  // A dropped-then-restored connection can miss ticks entirely - re-seed IV to resync rather than
  // trusting whatever the tape already accumulated (the tape itself is a pure log, so it just keeps
  // whatever it already showed - only the IV seed and strike list need refreshing).
  const connectionState = useOiLiveHub(null, handleTick, loadSeed, null, null, null, underlying, expiryFlag)

  const displayedTicks = ticks.filter(
    (t) => (strikeFilter === 'ALL' || t.strike === strikeFilter) && (sideFilter === 'ALL' || t.side === sideFilter),
  )

  const columns = [
    { title: 'Time (IST)', dataIndex: 'time', key: 'time', width: 110, render: fmtTickTime },
    { title: 'Strike', dataIndex: 'strike', key: 'strike', width: 90, align: 'right', render: (v) => v.toLocaleString() },
    {
      title: 'Side', dataIndex: 'side', key: 'side', width: 70,
      render: (v) => <Tag color={v === 'CE' ? 'red' : 'green'}>{v}</Tag>,
    },
    { title: 'Price', dataIndex: 'price', key: 'price', width: 90, align: 'right', render: (v) => (v == null ? '—' : v.toFixed(2)) },
    { title: 'OI', dataIndex: 'openInterest', key: 'openInterest', width: 110, align: 'right', render: (v) => (v == null ? '—' : v.toLocaleString()) },
    {
      title: 'OI Δ', dataIndex: 'oiDelta', key: 'oiDelta', width: 100, align: 'right',
      render: (v) => v == null ? '—' : <Text style={{ color: v > 0 ? '#3ddc84' : v < 0 ? '#ff5c5c' : undefined }}>{v > 0 ? '+' : ''}{v.toLocaleString()}</Text>,
    },
    { title: 'IV', dataIndex: 'impliedVolatility', key: 'impliedVolatility', width: 80, align: 'right', render: (v) => (v == null ? '—' : v.toFixed(1)) },
    { title: 'Volume', dataIndex: 'volume', key: 'volume', width: 100, align: 'right', render: (v) => (v == null ? '—' : v.toLocaleString()) },
    { title: 'Bid', dataIndex: 'bestBidPrice', key: 'bestBidPrice', width: 80, align: 'right', render: (v) => (!v ? '—' : v.toFixed(2)) },
    { title: 'Ask', dataIndex: 'bestAskPrice', key: 'bestAskPrice', width: 80, align: 'right', render: (v) => (!v ? '—' : v.toFixed(2)) },
    { title: 'Day O', dataIndex: 'dayOpen', key: 'dayOpen', width: 80, align: 'right', render: (v) => (!v ? '—' : v.toFixed(2)) },
    { title: 'Day H', dataIndex: 'dayHigh', key: 'dayHigh', width: 80, align: 'right', render: (v) => (!v ? '—' : v.toFixed(2)) },
    { title: 'Day L', dataIndex: 'dayLow', key: 'dayLow', width: 80, align: 'right', render: (v) => (!v ? '—' : v.toFixed(2)) },
  ]

  const strikeOptions = [{ value: 'ALL', label: 'All strikes' }, ...knownStrikes.map((s) => ({ value: s, label: s.toLocaleString() }))]

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>

        <Card size="small" title="Live Strike Data">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Every live tick for this underlying/expiry's tracked strike band, one row per tick, newest
              first - the raw feed itself, not the OI Dashboard's own latest-per-strike ladder. IV is
              seeded once per strike (Dhan's live feed never carries it) and does not update tick by
              tick - see the OI Dashboard page for the same caveat. Volume/Bid/Ask/Day O-H-L are
              whatever Dhan's own Full packet carries for that leg, forwarded as-is - Day O/H/L is the
              CONTRACT's own cumulative high/low so far today, not a per-minute range; Bid/Ask read "—"
              until at least one Full packet has actually arrived for that strike.
            </Text>
            <Space wrap size={12}>
              <Select
                value={underlying} onChange={setUnderlying} style={{ width: 130 }}
                options={[{ value: 'NIFTY', label: 'NIFTY' }, { value: 'BANKNIFTY', label: 'BANKNIFTY' }, { value: 'SENSEX', label: 'SENSEX' }]}
              />
              <Select
                value={expiryFlag} onChange={setExpiryFlag} style={{ width: 190 }}
                options={[
                  { value: 'WEEK', label: `Weekly${resolvedExpiries.week ? ` (${fmtDateOnly(resolvedExpiries.week)})` : ''}`, disabled: underlying === 'BANKNIFTY' },
                  { value: 'MONTH', label: `Monthly${resolvedExpiries.month ? ` (${fmtDateOnly(resolvedExpiries.month)})` : ''}` },
                ]}
              />
              <Select value={strikeFilter} onChange={setStrikeFilter} style={{ width: 140 }} options={strikeOptions} />
              <Select
                value={sideFilter} onChange={setSideFilter} style={{ width: 110 }}
                options={[{ value: 'ALL', label: 'CE + PE' }, { value: 'CE', label: 'CE only' }, { value: 'PE', label: 'PE only' }]}
              />
              <Button onClick={() => setPaused((p) => !p)}>{paused ? 'Resume' : 'Pause'}</Button>
              <Button onClick={() => setTicks([])}>Clear</Button>
              <Tooltip title={
                connectionState === 'connected' ? "Streaming live ticks from Dhan's WebSocket feed"
                  : connectionState === 'reconnecting' ? 'Connection dropped - automatically retrying.'
                    : connectionState === 'connecting' ? 'Connecting to the live feed…'
                      : 'Not connected - not receiving live ticks right now.'
              }>
                <Tag color={connectionState === 'connected' ? 'success' : connectionState === 'reconnecting' ? 'warning' : connectionState === 'connecting' ? 'processing' : 'error'}>
                  {connectionState === 'connected' ? '● LIVE' : connectionState === 'reconnecting' ? '● RECONNECTING' : connectionState === 'connecting' ? '● CONNECTING' : '● OFFLINE'}
                </Tag>
              </Tooltip>
              {paused && <Tag color="warning">PAUSED - not appending new ticks</Tag>}
            </Space>
            {!liveFeedSupported && (
              <Alert
                type="info" showIcon
                message={`Live tick-by-tick updates aren't wired up for ${underlying} ${expiryFlag === 'WEEK' ? 'Weekly' : 'Monthly'} - no ticks will arrive here. NIFTY (Weekly/Monthly), BANKNIFTY (Monthly) and SENSEX (Weekly/Monthly) all stay live.`}
              />
            )}
            {seedError && <Alert type="warning" showIcon message={seedError} />}
          </Space>
        </Card>

        <Row>
          <Col span={24}>
            <Card size="small" title={`Tick tape (${displayedTicks.length.toLocaleString()} shown, capped at ${MAX_ROWS})`}>
              <Table
                size="small"
                rowKey="key"
                dataSource={displayedTicks}
                columns={columns}
                pagination={false}
                scroll={{ x: 1140, y: 640 }}
                locale={{ emptyText: 'No ticks yet - waiting for the live feed.' }}
              />
            </Card>
          </Col>
        </Row>
      </Space>
    </div>
  )
}
