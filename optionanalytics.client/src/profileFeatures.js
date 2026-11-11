// The DEVELOPING profiles of a day, candle by candle, for the Feature finder (and the dataset CSV) - asked for: "market profile
// and volume profile, LVN HVN VAL VAH POC, OI details, cumulative delta, heatmap, delta profile, futures profile ... use all these
// in the model training".
//
// Each profile at candle k is built ONLY from the candles up to k (the candle's close - no look-ahead; `tests/feature-finder.test.mjs`
// checks every feature of a day cut part way against the whole day's):
//   * the VOLUME profile of the day so far - the price series' volume (the near FUTURES' when the day has them, else the index's
//     own), each candle's volume spread evenly over the rows its range covers (profileZones.dayVolumeProfile's rule): POC, VAH,
//     VAL (orderFlowMath's value area), and the ONE HVN / LVN the charts draw (profileZones.volumeZones);
//   * the MARKET (TPO) profile of the day so far on the spot candles, 30-minute periods, row = profiles.tpoRowFor: POC, VAH, VAL
//     and the single prints above / below spot (profiles.tpoProfile's rules).
// They are worked out incrementally (one accumulation, a read at each candle), once a day / view.
import { pocIndexOf, valueAreaOf } from './orderFlowMath.js'
import { PROFILE_ROWS, volumeZones } from './profileZones.js'
import { tpoRowFor } from './profiles.js'

const SESSION_FIRST = 9 * 60 + 15
const TPO_PERIOD = 30
const istMinute = (ms) => Math.floor((ms + 5.5 * 3600e3) / 60e3) % 1440
const fin = (v) => Number.isFinite(v)
const round2 = (v) => Math.round(v * 100) / 100
const rowIndex = (price, size) => Math.floor(price / size + 1e-9)

const KEPT = new WeakMap()

/** { vp: [{ poc, vah, val, hvn, lvn } | null per candle], tpo: [{ poc, vah, val, singlesUp, singlesDown } | null per candle] } for a prepared
 *  day or its timeframe view. */
export function profileSeries(d) {
  let kept = KEPT.get(d)
  if (!kept) KEPT.set(d, kept = { vp: volumeSeries(d), tpo: tpoSeries(d) })
  return kept
}

function volumeSeries(d) {
  const p = d.price
  const out = new Array(d.n).fill(null)
  if (!p?.v) return out
  const size = PROFILE_ROWS[d.underlying] ?? 5
  const lo = Math.min(...p.l.filter((x) => x > 0))
  const hi = Math.max(...p.h)
  if (!fin(lo) || !fin(hi)) return out
  // The array only spans the day's price range - its size, not data: a read at candle k still sees nothing after k.
  const base = rowIndex(lo, size)
  const total = new Float64Array(rowIndex(hi, size) - base + 1)
  for (let k = 0; k < d.n; k++) {
    const volume = p.v[k]
    if (volume > 0 && p.h[k] >= p.l[k] && p.l[k] > 0) {
      const a = rowIndex(p.l[k], size) - base, b = rowIndex(p.h[k], size) - base
      const share = volume / (b - a + 1)
      for (let r = a; r <= b; r++) total[r] += share
    }
    const rows = []
    for (let r = 0; r < total.length; r++) if (total[r] > 0) rows.push({ price: round2((base + r) * size), total: total[r] })
    if (!rows.length) continue
    const counts = rows.map((r) => r.total)
    const poc = pocIndexOf(counts)
    const va = valueAreaOf(counts, poc, 0.7)
    const z = volumeZones({ rows, poc: rows[poc].price }, size)
    out[k] = { poc: rows[poc].price, vah: rows[va.hi].price, val: rows[va.lo].price, hvn: z.topHvn, lvn: z.thinLvn }
  }
  return out
}

function tpoSeries(d) {
  const out = new Array(d.n).fill(null)
  const s = d.spot
  if (!s?.h?.length) return out
  const size = tpoRowFor(d.underlying, PROFILE_ROWS[d.underlying] ?? 5)
  const lo = Math.min(...s.l.filter((x) => x > 0))
  const hi = Math.max(...s.h)
  if (!fin(lo) || !fin(hi)) return out
  const base = rowIndex(lo, size)
  const count = new Int32Array(rowIndex(hi, size) - base + 1)
  const lastPeriod = new Int32Array(count.length).fill(-1)
  const tf = d.tf ?? 1
  for (let k = 0; k < d.n; k++) {
    if (s.l[k] > 0 && s.h[k] >= s.l[k]) {
      // The candle's period: its first minute's (a candle never straddles a period at 1 / 3 / 5 / 15 minutes).
      const period = Math.max(0, Math.floor((istMinute(d.t[k]) - (tf - 1) - SESSION_FIRST) / TPO_PERIOD))
      for (let r = rowIndex(s.l[k], size) - base; r <= rowIndex(s.h[k], size) - base; r++) {
        if (lastPeriod[r] !== period) { lastPeriod[r] = period; count[r]++ }
      }
    }
    const rows = []
    for (let r = 0; r < count.length; r++) if (count[r] > 0) rows.push({ price: round2((base + r) * size), count: count[r] })
    if (!rows.length) continue
    const counts = rows.map((r) => r.count)
    const poc = pocIndexOf(counts)
    const va = valueAreaOf(counts, poc, 0.7)
    // Single prints: a row only one period visited, inside the day's range - above / below where spot is now.
    const spot = s.c[k]
    let up = 0, down = 0
    rows.forEach((r, i) => { if (r.count === 1 && i > 0 && i < rows.length - 1) { if (r.price > spot) up++; else down++ } })
    out[k] = { poc: rows[poc].price, vah: rows[va.hi].price, val: rows[va.lo].price, singlesUp: up, singlesDown: down }
  }
  return out
}
