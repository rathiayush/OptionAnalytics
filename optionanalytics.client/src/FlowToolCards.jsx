import { useEffect, useMemo, useRef } from 'react'
import { Card, Empty, Segmented, Select, Space, Tag, Tooltip, Typography } from 'antd'
import { BaselineSeries, CandlestickSeries, CrosshairMode, HistogramSeries, LineSeries, createSeriesMarkers } from 'lightweight-charts'
import { createZoomableChart } from './chartZoom.js'
import { AXIS_COLOR, BORDER_COLOR, DOWN_COLOR, GRID_COLOR, UP_COLOR, istTickMarkFormatter, istTimeFormatter, toChartTime, usePersistedState } from './shared.jsx'
import { useFitContentAsDataGrows } from './oiShared.jsx'
import { FoldText } from './FoldText.jsx'
import { formatVolume } from './OrderFlowCharts.jsx'
import { PRESSURE_DEFAULTS, PRESSURE_TIMEFRAMES, pressureCandles, pressureRead } from './sellingPressure.js'
import {
  LIQUIDITY_BANDS, LIQUIDITY_BAND_DEFAULT, LIQUIDITY_FLOW_DEFAULTS, POSITIONING, POSITIONING_KEYS, POSITIONING_TIMEFRAMES, bucketFlow, liquidityFlow, liquidityRead, positioningCandles,
  positioningRead, positioningSummary,
} from './flowTools.js'

// The Order Flow page's two cards on the futures' positioning and book (asked for - "delta + OI positioning on futures
// ... net liquidity added versus pulled ... build these in separate card components"). The reading is flowTools.js
// (pure, tested); these draw it at the page's clock - live, or the replay's. Reads only: they feed no strategy, alert
// or order. (The BOOK PRESSURE and ORDER FLOW IMBALANCE cards that stood between them were REMOVED on request.)

const { Text } = Typography
const PRICE_COLOR = '#8ab4f8'
const SERIES = { candles: CandlestickSeries, line: LineSeries, histogram: HistogramSeries, baseline: BaselineSeries }
const TONE_COLOR = (tone) => (tone > 0 ? UP_COLOR : tone < 0 ? DOWN_COLOR : undefined)
const price = (v) => (Number.isFinite(v) ? v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—')
const signedText = (v, format) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${format(Math.abs(v))}`

/** A chart of two panes sharing one time axis: `specs` - [{ key, type ('candles' | 'line' | 'histogram' | 'baseline'),
 *  pane (0 the upper), options }] (fixed for the chart's life) and `data` - { [key]: points } in chart time. `format`:
 *  the lower pane's numbers. */
function PaneChart({ specs, data, height, dayKey, format, stretch = [3, 2], markers = null }) {
  const containerRef = useRef(null)
  const markersRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef({})
  const heightRef = useRef(height)
  const specsRef = useRef(specs)
  const stretchRef = useRef(stretch)
  const formatRef = useRef(format)
  useEffect(() => { formatRef.current = format })
  useEffect(() => {
    if (!containerRef.current) return undefined
    const chart = createZoomableChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: heightRef.current,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter, rightOffset: 4 },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    const lower = { type: 'custom', minMove: 0.01, formatter: (v) => (formatRef.current ? formatRef.current(v) : String(Math.round(v))) }
    for (const spec of specsRef.current) {
      seriesRef.current[spec.key] = chart.addSeries(SERIES[spec.type], { priceLineVisible: false, ...(spec.pane ? { priceFormat: lower } : {}), ...spec.options }, spec.pane ?? 0)
    }
    // Markers on the candles (the pressure card's swings and signals), when asked.
    if (seriesRef.current.candles) markersRef.current = createSeriesMarkers(seriesRef.current.candles, [])
    const [upper, under] = chart.panes()
    upper?.setStretchFactor(stretchRef.current[0])
    under?.setStretchFactor(stretchRef.current[1])
    const resize = new ResizeObserver(() => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) })
    resize.observe(containerRef.current)
    return () => {
      resize.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = {}
      markersRef.current = null
    }
  }, [])
  useEffect(() => { markersRef.current?.setMarkers(markers ?? []) }, [markers])
  // A new height is applied to the chart there is - drawn again it would have no data until the next update.
  useEffect(() => { chartRef.current?.applyOptions({ height }) }, [height])
  useEffect(() => {
    for (const [key, points] of Object.entries(data)) seriesRef.current[key]?.setData(points ?? [])
  }, [data])
  const length = Math.max(0, ...Object.values(data).map((points) => points?.length ?? 0))
  useFitContentAsDataGrows(chartRef, length, dayKey)
  return <div ref={containerRef} style={{ width: '100%', height }} />
}

const Stat = ({ title, value, note, color }) => (
  <div style={{ minWidth: 118 }}>
    <Text type="secondary" style={{ fontSize: 11 }}>{title}</Text>
    <div style={{ color, fontSize: 17, fontWeight: 600, lineHeight: 1.2 }}>{value}</div>
    {note && <Text type="secondary" style={{ fontSize: 11 }}>{note}</Text>}
  </div>
)

const Read = ({ read }) => (read ? (
  <div style={{ borderLeft: `3px solid ${TONE_COLOR(read.tone) ?? '#595959'}`, paddingLeft: 8, margin: '4px 0 6px', fontSize: 12 }}>{read.text}</div>
) : null)

// ---- 1. Delta + OI positioning ----------------------------------------------------------------------------------------

const POSITIONING_SPECS = [
  { key: 'candles', type: 'candles', pane: 0, options: { borderVisible: false } },
  { key: 'oi', type: 'histogram', pane: 1, options: { title: 'OI Δ', lastValueVisible: false } },
]
const RECENT_CANDLES = 6

/**
 * "Positioning": the futures candles coloured by WHO was aggressive and whether positions were OPENED or CLOSED - new
 * longs / short covering / new shorts / long liquidation (flowTools.positioningCandles) - with each candle's OI change
 * under it and what the day (and the last candles) add up to. `futuresOi` / `oiLag`: useDayOi's futures readings (the
 * NEAR futures' - `otherContract`: another contract is on the page, whose OI this is not).
 */
export function PositioningCard({ view, futuresOi, oiLag = 0, clockMs, isReplay, underlying, lotSize, showLots, dayKey, narrow, estimated, otherContract, oiError }) {
  const [timeframe, setTimeframe] = usePersistedState('optionanalytics.orderFlow.positioningTf', 5)
  const tf = POSITIONING_TIMEFRAMES.includes(timeframe) ? timeframe : 5
  // Live, the OI readings are folded into the same array as they come: read again every few seconds of the clock.
  const tick = Math.floor((clockMs ?? 0) / 5000)
  const candles = useMemo(
    () => (otherContract ? [] : positioningCandles(view?.minuteBars, futuresOi, { minutes: tf, lag: oiLag, clockMs: isReplay ? clockMs : null })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view?.minuteBars, futuresOi, oiLag, tf, isReplay, tick, otherContract],
  )
  const format = useMemo(() => (q) => formatVolume(q, lotSize, showLots), [lotSize, showLots])
  const day = useMemo(() => positioningSummary(candles), [candles])
  const recent = useMemo(() => positioningSummary(candles, RECENT_CANDLES), [candles])
  const data = useMemo(() => ({
    candles: candles.map((c) => {
      const color = POSITIONING[c.kind].color
      return { time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close, color, borderColor: color, wickColor: color }
    }),
    oi: candles.filter((c) => c.dOi != null).map((c) => ({ time: toChartTime(c.time), value: c.dOi, color: POSITIONING[c.kind].color })),
  }), [candles])
  const last = candles.at(-1)
  const hasOi = candles.some((c) => c.dOi != null)
  const unit = showLots ? 'lots' : 'qty'
  const controls = <Segmented size="small" value={tf} onChange={setTimeframe} options={POSITIONING_TIMEFRAMES.map((m) => ({ value: m, label: `${m}m` }))} />
  return (
    <Card size="small" title={`Positioning · delta + futures OI · ${tf} min`} extra={!narrow && controls}>
      {narrow && <div style={{ marginBottom: 8 }}>{controls}</div>}
      {otherContract ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="The futures OI here is the nearest contract's - pick the nearest contract to read its positioning." />
      ) : !candles.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No futures candles yet." />
      ) : (
        <>
          <Space size={[20, 8]} wrap style={{ marginBottom: 4 }}>
            <div style={{ minWidth: 150 }}>
              <Text type="secondary" style={{ fontSize: 11 }}>{underlying} future · last candle{isReplay ? ' (replay)' : ''}</Text>
              <div><Tag color={POSITIONING[last.kind].color} style={{ color: '#111', fontWeight: 600, marginTop: 2 }}>{POSITIONING[last.kind].label}</Tag></div>
              <Text type="secondary" style={{ fontSize: 11 }}>Δ {signedText(last.delta, format)} · OI {last.dOi == null ? '—' : signedText(last.dOi, format)}</Text>
            </div>
            {POSITIONING_KEYS.map((key) => (
              <Stat key={key} title={POSITIONING[key].label} color={POSITIONING[key].color} value={format(day.by[key].delta)}
                note={`${day.by[key].candles} candles · last ${RECENT_CANDLES}: ${format(recent.by[key].delta)}`} />
            ))}
          </Space>
          <Read read={positioningRead(day)} />
          {recent.lead && recent.lead !== day.lead && (
            <Text type="secondary" style={{ display: 'block', fontSize: 11, marginBottom: 4 }}>
              The last {RECENT_CANDLES} candles: mostly {POSITIONING[recent.lead].label.toLowerCase()} - not what led the day.
            </Text>
          )}
          {!hasOi && <Text type="warning" style={{ display: 'block', fontSize: 11, marginBottom: 4 }}>No futures OI reading yet{oiError ? ` (${oiError})` : ''} - the candles show the delta only.</Text>}
          {estimated && <Text type="warning" style={{ display: 'block', fontSize: 11, marginBottom: 4 }}>This day&apos;s delta is estimated from 1-minute candles, so the aggressor side is an estimate too.</Text>}
          <div style={{ fontSize: 11, marginBottom: 4, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {[...POSITIONING_KEYS, 'balanced', 'none'].map((key) => (
              <Tooltip key={key} title={POSITIONING[key].text}><span><span style={{ color: POSITIONING[key].color }}>■</span> {POSITIONING[key].label}</span></Tooltip>
            ))}
            <Text type="secondary" style={{ fontSize: 11 }}>numbers = delta done under each read, in {unit}</Text>
          </div>
          <PaneChart specs={POSITIONING_SPECS} data={data} height={narrow ? 380 : 460} dayKey={`${dayKey}-pos-${tf}`} format={format} />
          <FoldText id="orderFlow.positioning" label="how to read it" className="oa-note">
            <Text type="secondary" style={{ fontSize: 11 }}>
              Each candle is coloured by its aggressor delta (buy − sell volume) together with the change in the futures&apos; open
              interest over it. Buyers aggressive with OI rising = NEW LONGS (fresh buying - a move on new positions tends to continue);
              with OI falling = SHORT COVERING (shorts buying back - tends to fade once they are out). Sellers aggressive with OI
              rising = NEW SHORTS; with OI falling = LONG LIQUIDATION. A candle whose delta is under 5% of its volume is balanced; one
              with no OI change has no read. The bars under the candles are each candle&apos;s OI change. The futures chart&apos;s OI
              regimes read price with OI; this reads who was the aggressor. Dhan&apos;s OI updates in steps, so 1-minute candles are
              noisy - 5 minutes and up read better.
            </Text>
          </FoldText>
        </>
      )}
    </Card>
  )
}

// ---- 2. Liquidity added vs pulled --------------------------------------------------------------------------------

const BUCKET_SECONDS = 10
const WINDOWS = [1, 2, 5, 10, 15]
const priceLine = { key: 'price', type: 'line', pane: 0, options: { color: PRICE_COLOR, lineWidth: 2, title: 'price' } }

const useFlow = (view, rowSize, noDepth, bandRows = LIQUIDITY_FLOW_DEFAULTS.bandRows) => useMemo(
  () => (noDepth ? [] : liquidityFlow(view?.heatmap, { rowSize, bandRows })),
  [noDepth, view?.heatmap, rowSize, bandRows],
)
const NoBook = () => <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No order book for this day - it needs market depth, which only the days the server saw live have." />
const LIQUIDITY_SPECS = [
  priceLine,
  { key: 'bids', type: 'line', pane: 1, options: { color: UP_COLOR, lineWidth: 2, title: 'bids' } },
  { key: 'offers', type: 'line', pane: 1, options: { color: DOWN_COLOR, lineWidth: 2, title: 'offers' } },
]

/**
 * "Liquidity added vs pulled": resting orders ADDED less orders PULLED (cancelled away from the touch), a running line
 * for the bids and one for the offers from the day's first book column (flowTools.liquidityFlow's `cumBid` / `cumAsk`) -
 * the trend the single PULL / STACK signals come from: a rise with the offers being pulled is not a rise into offers
 * being stacked.
 */
export function LiquidityNetCard({ view, rowSize, lotSize, showLots, dayKey, narrow, noDepth, isReplay, underlying }) {
  const [windowMin, setWindowMin] = usePersistedState('optionanalytics.orderFlow.liquidityNetWindow', 5)
  const win = WINDOWS.includes(windowMin) ? windowMin : 5
  const [bandRows, setBandRows] = usePersistedState('optionanalytics.orderFlow.liquidityNetBand', LIQUIDITY_BAND_DEFAULT)
  const band = LIQUIDITY_BANDS.includes(bandRows) ? bandRows : LIQUIDITY_BAND_DEFAULT
  const flow = useFlow(view, rowSize, noDepth, band)
  const format = useMemo(() => (q) => formatVolume(q, lotSize, showLots), [lotSize, showLots])
  const data = useMemo(() => {
    const buckets = bucketFlow(flow, BUCKET_SECONDS)
    return {
      price: buckets.map((b) => ({ time: toChartTime(b.t), value: b.mid })),
      bids: buckets.map((b) => ({ time: toChartTime(b.t), value: b.cumBid })),
      offers: buckets.map((b) => ({ time: toChartTime(b.t), value: b.cumAsk })),
    }
  }, [flow])
  const read = useMemo(() => liquidityRead(flow, { windowMin: win }), [flow, win])
  const unit = showLots ? 'lots' : 'qty'
  const points = (rows) => Math.round(rows * rowSize * 100) / 100
  const controls = (
    <Space size={8} wrap>
      <Tooltip title="How far from the best bid / offer orders are counted">
        <Select size="small" value={band} style={{ width: 140 }} onChange={setBandRows} options={LIQUIDITY_BANDS.map((v) => ({ value: v, label: `within ${points(v)} pts` }))} />
      </Tooltip>
      <Tooltip title="The read and the numbers count what was added and pulled over this many minutes">
        <Select size="small" value={win} style={{ width: 96 }} onChange={setWindowMin} options={WINDOWS.map((v) => ({ value: v, label: `last ${v}m` }))} />
      </Tooltip>
    </Space>
  )
  return (
    <Card size="small" title={`Liquidity added vs pulled · ${unit}, away from the touch`} extra={!narrow && controls}>
      {narrow && <div style={{ marginBottom: 8 }}>{controls}</div>}
      {noDepth ? <NoBook /> : !flow.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No book yet." /> : (
        <>
          <Space size={[20, 8]} wrap style={{ marginBottom: 4 }}>
            <Stat title={`${underlying} future${isReplay ? ' (replay)' : ''}`} value={price(flow.at(-1).mid)} note="mid of the book" />
            <Stat title={`Bids · last ${win} min`} value={read ? signedText(read.bidNet, format) : '—'} color={TONE_COLOR(read?.bidNet)}
              note={read ? `added ${format(read.bidAdded)} · pulled ${format(read.bidPulled)}` : null} />
            <Stat title={`Offers · last ${win} min`} value={read ? signedText(read.askNet, format) : '—'} color={TONE_COLOR(-(read?.askNet ?? 0))}
              note={read ? `added ${format(read.askAdded)} · pulled ${format(read.askPulled)}` : null} />
            <Stat title="Since the first book" value={`${signedText(flow.at(-1).cumBid, format)} / ${signedText(flow.at(-1).cumAsk, format)}`} note="bids / offers, net" />
          </Space>
          <Read read={read} />
          <PaneChart specs={LIQUIDITY_SPECS} data={data} height={narrow ? 340 : 400} dayKey={`${dayKey}-liq`} format={format} />
          <FoldText id="orderFlow.liquidityNet" label="how to read it" className="oa-note">
            <Text type="secondary" style={{ fontSize: 11 }}>
              Between two pictures of the book, at the rows that stayed away from the best bid / offer in both (up
              to {points(band)} pts out) nothing can have traded - so a rise there is orders ADDED and a drop is
              orders PULLED (cancelled). The lower lines add that up from the day&apos;s first book: green = the bids (rising = support
              being built under the price, falling = support withdrawn), red = the offers (rising = resistance being built, falling =
              resistance withdrawn). A rise with the offers falling has its way cleared; a rise into rising offers is being sold into.
              The book is sampled (every 2 s live, further apart on a loaded day), so orders added and pulled again between two
              samples are not seen - the lines are a floor, and a loaded day reads smaller than the same day seen live.
            </Text>
          </FoldText>
        </>
      )}
    </Card>
  )
}

// ---- 4. Order flow imbalance at the touch --------------------------------------------------------------------------


// ---- 3. Pressure at the lows / highs ----------------------------------------------------------------------------------

const PRESSURE_SPECS = [
  { key: 'candles', type: 'candles', pane: 0, options: { upColor: UP_COLOR, downColor: DOWN_COLOR, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR, borderVisible: false } },
  { key: 'pressure', type: 'histogram', pane: 1, options: { title: 'buy − sell % of volume', lastValueVisible: false } },
]
const pctText = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—')
const STATUS = { pending: '', confirmed: ' ✓', failed: ' ✗' }
const STATUS_TEXT = { pending: 'pending', confirmed: 'confirmed - closed past the swing between them', failed: 'failed - traded past the later extreme' }

/**
 * "Pressure at the lows" (sellingPressure.js - asked for: "compare selling pressure relative to total traded volume, then
 * the price response, and when the subsequent low has weaker normalised selling pressure and claims back the previous
 * low, interest is on the buying side"): the futures' candles with each swing low labelled by the SELLING share of the
 * push into it (each swing high by the BUYING share), BUYING INTEREST / SELLING INTEREST marked where a later low (high)
 * came on weaker pressure and the earlier one was claimed back, each candle's buy − sell share under them, and a table
 * comparing the lows and the highs - pressure, how far price went, how far per 100 lots. At the page's clock.
 */
export function PressureCard({ view, clockMs, isReplay, underlying, lotSize, showLots, dayKey, narrow, estimated }) {
  const [timeframe, setTimeframe] = usePersistedState('optionanalytics.orderFlow.pressureTf', PRESSURE_DEFAULTS.minutes)
  const tf = PRESSURE_TIMEFRAMES.includes(timeframe) ? timeframe : PRESSURE_DEFAULTS.minutes
  // Live only the completed candles count - read again as the clock passes each minute.
  const minute = Math.floor((clockMs ?? 0) / 60000)
  const candles = useMemo(() => pressureCandles(view?.minuteBars, tf, clockMs), // eslint-disable-next-line react-hooks/exhaustive-deps
    [view?.minuteBars, tf, minute])
  const read = useMemo(() => pressureRead(candles), [candles])
  const lot = lotSize > 0 ? lotSize : 1
  const perHundred = (leg) => (leg.side > 0 ? (leg.move / (leg.side / lot)) * 100 : null)
  const data = useMemo(() => ({
    candles: candles.map((c) => ({ time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close })),
    pressure: candles.filter((c) => c.buy + c.sell > 0).map((c) => {
      const v = ((c.buy - c.sell) / (c.buy + c.sell)) * 100
      return { time: toChartTime(c.time), value: v, color: v >= 0 ? 'rgba(38,166,154,0.7)' : 'rgba(239,83,80,0.7)' }
    }),
  }), [candles])
  const markers = useMemo(() => {
    const out = []
    for (const s of read.swings) {
      const low = s.kind === 'low'
      out.push({ time: toChartTime(candles[s.index].time), position: low ? 'belowBar' : 'aboveBar', shape: 'circle', size: 0.5,
        color: low ? 'rgba(239,83,80,0.85)' : 'rgba(38,166,154,0.85)', text: `${low ? 'S' : 'B'} ${pctText(s.leg.pressure)}` })
    }
    for (const g of read.signals) {
      const buy = g.kind === 'buying'
      out.push({ time: toChartTime(candles[g.at].time), position: buy ? 'belowBar' : 'aboveBar', shape: buy ? 'arrowUp' : 'arrowDown', size: 1.4,
        color: buy ? UP_COLOR : DOWN_COLOR, text: `${buy ? 'BUY' : 'SELL'} INTEREST${STATUS[g.status]}` })
    }
    return out.sort((a, b) => a.time - b.time)
  }, [read, candles])
  const latest = read.signals.at(-1) ?? null
  const rows = (kind) => {
    const xs = read.swings.filter((s) => s.kind === kind).slice(-4)
    return xs.map((s, i) => {
      const prev = i > 0 ? xs[i - 1] : null
      const vs = prev?.leg.pressure != null && s.leg.pressure != null ? s.leg.pressure - prev.leg.pressure : null
      return { s, vs }
    })
  }
  const controls = <Segmented size="small" value={tf} onChange={setTimeframe} options={PRESSURE_TIMEFRAMES.map((m) => ({ value: m, label: `${m}m` }))} />
  const Table = ({ kind }) => {
    const low = kind === 'low'
    const list = rows(kind)
    if (!list.length) return <Text type="secondary" style={{ fontSize: 11 }}>No swing {kind} yet.</Text>
    return (
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
          <thead><tr style={{ color: '#8c8c8c' }}>
            <th style={{ textAlign: 'left', padding: '2px 6px' }}>Swing {kind}</th>
            <th style={{ textAlign: 'right', padding: '2px 6px' }}>{low ? 'Selling' : 'Buying'} share</th>
            <th style={{ textAlign: 'right', padding: '2px 6px' }}>vs before</th>
            <th style={{ textAlign: 'right', padding: '2px 6px' }}>{low ? 'Fell' : 'Rose'}</th>
            <th style={{ textAlign: 'right', padding: '2px 6px' }}>pts / 100 lots</th>
          </tr></thead>
          <tbody>
            {list.map(({ s, vs }) => (
              <tr key={s.index}>
                <td style={{ padding: '2px 6px' }}>{price(s.price)} <Text type="secondary" style={{ fontSize: 10 }}>{istTimeFormatter(toChartTime(candles[s.index].time))}</Text></td>
                <td style={{ textAlign: 'right', padding: '2px 6px', color: low ? DOWN_COLOR : UP_COLOR }}>{pctText(s.leg.pressure)}</td>
                <td style={{ textAlign: 'right', padding: '2px 6px', color: vs == null ? undefined : vs < 0 ? (low ? UP_COLOR : DOWN_COLOR) : undefined }}>
                  {vs == null ? '—' : `${vs > 0 ? '+' : vs < 0 ? '−' : ''}${Math.abs(Math.round(vs * 100))} pts ${vs < 0 ? 'weaker' : vs > 0 ? 'stronger' : ''}`}
                </td>
                <td style={{ textAlign: 'right', padding: '2px 6px' }}>{price(s.leg.move)}</td>
                <td style={{ textAlign: 'right', padding: '2px 6px' }}>{perHundred(s.leg) == null ? '—' : price(Math.round(perHundred(s.leg) * 100) / 100)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }
  return (
    <Card size="small" title={`Pressure at the lows / highs · ${tf} min`} extra={!narrow && controls}>
      {narrow && <div style={{ marginBottom: 8 }}>{controls}</div>}
      {!candles.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No completed futures candles yet." />
      ) : (
        <>
          {latest ? (
            <Read read={{ tone: latest.kind === 'buying' ? 1 : -1, text: `${istTimeFormatter(toChartTime(latest.time))} · ${latest.text} · ${STATUS_TEXT[latest.status]}` }} />
          ) : (
            <Text type="secondary" style={{ display: 'block', fontSize: 12, margin: '4px 0 6px' }}>
              {underlying} future{isReplay ? ' (replay)' : ''}: no buying / selling interest read yet - it needs two swing lows (highs), the later on weaker pressure, and the earlier one claimed back.
            </Text>
          )}
          {read.signals.length > 1 && (
            <Text type="secondary" style={{ display: 'block', fontSize: 11, marginBottom: 4 }}>
              Today: {read.signals.map((g) => `${istTimeFormatter(toChartTime(g.time))} ${g.kind === 'buying' ? '▲' : '▼'}${STATUS[g.status]}`).join(' · ')}
            </Text>
          )}
          {estimated && <Text type="warning" style={{ display: 'block', fontSize: 11, marginBottom: 4 }}>This day&apos;s buy / sell split is estimated from 1-minute candles, so the pressure is an estimate too.</Text>}
          <PaneChart specs={PRESSURE_SPECS} data={data} markers={markers} height={narrow ? 380 : 460} dayKey={`${dayKey}-pressure-${tf}`} format={(v) => `${Math.round(v)}%`} />
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 6 }}>
            <div style={{ flex: '1 1 320px', minWidth: 0 }}><Table kind="low" /></div>
            <div style={{ flex: '1 1 320px', minWidth: 0 }}><Table kind="high" /></div>
          </div>
          <Text type="secondary" style={{ display: 'block', fontSize: 11, marginTop: 4 }}>
            {showLots ? 'Volumes in lots' : 'Volumes in quantity'}; pts / 100 lots = how far price went per 100 lots of the side pushing it.
          </Text>
          <FoldText id="orderFlow.pressure" label="how to read it" className="oa-note">
            <Text type="secondary" style={{ fontSize: 11 }}>
              Effort vs result. For each swing low, the push into it is measured from the highest point since the swing low before:
              the SELLING SHARE is the aggressor sell volume of that push divided by ALL the volume traded in it (normalised, so a
              busy and a quiet push compare), and the PRICE RESPONSE is how far it fell, in points and per 100 lots sold. BUYING
              INTEREST is marked when a LATER low reaches the earlier one (at or under it) on a selling share at least 5 points
              WEAKER, and price then closes back above the earlier low within 6 candles - the sellers could not keep the new low,
              the buyers took it back. It is CONFIRMED once a candle closes over the bounce high between the two lows, FAILED once
              price trades under the later low. SELLING INTEREST is the mirror at the highs (a later high on a weaker buying share,
              the earlier high lost again). A swing is known only 2 candles after it, and only completed candles count - nothing
              after the clock is read. The bars under the candles: each candle&apos;s buy − sell in % of its volume.
            </Text>
          </FoldText>
        </>
      )}
    </Card>
  )
}
