import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { axisTicks } from './tickFlowMath.js'
import { profileLevels, standouts } from './tickDeltaProfile.js'

// The Tick Flow page's PROFILE CHART (asked for - OI Replay's delta profile look on TrueData's data): candles on the left, a panel of profile columns at the
// right on the SAME price rows - a VOLUME column (grey, the value area brighter, the POC amber, POC / VAH / VAL lines across the candles) and any number of
// DELTA columns (green right of their centre line, red left; `bullishNegative` flips it for the OI's CE - PE), the biggest buying rows tagged B1 / B2 and the
// biggest selling S1 / S2. Canvas, this page's own - nothing shared with OI Replay's chart. Candles stand from the left (30 slots at least).
const GREEN = '#26a69a'
const RED = '#ef5350'
const B1 = '#00e676'
const B2 = '#40c4ff'
const S1 = '#ff1744'
const S2 = '#ff9100'
const AMBER = '#faad14'
const AXIS_W = 58
const TOP = 18
const MIN_SLOTS = 30

const num = (v) => Math.round(v).toLocaleString('en-IN')

/**
 * candles [{ time (ms), open, high, low, close }]; rows (high to low, { price, ...values }); rowSize in points; columns [{ key, title, kind: 'volume' | 'delta',
 * bullishNegative? }]; `unit` the values' unit in the readout ('lots'). `rangeNote` is drawn nowhere - the card says it.
 */
export function TickProfileChart({ candles, rows, rowSize, columns, unit = 'lots', height = 420, levels = true }) {
  const wrap = useRef(null)
  const canvas = useRef(null)
  const [width, setWidth] = useState(600)
  const [hover, setHover] = useState(null)
  const narrow = width < 560

  useEffect(() => {
    const el = wrap.current
    if (!el) return undefined
    const ro = new ResizeObserver(() => setWidth(Math.max(280, Math.floor(el.clientWidth))))
    ro.observe(el)
    setWidth(Math.max(280, Math.floor(el.clientWidth)))
    return () => ro.disconnect()
  }, [])

  const colW = narrow ? 76 : 112
  const panelW = Math.min(width * 0.62, colW * columns.length)
  const plotW = width - AXIS_W - panelW
  const colWidth = panelW / Math.max(1, columns.length)

  // The price range: the candles' own, widened to the profile rows within 1% of them (an old session's far rows would squash the candles).
  const range = useMemo(() => {
    let lo = Infinity
    let hi = -Infinity
    for (const c of candles) { if (c.low < lo) lo = c.low; if (c.high > hi) hi = c.high }
    const pad = Number.isFinite(lo) ? (hi + lo) / 2 * 0.01 : 0
    for (const r of rows) {
      if (Number.isFinite(lo) && (r.price + rowSize < lo - pad || r.price > hi + pad)) continue
      lo = Math.min(lo, r.price); hi = Math.max(hi, r.price + rowSize)
    }
    if (!Number.isFinite(lo)) return null
    if (hi - lo < rowSize * 4) { hi += rowSize * 2; lo -= rowSize * 2 }
    const margin = (hi - lo) * 0.04
    return { lo: lo - margin, hi: hi + margin }
  }, [candles, rows, rowSize])

  const model = useMemo(() => {
    const vol = columns.find((c) => c.kind === 'volume')
    const lv = vol && levels ? profileLevels(rows.map((r) => ({ price: r.price, vol: r[vol.key] }))) : null
    const maxes = Object.fromEntries(columns.map((c) => [c.key, Math.max(1e-9, ...rows.map((r) => Math.abs(r[c.key] ?? 0)))]))
    const marks = Object.fromEntries(columns.filter((c) => c.kind === 'delta').map((c) => [c.key, standouts(rows, c.key, !!c.bullishNegative)]))
    return { vol, lv, maxes, marks }
  }, [columns, rows, levels])

  const y = useCallback((p) => TOP + (1 - (p - range.lo) / (range.hi - range.lo)) * (height - TOP - 4), [range, height])

  useEffect(() => {
    const cv = canvas.current
    if (!cv || !range) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.floor(width * dpr); cv.height = Math.floor(height * dpr)
    const g = cv.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, height)
    g.font = '11px system-ui, sans-serif'
    const panelX = plotW
    // grid + price axis
    g.strokeStyle = '#262626'; g.fillStyle = '#8c8c8c'; g.lineWidth = 1; g.textAlign = 'left'
    for (const t of axisTicks(range.lo, range.hi, 8)) {
      const yy = Math.round(y(t)) + 0.5
      g.beginPath(); g.moveTo(0, yy); g.lineTo(width - AXIS_W, yy); g.stroke()
      g.fillText(String(Math.round(t * 100) / 100), width - AXIS_W + 6, yy + 4)
    }
    // candles
    const slot = plotW / Math.max(MIN_SLOTS, candles.length)
    const bodyW = Math.max(1, slot * 0.7)
    candles.forEach((c, i) => {
      const x = i * slot + slot / 2
      const up = c.close >= c.open
      g.strokeStyle = g.fillStyle = up ? GREEN : RED
      g.beginPath(); g.moveTo(Math.round(x) + 0.5, y(c.high)); g.lineTo(Math.round(x) + 0.5, y(c.low)); g.stroke()
      g.fillRect(x - bodyW / 2, Math.min(y(c.open), y(c.close)), bodyW, Math.max(1, Math.abs(y(c.open) - y(c.close))))
    })
    // profile rows
    const rowPx = Math.max(1, Math.abs(y(range.lo) - y(range.lo + rowSize)) - 1)
    columns.forEach((c, ci) => {
      const x0 = panelX + ci * colWidth
      const cx = x0 + colWidth / 2
      g.fillStyle = '#8c8c8c'; g.textAlign = 'center'
      g.fillText(c.title, cx, 12, colWidth - 4)
      if (c.kind === 'delta') { g.strokeStyle = '#3a3a3a'; g.beginPath(); g.moveTo(Math.round(cx) + 0.5, TOP); g.lineTo(Math.round(cx) + 0.5, height); g.stroke() }
      else { g.strokeStyle = '#3a3a3a'; g.beginPath(); g.moveTo(Math.round(x0) + 0.5, TOP); g.lineTo(Math.round(x0) + 0.5, height); g.stroke() }
      for (const r of rows) {
        if (r.price + rowSize < range.lo || r.price > range.hi) continue
        const top = y(r.price + rowSize)
        const v = r[c.key] ?? 0
        if (!v) continue
        if (c.kind === 'volume') {
          const w = (v / model.maxes[c.key]) * (colWidth - 6)
          const inVa = model.lv?.val != null && r.price >= model.lv.val && r.price <= model.lv.vah
          g.fillStyle = r.price === model.lv?.poc ? AMBER : inVa ? 'rgba(180,180,180,0.8)' : 'rgba(120,120,120,0.55)'
          g.fillRect(x0 + 2, top + 0.5, w, rowPx)
        } else {
          const w = (Math.abs(v) / model.maxes[c.key]) * (colWidth / 2 - 4)
          const bullish = c.bullishNegative ? v < 0 : v > 0
          const m = model.marks[c.key]
          const tag = r.price === m.b1 ? ['B1', B1] : r.price === m.b2 ? ['B2', B2] : r.price === m.s1 ? ['S1', S1] : r.price === m.s2 ? ['S2', S2] : null
          g.fillStyle = tag ? tag[1] : bullish ? GREEN : RED
          g.globalAlpha = tag ? 1 : 0.85
          g.fillRect(v > 0 ? cx : cx - w, top + 0.5, Math.max(1, w), rowPx)
          g.globalAlpha = 1
          if (tag && rowPx >= 7) { g.fillStyle = tag[1]; g.textAlign = v > 0 ? 'left' : 'right'; g.font = 'bold 9px system-ui, sans-serif'; g.fillText(tag[0], v > 0 ? cx + w + 3 : cx - w - 3, top + rowPx / 2 + 3.5); g.font = '11px system-ui, sans-serif' }
        }
      }
    })
    // POC / VAH / VAL across the candles
    if (model.lv?.poc != null) {
      const line = (p, color, dash, label) => {
        const yy = Math.round(y(p + rowSize / 2)) + 0.5
        g.strokeStyle = color; g.setLineDash(dash); g.beginPath(); g.moveTo(0, yy); g.lineTo(plotW, yy); g.stroke(); g.setLineDash([])
        g.fillStyle = color; g.textAlign = 'left'; g.fillText(label, 4, yy - 3)
      }
      line(model.lv.poc, AMBER, [], `POC ${model.lv.poc}`)
      line(model.lv.vah, 'rgba(250,173,20,0.7)', [4, 3], `VAH ${model.lv.vah}`)
      line(model.lv.val, 'rgba(250,173,20,0.7)', [4, 3], `VAL ${model.lv.val}`)
    }
    // hover row
    if (hover != null) {
      const yy = y(hover + rowSize)
      g.strokeStyle = '#d9d9d9'; g.lineWidth = 1; g.strokeRect(panelX + 0.5, Math.round(yy) + 0.5, panelW - 1, Math.max(2, rowPx))
    }
  }, [candles, rows, rowSize, columns, model, range, width, height, plotW, panelW, colWidth, hover, y])

  const onMove = (e) => {
    if (!range) return
    const rect = canvas.current.getBoundingClientRect()
    const py = e.clientY - rect.top
    const price = range.lo + (1 - (py - TOP) / (height - TOP - 4)) * (range.hi - range.lo)
    setHover(Math.floor(price / rowSize + 1e-9) * rowSize)
  }
  const hovered = hover != null ? rows.find((r) => r.price === hover) : null

  if (!range) return <div ref={wrap} style={{ height: 60 }} />
  return (
    <div ref={wrap} style={{ width: '100%' }}>
      <canvas ref={canvas} style={{ width, height, display: 'block' }} onPointerMove={onMove} onPointerLeave={() => setHover(null)} role="img" aria-label="Candles with profile columns" />
      <div style={{ fontSize: 12, minHeight: 18, opacity: 0.85 }}>
        {hover == null ? 'Hover a row for its numbers.' : `${hover} – ${hover + rowSize}: ${hovered ? columns.map((c) => `${c.title} ${num(hovered[c.key] ?? 0)} ${unit}`).join(' · ') : 'nothing traded there'}`}
      </div>
    </div>
  )
}
