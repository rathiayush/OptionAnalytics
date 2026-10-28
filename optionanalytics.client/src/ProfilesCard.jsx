import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Card, Col, Row, Tag, Typography } from 'antd'
import { UP_COLOR, DOWN_COLOR, AXIS_COLOR } from './shared.jsx'
import { formatVolume } from './OrderFlowCharts.jsx'
import { useElementWidth, prepareCanvas } from './canvasUtils.js'
import { PREV_PROFILE, RUNNING_PROFILE } from './profileColors.js'

const { Text } = Typography
const fmt = (v) => (v == null ? '-' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }))
const IB_LETTERS = new Set(['A', 'B'])
const FONT = '"Segoe UI", system-ui, sans-serif'
const MONO = 'ui-monospace, Menlo, Consolas, monospace'
const AXIS_W = 64
const HEAD_H = 20
const POC = PREV_PROFILE.poc
const VA = PREV_PROFILE.va
const TPO_VA = '#b37feb'
const HVN = PREV_PROFILE.hvn
const LVN = PREV_PROFILE.lvn
const RUN = RUNNING_PROFILE
const PRICE = '#2f80ed'
const BG = '#0d111a'

/**
 * Volume profile and market profile as two charts side by side, on one shared price axis (zoom or
 * pan either and both follow, so a level lines up across them):
 *   Volume profile - the PREVIOUS session's volume at each price (buy / sell), its POC, value area
 *     (VAH / VAL, 70% of the volume) and high / low volume nodes - the levels carried into today.
 *   Market profile (TPO) - the previous session's profile next to today's developing one: each letter
 *     a 30-minute period (A = 09:15) that traded at that price; value areas, POCs, today's initial
 *     balance (A + B) and single prints.
 * Wheel = zoom prices at the cursor, drag = pan, double-click = fit.
 */
export function ProfilesCard({ prevDate, prevVp, todayVp, prevTpo, todayTpo, lastPrice: rawLastPrice, loading, estimatedPrev, lotSize, showLots, height = 440 }) {
  // No price yet (0 before the first tick of the day, a replay at its very start) is no price: drawn
  // and fitted as a price it stretched the shared axis from 0 and flattened both profiles.
  const lastPrice = rawLastPrice > 0 ? rawLastPrice : null
  const fitted = useMemo(() => {
    const levels = [...(prevVp?.rows ?? []).map((r) => r.price), ...(todayVp?.rows ?? []).map((r) => r.price), ...(prevTpo?.rows ?? []).map((r) => r.price), ...(todayTpo?.rows ?? []).map((r) => r.price)]
    const base = fitRange(levels)
    // The last price is fitted in too, unless it is far from the profiles (another contract month).
    if (!base || lastPrice == null) return base ?? fitRange([lastPrice])
    const span = Math.max(base.hi - base.lo, lastPrice * 0.01)
    return lastPrice > base.lo - span && lastPrice < base.hi + span ? fitRange([...levels, lastPrice]) : base
  }, [prevVp, todayVp, prevTpo, todayTpo, lastPrice])
  const [view, setView] = useState(null) // { hi, lo } when zoomed / panned
  const [hoverPrice, setHoverPrice] = useState(null)
  const range = view ?? fitted
  const nav = useMemo(() => ({
    zoom: (factor, price) => {
      if (!range) return
      const span = Math.max(5, (range.hi - range.lo) / factor)
      const at = price ?? (range.hi + range.lo) / 2
      const share = (range.hi - at) / (range.hi - range.lo)
      setView({ hi: at + span * share, lo: at - span * (1 - share) })
    },
    pan: (dPrice) => range && setView({ hi: range.hi + dPrice, lo: range.lo + dPrice }),
    reset: () => setView(null),
  }), [range])

  return (
    <Card
      size="small"
      title={`Volume & market profile${prevDate ? ` · previous session ${prevDate}` : ''}`}
      extra={view && <Button size="small" onClick={nav.reset}>Fit</Button>}
    >
      {loading && <Text type="secondary">Loading the previous session…</Text>}
      {!loading && !prevVp?.poc && !todayTpo?.rows?.length && <Text type="secondary" style={{ fontSize: 12 }}>No previous session found in the last week, and no trading today yet.</Text>}
      <Row gutter={[12, 12]}>
        <Col xs={24} lg={12}>
          <div style={{ fontSize: 12, marginBottom: 4, minHeight: 36 }}>
            <Text strong style={{ fontSize: 12 }}>Volume profile · previous session | <span style={{ color: RUN.bar }}>today (running)</span></Text>{estimatedPrev && <Tag style={{ marginLeft: 6 }}>estimated</Tag>}
            {prevVp?.poc != null && (
              <div>
                prev: <span style={{ color: POC }}>POC {fmt(prevVp.poc)}</span> · <span style={{ color: VA }}>VAH {fmt(prevVp.vah)} · VAL {fmt(prevVp.val)}</span>
                {' '}· <span style={{ color: HVN }}>HVN {fmt(prevVp.hvnTop)}</span> · <span style={{ color: LVN }}>LVN {fmt(prevVp.lvnTop)}</span>
              </div>
            )}
            {todayVp?.poc != null && (
              <div>
                today: <span style={{ color: RUN.poc }}>POC {fmt(todayVp.poc)}</span> · <span style={{ color: RUN.va }}>VAH {fmt(todayVp.vah)} · VAL {fmt(todayVp.val)}</span>
                {' '}· <span style={{ color: RUN.hvn }}>HVN {fmt(todayVp.hvnTop)}</span> · <span style={{ color: RUN.lvn }}>LVN {fmt(todayVp.lvnTop)}</span>
              </div>
            )}
          </div>
          <VolumeProfileChart vp={prevVp} todayVp={todayVp} range={range} lastPrice={lastPrice} nav={nav} hoverPrice={hoverPrice} onHover={setHoverPrice}
            lotSize={lotSize} showLots={showLots} height={height} />
        </Col>
        <Col xs={24} lg={12}>
          <div style={{ fontSize: 12, marginBottom: 4, minHeight: 36 }}>
            <Text strong style={{ fontSize: 12 }}>Market profile (TPO) · previous | today</Text>
            <div>
              {prevTpo && <><span style={{ color: TPO_VA }}>prev VA {fmt(prevTpo.val)}–{fmt(prevTpo.vah)}</span> · <span style={{ color: POC }}>prev POC {fmt(prevTpo.poc)}</span></>}
              {todayTpo?.ib && <> · <span style={{ color: UP_COLOR }}>today IB {fmt(todayTpo.ib.low)}–{fmt(todayTpo.ib.high)}</span></>}
              {todayTpo?.poc != null && <> · today POC {fmt(todayTpo.poc)}</>}
            </div>
          </div>
          <MarketProfileChart prevTpo={prevTpo} todayTpo={todayTpo} range={range} lastPrice={lastPrice} nav={nav} hoverPrice={hoverPrice} onHover={setHoverPrice} height={height} />
        </Col>
      </Row>
      <Text className="oa-note" type="secondary" style={{ fontSize: 11 }}>
        Both charts share the price axis - wheel to zoom, drag to pan, double-click to fit. TPO letters = 30-minute periods (A = 09:15) ·{' '}
        <span style={{ color: UP_COLOR }}>A B</span> = initial balance · <span style={{ color: POC }}>yellow</span> = POC · bright = value area ·{' '}
        <span style={{ color: DOWN_COLOR }}>◂</span> = single print · <span style={{ color: PRICE }}>blue</span> = last price.
      </Text>
    </Card>
  )
}

function fitRange(prices) {
  const list = prices.filter((p) => Number.isFinite(p) && p > 0)
  if (!list.length) return null
  let hi = Math.max(...list)
  let lo = Math.min(...list)
  const pad = Math.max(10, (hi - lo) * 0.04)
  hi += pad
  lo -= pad
  return { hi, lo }
}

// Wheel / drag / double-click on a profile canvas, against the shared price range.
function useProfileNav(canvasRef, plotH, range, nav, onHover) {
  const latest = useRef({})
  useEffect(() => { latest.current = { plotH, range, nav, onHover } })
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return undefined
    const priceAt = (y) => {
      const { range: r, plotH: h } = latest.current
      return r ? r.hi - ((y - HEAD_H) / h) * (r.hi - r.lo) : null
    }
    let drag = null
    const onWheel = (e) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      latest.current.nav.zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15, priceAt(e.clientY - rect.top))
    }
    const onDown = (e) => { drag = { y: e.clientY } }
    const onMove = (e) => {
      const rect = canvas.getBoundingClientRect()
      const { range: r, plotH: h } = latest.current
      if (drag && r) {
        const dy = e.clientY - drag.y
        if (Math.abs(dy) >= 2) {
          latest.current.nav.pan((dy / h) * (r.hi - r.lo))
          drag = { y: e.clientY }
        }
      }
      const y = e.clientY - rect.top
      latest.current.onHover(y >= HEAD_H && y <= HEAD_H + h ? priceAt(y) : null)
    }
    const onUp = () => { drag = null }
    const onLeave = () => { drag = null; latest.current.onHover(null) }
    const onDbl = () => latest.current.nav.reset()
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    canvas.addEventListener('mouseleave', onLeave)
    canvas.addEventListener('dblclick', onDbl)
    return () => {
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      canvas.removeEventListener('mouseleave', onLeave)
      canvas.removeEventListener('dblclick', onDbl)
    }
  }, [canvasRef])
}

// Shared drawing: background, price axis with labels, a horizontal level line with a label, the
// last-price line and the hover crosshair.
function axisLabels(ctx, range, plotW, plotH, part) {
  const span = range.hi - range.lo
  const raw = span / Math.max(4, plotH / 40)
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((n) => n >= raw) ?? 1000
  ctx.font = `11px ${FONT}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  for (let p = Math.ceil(range.lo / step) * step; p <= range.hi; p += step) {
    const y = HEAD_H + ((range.hi - p) / span) * plotH
    if (part === 'grid') {
      ctx.fillStyle = '#ffffff0a'
      ctx.fillRect(0, Math.round(y), plotW, 1)
    } else if (y > HEAD_H + 6 && y < HEAD_H + plotH - 4) {
      ctx.fillStyle = AXIS_COLOR
      ctx.fillText(p.toLocaleString('en-IN'), plotW + 6, y)
    }
  }
}

function levelLine(ctx, y, plotW, color, label, { dash = [5, 4], from = 0, to = plotW, labelX = null } = {}) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.setLineDash(dash)
  ctx.beginPath()
  ctx.moveTo(from, Math.round(y) + 0.5)
  ctx.lineTo(to, Math.round(y) + 0.5)
  ctx.stroke()
  ctx.restore()
  if (label) {
    ctx.font = `10px ${FONT}`
    ctx.textAlign = 'right'
    ctx.textBaseline = 'bottom'
    ctx.fillStyle = color
    ctx.fillText(label, labelX ?? to - 2, y - 1)
  }
}

function priceTag(ctx, y, plotW, color, text) {
  ctx.fillStyle = color
  ctx.fillRect(plotW + 1, y - 8, AXIS_W - 2, 16)
  ctx.fillStyle = '#fff'
  ctx.font = `bold 11px ${FONT}`
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, plotW + 5, y)
}

function rowStepOf(rows) {
  let step = Infinity
  for (let i = 1; i < rows.length; i++) step = Math.min(step, rows[i].price - rows[i - 1].price)
  return Number.isFinite(step) && step > 0 ? step : 1
}

function VolumeProfileChart({ vp, todayVp, range, lastPrice, nav, hoverPrice, onHover, lotSize, showLots, height }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const width = useElementWidth(wrapRef)
  const plotW = Math.max(0, width - AXIS_W)
  const plotH = Math.max(50, height - HEAD_H - 4)
  useProfileNav(canvasRef, plotH, range, nav, onHover)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !width) return
    const ctx = prepareCanvas(canvas, width, height)
    ctx.fillStyle = BG
    ctx.fillRect(0, HEAD_H, plotW, plotH)
    if (!range || !(vp?.rows?.length || todayVp?.rows?.length)) {
      ctx.fillStyle = AXIS_COLOR
      ctx.font = `13px ${FONT}`
      ctx.fillText('No volume profile yet.', 12, HEAD_H + 24)
      return
    }
    vp = vp?.rows?.length ? vp : { rows: [] }
    const span = range.hi - range.lo
    const y = (p) => HEAD_H + ((range.hi - p) / span) * plotH
    const step = rowStepOf(vp.rows.length ? vp.rows : todayVp.rows)
    const rowPx = Math.max(1, (step / span) * plotH)
    const barH = Math.max(1, rowPx - (rowPx > 3 ? 1 : 0))
    const maxRow = vp.maxRow || Math.max(...vp.rows.map((r) => r.total)) || 1
    const barMax = plotW - 70

    ctx.save()
    ctx.beginPath(); ctx.rect(0, HEAD_H, plotW, plotH); ctx.clip()
    axisLabels(ctx, range, plotW, plotH, 'grid')
    // Value area band.
    if (vp.vah != null && vp.val != null) {
      ctx.fillStyle = '#9b8cff12'
      ctx.fillRect(0, y(vp.vah + step / 2), plotW, y(vp.val - step / 2) - y(vp.vah + step / 2))
    }
    for (const r of vp.rows) {
      const top = y(r.price + step / 2) + (rowPx - barH) / 2
      if (top > HEAD_H + plotH || top + barH < HEAD_H) continue
      const inVa = r.price >= vp.val && r.price <= vp.vah
      const w = (r.total / maxRow) * barMax
      const sellW = r.total > 0 ? (r.sell / r.total) * w : 0
      const alpha = inVa ? 'd0' : '70'
      if (r.price === vp.poc) {
        ctx.fillStyle = POC
        ctx.fillRect(0, top, w, barH)
      } else {
        ctx.fillStyle = `#ef5350${alpha}`
        ctx.fillRect(0, top, sellW, barH)
        ctx.fillStyle = `#26a69a${alpha}`
        ctx.fillRect(sellW, top, w - sellW, barH)
      }
    }
    // Today's running profile: its own colour, bars drawn from the right edge so the two shapes never
    // hide each other.
    if (todayVp?.rows?.length) {
      const todayStep = rowStepOf(todayVp.rows)
      const todayRowPx = Math.max(1, (todayStep / span) * plotH)
      const todayBarH = Math.max(1, todayRowPx - (todayRowPx > 3 ? 1 : 0))
      const todayMax = todayVp.maxRow || Math.max(...todayVp.rows.map((r) => r.total)) || 1
      for (const r of todayVp.rows) {
        const top = y(r.price + todayStep / 2) + (todayRowPx - todayBarH) / 2
        if (top > HEAD_H + plotH || top + todayBarH < HEAD_H) continue
        const w = (r.total / todayMax) * (plotW * 0.45)
        const inVa = r.price >= todayVp.val && r.price <= todayVp.vah
        ctx.fillStyle = r.price === todayVp.poc ? RUN.poc : `${RUN.bar}${inVa ? '90' : '45'}`
        ctx.fillRect(plotW - w, top, w, todayBarH)
      }
    }
    // ONE HVN (the strongest after the POC) and ONE LVN (the thinnest) per profile.
    const levels = (p, c, prefix, labelX) => {
      if (!p?.rows?.length) return
      if (p.hvnTop != null) levelLine(ctx, y(p.hvnTop), plotW, c.hvn, `${prefix}HVN ${fmt(p.hvnTop)}`, { dash: [2, 3], labelX })
      if (p.lvnTop != null) levelLine(ctx, y(p.lvnTop), plotW, c.lvn, `${prefix}LVN ${fmt(p.lvnTop)}`, { dash: [2, 3], labelX })
      if (p.vah != null) levelLine(ctx, y(p.vah), plotW, c.va, `${prefix}VAH ${fmt(p.vah)}`, { labelX })
      if (p.val != null) levelLine(ctx, y(p.val), plotW, c.va, `${prefix}VAL ${fmt(p.val)}`, { labelX })
      if (p.poc != null) levelLine(ctx, y(p.poc), plotW, c.poc, `${prefix}POC ${fmt(p.poc)}`, { dash: [], labelX })
    }
    levels(vp, PREV_PROFILE, '', null)
    levels(todayVp, RUNNING_PROFILE, 'today ', plotW * 0.5)
    if (lastPrice > 0) levelLine(ctx, y(lastPrice), plotW, PRICE, null, { dash: [] })
    if (hoverPrice != null) {
      levelLine(ctx, y(hoverPrice), plotW, '#ffffff66', null, { dash: [3, 3] })
      const row = vp.rows.reduce((best, r) => (Math.abs(r.price - hoverPrice) < Math.abs((best?.price ?? Infinity) - hoverPrice) ? r : best), null)
      if (row && Math.abs(row.price - hoverPrice) <= step) {
        ctx.font = `11px ${FONT}`
        ctx.textAlign = 'left'
        ctx.textBaseline = 'bottom'
        ctx.fillStyle = '#e6e6e6'
        ctx.fillText(`${fmt(row.price)}: ${formatVolume(row.total, lotSize, showLots)} (buy ${formatVolume(row.buy, lotSize, showLots)} / sell ${formatVolume(row.sell, lotSize, showLots)})`, 6, y(hoverPrice) - 2)
      }
    }
    ctx.restore()
    axisLabels(ctx, range, plotW, plotH, 'labels')
    if (lastPrice > 0 && lastPrice <= range.hi && lastPrice >= range.lo) priceTag(ctx, y(lastPrice), plotW, PRICE, fmt(lastPrice))
    ctx.fillStyle = AXIS_COLOR
    ctx.font = `11px ${FONT}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(`volume (${showLots ? 'lots' : 'qty'}) - sell | buy`, 4, HEAD_H / 2)
  }, [vp, todayVp, range, lastPrice, hoverPrice, width, height, plotW, plotH, lotSize, showLots])

  return (
    <div ref={wrapRef} style={{ width: '100%', cursor: 'ns-resize' }} aria-label="Volume profile chart">
      <canvas ref={canvasRef} style={{ display: 'block' }} />
    </div>
  )
}

function MarketProfileChart({ prevTpo, todayTpo, range, lastPrice, nav, hoverPrice, onHover, height }) {
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const width = useElementWidth(wrapRef)
  const plotW = Math.max(0, width - AXIS_W)
  const plotH = Math.max(50, height - HEAD_H - 4)
  useProfileNav(canvasRef, plotH, range, nav, onHover)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !width) return
    const ctx = prepareCanvas(canvas, width, height)
    ctx.fillStyle = BG
    ctx.fillRect(0, HEAD_H, plotW, plotH)
    if (!range || (!prevTpo?.rows?.length && !todayTpo?.rows?.length)) {
      ctx.fillStyle = AXIS_COLOR
      ctx.font = `13px ${FONT}`
      ctx.fillText("The TPO profile builds from the first 30-minute period.", 12, HEAD_H + 24)
      return
    }
    const span = range.hi - range.lo
    const y = (p) => HEAD_H + ((range.hi - p) / span) * plotH
    const split = Math.round(plotW * 0.4)
    ctx.save()
    ctx.beginPath(); ctx.rect(0, HEAD_H, plotW, plotH); ctx.clip()
    axisLabels(ctx, range, plotW, plotH, 'grid')

    const drawProfile = (tpo, x0, x1, today) => {
      if (!tpo?.rows?.length) return
      const step = tpo.rowSize
      const rowPx = (step / span) * plotH
      if (tpo.vah != null && tpo.val != null) {
        ctx.fillStyle = today ? '#b37feb14' : '#b37feb10'
        ctx.fillRect(x0, y(tpo.vah + step / 2), x1 - x0, y(tpo.val - step / 2) - y(tpo.vah + step / 2))
      }
      const cell = Math.max(3, Math.min(9, (x1 - x0 - 16) / 26))
      const letters = rowPx >= 8
      ctx.font = `${Math.max(8, Math.min(12, rowPx - 1))}px ${MONO}`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      for (const r of tpo.rows) {
        const cy = y(r.price)
        if (cy < HEAD_H - rowPx || cy > HEAD_H + plotH + rowPx) continue
        const inVa = r.price >= tpo.val && r.price <= tpo.vah
        const isPoc = r.price === tpo.poc
        ;[...r.letters].forEach((l, i) => {
          const color = isPoc ? POC : today && IB_LETTERS.has(l) ? UP_COLOR : inVa ? (today ? '#d9dee5' : '#9aa4b2') : (today ? '#6b7280' : '#4b5563')
          const x = x0 + 4 + i * cell
          if (x + cell > x1) return
          ctx.fillStyle = color
          if (letters) ctx.fillText(l, x, cy)
          else ctx.fillRect(x, cy - Math.max(1, rowPx - 1) / 2, cell - 1, Math.max(1, rowPx - 1))
        })
        if (today && tpo.singles?.includes(r.price)) {
          ctx.fillStyle = DOWN_COLOR
          ctx.fillText('◂', Math.min(x1 - 10, x0 + 6 + r.letters.length * cell), cy)
        }
      }
      if (tpo.poc != null) levelLine(ctx, y(tpo.poc), x1, POC, `${today ? '' : 'p'}POC`, { dash: today ? [] : [5, 4], from: x0 })
      if (tpo.vah != null) levelLine(ctx, y(tpo.vah), x1, TPO_VA, `${today ? '' : 'p'}VAH`, { from: x0 })
      if (tpo.val != null) levelLine(ctx, y(tpo.val), x1, TPO_VA, `${today ? '' : 'p'}VAL`, { from: x0 })
    }
    drawProfile(prevTpo, 0, split - 1, false)
    drawProfile(todayTpo, split + 1, plotW, true)
    // The previous session's value area and POC carried across today's side, faint.
    if (prevTpo?.poc != null) levelLine(ctx, y(prevTpo.poc), plotW, `${POC}66`, null, { dash: [2, 4], from: split })
    if (prevTpo?.vah != null) levelLine(ctx, y(prevTpo.vah), plotW, `${TPO_VA}66`, null, { dash: [2, 4], from: split })
    if (prevTpo?.val != null) levelLine(ctx, y(prevTpo.val), plotW, `${TPO_VA}66`, null, { dash: [2, 4], from: split })
    // Today's initial balance: a bracket on the left edge of today's profile.
    if (todayTpo?.ib) {
      const top = y(todayTpo.ib.high)
      const bottom = y(todayTpo.ib.low)
      ctx.fillStyle = UP_COLOR
      ctx.fillRect(split + 1, top, 2, Math.max(1, bottom - top))
      levelLine(ctx, top, plotW, `${UP_COLOR}aa`, 'IB high', { dash: [1, 3], from: split })
      levelLine(ctx, bottom, plotW, `${UP_COLOR}aa`, 'IB low', { dash: [1, 3], from: split })
    }
    ctx.fillStyle = '#ffffff22'
    ctx.fillRect(split, HEAD_H, 1, plotH)
    if (lastPrice > 0) levelLine(ctx, y(lastPrice), plotW, PRICE, null, { dash: [] })
    if (hoverPrice != null) levelLine(ctx, y(hoverPrice), plotW, '#ffffff66', null, { dash: [3, 3] })
    ctx.restore()
    axisLabels(ctx, range, plotW, plotH, 'labels')
    if (lastPrice > 0 && lastPrice <= range.hi && lastPrice >= range.lo) priceTag(ctx, y(lastPrice), plotW, PRICE, fmt(lastPrice))
    ctx.fillStyle = AXIS_COLOR
    ctx.font = `11px ${FONT}`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText('previous session', 4, HEAD_H / 2)
    ctx.fillText(`today${todayTpo?.periods ? ` (${todayTpo.periods} period${todayTpo.periods === 1 ? '' : 's'})` : ''}`, split + 6, HEAD_H / 2)
  }, [prevTpo, todayTpo, range, lastPrice, hoverPrice, width, height, plotW, plotH])

  return (
    <div ref={wrapRef} style={{ width: '100%', cursor: 'ns-resize' }} aria-label="Market profile chart">
      <canvas ref={canvasRef} style={{ display: 'block' }} />
    </div>
  )
}
