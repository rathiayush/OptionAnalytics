import { useEffect, useMemo, useRef, useState } from 'react'
import { Select, Space, Typography, Card, Button, Row, Col, Tag, Tooltip, Empty, Alert } from 'antd'
import * as signalR from '@microsoft/signalr'
import {
  NavBar, TIMEFRAME_OPTIONS, STORED_UNDERLYING, STORED_TIMEFRAME, usePersistedState, istDateKey, toBar,
} from './shared.jsx'
import {
  groupByStrike, latestAtOrBefore, aggregateBars, buildStrikeOffsetOptions, buildPremiumLine,
  ReplayChart, EmaChart, PremiumLineChart, PaperTradePanel, DraggableFloatingPanel,
  OiLadder, ChartErrorBoundary, PAPER_TRADE_LOT_SIZE, OI_STALE_MS,
} from './oiShared.jsx'

const { Text, Title } = Typography

// "Live OI Dashboard" - a SEPARATE page from OI Replay, deliberately. OI Replay's own "today, live"
// mode kept getting stuck (see its own git history) because it forced live data through a "replay
// clock" (visibleCount/asOfMs slicing) built for scrubbing a HISTORICAL day - live data has no
// "position" to scrub to, it only ever has "now", and threading it through that abstraction anyway
// kept reintroducing bugs across many rounds of fixes. This page instead copies the Dashboard page's
// (App.jsx) own proven live pattern: connect once, replace/append state directly from each tick, no
// time cursor anywhere. OI Replay itself is UNTOUCHED by this file - every helper/component used
// here comes from oiShared.jsx (a copy, not an edit of OiReplayPage.jsx), so nothing about this page
// can regress historical replay.
const LIVE_FEED_COMBOS = new Set(['NIFTY:WEEK', 'NIFTY:MONTH', 'BANKNIFTY:MONTH', 'SENSEX:WEEK', 'SENSEX:MONTH'])
const STEP_BY_UNDERLYING = { NIFTY: 50, BANKNIFTY: 100, SENSEX: 100 }

// Modeled directly on App.jsx's own useHub: ONE connection, opened on mount and never torn down or
// rebuilt - no `enabled` gate, no dependency on underlying/expiryFlag (the SAME hub broadcasts ticks
// for every underlying; this page just filters client-side in its own handlers, same as every
// consumer of oiReplayTick/futuresTick already does). This is the exact fix for the "reconnect churn"
// OiReplayPage's own useOiReplayLiveFeed was exposed to (its effect depends on `[enabled]`, which can
// flip during a fetch and tear the socket down at the worst moment) - this hook has no such flag.
function useOiLiveHub(onSpotUpdate, onOiReplayTick, onReconnected) {
  const spotRef = useRef(onSpotUpdate)
  const tickRef = useRef(onOiReplayTick)
  const reconnectedRef = useRef(onReconnected)
  spotRef.current = onSpotUpdate
  tickRef.current = onOiReplayTick
  reconnectedRef.current = onReconnected

  const [connectionState, setConnectionState] = useState('connecting')

  useEffect(() => {
    const connection = new signalR.HubConnectionBuilder()
      .withUrl('/hubs/spot')
      .withAutomaticReconnect()
      .build()

    connection.on('spotUpdate', (snapshot) => spotRef.current(snapshot))
    connection.on('oiReplayTick', (tick) => tickRef.current(tick))
    connection.onreconnecting(() => setConnectionState('reconnecting'))
    connection.onreconnected(() => { setConnectionState('connected'); reconnectedRef.current?.() })
    connection.onclose(() => setConnectionState('disconnected'))
    connection.start()
      .then(() => setConnectionState('connected'))
      .catch((err) => {
        // React StrictMode double-mounts every effect once in development - the first connection's
        // start() gets aborted by this effect's own cleanup before negotiation finishes on the
        // second mount. Not a real failure.
        if (err?.name === 'AbortError') return
        console.error('Live OI Dashboard connection failed:', err)
        setConnectionState('disconnected')
      })

    return () => { connection.stop() }
  }, [])

  return connectionState
}

// Appends a point to one strike's own array, or replaces the last entry if it lands in the exact
// same second (a still-forming reading updating in place) - the same "replace in place / append"
// merge shape every live series in this app already uses. Carries the previous entry's own IV
// forward when the new point doesn't have one (a live tick never carries IV - see
// OiReplayLiveFeedService's own doc comment - only the initial REST seed does).
function appendPoint(map, strike, point) {
  const next = new Map(map)
  const existing = next.get(strike) ?? []
  const withIv = { ...point, impliedVolatility: point.impliedVolatility ?? existing[existing.length - 1]?.impliedVolatility ?? null }
  if (existing.length > 0 && new Date(existing[existing.length - 1].time).getTime() === new Date(point.time).getTime()) {
    next.set(strike, [...existing.slice(0, -1), withIv])
  } else {
    next.set(strike, [...existing, withIv])
  }
  return next
}

// Merges one live spot bar into the day's own bar array - replace-by-timestamp if it's the same
// still-forming minute, append if it's a genuinely new one. Same shape as App.jsx's own
// mergeLiveBar, just against chart-time (already-shifted) values.
function mergeBar(bars, bar) {
  if (bars.length > 0 && bars[bars.length - 1].time === bar.time) return [...bars.slice(0, -1), bar]
  if (bars.length === 0 || bar.time > bars[bars.length - 1].time) return [...bars, bar]
  return bars
}

export default function OiLiveDashboardPage() {
  const [underlying, setUnderlying] = usePersistedState(STORED_UNDERLYING, 'NIFTY')
  const [expiryFlag, setExpiryFlag] = useState('WEEK')
  const [timeframe, setTimeframe] = usePersistedState(STORED_TIMEFRAME, 15)
  const [chartBTimeframe, setChartBTimeframe] = useState(3)
  const [chartBEma1, setChartBEma1] = useState(9)
  const [chartBEma2, setChartBEma2] = useState(15)
  const [chartCTimeframe, setChartCTimeframe] = useState(1)
  const [chartCEma1, setChartCEma1] = useState(9)
  const [chartCEma2, setChartCEma2] = useState(15)

  const [result, setResult] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  // The live state itself - an array of every 1-minute bar today has had so far, and a Map per side
  // of every strike's own points, ascending by time. No "as of" cursor anywhere: since this page
  // never scrubs backward, "the latest reading" is always just the last element, and "today's open"
  // is always just the first - see ladderRows below.
  const [oneMinBars, setOneMinBars] = useState([])
  const [ceSeries, setCeSeries] = useState(new Map())
  const [peSeries, setPeSeries] = useState(new Map())

  const [cePremiumOffset, setCePremiumOffset] = useState(0)
  const [pePremiumOffset, setPePremiumOffset] = useState(0)

  const [paperSide, setPaperSide] = useState('CE')
  const [paperDirection, setPaperDirection] = useState('BUY')
  const [paperStrikeOffset, setPaperStrikeOffset] = useState(0)
  const [paperQtyLots, setPaperQtyLots] = useState(10)
  const [paperPositions, setPaperPositions] = useState([])
  const [paperPanelOpen, setPaperPanelOpen] = useState(false)
  const [paperPanelPos, setPaperPanelPos] = useState(() => ({ x: Math.max(24, window.innerWidth - 480), y: 140 }))

  const liveFeedSupported = LIVE_FEED_COMBOS.has(`${underlying}:${expiryFlag}`)

  const load = () => {
    if (!underlying) return
    setLoading(true)
    setError(null)
    const params = new URLSearchParams({ date: istDateKey(new Date()), timeframeMinutes: '1', expiryFlag })
    fetch(`/api/oi-replay/${underlying}/run?${params.toString()}`)
      .then(async (r) => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.error || `Request failed (HTTP ${r.status}).`)
        return body
      })
      .then((body) => {
        if (!body?.success) throw new Error(body?.error || 'This run did not succeed.')
        setResult(body)
        setOneMinBars((body.spotCandlesOneMinute ?? []).map(toBar))
        setCeSeries(groupByStrike(body.cePoints ?? []))
        setPeSeries(groupByStrike(body.pePoints ?? []))
        setPaperPositions([])
      })
      .catch((err) => {
        console.error('Failed to load Live OI Dashboard data:', err)
        setResult(null)
        setError(err.message || 'Failed to load today.')
      })
      .finally(() => setLoading(false))
  }

  // Fresh seed whenever the underlying/expiry actually looked at changes - the live handlers below
  // filter every incoming tick by `underlying`/`expiryFlag`, so switching either one needs a new
  // snapshot for the newly-selected combo, exactly like a fresh Load in OI Replay.
  useEffect(() => { load() /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [underlying, expiryFlag])

  const handleSpotUpdate = (snapshot) => {
    if (snapshot?.underlying !== underlying || !snapshot?.currentBar) return
    setOneMinBars((prev) => mergeBar(prev, toBar(snapshot.currentBar)))
  }

  const handleOiReplayTick = (tick) => {
    if (tick?.underlying !== underlying || tick?.expiryFlag !== expiryFlag) return
    const point = { time: tick.time, strike: tick.strike, openInterest: tick.openInterest, impliedVolatility: null, price: tick.price }
    if (tick.side === 'CE') setCeSeries((prev) => appendPoint(prev, tick.strike, point))
    else setPeSeries((prev) => appendPoint(prev, tick.strike, point))
  }

  // A dropped-then-restored connection can miss ticks entirely while it was down - re-fetch the
  // whole snapshot to resync rather than silently trusting whatever partial state accumulated.
  const handleReconnected = () => load()

  const connectionState = useOiLiveHub(handleSpotUpdate, handleOiReplayTick, handleReconnected)

  const step = result?.step || STEP_BY_UNDERLYING[underlying] || 50
  const currentBar = oneMinBars[oneMinBars.length - 1] ?? null
  const atmStrike = currentBar ? Math.round(currentBar.close / step) * step : null

  const displayBars = useMemo(() => aggregateBars(oneMinBars, timeframe), [oneMinBars, timeframe])

  // Every strike either side has ever reported, current OI/IV/price plus a one-minute-ago and a
  // day-open reference - "now" and "a minute ago" are plain Date.now() reads (this page has no
  // concept of any other "now"), and "day-open" is simply each array's own first element, since the
  // seed fetch already starts from market open.
  const ladderRows = useMemo(() => {
    const now = Date.now()
    const priorMs = now - 60_000
    const strikes = new Set([...ceSeries.keys(), ...peSeries.keys()])
    const rows = [...strikes].map((strike) => {
      const ceArr = ceSeries.get(strike) ?? []
      const peArr = peSeries.get(strike) ?? []
      const ce = ceArr[ceArr.length - 1] ?? null
      const pe = peArr[peArr.length - 1] ?? null
      const cePrior = latestAtOrBefore(ceArr, priorMs)
      const pePrior = latestAtOrBefore(peArr, priorMs)
      const ceOpen = ceArr[0] ?? null
      const peOpen = peArr[0] ?? null
      const ceAsOfMs = ce ? new Date(ce.time).getTime() : null
      const peAsOfMs = pe ? new Date(pe.time).getTime() : null
      return {
        strike,
        ceOi: ce?.openInterest ?? null, ceIv: ce?.impliedVolatility ?? null, cePrice: ce?.price ?? null,
        peOi: pe?.openInterest ?? null, peIv: pe?.impliedVolatility ?? null, pePrice: pe?.price ?? null,
        ceOiChange: ce?.openInterest != null && cePrior?.openInterest != null ? ce.openInterest - cePrior.openInterest : null,
        peOiChange: pe?.openInterest != null && pePrior?.openInterest != null ? pe.openInterest - pePrior.openInterest : null,
        ceOiSinceOpen: ce?.openInterest != null && ceOpen?.openInterest != null ? ce.openInterest - ceOpen.openInterest : null,
        peOiSinceOpen: pe?.openInterest != null && peOpen?.openInterest != null ? pe.openInterest - peOpen.openInterest : null,
        ceAsOfMs, peAsOfMs,
        ceStale: ceAsOfMs != null && now - ceAsOfMs > OI_STALE_MS,
        peStale: peAsOfMs != null && now - peAsOfMs > OI_STALE_MS,
      }
    })
    return rows.sort((a, b) => b.strike - a.strike)
  }, [ceSeries, peSeries])

  const cePremiumStrike = atmStrike != null ? atmStrike + cePremiumOffset * step : null
  const pePremiumStrike = atmStrike != null ? atmStrike + pePremiumOffset * step : null
  const cePremiumLine = useMemo(() => buildPremiumLine(ceSeries.get(cePremiumStrike), Date.now()), [ceSeries, cePremiumStrike])
  const pePremiumLine = useMemo(() => buildPremiumLine(peSeries.get(pePremiumStrike), Date.now()), [peSeries, pePremiumStrike])
  const premiumStrikeOptions = useMemo(() => buildStrikeOffsetOptions(atmStrike, step), [atmStrike, step])

  const paperStrike = atmStrike != null ? atmStrike + paperStrikeOffset * step : null
  const paperEntryPreview = useMemo(() => {
    const series = (paperSide === 'CE' ? ceSeries : peSeries).get(paperStrike)
    return series?.[series.length - 1] ?? null
  }, [paperSide, paperStrike, ceSeries, peSeries])

  const handlePaperPunch = () => {
    if (paperStrike == null || paperEntryPreview?.price == null) return
    setPaperPositions((prev) => [...prev, {
      id: `${Date.now()}-${Math.random()}`,
      side: paperSide, direction: paperDirection, strike: paperStrike, qtyLots: paperQtyLots,
      lotSize: PAPER_TRADE_LOT_SIZE[underlying] ?? 1,
      entryPrice: paperEntryPreview.price, status: 'OPEN', exitPrice: null,
    }])
  }

  const handlePaperExit = (id) => {
    setPaperPositions((prev) => prev.map((p) => {
      if (p.id !== id || p.status !== 'OPEN') return p
      const series = (p.side === 'CE' ? ceSeries : peSeries).get(p.strike)
      const point = series?.[series.length - 1] ?? null
      return { ...p, status: 'CLOSED', exitPrice: point?.price ?? p.entryPrice }
    }))
  }

  const handlePaperClearAll = () => setPaperPositions([])

  const enrichedPaperPositions = useMemo(() => paperPositions.map((p) => {
    const series = (p.side === 'CE' ? ceSeries : peSeries).get(p.strike)
    const livePoint = p.status === 'OPEN' ? series?.[series.length - 1] : null
    const ltp = p.status === 'OPEN' ? (livePoint?.price ?? p.entryPrice) : p.exitPrice
    const priceDelta = p.direction === 'SELL' ? p.entryPrice - ltp : ltp - p.entryPrice
    return { ...p, ltp, pnl: priceDelta * p.qtyLots * p.lotSize }
  }), [paperPositions, ceSeries, peSeries])
  const paperOpenCount = enrichedPaperPositions.filter((p) => p.status === 'OPEN').length
  const paperTotalPnl = enrichedPaperPositions.reduce((sum, p) => sum + p.pnl, 0)

  const dayKey = `${underlying}-${expiryFlag}`

  return (
    <div style={{ maxWidth: 2600, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>

        <Card size="small" title="Live OI Dashboard">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Always today, always live - ticks straight off the same feed OI Replay uses, with no
              playback position to get stuck at. To review a past day instead, use OI Replay.
            </Text>
            <Space wrap size={12}>
              <Select
                value={underlying} onChange={setUnderlying} style={{ width: 130 }}
                options={[{ value: 'NIFTY', label: 'NIFTY' }, { value: 'BANKNIFTY', label: 'BANKNIFTY' }, { value: 'SENSEX', label: 'SENSEX' }]}
              />
              <Select
                value={expiryFlag} onChange={setExpiryFlag} style={{ width: 130 }}
                options={[{ value: 'WEEK', label: 'Weekly', disabled: underlying === 'BANKNIFTY' }, { value: 'MONTH', label: 'Monthly' }]}
              />
              <Select value={timeframe} onChange={setTimeframe} style={{ width: 110 }} options={TIMEFRAME_OPTIONS} />
              <Tooltip title={
                connectionState === 'connected' ? "Streaming live ticks from Dhan's WebSocket feed (price + OI - IV stays at the last REST-fetched value)"
                  : connectionState === 'reconnecting' ? 'Connection dropped - automatically retrying.'
                    : connectionState === 'connecting' ? 'Connecting to the live feed…'
                      : 'Not connected - not receiving live ticks right now.'
              }>
                <Tag color={connectionState === 'connected' ? 'success' : connectionState === 'reconnecting' ? 'warning' : connectionState === 'connecting' ? 'processing' : 'error'}>
                  {connectionState === 'connected' ? '● LIVE' : connectionState === 'reconnecting' ? '● RECONNECTING' : connectionState === 'connecting' ? '● CONNECTING' : '● OFFLINE'}
                </Tag>
              </Tooltip>
              {paperTotalPnl !== 0 || paperOpenCount > 0 ? (
                <Tag color={paperTotalPnl >= 0 ? 'success' : 'error'} style={{ cursor: 'pointer' }} onClick={() => setPaperPanelOpen((o) => !o)}>
                  Paper PnL: {paperTotalPnl >= 0 ? '+' : ''}{paperTotalPnl.toFixed(0)}{paperOpenCount > 0 ? ` (${paperOpenCount} open)` : ''}
                </Tag>
              ) : (
                <Button size="small" onClick={() => setPaperPanelOpen((o) => !o)}>Paper Trade</Button>
              )}
            </Space>
            {!liveFeedSupported && (
              <Alert
                type="info" showIcon
                message={`Live tick-by-tick updates aren't wired up for ${underlying} ${expiryFlag === 'WEEK' ? 'Weekly' : 'Monthly'} - you'll see today's snapshot as of the last load, not a continuously ticking feed. NIFTY (Weekly/Monthly), BANKNIFTY (Monthly) and SENSEX (Weekly/Monthly) all stay live.`}
              />
            )}
            {liveFeedSupported && connectionState === 'disconnected' && (
              <Alert
                type="error" showIcon
                message="Not receiving live ticks right now - check the browser console for a SignalR connection error, and confirm the backend's own Dhan market-feed connection is up."
              />
            )}
            {error && <Alert type="error" showIcon message={error} />}
            {paperPanelOpen && (
              <DraggableFloatingPanel title="Paper trade" pos={paperPanelPos} onPosChange={setPaperPanelPos} onClose={() => setPaperPanelOpen(false)}>
                <PaperTradePanel
                  atmStrike={atmStrike} step={step}
                  side={paperSide} onSideChange={setPaperSide}
                  direction={paperDirection} onDirectionChange={setPaperDirection}
                  strikeOffset={paperStrikeOffset} onStrikeOffsetChange={setPaperStrikeOffset}
                  qtyLots={paperQtyLots} onQtyLotsChange={setPaperQtyLots}
                  onPunch={handlePaperPunch} canPunch={paperEntryPreview?.price != null}
                  positions={enrichedPaperPositions} onExit={handlePaperExit} onClearAll={handlePaperClearAll}
                />
              </DraggableFloatingPanel>
            )}
          </Space>
        </Card>

        <Row gutter={16}>
          <Col span={8}>
            <Card size="small" title="Spot (live)">
              {oneMinBars.length > 0 ? (
                <ChartErrorBoundary key={`${underlying}-${expiryFlag}-${timeframe}`}>
                  <ReplayChart bars={displayBars} ladderRows={ladderRows} dayKey={dayKey} atmStrike={atmStrike} step={step} height={560} />
                </ChartErrorBoundary>
              ) : (
                <Empty description={loading ? 'Loading…' : 'No spot candles yet today.'} />
              )}
            </Card>
          </Col>
          <Col span={8}>
            <Card size="small" title="Entry chart B (independent timeframe + EMA)">
              {oneMinBars.length > 0 ? (
                <ChartErrorBoundary key={`emaB-${underlying}-${expiryFlag}-${chartBTimeframe}`}>
                  <EmaChart
                    oneMinBars={oneMinBars} visibleCount={oneMinBars.length}
                    timeframe={chartBTimeframe} onTimeframeChange={setChartBTimeframe}
                    ema1Period={chartBEma1} onEma1PeriodChange={setChartBEma1}
                    ema2Period={chartBEma2} onEma2PeriodChange={setChartBEma2}
                    dayKey={`emaB-${dayKey}`} height={560}
                  />
                </ChartErrorBoundary>
              ) : (
                <Empty description={loading ? 'Loading…' : 'No spot candles yet today.'} />
              )}
            </Card>
          </Col>
          <Col span={8}>
            <Card size="small" title="Entry chart C (independent timeframe + EMA)">
              {oneMinBars.length > 0 ? (
                <ChartErrorBoundary key={`emaC-${underlying}-${expiryFlag}-${chartCTimeframe}`}>
                  <EmaChart
                    oneMinBars={oneMinBars} visibleCount={oneMinBars.length}
                    timeframe={chartCTimeframe} onTimeframeChange={setChartCTimeframe}
                    ema1Period={chartCEma1} onEma1PeriodChange={setChartCEma1}
                    ema2Period={chartCEma2} onEma2PeriodChange={setChartCEma2}
                    dayKey={`emaC-${dayKey}`} height={560}
                  />
                </ChartErrorBoundary>
              ) : (
                <Empty description={loading ? 'Loading…' : 'No spot candles yet today.'} />
              )}
            </Card>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={12}>
            <Card
              size="small"
              title={`CE premium ${cePremiumStrike ?? ''}`}
              extra={<Select value={cePremiumOffset} onChange={setCePremiumOffset} style={{ width: 150 }} options={premiumStrikeOptions} disabled={atmStrike == null} />}
            >
              {oneMinBars.length === 0
                ? <Empty description="No spot candles yet today." />
                : cePremiumLine.length === 0
                  ? <Empty description={`No CE ${cePremiumStrike ?? ''} premium data yet today.`} />
                  : (
                    <ChartErrorBoundary key={`premium-ce-${underlying}-${expiryFlag}-${cePremiumOffset}`}>
                      <PremiumLineChart points={cePremiumLine} dayKey={`premium-ce-${dayKey}-${cePremiumOffset}`} color="#7a0000" height={320} />
                    </ChartErrorBoundary>
                  )}
            </Card>
          </Col>
          <Col span={12}>
            <Card
              size="small"
              title={`PE premium ${pePremiumStrike ?? ''}`}
              extra={<Select value={pePremiumOffset} onChange={setPePremiumOffset} style={{ width: 150 }} options={premiumStrikeOptions} disabled={atmStrike == null} />}
            >
              {oneMinBars.length === 0
                ? <Empty description="No spot candles yet today." />
                : pePremiumLine.length === 0
                  ? <Empty description={`No PE ${pePremiumStrike ?? ''} premium data yet today.`} />
                  : (
                    <ChartErrorBoundary key={`premium-pe-${underlying}-${expiryFlag}-${pePremiumOffset}`}>
                      <PremiumLineChart points={pePremiumLine} dayKey={`premium-pe-${dayKey}-${pePremiumOffset}`} color="#0a5c1f" height={320} />
                    </ChartErrorBoundary>
                  )}
            </Card>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={24}>
            <Card size="small" title="OI / IV ladder (nearest expiry, live)" bodyStyle={{ maxHeight: 560, overflowY: 'auto' }}>
              <OiLadder rows={ladderRows} atmStrike={atmStrike} />
            </Card>
          </Col>
        </Row>
      </Space>
    </div>
  )
}
