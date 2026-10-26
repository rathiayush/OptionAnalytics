// Alerts when an OI totals cumulative line (CE, PE or net CE − PE - the totals charts' lines) breaks one of its own
// support / resistance levels (lineLevels.js): the "broke S" / "broke R" arrows on those charts, as they happen.
//
// Only COMPLETED buckets are read - the running bucket's figure still moves, so a break in it could come and go within
// the minute. A break is announced once (per index, bucket size, line, direction and bucket), and only while it is
// fresh: what was already broken when the page opened, or a break that only shows up later in older history (a swing
// confirmed afterwards), is not announced.

import { lineLevels } from './lineLevels.js'
import { buildOiTotalsRows, oiTotalsSeries } from './oiTotalsHeatmap.js'

// What the cumulative line going UP or DOWN means, per side.
export const TOTALS_SIDES = [
  { key: 'ce', label: 'CE', up: 'call writing - bearish', down: 'calls unwinding - bullish' },
  { key: 'pe', label: 'PE', up: 'put writing - bullish', down: 'puts unwinding - bearish' },
  { key: 'net', label: 'Net (CE − PE)', up: 'call writers gaining - bearish', down: 'put writers gaining - bullish' },
]

// Whether a break of `side` going up / down is bullish (+1) or bearish (-1).
export const breakMeaning = (sideKey, up) => (sideKey === 'pe' ? (up ? 1 : -1) : (up ? -1 : 1))

/** Each side's levels on its cumulative line, from the completed buckets of `totals` (buildOiTotalsRows): a bucket
 *  starting at t (chart seconds) is complete once `nowSec` >= t + bucketSeconds. */
export function completedLevelReads(totals, bucketSeconds, nowSec) {
  if (!totals?.buckets?.length) return null
  const done = totals.buckets.filter((t) => t + bucketSeconds <= nowSec)
  if (done.length === 0) return null
  const series = oiTotalsSeries({ buckets: done, rows: totals.rows })
  return {
    last: done.at(-1),
    sides: Object.fromEntries(TOTALS_SIDES.map((side) => [side.key, { read: lineLevels(series[side.key].cum), now: series[side.key].cum.at(-1)?.value ?? null }])),
  }
}

export const newBreakWatch = () => ({ seeded: false, seen: new Set() })

/**
 * The breaks in `reads` (completedLevelReads) not announced yet: [{ side, up, time, levels, now }] - one per line,
 * direction and bucket (levels broken in the same bucket come together). The first call only remembers what is
 * already broken; after it, a break counts only if it is in one of the last `freshBuckets` completed buckets.
 */
export function watchBreaks(watch, reads, bucketSeconds, freshBuckets = 2) {
  if (!reads) return []
  const groups = new Map()
  for (const side of TOTALS_SIDES) {
    const { read, now } = reads.sides[side.key]
    for (const level of read.levels) {
      if (level.brokenAt == null) continue
      const key = `${side.key}|${level.brokeUp ? 'up' : 'down'}|${level.brokenAt}`
      if (!groups.has(key)) groups.set(key, { key, side, up: level.brokeUp, time: level.brokenAt, levels: [], now })
      groups.get(key).levels.push(level)
    }
  }
  const out = []
  for (const group of groups.values()) {
    if (watch.seen.has(group.key)) continue
    watch.seen.add(group.key)
    if (watch.seeded && group.time > reads.last - freshBuckets * bucketSeconds) out.push(group)
  }
  watch.seeded = true
  return out.sort((a, b) => a.time - b.time)
}

/** The message for one break, e.g. "NIFTY OI CE cumulative Δ broke below support +653.43L at 13:39 (calls unwinding -
 *  bullish) · now +537.80L". `format`: the OI number format; `timeOf`: a chart time as HH:mm. */
export function breakText(underlying, b, format, timeOf, bucketMinutes) {
  const kind = b.up ? 'resistance' : 'support'
  const levels = b.levels.map((l) => `${format(l.value)}${l.touches > 1 ? ` (×${l.touches})` : ''}`).join(', ')
  return `${underlying} OI ${b.side.label} cumulative Δ broke ${b.up ? 'above' : 'below'} ${kind} ${levels} at ${timeOf(b.time)}`
    + ` (${b.up ? b.side.up : b.side.down}) · now ${format(b.now)}${bucketMinutes > 1 ? ` · ${bucketMinutes}-min buckets` : ''}`
}

// ---- High-probability signal ----------------------------------------------------------------------------------------
// A high-probability signal is three things in the same direction within one time window (`windowMinutes`, 3 - 5 min),
// read at a completed bucket:
//  - an OI totals line broke its support / resistance (a break above) inside the window;
//  - the CE − PE cumulative Δ made a LARGE shift over the window: at least `shiftAbovePct` % bigger than the day's
//    typical (median) change over a window that long (20% = 1.2x typical);
//  - the shift is AT THE MONEY: the ATM strike and the strike either side (ATM ± 1) carry at least `nearShare` of it,
//    in the same direction;
// and the break agrees: a bullish break (CE falling / PE rising / net falling) with a falling net (put writers ahead),
// a bearish one with a rising net. The window is in buckets of the totals' size (at least one).
export const HIGH_PROBABILITY = { windowMinutes: 5, minHistory: 10, shiftAbovePct: 20, nearShare: 0.3 }
export const HIGH_PROBABILITY_WINDOWS = [3, 4, 5]

const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** How many buckets of `bucketSeconds` a window of `windowMinutes` spans (at least one). */
export const windowBuckets = (windowMinutes, bucketSeconds) => Math.max(1, Math.round((windowMinutes * 60) / bucketSeconds))

/**
 * Whether break `b` (watchBreaks) makes a high-probability signal at the completed bucket `last`, else null.
 * `totals`: buildOiTotalsRows of the per-strike changes `ce` / `pe` (strike -> Map(bucket -> change)); `atmStrike`:
 * the ATM strike now; `bucketSeconds`: the bucket size. Only buckets up to `last` are read.
 * Returns { bullish, shift, typical, ratio, nearShift, nearShare, nearStrikes, windowBuckets, at }.
 */
export function highProbability(b, { totals, ce, pe, last, atmStrike, bucketSeconds }, opts = {}) {
  const { windowMinutes, minHistory, shiftAbovePct, nearShare: minShare } = { ...HIGH_PROBABILITY, ...opts }
  if (!b || !totals?.buckets?.length || !Number.isFinite(atmStrike) || !(bucketSeconds > 0)) return null
  const w = windowBuckets(windowMinutes, bucketSeconds)
  const done = totals.buckets.filter((t) => t <= last)
  const i = done.length - 1
  if (i < Math.max(minHistory, w)) return null
  // The break inside the window: one of its last w buckets.
  if (!(b.time > done[i - w] && b.time <= done[i])) return null
  const cum = done.map((t) => totals.rows.netCum.get(t) ?? 0)
  const shift = cum[i] - cum[i - w]
  if (shift === 0) return null
  const typical = median(Array.from({ length: i - w }, (_, k) => Math.abs(cum[k + w] - cum[k])))
  const ratio = typical > 0 ? Math.abs(shift) / typical : Infinity
  if (ratio < 1 + Math.max(0, shiftAbovePct) / 100) return null
  const bullish = shift < 0   // net CE − PE falling: put writers gaining
  if ((breakMeaning(b.side.key, b.up) > 0) !== bullish) return null
  // ATM ± 1 strike.
  const strikes = [...new Set([...ce.keys(), ...pe.keys()])].sort((x, y) => x - y)
  let step = Infinity
  for (let k = 1; k < strikes.length; k++) step = Math.min(step, strikes[k] - strikes[k - 1])
  if (!Number.isFinite(step)) return null
  const nearStrikes = strikes.filter((k) => Math.abs(k - atmStrike) <= step * 1.01)
  const windowTimes = done.slice(i - w + 1)
  let nearShift = 0
  for (const k of nearStrikes) for (const t of windowTimes) nearShift += (ce.get(k)?.get(t) ?? 0) - (pe.get(k)?.get(t) ?? 0)
  const share = nearShift / shift
  if (!(share >= minShare)) return null
  return { bullish, shift, typical, ratio, nearShift, nearShare: share, nearStrikes, windowBuckets: w, at: done[i] }
}

/** Remembers recent breaks and which directions already signalled, so a signal fires once per window. */
export const newHighProbabilityWatch = () => ({ breaks: [], lastSignal: {} })

/**
 * Feeds the new breaks of this completed bucket (watchBreaks' result) and returns the high-probability signals to send
 * now: [{ b, hp, key }] - at most one per direction, and none within a window of the last one in that direction.
 */
export function watchHighProbability(watch, newBreaks, ctx, opts = {}) {
  const { windowMinutes } = { ...HIGH_PROBABILITY, ...opts }
  const span = windowBuckets(windowMinutes, ctx.bucketSeconds) * ctx.bucketSeconds
  watch.breaks.push(...newBreaks)
  watch.breaks = watch.breaks.filter((b) => b.time > ctx.last - span)
  const out = []
  for (const b of [...watch.breaks].reverse()) {
    const hp = highProbability(b, ctx, opts)
    if (!hp) continue
    const dir = hp.bullish ? 'bull' : 'bear'
    const prev = watch.lastSignal[dir]
    if (prev != null && hp.at - prev < span) continue
    watch.lastSignal[dir] = hp.at
    out.push({ b, hp, key: `${dir}|${hp.at}` })
  }
  return out
}

/** The high-probability message. */
export function highProbabilityText(underlying, b, hp, format, timeOf, bucketMinutes) {
  const span = hp.windowBuckets * bucketMinutes
  const ratio = Number.isFinite(hp.ratio) ? `${hp.ratio.toFixed(1)}× typical` : 'from a flat day'
  return `HIGH PROBABILITY ${hp.bullish ? 'BULLISH' : 'BEARISH'} · ${underlying} at ${timeOf(hp.at)}\n`
    + `• OI ${b.side.label} cumulative Δ broke ${b.up ? 'above resistance' : 'below support'} ${b.levels.map((l) => format(l.value)).join(', ')} at ${timeOf(b.time)} (${b.up ? b.side.up : b.side.down})\n`
    + `• CE − PE cumulative Δ shifted ${format(hp.shift)} in ${span} min (${ratio})\n`
    + `• ATM ± 1 (${hp.nearStrikes.join(' / ')}) carried ${format(hp.nearShift)} of it (${Math.round(hp.nearShare * 100)}%)`
}

// ---- One step for the page and the server ---------------------------------------------------------------------------
// The OI Replay page (useOiBreakAlerts) and the server scanner (scanner-runner/indexScanner.mjs) both run the same step
// on their own data each time a bucket completes or OI changes: the breaks to announce and the high-probability
// signals. The Telegram keys are the same too, so when both are running the server sends each message once.


export const IST_OFFSET_SECONDS = 19_800

export const newOiBreakAlertState = () => ({ breaks: newBreakWatch(), hp: newHighProbabilityWatch() })

/** The breaks and high-probability signals new at `nowSec` (chart seconds - IST-shifted), from the per-strike changes
 *  `ce` / `pe` (strike -> Map(bucket -> change)). `opts`: { windowMinutes, shiftAbovePct }. */
export function stepOiBreakAlerts(state, { ce, pe, bucketSeconds, nowSec, atmStrike }, opts = {}) {
  const totals = buildOiTotalsRows(ce, pe)
  const reads = completedLevelReads(totals, bucketSeconds, nowSec)
  const breaks = watchBreaks(state.breaks, reads, bucketSeconds)
  const signals = reads ? watchHighProbability(state.hp, breaks, { totals, ce, pe, last: reads.last, atmStrike, bucketSeconds }, opts) : []
  return { breaks, signals }
}

/** Each strike's OI change per bucket (chart seconds) from a live series - strike -> [{ t (ms), oi }] (the server
 *  scanner's OI context): a bucket's OI is its last reading, the first bucket has no change (as the page's matrix). */
export function perStrikeChanges(series, bucketSeconds) {
  const out = new Map()
  for (const [strike, points] of series ?? []) {
    const byBucket = new Map()
    for (const p of points ?? []) {
      if (!(p?.oi > 0) || !Number.isFinite(p.t)) continue
      const sec = Math.floor(p.t / 1000) + IST_OFFSET_SECONDS
      byBucket.set(Math.floor(sec / bucketSeconds) * bucketSeconds, p.oi)
    }
    const buckets = [...byBucket.keys()].sort((a, b) => a - b)
    const changes = new Map()
    for (let i = 1; i < buckets.length; i++) changes.set(buckets[i], byBucket.get(buckets[i]) - byBucket.get(buckets[i - 1]))
    out.set(strike, changes)
  }
  return out
}

/** The Telegram key of a break / signal: `dayKey` = "{UNDERLYING}-{date}". */
export const breakAlertKey = (underlying, dayKey, bucketMinutes, b) => `oi-break|${underlying}|${dayKey}|${bucketMinutes}|${b.key}`
export const highProbabilityAlertKey = (underlying, dayKey, bucketMinutes, key) => `oi-hp|${underlying}|${dayKey}|${bucketMinutes}|${key}`

/** OI as lakh (L) from 1,00,000, else thousand (K), signed - the totals table's format. */
export function fmtOiLakh(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v === 0) return '0'
  const a = Math.abs(v)
  const text = a >= 1e5 ? `${(a / 1e5).toFixed(2)}L` : `${(a / 1e3).toFixed(1)}K`
  return `${v > 0 ? '+' : '−'}${text}`
}

/** A chart time (IST-shifted seconds) as "HH:mm" IST. */
export const chartTimeHHmm = (sec) => new Date(sec * 1000).toISOString().slice(11, 16)

/** The server scanner's settings for these alerts (config.oiBreakAlerts, synced from the OI Replay page). */
export const OI_BREAK_ALERT_DEFAULTS = { on: true, bucketMinutes: 1, windowMinutes: HIGH_PROBABILITY.windowMinutes, shiftAbovePct: HIGH_PROBABILITY.shiftAbovePct }
