// OI Replay: TRADE IN ANOTHER INDEX than the charts show - a past day replayed with NIFTY on screen and the paper trades
// in SENSEX (or any pair). The page loads the trade index's day too (its own option chain, spot and step - the same
// /run the chart index loads, alongside it on Load day) and the paper panel / order ticket take that index's ATM
// strike, premiums, lot size and SL / target at the replay clock. Live it is always the index on screen (a live order
// goes to Dhan - not widened here).

export const TRADE_INDEXES = ['NIFTY', 'BANKNIFTY', 'SENSEX']

/** The index the paper trades go to: the one picked, on a replayed day when it is another than the charts'; else the charts'. */
export function effectiveTradeIndex(choice, underlying, isLive) {
  return !isLive && TRADE_INDEXES.includes(choice) && choice !== underlying ? choice : underlying
}

/** The trade index's expiry series: the charts' Weekly / Monthly - BANKNIFTY lists no weeklies (Monthly). */
export const tradeExpiryFlag = (u, chartFlag) => (u === 'BANKNIFTY' || chartFlag === 'MONTH' ? 'MONTH' : 'WEEK')

export const tradeRunKey = (u, dateKey, flag) => `${u}|${dateKey}|${flag}`

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
