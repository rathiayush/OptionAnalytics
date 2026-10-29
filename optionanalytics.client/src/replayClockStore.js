// OI Replay's LAST replay clock, kept in this browser (localStorage) beside the one-way clock channel
// (replaySync.jsx): a page that follows OI Replay takes it up when no OI Replay tab answers. On a phone the pages
// share ONE tab - OI Replay is closed the moment the Profiles page opens - and a tab in the background is frozen,
// so the channel's messages never reach the follower and it showed "OI Replay is not open" on its own day.
// A record, not a preference: LOCAL_ONLY in prefsSync.js (it changes every replay step).

export const LAST_CLOCK_KEY = 'optionanalytics.replayClock.last'
// An older one is not taken up - the follower opens on its own choice instead.
export const LAST_CLOCK_MAX_AGE_MS = 2 * 60 * 60_000

const FIELDS = ['underlying', 'date', 'loadingDate', 'failedDate', 'ms', 'live', 'playing']

/** The record to keep for OI Replay's clock state `state` at `now` - a JSON string, or null when there is nothing to
 *  keep: no index, or no day at all (OI Replay just opened, before it goes live) - the record before it stays. */
export function lastClockRecord(state, now = Date.now()) {
  if (!state?.underlying || !(state.live || state.date || state.loadingDate || state.failedDate)) return null
  return JSON.stringify({ ...Object.fromEntries(FIELDS.map((k) => [k, state[k] ?? null])), live: Boolean(state.live), savedAt: now })
}

/** The clock kept as `raw` (lastClockRecord's string), if it is fresh enough to follow at `now` - else null. */
export function readLastClock(raw, now = Date.now(), maxAgeMs = LAST_CLOCK_MAX_AGE_MS) {
  if (typeof raw !== 'string' || !raw) return null
  let value
  try { value = JSON.parse(raw) } catch { return null }
  if (!value || typeof value.underlying !== 'string' || !value.underlying || !Number.isFinite(value.savedAt)) return null
  // Not from the future either (a clock set back) - a minute's leeway.
  if (now - value.savedAt > maxAgeMs || value.savedAt - now > 60_000) return null
  return { ...Object.fromEntries(FIELDS.map((k) => [k, value[k] ?? null])), live: Boolean(value.live), playing: Boolean(value.playing), savedAt: value.savedAt }
}
