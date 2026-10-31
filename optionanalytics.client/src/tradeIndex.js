// OI Replay: MORE THAN ONE INDEX on a replayed day. "Also load" (a multi-select beside Load day) loads other indices' days
// with the charts' (the same /run - calls, puts, spot, futures) and holds them per index and day; the page then switches
// between them at the same replay minute with no reload, and the paper trades go to - and are priced and exited in -
// their own index whatever the charts show. Live it is always the index on screen (a live order goes to Dhan - not widened
// here).

export const TRADE_INDEXES = ['NIFTY', 'BANKNIFTY', 'SENSEX']

/** The index the paper trades go to: the one picked, on a replayed day when it is another than the charts'; else the charts'. */
export function effectiveTradeIndex(choice, underlying, isLive) {
  return !isLive && TRADE_INDEXES.includes(choice) && choice !== underlying ? choice : underlying
}

/** The trade index's expiry series: the charts' Weekly / Monthly - BANKNIFTY lists no weeklies (Monthly). */
export const tradeExpiryFlag = (u, chartFlag) => (u === 'BANKNIFTY' || chartFlag === 'MONTH' ? 'MONTH' : 'WEEK')

/** A held day's key: one series an index and day (the one it was loaded with - its run carries its expiryFlag). */
export const tradeRunKey = (u, dateKey) => `${u}|${dateKey}`

/** The "Also load" choice as the page uses it: known indices, each once, never the charts' own. */
export function alsoLoadIndexes(choice, underlying) {
  return [...new Set((Array.isArray(choice) ? choice : []).filter((u) => TRADE_INDEXES.includes(u) && u !== underlying))]
}

/**
 * The replay position on another index's day at the same clock: how many of its 1-minute spot bars (each stamped at its
 * minute's start) start at or before `asOfMs` - at least 1 when it has any. 0 without bars.
 */
export function barsShownAt(spotBars, asOfMs) {
  if (!spotBars?.length) return 0
  if (asOfMs == null) return 1
  let n = 0
  while (n < spotBars.length && new Date(spotBars[n].time).getTime() <= asOfMs) n++
  return Math.max(1, n)
}

/**
 * The trade index's ATM strike at the replay clock: its 1-minute spot bar of that minute (stamped at the minute's start,
 * holding its close - as the charts' own ATM is read), else the last one before it; nothing after the clock. Null
 * without a bar yet or a step.
 */
export function tradeAtmAt(spotBars, step, asOfMs) {
  if (!(step > 0) || asOfMs == null || !spotBars?.length) return null
  let found = null
  for (const bar of spotBars) {
    const t = new Date(bar.time).getTime()
    if (t > asOfMs) break
    if (bar.close > 0) found = bar
  }
  return found ? Math.round(found.close / step) * step : null
}
