import { pocIndexOf, valueAreaOf, volumeProfile } from './orderFlowMath.js'

// Volume profile and market profile (TPO) for the strategy scanner and the Profiles card.
//
// Volume profile levels always come from the PREVIOUS session - POC, value area (VAH / VAL, 70% of the
// volume) and its high / low volume nodes (HVN / LVN) - the levels a day trader carries into today.
// Market profile: the previous session's TPO value area and POC (30-minute periods), plus today's
// developing TPO profile and its initial balance (the first hour, 09:15-10:15).

const MIN = 60_000
const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())
const round2 = (v) => Math.round(v * 100) / 100
const istMinute = (ms) => Math.floor((ms / MIN + 330) % 1440)
export const TPO_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** Previous session volume profile with its high / low volume nodes. `bars`: that day's minute bars
 *  (footprint levels bucketed to the row size). */
export function sessionVolumeProfile(bars) {
  const profile = volumeProfile(bars)
  if (!profile.rows.length) return { ...profile, hvn: [], lvn: [] }
  const rows = profile.rows
  // Smooth over three rows so a single thin row inside a busy area is not called a node.
  const smooth = rows.map((r, i) => (rows[i - 1]?.total ?? r.total) / 4 + r.total / 2 + (rows[i + 1]?.total ?? r.total) / 4)
  const mean = smooth.reduce((s, v) => s + v, 0) / smooth.length
  const peaks = []
  const troughs = []
  for (let i = 1; i < rows.length - 1; i++) {
    if (smooth[i] >= smooth[i - 1] && smooth[i] >= smooth[i + 1] && smooth[i] >= 1.3 * mean) peaks.push({ price: rows[i].price, v: smooth[i] })
    if (smooth[i] <= smooth[i - 1] && smooth[i] <= smooth[i + 1] && smooth[i] <= 0.6 * mean) troughs.push({ price: rows[i].price, v: smooth[i] })
  }
  const hvn = peaks.filter((p) => p.price !== profile.poc).sort((a, b) => b.v - a.v).slice(0, 4).map((p) => p.price).sort((a, b) => a - b)
  const top = [profile.poc, ...hvn]
  const lo = Math.min(...top)
  const hi = Math.max(...top)
  // LVNs between the high-volume areas are the ones price moves through fast - only the two thinnest
  // are marked (and traded): the rest are noise next to them.
  const lvn = troughs.filter((t) => t.price > lo && t.price < hi).sort((a, b) => a.v - b.v).slice(0, 2).map((t) => t.price).sort((a, b) => a - b)
  return { ...profile, hvn, lvn }
}

/** A TPO (market) profile: each `periodMinutes` period puts its letter on every row its range touched.
 *  `rowSize` here is the TPO row (coarser than the footprint row). Value area = 70% of the TPOs around
 *  the POC, added two rows at a time (valueAreaOf); initial balance = the first two periods. */
export function tpoProfile(bars, rowSize, periodMinutes = 30) {
  if (!bars?.length || !(rowSize > 0)) return null
  const first = msOf(bars[0].time)
  const dayOpen = first - ((istMinute(first) - (9 * 60 + 15)) * MIN)
  const rows = new Map()
  let ibHigh = -Infinity
  let ibLow = Infinity
  for (const b of bars) {
    // A bar without a real range (a zero price from a feed gap) would paint every row from 0 up.
    if (!(b.low > 0) || !(b.high >= b.low)) continue
    const period = Math.max(0, Math.floor((msOf(b.time) - dayOpen) / (periodMinutes * MIN)))
    const letter = TPO_LETTERS[Math.min(period, TPO_LETTERS.length - 1)]
    if (period < 2) { ibHigh = Math.max(ibHigh, b.high); ibLow = Math.min(ibLow, b.low) }
    for (let p = Math.floor(b.low / rowSize) * rowSize; p <= b.high + 1e-9; p = round2(p + rowSize)) {
      const key = round2(p)
      if (!rows.has(key)) rows.set(key, new Set())
      rows.get(key).add(letter)
    }
  }
  const list = [...rows.entries()].map(([price, set]) => ({ price, letters: [...set].sort().join(''), count: set.size })).sort((a, b) => a.price - b.price)
  if (!list.length) return null
  // POC (ties: nearest the middle) and the 70% value area by the standard two-rows-at-a-time rule.
  const counts = list.map((r) => r.count)
  const pocIndex = pocIndexOf(counts)
  const { lo, hi } = valueAreaOf(counts, pocIndex, 0.7)
  // Single prints: rows only one period visited, inside the day's range (fast moves - often revisited).
  const singles = list.filter((r, i) => r.count === 1 && i > 0 && i < list.length - 1).map((r) => r.price)
  return {
    rows: list, rowSize, poc: list[pocIndex].price, vah: list[hi].price, val: list[lo].price,
    ib: Number.isFinite(ibHigh) ? { high: ibHigh, low: ibLow } : null, singles, periods: Math.min(TPO_LETTERS.length, Math.ceil((msOf(bars.at(-1).time) - dayOpen + MIN) / (periodMinutes * MIN))),
  }
}

/** The TPO row size for an underlying's futures: coarse enough to read as a profile. */
export const tpoRowFor = (underlying, rowSize) => Math.max(rowSize, underlying === 'BANKNIFTY' || underlying === 'SENSEX' ? 10 : 5)

/** The previous trading day's bars for a date: tries up to a week back (holidays, weekends). */
export async function fetchPreviousSession(underlying, date, rowSize, expiryQuery = '') {
  const d = new Date(`${date}T00:00:00Z`)
  for (let back = 1; back <= 7; back++) {
    const day = new Date(d.getTime() - back * 86_400_000)
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue
    const key = day.toISOString().slice(0, 10)
    try {
      const r = await fetch(`/api/order-flow/${underlying}/day/${key}?rowSize=${rowSize}&minTradeLots=100000&heatmapColumns=50${expiryQuery}`)
      if (!r.ok) continue
      const body = await r.json()
      if (body?.bars?.length) return { date: key, bars: body.bars, source: body.source, contract: body.meta?.contractSymbol }
    } catch { /* try the day before */ }
  }
  return null
}
