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
  return { ...profile, ...profileNodes(profile) }
}

/** The high / low volume nodes of a volume profile (`rows` [{ price, total }] in price order, `poc`) - any row size,
 *  footprint or candle-spread: { hvn, lvn, hvnTop, lvnTop }. */
export function profileNodes(profile) {
  const rows = profile?.rows ?? []
  if (!rows.length) return { hvn: [], lvn: [], hvnTop: null, lvnTop: null }
  // Smooth over three rows so a single thin row inside a busy area is not called a node.
  const smooth = rows.map((r, i) => (rows[i - 1]?.total ?? r.total) / 4 + r.total / 2 + (rows[i + 1]?.total ?? r.total) / 4)
  const mean = smooth.reduce((s, v) => s + v, 0) / smooth.length
  const peaks = []
  const troughs = []
  for (let i = 1; i < rows.length - 1; i++) {
    if (smooth[i] >= smooth[i - 1] && smooth[i] >= smooth[i + 1] && smooth[i] >= 1.3 * mean) peaks.push({ price: rows[i].price, v: smooth[i] })
    if (smooth[i] <= smooth[i - 1] && smooth[i] <= smooth[i + 1] && smooth[i] <= 0.6 * mean) troughs.push({ price: rows[i].price, v: smooth[i] })
  }
  const byVolume = peaks.filter((p) => p.price !== profile.poc).sort((a, b) => b.v - a.v)
  const hvn = byVolume.slice(0, 4).map((p) => p.price).sort((a, b) => a - b)
  const top = [profile.poc, ...hvn]
  const lo = Math.min(...top)
  const hi = Math.max(...top)
  // LVNs between the high-volume areas are the ones price moves through fast - only the two thinnest
  // are marked (and traded): the rest are noise next to them.
  const thinnest = troughs.filter((t) => t.price > lo && t.price < hi).sort((a, b) => a.v - b.v)
  const lvn = thinnest.slice(0, 2).map((t) => t.price).sort((a, b) => a - b)
  // What the charts show: ONE of each - the strongest HVN after the POC (the highest-volume node) and
  // the thinnest LVN (the lowest-volume node). The lists above stay for the strategies.
  return { hvn, lvn, hvnTop: byVolume[0]?.price ?? null, lvnTop: thinnest[0]?.price ?? null }
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

// ---- Gaps: the thin parts of a profile, where price tends to move fast --------------------------------

/** A profile's rows on a full price grid - a price nobody traded (or no period visited) is a row of 0.
 *  `valueOf` reads a row's volume or TPO count. */
function gridOf(rows, valueOf) {
  const list = (rows ?? []).filter((r) => Number.isFinite(r.price)).sort((a, b) => a.price - b.price)
  if (list.length < 3) return null
  const diffs = list.slice(1).map((r, i) => r.price - list[i].price)
  const minStep = Math.min(...diffs)
  if (!(minStep > 1e-9)) return null
  let prices
  let values
  let step
  if (diffs.every((d) => d < 1.5 * minStep)) {
    // Already every row (the server's bins: one width, rounded to the paisa) - their own prices, the mean width.
    prices = list.map((r) => r.price)
    values = list.map(valueOf)
    step = (list.at(-1).price - list[0].price) / (list.length - 1)
  } else {
    step = minStep
    const n = Math.round((list.at(-1).price - list[0].price) / step) + 1
    if (n > 5000) return null // not a profile's grid
    const byIndex = new Map(list.map((r) => [Math.round((r.price - list[0].price) / step), valueOf(r)]))
    prices = Array.from({ length: n }, (_, i) => round2(list[0].price + i * step))
    values = prices.map((_, i) => byIndex.get(i) ?? 0)
  }
  const n = prices.length
  // Smoothed over three rows, as the node rule (sessionVolumeProfile) - one thin row inside a busy area is not a gap.
  const smooth = values.map((v, i) => (values[i - 1] ?? v) / 4 + v / 2 + (values[i + 1] ?? v) / 4)
  const mean = smooth.reduce((s, v) => s + v, 0) / n
  return { prices, values, smooth, mean, step }
}

/** Zones overlapping or touching (within `join`) as one, labels kept once each. */
function mergeZones(zones, join = 0) {
  const sorted = [...zones].sort((a, b) => a.low - b.low)
  const out = []
  for (const z of sorted) {
    const last = out.at(-1)
    if (last && z.low <= last.high + join) { last.high = Math.max(last.high, z.high); for (const l of z.labels ?? []) if (!last.labels.includes(l)) last.labels.push(l) }
    else out.push({ ...z, labels: [...(z.labels ?? [])] })
  }
  return out
}

/** The low-volume gap around each low node (`lows`: prices, e.g. a profile's LVNs) as a zone { low, high }:
 *  the node's row and its neighbours that are thin too (smoothed value at most 0.6 x the mean - the LVN rule),
 *  the stretch price crosses fast. A node on a row that is not thin is a zone of its own row. */
export function lowNodeGaps(rows, lows, valueOf = (r) => r.total) {
  const g = gridOf(rows, valueOf)
  if (!g || !(g.mean > 0)) return []
  const thin = (i) => g.smooth[i] <= 0.6 * g.mean
  const zones = []
  for (const p of lows ?? []) {
    if (!Number.isFinite(p)) continue
    let i = Math.round((p - g.prices[0]) / g.step)
    if (i < 0 || i >= g.prices.length) continue
    let a = i
    let b = i
    if (thin(i)) { while (a > 0 && thin(a - 1)) a--; while (b < g.prices.length - 1 && thin(b + 1)) b++ }
    zones.push({ low: g.prices[a], high: g.prices[b] })
  }
  return mergeZones(zones).map(({ low, high }) => ({ low, high }))
}

/** A market profile's own low nodes: its two thinnest TPO-count troughs between its POC and its high-count
 *  areas - the volume profile's LVN rule (sessionVolumeProfile) on TPO counts. */
export function tpoLowNodes(tpo) {
  const g = gridOf(tpo?.rows, (r) => r.count)
  if (!g || !(g.mean > 0)) return []
  const peaks = []
  const troughs = []
  for (let i = 1; i < g.prices.length - 1; i++) {
    if (g.smooth[i] >= g.smooth[i - 1] && g.smooth[i] >= g.smooth[i + 1] && g.smooth[i] >= 1.3 * g.mean) peaks.push(g.prices[i])
    if (g.smooth[i] <= g.smooth[i - 1] && g.smooth[i] <= g.smooth[i + 1] && g.smooth[i] <= 0.6 * g.mean) troughs.push({ price: g.prices[i], v: g.smooth[i] })
  }
  const top = [tpo.poc, ...peaks]
  const lo = Math.min(...top)
  const hi = Math.max(...top)
  return troughs.filter((t) => t.price > lo && t.price < hi).sort((a, b) => a.v - b.v).slice(0, 2).map((t) => t.price).sort((a, b) => a - b)
}

/** A market profile's own high-count node (its HVN): the centre of its strongest busy area other than the POC's -
 *  a peak (or a flat top - its middle row) of at least 0.4 x the POC's count, with the count dipping below 0.7 x
 *  the peak's between it and the POC, so a bump inside the POC's own area is not one (counts smoothed over three
 *  rows, as the LVN rule). `count` of them, strongest first, one per area. */
export function tpoHighNodes(tpo, count = 1) {
  const g = gridOf(tpo?.rows, (r) => r.count)
  if (!g || !(g.mean > 0) || !Number.isFinite(tpo?.poc)) return []
  const n = g.prices.length
  const at = (price) => Math.max(0, Math.min(n - 1, Math.round((price - g.prices[0]) / g.step)))
  const apart = (i, j) => { const [a, b] = i < j ? [i, j] : [j, i]; let low = Infinity; for (let k = a; k <= b; k++) low = Math.min(low, g.smooth[k]); return low < 0.7 * Math.min(g.smooth[i], g.smooth[j]) }
  const poc = at(tpo.poc)
  const floor = 0.4 * g.smooth[poc]
  const peaks = []
  for (let i = 1; i < n - 1; i++) {
    if (g.smooth[i] >= g.smooth[i - 1] && g.smooth[i] >= g.smooth[i + 1] && g.smooth[i] >= floor && apart(i, poc)) peaks.push(i)
  }
  // A flat top is one peak, at its middle row.
  const centre = (i) => { let a = i; let b = i; while (a > 0 && Math.abs(g.smooth[a - 1] - g.smooth[i]) < 1e-9) a--; while (b < n - 1 && Math.abs(g.smooth[b + 1] - g.smooth[i]) < 1e-9) b++; return Math.round((a + b) / 2) }
  const out = []
  for (const i of peaks.sort((a, b) => g.smooth[b] - g.smooth[a] || a - b)) {
    const c = centre(i)
    if (out.every((j) => j !== c && apart(c, j))) out.push(c)
    if (out.length >= count) break
  }
  return out.map((i) => g.prices[i])
}

/** A market profile's single-print gaps: runs of rows only one period visited (or none - a jump), with more
 *  than one period on BOTH sides. A single-print run at the day's high or low is a tail, not a gap. */
export function singlePrintGaps(tpo) {
  const g = gridOf(tpo?.rows, (r) => r.count)
  if (!g) return []
  const zones = []
  let start = -1
  for (let i = 0; i < g.values.length; i++) {
    if (g.values[i] <= 1) { if (start < 0) start = i; continue }
    if (start > 0) zones.push({ low: g.prices[start], high: g.prices[i - 1] })
    start = -1
  }
  return zones
}

/** The gaps of the previous session's profiles, as zones { low, high, labels }: the volume profile's LVN gaps
 *  (`vp.rows` and `vp.lvn`) and the market profile's LVN gaps and single prints (`tpo.rows`) - zones that
 *  overlap or are within `join` of each other are one (both profiles in it: a confluence). A node whose row
 *  is not thin is a zone one row wide, labelled as the node (LVN) rather than a gap. */
export function profileGaps(vp, tpo, join = 0) {
  const out = []
  const label = (z, node, gap) => ({ ...z, labels: [z.high > z.low ? gap : node] })
  if (vp?.rows?.length && vp.lvn?.length) for (const z of lowNodeGaps(vp.rows, vp.lvn, (r) => r.total ?? r.volume ?? 0)) out.push(label(z, 'VP LVN', 'VP LVN gap'))
  if (tpo?.rows?.length) {
    for (const z of lowNodeGaps(tpo.rows, tpoLowNodes(tpo), (r) => r.count)) out.push(label(z, 'TPO LVN', 'TPO LVN gap'))
    for (const z of singlePrintGaps(tpo)) out.push({ ...z, labels: ['TPO single prints'] })
  }
  // The volume profile's part named first, whichever zone starts lower.
  return mergeZones(out, join).map((z) => ({ ...z, labels: z.labels.sort((a, b) => a.startsWith('TPO') - b.startsWith('TPO')) }))
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

/** The SERVER's previous-day spot volume profile (`bins` of each bin's MIDDLE price and volume, with its own
 *  poc / vah / val) as the shape VolumeProfilePrimitive draws - rows at each bin's BOTTOM price, `rowSize` tall,
 *  with no buy / sell split (the bins carry none, so they are drawn in one neutral colour) and the levels moved
 *  to the same bottom-of-row space. Null when there are not two bins to read a row size from. */
export function binsProfile(profile) {
  const bins = (profile?.bins ?? [])
    .filter((b) => Number.isFinite(b?.price) && Number.isFinite(b?.volume))
    .sort((a, b) => a.price - b.price)
  if (bins.length < 2) return null
  // The row size comes from ALL the bins, the empty ones included: the server bins by each bar's close, so a
  // real day leaves plenty at zero volume, and measuring the step between only the bins that traded would
  // read a gap of three empty bins as the row size and draw every bar three times too tall.
  const steps = bins.slice(1).map((b, i) => b.price - bins[i].price).filter((d) => d > 0)
  if (!steps.length) return null
  const rowSize = Math.min(...steps)
  const half = rowSize / 2
  const rows = bins.filter((b) => b.volume > 0).map((b) => ({ price: round2(b.price - half), buy: 0, sell: 0, total: b.volume }))
  const maxRow = rows.length ? Math.max(...rows.map((r) => r.total)) : 0
  if (!(maxRow > 0)) return null
  const bottom = (v) => (Number.isFinite(v) ? round2(v - half) : null)
  return { rows, rowSize, maxRow, poc: bottom(profile.poc), vah: bottom(profile.vah), val: bottom(profile.val) }
}
