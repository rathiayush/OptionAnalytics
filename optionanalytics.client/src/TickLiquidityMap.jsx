import { useEffect, useMemo, useRef, useState } from 'react'
import { Checkbox, Segmented, Select, Space, Tag, Typography } from 'antd'
import { usePersistedState } from './shared.jsx'
import { FoldText } from './FoldText.jsx'
import { TLM_COLORS, TLM_KINDS, TLM_LABELS, filterMapOrders, priceRowPosition, tickLiquidityDepth, tickLiquidityGrid } from './tickLiquidityMap.js'

const { Text } = Typography
const AXIS_W = 58
const AXIS_H = 22
const ROW_H = 18
const MIN_COL_W = 6
const TFS = [1, 3, 5, 15]
const hhmm = (ms) => new Date(ms).toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })
const crore = (v) => (v >= 1e7 ? `₹${(v / 1e7).toFixed(2)} Cr` : `₹${(v / 1e5).toFixed(1)} L`)
function rgba(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})` }

/**
 * The Tick Flow page's OPTION LIQUIDITY MAP (tickLiquidityMap.js): strikes x time, each cell the big option orders' money in the colour of its biggest kind
 * (four colours), the futures price drawn across it. `orders` are the card's orders after its size filters (up to the replay clock); `priceBars` the futures'
 * 1-minute bars { time (ms), close }; `step` the strike step.
 */
export function TickLiquidityMap({ orders: allOrders, priceBars, step }) {
  const [tf, setTf] = usePersistedState('optionanalytics.tickFlow.liqMapTf', 3)
  // The map's own filters: hedge positions only (deep out of the money), and buyers / sellers / both.
  const [hedgeOnly, setHedgeOnly] = usePersistedState('optionanalytics.tickFlow.liqMapHedge', false)
  const [hedgeSteps, setHedgeSteps] = usePersistedState('optionanalytics.tickFlow.liqMapHedgeSteps', 5)
  const [side, setSide] = usePersistedState('optionanalytics.tickFlow.liqMapSide', 'both')
  const orders = useMemo(() => filterMapOrders(allOrders, { hedgeOnly, hedgeSteps, side }), [allOrders, hedgeOnly, hedgeSteps, side])
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

  const plotW = Math.max(0, width - AXIS_W)
  const maxColumns = Math.max(1, Math.floor(plotW / MIN_COL_W))
  const grid = useMemo(() => tickLiquidityGrid({ orders, bucketMs: tf * 60_000, priceBars, maxColumns, step }), [orders, tf, priceBars, maxColumns, step])
  const height = grid.rows.length * ROW_H + AXIS_H
  const colW = grid.columns.length ? plotW / grid.columns.length : 0

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv || !grid.columns.length || width <= 0) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.floor(width * dpr); cv.height = Math.floor(height * dpr)
    cv.style.width = `${width}px`; cv.style.height = `${height}px`
    const g = cv.getContext('2d')
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    g.clearRect(0, 0, width, height)
    g.font = '11px sans-serif'; g.textBaseline = 'middle'
    grid.rows.forEach((strike, r) => {
      const y = r * ROW_H
      if (r % 2 === 0) { g.fillStyle = 'rgba(255,255,255,0.03)'; g.fillRect(AXIS_W, y, plotW, ROW_H) }
      g.fillStyle = 'rgba(255,255,255,0.65)'; g.textAlign = 'right'
      g.fillText(String(strike), AXIS_W - 6, y + ROW_H / 2)
    })
    grid.columns.forEach((t, c) => {
      const x = AXIS_W + c * colW
      grid.rows.forEach((strike, r) => {
        const cell = grid.cells.get(`${strike}|${t}`)
        if (!cell) return
        g.fillStyle = rgba(TLM_COLORS[cell.kind], 0.15 + 0.85 * tickLiquidityDepth(cell.total, grid.scale))
        g.fillRect(x, r * ROW_H + 1, Math.max(1, colW - 1), ROW_H - 2)
      })
    })
    g.fillStyle = 'rgba(255,255,255,0.65)'; g.textAlign = 'center'
    const every = Math.max(1, Math.ceil(64 / Math.max(colW, 1)))
    grid.columns.forEach((t, c) => { if (c % every === 0) g.fillText(hhmm(t), AXIS_W + c * colW + colW / 2, grid.rows.length * ROW_H + AXIS_H / 2) })
    const t0 = grid.columns[0]
    const span = grid.columns.length * tf * 60_000
    const pts = grid.price.map((p) => {
      const pos = priceRowPosition(p.price, grid.rows)
      return pos == null ? null : { x: AXIS_W + ((p.t - t0 + 30_000) / span) * plotW, y: pos * ROW_H + ROW_H / 2 }
    })
    for (const [w, color] of [[4.5, 'rgba(0,0,0,0.55)'], [2, '#ffffff']]) {
      g.strokeStyle = color; g.lineWidth = w; g.lineJoin = 'round'; g.beginPath()
      let pen = false
      for (const p of pts) { if (!p) { pen = false; continue } if (!pen) { g.moveTo(p.x, p.y); pen = true } else g.lineTo(p.x, p.y) }
      g.stroke()
    }
  }, [grid, width, height, plotW, colW, tf])

  const onMove = (e) => {
    if (!grid.columns.length) return
    const rect = e.currentTarget.getBoundingClientRect()
    const c = Math.floor((e.clientX - rect.left - AXIS_W) / colW)
    const r = Math.floor((e.clientY - rect.top) / ROW_H)
    if (c < 0 || c >= grid.columns.length || r < 0 || r >= grid.rows.length) { setHover(null); return }
    const strike = grid.rows[r]
    const t = grid.columns[c]
    setHover({ strike, t, cell: grid.cells.get(`${strike}|${t}`) ?? null, x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  return (
    <Space direction="vertical" size={6} style={{ width: '100%' }}>
      <Space wrap size={[10, 6]}>
        <Text strong>Option liquidity map</Text>
        <span>Bucket <Select size="small" value={tf} onChange={setTf} style={{ width: 80 }} options={TFS.map((v) => ({ value: v, label: `${v} min` }))} /></span>
        <Checkbox checked={hedgeOnly} onChange={(e) => setHedgeOnly(e.target.checked)}>Hedge positions (≥ <Select size="small" value={hedgeSteps} onChange={setHedgeSteps} style={{ width: 60 }} options={Array.from({ length: 10 }, (_, i) => ({ value: i + 1, label: i + 1 }))} onClick={(e) => e.stopPropagation()} /> strikes out of the money)</Checkbox>
        <Segmented size="small" value={side} onChange={setSide} options={[{ value: 'both', label: 'Buyers + sellers' }, { value: 'buy', label: 'Buyers only' }, { value: 'sell', label: 'Sellers only' }]} aria-label="Map side" />
        {TLM_KINDS.map((k) => <Tag key={k} color={TLM_COLORS[k]} style={{ marginInlineEnd: 0 }}>{TLM_LABELS[k]}</Tag>)}
        <Tag style={{ marginInlineEnd: 0, color: '#fff', background: '#555' }}>━ Futures price</Tag>
      </Space>
      <div ref={wrapRef} style={{ position: 'relative', width: '100%' }}>
        {!grid.columns.length
          ? <Text type="secondary">No big option order with a read yet - nothing to map (or the filters above leave none).</Text>
          : (
            <>
              <canvas ref={canvasRef} onMouseMove={onMove} onMouseLeave={() => setHover(null)} style={{ display: 'block' }} />
              {hover && (
                <div style={{ position: 'absolute', left: Math.min(hover.x + 12, Math.max(0, width - 220)), top: hover.y + 10, background: 'rgba(20,20,20,0.95)', border: '1px solid #444', borderRadius: 4, padding: '4px 8px', fontSize: 12, pointerEvents: 'none', zIndex: 5, whiteSpace: 'nowrap' }}>
                  <div><b>{hover.strike}</b> · {hhmm(hover.t)}</div>
                  {hover.cell
                    ? TLM_KINDS.filter((k) => hover.cell[k] > 0).map((k) => <div key={k} style={{ color: TLM_COLORS[k] }}>{TLM_LABELS[k]}: {crore(hover.cell[k])}</div>)
                    : <div style={{ opacity: 0.6 }}>no big order</div>}
                  {hover.cell && <div style={{ opacity: 0.7 }}>{hover.cell.count} order{hover.cell.count === 1 ? '' : 's'}</div>}
                </div>
              )}
            </>
          )}
      </div>
      <FoldText id="tickLiquidityMap.how" className="oa-note" summary="How to read the option liquidity map">
        <div style={{ fontSize: 12 }}>
          Each row is a strike, each column a time bucket; a cell is where TrueData's option ticks showed a big order and takes the colour of the kind with the most
          money in it, deeper the more rupees against the busiest cells in view. Cool colours are the bullish pair (calls bought, puts written), warm the bearish pair
          (puts bought, calls written) - read from the side the quote gave and the OI change, so "written" needs an OI reading. The white line is the NEAR FUTURES
          price (TrueData's feed has the futures, not the index). The size filters above apply, then this map's own: "Hedge positions" shows only the orders N or more strikes out of the money (the cheap protection options), and Buyers / Sellers keeps one side of the option. A lead, not a signal - it places nothing.
        </div>
      </FoldText>
    </Space>
  )
}
