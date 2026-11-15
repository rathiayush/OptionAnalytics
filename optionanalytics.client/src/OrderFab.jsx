import { ShoppingCartOutlined } from '@ant-design/icons'
import { FAB_ACCENT, FAB_SIZE, FAB_Z, orderFabDefault } from './quickViews.js'
import { useFabDrag } from './useFabDrag.js'

// OI Replay's ORDER button (asked for - "order punching should also be in the floating popover so I can punch trades
// easily", then "there as well as popover somewhere on screen"): a round cart button ALWAYS ON SCREEN whose one tap opens
// / closes the Paper / Live order panel - the "Paper Trade" button's own floating panel, the same as the quick button's
// Order item. It starts at the BOTTOM RIGHT, one row above the floating replay bar (quickViews.orderFabDefault), is
// dragged anywhere, and where it was dropped is `anchor` (its nearest corner, kept by the page) - useFabDrag, as the
// quick button. Blue while the panel is open; a red ring and a LIVE tag while Live mode is on. It only opens the panel:
// a live order still goes through the panel's own confirm. `enabled` is the page's "Order button" tick.
const LIVE_RED = '#ff4d4f'

export function OrderFab({ open = false, live = false, onToggle, enabled = true, anchor = null, onAnchorChange }) {
  const { pos, dragging, handlers, tapped } = useFabDrag({ anchor, onAnchorChange, start: orderFabDefault })
  if (!enabled) return null
  const title = open ? 'Close the order panel' : `Punch a trade - the ${live ? 'LIVE (Dhan)' : 'Paper'} order panel`
  return (
    <button
      type="button" className="oa-order-fab" aria-label={title} title={title} aria-pressed={open}
      {...handlers} onClick={() => { if (tapped()) onToggle?.() }}
      style={{
        position: 'fixed', left: pos.x, top: pos.y, width: FAB_SIZE, height: FAB_SIZE, zIndex: FAB_Z, boxSizing: 'border-box',
        borderRadius: '50%', border: `2px solid ${live ? LIVE_RED : FAB_ACCENT}`, background: open ? FAB_ACCENT : '#1f2430', color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, cursor: 'pointer', fontSize: 18,
        boxShadow: '0 2px 8px rgba(0,0,0,0.45)', touchAction: 'none', opacity: open || dragging ? 1 : 0.92,
      }}
    >
      <ShoppingCartOutlined />
      {live && (
        <span style={{ position: 'absolute', top: -7, right: -9, fontSize: 9, lineHeight: '13px', fontWeight: 700, letterSpacing: 0.3, color: '#fff', background: LIVE_RED, borderRadius: 6, padding: '0 4px', pointerEvents: 'none' }}>
          LIVE
        </span>
      )}
    </button>
  )
}
