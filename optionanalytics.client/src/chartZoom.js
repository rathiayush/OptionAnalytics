import { createChart } from 'lightweight-charts'

// Zoom on BOTH axes for every lightweight-charts chart in the app.
//
//   Time (X):  mouse wheel / pinch (the library's own), drag the time axis, or the ⟷− / ⟷+ buttons.
//   Price (Y): Shift + wheel anywhere on a pane, the wheel over a price axis, dragging a price axis
//              (the library's own), or the ↕− / ↕+ buttons. Once prices are zoomed the chart also pans
//              up/down when dragged.
//   Reset:     ⟲ or double-click - prices auto-fit again and the time axis fits the data.
//
// `wheelZoomNeedsCtrl` (the OI Replay futures chart - a full-width chart on a long page): the plain wheel scrolls the
// PAGE, over the chart and its price axes alike, instead of zooming it - scrolling past it squeezed the candles into
// a sliver. Ctrl (or ⌘) + wheel zooms the time axis instead (a trackpad pinch sends exactly that), Shift + wheel the
// prices as on every chart.
//
// The buttons live inside the chart's own element and act on pointerdown, so useChartUserControl
// (oiShared.jsx) sees a zoom from them exactly like a wheel zoom and stops auto-fitting the view.

const SCALE_IDS = ['right', 'left']
const STEP = 1.25

export function createZoomableChart(container, options, { wheelZoomNeedsCtrl = false } = {}) {
  const chart = createChart(container, options)
  if (wheelZoomNeedsCtrl) chart.applyOptions({ handleScale: { mouseWheel: false }, handleScroll: { mouseWheel: false } })
  enableAxisZoom(chart, { wheelZoomNeedsCtrl })
  // Room for more time labels on the axis: they are short "HH:MM" (istTickMarkFormatter), so the axis spaces them for 5
  // characters ("09:30") rather than the library's wider default and a narrow (phone) chart still shows the time every so often.
  chart.applyOptions({ timeScale: { tickMarkMaxCharacterLength: 5 } })
  return chart
}

// Which pane (index, top, height) a y coordinate inside the chart element falls in.
function paneAt(chart, y) {
  let top = 0
  const panes = chart.panes()
  for (let i = 0; i < panes.length; i++) {
    const height = panes[i].getHeight()
    if (y < top + height || i === panes.length - 1) return { index: i, top, height }
    top += height + 1 // the separator
  }
  return { index: 0, top: 0, height: 0 }
}

function visibleScales(chart, paneIndex) {
  return SCALE_IDS
    .map((id) => {
      try {
        const scale = chart.priceScale(id, paneIndex)
        return scale.width() > 0 && scale.getVisibleRange() ? { id, scale } : null
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

// Prices `factor` times closer together (factor > 1 = zoom in), keeping the price at `fraction` of
// the pane's height (0 = top) where it is.
function zoomScale(scale, factor, fraction = 0.5) {
  const range = scale.getVisibleRange()
  if (!range || !(range.to > range.from)) return
  const anchor = range.to - fraction * (range.to - range.from)
  scale.setAutoScale(false)
  scale.setVisibleRange({ from: anchor - (anchor - range.from) / factor, to: anchor + (range.to - anchor) / factor })
}

export function zoomPrices(chart, factor, paneIndex = 0, fraction = 0.5) {
  for (const { scale } of visibleScales(chart, paneIndex)) zoomScale(scale, factor, fraction)
}

// Bars `factor` times wider (factor > 1 = zoom in), keeping the right edge where it is.
export function zoomTime(chart, factor) {
  const timeScale = chart.timeScale()
  const range = timeScale.getVisibleLogicalRange()
  if (!range) return
  const span = Math.max(3, (range.to - range.from) / factor)
  timeScale.setVisibleLogicalRange({ from: range.to - span, to: range.to })
}

export function resetZoom(chart) {
  chart.panes().forEach((_, index) => {
    for (const id of SCALE_IDS) {
      try { chart.priceScale(id, index).setAutoScale(true) } catch { /* no such scale */ }
    }
  })
}

let styleAdded = false
function addStyle() {
  if (styleAdded || typeof document === 'undefined') return
  styleAdded = true
  const style = document.createElement('style')
  style.textContent = `
    .oa-zoom { position: absolute; left: 48px; bottom: 34px; z-index: 5; display: flex; gap: 3px; opacity: 0.28; transition: opacity 120ms; }
    .oa-zoom-host:hover .oa-zoom, .oa-zoom:focus-within { opacity: 1; }
    .oa-zoom button { font: 600 11px system-ui, sans-serif; color: #d9dee5; background: #1d2129ee; border: 1px solid #ffffff2e;
      border-radius: 4px; padding: 1px 6px; line-height: 16px; cursor: pointer; touch-action: manipulation; }
    .oa-zoom button:hover { background: #2b3240; }
    @media (hover: none) { .oa-zoom { opacity: 0.7; } }
  `
  document.head.appendChild(style)
}

export function enableAxisZoom(chart, { wheelZoomNeedsCtrl = false } = {}) {
  const element = chart.chartElement()
  if (!element || element.dataset.oaZoom) return
  element.dataset.oaZoom = '1'
  addStyle()
  if (getComputedStyle(element).position === 'static') element.style.position = 'relative'
  element.classList.add('oa-zoom-host')

  // Shift + wheel, or the wheel over a price axis: zoom prices around the cursor.
  const onWheel = (e) => {
    if (wheelZoomNeedsCtrl && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()   // not the browser's page zoom
      e.stopPropagation()
      // A notch of a mouse wheel (~100) about 20%, a trackpad pinch's small steps a little each. Next frame: the
      // viewer-control check (useChartUserControl) reads the view before it, so it sees the zoom and stops auto-fitting.
      const factor = Math.exp(-(Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX) * 0.002)
      requestAnimationFrame(() => zoomTime(chart, factor))
      return
    }
    if (wheelZoomNeedsCtrl && !e.shiftKey) return // the plain wheel scrolls the page
    const rect = element.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const pane = paneAt(chart, y)
    const scales = visibleScales(chart, pane.index)
    if (!scales.length) return
    const left = scales.find((s) => s.id === 'left')
    const right = scales.find((s) => s.id === 'right')
    const overLeft = left && x <= left.scale.width()
    const overRight = right && x >= rect.width - right.scale.width()
    if (!e.shiftKey && !overLeft && !overRight) return
    e.preventDefault()
    e.stopPropagation()
    const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX
    const factor = delta < 0 ? 1.15 : 1 / 1.15
    const fraction = pane.height > 0 ? Math.min(1, Math.max(0, (y - pane.top) / pane.height)) : 0.5
    const targets = overLeft ? [left] : overRight ? [right] : scales
    for (const { scale } of targets) zoomScale(scale, factor, fraction)
  }
  element.addEventListener('wheel', onWheel, { passive: false, capture: true })
  element.addEventListener('dblclick', () => resetZoom(chart), true)

  const bar = document.createElement('div')
  bar.className = 'oa-zoom'
  const buttons = [
    ['⟷−', `Zoom out (time)${wheelZoomNeedsCtrl ? ' - or Ctrl + wheel' : ''}`, () => zoomTime(chart, 1 / STEP)],
    ['⟷+', `Zoom in (time)${wheelZoomNeedsCtrl ? ' - or Ctrl + wheel' : ''}`, () => zoomTime(chart, STEP)],
    ['↕−', 'Zoom out (price) - or Shift + wheel', () => zoomPrices(chart, 1 / STEP)],
    ['↕+', 'Zoom in (price) - or Shift + wheel', () => zoomPrices(chart, STEP)],
    ['⟲', 'Reset zoom (or double-click the chart)', () => { resetZoom(chart); chart.timeScale().fitContent(); element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })) }],
  ]
  for (const [label, title, action] of buttons) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.title = title
    button.setAttribute('aria-label', title)
    // pointerdown, not click: useChartUserControl compares the view between press and release.
    button.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); action() })
    button.addEventListener('click', (e) => { if (e.detail === 0) action() }) // keyboard
    button.addEventListener('dblclick', (e) => e.stopPropagation())
    bar.appendChild(button)
  }
  element.appendChild(bar)
}
