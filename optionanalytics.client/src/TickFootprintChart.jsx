import { useEffect, useMemo, useRef, useState } from 'react'
import { barStats, diagonalImbalances, fmtQty, msOf } from './tickFlowMath.js'

// The Tick Flow page's FOOTPRINT: bars side by side, each a ladder of price rows with the sellers (bid) on the left and the buyers
// (ask) on the right, drawn on a canvas. Its own drawing - nothing shared with the Order Flow page. Cells are shaded by the row's
// share of the bar's largest row, diagonal imbalances are outlined, the POC row is boxed, and under every bar its delta, cumulative
// delta and volume. Wheel: how many bars show; Shift + wheel: row height; drag: move back in time; double-click: back to the latest and the default row height.

const COLORS = { buy: '#26a69a', sell: '#ef5350', text: '#d9d9d9', grid: '#1f2937', axis: '#8c8c8c', bg: '#0b1220', last: '#1668dc', poc: '#faad14' }
const AXIS_W = 62
const STRIP_H = 64

export function TickFootprintChart({ bars, cvd, rowSize, lotSize, showLots, lastPrice, height: maxHeight = 640, imbalanceRatio = 3, rowDelta = false }) {
  const wrap = useRef(null)
  const canvas = useRef(null)
  const [width, setWidth] = useState(900)
  const [picked, setPicked] = useState(null) // bars shown, once the wheel has set it
  const [rowZoom, setRowZoom] = useState(1)   // Shift + wheel: taller or shorter rows
  const [offset, setOffset] = useState(0) // bars hidden at the right (0 = the latest on screen)
  const drag = useRef(null)
  const visibleRef = useRef(14)

  useEffect(() => {
    const el = wrap.current
    if (!el) return undefined
    const ro = new ResizeObserver(() => setWidth(Math.max(320, el.clientWidth)))
    ro.observe(el)
    setWidth(Math.max(320, el.clientWidth))
    return () => ro.disconnect()
  }, [])

  // By default as many bars as fit at a readable width (~74 px each): a phone shows 4, a monitor 15+.
  const visible = picked ?? Math.max(4, Math.floor((width - AXIS_W) / 74))
  useEffect(() => { visibleRef.current = visible }, [visible])
  const n = bars.length
  const last = Math.max(0, n - offset)
  const first = Math.max(0, last - visible)
  const shown = useMemo(() => bars.slice(first, last), [bars, first, last])

  const layout = useMemo(() => {
    let hi = -Infinity
    let lo = Infinity
    for (const b of shown) { hi = Math.max(hi, b.high); lo = Math.min(lo, b.low) }
    if (!Number.isFinite(hi)) return null
    // Everything is laid out on row boundaries (a bar's levels are row prices), so the grid, the labels and the cells agree.
    const hiRow = Math.floor(hi / rowSize + 1e-9) * rowSize
    const loRow = Math.floor(lo / rowSize + 1e-9) * rowSize
    const rows = Math.max(1, Math.round((hiRow - loRow) / rowSize) + 1)
    const top = hiRow + rowSize
    const plotH = maxHeight - STRIP_H - 18
    const rowH = Math.max(4, Math.min(70, Math.min(34, plotH / (rows + 2)) * rowZoom))
    return { hi, lo, hiRow, loRow, top, rows, rowH, plotH, needed: Math.ceil(10 + (rows + 1) * rowH + 8 + STRIP_H) }
  }, [shown, rowSize, maxHeight, rowZoom])

  // The canvas is as tall as its content (never past the height asked for): a few rows do not leave a screen of empty chart.
  const wanted = layout ? Math.max(260, Math.min(rowZoom > 1 ? 3000 : maxHeight, layout.needed)) : maxHeight
  const height = wanted

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = width * dpr
    c.height = height * dpr
    const g = c.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.fillStyle = COLORS.bg
    g.fillRect(0, 0, width, height)
    if (!layout || shown.length === 0) return
    const { top, rowH } = layout
    const plotW = width - AXIS_W
    const colW = plotW / Math.max(visible, shown.length)
    const y = (price) => 10 + ((top - price) / rowSize) * rowH
    // Price axis + grid.
    g.font = '11px sans-serif'
    g.textBaseline = 'middle'
    g.textAlign = 'left'
    // A label on a row boundary, every few rows so the numbers never touch.
    const every = Math.max(1, Math.ceil(14 / rowH))
    for (let i = 0; i <= layout.rows; i += every) {
      const price = Math.round((layout.hiRow - i * rowSize) * 1e4) / 1e4
      const yy = y(price) + rowH / 2
      g.strokeStyle = COLORS.grid
      g.beginPath(); g.moveTo(0, yy); g.lineTo(plotW, yy); g.stroke()
      g.fillStyle = COLORS.axis
      g.fillText(String(price), plotW + 6, yy)
    }
    const cells = colW >= 58 && rowH >= 9
    const fontPx = Math.max(8, Math.min(12, Math.floor(rowH - 2), Math.floor(colW / 7)))
    const deltas = cvd ?? []
    shown.forEach((b, i) => {
      const x0 = i * colW
      const innerW = colW - 6
      const rowsMax = Math.max(1, ...b.levels.map((l) => l.buy + l.sell))
      const imb = diagonalImbalances(b.levels, imbalanceRatio, 1)
      const stats = barStats(b)
      // Candle wick + body down the bar's left edge.
      const cx = x0 + 3
      g.strokeStyle = b.close >= b.open ? COLORS.buy : COLORS.sell
      g.fillStyle = g.strokeStyle
      g.beginPath(); g.moveTo(cx, y(b.high)); g.lineTo(cx, y(b.low) + rowH); g.stroke()
      g.fillRect(cx - 2, Math.min(y(b.open), y(b.close)), 4, Math.max(2, Math.abs(y(b.open) - y(b.close)) + 2))
      const left = x0 + 8
      const cellW = Math.max(6, (innerW - 6) / 2)
      for (const l of b.levels) {
        const yy = y(l.price)
        const sellShade = Math.min(1, l.sell / rowsMax)
        const buyShade = Math.min(1, l.buy / rowsMax)
        g.fillStyle = `rgba(239,83,80,${0.12 + 0.55 * sellShade})`
        g.fillRect(left, yy, cellW - 1, rowH - 1)
        g.fillStyle = `rgba(38,166,154,${0.12 + 0.55 * buyShade})`
        g.fillRect(left + cellW, yy, cellW - 1, rowH - 1)
        if (imb.sell.has(l.price)) { g.strokeStyle = COLORS.sell; g.lineWidth = 1.5; g.strokeRect(left + 0.5, yy + 0.5, cellW - 2, rowH - 2) }
        if (imb.buy.has(l.price)) { g.strokeStyle = COLORS.buy; g.lineWidth = 1.5; g.strokeRect(left + cellW + 0.5, yy + 0.5, cellW - 2, rowH - 2) }
        g.lineWidth = 1
        if (l.price === stats.poc) { g.strokeStyle = COLORS.poc; g.strokeRect(left - 0.5, yy - 0.5, cellW * 2, rowH) }
        if (cells) {
          g.font = `${fontPx}px sans-serif`
          if (rowDelta) {
            // Delta per row: the one number, centred, in the colour of the side that won the row.
            g.textAlign = 'center'
            g.fillStyle = l.buy >= l.sell ? COLORS.buy : COLORS.sell
            g.fillText(fmtQty(l.buy - l.sell, lotSize, showLots), left + cellW, yy + rowH / 2)
          } else {
            g.fillStyle = COLORS.text
            g.textAlign = 'right'
            g.fillText(fmtQty(l.sell, lotSize, showLots), left + cellW - 3, yy + rowH / 2)
            g.textAlign = 'left'
            g.fillText(fmtQty(l.buy, lotSize, showLots), left + cellW + 3, yy + rowH / 2)
          }
        }
      }
      // The strip under the bars: delta, cumulative delta, volume, time (fewer lines when the bar is narrow).
      const sy = 10 + (layout.rows + 1) * rowH + 8
      g.font = '11px sans-serif'
      g.textAlign = 'center'
      g.fillStyle = stats.delta >= 0 ? COLORS.buy : COLORS.sell
      g.fillText(`Δ ${stats.delta >= 0 ? '+' : ''}${fmtQty(stats.delta, lotSize, showLots)}`, x0 + colW / 2, sy + 8)
      const cum = deltas[first + i]
      if (cum != null) { g.fillStyle = cum >= 0 ? COLORS.buy : COLORS.sell; g.fillText(`ΣΔ ${cum >= 0 ? '+' : ''}${fmtQty(cum, lotSize, showLots)}`, x0 + colW / 2, sy + 22) }
      if (colW < 58) { g.fillStyle = COLORS.axis; g.font = '10px sans-serif'; g.fillText(new Date(msOf(b.time)).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }), x0 + colW / 2, sy + 36); return }
      g.fillStyle = COLORS.axis
      g.fillText(`Vol ${fmtQty(stats.total, lotSize, showLots)}`, x0 + colW / 2, sy + 36)
      g.fillText(new Date(msOf(b.time)).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' }), x0 + colW / 2, sy + 50)
    })
    // The last price.
    if (lastPrice > 0 && lastPrice < top + rowSize && lastPrice >= layout.loRow - rowSize) {
      const yy = y(Math.floor(lastPrice / rowSize) * rowSize) + rowH / 2
      g.strokeStyle = COLORS.last; g.setLineDash([4, 3])
      g.beginPath(); g.moveTo(0, yy); g.lineTo(plotW, yy); g.stroke(); g.setLineDash([])
      g.fillStyle = COLORS.last; g.fillRect(plotW, yy - 9, AXIS_W, 18)
      g.fillStyle = '#fff'; g.textAlign = 'left'; g.font = '11px sans-serif'; g.fillText(String(lastPrice), plotW + 6, yy)
    }
  }, [shown, layout, width, height, visible, rowSize, lotSize, showLots, lastPrice, cvd, first, imbalanceRatio, rowDelta])

  const onWheel = (e) => {
    e.preventDefault()
    if (e.shiftKey) { setRowZoom((z) => Math.max(0.4, Math.min(3, z * (e.deltaY > 0 ? 0.87 : 1.15)))); return }
    setPicked((p) => Math.max(3, Math.min(120, Math.round((p ?? visibleRef.current) * (e.deltaY > 0 ? 1.15 : 0.87)))))
  }
  useEffect(() => {
    const el = canvas.current
    if (!el) return undefined
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  return (
    <div ref={wrap} style={{ width: '100%' }}>
      <canvas
        ref={canvas} style={{ width: '100%', height, cursor: 'grab', display: 'block', touchAction: 'pan-y' }}
        onPointerDown={(e) => { drag.current = { x: e.clientX, offset }; e.currentTarget.setPointerCapture?.(e.pointerId) }}
        onPointerMove={(e) => {
          if (!drag.current) return
          const colW = (width - AXIS_W) / visible
          const moved = Math.round((e.clientX - drag.current.x) / colW)
          setOffset(Math.max(0, Math.min(Math.max(0, n - 1), drag.current.offset + moved)))
        }}
        onPointerUp={() => { drag.current = null }}
        onDoubleClick={() => { setOffset(0); setRowZoom(1) }}
      />
    </div>
  )
}
