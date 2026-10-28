import { useEffect, useRef, useState } from 'react'
import ReactGridLayout from 'react-grid-layout/legacy'
import 'react-grid-layout/css/styles.css'
import { GRID_COLS, GRID_MARGIN, GRID_ROW_HEIGHT, MIN_H, MIN_W, reconcileGridLayout } from './dashboardLayout.js'

// The OI Replay cards as a dashboard: a 12-column grid any card can be dragged around and resized in
// (react-grid-layout), or - under WIDE_LAYOUT_PX, which the page decides and passes as `wide` - the plain
// full-width stack the page has always had on a phone.
//
// The cards are this component's own children, passed straight through: react-grid-layout matches each one
// to its layout item BY KEY, so a card that is currently hidden ("Sections shown") simply is not there and
// the rest keep their places. Nothing is cloned or re-keyed on the way, which is why the children go to it
// untouched rather than through Children.toArray.
//
// Dragging starts from the card's own ⠿ grip (`draggableHandle`), never from the card's body - otherwise
// every attempt to scrub a chart or select a number would move the card instead.

const DRAG_HANDLE = '.oa-dash-grip'
// A chart, a table or a drawing is not something to start a drag from even when it is under the grip.
const DRAG_CANCEL = '.ant-select, .ant-input, input, textarea, button, canvas, table, .ant-switch, .ant-checkbox'

/** The width of `ref`'s element, followed as it changes - react-grid-layout's legacy API is told its own
 *  width rather than measuring it. 0 until it has been measured once. */
function useWidth(ref) {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)))
    observer.observe(element)
    setWidth(Math.floor(element.getBoundingClientRect().width))
    return () => observer.disconnect()
  }, [ref])
  return width
}

export function DashboardGrid({
  wide, cardIds, order, layout, onLayoutChange, onResizeCard, editing = false, freePlacement = false, children,
}) {
  const ref = useRef(null)
  const width = useWidth(ref)
  // While a card is being resized or dragged the grid keeps at least the height it had when that started. Without it,
  // shrinking the bottom card shortened the page, the browser scrolled up to match, the card's corner moved away from
  // the pointer - and the card shrank again, all the way down to its minimum, from a small drag.
  const [holdHeight, setHoldHeight] = useState(null)
  const hold = () => setHoldHeight(ref.current?.offsetHeight ?? null)
  const release = () => setHoldHeight(null)

  if (!wide) return <div className="oi-dash-stack">{children}</div>

  const items = reconcileGridLayout(layout, cardIds, order)
  return (
    <div ref={ref} className={`oi-dash-grid${editing ? ' oi-dash-grid--editing' : ''}`} style={holdHeight ? { minHeight: holdHeight } : undefined}>
      {width > 0 && (
        <ReactGridLayout
          width={width}
          cols={GRID_COLS}
          rowHeight={GRID_ROW_HEIGHT}
          margin={[GRID_MARGIN, GRID_MARGIN]}
          containerPadding={[0, 0]}
          // The narrowest / shortest a card is KEPT at (gridItem) is also the narrowest it can be dragged to -
          // otherwise a card resized past it jumped back wider on the next load.
          layout={items.map((it) => ({ ...it, minW: MIN_W, minH: MIN_H }))}
          // Packed upwards by default, so a card dragged out never leaves a hole above it. "Free placement"
          // turns that off: a card then stays exactly where it is dropped, gaps and all.
          //
          // preventCollision stays OFF either way. With it on, a card dropped anywhere already occupied
          // was simply refused and snapped back to where it came from - which reads as "I cannot move
          // this card" rather than as free placement. Off, whatever is in the way moves aside instead.
          compactType={freePlacement ? null : 'vertical'}
          preventCollision={false}
          isDraggable
          isResizable
          draggableHandle={DRAG_HANDLE}
          draggableCancel={DRAG_CANCEL}
          resizeHandles={['se']}
          // The phone keeps its own scrolling while a finger is on a card.
          allowMobileScroll
          useCSSTransforms
          onLayoutChange={onLayoutChange}
          onDragStart={hold}
          onDragStop={(next) => { release(); onLayoutChange(next) }}
          onResizeStart={hold}
          // A card whose corner has been dragged has been given a height of its own, and stops following
          // its content from here on (DashboardCard's two modes) - the page remembers which those are.
          onResizeStop={(next, _before, item) => { release(); onLayoutChange(next); if (item?.i) onResizeCard?.(item.i) }}
        >
          {children}
        </ReactGridLayout>
      )}
    </div>
  )
}

export { MIN_H, MIN_W }
