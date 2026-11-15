import { useEffect, useMemo, useRef } from 'react'
import { Card, Empty, Segmented, Space, Tag, Tooltip, Typography } from 'antd'
import { BaselineSeries, CandlestickSeries, CrosshairMode, HistogramSeries, LineSeries } from 'lightweight-charts'
import { createZoomableChart } from './chartZoom.js'
import { AXIS_COLOR, BORDER_COLOR, DOWN_COLOR, GRID_COLOR, UP_COLOR, istTickMarkFormatter, istTimeFormatter, toChartTime, usePersistedState } from './shared.jsx'
import { useFitContentAsDataGrows } from './oiShared.jsx'
import { FoldText } from './FoldText.jsx'
import { formatVolume } from './OrderFlowCharts.jsx'
import {
  OFI_TIMEFRAMES, POSITIONING, POSITIONING_KEYS, POSITIONING_TIMEFRAMES, ofiAgreement, ofiCandles, ofiRead, ofiSeries, positioningCandles, positioningRead,
  positioningSummary,
} from './flowTools.js'

// The Order Flow page's two cards on the futures' positioning and book flow (asked for - "delta + OI positioning on
// futures ... build these in separate card components"; the book pressure and liquidity added / pulled cards were replaced
// by the order flow imbalance on request - "book pressure also doesn't seem useful"). The reading
// is flowTools.js (pure, tested); these draw it at the page's clock - live, or the replay's. Reads only: they feed no
// strategy, alert or order.

const { Text } = Typography
const SERIES = { candles: CandlestickSeries, line: LineSeries, histogram: HistogramSeries, baseline: BaselineSeries }
const TONE_COLOR = (tone) => (tone > 0 ? UP_COLOR : tone < 0 ? DOWN_COLOR : undefined)
const price = (v) => (Number.isFinite(v) ? v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—')
const signedText = (v, format) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${format(Math.abs(v))}`

/** A chart of two panes sharing one time axis: `specs` - [{ key, type ('candles' | 'line' | 'histogram' | 'baseline'),
 *  pane (0 the upper), options }] (fixed for the chart's life) and `data` - { [key]: points } in chart time. `format`:
 *  the lower pane's numbers. */
function PaneChart({ specs, data, height, dayKey, format, stretch = [3, 2] }) {
  const containerRef = useRef(null)
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
    }
  }, [])
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

// ---- 2. Order flow imbalance at the touch --------------------------------------------------------------------------

const OFI_SPECS = [
  { key: 'candles', type: 'candles', pane: 0, options: { upColor: UP_COLOR, downColor: DOWN_COLOR, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR, borderVisible: false } },
  { key: 'ofi', type: 'histogram', pane: 1, options: { title: 'OFI', lastValueVisible: false } },
]
const OFI_RECENT = 5
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const NoBook = () => <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No order book for this day - it needs market depth, which only the days the server saw live have." />

/**
 * "Order flow imbalance": Cont, Kukanov & Stoikov's OFI at the best bid / offer (flowTools.ofiSeries) - every change at
 * the touch (orders taken, joined, stepped up / down, cancelled) as one signed number a candle, under the book's mid -
 * with how often it went with the price on this day, measured (`ofiAgreement`), and a read of the last candles.
 */
export function OfiCard({ view, rowSize, lotSize, showLots, dayKey, narrow, noDepth, isReplay, underlying }) {
  const [timeframe, setTimeframe] = usePersistedState('optionanalytics.orderFlow.ofiTf', 1)
  const tf = OFI_TIMEFRAMES.includes(timeframe) ? timeframe : 1
  const points = useMemo(() => (noDepth ? [] : ofiSeries(view?.heatmap, { rowSize })), [noDepth, view?.heatmap, rowSize])
  const candles = useMemo(() => ofiCandles(points, tf), [points, tf])
  const agreement = useMemo(() => ofiAgreement(candles), [candles])
  const read = useMemo(() => ofiRead(candles, { last: OFI_RECENT }), [candles])
  const format = useMemo(() => (q) => formatVolume(q, lotSize, showLots), [lotSize, showLots])
  const data = useMemo(() => ({
    candles: candles.map((c) => ({ time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close })),
    ofi: candles.map((c) => ({ time: toChartTime(c.time), value: c.ofi, color: c.ofi >= 0 ? UP_COLOR : DOWN_COLOR })),
  }), [candles])
  const last = candles.at(-1)
  const unit = showLots ? 'lots' : 'qty'
  const controls = <Segmented size="small" value={tf} onChange={setTimeframe} options={OFI_TIMEFRAMES.map((m) => ({ value: m, label: `${m}m` }))} />
  return (
    <Card size="small" title={`Order flow imbalance (OFI) · best bid / offer · ${tf} min`} extra={!narrow && controls}>
      {narrow && <div style={{ marginBottom: 8 }}>{controls}</div>}
      {noDepth ? <NoBook /> : !candles.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No book yet." /> : (
        <>
          <Space size={[20, 8]} wrap style={{ marginBottom: 4 }}>
            <Stat title={`${underlying} future${isReplay ? ' (replay)' : ''}`} value={price(last.close)} note="mid of the book" />
            <Stat title="Last candle" value={signedText(last.ofi, format)} color={TONE_COLOR(last.ofi)} note={`OFI, ${unit}`} />
            <Stat title={`Last ${OFI_RECENT} candles`} value={read ? signedText(read.ofi, format) : '—'} color={TONE_COLOR(read?.ofi)}
              note={read ? `price ${read.move > 0 ? '+' : ''}${read.move.toFixed(1)} pts` : null} />
            <Stat title="Day" value={signedText(last.cum, format)} color={TONE_COLOR(last.cum)} note="OFI since the first book" />
            <Tooltip title="Of this day's candles with both an OFI and a price move: how often their signs agreed in the same candle, and how often a candle's OFI matched the NEXT candle's move (near 50% = it says nothing ahead).">
              <div><Stat title="With the price" value={pct(agreement.together)} note={`same candle (${agreement.n}) · next ${pct(agreement.next)}`} /></div>
            </Tooltip>
          </Space>
          <Read read={read} />
          <PaneChart specs={OFI_SPECS} data={data} height={narrow ? 340 : 400} dayKey={`${dayKey}-ofi-${tf}`} format={format} />
          <FoldText id="orderFlow.ofi" label="how to read it" className="oa-note">
            <Text type="secondary" style={{ fontSize: 11 }}>
              Order flow imbalance (Cont, Kukanov &amp; Stoikov, 2014) adds up every change at the best bid and offer between two
              pictures of the book: bids joining or stepping up and offers being taken or pulled count as buying (+); offers joining
              or stepping down and bids being hit or pulled count as selling (−). It is the flow the tape&apos;s delta does not see -
              limit orders and cancels at the touch as well as trades - and in their study it explained most of the price&apos;s move
              over the same seconds to minutes. Green bars = buying flow in the candle, red = selling. Flow one way while the price
              does not follow = the other side keeps refilling (absorption). &quot;With the price&quot; is measured on this day: the
              share of candles whose OFI and move agreed, and how often it matched the next candle - a high &quot;same candle&quot;
              and a &quot;next&quot; near 50% means it describes the move, it does not forecast it. The book is sampled (every 2 s
              live, further apart on a loaded day), so a loaded day reads less than the same day seen live.
            </Text>
          </FoldText>
        </>
      )}
    </Card>
  )
}
