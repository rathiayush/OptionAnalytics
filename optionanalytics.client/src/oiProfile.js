// The OI PROFILE (asked for - "delta profile ... like professional systems use it: on the futures chart use futures OI, on
// the option chart options OI"): OPEN INTEREST CHANGE added up by PRICE, as the OI profiles of the professional tools draw
// it (Hyblock's OI profile, Exocharts' / ATAS' OI by price) beside the volume delta - where positions were OPENED (OI up)
// and where they were CLOSED (OI down), which volume alone cannot tell.
//
//   FUTURES: each minute's change in the near futures' OI (the run's 1-minute futures bars - OI at the minute's close less
//     the minute before's), laid on the price rows that minute's futures bar covered (spread evenly - the volume profile's
//     way for a candle). + = positions opened there, − = closed.
//   OPTIONS on the SPOT chart: each minute's change in the option OI of every strike loaded (a strike from its own first
//     reading - the band follows spot, so a strike joining later is not counted whole), calls and puts apart, laid on the
//     rows the SPOT covered that minute. NET = PE added − CE added: + = puts written / calls closed there (a floor building -
//     bullish), − = calls written / puts closed (a ceiling building - bearish) - ATAS' net OI convention, on spot.
//
// Every minute from readings up to its own end: a profile at a clock is the one built from the minutes before it (no
// look-ahead). Pure - it feeds no strategy or alert.

const MIN = 60_000
const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())
const minuteOf = (ms) => Math.floor(ms / MIN) * MIN
const round2 = (v) => Math.round(v * 100) / 100
const rowOf = (price, rowSize) => round2(Math.floor(price / rowSize + 1e-9) * rowSize)

// A side's OI change per minute, summed over its strikes: each strike's last reading of a minute against its reading before
// (its first reading counts 0). Map minute -> change.
function sideOiChanges(points, clock) {
  const byStrike = new Map()
  for (const p of points ?? []) {
    if (!p || !Number.isFinite(p.strike) || !Number.isFinite(p.openInterest)) continue
    const t = minuteOf(msOf(p.time))
    if (!Number.isFinite(t) || (clock != null && t > clock)) continue
    let m = byStrike.get(p.strike)
    if (!m) byStrike.set(p.strike, m = new Map())
    m.set(t, p.openInterest)
  }
  const out = new Map()
  for (const readings of byStrike.values()) {
    let prev = null
    for (const [t, oi] of [...readings.entries()].sort((a, b) => a[0] - b[0])) {
      if (prev != null && oi !== prev) out.set(t, (out.get(t) ?? 0) + (oi - prev))
      prev = oi
    }
  }
  return out
}

/** The OPTIONS' OI change minute by minute on the spot: [{ t, low, high, ce, pe }] - the CE and PE OI added that minute
 *  (− = taken off) and the spot's range then (its last price when it has no bar); minutes with no change left out. */
export function optionOiMinutes(cePoints, pePoints, spotBars, { asOfMs = null } = {}) {
  const clock = asOfMs == null ? null : minuteOf(asOfMs)
  const spot = (spotBars ?? []).filter((b) => b && b.close > 0 && Number.isFinite(msOf(b.time)))
    .map((b) => ({ t: minuteOf(msOf(b.time)), low: Math.min(b.low ?? b.close, b.close), high: Math.max(b.high ?? b.close, b.close), close: b.close }))
    .filter((b) => clock == null || b.t <= clock).sort((a, b) => a.t - b.t)
  if (!spot.length) return []
  const bar = new Map(spot.map((b) => [b.t, b]))
  const spotAt = (t) => {
    if (bar.has(t)) return bar.get(t)
    let found = null
    for (const b of spot) { if (b.t <= t) found = b; else break }
    return found ? { low: found.close, high: found.close } : null
  }
  const ce = sideOiChanges(cePoints, clock), pe = sideOiChanges(pePoints, clock)
  const out = []
  for (const t of [...new Set([...ce.keys(), ...pe.keys()])].sort((a, b) => a - b)) {
    const s = spotAt(t)
    if (!s) continue
    out.push({ t, low: s.low, high: s.high, ce: ce.get(t) ?? 0, pe: pe.get(t) ?? 0 })
  }
  return out
}

/** The FUTURES' OI change minute by minute: [{ t, low, high, oi }] - the OI at each minute's close less the minute
 *  before's, on that minute's futures bar range; minutes with no change (or no OI) left out. */
export function futuresOiMinutes(futuresBars, { asOfMs = null } = {}) {
  const clock = asOfMs == null ? null : minuteOf(asOfMs)
  const bars = (futuresBars ?? []).filter((b) => b && Number.isFinite(b.openInterest) && b.openInterest > 0 && b.close > 0)
    .map((b) => ({ ...b, t: minuteOf(msOf(b.time)) })).filter((b) => Number.isFinite(b.t) && (clock == null || b.t <= clock))
    .sort((a, b) => a.t - b.t)
  const out = []
  for (let i = 1; i < bars.length; i++) {
    const change = bars[i].openInterest - bars[i - 1].openInterest
    if (!change) continue
    const b = bars[i]
    out.push({ t: b.t, low: Math.min(b.low ?? b.close, b.close), high: Math.max(b.high ?? b.close, b.close), oi: change })
  }
  return out
}

/**
 * The OI profile of one or more SESSIONS (each `optionOiMinutes` or `futuresOiMinutes`), in rows of `rowSize`: { rows
 * [{ price (the row's bottom), delta (the OI change there - options: PE − CE), ce, pe, oi }], rowSize, maxAbsDelta,
 * delta (the total), added (the + rows' total), shed (the − rows'), built / unwound (the row with the most added / taken
 * off, its middle - null for none) }. Each minute's change spread evenly over the rows its range covered.
 */
export function oiProfileOf(sessions, { rowSize = 5 } = {}) {
  const rows = new Map()
  for (const minutes of sessions ?? []) for (const m of minutes ?? []) {
    if (!(rowSize > 0) || !Number.isFinite(m.low) || !Number.isFinite(m.high)) continue
    const bottom = rowOf(m.low, rowSize), top = rowOf(m.high, rowSize)
    const n = Math.max(1, Math.round((top - bottom) / rowSize) + 1)
    for (let i = 0; i < n; i++) {
      const price = round2(bottom + i * rowSize)
      let r = rows.get(price)
      if (!r) rows.set(price, r = { price, delta: 0, ce: 0, pe: 0, oi: 0 })
      if (m.oi != null) { r.oi += m.oi / n; r.delta += m.oi / n } else { r.ce += m.ce / n; r.pe += m.pe / n; r.delta += (m.pe - m.ce) / n }
    }
  }
  const list = [...rows.values()].filter((r) => Math.abs(r.delta) > 1e-9 || r.ce || r.pe).sort((a, b) => a.price - b.price)
  let maxAbsDelta = 0, delta = 0, added = 0, shed = 0, built = null, unwound = null
  for (const r of list) {
    maxAbsDelta = Math.max(maxAbsDelta, Math.abs(r.delta))
    delta += r.delta
    if (r.delta > 0) { added += r.delta; if (!built || r.delta > built.delta) built = r } else { shed += r.delta; if (!unwound || r.delta < unwound.delta) unwound = r }
  }
  const mid = (r) => (r ? round2(r.price + rowSize / 2) : null)
  return { rows: list, rowSize, maxAbsDelta, delta, added, shed, built: mid(built), unwound: mid(unwound) }
}
