// Sudden OI walls: option writers putting on a lot of OI at one strike within a few minutes - far
// faster than they had been writing there before. One definition, used by the strategy engine (#25),
// the Order Flow page (chart lines, the liquidity map, signals, alerts), the scanner's OI read and OI
// Replay's liquidity map.

const MIN = 60_000

/**
 * minutes    - the window the writing happened in (5)
 * paceMinutes - the stretch before it the pace is judged on (30)
 * minPct     - the add must be at least this share of the strike's OI at the window's start (3%)
 * paceX      - ...and this many times its average add per window over the stretch before (3x)
 * minOfBand  - ...and this share of the biggest OI of its kind in the band, so a far strike's 3% of
 *              almost nothing is not a "wall" (2%)
 * band       - strikes within this many steps of the index (15)
 */
export const SUDDEN_OI = { minutes: 5, paceMinutes: 30, minPct: 0.03, paceX: 3, minOfBand: 0.02, band: 15 }

/**
 * Every sudden wall at `ms`, biggest add first. `oiAt(side, strike, t)` gives the OI ('CE' / 'PE')
 * known at t (null when none) - only what was known by `ms` is read.
 * Each: { side, strike, kind: 'support' (PUT) | 'resistance' (CALL), add, pct, paceX (null = nothing
 * written there before), oi (now), share (oi / the biggest of its kind in the band) }.
 */
export function findSuddenWalls({ strikes, oiAt, ms, spot, step, ...options }) {
  const o = { ...SUDDEN_OI, ...options }
  if (!(spot > 0) || !(step > 0)) return []
  const near = strikes.filter((k) => Math.abs(k - spot) <= o.band * step)
  const out = []
  for (const side of ['PE', 'CE']) {
    const bandMax = Math.max(0, ...near.map((k) => oiAt(side, k, ms) ?? 0))
    if (!(bandMax > 0)) continue
    for (const strike of near) {
      const now = oiAt(side, strike, ms)
      const base = oiAt(side, strike, ms - o.minutes * MIN)
      if (now == null || !(base > 0)) continue
      const add = now - base
      const earlier = oiAt(side, strike, ms - (o.minutes + o.paceMinutes) * MIN)
      // The average add per window over the stretch before (none known: no pace to beat).
      const pace = earlier != null ? (Math.max(0, base - earlier) * o.minutes) / o.paceMinutes : 0
      if (add < o.minPct * base || add < o.minOfBand * bandMax || add < o.paceX * pace) continue
      out.push({
        side, strike, kind: side === 'PE' ? 'support' : 'resistance', add, pct: add / base,
        paceX: pace > 0 ? add / pace : null, oi: now, share: now / bandMax,
      })
    }
  }
  return out.sort((a, b) => b.add - a.add)
}

const lakh = (v) => `${(v / 1e5).toFixed(1)}L`
/** "PUT 22700 +1.6L in 5m (+5.3%, 4.2x its pace)" */
export function suddenWallText(w, minutes = SUDDEN_OI.minutes) {
  return `${w.side === 'PE' ? 'PUT' : 'CALL'} ${w.strike} +${lakh(w.add)} in ${minutes}m (+${(w.pct * 100).toFixed(1)}%, ${w.paceX != null ? `${w.paceX.toFixed(1)}x its pace` : 'nothing written before'}) - now ${lakh(w.oi)}`
}
