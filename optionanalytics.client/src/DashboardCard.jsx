import { createContext, useContext, useRef, useState } from 'react'
import { Tooltip } from 'antd'
import { LAYOUT_COLUMNS, MIN_SPAN, cardStyle, contentHeight, heightFromDrag, layoutEntry, spanFromDrag } from './dashboardLayout.js'

// One card on the OI Replay dashboard: the page's own <Card> in a wrapper that gives it its width and
// height from the saved layout (dashboardLayout.js), and - while "Adjust layout" is on - a grip at its
// bottom-right corner to drag either one.
//
// Dragging sideways changes the width a twelfth at a time (so cards tile into rows), downwards the
// height. The size follows the pointer live and is saved when it is let go, so a drag is one undoable
// change rather than a hundred. Double-click the grip to give the card its own height back.
//
// The charts inside already follow their container's width (every one of them has a ResizeObserver), so
// a narrower card redraws its chart narrower by itself. Height is the card's own: a chart that wants to
// FILL the card reads useCardContentHeight() instead of keeping its fixed height - the height it is GIVEN,
// not the one under the pointer mid-drag, since a chart that rebuilds on a new height would otherwise be
// torn down and built again on every pixel of the drag.

const CardHeightContext = createContext(null)

/** The height a chart inside a sized card should use, or `fallback` where the card has its own height
 *  (not sized, or a narrow screen). */
export function useCardContentHeight(fallback) {
  return useContext(CardHeightContext) ?? fallback
}

const GRIP_SIZE = 18

export function DashboardCard({
  id, entry, order = 0, wide = true, editing = false, onChange, dropProps = {}, chromePx = 86, children,
}) {
  const ref = useRef(null)
  const drag = useRef(null)
  const [live, setLive] = useState(null)   // the size under the pointer, before it is let go
  const shown = live ?? entry
  const { style: dropStyle, ...dropHandlers } = dropProps

  const onPointerDown = (e) => {
    if (!wide) return
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture?.(e.pointerId)
    const row = ref.current?.parentElement
    drag.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      from: layoutEntry(entry),
      rowPx: row?.clientWidth ?? 0,
      measured: ref.current?.offsetHeight ?? null,
    }
  }
  const onPointerMove = (e) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    setLive({
      span: spanFromDrag(d.from.span, e.clientX - d.x, d.rowPx),
      h: heightFromDrag(d.from.h, e.clientY - d.y, d.measured),
    })
  }
  const endDrag = (e) => {
    const d = drag.current
    drag.current = null
    if (!d || d.id !== e.pointerId) return
    const next = live
    setLive(null)
    if (next && (next.span !== d.from.span || next.h !== d.from.h)) onChange?.(id, next)
  }
  // Its own height back - the one thing a drag cannot do, since the grip only ever sets a height.
  const onDoubleClick = (e) => { e.preventDefault(); e.stopPropagation(); onChange?.(id, { ...layoutEntry(entry), h: null }) }

  const sized = wide && shown.h != null
  return (
    <CardHeightContext.Provider value={contentHeight(entry, { wide, chromePx })}>
      <div
        ref={ref}
        className={`oa-dash-card${sized ? ' oa-dash-card--sized' : ''}`}
        style={{ ...cardStyle(shown, { wide, order }), ...dropStyle, position: 'relative' }}
        {...dropHandlers}
      >
        {children}
        {editing && wide && (
          <>
            <Tooltip title={`Drag: sideways for the width (${shown.span}/${LAYOUT_COLUMNS}), down for the height${shown.h != null ? ` (${shown.h}px)` : ''}. Double-click for its own height back.`}>
              <span
                role="separator"
                aria-label={`Resize ${id}`}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onDoubleClick={onDoubleClick}
                style={{
                  position: 'absolute', right: 1, bottom: 1, width: GRIP_SIZE, height: GRIP_SIZE, cursor: 'nwse-resize',
                  zIndex: 3, borderRadius: '4px 0 6px 0', background: '#1677ffcc', touchAction: 'none',
                  backgroundImage: 'linear-gradient(135deg, transparent 45%, #fff 45%, #fff 55%, transparent 55%)',
                }}
              />
            </Tooltip>
            <span style={{
              position: 'absolute', right: GRIP_SIZE + 5, bottom: 2, zIndex: 3, pointerEvents: 'none',
              fontSize: 10, color: '#cfe3ff', background: '#0b1220cc', borderRadius: 4, padding: '0 4px',
            }}
            >
              {shown.span}/{LAYOUT_COLUMNS}{shown.h != null ? ` · ${shown.h}px` : ''}
            </span>
          </>
        )}
      </div>
    </CardHeightContext.Provider>
  )
}

export { MIN_SPAN }
