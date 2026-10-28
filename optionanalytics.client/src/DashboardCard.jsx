import { createContext, useContext } from 'react'
import { contentHeight } from './dashboardLayout.js'

// One card on the OI Replay dashboard. Thin on purpose: react-grid-layout owns where the card is and how
// big it is - it CLONES this element with its own `ref`, `className` and `style` (the absolute position and
// the pixel size it worked out), so every one of those has to reach the root <div> untouched, and anything
// else it hands down (the drag and resize handlers) with them.
//
// What this adds is the card's own content height, handed to whatever is inside through a context: the
// charts already follow their container's WIDTH by themselves (each has a ResizeObserver), but their height
// is a prop, so a chart that should fill its card reads useCardContentHeight() instead.
//
// On a narrow screen there is no grid at all (see DashboardGrid): no className or style arrives, the card is
// full width at its own height, and the context is null - every chart keeps the height it asks for.

const CardHeightContext = createContext(null)

/** The height a chart inside a dashboard card should use, or `fallback` where the card has no height of its
 *  own (a narrow screen, a floating panel, a popup). */
export function useCardContentHeight(fallback) {
  return useContext(CardHeightContext) ?? fallback
}

export function DashboardCard({ id, rows = null, chromePx = 86, className, style, children, ...rest }) {
  return (
    <div
      {...rest}
      data-card={id}
      className={`oa-dash-card${className ? ` ${className}` : ''}`}
      style={style}
    >
      <CardHeightContext.Provider value={contentHeight(rows, { chromePx })}>
        {children}
      </CardHeightContext.Provider>
    </div>
  )
}
