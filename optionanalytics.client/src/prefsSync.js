// Every page preference this browser keeps (localStorage "optionanalytics.*": dashboard layouts, the cards shown, folded
// or collapsed parts, timeframes, EMAs, tabs and switches) is kept for the ACCOUNT on the server too - GET / PUT
// /api/preferences, UserPreferencesStore - so a refresh, a server restart or a deploy, another browser or another
// computer all open the pages the way they were left.
//
// - On a page load already signed in, and on signing in, BEFORE any page draws: loadPreferences() puts the server's
//   values into localStorage, so every page reads them the way it always has. With nothing saved on the server yet
//   (the first time), this browser's own preferences are sent up instead.
// - From then on every write of a preference - whichever page or component makes it - is sent: localStorage's setItem /
//   removeItem are watched (installPreferenceSync), so no page has to remember to. Writes are gathered for a moment and
//   sent in one request, at once when the tab is hidden or closed; a failed send is tried again.
// - A load that fails (the server restarting, signed out, too slow) sends nothing for the rest of that page's life: a
//   fresh browser's defaults never overwrite what was saved.
// - Not preferences (LOCAL_ONLY): caches and records the pages build up, per-browser ids and flags, the paper positions
//   and the trade levels / lots (the server keeps those itself), and the scanner's Paper / Live choice - live trading is
//   never switched on from another browser.

export const PREFS_PREFIX = 'optionanalytics.'
// The server's own limits (UserPreferencesStore).
export const MAX_KEY_LENGTH = 120
export const MAX_VALUE_BYTES = 64 * 1024

export const LOCAL_ONLY = new Set([
  'optionanalytics.oiReplay.liveDayCache',
  'optionanalytics.oiReplay.livePaperPositions',
  'optionanalytics.visitorId',
  'optionanalytics.reloadedForBuild',
  'optionanalytics.replaySync',
  'optionanalytics.liveTradeEvents.seen.v1',
  'optionanalytics.strategyScanner.history.v2',
  'optionanalytics.strategyScanner.paper.v1',
  'optionanalytics.strategyScanner.fired.v1',
  'optionanalytics.strategyScanner.trailLog.v1',
  'optionanalytics.strategyScanner.telegramSent.v1',
  'optionanalytics.strategyScanner.tradeMode',
  'optionanalytics.orderFlow.iceTelegramSent.v1',
  'optionanalytics.tradeLevels.global.v1',
  'optionanalytics.tradeLevels.scanner.v1',
  'optionanalytics.tradeLevels.oiReplay.v1',
])

const bytes = (text) => new TextEncoder().encode(text).length

/** Whether a localStorage key is a page preference kept on the server. */
export function isPreferenceKey(key) {
  return typeof key === 'string' && key.startsWith(PREFS_PREFIX) && key.length > PREFS_PREFIX.length
    && key.length <= MAX_KEY_LENGTH && !LOCAL_ONLY.has(key) && ![...key].some((c) => c.charCodeAt(0) < 32)
}

const storageKeys = (storage) => {
  const keys = []
  for (let i = 0; i < storage.length; i += 1) keys.push(storage.key(i))
  return keys
}

/**
 * The sync itself, on any storage and transport (the tests pass fakes). `request(method, values, { keepalive })`:
 * 'GET' resolves to { version, values } or throws; 'PUT' resolves to { ok, permanent } - permanent: the server refused
 * it for good (a 400), so it is not tried again.
 */
export function createPreferenceSync({ storage, request, delayMs = 800, retryMs = 5000, maxRetryMs = 60_000 } = {}) {
  const known = new Map()      // key -> the text the server has, as far as this page knows
  const pending = new Map()    // key -> text (or null: remove) not sent yet
  let ready = false
  let applying = false
  let timer = null
  let retry = retryMs
  let generation = 0

  const schedule = (ms) => {
    clearTimeout(timer)
    timer = setTimeout(() => { timer = null; flush() }, ms)
  }

  /** A preference written (or removed - null) in this browser: sent shortly, once the server's were loaded. */
  function noteWrite(key, value) {
    if (!ready || applying || !isPreferenceKey(key)) return
    if (value != null && bytes(value) > MAX_VALUE_BYTES) return
    if (value == null ? !known.has(key) : known.get(key) === value) { pending.delete(key); return }
    pending.set(key, value)
    schedule(delayMs)
  }

  async function flush({ keepalive = false } = {}) {
    clearTimeout(timer)
    timer = null
    if (!ready || pending.size === 0) return true
    const values = Object.fromEntries(pending)
    pending.clear()
    const sentFor = generation
    try {
      const answer = await request('PUT', values, { keepalive })
      if (sentFor !== generation) return false
      if (answer?.ok) {
        for (const [key, value] of Object.entries(values)) {
          if (value == null) known.delete(key)
          else known.set(key, value)
        }
        retry = retryMs
        return true
      }
      if (answer?.permanent) return false
      throw new Error('not saved')
    } catch {
      if (sentFor !== generation) return false
      // Put back what is not newer already, and try again later (slower each time).
      for (const [key, value] of Object.entries(values)) if (!pending.has(key)) pending.set(key, value)
      schedule(retry)
      retry = Math.min(retry * 2, maxRetryMs)
      return false
    }
  }

  /** The account's preferences into this browser (or, the first time, this browser's up to the account). Resolves to
   *  whether it worked; until it has, nothing is sent. */
  async function load() {
    generation += 1
    const mine = generation
    ready = false
    known.clear()
    pending.clear()
    clearTimeout(timer)
    let snapshot
    try {
      snapshot = await request('GET')
    } catch {
      return false
    }
    if (mine !== generation || !snapshot || typeof snapshot !== 'object') return false
    const values = snapshot.values && typeof snapshot.values === 'object' ? snapshot.values : {}
    applying = true
    try {
      for (const [key, value] of Object.entries(values)) {
        if (!isPreferenceKey(key) || typeof value !== 'string') continue
        known.set(key, value)
        try {
          if (storage.getItem(key) !== value) storage.setItem(key, value)
        } catch { /* storage full or blocked: the page uses its defaults */ }
      }
    } finally {
      applying = false
    }
    ready = true
    if (!(snapshot.version > 0)) {
      // Nothing saved for the account yet: what this browser has becomes its preferences.
      for (const key of storageKeys(storage)) {
        if (!isPreferenceKey(key)) continue
        const value = storage.getItem(key)
        if (value != null && bytes(value) <= MAX_VALUE_BYTES) pending.set(key, value)
      }
      await flush()
    }
    return true
  }

  /** Signing out: what is waiting goes now, then nothing more until the next load. */
  function pause() {
    const sending = flush({ keepalive: true })
    generation += 1
    ready = false
    return sending
  }

  return { load, noteWrite, flush, pause, isReady: () => ready, pendingKeys: () => [...pending.keys()] }
}

// ---- The browser's one sync ----

async function httpRequest(method, values, { keepalive = false } = {}) {
  if (method === 'GET') {
    const response = await fetch('/api/preferences', { credentials: 'same-origin' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return response.json()
  }
  const response = await fetch('/api/preferences', {
    method: 'PUT', credentials: 'same-origin', keepalive,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ values }),
  })
  if (response.status === 400) {
    console.warn('Preferences not saved on the server:', await response.text().catch(() => ''))
    return { ok: false, permanent: true }
  }
  return { ok: response.ok }
}

let sync = null

/** Watches this browser's localStorage writes (once) - every preference written from then on is sent. */
export function installPreferenceSync() {
  if (sync || typeof window === 'undefined' || !window.localStorage) return sync
  sync = createPreferenceSync({ storage: window.localStorage, request: httpRequest })
  const proto = Object.getPrototypeOf(window.localStorage)
  const setItem = proto.setItem
  const removeItem = proto.removeItem
  proto.setItem = function setItemSynced(key, value) {
    setItem.call(this, key, value)
    if (this === window.localStorage) sync.noteWrite(String(key), String(value))
  }
  proto.removeItem = function removeItemSynced(key) {
    removeItem.call(this, key)
    if (this === window.localStorage) sync.noteWrite(String(key), null)
  }
  const sendNow = () => { sync.flush({ keepalive: true }) }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') sendNow() })
  window.addEventListener('pagehide', sendNow)
  return sync
}

/** The signed-in account's preferences into this browser before a page draws - at most `timeoutMs`: a slow server
 *  leaves the page on this browser's own copy (and sends nothing this time) rather than holding it up. */
export function loadPreferences(timeoutMs = 3000) {
  const current = installPreferenceSync()
  if (!current) return Promise.resolve(false)
  let timeout = null
  const late = new Promise((resolve) => {
    timeout = setTimeout(() => { current.pause(); resolve(false) }, timeoutMs)
  })
  return Promise.race([current.load().finally(() => clearTimeout(timeout)), late])
}

/** Signing out: what is waiting is sent, then nothing until the next sign-in. */
export function pausePreferenceSync() {
  return sync?.pause() ?? Promise.resolve(true)
}
