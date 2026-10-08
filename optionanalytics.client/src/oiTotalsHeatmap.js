// Whole-band OI totals per time bucket for the OI Replay "OI totals heatmap": for CE and PE, the OI
// added/removed summed over every strike in each bucket (delta) and its running sum (cumulative),
// plus the net of the two (CE - PE). Pure - takes the per-strike change maps OI Replay's
// buildOiChangeMatrix already builds (Map<strike, Map<bucketTime, change>>), so it reads exactly the
// numbers the per-strike heatmaps show and adds no look-ahead of its own.

function sumByBucket(perStrikeChange) {
  const totals = new Map()
  for (const byBucket of perStrikeChange.values())
    for (const [time, v] of byBucket)
      if (Number.isFinite(v)) totals.set(time, (totals.get(time) ?? 0) + v)
  return totals
}

export function buildOiTotalsRows(cePerStrike, pePerStrike) {
  const ce = sumByBucket(cePerStrike)
  const pe = sumByBucket(pePerStrike)
  const buckets = [...new Set([...ce.keys(), ...pe.keys()])].sort((a, b) => a - b)
  const rows = {
    ceDelta: new Map(), ceCum: new Map(),
    peDelta: new Map(), peCum: new Map(),
    netDelta: new Map(), netCum: new Map(),
  }
  let ceCum = 0
  let peCum = 0
  for (const t of buckets) {
    const c = ce.get(t) ?? 0
    const p = pe.get(t) ?? 0
    ceCum += c
    peCum += p
    rows.ceDelta.set(t, c); rows.ceCum.set(t, ceCum)
    rows.peDelta.set(t, p); rows.peCum.set(t, peCum)
    rows.netDelta.set(t, c - p); rows.netCum.set(t, ceCum - peCum)
  }
  return { buckets, rows }
}

// Did this row's series DECLINE in bucket t - CE, PE or net OI falling in that bucket? A delta row: its
// change is negative. A cumulative row: it fell from the bucket before, which is the same thing as its
// delta row being negative (the cumulative of a positive day can still be falling).
const DELTA_OF = { ceDelta: 'ceDelta', ceCum: 'ceDelta', peDelta: 'peDelta', peCum: 'peDelta', netDelta: 'netDelta', netCum: 'netDelta' }
export function oiTotalsDeclined(rows, key, t) {
  const v = rows[DELTA_OF[key]]?.get(t)
  return Number.isFinite(v) && v < 0
}

// Rose / declined / unchanged in bucket t, for colouring a cell.
export function oiTotalsTrend(rows, key, t) {
  const v = rows[DELTA_OF[key]]?.get(t)
  return !Number.isFinite(v) || v === 0 ? 0 : v > 0 ? 1 : -1
}
