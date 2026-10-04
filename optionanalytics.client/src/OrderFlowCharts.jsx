import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Tag, Typography } from 'antd'
import { createChart, HistogramSeries, LineSeries, CrosshairMode } from 'lightweight-charts'
import { UP_COLOR, DOWN_COLOR, AXIS_COLOR, GRID_COLOR, BORDER_COLOR, toChartTime, istTickMarkFormatter, istTimeFormatter } from './shared.jsx'
import { useFitContentAsDataGrows } from './oiShared.jsx'

const { Text } = Typography

// Canvas charts for the Order Flow page. The footprint and the depth heatmap have no equivalent in
// lightweight-charts, so they are drawn directly; the cumulative delta chart uses lightweight-charts
// like the rest of the app.

const IST_HHMM = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })
const IST_HHMMSS = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })
const BUY_FILL = 'rgba(38, 166, 154, 0.85)'
const SELL_FILL = 'rgba(239, 83, 80, 0.85)'
const POC_COLOR = '#f5c542'
const ICEBERG_COLOR = '#d36cff'
const FONT = '"Segoe UI", system-ui, sans-serif'

// Volume as lots (or raw quantity), compact.
export function formatVolume(quantity, lotSize, showLots) {
  const v = showLots && lotSize > 0 ? quantity / lotSize : quantity
  const abs = Math.abs(v)
  if (abs >= 1e7) return `${(v / 1e7).toFixed(1)}Cr`
  if (abs >= 1e5) return `${(v / 1e5).toFixed(1)}L`
  if (abs >= 1e4) return `${(v / 1e3).toFixed(0)}k`
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}k`
  return abs < 10 && v % 1 !== 0 ? v.toFixed(1) : String(Math.round(v))
}

function useElementWidth(ref) {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    if (!ref.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)))
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [ref])
  return width
}

// A canvas sized for the device's pixel ratio; returns its 2D context ready to draw in CSS pixels.
function prepareCanvas(canvas, width, height) {
  const dpr = window.devicePixelRatio || 1
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
  }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  return ctx
}

function niceStep(rowsPerLabel) {
  for (const n of [1, 2, 5, 10, 20, 25, 50, 100, 200, 500]) if (n >= rowsPerLabel) return n
  return 1000
}

const priceText = (p) => (Number.isInteger(p) ? p.toLocaleString('en-IN') : p.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))

// ---- Footprint ------------------------------------------------------------------------------

const FP_AXIS_W = 70
const FP_TIME_H = 18
const FP_STRIP_H = 36
const FP_TOP = 6

// Footprint: each bar is a candle plus, per price row, the volume that hit the bid (left, sellers
// aggressive) and lifted the offer (right, buyers aggressive). Imbalanced cells are filled green/red,
// the POC row outlined, stacked imbalance zones extended to the right as bands, absorption (A) and
// exhaustion (E) marked at their rows, and each bar's delta and volume below it.
// Drag to scroll back, wheel to change bar width, double-click to return to the live edge.
export function FootprintChart({ bars, rowSize, lotSize, showLots, height = 620, lastPrice }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const width = useElementWidth(wrapRef)
  const [colWidth, setColWidth] = useState(120)
  const [offset, setOffset] = useState(0)
  const [hover, setHover] = useState(null)
  const dragRef = useRef(null)

  const step = rowSize > 0 ? rowSize : 0.05
  const plotW = Math.max(0, width - FP_AXIS_W)
  const plotH = Math.max(50, height - FP_STRIP_H - FP_TIME_H - FP_TOP)

  const layout = useMemo(() => {
    if (!width || bars.length === 0) return null
    const nVisible = Math.max(1, Math.floor(plotW / colWidth))
    const end = Math.max(1, bars.length - Math.min(offset, bars.length - 1))
    const start = Math.max(0, end - nVisible)
    const visible = bars.slice(start, end)
    let hi = -Infinity
    let lo = Infinity
    for (const bar of visible) {
      for (const level of bar.levels) { hi = Math.max(hi, level.price); lo = Math.min(lo, level.price) }
      if (!bar.levels.length) { hi = Math.max(hi, bar.high); lo = Math.min(lo, bar.low) }
    }
    if (!Number.isFinite(hi)) return null
    const hiPad = hi + step
    const loPad = lo - step
    const nRows = Math.round((hiPad - loPad) / step) + 1
    const rowH = plotH / nRows
    return { visible, hiPad, loPad, nRows, rowH, start }
  }, [bars, width, plotW, plotH, colWidth, offset, step])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !width) return
    const ctx = prepareCanvas(canvas, width, height)
    if (!layout) {
      ctx.fillStyle = AXIS_COLOR
      ctx.font = `13px ${FONT}`
      ctx.fillText('Waiting for futures trades…', 16, 30)
      return
    }
    const { visible, hiPad, nRows, rowH } = layout
    const rowTop = (price) => FP_TOP + Math.round((hiPad - price) / step) * rowH
    const yPrice = (price) => FP_TOP + ((hiPad + step - price) / step) * rowH
    const textSize = Math.min(12, Math.floor(rowH - 2))
    const showText = rowH >= 10

    // Price grid + axis
    ctx.font = `11px ${FONT}`
    ctx.textBaseline = 'middle'
    const labelEvery = niceStep(Math.ceil(18 / Math.max(rowH, 0.1)))
    for (let i = 0; i < nRows; i++) {
      const price = Math.round((hiPad - i * step) * 100) / 100
      const rowIndex = Math.round(price / step)
      if (rowIndex % labelEvery !== 0) continue
      const y = FP_TOP + i * rowH + rowH / 2
      ctx.strokeStyle = GRID_COLOR
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke()
      ctx.fillStyle = AXIS_COLOR
      ctx.fillText(priceText(price), plotW + 6, y)
    }

    visible.forEach((bar, k) => {
      const x0 = plotW - (visible.length - k) * colWidth
      const cellX = x0 + 15
      const cellW = Math.max(8, (colWidth - 19) / 2)
      const maxSide = Math.max(1, ...bar.levels.map((l) => Math.max(l.buy, l.sell)))

      // Stacked imbalance zones, extended to the right edge.
      for (const zone of bar.stacked ?? []) {
        const top = rowTop(zone.high)
        const bottom = rowTop(zone.low) + rowH
        ctx.fillStyle = zone.side === 'buy' ? 'rgba(38,166,154,0.10)' : 'rgba(239,83,80,0.10)'
        ctx.fillRect(cellX, top, plotW - cellX, bottom - top)
        ctx.fillStyle = zone.side === 'buy' ? UP_COLOR : DOWN_COLOR
        ctx.fillRect(cellX, top, 2, bottom - top)
      }

      for (const level of bar.levels) {
        const top = rowTop(level.price)
        const imb = bar.imbalances?.get(level.price)
        ctx.fillStyle = imb === 'sell' ? SELL_FILL : `rgba(239,83,80,${0.06 + 0.32 * (level.sell / maxSide)})`
        ctx.fillRect(cellX, top + 0.5, cellW - 1, rowH - 1)
        ctx.fillStyle = imb === 'buy' ? BUY_FILL : `rgba(38,166,154,${0.06 + 0.32 * (level.buy / maxSide)})`
        ctx.fillRect(cellX + cellW, top + 0.5, cellW - 1, rowH - 1)
        if (showText) {
          ctx.font = `${imb ? '600 ' : ''}${textSize}px ${FONT}`
          ctx.textBaseline = 'middle'
          ctx.fillStyle = imb === 'sell' ? '#fff' : '#e8c6c6'
          ctx.textAlign = 'right'
          ctx.fillText(formatVolume(level.sell, lotSize, showLots), cellX + cellW - 4, top + rowH / 2)
          ctx.fillStyle = imb === 'buy' ? '#fff' : '#c4e8e3'
          ctx.textAlign = 'left'
          ctx.fillText(formatVolume(level.buy, lotSize, showLots), cellX + cellW + 3, top + rowH / 2)
          ctx.textAlign = 'left'
        }
        if (level.price === bar.poc) {
          ctx.strokeStyle = POC_COLOR
          ctx.lineWidth = 1.5
          ctx.strokeRect(cellX + 0.5, top + 0.5, cellW * 2 - 2, rowH - 1)
          ctx.lineWidth = 1
        }
      }

      // Candle
      const up = bar.close >= bar.open
      const cx = x0 + 7
      ctx.strokeStyle = up ? UP_COLOR : DOWN_COLOR
      ctx.beginPath(); ctx.moveTo(cx, yPrice(bar.high + step / 2)); ctx.lineTo(cx, yPrice(bar.low + step / 2)); ctx.stroke()
      ctx.fillStyle = up ? UP_COLOR : DOWN_COLOR
      const bodyTop = yPrice(Math.max(bar.open, bar.close) + step / 2)
      const bodyBottom = yPrice(Math.min(bar.open, bar.close) + step / 2)
      ctx.fillRect(cx - 3, bodyTop, 6, Math.max(1, bodyBottom - bodyTop))

      // Absorption (A) / exhaustion (E) markers.
      const marker = (price, side, letter) => {
        const y = rowTop(price) + rowH / 2
        const x = x0 + colWidth - 9
        const r = Math.max(5, Math.min(8, rowH / 2))
        ctx.fillStyle = side === 'buy' ? UP_COLOR : DOWN_COLOR
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
        ctx.fillStyle = '#fff'
        ctx.font = `700 ${Math.round(r * 1.3)}px ${FONT}`
        ctx.textAlign = 'center'
        ctx.fillText(letter, x, y + 0.5)
        ctx.textAlign = 'left'
      }
      for (const a of bar.absorption ?? []) marker(a.price, a.side, 'A')
      for (const e of bar.exhaustion ?? []) marker(e.price, e.side, 'E')

      // Delta + volume strip and time label.
      const stripY = FP_TOP + plotH + 2
      ctx.fillStyle = 'rgba(255,255,255,0.03)'
      ctx.fillRect(x0 + 1, stripY, colWidth - 2, FP_STRIP_H - 4)
      ctx.textAlign = 'center'
      ctx.font = `600 12px ${FONT}`
      ctx.fillStyle = bar.delta >= 0 ? UP_COLOR : DOWN_COLOR
      ctx.fillText(`Δ ${bar.delta >= 0 ? '+' : ''}${formatVolume(bar.delta, lotSize, showLots)}`, x0 + colWidth / 2, stripY + 10)
      ctx.font = `11px ${FONT}`
      ctx.fillStyle = AXIS_COLOR
      ctx.fillText(`Vol ${formatVolume(bar.volume, lotSize, showLots)}`, x0 + colWidth / 2, stripY + 24)
      if (colWidth >= 56 || k % 2 === 0) ctx.fillText(IST_HHMM.format(new Date(bar.time)), x0 + colWidth / 2, height - FP_TIME_H / 2)
      ctx.textAlign = 'left'
      ctx.strokeStyle = GRID_COLOR
      ctx.beginPath(); ctx.moveTo(x0, FP_TOP); ctx.lineTo(x0, FP_TOP + plotH); ctx.stroke()
    })

    // Last price line.
    if (lastPrice > 0) {
      const y = yPrice(lastPrice + step / 2)
      if (y > FP_TOP && y < FP_TOP + plotH) {
        ctx.setLineDash([4, 3])
        ctx.strokeStyle = '#ffffffaa'
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = '#2b6cb0'
        ctx.fillRect(plotW + 1, y - 9, FP_AXIS_W - 2, 18)
        ctx.fillStyle = '#fff'
        ctx.font = `600 11px ${FONT}`
        ctx.textBaseline = 'middle'
        ctx.fillText(priceText(lastPrice), plotW + 5, y)
      }
    }
  }, [layout, width, height, plotW, plotH, colWidth, step, lotSize, showLots, lastPrice])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (e) => {
      e.preventDefault()
      setColWidth((w) => Math.max(56, Math.min(240, w + (e.deltaY < 0 ? 10 : -10))))
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

  const hitTest = (x, y) => {
    if (!layout || x > plotW) return null
    const k = layout.visible.length - Math.ceil((plotW - x) / colWidth)
    const bar = layout.visible[k]
    if (!bar) return null
    const row = Math.round((layout.hiPad - Math.floor((y - FP_TOP) / layout.rowH) * step) * 100) / 100
    const level = bar.levels.find((l) => l.price === row)
    return { bar, level, row, x, y }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', height, userSelect: 'none' }}>
      <canvas
        ref={canvasRef}
        style={{ cursor: 'crosshair', display: 'block', touchAction: 'none' }}
        onPointerDown={(e) => { dragRef.current = { x: e.clientX, offset }; e.currentTarget.setPointerCapture(e.pointerId) }}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          if (dragRef.current) {
            const moved = Math.round((e.clientX - dragRef.current.x) / colWidth)
            setOffset(Math.max(0, Math.min(Math.max(0, bars.length - 1), dragRef.current.offset + moved)))
            setHover(null)
          } else setHover(hitTest(e.clientX - rect.left, e.clientY - rect.top))
        }}
        onPointerUp={() => { dragRef.current = null }}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={() => setOffset(0)}
      />
      {offset > 0 && (
        <Button size="small" style={{ position: 'absolute', top: 8, right: FP_AXIS_W + 8 }} onClick={() => setOffset(0)}>
          Back to live ▸
        </Button>
      )}
      {hover?.level && (
        <div style={{
          position: 'absolute', left: Math.min(hover.x + 14, width - 220), top: Math.max(0, hover.y - 70), pointerEvents: 'none',
          background: '#141821ee', border: `1px solid ${BORDER_COLOR}`, borderRadius: 6, padding: '6px 9px', fontSize: 12, lineHeight: 1.5, width: 200,
        }}>
          <div><b>{priceText(hover.row)}</b> · {IST_HHMM.format(new Date(hover.bar.time))}</div>
          <div style={{ color: DOWN_COLOR }}>Sell (at bid): {formatVolume(hover.level.sell, lotSize, showLots)}{showLots ? ' lots' : ''}</div>
          <div style={{ color: UP_COLOR }}>Buy (at ask): {formatVolume(hover.level.buy, lotSize, showLots)}{showLots ? ' lots' : ''}</div>
          <div>Delta {hover.level.buy - hover.level.sell >= 0 ? '+' : ''}{formatVolume(hover.level.buy - hover.level.sell, lotSize, showLots)}
            {hover.bar.imbalances?.get(hover.row) ? ` · ${hover.bar.imbalances.get(hover.row)} imbalance` : ''}
            {hover.row === hover.bar.poc ? ' · POC' : ''}
          </div>
        </div>
      )}
    </div>
  )
}

// ---- Depth heatmap --------------------------------------------------------------------------

const HM_AXIS_W = 70
const HM_TIME_H = 18
const HEAT_STOPS = [[0, [20, 30, 60]], [0.3, [29, 59, 139]], [0.55, [31, 162, 200]], [0.8, [242, 212, 61]], [1, [240, 74, 42]]]

function heatColor(t) {
  const v = Math.max(0, Math.min(1, t))
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const [t1, c1] = HEAT_STOPS[i]
    const [t0, c0] = HEAT_STOPS[i - 1]
    if (v <= t1) {
      const f = (v - t0) / (t1 - t0)
      return `rgb(${c0.map((c, j) => Math.round(c + (c1[j] - c) * f)).join(',')})`
    }
  }
  return 'rgb(240,74,42)'
}

// Depth heatmap: resting liquidity over time - each column is one book snapshot, each cell a price
// row, brighter = more quantity resting there. The white line is the mid price; circles are large
// prints (green buy / red sell, size by quantity); magenta lines are detected icebergs.
export function DepthHeatmap({ columns, rowSize, trades, icebergs, lotSize, showLots, height = 420 }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const width = useElementWidth(wrapRef)
  const [hover, setHover] = useState(null)
  const step = rowSize > 0 ? rowSize : 0.05
  const plotW = Math.max(0, width - HM_AXIS_W)
  const plotH = Math.max(50, height - HM_TIME_H)

  const layout = useMemo(() => {
    if (!width || columns.length === 0) return null
    const maxCols = Math.max(1, Math.floor(plotW / 2))
    const visible = columns.slice(-maxCols)
    const mids = visible.map((c) => {
      const bestBid = c.bids.length ? Math.max(...c.bids.map((b) => b[0])) : null
      const bestAsk = c.asks.length ? Math.min(...c.asks.map((a) => a[0])) : null
      return bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : bestBid ?? bestAsk
    })
    let hi = -Infinity
    let lo = Infinity
    const quantities = []
    for (const c of visible) {
      for (const [p, q] of c.bids) { lo = Math.min(lo, p); hi = Math.max(hi, p); quantities.push(q) }
      for (const [p, q] of c.asks) { lo = Math.min(lo, p); hi = Math.max(hi, p); quantities.push(q) }
    }
    if (!Number.isFinite(hi)) return null
    // Keep the view readable on a trending day: at most 160 rows, centred on the latest mid.
    const lastMid = mids.filter((m) => m != null).at(-1) ?? (hi + lo) / 2
    if ((hi - lo) / step > 160) { hi = lastMid + 80 * step; lo = lastMid - 80 * step }
    quantities.sort((a, b) => a - b)
    // Linear against the 98th percentile: ordinary liquidity stays blue, walls stand out hot.
    const cap = quantities[Math.floor(quantities.length * 0.98)] || 1
    const hiPad = hi + step
    const nRows = Math.round((hiPad - (lo - step)) / step) + 1
    return { visible, mids, hiPad, nRows, rowH: plotH / nRows, colW: plotW / visible.length, cap, t0: visible[0].t, t1: visible[visible.length - 1].t }
  }, [columns, width, plotW, plotH, step])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !width) return
    const ctx = prepareCanvas(canvas, width, height)
    ctx.fillStyle = '#0d111a'
    ctx.fillRect(0, 0, plotW, plotH)
    if (!layout) {
      ctx.fillStyle = AXIS_COLOR
      ctx.font = `13px ${FONT}`
      ctx.fillText('Waiting for market depth…', 16, 30)
      return
    }
    const { visible, mids, hiPad, nRows, rowH, colW, cap, t0, t1 } = layout
    const rowTop = (p) => Math.round((hiPad - p) / step) * rowH
    const yPrice = (p) => ((hiPad + step - p) / step) * rowH - rowH / 2
    const xTime = (t) => (t1 === t0 ? plotW : ((t - t0) / (t1 - t0)) * (plotW - colW) + colW / 2)

    visible.forEach((c, i) => {
      const x = i * colW
      for (const side of [c.bids, c.asks]) {
        for (const [p, q] of side) {
          const top = rowTop(p)
          if (top < -rowH || top > plotH) continue
          ctx.fillStyle = heatColor(q / cap)
          ctx.fillRect(x, top, colW + 0.6, rowH + 0.6)
        }
      }
    })

    // Mid price
    ctx.strokeStyle = '#ffffffdd'
    ctx.lineWidth = 1.5
    ctx.beginPath()
    let started = false
    mids.forEach((m, i) => {
      if (m == null) return
      const x = i * colW + colW / 2
      const y = yPrice(m)
      if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
    })
    ctx.stroke()
    ctx.lineWidth = 1

    // Icebergs
    for (const ice of icebergs ?? []) {
      const start = new Date(ice.startedAt).getTime()
      const end = ice.endedAt ? new Date(ice.endedAt).getTime() : t1
      if (end < t0 || start > t1) continue
      const y = yPrice(ice.price)
      ctx.strokeStyle = ICEBERG_COLOR
      ctx.lineWidth = 3
      ctx.beginPath(); ctx.moveTo(xTime(Math.max(start, t0)), y); ctx.lineTo(xTime(Math.min(end, t1)), y); ctx.stroke()
      ctx.lineWidth = 1
      const dx = xTime(Math.max(new Date(ice.detectedAt).getTime(), t0))
      ctx.fillStyle = ICEBERG_COLOR
      ctx.beginPath(); ctx.moveTo(dx, y - 6); ctx.lineTo(dx + 6, y); ctx.lineTo(dx, y + 6); ctx.lineTo(dx - 6, y); ctx.closePath(); ctx.fill()
    }

    // Large prints
    for (const trade of trades ?? []) {
      const t = new Date(trade.time).getTime()
      if (t < t0 || t > t1) continue
      const r = Math.max(2.5, Math.min(14, 2.5 * Math.sqrt(trade.quantity / Math.max(1, lotSize))))
      ctx.fillStyle = trade.buy ? 'rgba(38,166,154,0.75)' : 'rgba(239,83,80,0.75)'
      ctx.strokeStyle = '#ffffffaa'
      ctx.beginPath(); ctx.arc(xTime(t), yPrice(trade.price), r, 0, Math.PI * 2); ctx.fill(); ctx.stroke()
    }

    // Axes
    ctx.font = `11px ${FONT}`
    ctx.textBaseline = 'middle'
    ctx.fillStyle = AXIS_COLOR
    const labelEvery = niceStep(Math.ceil(18 / Math.max(rowH, 0.1)))
    for (let i = 0; i < nRows; i++) {
      const price = Math.round((hiPad - i * step) * 100) / 100
      if (Math.round(price / step) % labelEvery !== 0) continue
      ctx.fillText(priceText(price), plotW + 6, i * rowH + rowH / 2)
    }
    ctx.textAlign = 'center'
    const labels = Math.max(2, Math.floor(plotW / 110))
    for (let i = 0; i <= labels; i++) {
      const t = t0 + ((t1 - t0) * i) / labels
      ctx.fillText(IST_HHMM.format(new Date(t)), Math.min(plotW - 20, Math.max(20, xTime(t))), plotH + HM_TIME_H / 2)
    }
    ctx.textAlign = 'left'
  }, [layout, width, height, plotW, plotH, step, trades, icebergs, lotSize])

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', height }}>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', cursor: 'crosshair' }}
        onPointerMove={(e) => {
          if (!layout) return
          const rect = e.currentTarget.getBoundingClientRect()
          const x = e.clientX - rect.left
          const y = e.clientY - rect.top
          const col = layout.visible[Math.floor(x / layout.colW)]
          if (!col || y > plotH) { setHover(null); return }
          const row = Math.round((layout.hiPad - Math.floor(y / layout.rowH) * step) * 100) / 100
          const bid = col.bids.find((b) => b[0] === row)?.[1]
          const ask = col.asks.find((a) => a[0] === row)?.[1]
          setHover({ x, y, row, t: col.t, bid, ask })
        }}
        onPointerLeave={() => setHover(null)}
      />
      {hover && (hover.bid != null || hover.ask != null) && (
        <div style={{
          position: 'absolute', left: Math.min(hover.x + 14, width - 190), top: Math.max(0, hover.y - 50), pointerEvents: 'none',
          background: '#141821ee', border: `1px solid ${BORDER_COLOR}`, borderRadius: 6, padding: '6px 9px', fontSize: 12, lineHeight: 1.5,
        }}>
          <div><b>{priceText(hover.row)}</b> · {IST_HHMMSS.format(new Date(hover.t))}</div>
          {hover.bid != null && <div style={{ color: UP_COLOR }}>Bids resting: {formatVolume(hover.bid, lotSize, showLots)}{showLots ? ' lots' : ''}</div>}
          {hover.ask != null && <div style={{ color: DOWN_COLOR }}>Offers resting: {formatVolume(hover.ask, lotSize, showLots)}{showLots ? ' lots' : ''}</div>}
        </div>
      )}
    </div>
  )
}

// ---- Delta / cumulative delta ---------------------------------------------------------------

// Each bar's delta (buy - sell aggression) as a histogram, and the session's cumulative delta as a line.
export function CumulativeDeltaChart({ bars, dayKey, lotSize, showLots, height = 240 }) {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const deltaRef = useRef(null)
  const cvdRef = useRef(null)
  const scale = showLots && lotSize > 0 ? 1 / lotSize : 1

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      leftPriceScale: { visible: true, borderColor: BORDER_COLOR },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter },
      crosshair: { mode: CrosshairMode.Normal },
      localization: { timeFormatter: istTimeFormatter },
    })
    chartRef.current = chart
    deltaRef.current = chart.addSeries(HistogramSeries, { priceScaleId: 'left', title: 'Delta', priceLineVisible: false })
    cvdRef.current = chart.addSeries(LineSeries, { color: '#f5c542', lineWidth: 2, title: 'Cum Δ', priceLineVisible: false })
    const observer = new ResizeObserver(() => { if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth }) })
    observer.observe(containerRef.current)
    return () => { observer.disconnect(); chart.remove(); chartRef.current = null }
  }, [height])

  useEffect(() => {
    if (!deltaRef.current || !cvdRef.current) return
    deltaRef.current.setData(bars.map((b) => ({ time: toChartTime(new Date(b.time)), value: b.delta * scale, color: b.delta >= 0 ? UP_COLOR : DOWN_COLOR })))
    cvdRef.current.setData(bars.map((b) => ({ time: toChartTime(new Date(b.time)), value: b.cvd * scale })))
  }, [bars, scale])

  useFitContentAsDataGrows(chartRef, bars.length, dayKey)

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// ---- Book ladder ----------------------------------------------------------------------------

// The live book: offers above, bids below, each row's quantity as a bar; walls (far larger than the
// rest of the book) highlighted, and prices with a live iceberg tagged.
export function BookLadder({ book, walls, icebergPrices, lotSize, showLots, maxRows = 20 }) {
  const asks = (book?.asks ?? []).slice(0, maxRows)
  const bids = (book?.bids ?? []).slice(0, maxRows)
  const max = Math.max(1, ...asks.map((l) => l.quantity), ...bids.map((l) => l.quantity))
  if (!asks.length && !bids.length) return <Text type="secondary">No market depth yet.</Text>
  const totalBid = bids.reduce((s, l) => s + l.quantity, 0)
  const totalAsk = asks.reduce((s, l) => s + l.quantity, 0)

  const row = (level, side) => {
    const isWall = (side === 'bid' ? walls?.bids : walls?.asks)?.has(level.price)
    const color = side === 'bid' ? UP_COLOR : DOWN_COLOR
    return (
      <div key={`${side}-${level.price}`} style={{ display: 'grid', gridTemplateColumns: '78px 1fr 34px', alignItems: 'center', gap: 6, fontSize: 12, height: 19 }}>
        <span style={{ color, fontWeight: isWall ? 700 : 400 }}>{priceText(level.price)}</span>
        <span style={{ position: 'relative', height: 15 }}>
          <span style={{ position: 'absolute', inset: 0, width: `${(level.quantity / max) * 100}%`, background: isWall ? (side === 'bid' ? '#26a69a99' : '#ef535099') : (side === 'bid' ? '#26a69a33' : '#ef535033'), borderRadius: 2 }} />
          <span style={{ position: 'relative', paddingLeft: 4, fontWeight: isWall ? 700 : 400 }}>
            {formatVolume(level.quantity, lotSize, showLots)}{isWall ? '  WALL' : ''}
          </span>
        </span>
        <span style={{ color: AXIS_COLOR, textAlign: 'right' }}>
          {icebergPrices?.has(level.price) ? <Tag color="purple" style={{ margin: 0, fontSize: 10, padding: '0 3px', lineHeight: '14px' }}>ICE</Tag> : level.orders}
        </span>
      </div>
    )
  }

  return (
    <div>
      {[...asks].reverse().map((l) => row(l, 'ask'))}
      <div style={{ borderTop: `1px solid ${BORDER_COLOR}`, margin: '3px 0' }} />
      {bids.map((l) => row(l, 'bid'))}
      <div style={{ fontSize: 11, color: AXIS_COLOR, marginTop: 6 }}>
        Shown depth - bids {formatVolume(totalBid, lotSize, showLots)} vs offers {formatVolume(totalAsk, lotSize, showLots)}
        {totalBid + totalAsk > 0 ? ` (${Math.round((totalBid / (totalBid + totalAsk)) * 100)}% bids)` : ''} · right column = orders
      </div>
    </div>
  )
}
