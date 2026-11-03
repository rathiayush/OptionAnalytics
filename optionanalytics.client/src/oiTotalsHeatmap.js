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

// shared.toChartTime for an epoch-ms time: the chart's seconds, shifted to IST - the OI buckets' own clock.
const chartSeconds = (ms) => Math.floor(ms / 1000) + 5.5 * 3600

/** The near futures' ORDER FLOW beside the OI totals, in the SAME buckets (asked for - "show order flow's delta and
 *  cumulative delta after the OI net cumulative, per 3 min"): `flowDelta` = each bucket's delta (the aggressor buy - sell
 *  volume of its minutes - the Order Flow page's delta), `flowCum` = the cumulative delta from the session's FIRST minute
 *  (its CVD - the minutes before the first OI column count too). `minutes` - [{ ms, delta, estimated }] (cvdBackfill's
 *  deltaMinutes, kept up to date live by the "orderFlowDelta" push); a minute counts once the clock `asOfMs` has reached
 *  its start, as on the futures chart's delta panes - the newest column, like the OI's, is the bucket still trading. A
 *  column before the first minute traded has none (no cell); a bucket with no trade is 0. `estimated` holds the columns
 *  read from estimated minutes (the server recorded the day only from part way - cvdBackfill): the delta's own minutes,
 *  the cumulative's any minute up to it. No minutes - the totals as they were. */
export function withOrderFlowRows(totals, minutes, bucketSeconds, asOfMs = null) {
  if (!minutes?.length || !(bucketSeconds > 0) || !totals?.buckets?.length) return totals
  const byBucket = new Map()
  for (const m of minutes) {
    if (!Number.isFinite(m?.ms) || !Number.isFinite(m.delta) || (asOfMs != null && m.ms > asOfMs)) continue
    const t = Math.floor(chartSeconds(m.ms) / bucketSeconds) * bucketSeconds
    const b = byBucket.get(t) ?? { delta: 0, estimated: false }
    byBucket.set(t, { delta: b.delta + m.delta, estimated: b.estimated || !!m.estimated })
  }
  const times = [...byBucket.keys()].sort((a, b) => a - b)
  const flowDelta = new Map()
  const flowCum = new Map()
  const estimated = { flowDelta: new Set(), flowCum: new Set() }
  let cum = 0
  let cumEstimated = false
  let i = 0
  for (const t of totals.buckets) {
    while (i < times.length && times[i] <= t) {
      const b = byBucket.get(times[i])
      cum += b.delta
      cumEstimated ||= b.estimated
      i++
    }
    if (i === 0) continue
    const own = byBucket.get(t)
    flowDelta.set(t, own?.delta ?? 0)
    flowCum.set(t, cum)
    if (own?.estimated) estimated.flowDelta.add(t)
    if (cumEstimated) estimated.flowCum.add(t)
  }
  if (!flowCum.size) return totals
  return { buckets: totals.buckets, rows: { ...totals.rows, flowDelta, flowCum }, estimated }
}

// Did this row's series DECLINE in bucket t - CE, PE or net OI falling in that bucket? A delta row: its
// change is negative. A cumulative row: it fell from the bucket before, which is the same thing as its
// delta row being negative (the cumulative of a positive day can still be falling).
const DELTA_OF = { ceDelta: 'ceDelta', ceCum: 'ceDelta', peDelta: 'peDelta', peCum: 'peDelta', netDelta: 'netDelta', netCum: 'netDelta', flowDelta: 'flowDelta', flowCum: 'flowDelta' }
export function oiTotalsDeclined(rows, key, t) {
  const v = rows[DELTA_OF[key]]?.get(t)
  return Number.isFinite(v) && v < 0
}

// Rose / declined / unchanged in bucket t, for colouring a cell.
export function oiTotalsTrend(rows, key, t) {
  const v = rows[DELTA_OF[key]]?.get(t)
  return !Number.isFinite(v) || v === 0 ? 0 : v > 0 ? 1 : -1
}

// What a figure MEANS for the market: +1 bullish (green), -1 bearish (red), 0 nothing. PE OI added is put
// writers supporting the market - bullish - and PE removed bearish; CE OI added is call writers capping it -
// bearish - and CE removed bullish. Net = CE - PE: negative means the PE writers dominate - bullish; positive
// the CE writers - bearish. The same for a bucket's change (delta rows) and for the running total (who is
// ahead on the day: cumulative rows). The futures order flow: buyers ahead (delta positive) bullish, sellers bearish.
const BULLISH_WHEN = { ce: -1, pe: 1, net: -1, flow: 1 }
const SIDE_OF = { ceDelta: 'ce', ceCum: 'ce', peDelta: 'pe', peCum: 'pe', netDelta: 'net', netCum: 'net', flowDelta: 'flow', flowCum: 'flow' }
export function oiMeaning(key, v) {
  if (!Number.isFinite(v) || v === 0 || !SIDE_OF[key]) return 0
  return Math.sign(v) * BULLISH_WHEN[SIDE_OF[key]]
}

// The cell's own figure: for a delta row what that bucket did, for a cumulative row who is ahead.
export function oiTotalsMeaning(rows, key, t) {
  return oiMeaning(key, rows[key]?.get(t))
}

// What happened IN bucket t, for any row: the meaning of that row's change - so a cumulative that is still
// bullish but fell in the bucket (PE removed, say) shows a bearish bucket.
export function oiTotalsFlowMeaning(rows, key, t) {
  return oiMeaning(DELTA_OF[key], rows[DELTA_OF[key]]?.get(t))
}

// The totals as chart series (the totals charts popup): for CE, PE and net, the running total (cum) and each
// bucket's change (delta), { time, value, meaning } in bucket order - meaning as the table colours the figure
// (oiMeaning: a cumulative = who is ahead, a delta = what that bucket did).
export function oiTotalsSeries({ buckets, rows }) {
  const series = (key) => buckets.map((time) => {
    const value = rows[key].get(time) ?? 0
    return { time, value, meaning: oiMeaning(key, value) }
  })
  return {
    ce: { delta: series('ceDelta'), cum: series('ceCum') },
    pe: { delta: series('peDelta'), cum: series('peCum') },
    net: { delta: series('netDelta'), cum: series('netCum') },
  }
}
