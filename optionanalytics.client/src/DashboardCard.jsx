import { createContext, isValidElement, useContext, useEffect, useRef } from 'react'
import { contentHeight } from './dashboardLayout.js'

// One card on the OI Replay dashboard. Thin on purpose: react-grid-layout owns where the card is and how
// big it is - it CLONES this element with its own `ref`, `className` and `style` (the absolute position and
// the pixel size it worked out), so every one of those has to reach the root <div> untouched, and anything
// else it hands down (the drag and resize handlers, the resize corner it appends as a child) with them.
//
// The card itself never scrolls - its BODY does. That matters for one concrete reason: the resize corner is
// a child of the card, pinned to its bottom-right, so while the card was the scrolling box the corner sat
// underneath the scrollbar and the scrollbar swallowed every drag of it. With the scrolling one level in,
// the corner is always on top of the card and always grabbable.
//
// A card is in one of two modes, and that is what keeps a dashboard free of scrollbars:
//
//   AUTO (`auto`) - the trader has not sized this card. Its body stands at its content's own height and is
//   measured, and the page grows the card to match (fitLayoutHeights), so there is nothing to scroll. The
//   height context is null here, so the charts inside stand at their own height rather than the card's -
//   which is exactly what stops the measurement chasing itself (chart fills card -> card fits chart -> ...).
//
//   SIZED - the trader dragged this card's corner. The card keeps that height, the body scrolls inside it,
//   and the charts fill it (useCardContentHeight).
//
// On a narrow screen there is no grid at all (see DashboardGrid): no className or style arrives, the card is
// full width at its own height, and the context is null - every chart keeps the height it asks for.

const CardHeightContext = createContext(null)

/** The height a chart inside a dashboard card should use, or `fallback` where the card has no height of its
 *  own (a card still following its content, a narrow screen, a floating panel, a popup). */
export function useCardContentHeight(fallback) {
  return useContext(CardHeightContext) ?? fallback
}

export function DashboardCard({
  id, rows = null, auto = false, chromePx = 86, onMeasure, className, style, children, ...rest
}) {
  const bodyRef = useRef(null)
  useEffect(() => {
    if (!auto || !onMeasure) return undefined
    const element = bodyRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    // Measured on the next frame rather than inside the observer: a card holding a chart that is itself
    // resizing would otherwise report a height mid-flight, and ResizeObserver would loop on it.
    let frame = 0
    const report = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => onMeasure(id, Math.ceil(element.getBoundingClientRect().height)))
    }
    const observer = new ResizeObserver(report)
    observer.observe(element)
    report()
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [auto, onMeasure, id])

  // react-resizable hands its resize corner in WITH the children (keyed "resizableHandle-se"): it goes on the card
  // itself, beside the body - inside the body it sat under a sized card's scrollbar again.
  const parts = Array.isArray(children) ? children : [children]
  const isHandle = (child) => isValidElement(child) && String(child.key ?? '').includes('resizableHandle-')
  return (
    <div
      {...rest}
      data-card={id}
      className={`oa-dash-card${className ? ` ${className}` : ''}`}
      style={style}
    >
      <div ref={bodyRef} className={`oa-dash-body${auto ? ' oa-dash-body--auto' : ''}`}>
        <CardHeightContext.Provider value={auto ? null : contentHeight(rows, { chromePx })}>
          {parts.filter((child) => !isHandle(child))}
        </CardHeightContext.Provider>
      </div>
      {parts.filter(isHandle)}
    </div>
  )
}
