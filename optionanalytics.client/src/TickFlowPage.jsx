import { useEffect, useMemo, useState } from 'react'
import { Alert, Card, Checkbox, Empty, InputNumber, Segmented, Select, Space, Statistic, Tag, Tooltip, Typography } from 'antd'
import { NavBar, POLL_HEADERS, usePersistedState } from './shared.jsx'
import { FoldText } from './FoldText.jsx'
import { TickFootprintChart } from './TickFootprintChart.jsx'
import { TickBubbleChart } from './TickBubbleChart.jsx'
import { aggregateTickBars, cumulativeDelta, fmtQty } from './tickFlowMath.js'

const { Title } = Typography

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

function useTickDay(underlying, rowSize) {
  const key = `${underlying}|${rowSize}`
  const [held, setHeld] = useState({ key: null, day: null, error: null })
  const [status, setStatus] = useState(null)
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const [dayRes, statusRes] = await Promise.all([
          fetch(`/api/tick-flow/${underlying}?rowSize=${rowSize}&maxBubbles=8000`, { headers: POLL_HEADERS }),
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
    const timer = setInterval(load, POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [underlying, rowSize, key])
  const current = held.key === key ? held : { day: null, error: null }
  return { day: current.day, error: current.error, loading: held.key !== key, status }
}

export default function TickFlowPage() {
  const narrow = useNarrowScreen()
  const [underlying, setUnderlying] = usePersistedState('optionanalytics.tickFlow.underlying', 'NIFTY')
  const [rowSizes, setRowSizes] = usePersistedState('optionanalytics.tickFlow.rowSizes', DEFAULT_ROWS)
  const [timeframe, setTimeframe] = usePersistedState('optionanalytics.tickFlow.timeframe', 1)
  const [showLots, setShowLots] = usePersistedState('optionanalytics.tickFlow.showLots', true)
  const [rowDelta, setRowDelta] = usePersistedState('optionanalytics.tickFlow.rowDelta', false)
  const [minLots, setMinLots] = usePersistedState('optionanalytics.tickFlow.minLots', 1)
  const index = INDICES.includes(underlying) ? underlying : 'NIFTY'
  const rowSize = rowSizes?.[index] ?? DEFAULT_ROWS[index]
  const { day, error, loading, status } = useTickDay(index, rowSize)

  const meta = day?.meta
  const lotSize = meta?.lotSize ?? 1
  const bars = useMemo(() => aggregateTickBars(day?.bars ?? [], timeframe), [day?.bars, timeframe])
  const cvd = useMemo(() => cumulativeDelta(bars), [bars])
  const stream = status?.status?.streams?.find((s) => s.underlying === index)
  const feedState = status?.status?.state ?? status?.state ?? 'unknown'
  const off = status && status.enabled === false
  const total = cvd.at(-1) ?? 0

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
              <Segmented value={index} onChange={setUnderlying} options={INDICES} />
              <Select value={timeframe} onChange={setTimeframe} style={{ width: 110 }} options={[1, 3, 5, 15].map((v) => ({ value: v, label: `${v} min` }))} />
              <Select value={rowSize} onChange={(v) => setRowSizes({ ...(rowSizes ?? {}), [index]: v })} style={{ width: 120 }} options={ROW_OPTIONS} />
              <Tooltip title="The smallest order drawn as a bubble, in lots. 1 = every order; raise it on a busy day to see only the larger ones.">
                <span>Bubbles ≥ <InputNumber size="small" min={1} max={1000} value={minLots} onChange={(v) => setMinLots(v ?? 1)} style={{ width: 70 }} /> lots</span>
              </Tooltip>
              <Checkbox checked={showLots} onChange={(e) => setShowLots(e.target.checked)}>Lots</Checkbox>
              <Checkbox checked={rowDelta} onChange={(e) => setRowDelta(e.target.checked)}>Delta per row</Checkbox>
              <Tag color={feedState === 'streaming' ? 'green' : off ? 'default' : 'orange'}>TrueData: {off ? 'off' : feedState}</Tag>
              {stream && (
                <Tooltip title="TrueData numbers every tick: a count here means ticks were lost on the way to the server (their feed's own sequence number).">
                  <Tag color={stream.sequenceGaps > 0 ? 'red' : 'green'}>{stream.trades.toLocaleString()} trades · {stream.sequenceGaps} lost</Tag>
                </Tooltip>
              )}
            </Space>
            <FoldText id="tickFlowIntro" summary="What this page is and is not"
              text="Every trade arrives from TrueData with its own quantity and the best bid / ask, so the footprint is exact and a trade's side comes from the quote before it. The bubble chart draws every order where and when it traded: green bought at the ask, red sold at the bid, the size of the bubble following the size of the order (orders at one price within a second are one bubble). TrueData's NSE feed has only the best bid and ask - the grey band - not a deeper order book. The day lives in the server's memory, so a restart begins it again from the next tick. Nothing here places an order or feeds a strategy or alert." />
          </Space>
        </Card>

        {off && <Alert type="info" showIcon message="The TrueData live feed is off" description={status?.note ?? 'Set TrueData:Live:Enabled and the TrueData login (TrueData__UserId / TrueData__Password) on the server.'} />}
        {!off && error && <Alert type="warning" showIcon message={error} />}
        {status?.status?.error && !off && <Alert type="warning" showIcon message={`TrueData: ${status.status.error}`} />}

        {meta && (
          <Space size={24} wrap>
            <Statistic title={`${meta.symbol} last`} value={meta.lastPrice || '-'} />
            <Statistic title="Bid × Ask" value={meta.bid > 0 ? `${meta.bid} × ${meta.ask}` : '-'} />
            <Statistic title="Bid / ask size" value={meta.bid > 0 ? `${fmtQty(meta.bidQty, lotSize, showLots)} / ${fmtQty(meta.askQty, lotSize, showLots)}` : '-'} />
            <Statistic title={`Cumulative delta${showLots ? ' (lots)' : ''}`} value={fmtQty(total, lotSize, showLots)} valueStyle={{ color: total >= 0 ? '#52c41a' : '#ff4d4f' }} />
          </Space>
        )}

        <Card size="small" title="Order bubbles - price through time, a bubble at every order" extra={!narrow && <span style={{ fontSize: 11, opacity: 0.65 }}>wheel: zoom time · drag: move back · double-click: live · hover a bubble</span>}>
          {!day || day.bubbles.length === 0
            ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? 'Loading…' : off ? 'Turn the feed on to see the bubbles.' : 'No trade yet today - it starts with the first tick after the connection (market hours).'} />
            : <TickBubbleChart bubbles={day.bubbles} quotes={day.quotes} lastPrice={meta?.lastPrice} lotSize={lotSize} showLots={showLots} minLots={minLots} height={narrow ? 380 : 560} />}
        </Card>

        <Card size="small" title={`Footprint · ${timeframe} min · ${rowSize} pt rows`} extra={!narrow && <span style={{ fontSize: 11, opacity: 0.65 }}>sellers (bid) × buyers (ask) · outlined = 3:1 diagonal imbalance · boxed = POC · wheel: bars shown · drag: move back</span>}>
          {bars.length === 0
            ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? 'Loading…' : 'No trade yet today.'} />
            : <TickFootprintChart bars={bars} cvd={cvd} rowSize={rowSize} lotSize={lotSize} showLots={showLots} lastPrice={meta?.lastPrice} height={narrow ? 520 : 680} rowDelta={rowDelta} />}
        </Card>
      </Space>
    </div>
  )
}
