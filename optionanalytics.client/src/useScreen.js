import { useEffect, useState } from 'react'

// Hooks for what floats over a page (OI Replay's quick button and replay bar): the window's size, how far the page starts
// from the left (the sidebar), and whether an element is on the screen.

// The sidebar's widths and the screen it shows from - index.css's .oa-sidenav-panel / body.oa-sidenav padding.
const SIDENAV_WIDTH = { open: 216, folded: 64 }
const SIDENAV_MEDIA = '(min-width: 769px)'

const sideNavInset = () => {
  const { classList } = document.body
  if (!classList.contains('oa-sidenav') || !window.matchMedia?.(SIDENAV_MEDIA).matches) return 0
  return classList.contains('oa-sidenav--collapsed') ? SIDENAV_WIDTH.folded : SIDENAV_WIDTH.open
}

/** The window's size, followed. */
export function useViewport() {
  const [viewport, setViewport] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))
  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return viewport
}

/** How far from the window's left edge the page starts: the sidebar's width while it shows (over 768 px), else 0 - for
 *  what floats over the page (the quick button, the replay bar) and must not sit on the menu. Follows the sidebar
 *  being folded / opened and the window crossing 768 px. */
export function useSideNavInset() {
  const [inset, setInset] = useState(sideNavInset)
  useEffect(() => {
    const update = () => setInset(sideNavInset())
    update()
    const observer = new MutationObserver(update)
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] })
    window.addEventListener('resize', update)
    return () => { observer.disconnect(); window.removeEventListener('resize', update) }
  }, [])
  return inset
}

/** Whether `el` is (partly) on the screen now; false with no element (the card holding it is hidden), true until the
 *  first reading of a new one (so the bar does not flash up for a frame while the inline controls are in sight). */
export function useOnScreen(el) {
  const [seen, setSeen] = useState({ el: null, on: false })
  useEffect(() => {
    if (!el || typeof IntersectionObserver === 'undefined') return undefined
    const observer = new IntersectionObserver(([entry]) => setSeen({ el, on: entry.isIntersecting }), { threshold: 0 })
    observer.observe(el)
    return () => observer.disconnect()
  }, [el])
  if (!el) return false
  return seen.el === el ? seen.on : true
}
