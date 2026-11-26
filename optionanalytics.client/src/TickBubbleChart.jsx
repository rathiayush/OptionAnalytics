import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Space, Tooltip } from 'antd'
import { axisTicks, bubbleRadius, bubbleScaleMax, fmtQty, msOf } from './tickFlowMath.js'

// The Tick Flow page's BUBBLE CHART (the "deep chart"): the price moving through time with a bubble at every order - a small order
// a small bubble, a big order a big bubble (the bubble's AREA follows its size). Green = bought at the ask, red = sold at the bid;
// the white line is the price, the grey band the best bid / ask. TrueData's NSE feed has no depth past level 1, so the band is the
// whole book. Drawn on a canvas; its own code - nothing shared with the Order Flow page.
//
// ZOOM, both ways: the wheel zooms the TIME around the pointer, Shift + wheel zooms the PRICE around the pointer, a drag moves the
// chart in both (a price move or zoom takes the price scale off auto - "Fit price" gives it back), the + / - buttons zoom the time,
// "Live" follows the newest order again and a double-click resets both. Two fingers pinch the time.

const C = { buy: '38,166,154', sell: '239,83,80', bg: '#0b1220', grid: '#1f2937', axis: '#8c8c8c', price: '#f0f0f0' }
const AXIS_W = 66
const TIME_H = 24
const PAD_MS = 10_000
const MIN_SPAN_MS = 20_000
const MAX_SPAN_MS = 8 * 3_600_000

const hhmmss = (ms, seconds = false) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) })

// A touch screen: one finger scrolling UP / DOWN moves the PAGE (the chart is one card of a long page - `touchAction: 'none'` trapped it),
// sideways moves the time, two fingers pinch it; a tap reads the bubble under it.
const COARSE = typeof window !== 'undefined' && Boolean(window.matchMedia?.('(pointer: coarse)')?.matches)

export function TickBubbleChart({ bubbles, quotes, lastPrice, lotSize, showLots, height = 520, minLots = 1, rMax = 34 }) {
  const wrap = useRef(null)
  const canvas = useRef(null)
  const [width, setWidth] = useState(900)
  const [spanMs, setSpanMs] = useState(30 * 60_000)
  const [tEnd, setTEnd] = useState(null)   // the right edge's time; null = follow the newest order
  const [yRange, setYRange] = useState(null) // { lo, hi } once the price was zoomed or moved; null = fitted
  const [hover, setHover] = useState(null)
  const drag = useRef(null)
  const hits = useRef([])
  const current = useRef(null)
  const pointers = useRef(new Map())
  const pinch = useRef(null)

  useEffect(() => {
    const el = wrap.current
    if (!el) return undefined
    const ro = new ResizeObserver(() => setWidth(Math.max(320, el.clientWidth)))
    ro.observe(el)
    setWidth(Math.max(320, el.clientWidth))
    return () => ro.disconnect()
  }, [])

  const list = useMemo(() => (bubbles ?? []).filter((b) => b.qty >= minLots * lotSize).map((b) => ({ ...b, ms: b.ms ?? msOf(b.time) })), [bubbles, minLots, lotSize])
  const quoteList = useMemo(() => (quotes ?? []).map((q) => ({ ...q, ms: q.ms ?? msOf(q.time) })), [quotes])
  const latest = Math.max(list.at(-1)?.ms ?? 0, quoteList.at(-1)?.ms ?? 0)
  // The day's first reading: while everything fits in the window the chart STARTS FROM THE LEFT (first order at the left edge, the rest filling to the right).
  const earliest = Math.min(list[0]?.ms ?? Infinity, quoteList[0]?.ms ?? Infinity)

  const view = useMemo(() => {
    if (!latest) return null
    const fromLeft = tEnd == null && Number.isFinite(earliest) && latest + PAD_MS - earliest < spanMs
    const t1 = tEnd ?? (fromLeft ? earliest - PAD_MS + spanMs : latest + PAD_MS)
    const t0 = t1 - spanMs
    const inView = list.filter((b) => b.ms >= t0 && b.ms <= t1)
    const qs = quoteList.filter((q) => q.ms >= t0 - 60_000 && q.ms <= t1)
    let hi = -Infinity
    let lo = Infinity
    for (const b of inView) { hi = Math.max(hi, b.price); lo = Math.min(lo, b.price) }
    for (const q of qs) { hi = Math.max(hi, q.ask); lo = Math.min(lo, q.bid) }
    const max = bubbleScaleMax(inView)
    if (yRange) return { t0, t1, inView, qs, hi: yRange.hi, lo: yRange.lo, max, manual: true }
    if (!Number.isFinite(hi)) return { t0, t1, inView, qs, hi: null, lo: null, max }
    const pad = Math.max((hi - lo) * 0.12, 1)
    return { t0, t1, inView, qs, hi: hi + pad, lo: lo - pad, max }
  }, [list, quoteList, latest, earliest, tEnd, spanMs, yRange])
  current.current = view

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = width * dpr
    c.height = height * dpr
    const g = c.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.fillStyle = C.bg
    g.fillRect(0, 0, width, height)
    hits.current = []
    if (!view || view.hi == null) return
    const plotW = width - AXIS_W
    const plotH = height - TIME_H
    const x = (ms) => ((ms - view.t0) / (view.t1 - view.t0)) * plotW
    const y = (p) => ((view.hi - p) / (view.hi - view.lo)) * plotH
    g.font = '11px sans-serif'
    g.textBaseline = 'middle'
    for (const p of axisTicks(view.lo, view.hi, Math.max(4, Math.floor(plotH / 48)))) {
      g.strokeStyle = C.grid; g.beginPath(); g.moveTo(0, y(p)); g.lineTo(plotW, y(p)); g.stroke()
      g.fillStyle = C.axis; g.textAlign = 'left'; g.fillText(String(p), plotW + 6, y(p))
    }
    g.textAlign = 'center'
    const wide = view.t1 - view.t0
    for (const t of axisTicks(view.t0 / 1000, view.t1 / 1000, Math.max(3, Math.floor(plotW / 90)))) {
      const ms = t * 1000
      g.strokeStyle = C.grid; g.beginPath(); g.moveTo(x(ms), 0); g.lineTo(x(ms), plotH); g.stroke()
      g.fillStyle = C.axis; g.fillText(hhmmss(ms, wide < 10 * 60_000), x(ms), plotH + TIME_H / 2)
    }
    // The best bid / ask band and its two lines (steps).
    if (view.qs.length) {
      const qx = (q) => Math.max(0, x(q.ms))
      g.save()
      g.beginPath(); g.rect(0, 0, plotW, plotH); g.clip()
      g.beginPath()
      view.qs.forEach((q, i) => { if (i === 0) g.moveTo(qx(q), y(q.ask)); else { g.lineTo(qx(q), y(view.qs[i - 1].ask)); g.lineTo(qx(q), y(q.ask)) } })
      g.lineTo(plotW, y(view.qs.at(-1).ask))
      g.lineTo(plotW, y(view.qs.at(-1).bid))
      for (let i = view.qs.length - 1; i >= 0; i--) { const q = view.qs[i]; g.lineTo(qx(q), y(q.bid)); if (i > 0) g.lineTo(qx(q), y(view.qs[i - 1].bid)) }
      g.closePath()
      g.fillStyle = 'rgba(140,140,140,0.13)'; g.fill()
      for (const [key, color] of [['ask', `rgba(${C.sell},0.55)`], ['bid', `rgba(${C.buy},0.55)`]]) {
        g.beginPath()
        view.qs.forEach((q, i) => { if (i === 0) g.moveTo(qx(q), y(q[key])); else { g.lineTo(qx(q), y(view.qs[i - 1][key])); g.lineTo(qx(q), y(q[key])) } })
        g.lineTo(plotW, y(view.qs.at(-1)[key]))
        g.strokeStyle = color; g.lineWidth = 1; g.stroke()
      }
      g.restore()
    }
    g.save()
    g.beginPath(); g.rect(0, 0, plotW, plotH); g.clip()
    // The price line through the trades.
    g.beginPath()
    view.inView.forEach((b, i) => { if (i === 0) g.moveTo(x(b.ms), y(b.price)); else g.lineTo(x(b.ms), y(b.price)) })
    g.strokeStyle = C.price; g.lineWidth = 1.2; g.stroke(); g.lineWidth = 1
    // Bubbles - the biggest first so the small ones stay visible on top.
    const ordered = [...view.inView].sort((a, b) => b.qty - a.qty)
    for (const b of ordered) {
      const r = bubbleRadius(b.qty, view.max, 3, rMax)
      const cx = x(b.ms)
      const cy = y(b.price)
      if (cy < -r || cy > plotH + r) continue
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2)
      const col = b.buy ? C.buy : C.sell
      g.fillStyle = `rgba(${col},0.45)`; g.fill()
      g.strokeStyle = `rgba(${col},0.95)`; g.stroke()
      if (r >= 15) { g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = '11px sans-serif'; g.fillText(fmtQty(b.qty, lotSize, showLots), cx, cy) }
      hits.current.push({ cx, cy, r, b })
    }
    g.restore()
    // The last price on the axis.
    if (lastPrice > 0 && lastPrice <= view.hi && lastPrice >= view.lo) {
      g.fillStyle = '#1668dc'; g.fillRect(plotW, y(lastPrice) - 9, AXIS_W, 18)
      g.fillStyle = '#fff'; g.textAlign = 'left'; g.fillText(String(lastPrice), plotW + 6, y(lastPrice))
    }
    // Size legend, bottom left.
    const sizes = [view.max * 0.05, view.max * 0.25, view.max]
    let lx = 14
    g.textAlign = 'left'
    for (const q of sizes) {
      const r = bubbleRadius(q, view.max, 3, rMax)
      g.beginPath(); g.arc(lx + r, plotH - 10 - rMax + 4, r, 0, Math.PI * 2)
      g.fillStyle = 'rgba(180,180,180,0.25)'; g.fill(); g.strokeStyle = 'rgba(180,180,180,0.8)'; g.stroke()
      g.fillStyle = C.axis; g.fillText(fmtQty(q, lotSize, showLots), lx + r * 2 + 4, plotH - 10 - rMax + 4)
      lx += r * 2 + 44
    }
  }, [view, width, height, lastPrice, lotSize, showLots, rMax])

  // --- zoom and move -----------------------------------------------------------------------------------------------------------
  const plotSize = () => ({ w: Math.max(1, width - AXIS_W), h: Math.max(1, height - TIME_H) })

  const zoomTime = (factor, frac = 1) => {
    const v = current.current
    if (!v) return
    const span = v.t1 - v.t0
    const next = Math.max(MIN_SPAN_MS, Math.min(MAX_SPAN_MS, span * factor))
    const at = v.t0 + frac * span
    const end = at - frac * next + next
    setSpanMs(next)
    setTEnd(end >= latest + PAD_MS - 1 ? null : end)
  }

  const zoomPrice = (factor, frac = 0.5) => {
    const v = current.current
    if (!v || v.hi == null) return
    const span = v.hi - v.lo
    const next = Math.max(0.5, span * factor)
    const at = v.hi - frac * span
    const hi = at + frac * next
    setYRange({ hi, lo: hi - next })
  }

  useEffect(() => {
    const el = canvas.current
    if (!el) return undefined
    // A plain wheel scrolls the page; Ctrl + wheel (a pinch) zooms the time, Shift + wheel the price.
    const onWheel = (e) => {
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const { w, h } = plotSize()
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2
      if (e.shiftKey) zoomPrice(factor, Math.min(1, Math.max(0, (e.clientY - rect.top) / h)))
      else zoomTime(factor, Math.min(1, Math.max(0, (e.clientX - rect.left) / w)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, height, latest])

  const onDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), span: current.current ? current.current.t1 - current.current.t0 : spanMs }
      drag.current = null
      return
    }
    const v = current.current
    drag.current = v ? { x: e.clientX, y: e.clientY, t1: v.t1, hi: v.hi, lo: v.lo } : null
    if (e.pointerType === 'touch') {
      const rect = e.currentTarget.getBoundingClientRect()
      setHover(hitAt(e.clientX - rect.left, e.clientY - rect.top))
    }
  }

  // The smallest bubble under (px, py), else none.
  const hitAt = (px, py) => {
    let best = null
    for (const h of hits.current) {
      const d = Math.hypot(px - h.cx, py - h.cy)
      if (d <= h.r + 3 && (!best || h.r < best.r)) best = { ...h, px, py }
    }
    return best
  }

  const onMove = (e) => {
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch.current && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      const dist = Math.hypot(a.x - b.x, a.y - b.y)
      const next = Math.max(MIN_SPAN_MS, Math.min(MAX_SPAN_MS, pinch.current.span * (pinch.current.dist / Math.max(1, dist))))
      setSpanMs(next)
      return
    }
    const rect = e.currentTarget.getBoundingClientRect()
    if (drag.current) {
      const { w, h } = plotSize()
      const v = current.current
      const dx = e.clientX - drag.current.x
      const dy = e.clientY - drag.current.y
      const end = drag.current.t1 - dx * ((v.t1 - v.t0) / w)
      setTEnd(end >= latest + PAD_MS - 1 ? null : end)
      if (drag.current.hi != null && Math.abs(dy) > 3) {
        const perPx = (drag.current.hi - drag.current.lo) / h
        setYRange({ hi: drag.current.hi + dy * perPx, lo: drag.current.lo + dy * perPx })
      }
      setHover(null)
      return
    }
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    setHover(hitAt(px, py))
  }

  const onUp = (e) => {
    pointers.current.delete(e.pointerId)
    if (pointers.current.size < 2) pinch.current = null
    drag.current = null
  }

  return (
    <div ref={wrap} style={{ width: '100%', position: 'relative' }}>
      <div style={{ position: 'absolute', top: 6, left: 8, zIndex: 2 }}>
        <Space size={4} wrap>
          <Tooltip title="Zoom the time in"><Button size="small" onClick={() => zoomTime(1 / 1.5)}>＋</Button></Tooltip>
          <Tooltip title="Zoom the time out"><Button size="small" onClick={() => zoomTime(1.5)}>－</Button></Tooltip>
          <Tooltip title="Zoom the price in (Shift + wheel)"><Button size="small" onClick={() => zoomPrice(1 / 1.5)}>price ＋</Button></Tooltip>
          <Tooltip title="Zoom the price out"><Button size="small" onClick={() => zoomPrice(1.5)}>price －</Button></Tooltip>
          {yRange && <Button size="small" onClick={() => setYRange(null)}>Fit price</Button>}
          {tEnd != null && <Button size="small" type="primary" onClick={() => setTEnd(null)}>Live</Button>}
        </Space>
      </div>
      <canvas
        ref={canvas} style={{ width: '100%', height, display: 'block', cursor: 'crosshair', touchAction: COARSE ? 'pan-y' : 'none' }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onPointerLeave={(e) => { if (e.pointerType !== 'touch') setHover(null) }}
        onDoubleClick={() => { setTEnd(null); setYRange(null) }}
      />
      {hover && (
        <div style={{ position: 'absolute', left: Math.min(hover.px + 14, width - 210), top: Math.max(4, hover.py - 70), background: 'rgba(20,24,34,0.95)', border: '1px solid #303030', borderRadius: 4, padding: '6px 8px', fontSize: 12, pointerEvents: 'none', whiteSpace: 'nowrap' }}>
          <div style={{ color: hover.b.buy ? '#26a69a' : '#ef5350', fontWeight: 600 }}>{hover.b.buy ? 'BOUGHT at the ask' : 'SOLD at the bid'}</div>
          <div>{showLots ? `${fmtQty(hover.b.qty, lotSize, true)} lots (${hover.b.qty.toLocaleString()} qty)` : `${hover.b.qty.toLocaleString()} qty (${fmtQty(hover.b.qty, lotSize, true)} lots)`} @ {hover.b.price}</div>
          <div style={{ color: '#8c8c8c' }}>{hhmmss(hover.b.ms, true)} · {hover.b.prints} print{hover.b.prints === 1 ? '' : 's'}</div>
        </div>
      )}
    </div>
  )
}
