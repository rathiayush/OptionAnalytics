// Default option stop-loss / target (premium points) per underlying, for the OI Replay trade panel and the
// Order Flow strategy scanner. Premiums scale with the index: a BANKNIFTY ATM option moves ~2.5x a NIFTY
// one, SENSEX ~3x - one flat number is too tight on one and too loose on the other. A trade always starts
// with BOTH set (a live order is a Dhan super order, which needs both legs); what the trader sets is kept
// per underlying in this browser.

export const DEFAULT_TRADE_LEVELS = {
  NIFTY: { sl: 20, target: 30 },
  BANKNIFTY: { sl: 50, target: 75 },
  SENSEX: { sl: 60, target: 90 },
}
export const FALLBACK_TRADE_LEVELS = { sl: 20, target: 30 }

/** The default levels for an underlying (any not listed gets the fallback). */
export function defaultTradeLevels(underlying) {
  return DEFAULT_TRADE_LEVELS[String(underlying ?? '').toUpperCase()] ?? FALLBACK_TRADE_LEVELS
}

// ONE set of levels per underlying for the whole app: set from the OI Replay trade panel, the strategy
// scanner or anywhere else, the same SL / target / trailing is used by every page, for paper and live
// trades alike (`page` is only kept so old call sites read the same). Levels saved before this, per page,
// are picked up once: the scanner's first, then OI Replay's.
const KEY = 'optionanalytics.tradeLevels.global.v1'
const LEGACY_KEYS = ['optionanalytics.tradeLevels.scanner.v1', 'optionanalytics.tradeLevels.oiReplay.v1']
export const TRADE_LEVELS_EVENT = 'optionanalytics:tradeLevels'

function readAll() {
  try {
    const own = localStorage.getItem(KEY)
    if (own != null) return JSON.parse(own) ?? {}
    const merged = {}
    for (const key of [...LEGACY_KEYS].reverse()) {
      const old = JSON.parse(localStorage.getItem(key) ?? '{}') ?? {}
      for (const [underlying, levels] of Object.entries(old)) merged[underlying] = { ...merged[underlying], ...levels }
    }
    return merged
  } catch { return {} }
}

/** The levels saved for `underlying`, else its defaults. A saved 0 stays 0 (switched off).
 *  trailStart / trailGap: the option's trailing stop (optionTrail.js) - off (0) unless the trader sets it. */
export function loadTradeLevels(_page, underlying) {
  const d = defaultTradeLevels(underlying)
  const num = (v, fallback) => (Number.isFinite(v) ? v : fallback)
  const saved = readAll()[String(underlying ?? '').toUpperCase()]
  return { sl: num(saved?.sl, d.sl), target: num(saved?.target, d.target), trailStart: num(saved?.trailStart, 0), trailGap: num(saved?.trailGap, 0) }
}

/** Remembers `levels` for `underlying` (this browser), and tells every other page / tab that has the
 *  app open so they pick it up straight away. */
export function saveTradeLevels(_page, underlying, levels) {
  try {
    const all = readAll()
    const key = String(underlying ?? '').toUpperCase()
    all[key] = { ...all[key], ...levels }
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch { /* convenience only */ }
  try { globalThis.dispatchEvent?.(new Event(TRADE_LEVELS_EVENT)) } catch { /* no window */ }
}

/** Calls `onChange()` whenever the levels are saved - on this page or in another tab. Returns the unsubscribe. */
export function subscribeTradeLevels(onChange) {
  if (typeof window === 'undefined') return () => {}
  const onStorage = (e) => { if (e.key === KEY) onChange() }
  window.addEventListener(TRADE_LEVELS_EVENT, onChange)
  window.addEventListener('storage', onStorage)
  return () => { window.removeEventListener(TRADE_LEVELS_EVENT, onChange); window.removeEventListener('storage', onStorage) }
}
