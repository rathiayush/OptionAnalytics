import { useEffect, useMemo, useRef, useState } from 'react'
import { axisTicks, bubbleRadius, bubbleScaleMax, fmtQty, msOf } from './tickFlowMath.js'

// The Tick Flow page's BUBBLE CHART (the "deep chart"): the price moving through time with a bubble at every order - a small order
// a small bubble, a big order a big bubble (the bubble's AREA follows its size). Green = bought at the ask, red = sold at the bid;
// the white line is the price, the grey band the best bid / ask. TrueData's NSE feed has no depth past level 1, so the band is the
// whole book. Drawn on a canvas; its own code - nothing shared with the Order Flow page. Wheel: zoom the time; drag: move back in
// time; double-click: back to live.

const C = { buy: '38,166,154', sell: '239,83,80', bg: '#0b1220', grid: '#1f2937', axis: '#8c8c8c', price: '#f0f0f0' }
const AXIS_W = 66
const TIME_H = 24

const hhmmss = (ms, seconds = false) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) })

export function TickBubbleChart({ bubbles, quotes, lastPrice, lotSize, showLots, height = 520, minLots = 1, rMax = 34 }) {
  const wrap = useRef(null)
  const canvas = useRef(null)
  const [width, setWidth] = useState(900)
  const [spanMin, setSpanMin] = useState(30)
  const [back, setBack] = useState(0) // ms the right edge is behind the latest
  const [hover, setHover] = useState(null)
  const drag = useRef(null)
  const hits = useRef([])

  useEffect(() => {
    const el = wrap.current
    if (!el) return undefined
    const ro = new ResizeObserver(() => setWidth(Math.max(320, el.clientWidth)))
    ro.observe(el)
    setWidth(Math.max(320, el.clientWidth))
    return () => ro.disconnect()
  }, [])

  const list = useMemo(() => (bubbles ?? []).filter((b) => b.qty >= minLots * lotSize).map((b) => ({ ...b, ms: msOf(b.time) })), [bubbles, minLots, lotSize])
  const quoteList = useMemo(() => (quotes ?? []).map((q) => ({ ...q, ms: msOf(q.time) })), [quotes])
  const latest = Math.max(list.at(-1)?.ms ?? 0, quoteList.at(-1)?.ms ?? 0)

  const view = useMemo(() => {
    if (!latest) return null
    const t1 = latest - back + 10_000
    const t0 = t1 - spanMin * 60_000
    const inView = list.filter((b) => b.ms >= t0 && b.ms <= t1)
    const qs = quoteList.filter((q) => q.ms >= t0 - 60_000 && q.ms <= t1)
    let hi = -Infinity
    let lo = Infinity
    for (const b of inView) { hi = Math.max(hi, b.price); lo = Math.min(lo, b.price) }
    for (const q of qs) { hi = Math.max(hi, q.ask); lo = Math.min(lo, q.bid) }
    if (!Number.isFinite(hi)) return { t0, t1, inView, qs, hi: null, lo: null, max: 1 }
    const pad = Math.max((hi - lo) * 0.12, 1)
    return { t0, t1, inView, qs, hi: hi + pad, lo: lo - pad, max: bubbleScaleMax(inView) }
  }, [list, quoteList, latest, back, spanMin])

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
    for (const t of axisTicks(view.t0 / 60_000, view.t1 / 60_000, Math.max(3, Math.floor(plotW / 90)))) {
      const ms = t * 60_000
      g.strokeStyle = C.grid; g.beginPath(); g.moveTo(x(ms), 0); g.lineTo(x(ms), plotH); g.stroke()
      g.fillStyle = C.axis; g.fillText(hhmmss(ms), x(ms), plotH + TIME_H / 2)
    }
    // The best bid / ask band and its two lines (steps).
    if (view.qs.length) {
      g.beginPath()
      view.qs.forEach((q, i) => { const xx = Math.max(0, x(q.ms)); if (i === 0) g.moveTo(xx, y(q.ask)); else { g.lineTo(xx, y(view.qs[i - 1].ask)); g.lineTo(xx, y(q.ask)) } })
      g.lineTo(plotW, y(view.qs.at(-1).ask))
      g.lineTo(plotW, y(view.qs.at(-1).bid))
      for (let i = view.qs.length - 1; i >= 0; i--) { const q = view.qs[i]; const xx = Math.max(0, x(q.ms)); g.lineTo(xx, y(q.bid)); if (i > 0) g.lineTo(xx, y(view.qs[i - 1].bid)) }
      g.closePath()
      g.fillStyle = 'rgba(140,140,140,0.13)'; g.fill()
      for (const [key, color] of [['ask', `rgba(${C.sell},0.55)`], ['bid', `rgba(${C.buy},0.55)`]]) {
        g.beginPath()
        view.qs.forEach((q, i) => { const xx = Math.max(0, x(q.ms)); if (i === 0) g.moveTo(xx, y(q[key])); else { g.lineTo(xx, y(view.qs[i - 1][key])); g.lineTo(xx, y(q[key])) } })
        g.lineTo(plotW, y(view.qs.at(-1)[key]))
        g.strokeStyle = color; g.lineWidth = 1; g.stroke()
      }
    }
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
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2)
      const col = b.buy ? C.buy : C.sell
      g.fillStyle = `rgba(${col},0.45)`; g.fill()
      g.strokeStyle = `rgba(${col},0.95)`; g.stroke()
      if (r >= 15) { g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = '11px sans-serif'; g.fillText(fmtQty(b.qty, lotSize, showLots), cx, cy) }
      hits.current.push({ cx, cy, r, b })
    }
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

  useEffect(() => {
    const el = canvas.current
    if (!el) return undefined
    const onWheel = (e) => { e.preventDefault(); setSpanMin((s) => Math.max(1, Math.min(400, Math.round(s * (e.deltaY > 0 ? 1.2 : 0.83) * 10) / 10))) }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const py = e.clientY - rect.top
    if (drag.current) {
      const perPx = (spanMin * 60_000) / Math.max(1, width - AXIS_W)
      setBack(Math.max(0, drag.current.back + (e.clientX - drag.current.x) * perPx))
      setHover(null)
      return
    }
    let best = null
    for (const h of hits.current) {
      const d = Math.hypot(px - h.cx, py - h.cy)
      if (d <= h.r + 3 && (!best || h.r < best.r)) best = { ...h, px, py }
    }
    setHover(best)
  }

  return (
    <div ref={wrap} style={{ width: '100%', position: 'relative' }}>
      <canvas
        ref={canvas} style={{ width: '100%', height, display: 'block', cursor: 'crosshair', touchAction: 'pan-y' }}
        onPointerDown={(e) => { drag.current = { x: e.clientX, back }; e.currentTarget.setPointerCapture?.(e.pointerId) }}
        onPointerMove={onMove}
        onPointerUp={() => { drag.current = null }}
        onPointerLeave={() => setHover(null)}
        onDoubleClick={() => { setBack(0) }}
      />
      {hover && (
        <div style={{ position: 'absolute', left: Math.min(hover.px + 14, width - 210), top: Math.max(4, hover.py - 70), background: 'rgba(20,24,34,0.95)', border: '1px solid #303030', borderRadius: 4, padding: '6px 8px', fontSize: 12, pointerEvents: 'none', whiteSpace: 'nowrap' }}>
          <div style={{ color: hover.b.buy ? '#26a69a' : '#ef5350', fontWeight: 600 }}>{hover.b.buy ? 'BOUGHT at the ask' : 'SOLD at the bid'}</div>
          <div>{fmtQty(hover.b.qty, lotSize, true)} lots ({hover.b.qty.toLocaleString()}) @ {hover.b.price}</div>
          <div style={{ color: '#8c8c8c' }}>{hhmmss(hover.b.ms, true)} · {hover.b.prints} print{hover.b.prints === 1 ? '' : 's'}</div>
        </div>
      )}
    </div>
  )
}
