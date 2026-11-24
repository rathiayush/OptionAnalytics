import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, Empty, InputNumber, Segmented, Select, Slider, Space, Statistic, Tag, Tooltip, Typography } from 'antd'
import { PauseCircleOutlined, PlayCircleOutlined, StepBackwardOutlined } from '@ant-design/icons'
import { NavBar, POLL_HEADERS, useAuth, usePersistedState } from './shared.jsx'
import { FoldText } from './FoldText.jsx'
import { TickFootprintChart } from './TickFootprintChart.jsx'
import { TickBubbleChart } from './TickBubbleChart.jsx'
import { TickBigOrdersCard } from './TickBigOrdersCard.jsx'
import { aggregateTickBars, coveragePct, cumulativeDelta, fmtQty, prepareTickDay, replayCut, weekdayChoices } from './tickFlowMath.js'

const { Title, Text } = Typography

// TICK FLOW - a page of its own on TrueData's real-time TICK feed (TrueDataLiveFeed / TickBook on the server, TrueData:Live:Enabled),
// NIFTY and BANKNIFTY near futures. Nothing here is shared with the Order Flow page: its own server store, its own maths
// (tickFlowMath.js) and its own charts - the FOOTPRINT (TickFootprintChart) and the BUBBLE CHART (TickBubbleChart: the price moving
// through time, a bubble at every order, a small order a small bubble, a big order a big one). A trade arrives with its own
// quantity, so the footprint is exact; its side comes from the quote before it. NSE depth past level 1 is not in TrueData's feed.
// A read - it places nothing and feeds no strategy or alert.

const INDICES = ['NIFTY', 'BANKNIFTY']
const DEFAULT_ROWS = { NIFTY: 1, BANKNIFTY: 5 }
const ROW_OPTIONS = [0.5, 1, 2, 5, 10, 20].map((v) => ({ value: v, label: `${v} pt row` }))
const POLL_MS = 2000

function useNarrowScreen() {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 700)
  useEffect(() => {
    const on = () => setNarrow(window.innerWidth < 700)
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return narrow
}

// Live: the day so far, again every 2 s. Replay: a day loaded ONCE (every order and the whole quote trail, cut at the replay clock on
// the page); a failed load is shown, never retried in a loop - "Reload" asks again.
function useTickDay(underlying, rowSize, replayDate, reloadKey) {
  const key = `${underlying}|${rowSize}|${replayDate ?? 'live'}|${reloadKey}`
  const [held, setHeld] = useState({ key: null, day: null, error: null })
  const [status, setStatus] = useState(null)
  useEffect(() => {
    let alive = true
    const query = replayDate
      ? `date=${replayDate}&rowSize=${rowSize}&maxBubbles=400000&maxQuotes=100000`
      : `rowSize=${rowSize}&maxBubbles=8000`
    const load = async () => {
      try {
        const [dayRes, statusRes] = await Promise.all([
          fetch(`/api/tick-flow/${underlying}?${query}`, { headers: replayDate ? undefined : POLL_HEADERS }),
          fetch('/api/tick-flow/status', { headers: POLL_HEADERS }),
        ])
        const statusBody = statusRes.ok ? await statusRes.json() : null
        if (!alive) return
        setStatus(statusBody)
        if (!dayRes.ok) {
          const body = await dayRes.json().catch(() => null)
          setHeld({ key, day: null, error: body?.error ?? `HTTP ${dayRes.status}` })
          return
        }
        setHeld({ key, day: await dayRes.json(), error: null })
      } catch (e) {
        if (alive) setHeld((h) => ({ ...h, key, error: String(e?.message ?? e) }))
      }
    }
    load()
    const timer = replayDate ? null : setInterval(load, POLL_MS)
    return () => { alive = false; if (timer) clearInterval(timer) }
  }, [underlying, rowSize, replayDate, key])
  const current = held.key === key ? held : { day: null, error: null }
  return { day: current.day, error: current.error, loading: held.key !== key, status }
}

const SPEEDS = [1, 5, 10, 30, 60, 120, 300, 600].map((v) => ({ value: v, label: `${v}x` }))
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)
const hhmmss = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' })

// Where the live ticks come from - TrueData's WebSocket (JSON) or its TCP stream (binary packets). An admin picks; the server reconnects
// through the one picked at once and keeps the choice. Replay is always TrueData's REST history.
const SOURCES = [{ value: 'websocket', label: 'WebSocket' }, { value: 'tcp', label: 'TCP' }]

export default function TickFlowPage() {
  const narrow = useNarrowScreen()
  const isAdmin = useAuth()?.user?.role === 'Admin'
  const [sourceError, setSourceError] = useState(null)
  const [underlying, setUnderlying] = usePersistedState('optionanalytics.tickFlow.underlying', 'NIFTY')
  const [rowSizes, setRowSizes] = usePersistedState('optionanalytics.tickFlow.rowSizes', DEFAULT_ROWS)
  const [timeframe, setTimeframe] = usePersistedState('optionanalytics.tickFlow.timeframe', 1)
  const [showLots, setShowLots] = usePersistedState('optionanalytics.tickFlow.showLots', true)
  const [rowDelta, setRowDelta] = usePersistedState('optionanalytics.tickFlow.rowDelta', false)
  // The smallest bubble, kept in the unit picked (lots or quantity) - each its own box, so switching does not change what the other shows.
  const [minLots, setMinLots] = usePersistedState('optionanalytics.tickFlow.minLots', 1)
  const [minQty, setMinQty] = usePersistedState('optionanalytics.tickFlow.minQty', 1)
  const [mode, setMode] = usePersistedState('optionanalytics.tickFlow.mode', 'live')
  const [bubbleSize, setBubbleSize] = usePersistedState('optionanalytics.tickFlow.bubbleSize', 34)
  const days = useMemo(() => weekdayChoices(istToday(), 6), [])
  const [replayDay, setReplayDay] = useState(() => days[1] ?? days[0])
  const [reload, setReload] = useState(0)
  const [pos, setPos] = useState({ key: null, ms: null })
  const [playState, setPlayState] = useState({ key: null, on: false })
  const [speed, setSpeed] = useState(60)
  const index = INDICES.includes(underlying) ? underlying : 'NIFTY'
  const rowSize = rowSizes?.[index] ?? DEFAULT_ROWS[index]
  const replay = mode === 'replay'
  const { day: loaded, error, loading, status } = useTickDay(index, rowSize, replay ? replayDay : null, reload)

  // A replayed day: every time as ms once, the clock at the day's first minute, and the page shows the day cut at the clock.
  const prepared = useMemo(() => (replay ? prepareTickDay(loaded) : null), [replay, loaded])
  const range = useMemo(() => {
    if (!prepared || prepared.bars.length === 0) return null
    return { start: prepared.bars[0].ms, end: prepared.bars.at(-1).ms + 60_000 }
  }, [prepared])
  // The clock and play state belong to the day loaded: another day (or a reload) starts at its first minute, paused.
  const rangeKey = range ? `${range.start}-${range.end}` : null
  const clock = range ? (pos.key === rangeKey ? pos.ms : range.start) : null
  const playing = playState.key === rangeKey && playState.on
  const setClock = (ms) => setPos({ key: rangeKey, ms })
  const setPlaying = (on) => setPlayState({ key: rangeKey, on })
  const clockRef = useRef(null)
  useEffect(() => { clockRef.current = clock }, [clock])
  useEffect(() => {
    if (!playing || !range) return undefined
    const timer = setInterval(() => {
      const next = (clockRef.current ?? range.start) + speed * 200
      if (next >= range.end) { setPos({ key: rangeKey, ms: range.end }); setPlayState({ key: rangeKey, on: false }) } else setPos({ key: rangeKey, ms: next })
    }, 200)
    return () => clearInterval(timer)
  }, [playing, range, rangeKey, speed])
  const cut = useMemo(() => (prepared && clock != null ? replayCut(prepared, clock, rowSize) : null), [prepared, clock, rowSize])
  const day = replay ? (cut ? { meta: { ...loaded.meta, lastPrice: cut.lastPrice, bid: cut.bid, bidQty: cut.bidQty, ask: cut.ask, askQty: cut.askQty }, bars: cut.bars, bubbles: cut.bubbles, quotes: cut.quotes } : null) : loaded

  const meta = day?.meta
  const lotSize = meta?.lotSize ?? 1
  const bars = useMemo(() => aggregateTickBars(day?.bars ?? [], timeframe), [day?.bars, timeframe])
  const cvd = useMemo(() => cumulativeDelta(bars), [bars])
  const stream = status?.status?.streams?.find((s) => s.underlying === index)
  const feedState = status?.status?.state ?? status?.state ?? 'unknown'
  const off = status && status.enabled === false
  const total = cvd.at(-1) ?? 0
  const mt = loaded?.meta
  const coverage = coveragePct(mt?.bookedVolume ?? 0, mt?.exchangeVolume ?? 0)

  return (
    <div style={{ maxWidth: 2600, margin: '0 auto', padding: narrow ? '16px 8px 120px' : '24px 16px 120px', overflowX: 'clip' }}>
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>

        <Card size="small" title="Tick Flow - footprint and order bubbles from TrueData's tick feed">
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Space wrap size={[12, 8]}>
              <Segmented value={mode} onChange={setMode} options={[{ value: 'live', label: 'Live' }, { value: 'replay', label: 'Replay' }]} />
              <Segmented value={index} onChange={setUnderlying} options={INDICES} />
              <Select value={timeframe} onChange={setTimeframe} style={{ width: 110 }} options={[1, 3, 5, 15].map((v) => ({ value: v, label: `${v} min` }))} />
              <Select value={rowSize} onChange={(v) => setRowSizes({ ...(rowSizes ?? {}), [index]: v })} style={{ width: 120 }} options={ROW_OPTIONS} />
              <Tooltip title={`Where the live ticks come from: TrueData's WebSocket (JSON messages) or its TCP stream (binary packets with the last tick's volume and a sequence number). Once picked, the server reconnects through it and the data comes from there - one login an account, so the other is closed. ${isAdmin ? 'Kept across a restart.' : 'An admin picks it.'} Replay of a past day is always TrueData's tick history (REST).`}>
                <span>
                  Live source{' '}
                  <Segmented size="small" value={status?.status?.transport ?? 'websocket'} disabled={!isAdmin || off || !status?.status}
                    options={SOURCES}
                    onChange={async (value) => {
                      setSourceError(null)
                      try {
                        const r = await fetch('/api/tick-flow/source', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ transport: value }) })
                        if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`)
                        setReload((n) => n + 1)
                      } catch (e) { setSourceError(e.message) }
                    }} />
                </span>
              </Tooltip>
              <Tooltip title="The smallest order drawn as a bubble, in the unit picked (lots or quantity). 1 = every order; raise it on a busy day to see only the larger ones.">
                <span>
                  Bubbles ≥ {showLots
                    ? <InputNumber size="small" min={1} max={1000} value={minLots} onChange={(v) => setMinLots(v ?? 1)} style={{ width: 70 }} />
                    : <InputNumber size="small" min={1} max={1_000_000} step={lotSize} value={minQty} onChange={(v) => setMinQty(v ?? 1)} style={{ width: 90 }} />}
                  {showLots ? ' lots' : ' qty'}
                </span>
              </Tooltip>
              <Tooltip title="The biggest bubble's size on the chart.">
                <Select value={bubbleSize} onChange={setBubbleSize} style={{ width: 120 }} options={[{ value: 22, label: 'Small bubbles' }, { value: 34, label: 'Medium bubbles' }, { value: 52, label: 'Large bubbles' }]} />
              </Tooltip>
              <Tooltip title={`Show every size in lots (1 lot = ${lotSize} units) or as the quantity (units) itself - the footprint, delta, bubbles, sizes and the bubble filter all follow it.`}>
                <Segmented value={showLots ? 'lots' : 'qty'} onChange={(v) => setShowLots(v === 'lots')} options={[{ value: 'lots', label: 'Lots' }, { value: 'qty', label: 'Quantity' }]} />
              </Tooltip>
              <Checkbox checked={rowDelta} onChange={(e) => setRowDelta(e.target.checked)}>Delta per row</Checkbox>
              {replay && <Select value={replayDay} onChange={(v) => setReplayDay(v)} style={{ width: 130 }} options={days.map((d) => ({ value: d, label: d }))} />}
              {replay && <Button size="small" onClick={() => setReload((n) => n + 1)}>Reload</Button>}
              <Tag color={feedState === 'streaming' ? 'green' : off ? 'default' : 'orange'}>TrueData: {off ? 'off' : feedState}</Tag>
              {stream && (
                <Tooltip title="TrueData numbers every tick: a count here means ticks were lost on the way to the server (their feed's own sequence number).">
                  <Tag color={stream.sequenceGaps > 0 ? 'red' : 'green'}>{stream.trades.toLocaleString()} trades · {stream.sequenceGaps} lost</Tag>
                </Tooltip>
              )}
              {coverage != null && (
                <Tooltip title="What the feed delivered against the exchange's own running volume since the first trade it saw. 100% = all the volume is in the footprint; less = volume the feed did not send.">
                  <Tag color={coverage >= 99 ? 'green' : coverage >= 95 ? 'orange' : 'red'}>{coverage.toFixed(1)}% of exchange volume</Tag>
                </Tooltip>
              )}
            </Space>
            <FoldText id="tickFlowIntro" summary="What this page is and is not"
              text="TrueData sends an update about every second or faster, each carrying the quantity traded since the one before and the best bid / ask with their sizes - every unit of the exchange's volume is in them (the coverage tag checks it), but one update can hold several trades, which then share one price and side (a tested minute: ~50 updates, ~16 lots each). A trade's side comes from the quote before it. The bubble chart draws each update where and when it traded: green bought at the ask, red sold at the bid, the size of the bubble following its quantity (updates at one price and side within a second are one bubble). TrueData's NSE feed has only the best bid and ask - the grey band - not a deeper order book. The day lives in the server's memory, so a restart begins it again from the next tick. Nothing here places an order or feeds a strategy or alert." />
          </Space>
        </Card>

        {off && <Alert type="info" showIcon message="The TrueData live feed is off" description={status?.note ?? 'Set TrueData:Live:Enabled and the TrueData login (TrueData__UserId / TrueData__Password) on the server.'} />}
        {!off && error && <Alert type="warning" showIcon message={error} />}
        {sourceError && <Alert type="warning" showIcon closable onClose={() => setSourceError(null)} message={`The source was not changed: ${sourceError}`} />}
        {status?.status?.error && !off && <Alert type="warning" showIcon message={`TrueData: ${status.status.error}`} />}

        {!off && !replay && status?.status && (!stream || stream.trades === 0) && (
          <Alert type="info" showIcon
            message={`Nothing traded yet - feed: ${status.status.state}${status.status.error ? ` (${status.status.error})` : ''}`}
            description={(
              <div>
                <div>
                  {status.status.frames.toLocaleString()} messages received · last {status.status.lastFrameAt ? new Date(status.status.lastFrameAt).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata' }) : 'never'} IST · {status.status.port}.
                  {' '}It connects 08:30 - 15:45 IST on weekdays and TrueData's sandbox sends trades only while the market trades (09:15 - 15:30).
                </div>
                {(status.status.recentFrames ?? []).length > 0 && (
                  <>
                    <div style={{ marginTop: 6 }}>The newest messages TrueData sent (select and copy):</div>
                    <pre style={{ margin: 0, maxHeight: 180, overflow: 'auto', fontSize: 11, whiteSpace: 'pre-wrap', userSelect: 'all' }}>{status.status.recentFrames.join('\n')}</pre>
                  </>
                )}
              </div>
            )} />
        )}

        {replay && (
          <Card size="small">
            {!range
              ? <Text type="secondary">{loading ? 'Loading the day…' : error ? '' : 'No ticks for that day.'}</Text>
              : (
                <Space size={12} wrap style={{ width: '100%' }}>
                  <Button type="primary" icon={playing ? <PauseCircleOutlined /> : <PlayCircleOutlined />} onClick={() => { if (!playing && clock >= range.end) setClock(range.start); setPlaying(!playing) }}>{playing ? 'Pause' : 'Play'}</Button>
                  <Button icon={<StepBackwardOutlined />} onClick={() => { setPlaying(false); setClock(range.start) }}>Reset</Button>
                  <Select value={speed} onChange={setSpeed} style={{ width: 90 }} options={SPEEDS} />
                  <Text strong style={{ minWidth: 70 }}>{clock != null ? hhmmss(clock) : ''}</Text>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <Slider min={range.start} max={range.end} step={1000} value={clock ?? range.start} tooltip={{ open: false }}
                      onChange={(v) => setClock(v)} onChangeComplete={() => {}} />
                  </div>
                </Space>
              )}
          </Card>
        )}

        {meta && (
          <Space size={24} wrap>
            <Statistic title={`${meta.symbol} last`} value={meta.lastPrice || '-'} />
            <Statistic title="Bid × Ask" value={meta.bid > 0 ? `${meta.bid} × ${meta.ask}` : '-'} />
            <Statistic title="Bid / ask size" value={meta.bid > 0 ? `${fmtQty(meta.bidQty, lotSize, showLots)} / ${fmtQty(meta.askQty, lotSize, showLots)}` : '-'} />
            <Statistic title={`Cumulative delta (${showLots ? 'lots' : 'qty'})`} value={fmtQty(total, lotSize, showLots)} valueStyle={{ color: total >= 0 ? '#52c41a' : '#ff4d4f' }} />
          </Space>
        )}

        <Card size="small" title="Order bubbles - price through time, a bubble at every order" extra={!narrow && <span style={{ fontSize: 11, opacity: 0.65 }}>wheel scrolls the page · Ctrl+wheel: zoom time · Shift+wheel: zoom price · drag: move · pinch · double-click: reset · hover a bubble</span>}>
          {!day || day.bubbles.length === 0
            ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? 'Loading…' : off ? 'Turn the feed on to see the bubbles.' : replay ? 'No trade in this day up to the clock.' : 'No trade yet today - it starts with the first tick after the connection (market hours).'} />
            : <TickBubbleChart bubbles={day.bubbles} quotes={day.quotes} lastPrice={meta?.lastPrice} lotSize={lotSize} showLots={showLots} minLots={showLots ? minLots : minQty / (lotSize || 1)} rMax={bubbleSize} height={narrow ? 380 : 560} />}
        </Card>

        <Card size="small" title="Big option orders - TrueData's live ticks of the options ATM ± N, read and added up">
          <TickBigOrdersCard isAdmin={isAdmin} replay={replay} showLots={showLots} index={index} replayDate={replay ? replayDay : null} clockMs={replay ? clock : null} />
        </Card>

        <Card size="small" title={`Footprint · ${timeframe} min · ${rowSize} pt rows`} extra={!narrow && <span style={{ fontSize: 11, opacity: 0.65 }}>sellers (bid) × buyers (ask) · outlined = 3:1 diagonal imbalance · boxed = POC · wheel scrolls the page · Ctrl+wheel: bars shown · Shift+wheel: row height · drag or swipe: move back</span>}>
          {bars.length === 0
            ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? 'Loading…' : 'No trade yet today.'} />
            : <TickFootprintChart bars={bars} cvd={cvd} rowSize={rowSize} lotSize={lotSize} showLots={showLots} lastPrice={meta?.lastPrice} height={narrow ? 520 : 680} rowDelta={rowDelta} />}
        </Card>
      </Space>
    </div>
  )
}
