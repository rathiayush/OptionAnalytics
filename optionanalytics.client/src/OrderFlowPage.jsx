import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Col, InputNumber, Row, Segmented, Select, Slider, Space, Switch, Tag, Tooltip, Typography } from 'antd'
import { ReloadOutlined, PlayCircleOutlined, PauseCircleOutlined } from '@ant-design/icons'
import * as signalR from '@microsoft/signalr'
import {
  NavBar, TIMEFRAME_OPTIONS, usePersistedState, RECONNECT_RETRY_POLICY, onLiveBatch, syncSignalRGroups, joinAllSignalRGroups,
  checkForNewDeploy, UP_COLOR, DOWN_COLOR, AXIS_COLOR,
} from './shared.jsx'
import { aggregateBars, analyzeBars, findWalls, bucketBook, mergeLiveMinutes, volumeProfile, replayView, replayRange } from './orderFlowMath.js'
import { FootprintChart, DepthHeatmap, CumulativeDeltaChart, BookLadder, formatVolume } from './OrderFlowCharts.jsx'
import { DomDrawer, useNarrow } from './DomDrawer.jsx'

const { Title, Text } = Typography

// Order Flow - footprint, delta / cumulative delta, stacked imbalances, absorption, exhaustion, the
// depth heatmap, icebergs and large orders for each underlying's nearest FUTURES contract, live from
// Dhan's tick feed and market depth (200 levels where Dhan offers it). See OrderFlowEngine on the
// server for how trades and their aggressor side are inferred, and orderFlowMath.js for the analysis.
//
// REPLAY: the server records every day it tracks (OrderFlowRecorder) - Dhan itself has no historical
// tick or depth data - and Replay plays a recorded day back: the footprint, heatmap, prints, icebergs
// and book exactly as they were known at the replay clock.

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX']
const DEFAULT_ROW_SIZES = { NIFTY: 1, BANKNIFTY: 5, SENSEX: 5 }
const ROW_SIZE_OPTIONS = [0.5, 1, 2, 5, 10, 20].map((v) => ({ value: v, label: `${v} pt row` }))
const HEATMAP_COLUMN_MS = 2000
const MAX_HEATMAP_COLUMNS = 3000
const MAX_TRADES = 5000
const REPLAY_SPEEDS = [1, 2, 5, 10, 30, 60, 120, 300].map((v) => ({ value: v, label: `${v}x` }))
const REPLAY_TICK_MS = 200
const REPLAY_HEATMAP_COLUMNS = 1500
const IST_HHMMSS = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })

// One SignalR connection for the page's lifetime; group "of:{underlying}" follows the selection.
function useOrderFlowHub(underlying, onLive) {
  const [state, setState] = useState('connecting')
  const connectionRef = useRef(null)
  const groupsRef = useRef([])
  const liveRef = useRef(onLive)
  liveRef.current = onLive

  useEffect(() => {
    const connection = new signalR.HubConnectionBuilder().withUrl('/hubs/spot').withAutomaticReconnect(RECONNECT_RETRY_POLICY).build()
    connectionRef.current = connection
    onLiveBatch(connection, { orderFlowLive: (payload) => liveRef.current?.(payload) })
    connection.onreconnecting(() => setState('reconnecting'))
    connection.onreconnected(() => { setState('connected'); joinAllSignalRGroups(connection, groupsRef.current); checkForNewDeploy() })
    connection.onclose(() => setState('disconnected'))
    connection.start()
      .then(() => { setState('connected'); joinAllSignalRGroups(connection, groupsRef.current) })
      .catch((err) => { if (err?.name !== 'AbortError') { console.error('Order flow live connection failed:', err); setState('disconnected') } })
    return () => { connectionRef.current = null; connection.stop() }
  }, [])

  useEffect(() => {
    const groups = [`of:${underlying}`]
    syncSignalRGroups(connectionRef.current, groupsRef.current, groups)
    groupsRef.current = groups
  }, [underlying])

  return state
}

const toColumn = (c) => ({ t: new Date(c.time).getTime(), bids: c.bids, asks: c.asks })

export default function OrderFlowPage() {
  const [underlying, setUnderlying] = usePersistedState('optionanalytics.orderFlow.underlying', 'NIFTY')
  const [timeframe, setTimeframe] = usePersistedState('optionanalytics.orderFlow.timeframe', 1)
  const [rowSizes, setRowSizes] = usePersistedState('optionanalytics.orderFlow.rowSizes', DEFAULT_ROW_SIZES)
  const [imbalanceRatio, setImbalanceRatio] = usePersistedState('optionanalytics.orderFlow.imbalanceRatio', 3)
  const [stackedCount, setStackedCount] = usePersistedState('optionanalytics.orderFlow.stackedCount', 3)
  const [largeLots, setLargeLots] = usePersistedState('optionanalytics.orderFlow.largeLots', 10)
  const [showLots, setShowLots] = usePersistedState('optionanalytics.orderFlow.showLots', true)
  const [showProfile, setShowProfile] = usePersistedState('optionanalytics.orderFlow.showProfile', true)
  const [replaySpeed, setReplaySpeed] = usePersistedState('optionanalytics.orderFlow.replaySpeed', 10)
  const rowSize = rowSizes?.[underlying] ?? DEFAULT_ROW_SIZES[underlying] ?? 1
  const narrow = useNarrow()
  const [domOpen, setDomOpen] = useState(false)
  const [mode, setMode] = useState('live')

  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const contextRef = useRef({ underlying, rowSize })
  contextRef.current = { underlying, rowSize }

  const load = () => {
    setLoading(true)
    setError(null)
    const requested = { underlying, rowSize }
    // Only prints of the "large" size are needed - fetching every print would cap at the server's
    // newest 5000 and lose the morning's large ones on a busy day.
    fetch(`/api/order-flow/${underlying}?rowSize=${rowSize}&minTradeLots=${largeLots}&heatmapColumns=900`)
      .then(async (r) => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.error || `Request failed (HTTP ${r.status})`)
        return body
      })
      .then((body) => {
        if (contextRef.current.underlying !== requested.underlying || contextRef.current.rowSize !== requested.rowSize) return
        setData({
          meta: body.meta, minuteBars: body.bars, trades: body.trades, icebergs: body.icebergs, book: body.book,
          heatmap: body.heatmap.map(toColumn), lastSeq: body.trades.at(-1)?.seq ?? 0,
        })
      })
      .catch((err) => { setError(err.message); setData(null) })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    setData(null)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [underlying, rowSize, largeLots])

  // ---- Replay of a recorded day ----
  const [replayDays, setReplayDays] = useState(null)
  const [replayDate, setReplayDate] = useState(null)
  const [replayDay, setReplayDay] = useState(null)
  const [replayError, setReplayError] = useState(null)
  const [replayLoading, setReplayLoading] = useState(false)
  const [replayMs, setReplayMs] = useState(null)
  const [playing, setPlaying] = useState(false)
  const range = useMemo(() => replayRange(replayDay), [replayDay])

  useEffect(() => {
    if (mode !== 'replay') return undefined
    let cancelled = false
    setReplayDays(null)
    fetch(`/api/order-flow/${underlying}/days`)
      .then((r) => (r.ok ? r.json() : []))
      .then((days) => {
        if (cancelled) return
        setReplayDays(days)
        setReplayDate((current) => (days.some((d) => d.date === current) ? current : days[0]?.date ?? null))
      })
      .catch(() => { if (!cancelled) setReplayDays([]) })
    return () => { cancelled = true }
  }, [mode, underlying])

  useEffect(() => {
    if (mode !== 'replay' || !replayDate) { setReplayDay(null); return undefined }
    let cancelled = false
    setReplayLoading(true)
    setReplayError(null)
    setPlaying(false)
    fetch(`/api/order-flow/${underlying}/history/${replayDate}?rowSize=${rowSize}&minTradeLots=${largeLots}&heatmapColumns=${REPLAY_HEATMAP_COLUMNS}`)
      .then(async (r) => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.error || `Request failed (HTTP ${r.status})`)
        return body
      })
      .then((body) => {
        if (cancelled) return
        const day = { meta: body.meta, minuteBars: body.bars, trades: body.trades, icebergs: body.icebergs, heatmap: body.heatmap.map(toColumn) }
        setReplayDay(day)
        // Keep the clock where it was when only the rows / print size changed.
        setReplayMs((ms) => {
          const next = replayRange(day)
          if (!next) return null
          return ms != null && ms >= next.start && ms <= next.end ? ms : next.start + 15 * 60_000
        })
      })
      .catch((err) => { if (!cancelled) { setReplayError(err.message); setReplayDay(null) } })
      .finally(() => { if (!cancelled) setReplayLoading(false) })
    return () => { cancelled = true }
  }, [mode, underlying, replayDate, rowSize, largeLots])

  useEffect(() => {
    if (!playing || !range) return undefined
    const id = setInterval(() => {
      setReplayMs((ms) => {
        const next = Math.min(range.end, (ms ?? range.start) + REPLAY_TICK_MS * replaySpeed)
        if (next >= range.end) setPlaying(false)
        return next
      })
    }, REPLAY_TICK_MS)
    return () => clearInterval(id)
  }, [playing, range, replaySpeed])

  const handleLive = (payload) => {
    const { underlying: current, rowSize: rows } = contextRef.current
    if (payload?.meta?.underlying !== current) return
    setData((prev) => {
      if (!prev) return prev
      const now = payload.time ? new Date(payload.time).getTime() : Date.now()
      const freshTrades = (payload.trades ?? []).filter((t) => t.seq > prev.lastSeq)
      const trades = freshTrades.length ? [...prev.trades, ...freshTrades].slice(-MAX_TRADES) : prev.trades
      const icebergs = new Map(prev.icebergs.map((i) => [i.id, i]))
      for (const i of payload.icebergs ?? []) icebergs.set(i.id, i)
      const lastColumn = prev.heatmap.at(-1)
      // The whole book for the heatmap: "heat" is every level (200 a side) in 0.5-point rows, the
      // "book" only the ladder's top levels.
      const heatBids = payload.heat?.bids ?? payload.book?.bids
      const heatAsks = payload.heat?.asks ?? payload.book?.asks
      const heatmap = !lastColumn || now - lastColumn.t >= HEATMAP_COLUMN_MS
        ? [...prev.heatmap, { t: now, bids: bucketBook(heatBids, rows), asks: bucketBook(heatAsks, rows) }].slice(-MAX_HEATMAP_COLUMNS)
        : prev.heatmap
      return {
        ...prev, meta: payload.meta, book: payload.book, trades, heatmap,
        icebergs: [...icebergs.values()].sort((a, b) => a.id - b.id),
        minuteBars: mergeLiveMinutes(prev.minuteBars, payload.bars, rows),
        lastSeq: freshTrades.at(-1)?.seq ?? prev.lastSeq,
      }
    })
  }
  const connectionState = useOrderFlowHub(underlying, handleLive)

  // Everything below draws `view`: the live data, or the recorded day as of the replay clock.
  const isReplay = mode === 'replay'
  const view = useMemo(() => (isReplay ? replayView(replayDay, replayMs) : data), [isReplay, replayDay, replayMs, data])

  const lotSize = view?.meta?.lotSize ?? 1
  const bars = useMemo(
    () => analyzeBars(aggregateBars(view?.minuteBars ?? [], timeframe), { rowSize, minVolume: lotSize, imbalanceRatio, stackedCount }),
    [view?.minuteBars, timeframe, rowSize, lotSize, imbalanceRatio, stackedCount],
  )
  const profile = useMemo(() => (showProfile ? volumeProfile(bars) : null), [showProfile, bars])
  const largeTrades = useMemo(() => (view?.trades ?? []).filter((t) => t.quantity >= largeLots * lotSize), [view?.trades, largeLots, lotSize])
  const walls = useMemo(() => findWalls(view?.book), [view?.book])
  const activeIcebergs = useMemo(() => new Set((view?.icebergs ?? []).filter((i) => !i.endedAt).map((i) => i.price)), [view?.icebergs])

  const signals = useMemo(() => {
    const list = []
    for (const bar of bars.slice(-120)) {
      for (const z of bar.stacked) {
        list.push({ key: `s-${bar.time}-${z.side}-${z.low}`, time: bar.time, bullish: z.side === 'buy', type: 'Stacked imbalance',
          text: `${z.side === 'buy' ? 'Buy' : 'Sell'} stack ${z.low}–${z.high} (${z.rows} rows) - ${z.side === 'buy' ? 'support' : 'resistance'}` })
      }
      for (const a of bar.absorption) {
        list.push({ key: `a-${bar.time}-${a.side}`, time: bar.time, bullish: a.side === 'buy', type: 'Absorption',
          text: a.side === 'buy' ? `Selling absorbed at ${a.price} (${formatVolume(a.volume, lotSize, showLots)} hit the bid, bar closed off the low)` : `Buying absorbed at ${a.price} (${formatVolume(a.volume, lotSize, showLots)} lifted, bar closed off the high)` })
      }
      for (const e of bar.exhaustion) {
        list.push({ key: `e-${bar.time}-${e.side}`, time: bar.time, bullish: e.side === 'buy', type: 'Exhaustion',
          text: e.side === 'sell' ? `Buying exhausted at the high ${e.price}` : `Selling exhausted at the low ${e.price}` })
      }
    }
    for (const i of view?.icebergs ?? []) {
      list.push({ key: `i-${i.id}`, time: new Date(i.detectedAt).getTime(), bullish: i.isBid, type: 'Iceberg',
        text: `${i.isBid ? 'Hidden buyer at bid' : 'Hidden seller at offer'} ${i.price}: ${formatVolume(i.traded, lotSize, showLots)} traded vs ${formatVolume(i.maxDisplayed, lotSize, showLots)} shown${i.endedAt ? ' (ended)' : ' - active'}` })
    }
    for (const t of largeTrades.slice(-150)) {
      list.push({ key: `t-${t.seq}`, time: new Date(t.time).getTime(), bullish: t.buy, type: 'Large print',
        text: `${t.buy ? 'Buy' : 'Sell'} ${formatVolume(t.quantity, lotSize, true)} lots at ${t.price}` })
    }
    return list.sort((a, b) => b.time - a.time).slice(0, 200)
  }, [bars, view?.icebergs, largeTrades, lotSize, showLots])

  const meta = view?.meta
  const lastBar = bars.at(-1)
  const dayKey = `${underlying}-${timeframe}-${rowSize}-${isReplay ? replayDate : 'live'}`
  const jump = (minutes) => setReplayMs((ms) => (range ? Math.max(range.start, Math.min(range.end, (ms ?? range.start) + minutes * 60_000)) : ms))

  return (
    <div style={{ maxWidth: 2600, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>

        <Card
          size="small" title="Order Flow - futures"
          extra={(
            <Space size={8} wrap>
              <Segmented value={mode} onChange={(m) => { setMode(m); setPlaying(false) }} options={[{ label: 'Live', value: 'live' }, { label: 'Replay', value: 'replay' }]} />
              <Tooltip title="Depth of market - the full 200-level book in a side panel (live)">
                <Button onClick={() => setDomOpen(true)}>DOM</Button>
              </Tooltip>
            </Space>
          )}
        >
          <Space wrap size={12} align="center">
            <Select value={underlying} onChange={setUnderlying} style={{ width: 130 }} options={UNDERLYINGS.map((u) => ({ value: u, label: `${u} FUT` }))} />
            <Select value={timeframe} onChange={setTimeframe} style={{ width: 110 }} options={TIMEFRAME_OPTIONS} />
            <Select value={rowSize} onChange={(v) => setRowSizes({ ...(rowSizes ?? {}), [underlying]: v })} style={{ width: 120 }} options={ROW_SIZE_OPTIONS} />
            <Tooltip title="Diagonal imbalance: buying at a price vs selling one row below (and the mirror) must be at least this many times larger.">
              <InputNumber value={imbalanceRatio} onChange={(v) => setImbalanceRatio(v ?? 3)} min={1.5} max={10} step={0.5} style={{ width: 140 }} addonBefore="Imbalance" addonAfter="x" />
            </Tooltip>
            <InputNumber value={stackedCount} onChange={(v) => setStackedCount(v ?? 3)} min={2} max={8} style={{ width: 130 }} addonBefore="Stack" addonAfter="rows" />
            <InputNumber value={largeLots} onChange={(v) => setLargeLots(v ?? 10)} min={1} style={{ width: 160 }} addonBefore="Large print ≥" addonAfter="lots" />
            <Space size={4}><Switch size="small" checked={showLots} onChange={setShowLots} /><Text style={{ fontSize: 12 }}>Volume in lots</Text></Space>
            <Space size={4}><Switch size="small" checked={showProfile} onChange={setShowProfile} /><Text style={{ fontSize: 12 }}>Volume profile</Text></Space>
            {!isReplay && <Button size="small" icon={<ReloadOutlined />} onClick={load} loading={loading}>Reload</Button>}
          </Space>
          {isReplay && (
            <div style={{ marginTop: 12, padding: 10, border: '1px solid #ffffff1f', borderRadius: 6 }}>
              <Space wrap size={10} align="center">
                <Select
                  value={replayDate} onChange={setReplayDate} style={{ width: 150 }} loading={replayDays == null}
                  placeholder={replayDays?.length === 0 ? 'No recorded days' : 'Recorded day'}
                  options={(replayDays ?? []).map((d) => ({ value: d.date, label: d.date }))}
                />
                <Button
                  type="primary" icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />} disabled={!range}
                  onClick={() => { if (!playing && range && replayMs >= range.end) setReplayMs(range.start); setPlaying(!playing) }}
                >
                  {playing ? 'Pause' : 'Play'}
                </Button>
                <Select value={replaySpeed} onChange={setReplaySpeed} style={{ width: 84 }} options={REPLAY_SPEEDS} />
                <Space.Compact>
                  <Button disabled={!range} onClick={() => jump(-15)}>−15m</Button>
                  <Button disabled={!range} onClick={() => jump(-1)}>−1m</Button>
                  <Button disabled={!range} onClick={() => jump(1)}>+1m</Button>
                  <Button disabled={!range} onClick={() => jump(15)}>+15m</Button>
                </Space.Compact>
                {replayMs != null && <Text strong style={{ fontVariantNumeric: 'tabular-nums' }}>{IST_HHMMSS.format(new Date(replayMs))} IST</Text>}
                {replayLoading && <Text type="secondary">Loading…</Text>}
              </Space>
              {range && (
                <Slider
                  min={range.start} max={range.end} step={1000} value={replayMs ?? range.start}
                  onChange={(v) => setReplayMs(v)} tooltip={{ formatter: (v) => IST_HHMMSS.format(new Date(v)) }}
                  style={{ margin: '12px 6px 0' }}
                />
              )}
              {replayDays?.length === 0 && (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  Nothing recorded for {underlying} yet. Dhan has no historical tick or market-depth data, so a day can only be replayed if the server
                  was running and recording it - every trading day from now on is kept.
                </Text>
              )}
            </div>
          )}
          <Space wrap size={8} style={{ marginTop: 10 }}>
            {isReplay
              ? <Tag color="purple">● Replay{replayDate ? ` · ${replayDate}` : ''}</Tag>
              : (
                <Tag color={connectionState === 'connected' ? 'success' : connectionState === 'reconnecting' ? 'warning' : connectionState === 'connecting' ? 'processing' : 'error'}>
                  {connectionState === 'connected' ? '● Live' : connectionState === 'reconnecting' ? '● Reconnecting…' : connectionState === 'connecting' ? '● Connecting…' : '● Disconnected'}
                </Tag>
              )}
            {meta && <Tag>{meta.contractSymbol} · lot {meta.lotSize}</Tag>}
            {meta && (
              <Tooltip title={meta.depthLevels >= 200 ? "Streaming Dhan's full market depth: 200 levels a side." : meta.depthLevels >= 20 ? "Streaming Dhan's 20-level depth (the 200-level feed is not available for this contract right now)." : "No deeper depth for this contract (BSE contracts are not offered by Dhan, or the depth sockets are down) - using the 5 levels in each Full packet."}>
                <Tag color={meta.depthLevels >= 200 ? 'green' : meta.depthLevels >= 20 ? 'blue' : 'orange'}>{meta.depthLevels}-level depth</Tag>
              </Tooltip>
            )}
            {meta?.lastPrice > 0 && <Text strong>{meta.lastPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</Text>}
            {lastBar && (
              <Text style={{ fontSize: 12 }}>
                Cum Δ <span style={{ color: lastBar.cvd >= 0 ? UP_COLOR : DOWN_COLOR, fontWeight: 600 }}>{lastBar.cvd >= 0 ? '+' : ''}{formatVolume(lastBar.cvd, lotSize, showLots)}</span>
                {showLots ? ' lots' : ''}
              </Text>
            )}
            {meta?.lastTradeAt && <Text type="secondary" style={{ fontSize: 12 }}>last trade {IST_HHMMSS.format(new Date(meta.lastTradeAt))}</Text>}
          </Space>
        </Card>

        {!isReplay && error && <Alert type="warning" showIcon message={error} />}
        {isReplay && replayError && <Alert type="warning" showIcon message={replayError} />}

        <Row gutter={[16, 16]}>
          <Col xs={24} xl={17}>
            <Card size="small" title={`Footprint · ${timeframe} min · ${rowSize} pt rows`} extra={!narrow && <Text type="secondary" style={{ fontSize: 11 }}>sell at bid × buy at ask · drag to scroll, wheel to zoom</Text>}>
              <FootprintChart bars={bars} rowSize={rowSize} lotSize={lotSize} showLots={showLots} lastPrice={meta?.lastPrice} height={narrow ? 470 : 640} profile={profile} />
              {profile?.poc != null && (
                <Text type="secondary" style={{ fontSize: 11 }}>
                  Volume profile{isReplay ? ' (to the replay time)' : ' (today)'}: POC {profile.poc} · value area {profile.val}–{profile.vah} (70% of volume)
                </Text>
              )}
            </Card>
          </Col>
          <Col xs={24} xl={7}>
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <Card size="small" title={`Market depth${meta ? ` (${meta.depthLevels} levels)` : ''}`}>
                <BookLadder book={view?.book} walls={walls} icebergPrices={activeIcebergs} lotSize={lotSize} showLots={showLots} />
              </Card>
              <Card size="small" title="Signals" styles={{ body: { maxHeight: 360, overflowY: 'auto' } }}>
                {signals.length === 0 ? <Text type="secondary">No signals yet.</Text> : signals.map((s) => (
                  <div key={s.key} style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12, padding: '3px 0', borderBottom: '1px solid #ffffff0d' }}>
                    <Text type="secondary" style={{ fontSize: 11, minWidth: 58 }}>{IST_HHMMSS.format(new Date(s.time))}</Text>
                    <Tag color={s.bullish ? 'green' : 'red'} style={{ margin: 0, fontSize: 11 }}>{s.type}</Tag>
                    <span>{s.text}</span>
                  </div>
                ))}
              </Card>
            </Space>
          </Col>
        </Row>

        <Card size="small" title="Depth heatmap" extra={!narrow && <Text type="secondary" style={{ fontSize: 11 }}>resting liquidity over time · circles = large prints · magenta = icebergs</Text>}>
          <DepthHeatmap columns={view?.heatmap ?? []} rowSize={rowSize} trades={largeTrades} icebergs={view?.icebergs} lotSize={lotSize} showLots={showLots} height={narrow ? 320 : 440} />
        </Card>

        <Card size="small" title={`Delta & cumulative delta · ${timeframe} min`}>
          <CumulativeDeltaChart bars={bars} dayKey={dayKey} lotSize={lotSize} showLots={showLots} height={narrow ? 200 : 260} />
        </Card>

        <Text type="secondary" style={{ fontSize: 11, color: AXIS_COLOR }}>
          Trades are inferred from Dhan's tick feed: the rise in the day's volume between two ticks is the volume traded, at the tick's price, and
          its side comes from the book just before it - at or above the best offer = buyers aggressive, at or below the best bid = sellers
          aggressive, otherwise by tick direction. Several trades between two ticks count as one print. Imbalance compares diagonally (buying
          at a price vs selling one row below); a stack is that many imbalanced rows in a row. Absorption = heavy aggression at a bar's
          extreme that failed to push price on (A); exhaustion = almost nothing traded at the extreme (E). An iceberg is a level that keeps
          trading more than twice the most it ever showed while staying in the book. Walls are levels at least 4x the book's median size.
          The volume profile is the traded volume per row over the bars shown, with its point of control (POC) and the 70% value area
          (VAH-VAL). Each day is recorded on the server and can be replayed; Dhan provides no historical tick or depth data, so only days the
          server recorded exist. The heatmap's book is 200 levels a side for NSE futures, 5 for SENSEX.
        </Text>
        <DomDrawer open={domOpen} onClose={() => setDomOpen(false)} underlying={underlying} />
      </Space>
    </div>
  )
}
