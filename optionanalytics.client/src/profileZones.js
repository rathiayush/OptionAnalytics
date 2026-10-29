import { singlePrintGaps, tpoProfile, TPO_LETTERS } from './profiles.js'
import { rebucketBar, volumeProfile, volumeProfileFromCandles } from './orderFlowMath.js'
import { inMarketSession } from './marketSession.js'

// The Profiles page's maths: a day's volume profile and market profile (TPO) up to a clock, and the
// ZONES drawn over the candles as boxes -
//   volume profile: where the most volume traded (high-volume areas, each with its HVN) and where it
//     was thin (low-volume areas, each with its LVN), beside the POC and the value area;
//   market profile: where the market spent its time and accepted price (the value area and its
//     busiest rows) and where it moved through or rejected price (single prints inside the range,
//     tails at its extremes), beside the POC, value area and initial balance.
//
// Plain functions over the existing profile builders (orderFlowMath.volumeProfile, profiles.tpoProfile)
// so they can be tested without a browser. NOT read by the strategy scanner: its own node rules
// (profiles.profileNodes, lvnRun) are left exactly as they are.

const MIN = 60_000
const round2 = (v) => Math.round(v * 100) / 100
const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())

// The thresholds the page's boxes use. high / low: a row's volume (smoothed over three rows, as the
// node rule in profiles.profileNodes) against the profile's mean row - the same 1.3x / 0.6x. accept: a
// TPO row with at least this share of the POC row's TPOs is where the market spent its time. tailRows:
// a run of single prints at an extreme counts as a tail from this many rows (one row is just the high).
export const ZONE_RULES = { highX: 1.3, lowX: 0.6, acceptX: 0.7, tailRows: 2, maxZones: 4 }

/** The default profile row (points) for an index - fine enough to show the shape, coarse enough to read. */
export const PROFILE_ROWS = { NIFTY: 5, BANKNIFTY: 10, SENSEX: 10 }
export const PROFILE_ROW_CHOICES = { NIFTY: [2, 5, 10, 20], BANKNIFTY: [5, 10, 20, 50], SENSEX: [5, 10, 20, 50] }
/** The row the futures day is FETCHED in: the footprint's own (the Order Flow page's default), re-bucketed
 *  here into whichever profile row is picked, so changing the row asks the server nothing. */
export const FETCH_ROWS = { NIFTY: 1, BANKNIFTY: 5, SENSEX: 5 }

/** The minute bars known at the replay clock `clockMs` - a minute counts once it has COMPLETED (its start
 *  + 60 s <= the clock), the replay sync's own rule, so nothing after the clock is in a profile - and only
 *  the F&O session's minutes (09:15 - 15:29 IST). `clockMs` null = live: every bar of the session the
 *  server sent, the running minute too. */
export function barsKnownAt(bars, clockMs = null) {
  return (bars ?? []).filter((b) => {
    const ms = msOf(b.time)
    if (!Number.isFinite(ms) || !inMarketSession(ms)) return false
    return clockMs == null || ms + MIN <= clockMs
  })
}

/** The volume profile of `bars` in `rowSize` rows: from their footprint levels (the buy and sell traded at
 *  each price) when they carry any, else each candle's volume spread over its range. Rows: [{ price (the
 *  row's bottom), buy, sell, total }] low to high, with poc / vah / val. */
export function dayVolumeProfile(bars, rowSize) {
  const list = bars ?? []
  if (!(rowSize > 0) || !list.length) return volumeProfile([])
  const hasLevels = list.some((b) => b.levels?.some((l) => (l.buy ?? 0) + (l.sell ?? 0) > 0))
  if (hasLevels) return volumeProfile(list.map((b) => rebucketBar(b, rowSize)))
  return volumeProfileFromCandles(list.map((b) => ({ ...b, volume: b.volume ?? (b.buy ?? 0) + (b.sell ?? 0) })), rowSize)
}

/** A profile's rows on a full price grid of `rowSize` (a price nobody traded is a row of 0), with each row's
 *  value smoothed over three rows. */
function gridOf(rows, rowSize, valueOf) {
  const list = (rows ?? []).filter((r) => Number.isFinite(r.price)).sort((a, b) => a.price - b.price)
  if (!list.length || !(rowSize > 0)) return null
  const first = list[0].price
  const n = Math.round((list.at(-1).price - first) / rowSize) + 1
  if (n > 5000) return null
  const values = new Array(n).fill(0)
  for (const r of list) values[Math.round((r.price - first) / rowSize)] += valueOf(r)
  const prices = values.map((_, i) => round2(first + i * rowSize))
  const smooth = values.map((v, i) => (values[i - 1] ?? v) / 4 + v / 2 + (values[i + 1] ?? v) / 4)
  const mean = smooth.reduce((s, v) => s + v, 0) / n
  return { prices, values, smooth, mean, n }
}

/** Runs of consecutive grid rows for which `test(i)` holds, as [first, last] index pairs. */
function runsOf(n, test) {
  const runs = []
  let start = -1
  for (let i = 0; i <= n; i++) {
    if (i < n && test(i)) { if (start < 0) start = i; continue }
    if (start >= 0) runs.push([start, i - 1])
    start = -1
  }
  return runs
}

const rowMiddle = (price, rowSize) => round2(price + rowSize / 2)

/** The busy and thin areas of a volume profile, as boxes over the chart:
 *    high - runs of rows whose smoothed volume is at least highX x the mean row: where the most volume
 *           traded (the market's agreed prices). Each with its HVN - its busiest row - and its share of the
 *           day's volume; the one holding the POC is marked `poc`.
 *    low  - runs of rows at most lowX x the mean row, INSIDE the profile: where volume was thin and price
 *           moved through fast (often fast again on a return). Each with its LVN - its thinnest row. A thin
 *           run touching the top or bottom row is the day's edge, not a gap, and is left out.
 *  Box edges are price edges: `low` the bottom of its first row, `high` the top of its last. The strongest
 *  `maxZones` of each: the high ones by volume, the low ones by how thin and how wide. hvn / lvn: the node
 *  prices (row middles) of the high zones that are not the POC's, and of the low zones, strongest first. */
export function volumeZones(vp, rowSize, rules = ZONE_RULES) {
  const empty = { high: [], low: [], hvn: [], lvn: [] }
  const g = gridOf(vp?.rows, rowSize, (r) => r.total ?? (r.buy ?? 0) + (r.sell ?? 0))
  if (!g || g.n < 3 || !(g.mean > 0)) return empty
  const total = g.values.reduce((s, v) => s + v, 0)
  const pocIndex = Number.isFinite(vp.poc) ? Math.round((vp.poc - g.prices[0]) / rowSize) : -1

  const high = runsOf(g.n, (i) => g.smooth[i] >= rules.highX * g.mean).map(([a, b]) => {
    let peak = a
    for (let i = a; i <= b; i++) if (g.values[i] > g.values[peak]) peak = i
    const volume = g.values.slice(a, b + 1).reduce((s, v) => s + v, 0)
    return {
      kind: 'high', low: g.prices[a], high: round2(g.prices[b] + rowSize), node: rowMiddle(g.prices[peak], rowSize),
      share: total > 0 ? volume / total : 0, volume, poc: pocIndex >= a && pocIndex <= b,
    }
  }).sort((x, y) => y.volume - x.volume).slice(0, rules.maxZones)

  const low = runsOf(g.n, (i) => g.smooth[i] <= rules.lowX * g.mean)
    .filter(([a, b]) => a > 0 && b < g.n - 1)
    .map(([a, b]) => {
      let trough = a
      for (let i = a; i <= b; i++) if (g.smooth[i] < g.smooth[trough]) trough = i
      const volume = g.values.slice(a, b + 1).reduce((s, v) => s + v, 0)
      // Thinner and wider = a bigger gap: the room it leaves below the mean, over its rows.
      const depth = (b - a + 1) * g.mean - g.smooth.slice(a, b + 1).reduce((s, v) => s + v, 0)
      return { kind: 'low', low: g.prices[a], high: round2(g.prices[b] + rowSize), node: rowMiddle(g.prices[trough], rowSize), share: total > 0 ? volume / total : 0, volume, depth }
    })
    .sort((x, y) => y.depth - x.depth).slice(0, rules.maxZones)

  return {
    high, low,
    hvn: high.filter((z) => !z.poc).map((z) => z.node),
    lvn: low.map((z) => z.node),
  }
}

/** Which TPO letters the single row at `price` holds (the market profile's own rows). */
const lettersAt = (tpo, price) => tpo.rows.find((r) => Math.abs(r.price - price) < 1e-6)?.letters ?? ''

/** The market profile's boxes - where the market ACCEPTED price and where it REJECTED it:
 *    value    - the value area (70% of the TPOs around the POC): the day's accepted range;
 *    accepted - runs of at least two rows holding acceptX of the POC row's TPOs or more: where the market
 *               spent the most time (the POC's own run marked `poc`);
 *    singles  - single prints INSIDE the range (a row only one period visited, with more than one period on
 *               both sides - profiles.singlePrintGaps): a fast, one-sided move, often revisited;
 *    tails    - single prints at the day's high (a SELLING tail) or low (a BUYING tail) of at least tailRows
 *               rows, ending at a row more than one period visited: the auction rejected those prices.
 *  A single print or tail made only by the period still running (`lastPeriodRunning` - live, or a replay
 *  clock inside that period) is `forming`: the period can still fill it in.
 *  Box edges are price edges (the bottom of the first row, the top of the last). Nothing for a profile of
 *  one period: every row is a single print then, and none of it is a tail or a gap yet. */
export function marketProfileZones(tpo, { rules = ZONE_RULES, lastPeriodRunning = false } = {}) {
  const empty = { value: null, accepted: [], singles: [], tails: [], ib: null }
  if (!tpo?.rows?.length || !(tpo.rowSize > 0)) return empty
  const rowSize = tpo.rowSize
  const value = Number.isFinite(tpo.val) && Number.isFinite(tpo.vah) ? { kind: 'value', low: tpo.val, high: round2(tpo.vah + rowSize) } : null
  const ib = tpo.ib ? { kind: 'ib', low: tpo.ib.low, high: tpo.ib.high } : null
  if ((tpo.periods ?? 0) < 2) return { ...empty, value, ib }

  const g = gridOf(tpo.rows, rowSize, (r) => r.count)
  if (!g) return { ...empty, value, ib }
  const lastLetter = TPO_LETTERS[Math.max(0, Math.min(TPO_LETTERS.length, tpo.periods) - 1)]
  const forming = (a, b) => {
    if (!lastPeriodRunning) return false
    for (let i = a; i <= b; i++) if (!lettersAt(tpo, g.prices[i]).replace(lastLetter, '')) return true
    return false
  }

  const pocCount = Math.max(...g.values)
  const pocIndex = Math.round((tpo.poc - g.prices[0]) / rowSize)
  const accepted = runsOf(g.n, (i) => g.values[i] >= rules.acceptX * pocCount)
    .filter(([a, b]) => b > a)
    .map(([a, b]) => ({ kind: 'accepted', low: g.prices[a], high: round2(g.prices[b] + rowSize), rows: b - a + 1, poc: pocIndex >= a && pocIndex <= b }))
    .sort((x, y) => Number(y.poc) - Number(x.poc) || y.rows - x.rows)
    .slice(0, rules.maxZones)

  const singles = singlePrintGaps(tpo).map((z) => {
    const a = Math.round((z.low - g.prices[0]) / rowSize)
    const b = Math.round((z.high - g.prices[0]) / rowSize)
    return { kind: 'single', low: z.low, high: round2(z.high + rowSize), rows: b - a + 1, forming: forming(a, b) }
  })

  const tails = []
  let top = g.n - 1
  while (top >= 0 && g.values[top] === 1) top--
  if (top >= 0 && g.n - 1 - top >= rules.tailRows) tails.push({ kind: 'tail', side: 'selling', low: g.prices[top + 1], high: round2(g.prices[g.n - 1] + rowSize), rows: g.n - 1 - top, forming: forming(top + 1, g.n - 1) })
  let bottom = 0
  while (bottom < g.n && g.values[bottom] === 1) bottom++
  if (bottom < g.n && bottom >= rules.tailRows) tails.push({ kind: 'tail', side: 'buying', low: g.prices[0], high: round2(g.prices[bottom - 1] + rowSize), rows: bottom, forming: forming(0, bottom - 1) })

  return { value, accepted, singles, tails, ib }
}

export const TPO_PERIOD_MINUTES = 30

/** The day's market profile up to the clock, 30-minute periods (A = 09:15) in `rowSize` rows. */
export function dayMarketProfile(bars, rowSize) {
  return tpoProfile(bars, rowSize, TPO_PERIOD_MINUTES)
}

/** Whether the TPO period of the newest bar in `bars` is still running at `clockMs` (null = live: it is).
 *  Periods start at 09:15 IST, every 30 minutes. */
export function lastPeriodRunningAt(bars, clockMs = null) {
  const last = bars?.at(-1)
  if (!last) return false
  if (clockMs == null) return true
  const ms = msOf(last.time)
  const istMinute = Math.floor((ms / MIN + 330) % 1440)
  const open = ms - (istMinute - (9 * 60 + 15)) * MIN
  const end = open + (Math.floor((ms - open) / (TPO_PERIOD_MINUTES * MIN)) + 1) * TPO_PERIOD_MINUTES * MIN
  return clockMs < end
}

/** Candles of `timeframeMinutes` from minute bars (bucketed on the clock: a 5-minute candle is 09:15 - 09:20),
 *  { time (epoch ms of its start), open, high, low, close, volume }. */
export function candlesOf(bars, timeframeMinutes) {
  const bucket = Math.max(1, timeframeMinutes) * MIN
  const out = []
  for (const b of bars ?? []) {
    const ms = msOf(b.time)
    const start = Math.floor(ms / bucket) * bucket
    const volume = b.volume ?? (b.buy ?? 0) + (b.sell ?? 0)
    const last = out.at(-1)
    if (last && last.time === start) {
      last.high = Math.max(last.high, b.high)
      last.low = Math.min(last.low, b.low)
      last.close = b.close
      last.volume += volume
    } else {
      out.push({ time: start, open: b.open, high: b.high, low: b.low, close: b.close, volume })
    }
  }
  return out
}
