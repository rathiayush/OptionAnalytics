// The OI Replay Market Read card's OI walls and its OI build-up near ATM (OiReplayPage's marketRead).

const msOf = (p) => (p.ms != null ? p.ms : new Date(p.time).getTime())

function latestAtOrBefore(series, ms) {
  let lo = 0
  let hi = (series?.length ?? 0) - 1
  let found = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (msOf(series[mid]) <= ms) { found = series[mid]; lo = mid + 1 } else hi = mid - 1
  }
  return found
}

/** The OI walls around `spot` from the ladder's rows (buildLadderRows): resistance = the strike AT or ABOVE spot with the
 *  most call OI, support = the strike AT or BELOW spot with the most put OI - a heavy call strike below the price (or put
 *  strike above it) is writing the market has already gone through, not a wall ahead of it. A stale reading (a strike
 *  that has left the band) does not count. { resistance, support } - rows, or null. */
export function oiWalls(rows, spot) {
  let resistance = null
  let support = null
  if (!(spot > 0)) return { resistance, support }
  for (const r of rows ?? []) {
    if (r.strike >= spot && !r.ceStale && r.ceOi > 0 && r.ceOi > (resistance?.ceOi ?? 0)) resistance = r
    if (r.strike <= spot && !r.peStale && r.peOi > 0 && r.peOi > (support?.peOi ?? 0)) support = r
  }
  return { resistance, support }
}

/** The CE and PE OI change at the strikes within `width` points of `atm`, from `fromMs` to `asOfMs` - each strike's latest
 *  reading at or before each time; a strike with no reading at `fromMs` is left out (it had not joined the band). */
export function nearAtmOiChange(ceByStrike, peByStrike, atm, width, fromMs, asOfMs) {
  const side = (byStrike) => {
    let sum = 0
    for (const [strike, series] of byStrike) {
      if (Math.abs(strike - atm) > width) continue
      const from = latestAtOrBefore(series, fromMs)?.openInterest
      const now = latestAtOrBefore(series, asOfMs)?.openInterest
      if (Number.isFinite(from) && Number.isFinite(now)) sum += now - from
    }
    return sum
  }
  return { ce: side(ceByStrike), pe: side(peByStrike) }
}
