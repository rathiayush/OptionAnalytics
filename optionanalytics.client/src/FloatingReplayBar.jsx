import { useSideNavInset, useViewport } from './useScreen.js'
import { FAB_EDGE, FAB_SIZE, fabDefault, fabFromAnchor, fabInBarRow } from './quickViews.js'

// OI Replay's replay controls as a slim bar FLOATING at the bottom of the window (asked for - "replay bar also should be
// floating"): on a replayed day, once the Spot card's own replay controls are scrolled out of sight (or that card is
// hidden), so Start / Pause, Reset, the slider and the speed stay in reach from any card - the inline controls, their
// "Float" panel and everything they do are unchanged (the bar is the same controls, the same state). It starts right of
// the quick button when that sits in its row at the bottom left, never under the sidebar, and is at most `MAX_WIDTH`
// wide, centred, on a big monitor. The page's "Replay bar" tick turns it off.
const BAR_Z = 955 // over the floating panels (900+), under the quick button (960) and the popups (1000)
const MAX_WIDTH = 980


export function FloatingReplayBar({ fabOn = true, fabAnchor = null, children }) {
  const viewport = useViewport()
  const inset = useSideNavInset()
  const fab = fabOn ? (fabFromAnchor(fabAnchor, viewport, inset) ?? fabDefault(viewport, inset)) : null
  const left = inset + FAB_EDGE + (fab && fabInBarRow(fab, viewport, inset) ? FAB_SIZE + 10 : 0)
  return (
    <div
      role="toolbar" aria-label="Replay" className="oa-replay-bar"
      style={{
        position: 'fixed', left, right: FAB_EDGE, bottom: `calc(${FAB_EDGE}px + env(safe-area-inset-bottom, 0px))`,
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
