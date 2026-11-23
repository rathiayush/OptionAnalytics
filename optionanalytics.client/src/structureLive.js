// The Spot structure page's candles AT A CLOCK and LIVE (SpotStructurePage.jsx) - pure functions.
//
// The server builds every timeframe from the spot's 1-minute candles, bucketed on the SESSION from 09:15 IST
// (SpotStructureService.Aggregate): an hour 09:15 - 10:15 ..., a 4-hour candle 09:15 - 13:15 and 13:15 - 15:30, a day the
// whole session, each stamped with its bucket's START. The same buckets here:
//   - LIVE, the spot feed's forming 1-minute bar (the "spotUpdate" push) is folded into each timeframe's last candle - or
//     starts the next one - so the charts tick with the price instead of moving once a minute when the page re-reads them;
//   - REPLAYED (OI Replay's clock followed, or the page's own), the candles COMPLETED at the clock plus the one FORMING,
//     made from the day's 1-minute bars up to the clock - so a 1-hour chart grows minute by minute with the replay
//     instead of standing still until the hour is done. Nothing after the clock either way.

const MIN = 60_000
const IST_OFFSET_MS = 330 * MIN
/** The F&O session: 09:15 IST, 375 minutes (15:29 the last). */
export const SESSION_START_MIN = 9 * 60 + 15
export const SESSION_MINUTES = 375

/** 09:15 IST of the IST day `ms` falls on. */
export function sessionStartOf(ms) {
  const ist = ms + IST_OFFSET_MS
  const day = ist - (((ist % 86_400_000) + 86_400_000) % 86_400_000)
  return day + SESSION_START_MIN * MIN - IST_OFFSET_MS
}

/** The start of the `tf`-minute candle holding the minute at `ms` (1440 = the day), bucketed from 09:15 IST; null outside
 *  09:15 - 15:29. */
export function bucketStart(ms, tf) {
  if (!Number.isFinite(ms)) return null
  const open = sessionStartOf(ms)
  const minute = Math.floor((ms - open) / MIN)
  if (minute < 0 || minute >= SESSION_MINUTES) return null
  const bucket = tf >= 1440 ? 0 : Math.floor(minute / tf) * tf
  return open + bucket * MIN
}

/** When the candle starting at `time` is complete: its span, cut at the session's end (the last hour of a day is 15:15 -
 *  15:30, the afternoon 4-hour candle 13:15 - 15:30 - they are done at 15:30, not an hour / four hours later). */
export function candleEnd(time, tf) {
  return Math.min(time + Math.min(tf, SESSION_MINUTES) * MIN, sessionStartOf(time) + SESSION_MINUTES * MIN)
}

/** The candles completed by `asOfMs` (null = all). */
export function candlesAsOf(candles, tf, asOfMs) {
  if (asOfMs == null) return candles
  return candles.filter((c) => candleEnd(c.time, tf) <= asOfMs)
}

/** `minutes` (1-minute bars, { time: epoch ms, open, high, low, close }) folded into `candles` of `tf` minutes: a minute in
 *  the last candle's bucket widens it and sets its close, one in a later bucket starts a candle (its open the minute's),
 *  an older one or one outside the session changes nothing. The candles are not changed - a new list comes back. A candle
 *  a minute touched is marked `forming` (the live / replayed candle still building). */
export function foldMinutes(candles, minutes, tf) {
  const list = (minutes ?? []).filter((m) => Number.isFinite(m?.time) && Number.isFinite(m.close)).sort((a, b) => a.time - b.time)
  if (!list.length) return candles
  const out = candles.slice()
  for (const m of list) {
    const b = bucketStart(m.time, tf)
    if (b == null) continue
    const last = out.at(-1)
    if (!last || b > last.time) {
      out.push({ time: b, open: m.open ?? m.close, high: m.high ?? m.close, low: m.low ?? m.close, close: m.close, volume: m.volume ?? 0, forming: true })
    } else if (b === last.time) {
      out[out.length - 1] = { ...last, high: Math.max(last.high, m.high ?? m.close), low: Math.min(last.low, m.low ?? m.close), close: m.close, forming: true }
    }
  }
  return out
}

/** The chart at a replay clock: the candles completed by `asOfMs` and the one forming, made from the day's `minutes`
 *  completed by then (a minute counts once its END is reached - `asOfMs` is the end of the newest minute shown). */
export function candlesAtClock(candles, tf, asOfMs, minutes = []) {
  if (asOfMs == null) return candles
  const done = candlesAsOf(candles, tf, asOfMs)
  const lastStart = done.at(-1)?.time ?? -Infinity
  const shown = (minutes ?? []).filter((m) => m.time + MIN <= asOfMs && (bucketStart(m.time, tf) ?? -Infinity) > lastStart)
  return foldMinutes(done, shown, tf)
}

/** How many weekdays from `dateKey` up to the day before `todayKey` (YYYY-MM-DD, IST days): the trading days a window of
 *  past days ending yesterday must add to reach back to `dateKey` (0 for today or a later day). */
export function weekdaysBack(todayKey, dateKey) {
  const day = (k) => Date.parse(`${k}T00:00:00Z`)
  const today = day(todayKey)
  let d = day(dateKey)
  if (!Number.isFinite(today) || !Number.isFinite(d)) return 0
  let n = 0
  for (; d < today; d += 86_400_000) {
    const w = new Date(d).getUTCDay()
    if (w !== 0 && w !== 6) n++
  }
  return n
}

/** Live 1-minute bars kept from the pushes: `bar` (the feed's forming minute - its time ISO or ms) put in its minute's
 *  place, the list kept in time order and to the IST day of the newest; at most `max` minutes. */
export function addLiveMinute(list, bar, max = SESSION_MINUTES + 5) {
  const time = typeof bar?.time === 'number' ? bar.time : Date.parse(bar?.time)
  if (!Number.isFinite(time) || !Number.isFinite(bar?.close)) return list
  const minute = Math.floor(time / MIN) * MIN
  const item = { time: minute, open: bar.open, high: bar.high, low: bar.low, close: bar.close }
  const day = sessionStartOf(minute)
  const held = list ?? []
  // A minute of an earlier day than what is held (late, out of order) changes nothing; a new day starts the list again.
  if (held.length && day < sessionStartOf(held.at(-1).time)) return held
  const kept = held.filter((m) => m.time !== minute && sessionStartOf(m.time) === day)
  kept.push(item)
  if (kept.length > 1 && kept.at(-2).time > minute) kept.sort((a, b) => a.time - b.time)
  return kept.length > max ? kept.slice(-max) : kept
}
