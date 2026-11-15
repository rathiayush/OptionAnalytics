import { useState } from 'react'
import { AlignLeftOutlined, AlignRightOutlined, AppstoreOutlined, CloseOutlined, ColumnWidthOutlined, DollarOutlined, FundOutlined, HeatMapOutlined, LineChartOutlined, RadarChartOutlined, StockOutlined } from '@ant-design/icons'
import { FAB_ACCENT, FAB_GAP, FAB_ITEM_SIZE, FAB_SIZE, FAB_Z, fabDefault, fabEntries, fabOpensUp } from './quickViews.js'
import { useFabDrag } from './useFabDrag.js'

// The quick views as a small round button that floats over the page and can be dragged anywhere: a tap opens the views as
// small icons with their names, a tap on one opens its popup, a tap elsewhere closes them. On a phone it is the only way
// in (no keyboard for the Z X C V B N M keys, and scrolling to each card is slow); on a monitor it saves the same scroll,
// so it shows there too - `enabled` (the page's "Quick button" tick) turns it off. It starts at the BOTTOM LEFT of the
// page, right of the sidebar (fabDefault); where it is dropped is `anchor` - its distance from the nearest corner
// (fabAnchor), kept by the page, so the same place reads right on a phone and on a monitor. `actions` come first, nearest
// the button (fabEntries) - the ORDER panel (asked for - "order punching should also be in the floating popover so I can
// punch trades easily"): { key, label, title, icon (a component), active, onClick }. The order panel also has a button of
// its own, always on screen (OrderFab.jsx). The dragging is useFabDrag's, shared with it.
const ICONS = { dayOi: FundOutlined, oiCharts: LineChartOutlined, oiHeatmap: HeatMapOutlined, premium: DollarOutlined, straddle: ColumnWidthOutlined, gex: RadarChartOutlined, futures: StockOutlined, optionDelta: AlignLeftOutlined, futuresDelta: AlignRightOutlined }
const ACCENT = FAB_ACCENT

export function QuickViewFab({ views, actions = [], active = null, onOpen, enabled = true, anchor = null, onAnchorChange }) {
  const { pos, viewport, inset, dragging, handlers, tapped } = useFabDrag({ anchor, onAnchorChange, start: fabDefault })
  const [open, setOpen] = useState(false)
  if (!enabled) return null

  const entries = fabEntries(views, actions)
  const up = fabOpensUp(pos, entries.length, viewport)
  const labelsLeft = pos.x + FAB_SIZE / 2 > inset + (viewport.width - inset) / 2
  // A tap (not the end of a drag) opens or closes the icons.
  const onClick = () => { if (tapped()) setOpen((o) => !o) }

  const round = (size, background, color) => ({
    width: size, height: size, borderRadius: '50%', border: '1px solid rgba(255,255,255,0.18)', background, color,
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.45)',
  })
  return (
    <>
      {open && <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: FAB_Z - 1, background: 'rgba(0,0,0,0.25)' }} />}
      <div style={{ position: 'fixed', left: pos.x, top: pos.y, width: FAB_SIZE, height: FAB_SIZE, zIndex: FAB_Z }}>
        {open && entries.map((v, i) => {
          const Icon = (v.action ? v.icon : ICONS[v.key]) ?? AppstoreOutlined
          const isActive = v.action ? !!v.active : active === v.key
          const pick = () => { setOpen(false); if (v.action) v.onClick?.(); else onOpen(v.key) }
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
                onClick={pick}
                style={{ ...round(FAB_ITEM_SIZE, isActive ? ACCENT : '#1f2430', '#fff'), flexShrink: 0, fontSize: 15 }}
              >
                <Icon />
              </button>
              <span
                onClick={pick}
                style={{ whiteSpace: 'nowrap', fontSize: 11, color: '#fff', background: 'rgba(22,26,34,0.92)', border: `1px solid ${v.action ? ACCENT : 'rgba(255,255,255,0.12)'}`, borderRadius: 4, padding: '2px 6px', cursor: 'pointer', fontWeight: v.action ? 600 : 400 }}
              >
                {v.label}
              </span>
            </div>
          )
        })}
        <button
          type="button" aria-label={open ? 'Close the quick views' : 'Quick views and order'} aria-expanded={open}
          {...handlers} onClick={onClick}
          style={{ ...round(FAB_SIZE, ACCENT, '#fff'), fontSize: 17, touchAction: 'none', opacity: open || dragging ? 1 : 0.85 }}
        >
          {open ? <CloseOutlined /> : <AppstoreOutlined />}
        </button>
      </div>
    </>
  )
}
