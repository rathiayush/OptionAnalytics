// The F&O trading session - NSE and BSE index futures and options trade 09:15 to 15:30 IST (the 15:29 minute is the
// last). What the charts show: a reading outside it is not a minute of the market (Dhan keeps re-sending snapshots after
// the close, a stored database may hold them), so OI points and live futures minutes outside it are dropped where they
// come in (groupByStrike, mergeFuturesLive). The server keeps to the same window (MarketHours.InTradingSession).

const IST_OFFSET_SECONDS = 19_800
export const SESSION_OPEN_MINUTE = 9 * 60 + 15
export const SESSION_CLOSE_MINUTE = 15 * 60 + 30

const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())

/** Whether a time (ms, ISO text or Date) is inside the session's minutes of the IST day. */
export function inMarketSession(time) {
  const ms = msOf(time)
  if (!Number.isFinite(ms)) return false
  const minute = Math.floor((((Math.floor(ms / 1000) + IST_OFFSET_SECONDS) % 86_400) + 86_400) % 86_400 / 60)
  return minute >= SESSION_OPEN_MINUTE && minute < SESSION_CLOSE_MINUTE
}
