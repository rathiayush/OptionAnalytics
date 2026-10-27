// Chain-wide (every strike's) CE / PE open interest through the day - the Day OI card's figures and chart, the Total OI
// lookback table, the External page's chain-wide chart. The band of strikes follows spot (Dhan's ATM±10 for a past day,
// the live band today), so a strike can join it hours after the open: counted in full, its whole open interest would show
// up as "added" the minute it first appears - a jump nobody wrote. So a strike with a reading at the day's start counts its
// OI, and one that joins later counts its change since its first reading: the totals move only with OI actually added or
// removed (a strike that leaves the band keeps its last reading).

const msOf = (p) => (p.ms != null ? p.ms : new Date(p.time).getTime())

// What a strike's series counts from: 0 when it has a reading at or before `startMs` (there from the start), else its
// first reading's OI.
function baseOf(series, startMs) {
  const first = series.find((p) => Number.isFinite(p.openInterest))
  return first == null || msOf(first) <= startMs ? 0 : first.openInterest
}

/** The CE and PE totals ({ ce, pe }) at each of `times` (epoch ms, ascending) - `startMs` the day's first minute. Each
 *  strike's series (ascending) is swept once, its latest reading at or before each time counted. */
export function chainOiTotalsAt(ceByStrike, peByStrike, startMs, times) {
  const cursorsFor = (byStrike) => [...byStrike.values()].map((series) => ({ series, next: 0, oi: null, base: baseOf(series, startMs) }))
  const ce = cursorsFor(ceByStrike)
  const pe = cursorsFor(peByStrike)
  const totalAt = (cursors, ms) => {
    let total = 0
    for (const c of cursors) {
      while (c.next < c.series.length && msOf(c.series[c.next]) <= ms) {
        const oi = c.series[c.next++].openInterest
        if (Number.isFinite(oi)) c.oi = oi
      }
      if (c.oi != null) total += c.oi - c.base
    }
    return total
  }
  return times.map((ms) => ({ ce: totalAt(ce, ms), pe: totalAt(pe, ms) }))
}

/** The day so far at `asOfMs`: the totals then (`now`) and their change since `startMs` (`change`) - a strike that joined
 *  the band later counted by its change since it did. */
export function chainOiDay(ceByStrike, peByStrike, startMs, asOfMs) {
  if (startMs == null || asOfMs == null) return null
  const [start, now] = chainOiTotalsAt(ceByStrike, peByStrike, startMs, [startMs, Math.max(startMs, asOfMs)])
  return { now, change: { ce: now.ce - start.ce, pe: now.pe - start.pe } }
}
