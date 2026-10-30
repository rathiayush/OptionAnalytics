import { useEffect, useRef, useState } from 'react'
import { AppstoreOutlined, CloseOutlined, ColumnWidthOutlined, DollarOutlined, FundOutlined, HeatMapOutlined, LineChartOutlined, RadarChartOutlined, StockOutlined } from '@ant-design/icons'
import { usePersistedState } from './shared.jsx'
import { FAB_GAP, FAB_ITEM_SIZE, FAB_SIZE, fabDefault, fabOpensUp, isFabDrag, placeFab } from './quickViews.js'

// The quick views as a small round button that floats over the page and can be dragged anywhere (where it was left is
// remembered): a tap opens the views as small icons with their names, a tap on one opens its popup, a tap elsewhere closes
// them. On a phone it is the only way in (no keyboard for the Z X C V B N M keys, and scrolling to each card is slow); on a
// monitor it saves the same scroll, so it shows there too - `enabled` (the page's "Quick button" tick) turns it off.
const ICONS = { dayOi: FundOutlined, oiCharts: LineChartOutlined, oiHeatmap: HeatMapOutlined, premium: DollarOutlined, straddle: ColumnWidthOutlined, gex: RadarChartOutlined, futures: StockOutlined }
// Over the floating panels (900+), under the popups (1000).
const FAB_Z = 960
const ACCENT = '#1677ff'

function useViewport() {
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return viewport
}

export function QuickViewFab({ views, active = null, onOpen, enabled = true }) {
  const viewport = useViewport()
  const [saved, setSaved] = usePersistedState('optionanalytics.oiReplay.quickFab', null)
  const [dragPos, setDragPos] = useState(null)
  const [open, setOpen] = useState(false)
  const drag = useRef(null)
  const dragged = useRef(false)
  if (!enabled) return null

  const pos = placeFab(dragPos ?? saved ?? fabDefault(viewport), viewport)
  const up = fabOpensUp(pos, views.length, viewport)
  const labelsLeft = pos.x + FAB_SIZE / 2 > viewport.width / 2

  const moveTo = (e, d) => placeFab({ x: d.from.x + e.clientX - d.x, y: d.from.y + e.clientY - d.y }, viewport)
  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId)
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: pos, moved: false }
  }
  const onPointerMove = (e) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    if (!d.moved && !isFabDrag(e.clientX - d.x, e.clientY - d.y)) return
    d.moved = true
    setDragPos(moveTo(e, d))
  }
  const onPointerUp = (e) => {
    const d = drag.current
    drag.current = null
    if (!d || d.id !== e.pointerId) return
    dragged.current = d.moved
    if (d.moved) { setSaved(moveTo(e, d)); setDragPos(null) }
  }
  const onPointerCancel = () => { drag.current = null; setDragPos(null) }
  // A tap (not the end of a drag) opens or closes the icons.
  const onClick = () => {
    if (dragged.current) { dragged.current = false; return }
    setOpen((o) => !o)
  }

  const round = (size, background, color) => ({
    width: size, height: size, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.18)', background, color,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
  })
  return (
    <>
      {open && <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: FAB_Z - 1, background: 'rgba(0,0,0,0.25)' }} />}
      <div style={{ position: 'fixed', left: pos.x, top: pos.y, width: FAB_SIZE, height: FAB_SIZE, zIndex: FAB_Z }}>
        {open && views.map((v, i) => {
          const Icon = ICONS[v.key] ?? AppstoreOutlined
          // Centred on the button, one above (or below) the other.
          const inset = (FAB_SIZE - FAB_ITEM_SIZE) / 2
          return (
            <div
              key={v.key}
              style={{
                position: 'absolute', left: inset, top: inset + (up ? -1 : 1) * (i + 1) * (FAB_ITEM_SIZE + FAB_GAP),
                display: 'flex', alignItems: 'center', flexDirection: labelsLeft ? 'row-reverse' : 'row', gap: 6, width: FAB_ITEM_SIZE,
              }}
            >
              <button
                type="button" aria-label={v.title} title={v.title}
                onClick={() => { setOpen(false); onOpen(v.key) }}
                style={{ ...round(FAB_ITEM_SIZE, active === v.key ? ACCENT : '#1f2430', '#fff'), flexShrink: 0, fontSize: 15 }}
              >
                <Icon />
              </button>
              <span
                onClick={() => { setOpen(false); onOpen(v.key) }}
                style={{ whiteSpace: 'nowrap', fontSize: 11, color: '#fff', background: 'rgba(22,26,34,0.92)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 4, padding: '2px 6px', cursor: 'pointer' }}
              >
                {v.label}
              </span>
            </div>
          )
        })}
        <button
          type="button" aria-label={open ? 'Close the quick views' : 'Quick views'} aria-expanded={open}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerCancel} onClick={onClick}
          style={{ ...round(FAB_SIZE, ACCENT, '#fff'), fontSize: 17, touchAction: 'none', opacity: open || dragPos ? 1 : 0.85 }}
        >
          {open ? <CloseOutlined /> : <AppstoreOutlined />}
        </button>
      </div>
    </>
  )
}
