import { useEffect, useMemo, useRef, useState } from 'react'
import { Card, Empty, Segmented, Select, Space, Tooltip, Typography } from 'antd'
import { CandlestickSeries, CrosshairMode } from 'lightweight-charts'
import { createZoomableChart } from './chartZoom.js'
import { AXIS_COLOR, BORDER_COLOR, DOWN_COLOR, GRID_COLOR, UP_COLOR, istTickMarkFormatter, istTimeFormatter, toChartTime, usePersistedState } from './shared.jsx'
import { useChartUserControl } from './oiShared.jsx'
import { FoldText } from './FoldText.jsx'
import { formatVolume } from './OrderFlowCharts.jsx'
import { LADDER_ROWS, LADDER_ROW_CHOICES, LADDER_WINDOWS, ROWS_EACH, bookLadder, ladderRow, ladderRowAt } from './bookLadder.js'
import { BookLadderPrimitive, LADDER_SHARE, LADDER_SHARE_NARROW } from './bookLadderPrimitive.js'

const { Text } = Typography
const TIMEFRAMES = [1, 3, 5, 15]
// Candles shown when the chart opens (the newest ones), beside the ladder - the whole day is a drag / zoom away.
const OPEN_CANDLES = 70
const OPEN_CANDLES_NARROW = 36
const price = (v) => (Number.isFinite(v) ? v.toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—')

function candlesOf(minuteBars, minutes) {
  const size = Math.max(1, minutes) * 60
  const out = []
  for (const b of minuteBars ?? []) {
    if (!(b.open > 0)) continue
    const t = Math.floor(toChartTime(b.time) / size) * size
    const last = out.at(-1)
    if (last?.time === t) { last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close } else out.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close })
  }
  return out
}

function BookChart({ candles, ladder, format, dayKey, narrow, onHover }) {
  const height = narrow ? 460 : 560
  const share = narrow ? LADDER_SHARE_NARROW : LADDER_SHARE
  const heightRef = useRef(height)
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const primitiveRef = useRef(null)
  const linesRef = useRef([])
  const rangeRef = useRef(null)
  const hoverRef = useRef(onHover)
  useEffect(() => { hoverRef.current = onHover })
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
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR,
      // The prices hold the ladder's rows near the price too - not just the candles shown.
      autoscaleInfoProvider: (original) => {
        const base = original()
        const r = rangeRef.current
        if (!r) return base
        return { ...(base ?? {}), priceRange: { minValue: Math.min(base?.priceRange?.minValue ?? r.low, r.low), maxValue: Math.max(base?.priceRange?.maxValue ?? r.high, r.high) } }
      },
    })
    seriesRef.current = series
    const primitive = new BookLadderPrimitive()
    primitiveRef.current = primitive
    series.attachPrimitive(primitive)
    chart.subscribeCrosshairMove((param) => {
      const p = param?.point ? series.coordinateToPrice(param.point.y) : null
      hoverRef.current?.(Number.isFinite(p) ? p : null)
    })
    const resize = new ResizeObserver(() => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) })
    resize.observe(containerRef.current)
    return () => {
      resize.disconnect()
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      primitiveRef.current = null
      linesRef.current = []
    }
  }, [])
  // A phone turned / the window narrowed: the new height on the chart there is (drawn again it would have no data).
  useEffect(() => { chartRef.current?.applyOptions({ height }) }, [height])
  const userControlRef = useChartUserControl(chartRef, dayKey)
  useEffect(() => {
    seriesRef.current?.setData(candles)
  }, [candles])
  // The newest candles beside the ladder (its share of the plot left empty on the right), until the viewer drags /
  // zooms; again for each new candle.
  const n = candles.length
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || !n || userControlRef.current) return
    const k = Math.min(n, narrow ? OPEN_CANDLES_NARROW : OPEN_CANDLES)
    const offset = Math.round((k * share) / (1 - share)) + 2
    chart.timeScale().applyOptions({ rightOffset: offset })
    chart.timeScale().setVisibleLogicalRange({ from: n - k - 0.5, to: n - 1 + offset })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, dayKey, share])
  useEffect(() => {
    primitiveRef.current?.setLadder(ladder, format, share)
    const range = ladder ? { low: ladder.priceRow - ROWS_EACH * ladder.row, high: ladder.priceRow + (ROWS_EACH + 1) * ladder.row } : null
    const old = rangeRef.current
    rangeRef.current = range
    if ((old?.low !== range?.low || old?.high !== range?.high) && !userControlRef.current) chartRef.current?.priceScale('right').applyOptions({ autoScale: true })
    // The nearest big buyers / sellers on the price axis too.
    const series = seriesRef.current
    if (!series) return
    for (const line of linesRef.current) series.removePriceLine(line)
    linesRef.current = []
    // No caption on the lines: it is drawn inside the plot, over the ladder's rows - the header names them.
    if (ladder?.buyers) linesRef.current.push(series.createPriceLine({ price: ladder.buyers.hi, color: UP_COLOR, lineWidth: 1, lineStyle: 2, axisLabelVisible: true }))
    if (ladder?.sellers) linesRef.current.push(series.createPriceLine({ price: ladder.sellers.lo, color: DOWN_COLOR, lineWidth: 1, lineStyle: 2, axisLabelVisible: true }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ladder, format, share])
  return <div ref={containerRef} style={{ width: '100%', height }} />
}

function Zone({ title, zone, color, side, format }) {
  return (
    <div style={{ minWidth: 150 }}>
      <Text type="secondary" style={{ fontSize: 11 }}>{title}</Text>
      <div style={{ color, fontSize: 18, fontWeight: 600, lineHeight: 1.2 }}>{zone ? `${price(zone.lo)}–${price(zone.hi)}` : '—'}</div>
      <Text type="secondary" style={{ fontSize: 11 }}>
        {zone ? `${format(zone.quantity)} waiting · ${zone.distance === 0 ? 'at the price' : `${price(zone.distance)} pts ${side}`}` : `no big ${side === 'below' ? 'bids' : 'offers'} in the book`}
      </Text>
    </div>
  )
}

/**
 * The Order Flow page's "Chart and order book" card (asked for - "on Order Flow the liquidity heatmap on the futures
 * chart, like the one I sent"): the futures candles with the order book standing beside them - lots waiting a row of
 * N points, buyers left of the price and sellers right, bought / sold in the last minutes, what was pulled, the big rows
 * and the nearest big buyers / sellers - all at the page's clock (live, or the replay's). bookLadder.js does the
 * reading, bookLadderPrimitive.js the drawing. A picture of the book - it feeds no signal or strategy.
 */
export function OrderBookChartCard({ view, underlying, rowSize, lotSize, showLots, clockMs, dayKey, narrow, noDepth, isReplay }) {
  const [timeframe, setTimeframe] = usePersistedState('optionanalytics.orderFlow.bookChartTf', 1)
  const [rowsBy, setRowsBy] = usePersistedState('optionanalytics.orderFlow.bookChartRows', null)
  const [windowMin, setWindowMin] = usePersistedState('optionanalytics.orderFlow.bookChartWindow', 5)
  const [hover, setHover] = useState(null)
  const tf = TIMEFRAMES.includes(timeframe) ? timeframe : 1
  const picked = rowsBy?.[underlying] ?? LADDER_ROWS[underlying] ?? 5
  const row = ladderRow(picked, rowSize)
  const win = LADDER_WINDOWS.includes(windowMin) ? windowMin : 5
  const candles = useMemo(() => candlesOf(view?.minuteBars, tf), [view?.minuteBars, tf])
  const format = useMemo(() => (q) => formatVolume(q, lotSize, showLots), [lotSize, showLots])
  const ladder = useMemo(() => (noDepth ? null : bookLadder({
    book: view?.book, columns: view?.heatmap, minuteBars: view?.minuteBars, clockMs, row, price: view?.meta?.lastPrice, windowMin: win,
  })), [noDepth, view?.book, view?.heatmap, view?.minuteBars, clockMs, row, view?.meta?.lastPrice, win])
  const hoverRow = ladderRowAt(ladder, hover)
  const unit = showLots ? 'lots' : 'qty'
  const lean = ladder && ladder.bidQty + ladder.askQty > 0 ? Math.round((ladder.bidQty / (ladder.bidQty + ladder.askQty)) * 100) : null

  const controls = (
    <Space size={8} wrap>
      <Segmented size="small" value={tf} onChange={setTimeframe} options={TIMEFRAMES.map((m) => ({ value: m, label: `${m}m` }))} />
      <Tooltip title={`Points a ladder row (a whole number of the footprint's ${rowSize} pt rows)`}>
        <Select size="small" value={picked} style={{ width: 92 }} onChange={(v) => setRowsBy({ ...(rowsBy ?? {}), [underlying]: v })}
          options={LADDER_ROW_CHOICES.map((v) => ({ value: v, label: `${v} pt` }))} />
      </Tooltip>
      <Tooltip title="Bought / sold and pulled are counted over this many minutes up to the clock">
        <Select size="small" value={win} style={{ width: 96 }} onChange={setWindowMin}
          options={LADDER_WINDOWS.map((v) => ({ value: v, label: `last ${v}m` }))} />
      </Tooltip>
    </Space>
  )
  return (
    // On a phone the controls go in the body - beside the title they squeezed it out.
    <Card size="small" title={`Chart and order book · ${unit} waiting per ${row} pts`} extra={!narrow && controls}>
      {narrow && <div style={{ marginBottom: 8 }}>{controls}</div>}
      {noDepth ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No order book for this day - it needs market depth, which only the days the server saw live have." />
      ) : (
        <>
          <Space size={[24, 8]} wrap style={{ marginBottom: 6 }}>
            <div style={{ minWidth: 130 }}>
              <Text type="secondary" style={{ fontSize: 11 }}>{underlying} future{isReplay ? ' (replay)' : ''}</Text>
              <div style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.2 }}>{price(view?.meta?.lastPrice)}</div>
              <Text type="secondary" style={{ fontSize: 11 }}>{lean != null ? `bids ${lean}% of the book within ${ROWS_EACH} rows` : 'no book yet'}</Text>
            </div>
            <Zone title="Nearest big buyers" zone={ladder?.buyers} color={UP_COLOR} side="below" format={format} />
            <Zone title="Nearest big sellers" zone={ladder?.sellers} color={DOWN_COLOR} side="above" format={format} />
          </Space>
          <div style={{ fontSize: 11, marginBottom: 4, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <span><span style={{ color: UP_COLOR }}>■</span> buyers waiting · <span style={{ color: 'rgba(38,166,154,0.55)' }}>▬</span> bought</span>
            <span><span style={{ color: DOWN_COLOR }}>■</span> sellers waiting · <span style={{ color: 'rgba(239,83,80,0.55)' }}>▬</span> sold</span>
            <span><span style={{ color: '#faad14' }}>⬚</span> pulled (cancelled)</span>
            {ladder && (
              <Text type="secondary" style={{ fontSize: 11 }}>
                last {win}m near the price: bought {format(ladder.boughtQty)} · sold {format(ladder.soldQty)} · pulled bids {format(ladder.pulledBidQty)} · pulled offers {format(ladder.pulledAskQty)}
              </Text>
            )}
          </div>
          <BookChart candles={candles} ladder={ladder} format={format} dayKey={`${dayKey}-${tf}`} narrow={narrow} onHover={setHover} />
          <div style={{ fontSize: 11, minHeight: 18, marginTop: 2 }}>
            {hoverRow ? (
              <Text type="secondary" style={{ fontSize: 11 }}>
                {price(hoverRow.price)}–{price(hoverRow.price + ladder.row)}: <span style={{ color: UP_COLOR }}>bids {format(hoverRow.bid)}{hoverRow.bigBid ? ' (big)' : ''}</span>
                {' · '}<span style={{ color: DOWN_COLOR }}>offers {format(hoverRow.ask)}{hoverRow.bigAsk ? ' (big)' : ''}</span>
                {` · last ${win}m: bought ${format(hoverRow.bought)} · sold ${format(hoverRow.sold)} · pulled bids ${format(hoverRow.pulledBid)} · pulled offers ${format(hoverRow.pulledAsk)}`}
              </Text>
            ) : <Text type="secondary" style={{ fontSize: 11 }}>Hover a row for its numbers.</Text>}
          </div>
          <FoldText id="orderFlow.bookChart" label="how to read it" className="oa-note">
            <Text type="secondary" style={{ fontSize: 11 }}>
              The book at the clock beside the candles, in rows of {row} points: green left of the price = buyers waiting (resting bids),
              red right of it = sellers waiting (resting offers), {unit} at the bar's end; brighter = a BIG row ({'≥'} 2.5x the usual row
              of its side). The light strip under a row = what was BOUGHT (green) / SOLD (red) there in the last {win} minutes; the
              orange outline past a bar = what was PULLED there (cancelled away from the touch - it could not have traded). The bands
              across the candles and the dashed lines are the nearest big buyers under the price and big sellers over it. Big buyers
              that stay while selling hits them = support being defended; a big row that is pulled as price nears = not real.
            </Text>
          </FoldText>
        </>
      )}
    </Card>
  )
}
