// The sessions BEFORE a day for OI Replay's delta profiles (asked for - "a checkbox to see the previous day's delta, and N
// days too"): each card's "Previous day" tick and "Days" choice, as the Profiles page's "Profile of" / "Days" - unticked
// the day so far and the N - 1 sessions before it, ticked the N sessions before the day (`profileSessions` /
// `pastSessionsNeeded` in profileZones.js).
//
// Each session is loaded as the cards load their own day: the OPTIONS' from the day's run (`/api/oi-replay/{u}/run` - the
// same series, Weekly / Monthly, as the charts), kept as its minutes (`optionDeltaMinutes` - a few hundred numbers, not
// the run); the FUTURES' from the Order Flow day (`/api/order-flow/{u}/day/{date}` in the footprint's own row, regrouped
// in the card's row, with the minutes the server did not record estimated and tagged). A past day never changes: kept
// for the tab's life once it came back (`CACHE`), so a change of Days, the row or the side asks the server nothing again;
// a failure is not kept. Weekdays are walked back ONE REQUEST AT A TIME (a day the server does not hold comes from Dhan
// the first time); a day with no session (a holiday) is stepped over; the walk STOPS at the first failure and says so -
// the card's Retry walks again (nothing kept is asked again). A click, never a timer. Pure - no React (the cards' hook,
// `usePastDeltaSessions`, is in DeltaProfileCard.jsx): the Signal backtest's loader and runners read it too.

import { optionDeltaMinutes } from './deltaProfile.js'
import { FETCH_ROWS, barsKnownAt, withBackfillBars } from './profileZones.js'

const DAY_MS = 86_400_000
const LOAD_TIMEOUT_MS = 240_000
/** How many weekdays more than the sessions wanted are walked back at most (holidays). */
export const EXTRA_WEEKDAYS = 10
const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())

/** The `limit` weekdays before `dateKey` (YYYY-MM-DD), newest first. */
export function weekdaysBefore(dateKey, limit) {
  const out = []
  let t = Date.parse(`${dateKey}T00:00:00Z`)
  if (!Number.isFinite(t)) return out
  while (out.length < limit) {
    t -= DAY_MS
    const weekday = new Date(t).getUTCDay()
    if (weekday !== 0 && weekday !== 6) out.push(new Date(t).toISOString().slice(0, 10))
  }
  return out
}

/**
 * The `count` sessions before `dateKey`, OLDEST FIRST: `load(date)` resolves a session { date, items, ... } (no items =
 * no session that day - a holiday, stepped over) or throws (a failure - the walk stops there). At most `count` +
 * EXTRA_WEEKDAYS weekdays, one at a time; `onSession(found)` as each comes in. { sessions, error: { date, message } | null }.
 */
export async function walkPastSessions(dateKey, count, load, { onSession, cancelled = () => false } = {}) {
  const found = []
  if (!(count > 0)) return { sessions: found, error: null }
  for (const date of weekdaysBefore(dateKey, count + EXTRA_WEEKDAYS)) {
    if (found.length >= count) break
    let session
    try {
      session = await load(date)
    } catch (err) {
      return { sessions: found, error: { date, message: String(err?.message ?? err) } }
    }
    if (cancelled()) return { sessions: found, error: null }
    if (session?.items?.length) {
      found.unshift(session)
      onSession?.([...found])
    }
  }
  return { sessions: found, error: null }
}

/** A run's day as the option profile keeps it: its minutes (`optionDeltaMinutes`) and the spot's 1-minute candles (ms). */
export function optionDayRecord(date, body) {
  const spot = barsKnownAt(body?.spotCandlesOneMinute ?? [], null)
    .map((b) => ({ time: msOf(b.time), open: b.open, high: b.high, low: b.low, close: b.close }))
    .filter((b) => b.close > 0)
  return { date, items: optionDeltaMinutes(body?.cePoints, body?.pePoints, spot), candles: spot }
}

/** The Order Flow day's minute bars IN LOTS (`meta.lotSize` - so days of another lot size add up right): the recorded
 *  minutes, and those the server did not record from its estimate (`backfillBars`), tagged `estimated` - a day it did not
 *  record at all is its estimate throughout. Session minutes only. */
export function footprintBars(body) {
  const lot = body?.meta?.lotSize > 0 ? body.meta.lotSize : 1
  const whole = body?.source === 'estimated'
  const inLots = (b, estimated) => ({
    time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: (b.volume ?? 0) / lot,
    levels: (b.levels ?? []).map((l) => ({ price: l.price, buy: (l.buy ?? 0) / lot, sell: (l.sell ?? 0) / lot })),
    ...(estimated || b.estimated ? { estimated: true } : {}),
  })
  const recorded = (body?.bars ?? []).map((b) => inLots(b, whole))
  const backfill = (body?.backfillBars ?? []).map((b) => inLots(b, true))
  return barsKnownAt(withBackfillBars(recorded, backfill), null)
}

/** An Order Flow day as the futures profile keeps it: its bars in lots (`footprintBars`) and their candles (ms). */
export function futuresDayRecord(date, body) {
  const bars = footprintBars(body)
  return { date, items: bars, candles: bars.map((b) => ({ time: msOf(b.time), open: b.open, high: b.high, low: b.low, close: b.close })) }
}

export const optionDayUrl = (u, date, flag) => `/api/oi-replay/${u}/run?date=${date}&timeframeMinutes=1&expiryFlag=${flag}`
// In the footprint's own row (FETCH_ROWS - the Profiles page's): the card regroups it, so a row change asks nothing.
export const futuresDayUrl = (u, date) => `/api/order-flow/${u}/day/${date}?rowSize=${FETCH_ROWS[u] ?? 1}&minTradeLots=100000&heatmapColumns=50&backfillBars=true`

async function getJson(url, fetchImpl) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS)
  try {
    const r = await (fetchImpl ?? globalThis.fetch)(url, { signal: controller.signal })
    return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) }
  } catch (err) {
    throw new Error(controller.signal.aborted ? 'took too long to load' : String(err?.message ?? err))
  } finally {
    clearTimeout(timer)
  }
}

/** One past day of the options: the run answered without success (no spot that day - a holiday) = no session; an HTTP
 *  error throws. */
export async function loadOptionDay(underlying, date, flag, fetchImpl) {
  const { ok, status, body } = await getJson(optionDayUrl(underlying, date, flag), fetchImpl)
  if (!ok) throw new Error(body?.error ?? `HTTP ${status}`)
  if (!body?.success) return { date, items: [], candles: [], none: body?.error ?? 'no data' }
  return optionDayRecord(date, body)
}

/** One past day of the futures: no contract / day there (404 - a holiday) = no session; any other error throws. */
export async function loadFuturesDay(underlying, date, fetchImpl) {
  const { ok, status, body } = await getJson(futuresDayUrl(underlying, date), fetchImpl)
  if (status === 404) return { date, items: [], candles: [], none: body?.error ?? 'no futures day' }
  if (!ok) throw new Error(body?.error ?? `HTTP ${status}`)
  return futuresDayRecord(date, body)
}

// Kept for the tab's life: the days that came back with a session (a holiday is asked again - the server answers it from
// its disk), the oldest dropped past CACHE_MAX. A day already on its way is shared, not asked twice.
const CACHE = new Map()
const CACHE_MAX = 80
const IN_FLIGHT = new Map()
/** The cache's key of a day of the options (a series - WEEK / MONTH - of an index). */
export const optionDayKey = (underlying, flag, date) => `options|${underlying}|${flag}|${date}`
/** Keeps a day loaded some other way (the Signal backtest's own days - their run is already in): the next day's walk back
 *  finds it here instead of asking for its run again. */
export function rememberDay(key, day) {
  if (!day?.items?.length) return
  CACHE.delete(key)
  CACHE.set(key, day)
  if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value)
}
export function cachedDay(key, load) {
  if (CACHE.has(key)) return Promise.resolve(CACHE.get(key))
  if (IN_FLIGHT.has(key)) return IN_FLIGHT.get(key)
  const pending = load()
    .then((day) => {
      if (day?.items?.length) {
        CACHE.set(key, day)
        if (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value)
      }
      return day
    })
    .finally(() => IN_FLIGHT.delete(key))
  IN_FLIGHT.set(key, pending)
  return pending
}
