import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Tag, Typography } from 'antd'
import { HistogramSeries, LineSeries, CrosshairMode } from 'lightweight-charts'
import { createZoomableChart } from './chartZoom.js'
import { UP_COLOR, DOWN_COLOR, AXIS_COLOR, GRID_COLOR, BORDER_COLOR, toChartTime, istTickMarkFormatter, istTimeFormatter } from './shared.jsx'
import { useFitContentAsDataGrows } from './oiShared.jsx'
import { useElementWidth, prepareCanvas } from './canvasUtils.js'
import { PREV_PROFILE, RUNNING_PROFILE } from './profileColors.js'
import { bidShare, heatmapPriceRange } from './orderFlowMath.js'
import { checkpoints, checkpointStep } from './halfHourMarks.js'

const { Text } = Typography

// Canvas charts for the Order Flow page. The footprint and the depth heatmap have no equivalent in
// lightweight-charts, so they are drawn directly; the cumulative delta chart uses lightweight-charts
// like the rest of the app.

const IST_OFFSET_S = 19800
const IST_HHMM = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })
const EXH_COLOR = '#9254de'
// Stacked imbalances: a sell stack's bid-side (left) cells purple, a buy stack's ask-side (right) cells white.
const STACK_SELL_FILL = '#8e44d6'
const STACK_BUY_FILL = '#f2f2f2'
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

function niceStep(rowsPerLabel) {
  for (const n of [1, 2, 5, 10, 20, 25, 50, 100, 200, 500]) if (n >= rowsPerLabel) return n
  return 1000
}

const VWAP_LINE_COLOR = '#e072e8'
const priceText = (p) => (Number.isInteger(p) ? p.toLocaleString('en-IN') : p.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))

// ---- Footprint ------------------------------------------------------------------------------

const FP_AXIS_W = 70
const FP_TIME_H = 18
const FP_STRIP_H = 52
const FP_TOP = 6

// Footprint: each bar is a candle plus, per price row, the volume that hit the bid (left, sellers
// aggressive) and lifted the offer (right, buyers aggressive). Imbalanced cells are filled green/red,
// the POC row outlined, stacked imbalance zones extended to the right as bands, absorption (A) and
// exhaustion (E) marked at their rows, and each bar's delta and volume below it.
// Drag to scroll back, wheel (or the -/+ buttons) to change bar width, double-click to return to the
// live edge. `profile` (orderFlowMath.volumeProfile) adds the session volume profile as a column on
// the same price scale, with its POC and value area (VAH/VAL) drawn across the bars. `trades` (big
// orders) are drawn as dots at their price, inside their bar at their time, sized by quantity.
// Under each bar: its delta, the cumulative delta so far, and its volume.
const barMs = (bar) => (typeof bar.time === 'number' ? bar.time : new Date(bar.time).getTime())

// The view's right edge (in bars): at least one bar on screen, at most half a screen of empty space
// past the last bar.
const clampEnd = (endIdx, n, span) => Math.max(Math.min(1, n), Math.min(n + Math.max(1, span * 0.5), endIdx))

// Rows `factor` times taller (or shorter), keeping the price at canvas height `y` where it is.
function zoomRows(l, factor, y, step, plotH) {
  const rowH = Math.max(3, Math.min(140, l.rowH * factor))
  if (!(l.rowH > 0)) return { top: l.hiPad, rowH }
  const priceAt = l.hiPad - ((y - FP_TOP) / l.rowH) * step
  const top = priceAt + ((y - FP_TOP) / rowH) * step
  return { top, rowH: Math.max(rowH, plotH / 2000) }
}

export function FootprintChart({ bars, rowSize, lotSize, showLots, height = 620, lastPrice, profile = null, runningProfile = null, trades = [], timeframe = 1, bigLabel = 'Big order', alerts = [], levels = [], vwap = null }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const width = useElementWidth(wrapRef)
  const narrow = width > 0 && width < 640
  const [colWidth, setColWidth] = useState(() => (typeof window !== 'undefined' && window.innerWidth < 640 ? 76 : 120))
  // Where the view sits - yours once you drag it, never snapped back by new bars:
  //   pan:   null = follow the latest bar; else { t, f } = the right edge sits f bars after the
  //          bar that started at time t (anchored to a TIME, so bars arriving on the right - or
  //          trimmed on the left - do not move what you are looking at). f may run past the last
  //          bar, leaving empty space on the right.
  //   vview: null = prices auto-fit the bars on screen; else { top, rowH } = the price at the top
  //          edge and each row's height - dragged up/down or zoomed (Shift+wheel, price-axis drag).
  const [pan, setPan] = useState(null)
  const [vview, setVview] = useState(null)
  const [hover, setHover] = useState(null)
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef(null)
  const dotsRef = useRef([])

  const step = rowSize > 0 ? rowSize : 0.05
  const plotW = Math.max(0, width - FP_AXIS_W)
  const profileW = profile?.rows?.length ? (narrow ? 54 : 96) : 0
  const barsW = Math.max(0, plotW - profileW)
  const plotH = Math.max(50, height - FP_STRIP_H - FP_TIME_H - FP_TOP)

  const span = barsW / Math.max(1, colWidth)
  const endIndexFor = useCallback((p) => {
    const n = bars.length
    if (!p) return n
    const i = bars.findIndex((b) => barMs(b) === p.t)
    if (i < 0) return n
    return clampEnd(i + 1 + p.f, n, span)
  }, [bars, span])
  // A pan position for a (fractional) right-edge index - re-anchored on the bar at that edge; back at
  // the latest bar it follows again.
  const panFor = useCallback((endIdx) => {
    const n = bars.length
    if (n === 0) return null
    const e = clampEnd(endIdx, n, span)
    if (Math.abs(e - n) < 0.25) return null
    const i = Math.max(0, Math.min(n - 1, Math.ceil(e) - 1))
    return { t: barMs(bars[i]), f: e - (i + 1) }
  }, [bars, span])

  const layout = useMemo(() => {
    if (!width || bars.length === 0) return null
    const n = bars.length
    const endIdx = endIndexFor(pan)
    const end = Math.max(1, Math.min(n, Math.ceil(endIdx - 1e-9)))
    const start = Math.max(0, Math.floor(endIdx - span))
    const visible = bars.slice(start, end)
    // Bar i's left edge sits at barsW - (endIdx - i) * colWidth; rightPad is the gap (or overhang)
    // between the last drawn bar and the right edge.
    const rightPad = (endIdx - end) * colWidth
    let hiPad, rowH
    if (vview) {
      hiPad = vview.top
      rowH = vview.rowH
    } else {
      let hi = -Infinity
      let lo = Infinity
      for (const bar of visible) {
        for (const level of bar.levels) { hi = Math.max(hi, level.price); lo = Math.min(lo, level.price) }
        if (!bar.levels.length) { hi = Math.max(hi, bar.high); lo = Math.min(lo, bar.low) }
      }
      if (!Number.isFinite(hi)) {
        const last = bars[n - 1]
        hi = last.high; lo = last.low
      }
      if (!Number.isFinite(hi)) return null
      hiPad = hi + step
      rowH = plotH / (Math.round((hiPad - (lo - step)) / step) + 1)
    }
    const nRows = Math.ceil(plotH / rowH) + 1
    return { visible, hiPad, nRows, rowH, start, end, endIdx, rightPad }
  }, [bars, width, plotH, colWidth, span, pan, vview, step, endIndexFor])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !width) return
    const ctx = prepareCanvas(canvas, width, height)
    if (!layout) {
      ctx.fillStyle = AXIS_COLOR
      ctx.font = `13px ${FONT}`
      ctx.fillText('Waiting for futures trades…', 16, 64)
      return
    }
    const { visible, hiPad, rowH, rightPad } = layout
    const rowTop = (price) => FP_TOP + ((hiPad - price) / step) * rowH
    const yPrice = (price) => FP_TOP + ((hiPad + step - price) / step) * rowH
    const barX = (k) => barsW - rightPad - (visible.length - k) * colWidth
    const clip = (x, y, w, h) => { ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip() }
    const textSize = Math.min(12, Math.floor(rowH - 2))
    const showText = rowH >= 10

    // Price grid + axis
    ctx.font = `11px ${FONT}`
    ctx.textBaseline = 'middle'
    const labelEvery = niceStep(Math.ceil(18 / Math.max(rowH, 0.1)))
    const firstRow = Math.floor(hiPad / step + 1e-9)
    for (let r = firstRow; rowTop(r * step) < FP_TOP + plotH; r--) {
      const price = Math.round(r * step * 100) / 100
      const rowIndex = r
      if (rowIndex % labelEvery !== 0) continue
      const y = rowTop(price) + rowH / 2
      if (y < FP_TOP) continue
      ctx.strokeStyle = GRID_COLOR
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke()
      ctx.fillStyle = AXIS_COLOR
      ctx.fillText(priceText(price), plotW + 6, y)
    }

    visible.forEach((bar, k) => {
      const x0 = barX(k)
      // Cells, candle and markers stay inside the plot; the strip below only inside the bars' width.
      clip(0, FP_TOP, barsW, plotH)
      const cellX = x0 + 15
      const cellW = Math.max(8, (colWidth - 19) / 2)
      const maxSide = Math.max(1, ...bar.levels.map((l) => Math.max(l.buy, l.sell)))

      // Stacked imbalance zones: a faint band extended to the right edge (support for a buy stack,
      // resistance for a sell stack), and the stacked rows themselves marked in the cells below.
      const stackedSell = new Set()
      const stackedBuy = new Set()
      for (const zone of bar.stacked ?? []) {
        const top = rowTop(zone.high)
        const bottom = rowTop(zone.low) + rowH
        ctx.fillStyle = zone.side === 'buy' ? 'rgba(242,242,242,0.07)' : 'rgba(142,68,214,0.12)'
        ctx.fillRect(cellX, top, barsW - cellX, bottom - top)
        ctx.fillStyle = zone.side === 'buy' ? STACK_BUY_FILL : STACK_SELL_FILL
        ctx.fillRect(cellX, top, 2, bottom - top)
        for (let p = zone.low; p <= zone.high + 1e-9; p = Math.round((p + step) * 100) / 100) (zone.side === 'buy' ? stackedBuy : stackedSell).add(p)
      }

      for (const level of bar.levels) {
        const top = rowTop(level.price)
        const imb = bar.imbalances?.get(level.price)
        const sellStack = stackedSell.has(level.price)
        const buyStack = stackedBuy.has(level.price)
        ctx.fillStyle = sellStack ? STACK_SELL_FILL : imb === 'sell' ? SELL_FILL : `rgba(239,83,80,${0.06 + 0.32 * (level.sell / maxSide)})`
        ctx.fillRect(cellX, top + 0.5, cellW - 1, rowH - 1)
        ctx.fillStyle = buyStack ? STACK_BUY_FILL : imb === 'buy' ? BUY_FILL : `rgba(38,166,154,${0.06 + 0.32 * (level.buy / maxSide)})`
        ctx.fillRect(cellX + cellW, top + 0.5, cellW - 1, rowH - 1)
        if (showText) {
          ctx.font = `${imb ? '600 ' : ''}${textSize}px ${FONT}`
          ctx.textBaseline = 'middle'
          ctx.fillStyle = imb === 'sell' || sellStack ? '#fff' : '#e8c6c6'
          ctx.textAlign = 'right'
          ctx.fillText(formatVolume(level.sell, lotSize, showLots), cellX + cellW - 4, top + rowH / 2)
          ctx.fillStyle = buyStack ? '#111' : imb === 'buy' ? '#fff' : '#c4e8e3'
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

      // Absorption (ABS, green = bullish / red = bearish) and exhaustion (EXH, purple, arrow = the
      // expected turn): the row is outlined across the bar and a labelled pill sits on it, pointing
      // the way the signal reads.
      const marker = (price, side, label, color) => {
        const top = rowTop(price)
        ctx.strokeStyle = color
        ctx.lineWidth = 2
        ctx.strokeRect(cellX - 1, top - 0.5, cellW * 2 + 1, Math.max(3, rowH))
        ctx.lineWidth = 1
        const text = `${label} ${side === 'buy' ? '▲' : '▼'}`
        ctx.font = `700 10px ${FONT}`
        const w = ctx.measureText(text).width + 8
        const pillY = Math.max(FP_TOP, Math.min(FP_TOP + plotH - 14, top + rowH / 2 - 7))
        const pillX = Math.min(barsW - w - 1, x0 + colWidth - w - 2)
        ctx.fillStyle = color
        ctx.beginPath()
        if (ctx.roundRect) ctx.roundRect(pillX, pillY, w, 14, 3)
        else ctx.rect(pillX, pillY, w, 14)
        ctx.fill()
        ctx.fillStyle = '#fff'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, pillX + 4, pillY + 7.5)
      }
      for (const a of bar.absorption ?? []) marker(a.price, a.side, 'ABS', a.side === 'buy' ? UP_COLOR : DOWN_COLOR)
      for (const e of bar.exhaustion ?? []) marker(e.price, e.side, 'EXH', EXH_COLOR)
      ctx.restore()

      // Delta + volume strip and time label.
      clip(0, 0, barsW, height)
      const stripY = FP_TOP + plotH + 2
      ctx.fillStyle = 'rgba(255,255,255,0.03)'
      ctx.fillRect(x0 + 1, stripY, colWidth - 2, FP_STRIP_H - 4)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.font = `600 12px ${FONT}`
      ctx.fillStyle = bar.delta >= 0 ? UP_COLOR : DOWN_COLOR
      ctx.fillText(`Δ ${bar.delta >= 0 ? '+' : ''}${formatVolume(bar.delta, lotSize, showLots)}`, x0 + colWidth / 2, stripY + 9)
      ctx.font = `600 11px ${FONT}`
      ctx.fillStyle = (bar.cvd ?? 0) >= 0 ? '#7fd8cf' : '#f4a09e'
      ctx.fillText(`ΣΔ ${(bar.cvd ?? 0) >= 0 ? '+' : ''}${formatVolume(bar.cvd ?? 0, lotSize, showLots)}`, x0 + colWidth / 2, stripY + 23)
      ctx.font = `11px ${FONT}`
      ctx.fillStyle = AXIS_COLOR
      ctx.fillText(`Vol ${formatVolume(bar.volume, lotSize, showLots)}`, x0 + colWidth / 2, stripY + 37)
      if (colWidth >= 56 || k % 2 === 0) ctx.fillText(IST_HHMM.format(new Date(bar.time)), x0 + colWidth / 2, height - FP_TIME_H / 2)
      ctx.textAlign = 'left'
      ctx.strokeStyle = GRID_COLOR
      ctx.beginPath(); ctx.moveTo(x0, FP_TOP); ctx.lineTo(x0, FP_TOP + plotH); ctx.stroke()
      ctx.restore()
    })

    // Big orders: a dot at the print's price, placed inside its bar by its time, area ~ quantity.
    const dots = []
    if (trades?.length) {
      const bucketMs = Math.max(1, timeframe) * 60_000
      const index = new Map(visible.map((bar, k) => [typeof bar.time === 'number' ? bar.time : new Date(bar.time).getTime(), k]))
      const maxQty = Math.max(1, ...trades.map((t) => t.quantity))
      for (const t of trades) {
        const ms = new Date(t.time).getTime()
        const start = Math.floor(ms / bucketMs) * bucketMs
        const k = index.get(start)
        if (k == null) continue
        const y = rowTop(Math.round(Math.floor(t.price / step + 1e-9) * step * 100) / 100) + rowH / 2
        if (y < FP_TOP || y > FP_TOP + plotH) continue
        const x0 = barX(k)
        const x = x0 + 15 + ((ms - start) / bucketMs) * Math.max(4, colWidth - 30)
        if (x < 0 || x > barsW) continue
        const r = 4 + 11 * Math.sqrt(t.quantity / maxQty)
        dots.push({ x, y, r, trade: t })
      }
      dots.sort((a, b) => b.r - a.r)
      clip(0, FP_TOP, barsW, plotH)
      for (const d of dots) {
        ctx.beginPath(); ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2)
        ctx.fillStyle = d.trade.buy ? 'rgba(38,166,154,0.78)' : 'rgba(239,83,80,0.78)'
        ctx.fill()
        ctx.lineWidth = 1.5
        ctx.strokeStyle = '#ffffffdd'
        ctx.stroke()
        ctx.lineWidth = 1
      }
      ctx.restore()
    }
    dotsRef.current = dots

    // Session volume profile column, its value area and POC across the bars.
    if (profileW > 0) {
      const px = barsW + 2
      const pw = profileW - 6
      ctx.fillStyle = 'rgba(255,255,255,0.02)'
      ctx.fillRect(barsW, FP_TOP, profileW, plotH)
      ctx.strokeStyle = GRID_COLOR
      ctx.beginPath(); ctx.moveTo(barsW, FP_TOP); ctx.lineTo(barsW, FP_TOP + plotH); ctx.stroke()
      clip(barsW, FP_TOP, profileW, plotH)
      for (const row of profile.rows) {
        const top = rowTop(row.price)
        if (top + rowH < FP_TOP || top > FP_TOP + plotH) continue
        const inValue = row.price >= profile.val && row.price <= profile.vah
        const sellW = (row.sell / profile.maxRow) * pw
        const buyW = (row.buy / profile.maxRow) * pw
        ctx.fillStyle = inValue ? 'rgba(239,83,80,0.55)' : 'rgba(239,83,80,0.25)'
        ctx.fillRect(px, top + 0.5, sellW, Math.max(1, rowH - 1))
        ctx.fillStyle = inValue ? 'rgba(38,166,154,0.55)' : 'rgba(38,166,154,0.25)'
        ctx.fillRect(px + sellW, top + 0.5, buyW, Math.max(1, rowH - 1))
        if (row.price === profile.poc) {
          ctx.strokeStyle = POC_COLOR
          ctx.strokeRect(px + 0.5, top + 0.5, sellW + buyW, Math.max(1, rowH - 1))
        }
      }
      ctx.restore()
      const level = (price, label, color) => {
        if (price == null) return
        const isVal = label.endsWith('VAL')
        const isVah = label.endsWith('VAH')
        const y = isVal ? rowTop(price) + rowH : isVah ? rowTop(price) : rowTop(price) + rowH / 2
        if (y < FP_TOP || y > FP_TOP + plotH) return
        ctx.setLineDash(label.endsWith('POC') ? [] : [6, 4])
        ctx.strokeStyle = color
        ctx.globalAlpha = 0.7
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(barsW, y); ctx.stroke()
        ctx.globalAlpha = 1
        ctx.setLineDash([])
        ctx.fillStyle = color
        ctx.font = `600 10px ${FONT}`
        ctx.textBaseline = 'middle'
        ctx.textAlign = 'right'
        ctx.fillText(label, barsW + profileW - 3, Math.min(FP_TOP + plotH - 6, Math.max(FP_TOP + 6, y + (isVal ? -6 : isVah ? 6 : 0))))
        ctx.textAlign = 'left'
      }
      // ONE HVN (the strongest after the POC) and ONE LVN (the thinnest) - the previous session's.
      level(profile.hvnTop, 'HVN', PREV_PROFILE.hvn)
      level(profile.lvnTop, 'LVN', PREV_PROFILE.lvn)
      level(profile.vah, 'VAH', PREV_PROFILE.va)
      level(profile.val, 'VAL', PREV_PROFILE.va)
      level(profile.poc, 'POC', POC_COLOR)
      // Today's running profile in its own colours.
      if (runningProfile?.poc != null) {
        level(runningProfile.hvnTop, 'today HVN', RUNNING_PROFILE.hvn)
        level(runningProfile.lvnTop, 'today LVN', RUNNING_PROFILE.lvn)
        level(runningProfile.vah, 'today VAH', RUNNING_PROFILE.va)
        level(runningProfile.val, 'today VAL', RUNNING_PROFILE.va)
        level(runningProfile.poc, 'today POC', RUNNING_PROFILE.poc)
      }
    }

    // Marked levels (sudden OI walls): a dashed line across the bars, labelled at the left.
    for (const l of levels) {
      const y = yPrice(l.price + step / 2)
      if (!(y > FP_TOP && y < FP_TOP + plotH)) continue
      ctx.setLineDash([3, 3])
      ctx.strokeStyle = l.color
      ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(barsW, y); ctx.stroke()
      ctx.setLineDash([])
      ctx.lineWidth = 1
      ctx.font = `700 10px ${FONT}`
      ctx.textBaseline = 'middle'
      const w = ctx.measureText(l.label).width + 8
      ctx.fillStyle = l.color
      ctx.fillRect(2, y - 7, w, 14)
      ctx.fillStyle = '#000'
      ctx.fillText(l.label, 6, y)
    }

    // Price alerts: gold dashed lines across the chart, the level on the price axis.
    for (const a of alerts) {
      const y = yPrice(a.price + step / 2)
      if (!(y > FP_TOP && y < FP_TOP + plotH)) continue
      ctx.setLineDash([8, 4])
      ctx.strokeStyle = '#fadb14'
      ctx.globalAlpha = 0.85
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke()
      ctx.globalAlpha = 1
      ctx.setLineDash([])
      ctx.fillStyle = '#ad8b00'
      ctx.fillRect(plotW + 1, y - 9, FP_AXIS_W - 2, 18)
      ctx.fillStyle = '#fff'
      ctx.font = `600 11px ${FONT}`
      ctx.textBaseline = 'middle'
      ctx.fillText(`🔔${priceText(a.price)}`, plotW + 3, y)
    }

    // Session VWAP: one value per bar (`vwap`, aligned with `bars`), a line through the bars' centres.
    if (vwap?.length) {
      const { start } = layout
      ctx.save()
      ctx.beginPath(); ctx.rect(0, FP_TOP, barsW, plotH); ctx.clip()
      ctx.strokeStyle = VWAP_LINE_COLOR
      ctx.lineWidth = 2
      ctx.beginPath()
      let drawn = false
      let lastPoint = null
      visible.forEach((_, k) => {
        const v = vwap[start + k]
        if (!(v > 0)) return
        const x = barX(k) + colWidth / 2
        const y = yPrice(v)
        if (!drawn) { ctx.moveTo(x, y); drawn = true } else ctx.lineTo(x, y)
        lastPoint = { y, v }
      })
      ctx.stroke()
      ctx.restore()
      ctx.lineWidth = 1
      if (lastPoint && lastPoint.y > FP_TOP && lastPoint.y < FP_TOP + plotH) {
        ctx.fillStyle = VWAP_LINE_COLOR
        ctx.fillRect(plotW + 1, lastPoint.y - 9, FP_AXIS_W - 2, 18)
        ctx.fillStyle = '#000'
        ctx.font = `600 10px ${FONT}`
        ctx.textBaseline = 'middle'
        ctx.fillText(`VWAP ${lastPoint.v.toFixed(1)}`, plotW + 3, lastPoint.y)
      }
    }

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
  }, [layout, width, height, plotW, barsW, profileW, profile, runningProfile, plotH, colWidth, step, lotSize, showLots, lastPrice, trades, timeframe, alerts, levels, vwap])

  // The wheel listener is registered once; it reads the latest geometry through this.
  const geomRef = useRef({})
  useEffect(() => { geomRef.current = { layout, panFor, colWidth, plotW, plotH, step } })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // Wheel: wider/narrower bars. Shift+wheel (or the wheel over the price axis): taller/shorter rows
    // around the price under the cursor. A sideways trackpad swipe scrolls through time.
    const onWheel = (e) => {
      e.preventDefault()
      const g = geomRef.current
      const l = g.layout
      if (!l) return
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        setPan(g.panFor(l.endIdx + e.deltaX / g.colWidth))
        return
      }
      if (e.shiftKey || x > g.plotW) {
        setVview(zoomRows(l, e.deltaY < 0 ? 1.15 : 1 / 1.15, y, g.step, g.plotH))
        return
      }
      setColWidth((w) => Math.max(40, Math.min(240, w + (e.deltaY < 0 ? 10 : -10))))
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

  const resetView = () => { setPan(null); setVview(null) }

  const hitTest = (x, y) => {
    const dot = dotsRef.current.find((d) => (d.x - x) ** 2 + (d.y - y) ** 2 <= (d.r + 2) ** 2)
    if (dot) return { dot: dot.trade, x, y }
    if (!layout || x > barsW || y < FP_TOP || y > FP_TOP + plotH) return null
    const i = Math.floor(layout.endIdx - (barsW - x) / colWidth)
    if (i < layout.start || i >= layout.end) return null
    const bar = bars[i]
    if (!bar) return null
    const row = Math.round(Math.ceil((layout.hiPad - ((y - FP_TOP) / layout.rowH) * step) / step - 1e-9) * step * 100) / 100
    const level = bar.levels.find((l) => l.price === row)
    return { bar, level, row, x, y }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', height, userSelect: 'none' }}>
      <canvas
        ref={canvasRef}
        style={{ cursor: dragging ? 'grabbing' : 'crosshair', display: 'block', touchAction: 'none' }}
        onPointerDown={(e) => {
          if (!layout) return
          const rect = e.currentTarget.getBoundingClientRect()
          dragRef.current = {
            x: e.clientX, y: e.clientY, endIdx: layout.endIdx, top: layout.hiPad, rowH: layout.rowH,
            // Dragging on the price axis stretches the rows instead of moving them.
            axis: e.clientX - rect.left > plotW, vertical: !!vview,
          }
          e.currentTarget.setPointerCapture(e.pointerId)
          setDragging(true)
        }}
        onPointerMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          const d = dragRef.current
          if (d) {
            const dx = e.clientX - d.x
            const dy = e.clientY - d.y
            setHover(null)
            if (d.axis) {
              setVview(zoomRows({ hiPad: d.top, rowH: d.rowH }, Math.exp(-dy / 120), plotH / 2 + FP_TOP, step, plotH))
              return
            }
            setPan(panFor(d.endIdx - dx / colWidth))
            // Up/down moves the prices too, once the drag is clearly vertical (a sideways drag with a
            // little jitter keeps the auto-fit).
            if (d.vertical || Math.abs(dy) > 8) {
              d.vertical = true
              setVview({ top: d.top + (dy / d.rowH) * step, rowH: d.rowH })
            }
          } else setHover(hitTest(e.clientX - rect.left, e.clientY - rect.top))
        }}
        onPointerUp={() => { dragRef.current = null; setDragging(false) }}
        onPointerCancel={() => { dragRef.current = null; setDragging(false) }}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={resetView}
      />
      <div style={{ position: 'absolute', top: 8, left: 8, display: 'flex', gap: 4 }}>
        <Button size="small" onClick={() => setColWidth((w) => Math.max(40, w - 16))} aria-label="Narrower bars">−</Button>
        <Button size="small" onClick={() => setColWidth((w) => Math.min(240, w + 16))} aria-label="Wider bars">+</Button>
        <Button size="small" onClick={() => layout && setVview(zoomRows(layout, 1 / 1.25, FP_TOP + plotH / 2, step, plotH))} aria-label="Shorter rows">↕−</Button>
        <Button size="small" onClick={() => layout && setVview(zoomRows(layout, 1.25, FP_TOP + plotH / 2, step, plotH))} aria-label="Taller rows">↕+</Button>
      </div>
      {(pan || vview) && (
        <Button size="small" style={{ position: 'absolute', top: 8, right: FP_AXIS_W + profileW + 8 }} onClick={resetView}
          title="Follow the latest bar with prices fitted again (or double-click the chart)">
          {pan ? 'Back to latest ▸' : 'Auto-fit prices'}
        </Button>
      )}
      {hover?.dot && (
        <div style={{
          position: 'absolute', left: Math.min(hover.x + 14, width - 220), top: Math.max(0, hover.y - 50), pointerEvents: 'none',
          background: '#141821ee', border: `1px solid ${BORDER_COLOR}`, borderRadius: 6, padding: '6px 9px', fontSize: 12, lineHeight: 1.5, width: 210,
        }}>
          <div style={{ color: hover.dot.buy ? UP_COLOR : DOWN_COLOR, fontWeight: 600 }}>{bigLabel}: {hover.dot.buy ? 'BUY' : 'SELL'} {formatVolume(hover.dot.quantity, lotSize, true)} lots</div>
          <div>at {priceText(hover.dot.price)} · {IST_HHMMSS.format(new Date(hover.dot.time))}</div>
        </div>
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
export function DepthHeatmap({ columns, rowSize, trades, icebergs, signals = [], marks = [], vwap = null, lotSize, showLots, height = 420 }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const width = useElementWidth(wrapRef)
  const [hover, setHover] = useState(null)
  // Zoom / pan, both axes - kept until reset (double-click or ⟲):
  //   hview: null = every column that fits, following the latest; else { cols, endT } = that many
  //          columns ending at the column stamped endT (null endT = the latest).
  //   vview: null = prices fitted to the book; else { top, rowH }.
  const [hview, setHview] = useState(null)
  const [vview, setVview] = useState(null)
  const dragRef = useRef(null)
  const step = rowSize > 0 ? rowSize : 0.05
  const plotW = Math.max(0, width - HM_AXIS_W)
  const plotH = Math.max(50, height - HM_TIME_H)

  const layout = useMemo(() => {
    if (!width || columns.length === 0) return null
    const maxCols = Math.max(10, Math.min(columns.length, hview?.cols ?? Math.floor(plotW / 2)))
    let end = columns.length
    if (hview?.endT != null) {
      const i = columns.findLastIndex((c) => c.t <= hview.endT)
      if (i >= 0) end = i + 1
    }
    const start = Math.max(0, end - maxCols)
    const visible = columns.slice(start, Math.max(start + 1, end))
    const mids = visible.map((c) => {
      const bestBid = c.bids.length ? Math.max(...c.bids.map((b) => b[0])) : null
      const bestAsk = c.asks.length ? Math.min(...c.asks.map((a) => a[0])) : null
      return bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : bestBid ?? bestAsk
    })
    // Keep the view readable on a trending day - about 160 rows centred on the latest mid - but never cut the latest
    // book: all of its levels (200 a side on the full depth) stay in view.
    const range = heatmapPriceRange(visible, step, mids.filter((m) => m != null).at(-1))
    if (!range) return null
    const { hi, lo } = range
    const quantities = []
    for (const c of visible) for (const side of [c.bids, c.asks]) for (const [, q] of side) quantities.push(q)
    quantities.sort((a, b) => a - b)
    // Linear against the 98th percentile: ordinary liquidity stays blue, walls stand out hot.
    const cap = quantities[Math.floor(quantities.length * 0.98)] || 1
    let hiPad = hi + step
    let nRows = Math.round((hiPad - (lo - step)) / step) + 1
    let rowH = plotH / nRows
    if (vview) {
      hiPad = vview.top
      rowH = vview.rowH
      nRows = Math.ceil(plotH / rowH) + 1
    }
    return { visible, mids, hiPad, nRows, rowH, colW: plotW / visible.length, cap, t0: visible[0].t, t1: visible[visible.length - 1].t, start, end }
  }, [columns, width, plotW, plotH, step, hview, vview])

  // Rows `factor` times taller around the price at height y (factor > 1 = zoom in); the top stays on a row.
  const zoomRowsAt = (factor, y = plotH / 2) => {
    if (!layout) return
    const rowH = Math.max(1, Math.min(40, layout.rowH * factor))
    const price = layout.hiPad - (y / layout.rowH) * step
    setVview({ top: Math.round((price + (y / rowH) * step) / step) * step, rowH })
  }
  // `factor` times fewer columns (zoom in), keeping the right edge.
  const zoomColsBy = (factor) => {
    if (!layout) return
    const cols = Math.max(10, Math.min(columns.length, Math.round(layout.visible.length / factor)))
    setHview((h) => ({ cols, endT: h?.endT ?? null }))
  }
  const resetView = () => { setHview(null); setVview(null) }
  const zoomRef = useRef({})
  useEffect(() => { zoomRef.current = { zoomRowsAt, zoomColsBy, plotW } })
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    // Wheel = time zoom; Shift+wheel or the wheel over the price axis = price zoom at the cursor.
    const onWheel = (e) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const z = zoomRef.current
      if (e.shiftKey || e.clientX - rect.left > z.plotW) z.zoomRowsAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientY - rect.top)
      else z.zoomColsBy(e.deltaY < 0 ? 1.15 : 1 / 1.15)
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

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
    // Zoomed or panned, nothing may spill onto the axes.
    ctx.save()
    ctx.beginPath(); ctx.rect(0, 0, plotW, plotH); ctx.clip()

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

    // Liquidity map marks: zones as translucent bands, levels as dashed lines, labelled at the right.
    for (const m of marks) {
      ctx.font = `700 10px ${FONT}`
      ctx.textBaseline = 'middle'
      if (m.band) {
        const yTop = yPrice(m.high) - rowH / 2
        const yBottom = yPrice(m.low) + rowH / 2
        if (yBottom < 0 || yTop > plotH) continue
        ctx.fillStyle = m.color
        ctx.globalAlpha = 0.18
        ctx.fillRect(0, yTop, plotW, yBottom - yTop)
        ctx.globalAlpha = 1
        if (m.label) { ctx.fillStyle = m.color; ctx.fillText(m.label, 4, Math.max(8, Math.min(plotH - 8, (yTop + yBottom) / 2))) }
        continue
      }
      const y = yPrice(m.price)
      if (y < 0 || y > plotH) continue
      ctx.setLineDash(m.dash ?? [6, 4])
      ctx.strokeStyle = m.color
      ctx.lineWidth = m.width ?? 1.5
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke()
      ctx.setLineDash([])
      ctx.lineWidth = 1
      if (m.label) {
        const w = ctx.measureText(m.label).width + 8
        ctx.fillStyle = m.color
        ctx.fillRect(plotW - w - 2, y - 7, w, 14)
        ctx.fillStyle = '#000'
        ctx.fillText(m.label, plotW - w + 2, y)
      }
    }

    // Session VWAP over time (`vwap`: [{ t (ms), value }]).
    if (vwap?.length) {
      ctx.strokeStyle = VWAP_LINE_COLOR
      ctx.lineWidth = 2
      ctx.beginPath()
      let started = false
      for (const p of vwap) {
        if (p.t < t0 || p.t > t1 || !(p.value > 0)) continue
        const x = xTime(p.t)
        const y = yPrice(p.value)
        if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
      }
      ctx.stroke()
      ctx.lineWidth = 1
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

    // Liquidity signals: a labelled pill at the signal's price and time (green = bullish, red =
    // bearish), with its confidence.
    const SHORT = {
      Magnet: 'MAGNET', 'Wall absorption': 'ABS', 'Exhaustion into wall': 'EXH', Spoofing: 'SPOOF',
      'Liquidity pulled': 'PULL', 'Liquidity stacked': 'STACK', 'Buy sweep': 'SWEEP', 'Sell sweep': 'SWEEP',
    }
    for (const sig of signals ?? []) {
      if (sig.t < t0 || sig.t > t1) continue
      const x = xTime(sig.t)
      const y = yPrice(sig.price)
      if (y < 0 || y > plotH) continue
      const label = `${SHORT[sig.kind] ?? sig.kind} ${sig.confidence}%`
      ctx.font = `700 10px ${FONT}`
      const w = ctx.measureText(label).width + 8
      const px = Math.min(plotW - w - 1, Math.max(1, x - w / 2))
      const py = Math.max(1, Math.min(plotH - 15, y - 20))
      ctx.fillStyle = sig.bullish ? 'rgba(38,166,154,0.92)' : 'rgba(239,83,80,0.92)'
      ctx.beginPath()
      if (ctx.roundRect) ctx.roundRect(px, py, w, 14, 3)
      else ctx.rect(px, py, w, 14)
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.beginPath(); ctx.moveTo(x, py + 14); ctx.lineTo(x, y); ctx.stroke()
      ctx.fillStyle = '#fff'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, px + 4, py + 7.5)
    }

    ctx.restore()

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
    // The time axis: IST at every :00 / :30 in view (every hour, 2 h ... when zoomed out - halfHourMarks.js); with fewer than
    // two in view, evenly spaced times as before.
    const istSeconds = visible.map((c) => Math.floor(c.t / 1000) + IST_OFFSET_S)
    const spanS = (t1 - t0) / 1000
    const checks = spanS > 0 ? checkpoints(istSeconds, checkpointStep((plotW - colW) / spanS)) : []
    if (checks.length >= 2) {
      for (const c of checks) ctx.fillText(c.label, Math.min(plotW - 20, Math.max(20, xTime((c.time - IST_OFFSET_S) * 1000))), plotH + HM_TIME_H / 2)
    } else {
      const labels = Math.max(2, Math.floor(plotW / 110))
      for (let i = 0; i <= labels; i++) {
        const t = t0 + ((t1 - t0) * i) / labels
        ctx.fillText(IST_HHMM.format(new Date(t)), Math.min(plotW - 20, Math.max(20, xTime(t))), plotH + HM_TIME_H / 2)
      }
    }
    ctx.textAlign = 'left'
  }, [layout, width, height, plotW, plotH, step, trades, icebergs, signals, marks, vwap, lotSize])

  // The figures of the cell under a pointer (mouse hover or a finger's touch): its price, time, the bids and offers resting
  // there; null off the plot.
  const hoverAt = (e) => {
    if (!layout) return null
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const col = layout.visible[Math.floor(x / layout.colW)]
    if (!col || y < 0 || y > plotH) return null
    const row = Math.round((layout.hiPad - Math.floor(y / layout.rowH) * step) * 100) / 100
    const bid = col.bids.find((b) => b[0] === row)?.[1]
    const ask = col.asks.find((a) => a[0] === row)?.[1]
    return { x, y, row, t: col.t, bid, ask }
  }

  return (
    <div ref={wrapRef} style={{ position: 'relative', width: '100%', height }}>
      <canvas
        ref={canvasRef}
        style={{ display: 'block', cursor: 'crosshair', touchAction: 'none' }}
        onPointerDown={(e) => {
          if (!layout) return
          dragRef.current = { x: e.clientX, y: e.clientY, end: layout.end, cols: layout.visible.length, top: layout.hiPad, rowH: layout.rowH, colW: layout.colW, vertical: !!vview, moved: false }
          e.currentTarget.setPointerCapture(e.pointerId)
          // A finger has no hover: the touch itself shows that cell's figures (kept after lifting - see onPointerUp).
          if (e.pointerType !== 'mouse') setHover(hoverAt(e))
        }}
        onPointerUp={(e) => {
          const d = dragRef.current
          dragRef.current = null
          // A tap (no drag) on a touch screen shows the tapped cell and keeps it until the next tap.
          if (e.pointerType !== 'mouse' && d && !d.moved) setHover(hoverAt(e))
        }}
        onPointerCancel={() => { dragRef.current = null }}
        onDoubleClick={resetView}
        onPointerMove={(e) => {
          if (!layout) return
          const d = dragRef.current
          if (d && (d.moved || Math.abs(e.clientX - d.x) > 6 || Math.abs(e.clientY - d.y) > 6)) {
            // Drag sideways through time; up/down through prices once the drag is clearly vertical.
            d.moved = true
            setHover(null)
            const shift = Math.round((e.clientX - d.x) / d.colW)
            if (shift !== 0 || hview) {
              const end = Math.max(Math.min(d.cols, columns.length), Math.min(columns.length, d.end - shift))
              setHview({ cols: d.cols, endT: end >= columns.length ? null : columns[end - 1].t })
            }
            if (d.vertical || Math.abs(e.clientY - d.y) > 8) {
              d.vertical = true
              setVview({ top: Math.round((d.top + ((e.clientY - d.y) / d.rowH) * step) / step) * step, rowH: d.rowH })
            }
            return
          }
          if (d) return
          setHover(hoverAt(e))
        }}
        // A finger lifting also "leaves" - keep the tapped cell's figures on a touch screen.
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHover(null) }}
      />
      <div style={{ position: 'absolute', left: 6, bottom: HM_TIME_H + 4, display: 'flex', gap: 3 }}>
        <Button size="small" onClick={() => zoomColsBy(1 / 1.25)} aria-label="Heatmap zoom out (time)">⟷−</Button>
        <Button size="small" onClick={() => zoomColsBy(1.25)} aria-label="Heatmap zoom in (time)">⟷+</Button>
        <Button size="small" onClick={() => zoomRowsAt(1 / 1.25)} aria-label="Heatmap zoom out (price)">↕−</Button>
        <Button size="small" onClick={() => zoomRowsAt(1.25)} aria-label="Heatmap zoom in (price)">↕+</Button>
        {(hview || vview) && <Button size="small" onClick={resetView} aria-label="Heatmap reset zoom">⟲ {hview?.endT != null ? 'Latest' : 'Reset'}</Button>}
      </div>
      {hover && (hover.bid != null || hover.ask != null) && (
        <div style={{
          position: 'absolute', left: Math.min(hover.x + 14, width - 190), top: Math.max(0, hover.y - 50), pointerEvents: 'none',
          background: '#141821ee', border: `1px solid ${BORDER_COLOR}`, borderRadius: 6, padding: '6px 9px', fontSize: 12, lineHeight: 1.5,
        }}>
          <div><b>{priceText(hover.row)}</b> · {IST_HHMMSS.format(new Date(hover.t))}</div>
          {hover.bid != null && <div style={{ color: UP_COLOR }}>Bids resting: {formatVolume(hover.bid, lotSize, showLots)}{showLots ? ' lots' : ''}</div>}
          {hover.ask != null && <div style={{ color: DOWN_COLOR }}>Offers resting: {formatVolume(hover.ask, lotSize, showLots)}{showLots ? ' lots' : ''}</div>}
          {(() => {
            // Bids minus offers at this price: which side is heavier, and by how much.
            const diff = (hover.bid ?? 0) - (hover.ask ?? 0)
            const unit = showLots ? ' lots' : ''
            return (
              <div style={{ color: diff > 0 ? UP_COLOR : diff < 0 ? DOWN_COLOR : undefined }}>
                Difference: {diff > 0 ? '+' : diff < 0 ? '−' : ''}{formatVolume(Math.abs(diff), lotSize, showLots)}{unit}
                {diff !== 0 && ` (${diff > 0 ? 'bids' : 'offers'} heavier)`}
              </div>
            )
          })()}
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
    const chart = createZoomableChart(containerRef.current, {
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
    deltaRef.current.setData(bars.map((b) => ({ time: toChartTime(new Date(b.time)), value: b.delta * scale, color: `${b.delta >= 0 ? UP_COLOR : DOWN_COLOR}${b.estimated ? '73' : ''}` })))
    cvdRef.current.setData(bars.map((b) => ({ time: toChartTime(new Date(b.time)), value: b.cvd * scale })))
  }, [bars, scale])

  useFitContentAsDataGrows(chartRef, bars.length, dayKey)

  return <div ref={containerRef} style={{ width: '100%', height }} />
}

// ---- Book ladder ----------------------------------------------------------------------------

// The live book: offers above, bids below, each row's quantity as a bar; walls (far larger than the
// rest of the book) highlighted, and prices with a live iceberg tagged.
// The bid share of the book at each depth (top 20, top 50, all of it) - the lean near the price against through the book.
function DepthShares({ book }) {
  const deepest = Math.max(book?.bids?.length ?? 0, book?.asks?.length ?? 0)
  const depths = [20, 50, deepest].filter((d, i, all) => d > 0 && d <= deepest && all.indexOf(d) === i)
  const parts = depths.map((d) => ({ d, share: bidShare(book, d) })).filter((p) => p.share != null)
  if (parts.length < 2) return null
  return (
    <div style={{ fontSize: 11, color: AXIS_COLOR, marginTop: 2 }}>
      Bids share by depth -{' '}
      {parts.map((p, i) => (
        <span key={p.d}>
          {i > 0 ? ' · ' : ''}{p.d === deepest && p.d > 50 ? `all ${p.d}` : `top ${p.d}`}{' '}
          <span style={{ color: p.share >= 0.55 ? UP_COLOR : p.share <= 0.45 ? DOWN_COLOR : AXIS_COLOR, fontWeight: 600 }}>{Math.round(p.share * 100)}%</span>
        </span>
      ))}
    </div>
  )
}

export function BookLadder({ book, walls, icebergPrices, lotSize, showLots, maxRows = 20, height = null }) {
  const asks = (book?.asks ?? []).slice(0, maxRows)
  const bids = (book?.bids ?? []).slice(0, maxRows)
  const max = Math.max(1, ...asks.map((l) => l.quantity), ...bids.map((l) => l.quantity))
  // Scrollable (`height`): opened on the spread, and back on it when the number of rows changes.
  const scrollRef = useRef(null)
  const spreadRef = useRef(null)
  const hasBook = asks.length > 0 || bids.length > 0
  useEffect(() => {
    const box = scrollRef.current
    const spread = spreadRef.current
    if (box && spread) box.scrollTop = spread.offsetTop - box.offsetTop - box.clientHeight / 2
  }, [maxRows, height, hasBook])
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
          {icebergPrices?.has(level.price) ? <Tag color="purple" style={{ margin: 0, fontSize: 10, padding: '0 3px', lineHeight: '14px' }}>ICE</Tag> : level.orders || ''}
        </span>
      </div>
    )
  }

  return (
    <div>
      <div ref={scrollRef} style={height ? { maxHeight: height, overflowY: 'auto', position: 'relative' } : undefined}>
        {[...asks].reverse().map((l) => row(l, 'ask'))}
        <div ref={spreadRef} style={{ borderTop: `1px solid ${BORDER_COLOR}`, margin: '3px 0' }} />
        {bids.map((l) => row(l, 'bid'))}
      </div>
      <div style={{ fontSize: 11, color: AXIS_COLOR, marginTop: 6 }}>
        Shown depth ({Math.max(asks.length, bids.length)} rows) - bids {formatVolume(totalBid, lotSize, showLots)} vs offers {formatVolume(totalAsk, lotSize, showLots)}
        {totalBid + totalAsk > 0 ? ` (${Math.round((totalBid / (totalBid + totalAsk)) * 100)}% bids)` : ''} · right column = orders
      </div>
      <DepthShares book={book} />
    </div>
  )
}
