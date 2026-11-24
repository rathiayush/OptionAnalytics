import { useEffect, useMemo, useRef, useState } from 'react'
import { Select, Space, Tag, Typography } from 'antd'
import { istTimeFormatter, usePersistedState } from './shared.jsx'
import { FoldText } from './FoldText.jsx'
import { LIQ_COLORS, liquidityDepth, liquidityGrid, spotRowPosition } from './oiLiquidityMap.js'

const { Text } = Typography
const AXIS_W = 58
const AXIS_H = 22
const ROW_H = 18
const MIN_COL_W = 7
const BANDS = [5, 8, 10, 15]
const TFS = [1, 3, 5, 15]
const KEY = [
  ['ceAdd', 'Calls added (writers - resistance)'],
  ['ceCut', 'Calls cut (resistance unwinding)'],
  ['peAdd', 'Puts added (writers - support)'],
  ['peCut', 'Puts cut (support unwinding)'],
]
const num = (v) => Math.round(v).toLocaleString('en-IN')

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}

/**
 * OI Replay's OI LIQUIDITY MAP (oiLiquidityMap.js): strikes x time, each cell split into the CALL half (left) and the PUT half (right), four colours for
 * added / cut OI, the spot price drawn across it. `buildMatrix(byStrike, strikes, asOfMs, minutes)` is the page's own buildOiChangeMatrix.
 */
export function OiLiquidityMapCard({ ceByStrike, peByStrike, strikes, atmStrike, asOfMs, spotBars, buildMatrix }) {
  const [band, setBand] = usePersistedState('optionanalytics.oiReplay.liqMapBand', 10)
  const [tf, setTf] = usePersistedState('optionanalytics.oiReplay.liqMapTf', 3)
  const wrapRef = useRef(null)
  const canvasRef = useRef(null)
  const [width, setWidth] = useState(0)
  const [hover, setHover] = useState(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // The band: ATM +/- N strikes of the strikes the page tracks (nearest the ATM now).
  const shown = useMemo(() => {
    const all = [...new Set(strikes ?? [])].sort((a, b) => a - b)
    if (!all.length) return []
    const at = atmStrike ?? all[Math.floor(all.length / 2)]
    let i = all.findIndex((s) => s >= at)
    if (i < 0) i = all.length - 1
    return all.slice(Math.max(0, i - band), i + band + 1)
  }, [strikes, atmStrike, band])

  const plotW = Math.max(0, width - AXIS_W)
  const maxColumns = Math.max(1, Math.floor(plotW / MIN_COL_W))
  const grid = useMemo(() => {
    if (!shown.length) return null
    const ceMatrix = buildMatrix(ceByStrike, shown, asOfMs, tf)
    const peMatrix = buildMatrix(peByStrike, shown, asOfMs, tf)
    return liquidityGrid({ ceMatrix, peMatrix, strikes: shown, bucketSeconds: tf * 60, spotBars, maxColumns })
  }, [shown, ceByStrike, peByStrike, asOfMs, tf, spotBars, maxColumns, buildMatrix])

  const height = (grid?.rows.length ?? 0) * ROW_H + AXIS_H
  const colW = grid?.columns.length ? plotW / grid.columns.length : 0

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || !grid || width <= 0) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.floor(width * dpr); cv.height = Math.floor(height * dpr)
    cv.style.width = `${width}px`; cv.style.height = `${height}px`
    const g = cv.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, height)
    g.font = '11px sans-serif'; g.textBaseline = 'middle'
    // The strike rows: labels, the ATM row marked.
    grid.rows.forEach((strike, r) => {
      const y = r * ROW_H
      if (r % 2 === 0) { g.fillStyle = 'rgba(255,255,255,0.03)'; g.fillRect(AXIS_W, y, plotW, ROW_H) }
      g.fillStyle = strike === atmStrike ? '#fff' : 'rgba(255,255,255,0.65)'
      g.textAlign = 'right'
      g.fillText(`${strike}${strike === atmStrike ? ' ◂' : ''}`, AXIS_W - 6, y + ROW_H / 2)
    })
    // The cells: call half left, put half right.
    grid.columns.forEach((t, c) => {
      const x = AXIS_W + c * colW
      grid.rows.forEach((strike, r) => {
        const cell = grid.cells.get(`${strike}|${t}`)
        if (!cell) return
        const y = r * ROW_H
        const half = Math.max(1, colW / 2 - 0.5)
        if (cell.ce) { g.fillStyle = rgba(cell.ce > 0 ? LIQ_COLORS.ceAdd : LIQ_COLORS.ceCut, 0.1 + 0.9 * liquidityDepth(cell.ce, grid.scale)); g.fillRect(x, y + 1, half, ROW_H - 2) }
        if (cell.pe) { g.fillStyle = rgba(cell.pe > 0 ? LIQ_COLORS.peAdd : LIQ_COLORS.peCut, 0.1 + 0.9 * liquidityDepth(cell.pe, grid.scale)); g.fillRect(x + colW / 2, y + 1, half, ROW_H - 2) }
      })
    })
    // The time axis: a label about every 60 px.
    g.fillStyle = 'rgba(255,255,255,0.65)'; g.textAlign = 'center'
    const every = Math.max(1, Math.ceil(60 / Math.max(colW, 1)))
    grid.columns.forEach((t, c) => { if (c % every === 0) g.fillText(istTimeFormatter(t), AXIS_W + c * colW + colW / 2, grid.rows.length * ROW_H + AXIS_H / 2) })
    // The spot price: a white line (on a dark outline) across the map, each 1-minute close at its own time.
    const t0 = grid.columns[0]
    const span = grid.columns.length * tf * 60
    const pts = grid.spot.map((p) => {
      const pos = spotRowPosition(p.price, grid.rows)
      return pos == null ? null : { x: AXIS_W + ((p.t - t0 + 30) / span) * plotW, y: pos * ROW_H + ROW_H / 2 }
    })
    for (const [w, color] of [[4.5, 'rgba(0,0,0,0.55)'], [2, '#ffffff']]) {
      g.strokeStyle = color; g.lineWidth = w; g.lineJoin = 'round'; g.beginPath()
      let pen = false
      for (const p of pts) { if (!p) { pen = false; continue } if (!pen) { g.moveTo(p.x, p.y); pen = true } else g.lineTo(p.x, p.y) }
      g.stroke()
    }
  }, [grid, width, height, plotW, colW, atmStrike, tf])

  const onMove = (e) => {
    if (!grid || !grid.columns.length) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left - AXIS_W
    const y = e.clientY - rect.top
    const c = Math.floor(x / colW)
    const r = Math.floor(y / ROW_H)
    if (c < 0 || c >= grid.columns.length || r < 0 || r >= grid.rows.length) { setHover(null); return }
    const strike = grid.rows[r]
    const t = grid.columns[c]
    setHover({ strike, t, cell: grid.cells.get(`${strike}|${t}`) ?? { ce: 0, pe: 0 }, x: e.clientX - rect.left, y })
  }

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap size={[12, 6]}>
        <span>Strikes ATM ± <Select size="small" value={band} onChange={setBand} style={{ width: 70 }} options={BANDS.map((v) => ({ value: v, label: v }))} /></span>
        <span>Bucket <Select size="small" value={tf} onChange={setTf} style={{ width: 80 }} options={TFS.map((v) => ({ value: v, label: `${v} min` }))} /></span>
        {KEY.map(([k, label]) => <Tag key={k} color={LIQ_COLORS[k]} style={{ marginInlineEnd: 0 }}>{label}</Tag>)}
        <Tag color="default" style={{ marginInlineEnd: 0, color: '#fff', background: '#555' }}>━ Spot price</Tag>
      </Space>
      <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
        {!grid || !grid.columns.length
          ? <Text type="secondary">No OI change to draw yet.</Text>
          : (
            <>
              <canvas ref={canvasRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ display: 'block' }} />
              {hover && (
                <div style={{ position: 'absolute', left: Math.min(hover.x + 12, Math.max(0, width - 190)), top: hover.y + 10, background: 'rgba(20,20,20,0.95)', border: '1px solid #444', borderRadius: 4, padding: '4px 8px', fontSize: 12, pointerEvents: 'none', zIndex: 5, whiteSpace: 'nowrap' }}>
                  <div><b>{hover.strike}</b> · {istTimeFormatter(hover.t)}</div>
                  <div style={{ color: hover.cell.ce >= 0 ? LIQ_COLORS.ceAdd : LIQ_COLORS.ceCut }}>Calls {hover.cell.ce > 0 ? '+' : ''}{num(hover.cell.ce)} OI</div>
                  <div style={{ color: hover.cell.pe >= 0 ? LIQ_COLORS.peAdd : LIQ_COLORS.peCut }}>Puts {hover.cell.pe > 0 ? '+' : ''}{num(hover.cell.pe)} OI</div>
                </div>
              )}
            </>
          )}
      </div>
      <FoldText id="oiLiquidityMap.how" className="oa-note" summary="How to read the OI liquidity map">
        <div style={{ fontSize: 12 }}>
          Each row is a strike, each column a time bucket. A cell is split: the left half is the CALL side, the right half the PUT side, each as deep as the OI
          change in that bucket is against the 95th percentile of the changes in view. Red = calls added (writers building resistance), orange = calls cut,
          green = puts added (writers building support), blue = puts cut. The white line is the spot price. A deep red block just above the line is a wall
          forming overhead; a deep green block under it is a floor; orange / blue show a wall being pulled. Only readings up to the replay clock are used.
          A read of where option money moved - it places nothing and feeds no signal or alert.
        </div>
      </FoldText>
    </Space>
  )
}
