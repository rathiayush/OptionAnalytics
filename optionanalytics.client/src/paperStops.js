// The OI Replay trade panel's paper positions: the stop-loss / target / trailing stop on the option's own premium, and
// the 15:15 square-off (paperExit.js). The rules are the scanner's for its option trades (strategyEngine
// optionStopTargetHit), on the page's own premium points:
//
// - LEVELS: each position keeps the levels it was punched with (the panel's, or the keyboard ticket's) in `levelLog`
//   [{ t, sl, target, trailStart, trailGap }] (premium points, 0 = off; the first at the entry). A change on the panel
//   reaches the OPEN positions of its index from the minute it is made (withPaperLevelChange): a minute is judged with
//   the levels of the last change made in it or before, so what already passed is never judged again with a new level,
//   and an earned trailing stop is never loosened by one. A long log is folded into `checkpoint` { t, best, trail } -
//   the trade as judged up to then (still open) - so a position stays small enough for the server to keep.
// - POINTS: 1-minute bars, ascending - a replayed day's stamped at the minute's start and holding its close; today's live
//   ones updated in place as the ticks come (the running minute's time is its latest tick). A point is judged on its
//   high / low - except in the minute of the entry or of a change, whose range partly came BEFORE it: only the point's
//   own price (that minute's close, or the latest tick) counts there.
// - The stop counts first when one bar touches both; a fill is at the level itself (as the scanner's option trades).

import { optionTrailLevel, tighterStop } from './optionTrail.js'
import { paperSquareOffMs, squareOffExit } from './paperExit.js'

const MIN = 60_000
// More level changes than this on one position are folded into its checkpoint (the server keeps a position to 4 KB).
export const MAX_LEVEL_LOG = 24
const LEVEL_KEYS = ['sl', 'target', 'trailStart', 'trailGap']

const msOf = (p) => (p.ms != null ? p.ms : typeof p.time === 'number' ? p.time : new Date(p.time).getTime())
const points = (v) => (v > 0 ? v : 0)
const levelsOf = (c) => ({ sl: points(c?.sl), target: points(c?.target), trailStart: points(c?.trailStart), trailGap: points(c?.trailGap) })

/** The levelLog a position is punched with at `t` (its entry): one entry - null with No SL (no levels at all), no
 *  trailing with No trailing (or no trail gap). */
export function punchLevelLog({ sl, target, trailStart, trailGap, noStop = false, noTrail = false }, t) {
  if (noStop || t == null) return null
  const levels = levelsOf({ sl, target, trailStart, trailGap })
  if (noTrail || !(levels.trailGap > 0)) { levels.trailStart = 0; levels.trailGap = 0 }
  return [{ t, ...levels }]
}

/** A position's levels over time, oldest first: its levelLog, else (a position from before they were kept) one entry at
 *  its entry with `fallback` ({ sl, target, trailStart, trailGap }). A No trailing position never trails. */
export function paperLevelLog(position, fallback = null) {
  const own = Array.isArray(position?.levelLog) && position.levelLog.length > 0
    ? [...position.levelLog].sort((a, b) => a.t - b.t)
    : [{ t: position?.checkpoint?.t ?? position?.entryTime, ...fallback }]
  return own.map((c) => ({ t: c.t, ...levelsOf(c), ...(position?.noTrail ? { trailStart: 0, trailGap: 0 } : {}) }))
}

/** The levels a position has now (its last change), or null (No SL). */
export function paperLevelsNow(position, fallback = null) {
  return position?.noStop ? null : paperLevelLog(position, fallback).at(-1)
}

// Walks the position's points after its entry (or checkpoint) up to `untilMs` (inclusive, null = all) with the levels in
// force: { hit } at the first touch, else { best, trail } - where the trade stands after the last point walked.
function walk(series, p, log, untilMs) {
  const sell = p.direction === 'SELL'
  const entry = p.entryPrice
  const fromMs = p.checkpoint?.t ?? p.entryTime
  const entryMinute = Math.floor(p.entryTime / MIN)
  let best = p.checkpoint?.best ?? entry
  let trail = p.checkpoint?.trail ?? null
  let k = 0
  for (const pt of series ?? []) {
    const t = msOf(pt)
    if (!(t > fromMs)) continue
    if (untilMs != null && t > untilMs) break
    const minute = Math.floor(t / MIN)
    while (k + 1 < log.length && Math.floor(log[k + 1].t / MIN) <= minute) k++
    const c = log[k]
    const priceOnly = minute === entryMinute || minute === Math.floor(c.t / MIN)
    const high = priceOnly ? pt.price : pt.high ?? pt.price
    const low = priceOnly ? pt.price : pt.low ?? pt.price
    if (!(high > 0) || !(low > 0)) continue
    const fixed = c.sl > 0 ? (sell ? entry + c.sl : entry - c.sl) : null
    const target = c.target > 0 ? (sell ? entry - c.target : entry + c.target) : null
    // The trailing stop comes from the best premium BEFORE this bar and only ever tightens: what a bar earned with the
    // trail it had is kept (below), so a change of the trail - wider, or off - never gives it back.
    trail = trailedStop(p.direction, entry, best, c, trail)
    const stop = tighterStop(p.direction, fixed, trail)
    if (stop != null && (sell ? high >= stop : low <= stop)) {
      return { hit: { kind: trail != null && stop === trail && stop !== fixed ? 'trail' : 'sl', fillPrice: stop, at: t } }
    }
    if (target != null && (sell ? low <= target : high >= target)) return { hit: { kind: 'target', fillPrice: target, at: t } }
    best = sell ? Math.min(best, low) : Math.max(best, high)
    trail = trailedStop(p.direction, entry, best, c, trail)
  }
  return { best, trail }
}

// The trailing stop with `c`'s trail on the best premium `best`, never looser than `earned` (null = none yet).
const trailedStop = (direction, entry, best, c, earned) =>
  tighterStop(direction, earned, c.trailGap > 0 ? optionTrailLevel(direction, entry, best, c.trailStart, c.trailGap) : null)

/**
 * The first stop-loss / trailing-stop / target touch of a position on its premium points `series` (ascending), after its
 * entry and up to `asOfMs` (the replay clock; null = every point) and `untilMs`: { kind: 'sl' | 'trail' | 'target',
 * fillPrice, at }, or null. `fallback`: the levels of a position from before they were kept.
 */
export function paperStopTargetHit(series, position, { asOfMs = null, untilMs = null, fallback = null } = {}) {
  const p = position
  if (!p || p.noStop || p.entryTime == null || !(p.entryPrice > 0)) return null
  const log = paperLevelLog(p, fallback)
  if (p.checkpoint?.trail == null && !log.some((c) => c.sl > 0 || c.target > 0 || c.trailGap > 0)) return null
  const until = asOfMs == null ? untilMs : untilMs == null ? asOfMs : Math.min(asOfMs, untilMs)
  return walk(series, p, log, until).hit ?? null
}

/** An OPEN position's exit at the clock, if any: its stop-loss / trailing stop / target first (up to 15:15), else the 15:15
 *  square-off once `clockMs` has reached it. `asOfMs`: the replay clock for the points (null = all of them). */
export function paperExitHit(series, position, { asOfMs = null, clockMs = asOfMs, fallback = null } = {}) {
  if (position?.status !== 'OPEN' || position.entryTime == null) return null
  return paperStopTargetHit(series, position, { asOfMs, untilMs: paperSquareOffMs(position.entryTime), fallback })
    ?? squareOffExit(position, clockMs, series)
}

/**
 * A level change on the panel - `patch`: any of sl / target / trailStart / trailGap (points) - for the OPEN positions of
 * `underlying` (one saved without an index: the page's; No SL ones have no levels), from `atMs` (the clock): each keeps its
 * levels until then and has the new ones from that minute on; a change made earlier in the same minute, or after `atMs`
 * (a replay played back), is replaced.
 * A No trailing position keeps no trailing. `fallback(p)`: the levels a position from before they were kept had;
 * `seriesOf(p)`: its premium points, to fold a long log into its checkpoint. Returns `positions` itself when nothing
 * changes.
 */
export function withPaperLevelChange(positions, underlying, patch, atMs, { fallback = () => null, seriesOf = () => [] } = {}) {
  if (atMs == null || !patch || !Array.isArray(positions)) return positions
  const given = Object.fromEntries(LEVEL_KEYS.filter((key) => Number.isFinite(patch[key])).map((key) => [key, points(patch[key])]))
  if (Object.keys(given).length === 0) return positions
  let changed = false
  const next = positions.map((p) => {
    if (p.status !== 'OPEN' || p.noStop || p.entryTime == null || (p.underlying ?? underlying) !== underlying) return p
    const log = paperLevelLog(p, fallback(p))
    const at = Math.max(atMs, log[0].t)
    const minute = Math.floor(at / MIN)
    const kept = log.filter((c, i) => i === 0 || Math.floor(c.t / MIN) < minute)
    const last = kept.at(-1)
    const levels = { ...last, ...given, ...(p.noTrail ? { trailStart: 0, trailGap: 0 } : {}) }
    if (kept.length === log.length && LEVEL_KEYS.every((key) => levels[key] === last[key])) return p
    changed = true
    const levelLog = [...kept, { ...levelsOf(levels), t: at }]
    if (levelLog.length <= MAX_LEVEL_LOG) return { ...p, levelLog }
    // Too long to keep: the trade as judged up to this change (still open) becomes its checkpoint.
    const state = walk(seriesOf(p), p, levelLog, at)
    return state.hit ? { ...p, levelLog } : { ...p, checkpoint: { t: at, best: state.best, trail: state.trail }, levelLog: [{ ...levelsOf(levels), t: at }] }
  })
  return changed ? next : positions
}
