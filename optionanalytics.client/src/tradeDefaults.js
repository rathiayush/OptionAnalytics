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

const KEY = (page) => `optionanalytics.tradeLevels.${page}.v1`

/** The levels saved for `underlying` on `page`, else its defaults. A saved 0 stays 0 (switched off). */
export function loadTradeLevels(page, underlying) {
  const d = defaultTradeLevels(underlying)
  try {
    const saved = JSON.parse(localStorage.getItem(KEY(page)) ?? '{}')[String(underlying ?? '').toUpperCase()]
    return {
      sl: Number.isFinite(saved?.sl) ? saved.sl : d.sl,
      target: Number.isFinite(saved?.target) ? saved.target : d.target,
    }
  } catch { return { ...d } }
}

/** Remembers `levels` for `underlying` on `page` (this browser only). */
export function saveTradeLevels(page, underlying, levels) {
  try {
    const all = JSON.parse(localStorage.getItem(KEY(page)) ?? '{}')
    all[String(underlying ?? '').toUpperCase()] = { sl: levels.sl, target: levels.target }
    localStorage.setItem(KEY(page), JSON.stringify(all))
  } catch { /* convenience only */ }
}
