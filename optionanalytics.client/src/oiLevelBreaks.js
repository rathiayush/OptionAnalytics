// Alerts when an OI totals cumulative line (CE, PE or net CE − PE - the totals charts' lines) breaks one of its own
// support / resistance levels (lineLevels.js): the "broke S" / "broke R" arrows on those charts, as they happen.
//
// Only COMPLETED buckets are read - the running bucket's figure still moves, so a break in it could come and go within
// the minute. A break is announced once (per index, bucket size, line, direction and bucket), and only while it is
// fresh: what was already broken when the page opened, or a break that only shows up later in older history (a swing
// confirmed afterwards), is not announced.

import { lineLevels } from './lineLevels.js'
import { oiTotalsSeries } from './oiTotalsHeatmap.js'

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
// A break above is a high-probability signal when, in the same completed bucket and the same direction:
//  - the CE − PE cumulative Δ made a LARGE shift: its change over the last `windowBuckets` buckets is at least
//    `shiftVsTypical` times the day's typical (median) change over that many buckets so far;
//  - the shift is AT THE MONEY: the ATM strike and the strike either side (ATM ± 1) carry at least `nearShare` of it,
//    in the same direction;
//  - the break agrees: a bullish break (CE falling / PE rising / net falling) with a falling net (put writers ahead),
//    a bearish one with a rising net.
export const HIGH_PROBABILITY = { windowBuckets: 3, minHistory: 10, shiftVsTypical: 2.5, nearShare: 0.3 }

const median = (xs) => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/**
 * Whether break `b` (watchBreaks) is a high-probability signal, else null. `totals`: buildOiTotalsRows of the same
 * per-strike changes `ce` / `pe` (strike -> Map(bucket -> change)); `last`: the last completed bucket (reads.last);
 * `atmStrike`: the ATM strike now. Returns { bullish, shift, typical, ratio, nearShift, nearShare, nearStrikes }.
 */
export function highProbability(b, { totals, ce, pe, last, atmStrike }, opts = {}) {
  const { windowBuckets: w, minHistory, shiftVsTypical, nearShare: minShare } = { ...HIGH_PROBABILITY, ...opts }
  if (!b || !totals?.buckets?.length || !Number.isFinite(atmStrike)) return null
  // Read at the break's own bucket (completed, at most `last`): nothing after it.
  const done = totals.buckets.filter((t) => t <= Math.min(last, b.time))
  const i = done.length - 1
  if (i < Math.max(minHistory, w) || done[i] !== b.time) return null
  const cum = done.map((t) => totals.rows.netCum.get(t) ?? 0)
  const shift = cum[i] - cum[i - w]
  if (shift === 0) return null
  const typical = median(Array.from({ length: i - w }, (_, k) => Math.abs(cum[k + w] - cum[k])))
  const ratio = typical > 0 ? Math.abs(shift) / typical : Infinity
  if (ratio < shiftVsTypical) return null
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
  return { bullish, shift, typical, ratio, nearShift, nearShare: share, nearStrikes, windowBuckets: w }
}

/** The high-probability message. */
export function highProbabilityText(underlying, b, hp, format, timeOf, bucketMinutes) {
  const span = hp.windowBuckets * bucketMinutes
  const ratio = Number.isFinite(hp.ratio) ? `${hp.ratio.toFixed(1)}× typical` : 'from a flat day'
  return `HIGH PROBABILITY ${hp.bullish ? 'BULLISH' : 'BEARISH'} · ${underlying} at ${timeOf(b.time)}\n`
    + `• OI ${b.side.label} cumulative Δ broke ${b.up ? 'above resistance' : 'below support'} ${b.levels.map((l) => format(l.value)).join(', ')} (${b.up ? b.side.up : b.side.down})\n`
    + `• CE − PE cumulative Δ shifted ${format(hp.shift)} in ${span} min (${ratio})\n`
    + `• ATM ± 1 (${hp.nearStrikes.join(' / ')}) carried ${format(hp.nearShift)} of it (${Math.round(hp.nearShare * 100)}%)`
}
