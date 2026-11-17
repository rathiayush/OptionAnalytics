import { useSideNavInset, useViewport } from './useScreen.js'
import { readStored } from './shared.jsx'
import { STORED_ORDER_FAB, STORED_ORDER_FAB_ANCHOR, STORED_QUICK_FAB, STORED_QUICK_FAB_ANCHOR } from './dashboardLayout.js'
import { FAB_EDGE, FAB_ROW_GAP, FAB_SIZE, fabDefault, fabFromAnchor, fabInBarRow, fabInBarRowRight, orderFabDefault } from './quickViews.js'

// OI Replay's replay controls as a slim bar FLOATING at the bottom of the window (asked for - "replay bar also should be
// floating"): on a replayed day, once the Spot card's own replay controls are scrolled out of sight (or that card is
// hidden), so Start / Pause, Reset, the slider and the speed stay in reach from any card - the inline controls, their
// "Float" panel and everything they do are unchanged (the bar is the same controls, the same state). It starts right of
// the quick button when that sits in its row at the bottom left, never under the sidebar, ends left of the order button
// (OrderFab.jsx) when that was dropped in its row at the bottom right, and is at most `MAX_WIDTH` wide, centred, on a big
// monitor. The page's "Replay bar" tick turns it off.
const BAR_Z = 955 // over the floating panels (900+), under the quick button (960) and the popups (1000)
const MAX_WIDTH = 980

// `appFabs`: the page's buttons are the APP-WIDE ones (GlobalFloating.jsx - the Profiles and Order Flow pages): the bar
// reads their ticks and anchors (OI Replay's account preferences) itself at every render (the bar re-renders with each
// replay step, so a button dragged meanwhile is followed), so it stands beside them, not under them.
export function FloatingReplayBar({ appFabs = false, fabOn: fabOnProp = true, fabAnchor: fabAnchorProp = null, orderOn: orderOnProp = false, orderAnchor: orderAnchorProp = null, children }) {
  const viewport = useViewport()
  const inset = useSideNavInset()
  const fabOn = appFabs ? readStored(STORED_QUICK_FAB, true) : fabOnProp
  const fabAnchor = appFabs ? readStored(STORED_QUICK_FAB_ANCHOR, null) : fabAnchorProp
  const orderOn = appFabs ? readStored(STORED_ORDER_FAB, true) : orderOnProp
  const orderAnchor = appFabs ? readStored(STORED_ORDER_FAB_ANCHOR, null) : orderAnchorProp
  const fab = fabOn ? (fabFromAnchor(fabAnchor, viewport, inset) ?? fabDefault(viewport, inset)) : null
  const order = orderOn ? (fabFromAnchor(orderAnchor, viewport, inset) ?? orderFabDefault(viewport, inset)) : null
  const left = inset + FAB_EDGE + (fab && fabInBarRow(fab, viewport, inset) ? FAB_SIZE + FAB_ROW_GAP : 0)
  const right = FAB_EDGE + (order && fabInBarRowRight(order, viewport) ? FAB_SIZE + FAB_ROW_GAP : 0)
  return (
    <div
      role="toolbar" aria-label="Replay" className="oa-replay-bar"
      style={{
        position: 'fixed', left, right, bottom: `calc(${FAB_EDGE}px + env(safe-area-inset-bottom, 0px))`,
        maxWidth: MAX_WIDTH, margin: '0 auto', minHeight: FAB_SIZE, boxSizing: 'border-box', zIndex: BAR_Z,
        display: 'flex', alignItems: 'center', gap: 8, padding: '3px 12px 3px 6px',
        background: '#161a22', border: '1px solid rgba(255,255,255,0.16)', borderRadius: FAB_SIZE / 2,
        boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
      }}
    >
      {children}
    </div>
  )
}
