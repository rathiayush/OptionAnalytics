// The app-wide FLOATING BUTTONS (asked for - "the order float and this popover should not be specific to a page but to the
// overall application ... available on OI Replay, the Profiles page and the Order Flow page"): the Order button and the quick
// views' button. They work on OI Replay's own data (its option chain, prices, clock, paper positions), so on the Profiles and
// Order Flow pages they LAUNCH a popup-only copy of the OI Replay page (`<OiReplayPage popupOnly />`, mounted by
// GlobalFloating) - its quick views, order panel and buttons, none of its cards - and the tap that launched it is carried out
// once its data is in (`pending`). The store is tiny and pure so it is tested: { hostOn, pending, fabsShown }.
import { useSyncExternalStore } from 'react'

/** The pages the floating buttons belong to: OI Replay itself, and the two that launch them. */
export const FLOATING_PAGES = ['/oi-replay', '/profiles', '/order-flow']
/** 'own' - OI Replay draws its own buttons; 'launch' - the global launcher + popup host; null - no floating buttons. */
export function floatingModeFor(pathname) {
  const path = String(pathname ?? '').replace(/\/+$/, '') || '/'
  if (path === '/oi-replay') return 'own'
  return FLOATING_PAGES.includes(path) ? 'launch' : null
}

let state = { hostOn: false, pending: null, fabsShown: false }
const listeners = new Set()
const set = (patch) => { state = { ...state, ...patch }; listeners.forEach((l) => l()) }

export const floatingHost = {
  get: () => state,
  subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) },
  /** A tap on a launcher: mount the host and carry `action` ({ type: 'order' } | { type: 'view', key }) out when it is ready. */
  launch(action) { set({ hostOn: true, pending: action ?? null }) },
  /** The host takes the waiting action (once). */
  take() { const p = state.pending; if (p) set({ pending: null }); return p },
  /** The host's own buttons are on screen (its data is in) - the launchers step aside. */
  setFabsShown(shown) { if (state.fabsShown !== Boolean(shown)) set({ fabsShown: Boolean(shown) }) },
  /** For tests. */
  reset() { state = { hostOn: false, pending: null, fabsShown: false }; listeners.forEach((l) => l()) },
}

export const useFloatingHost = () => useSyncExternalStore(floatingHost.subscribe, floatingHost.get)
