import { useRef, useState } from 'react'
import { useSideNavInset, useViewport } from './useScreen.js'
import { fabAnchor, fabFromAnchor, isFabDrag, placeFab } from './quickViews.js'

// A floating round button dragged anywhere on the screen - the quick button (QuickViewFab.jsx) and the order button
// (OrderFab.jsx) alike. `anchor` is where it was dropped, kept by the page as its distance from the nearest corner
// (quickViews.fabAnchor - the same place reads right on a phone and on a monitor); `start(viewport, inset)` its first
// place. A press that moves is a drag (the button follows, the new corner goes to `onAnchorChange` on release); one that
// does not is a tap - `tapped()` in the button's onClick says which (the click that ends a drag is not a tap).
export function useFabDrag({ anchor = null, onAnchorChange, start }) {
  const viewport = useViewport()
  const inset = useSideNavInset()
  const [dragPos, setDragPos] = useState(null)
  const drag = useRef(null)
  const dragged = useRef(false)

  const pos = placeFab(dragPos ?? fabFromAnchor(anchor, viewport, inset) ?? start(viewport, inset), viewport, inset)
  const moveTo = (e, d) => placeFab({ x: d.from.x + e.clientX - d.x, y: d.from.y + e.clientY - d.y }, viewport, inset)
  const handlers = {
    onPointerDown: (e) => {
      e.currentTarget.setPointerCapture?.(e.pointerId)
      drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: pos, moved: false }
    },
    onPointerMove: (e) => {
      const d = drag.current
      if (!d || d.id !== e.pointerId) return
      if (!d.moved && !isFabDrag(e.clientX - d.x, e.clientY - d.y)) return
      d.moved = true
      setDragPos(moveTo(e, d))
    },
    onPointerUp: (e) => {
      const d = drag.current
      drag.current = null
      if (!d || d.id !== e.pointerId) return
      dragged.current = d.moved
      if (d.moved) { onAnchorChange?.(fabAnchor(moveTo(e, d), viewport, inset)); setDragPos(null) }
    },
    onPointerCancel: () => { drag.current = null; setDragPos(null) },
  }
  const tapped = () => {
    if (!dragged.current) return true
    dragged.current = false
    return false
  }
  return { pos, viewport, inset, dragging: dragPos != null, handlers, tapped }
}
