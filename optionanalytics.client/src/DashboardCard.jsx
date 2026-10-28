import { createContext, isValidElement, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { nextFitScale } from './dashboardLayout.js'

// One card on the OI Replay dashboard. Thin on purpose: react-grid-layout owns where the card is and how
// big it is - it CLONES this element with its own `ref`, `className` and `style` (the absolute position and
// the pixel size it worked out), so every one of those has to reach the root <div> untouched, and anything
// else it hands down (the drag and resize handlers, the resize corner it appends as a child) with them.
//
// The card itself never scrolls - its BODY does, if anything does. That matters for one concrete reason: the
// resize corner is a child of the card, pinned to its bottom-right, so while the card was the scrolling box
// the corner sat underneath the scrollbar and the scrollbar swallowed every drag of it.
//
// A card is in one of two modes:
//
//   AUTO (`auto`) - the trader has not sized this card. Its content stands at its own height and is measured,
//   and the page grows the card to match (fitLayoutHeights), so there is nothing to scroll.
//
//   SIZED (`sized`) - the trader dragged this card's corner, so it is the size they gave it and its CONTENT
//   FOLLOWS: every chart in it (useFitHeight) and every table / heatmap box (CardFitBox) takes its own height x
//   one scale for the card, measured until the content is exactly the card's height (nextFitScale) - taller
//   charts in a taller card, shorter in a shorter one. Only a card that is mostly text (nothing in it scales)
//   scrolls, when it is shorter than its text.
//
// On a narrow screen there is no grid at all (see DashboardGrid): no className or style arrives, the card is
// full width at its own height, and every chart keeps the height it asks for.

// React context reaches through portals: a popup opened from INSIDE a sized card (a Modal in its content) would be
// fitted with the card - render such a popup's charts outside the card, or under <FitContext value={null}>.
const FitContext = createContext(null)

/** The height an element `px` tall (its own height anywhere else) takes in a card the trader has sized: `px` x the
 *  card's fit scale, never under `min` - so the card's content fills exactly the size it was given. Anywhere else (a
 *  card following its content, a narrow screen, a popup, another page) just `px`. */
export function useFitHeight(px, min = 80) {
  const fit = useContext(FitContext)
  const id = useId()
  const register = fit?.register
  useEffect(() => (register && px > 0 ? register(id, px) : undefined), [register, id, px])
  if (!fit || !(px > 0)) return px
  return Math.max(Math.min(min, px), Math.round(px * fit.scale))
}

/** A table in a card: at its content's own height - at most `max`, scrolling through the rest - anywhere else; in a
 *  sized card it takes its share of the card (that height x the card's fit scale) and scrolls inside itself when the
 *  table is taller than that, or leaves the room under it empty when shorter. */
export function CardFitBox({ children, min = 120, max = Infinity, style }) {
  const fit = useContext(FitContext)
  const innerRef = useRef(null)
  const [natural, setNatural] = useState(0)
  useEffect(() => {
    const element = innerRef.current
    if (!element || typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(() => setNatural(Math.ceil(element.getBoundingClientRect().height)))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const height = useFitHeight(Math.min(natural, max), min)
  const box = fit && natural > 0 ? { height, overflowY: 'auto' }
    : Number.isFinite(max) ? { maxHeight: max, overflowY: 'auto' } : null
  return (
    <div style={{ ...style, ...box }}>
      <div ref={innerRef}>{children}</div>
    </div>
  )
}

/** Applies a chart's height to the chart already drawn (lightweight-charts), rather than drawing it again: a chart
 *  drawn again has no data until the next update arrives - a paused replay's chart went blank on a resize. */
export function useChartHeight(chartRef, height) {
  useEffect(() => { if (height > 0) chartRef.current?.applyOptions({ height }) }, [chartRef, height])
}

// The fit of a sized card: the scale its charts take, re-measured as the card, its width or its content change.
function useFitScale(sized, bodyRef, contentRef) {
  const [scale, setScale] = useState(1)
  const rendered = useRef(1)
  const pending = useRef(null)
  const fit = useRef(null)
  const parts = useRef(new Map())
  const [partsVersion, setPartsVersion] = useState(0)
  const register = useCallback((key, px) => {
    parts.current.set(key, px)
    setPartsVersion((v) => v + 1)
    return () => { parts.current.delete(key); setPartsVersion((v) => v + 1) }
  }, [])
  useLayoutEffect(() => { rendered.current = scale })

  useEffect(() => {
    if (!sized) { fit.current = null; pending.current = null; if (rendered.current !== 1) setScale(1); return undefined }
    const body = bodyRef.current
    const content = contentRef.current
    if (!body || !content || typeof ResizeObserver === 'undefined') return undefined
    let frame = 0
    const step = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        // A scale just set but not drawn yet: its measurement is still to come.
        if (pending.current != null && pending.current !== rendered.current) return
        pending.current = null
        let charts = 0
        for (const px of parts.current.values()) charts += px
        const next = nextFitScale(fit.current, {
          scale: rendered.current, content: content.getBoundingClientRect().height, box: body.clientHeight, width: body.clientWidth, charts,
        })
        fit.current = next.state
        if (next.scale !== rendered.current) { pending.current = next.scale; setScale(next.scale) }
      })
    }
    const observer = new ResizeObserver(step)
    observer.observe(body)
    observer.observe(content)
    step()
    return () => { cancelAnimationFrame(frame); observer.disconnect() }
  }, [sized, bodyRef, contentRef, partsVersion])

  return { scale, register }
}

export function DashboardCard({
  id, auto = false, sized = false, onMeasure, className, style, children, ...rest
}) {
  const bodyRef = useRef(null)
  const contentRef = useRef(null)
  useEffect(() => {
    if (!auto || !onMeasure) return undefined
    const element = contentRef.current
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

  const { scale, register } = useFitScale(sized, bodyRef, contentRef)
  const fit = useMemo(() => (sized ? { scale, register } : null), [sized, scale, register])

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
        <div ref={contentRef} className="oa-dash-content">
          <FitContext.Provider value={fit}>
            {parts.filter((child) => !isHandle(child))}
          </FitContext.Provider>
        </div>
      </div>
      {parts.filter(isHandle)}
    </div>
  )
}
