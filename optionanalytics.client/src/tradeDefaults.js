// The trade settings per index - the option stop-loss / target (premium points) and trailing stop, the
// default lots and live slippage, and whether the server scanner trades the index - for the OI Replay trade
// panel, the Order Flow strategy scanner and the Trade settings page. Premiums scale with the index: a
// BANKNIFTY ATM option moves ~2.5x a NIFTY one, SENSEX ~3x - one flat number is too tight on one and too
// loose on the other. A trade always starts with BOTH SL and target set (a live order is a Dhan super order,
// which needs both legs). The master copy is the server's trade-settings.csv (TradeSettingsStore); this
// browser keeps a copy, so a page reads it at once and works offline.

// The defaults are the trader's own Trade settings (the server's TradeSettingsStore.Default has the same): a manual
// trade's SL / target per index ...
export const DEFAULT_TRADE_LEVELS = {
  NIFTY: { sl: 30, target: 40 },
  BANKNIFTY: { sl: 50, target: 75 },
  SENSEX: { sl: 60, target: 90 },
}
export const FALLBACK_TRADE_LEVELS = { sl: 20, target: 30 }

/** The default levels for an underlying (any not listed gets the fallback). */
export function defaultTradeLevels(underlying) {
  return DEFAULT_TRADE_LEVELS[String(underlying ?? '').toUpperCase()] ?? FALLBACK_TRADE_LEVELS
}

// ... and the max rules every strategy's option trade is held to (premium points; 0 = none - no max target) and the lots.
export const DEFAULT_INDEX_TRADE = {
  NIFTY: { maxSl: 50, maxTarget: 0, lots: 4 },
  BANKNIFTY: { maxSl: 80, maxTarget: 0, lots: 3 },
  SENSEX: { maxSl: 120, maxTarget: 0, lots: 3 },
}

/** An index's default max rules and lots, else null (an index not listed: its SL / target as the max, 1 lot). */
export function defaultIndexTrade(underlying) {
  return DEFAULT_INDEX_TRADE[String(underlying ?? '').toUpperCase()] ?? null
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

// Everything else kept per index with the levels: the default lots and live slippage, whether the server
// scanner runs it and what an alert trades there ('sell' / 'buy' the option, or 'off').
export const DEFAULT_LOTS = 1
export const DEFAULT_SLIPPAGE = 2

/** One index's full trade settings: its levels (a manual trade's) plus lots, slippage, scanner on/off, auto trade and the
 *  max rules every strategy's option trade is held to (maxSl / maxTarget, premium points, 0 = none - until set, the
 *  index's defaults, DEFAULT_INDEX_TRADE). */
export function loadTradeDefaults(underlying) {
  const saved = readAll()[String(underlying ?? '').toUpperCase()] ?? {}
  const num = (v, fallback) => (Number.isFinite(v) ? v : fallback)
  const levels = loadTradeLevels('settings', underlying)
  // A row saved before the max rules (its own SL / target, no max): those are its max, as on the server; nothing saved:
  // the index's default max rules.
  const d = Number.isFinite(saved.sl) || Number.isFinite(saved.target) ? null : defaultIndexTrade(underlying)
  const lotsDefault = defaultIndexTrade(underlying)?.lots ?? DEFAULT_LOTS
  return {
    ...levels,
    maxSl: num(saved.maxSl, d?.maxSl ?? levels.sl), maxTarget: num(saved.maxTarget, d?.maxTarget ?? levels.target),
    lots: Math.max(1, num(saved.lots, lotsDefault)), slippage: num(saved.slippage, DEFAULT_SLIPPAGE),
    scannerEnabled: saved.scannerEnabled !== false, autoTrade: ['sell', 'buy', 'off', 'strategy'].includes(saved.autoTrade) ? saved.autoTrade : 'sell',
  }
}

/** Remembers `levels` for `underlying` (this browser), tells every other page / tab that has the app open
 *  so they pick it up straight away, and saves them on the server (trade-settings.csv - for every device
 *  and the server scanner; an admin's change only). */
export function saveTradeLevels(_page, underlying, levels) {
  const key = String(underlying ?? '').toUpperCase()
  try {
    const all = readAll()
    all[key] = { ...all[key], ...levels }
    localStorage.setItem(KEY, JSON.stringify(all))
  } catch { /* convenience only */ }
  try { globalThis.dispatchEvent?.(new Event(TRADE_LEVELS_EVENT)) } catch { /* no window */ }
  sendToServer(key)
}

/** The same for lots / slippage / scanner on-off / auto trade (any of them, with or without levels). */
export const saveTradeDefaults = (underlying, patch) => saveTradeLevels('settings', underlying, patch)

// ---- The server copy (GET / PUT /api/trade-settings) ------------------------------------------------

const toServer = (underlying, d) => ({
  underlying, lots: d.lots, slPoints: d.sl, targetPoints: d.target, trailStart: d.trailStart, trailGap: d.trailGap,
  slippagePoints: d.slippage, scannerEnabled: d.scannerEnabled, autoTrade: d.autoTrade, maxSlPoints: d.maxSl, maxTargetPoints: d.maxTarget,
})
const fromServer = (row) => ({
  sl: row.slPoints, target: row.targetPoints, trailStart: row.trailStart, trailGap: row.trailGap, lots: row.lots,
  slippage: row.slippagePoints, scannerEnabled: row.scannerEnabled, autoTrade: row.autoTrade,
  ...(Number.isFinite(row.maxSlPoints) ? { maxSl: row.maxSlPoints } : {}), ...(Number.isFinite(row.maxTargetPoints) ? { maxTarget: row.maxTargetPoints } : {}),
})

const pending = new Map()
function sendToServer(key) {
  if (typeof globalThis.fetch !== 'function' || !['NIFTY', 'BANKNIFTY', 'SENSEX'].includes(key)) return
  clearTimeout(pending.get(key))
  // Typing 1, 15, 150 in a box is one save, not three.
  pending.set(key, setTimeout(() => {
    pending.delete(key)
    globalThis.fetch(`/api/trade-settings/${key}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(toServer(key, loadTradeDefaults(key))) })
      .catch(() => { /* kept in this browser; saved again on the next change */ })
  }, 800))
}

/** Loads the server's trade settings into this browser (every page then reads them) - on sign-in and
 *  when the tab comes back. Returns the rows, or null when the server could not be read. */
export async function refreshTradeSettings() {
  if (typeof globalThis.fetch !== 'function') return null
  try {
    const res = await globalThis.fetch('/api/trade-settings')
    if (!res.ok) return null
    const body = await res.json()
    const all = readAll()
    for (const row of body?.settings ?? []) {
      // A box being typed into right now keeps what is being typed.
      if (pending.has(row.underlying)) continue
      all[row.underlying] = { ...all[row.underlying], ...fromServer(row) }
    }
    localStorage.setItem(KEY, JSON.stringify(all))
    try { globalThis.dispatchEvent?.(new Event(TRADE_LEVELS_EVENT)) } catch { /* no window */ }
    return body.settings
  } catch {
    return null
  }
}

/** Calls `onChange()` whenever the levels are saved - on this page or in another tab. Returns the unsubscribe. */
export function subscribeTradeLevels(onChange) {
  if (typeof window === 'undefined') return () => {}
  const onStorage = (e) => { if (e.key === KEY) onChange() }
  window.addEventListener(TRADE_LEVELS_EVENT, onChange)
  window.addEventListener('storage', onStorage)
  return () => { window.removeEventListener(TRADE_LEVELS_EVENT, onChange); window.removeEventListener('storage', onStorage) }
}
