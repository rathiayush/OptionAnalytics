import { useEffect, useMemo, useState } from 'react'
import { Alert, Card, Checkbox, Empty, Segmented, Select, Space, Statistic, Tag, Tooltip, Typography } from 'antd'
import { NavBar, POLL_HEADERS, usePersistedState } from './shared.jsx'
import { aggregateBars, analyzeBars } from './orderFlowMath.js'
import { orderFlowFromSnapshot } from './liveFeeds.js'
import { CumulativeDeltaChart, DepthHeatmap, FootprintChart, formatVolume } from './OrderFlowCharts.jsx'
import { useNarrow } from './DomDrawer.jsx'
import { FoldText } from './FoldText.jsx'

const { Title } = Typography

// TICK FLOW - the Order Flow footprint and the book trail built from TrueData's real-time TICK feed (TrueDataLiveFeed on the
// server, TrueData:Live:Enabled), NIFTY and BANKNIFTY near futures. The charts are the Order Flow page's own components; only the
// source differs: a "trade" message per trade with ITS OWN quantity and the best bid / ask in the same packet (so a trade's side
// comes from the quote before it, not from a guess at a once-a-second snapshot), a sequence number that proves no tick was lost,
// and the day kept in the server's memory. NSE depth beyond level 1 is not in TrueData's feed: the "heatmap" here is the best bid /
// ask trail (one level a side), not a 20 / 200-level book. It places nothing and feeds no strategy or alert.

const INDICES = ['NIFTY', 'BANKNIFTY']
const DEFAULT_ROWS = { NIFTY: 1, BANKNIFTY: 5 }
const ROW_OPTIONS = [0.5, 1, 2, 5, 10, 20].map((v) => ({ value: v, label: `${v} pt row` }))
const POLL_MS = 2000

function useTickFlow(underlying, rowSize) {
  const key = `${underlying}|${rowSize}`
  const [held, setState] = useState({ key: null, view: null, error: null })
  const [status, setStatus] = useState(null)
  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const [flowRes, statusRes] = await Promise.all([
          fetch(`/api/tick-flow/${underlying}?rowSize=${rowSize}&heatmapColumns=900`, { headers: POLL_HEADERS }),
          fetch('/api/tick-flow/status', { headers: POLL_HEADERS }),
        ])
        const statusBody = statusRes.ok ? await statusRes.json() : null
        if (!alive) return
        setStatus(statusBody)
        if (!flowRes.ok) {
          const body = await flowRes.json().catch(() => null)
          setState({ key, view: null, error: body?.error ?? `HTTP ${flowRes.status}` })
          return
        }
        setState({ key, view: orderFlowFromSnapshot(await flowRes.json()), error: null })
      } catch (e) {
        if (alive) setState((s) => ({ ...s, key, error: String(e?.message ?? e) }))
      }
    }
    load()
    const timer = setInterval(load, POLL_MS)
    return () => { alive = false; clearInterval(timer) }
  }, [underlying, rowSize, key])
  // What was loaded for another index / row size is not shown for this one.
  const state = held.key === key ? { ...held, loading: false } : { view: null, error: null, loading: true }
  return { ...state, status }
}

export default function TickFlowPage() {
  const narrow = useNarrow()
  const [underlying, setUnderlying] = usePersistedState('optionanalytics.tickFlow.underlying', 'NIFTY')
  const [rowSizes, setRowSizes] = usePersistedState('optionanalytics.tickFlow.rowSizes', DEFAULT_ROWS)
  const [timeframe, setTimeframe] = usePersistedState('optionanalytics.tickFlow.timeframe', 1)
  const [showLots, setShowLots] = usePersistedState('optionanalytics.tickFlow.showLots', true)
  const [rowDelta, setRowDelta] = usePersistedState('optionanalytics.tickFlow.rowDelta', false)
  const index = INDICES.includes(underlying) ? underlying : 'NIFTY'
  const rowSize = rowSizes?.[index] ?? DEFAULT_ROWS[index]
  const { view, error, loading, status } = useTickFlow(index, rowSize)

  const meta = view?.meta
  const lotSize = meta?.lotSize ?? 1
  const bars = useMemo(
    () => analyzeBars(aggregateBars(view?.minuteBars ?? [], timeframe), { rowSize, minVolume: lotSize }),
    [view?.minuteBars, timeframe, rowSize, lotSize],
  )
  const bigLots = 100
  const largeTrades = useMemo(() => (view?.trades ?? []).filter((t) => t.quantity >= bigLots * lotSize), [view?.trades, bigLots, lotSize])
  const stream = status?.status?.streams?.find((s) => s.underlying === index)
  const feedState = status?.status?.state ?? status?.state ?? 'unknown'
  const off = status && status.enabled === false
  const lastBar = bars.at(-1)
  const cvd = lastBar?.cvd ?? 0
  const dayKey = String(view?.minuteBars?.[0]?.time ?? 'day').slice(0, 10)

  return (
    <div className="oa-of-page" style={{ maxWidth: 2600, margin: '0 auto', padding: narrow ? '16px 8px 120px' : '24px 16px 120px' }}>
      <Space direction="vertical" size={14} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>

        <Card size="small" title="Tick Flow - footprint and best bid / ask from TrueData's tick feed">
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Space wrap size={[12, 8]}>
              <Segmented value={index} onChange={setUnderlying} options={INDICES} />
              <Select value={timeframe} onChange={setTimeframe} style={{ width: 110 }} options={[1, 3, 5, 15].map((v) => ({ value: v, label: `${v} min` }))} />
              <Select value={rowSize} onChange={(v) => setRowSizes({ ...(rowSizes ?? {}), [index]: v })} style={{ width: 120 }} options={ROW_OPTIONS} />
              <Checkbox checked={showLots} onChange={(e) => setShowLots(e.target.checked)}>Lots</Checkbox>
              <Checkbox checked={rowDelta} onChange={(e) => setRowDelta(e.target.checked)}>Delta per row</Checkbox>
              <Tag color={feedState === 'streaming' ? 'green' : off ? 'default' : 'orange'}>TrueData: {off ? 'off' : feedState}</Tag>
              {stream && (
                <Tooltip title="TrueData numbers every tick: a gap here means ticks were lost on the way to the server (their feed's own sequence number).">
                  <Tag color={stream.sequenceGaps > 0 ? 'red' : 'green'}>{stream.trades.toLocaleString()} trades · {stream.sequenceGaps} lost</Tag>
                </Tooltip>
              )}
            </Space>
            <FoldText id="tickFlowIntro" summary="What this page is and is not"
              text="The footprint and delta are built from TrueData's real-time ticks: every trade arrives with its own quantity and the best bid / ask in the same message, so a trade's side comes from the quote before it - no guess at a once-a-second snapshot. The day lives in the server's memory (a restart starts it again from the next tick). TrueData's NSE feed has only the best bid and ask (level 1): the second chart is that trail over time, not a 20 / 200-level order book - that stays on the Order Flow page (Dhan). Nothing here places an order or feeds a strategy or alert." />
          </Space>
        </Card>

        {off && <Alert type="info" showIcon message="The TrueData live feed is off" description={status?.note ?? 'Set TrueData:Live:Enabled and the TrueData login (TrueData__UserId / TrueData__Password) on the server.'} />}
        {!off && error && <Alert type="warning" showIcon message={error} />}
        {status?.status?.error && !off && <Alert type="warning" showIcon message={`TrueData: ${status.status.error}`} />}

        {meta && (
          <Space size={24} wrap>
            <Statistic title={`${meta.contractSymbol ?? index} last`} value={meta.lastPrice ?? '-'} />
            <Statistic title="Bid × Ask" value={stream && stream.bid > 0 ? `${stream.bid} × ${stream.ask}` : '-'} />
            <Statistic title="Bid / ask size" value={stream && stream.bid > 0 ? `${formatVolume(stream.bidQty, lotSize, showLots)} / ${formatVolume(stream.askQty, lotSize, showLots)}` : '-'} />
            <Statistic title={`Cumulative delta${showLots ? ' (lots)' : ''}`} value={formatVolume(cvd, lotSize, showLots)} valueStyle={{ color: cvd >= 0 ? '#52c41a' : '#ff4d4f' }} />
          </Space>
        )}

        <Card size="small" title={`Footprint · ${timeframe} min · ${rowSize} pt rows`}>
          {bars.length === 0
            ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={loading ? 'Loading…' : off ? 'Turn the feed on to see the footprint.' : 'No trade yet today - the footprint starts with the first tick after the connection (market hours).'} />
            : <FootprintChart bars={bars} rowSize={rowSize} lotSize={lotSize} showLots={showLots} lastPrice={meta?.lastPrice} height={narrow ? 480 : 660}
                trades={largeTrades} timeframe={timeframe} rowDelta={rowDelta} auctions cot />}
        </Card>

        <Card size="small" title="Best bid / ask trail (level 1 - TrueData has no deeper NSE book)">
          {(view?.heatmap?.length ?? 0) === 0
            ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing yet." />
            : <DepthHeatmap columns={view.heatmap} rowSize={rowSize} trades={largeTrades} icebergs={[]} signals={[]} marks={[]} lotSize={lotSize} showLots={showLots}
                height={narrow ? 320 : 440} volumeBars={view.minuteBars} showCob classicColours={false} />}
        </Card>

        <Card size="small" title="Cumulative delta">
          {bars.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing yet." />
            : <CumulativeDeltaChart bars={bars} dayKey={dayKey} lotSize={lotSize} showLots={showLots} height={narrow ? 200 : 260} />}
        </Card>
      </Space>
    </div>
  )
}
