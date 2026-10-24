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
