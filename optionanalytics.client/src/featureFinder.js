// FEATURE FINDER - the first step towards machine learning on the app's own data (asked for: "we have plenty of
// information - market and volume profile of past days, TA, OI, cumulative delta ... can we use a machine learning model to
// find the best correlation and create models?").
//
// Every reading the Signal backtest's rule builder reads, at every candle of the days loaded, as ONE TABLE: the FEATURES -
// each known at the candle's close (prepareDay works every one out from data up to the end of its minute: no look-ahead) -
// and the LABELS - what happened AFTER the candle: spot's move 15 / 30 / 60 min later, and how an option bought there did
// with the page's SL / target / trail (simulateTrade, the backtest's own trade). Then, for each feature and label, how well
// the feature ranked what came next on the EARLIER days (Spearman's rank correlation, the "information coefficient") and
// whether that HELD on the LATER days it never saw (a walk-forward split), with the win rate of the trades in its top and
// bottom fifth. A table that ranks readings is the honest first step: the same days give a lucky correlation as easily as a
// real one, so only what holds on the later days is worth turning into a rule - and that rule then goes through the
// backtest, with charges, like any other. Pure: no page, no network.

import { emaSeries, istMinute, optionFor, rsiSeries, simulateTrade, timeframeView, clockMinute } from './signalBacktest.js'

const MIN = 60_000
const fin = (v) => Number.isFinite(v)
const pct = (a, b) => (fin(a) && fin(b) && b !== 0 ? ((a - b) / b) * 100 : NaN)
// The candle `minutes` before `i` (at least the first): the look-backs are minutes, the candles the timeframe's.
const back = (d, i, minutes) => Math.max(0, i - Math.max(1, Math.round(minutes / (d.tf ?? 1))))
// A line's value now in % of its range so far (signed) - the scale the rule builder's cumulative lines are read on.
function ofRange(series, i) {
  if (!series || !fin(series[i])) return NaN
  let lo = Infinity, hi = -Infinity
  for (let k = 0; k <= i; k++) if (fin(series[k])) { lo = Math.min(lo, series[k]); hi = Math.max(hi, series[k]) }
  return hi > lo ? (series[i] / (hi - lo)) * 100 : 0
}
const lead = (ce, pe) => { const size = Math.abs(ce) + Math.abs(pe); return size > 0 ? ((pe - ce) / size) * 100 : NaN }
const leadOfLower = (ce, pe) => { const lo = Math.min(ce, pe); return ce > 0 && pe > 0 && lo > 0 ? ((pe - ce) / lo) * 100 : NaN }

/** The features: `read(d, i)` - a number known at candle i's close of the prepared day (or its timeframe view) `d`, NaN
 *  when there is none. Positive = the bullish way where a reading has a side (PE over CE, price over a level). */
export const FEATURES = [
  // OI
  { key: 'oiOpenLead', group: 'OI', name: 'OI since open: PE − CE (% of both)', read: (d, i) => lead(d.oi?.[i]?.ce, d.oi?.[i]?.pe) },
  { key: 'totalOiLead', group: 'OI', name: 'Total OI: PE over CE (% of the lower)', read: (d, i) => leadOfLower(d.tot?.[i]?.ce, d.tot?.[i]?.pe) },
  { key: 'totalCe15', group: 'OI', name: 'Total CE OI: change over 15 min %', read: (d, i) => pct(d.tot?.[i]?.ce, d.tot?.[back(d, i, 15)]?.ce) },
  { key: 'totalPe15', group: 'OI', name: 'Total PE OI: change over 15 min %', read: (d, i) => pct(d.tot?.[i]?.pe, d.tot?.[back(d, i, 15)]?.pe) },
  { key: 'atm1Total', group: 'OI', name: 'S-R walls ATM ± 1: PE over CE total OI %', read: (d, i) => { const x = d.atmOi?.[i]?.[1]; return x ? leadOfLower(x.ce, x.pe) : NaN } },
  { key: 'atm1Open', group: 'OI', name: 'S-R walls ATM ± 1: PE − CE added since open %', read: (d, i) => { const x = d.atmOi?.[i]?.[1]; return x ? lead(x.dce, x.dpe) : NaN } },
  { key: 'atm2Open', group: 'OI', name: 'S-R walls ATM ± 2: PE − CE added since open %', read: (d, i) => { const x = d.atmOi?.[i]?.[2]; return x ? lead(x.dce, x.dpe) : NaN } },
  { key: 'hp15', group: 'OI', name: '🎯 in the last 15 min (+1 bullish, −1 bearish)', read: (d, i) => {
    const from = back(d, i, 15)
    const last = (d.hp ?? []).filter((h) => h.i <= i && h.i > from).at(-1)
    return last ? last.dir : 0
  } },
  // Cumulative Δ (the OI totals' lines)
  { key: 'ceCum', group: 'Cumulative Δ', name: 'CE cumulative Δ (% of its range)', read: (d, i) => ofRange(d.ceCum, i) },
  { key: 'peCum', group: 'Cumulative Δ', name: 'PE cumulative Δ (% of its range)', read: (d, i) => ofRange(d.peCum, i) },
  { key: 'netCum', group: 'Cumulative Δ', name: 'Net (CE − PE) cumulative Δ (% of its range)', read: (d, i) => ofRange(d.netCum, i) },
  { key: 'netCum15', group: 'Cumulative Δ', name: 'Net cumulative Δ: move over 15 min (% of its range)', read: (d, i) => {
    // Both ends on the range known at the candle (the same scale).
    const s = d.netCum
    const j = back(d, i, 15)
    if (!s || !fin(s[i]) || !fin(s[j])) return NaN
    let lo = Infinity, hi = -Infinity
    for (let k = 0; k <= i; k++) if (fin(s[k])) { lo = Math.min(lo, s[k]); hi = Math.max(hi, s[k]) }
    return hi > lo ? ((s[i] - s[j]) / (hi - lo)) * 100 : 0
  } },
  // Walls and GEX (distance in % of spot)
  { key: 'oiSupport', group: 'Walls & GEX', name: 'Spot above the OI support %', read: (d, i) => pct(d.spot.c[i], d.walls?.[i]?.support) },
  { key: 'oiResistance', group: 'Walls & GEX', name: 'Spot below the OI resistance %', read: (d, i) => -pct(d.spot.c[i], d.walls?.[i]?.resistance) },
  { key: 'gexNet', group: 'Walls & GEX', name: 'Net GEX (% of its largest so far)', read: (d, i) => {
    const net = d.gex?.[i]?.net
    if (!fin(net)) return NaN
    let big = 0
    for (let k = 0; k <= i; k++) { const v = d.gex?.[k]?.net; if (fin(v)) big = Math.max(big, Math.abs(v)) }
    return big > 0 ? (net / big) * 100 : 0
  } },
  { key: 'gexCallWall', group: 'Walls & GEX', name: 'Spot below the GEX call wall %', read: (d, i) => -pct(d.spot.c[i], d.gex?.[i]?.callWall) },
  { key: 'gexPutWall', group: 'Walls & GEX', name: 'Spot above the GEX put wall %', read: (d, i) => pct(d.spot.c[i], d.gex?.[i]?.putWall) },
  // The ATM straddle
  { key: 'straddleVwap', group: 'Straddle', name: 'ATM straddle vs its VWAP %', read: (d, i) => pct(d.straddle?.[i]?.value, d.straddle?.[i]?.vwap) },
  { key: 'straddleDecay', group: 'Straddle', name: 'ATM straddle vs its decay-only line %', read: (d, i) => pct(d.straddle?.[i]?.value, d.straddle?.[i]?.decay) },
  // Price
  { key: 'vwap', group: 'Price', name: 'Price vs VWAP %', read: (d, i) => pct(d.price?.c?.[i], d.vwap?.[i]) },
  { key: 'move5', group: 'Price', name: 'Spot move over 5 min %', read: (d, i) => (i > 0 ? pct(d.spot.c[i], d.spot.c[back(d, i, 5)]) : NaN) },
  { key: 'move15', group: 'Price', name: 'Spot move over 15 min %', read: (d, i) => (i > 0 ? pct(d.spot.c[i], d.spot.c[back(d, i, 15)]) : NaN) },
  { key: 'move30', group: 'Price', name: 'Spot move over 30 min %', read: (d, i) => (i > 0 ? pct(d.spot.c[i], d.spot.c[back(d, i, 30)]) : NaN) },
  { key: 'dayMove', group: 'Price', name: 'Spot move since the open %', read: (d, i) => pct(d.spot.c[i], d.spot.o[0]) },
  { key: 'dayRange', group: 'Price', name: "Where spot is in the day's range so far (0 low - 100 high)", read: (d, i) => {
    let hi = -Infinity, lo = Infinity
    for (let k = 0; k <= i; k++) { hi = Math.max(hi, d.spot.h[k]); lo = Math.min(lo, d.spot.l[k]) }
    return hi > lo ? ((d.spot.c[i] - lo) / (hi - lo)) * 100 : NaN
  } },
  { key: 'ib', group: 'Price', name: 'Where price is against the Initial Balance (0 low - 100 high, after 10:15)', read: (d, i) => {
    const ib = d.ib
    return ib && i >= ib.done && ib.high > ib.low ? ((d.price.c[i] - ib.low) / (ib.high - ib.low)) * 100 : NaN
  } },
  // The previous day's volume profile and pivots (known before the open)
  { key: 'prevPoc', group: 'Profile & pivots', name: "Spot vs yesterday's POC %", read: (d, i) => pct(d.spot.c[i], d.prevVp?.poc) },
  { key: 'prevVah', group: 'Profile & pivots', name: "Spot vs yesterday's VAH %", read: (d, i) => pct(d.spot.c[i], d.prevVp?.vah) },
  { key: 'prevVal', group: 'Profile & pivots', name: "Spot vs yesterday's VAL %", read: (d, i) => pct(d.spot.c[i], d.prevVp?.val) },
  { key: 'pivot', group: 'Profile & pivots', name: 'Spot vs the pivot (P) %', read: (d, i) => pct(d.spot.c[i], d.pivots?.p) },
  { key: 'cprWidth', group: 'Profile & pivots', name: 'CPR width % (narrow = trend day more likely)', read: (d) => (fin(d.pivots?.widthPct) ? d.pivots.widthPct : NaN) },
  // TA on the spot candles of the timeframe
  { key: 'rsi', group: 'TA', name: 'RSI 14', read: (d, i) => rsiSeries(d, 14)[i] },
  { key: 'ema9_21', group: 'TA', name: 'EMA 9 over EMA 21 %', read: (d, i) => pct(emaSeries(d, 9)[i], emaSeries(d, 21)[i]) },
  { key: 'ema20', group: 'TA', name: 'Spot vs EMA 20 %', read: (d, i) => pct(d.spot.c[i], emaSeries(d, 20)[i]) },
  // When
  { key: 'minute', group: 'When', name: 'Minutes since 09:15', read: (d, i) => istMinute(d.t[i]) - (9 * 60 + 15) },
  { key: 'expiry', group: 'When', name: "Options' expiry day (1 = yes)", read: (d) => (d.isExpiry ? 1 : 0) },
]

/** What happened after the candle (`key`, its name; `trade` - an option bought there with the page's levels: its return in
 *  % of the entry premium). */
export const LABELS = [
  { key: 'fwd15', name: 'Spot 15 min later %', minutes: 15 },
  { key: 'fwd30', name: 'Spot 30 min later %', minutes: 30 },
  { key: 'fwd60', name: 'Spot 60 min later %', minutes: 60 },
  { key: 'ceBuy', name: 'CE bought there (return %)', trade: 1 },
  { key: 'peBuy', name: 'PE bought there (return %)', trade: -1 },
]

// Spot `minutes` after minute `m` of the 1-minute day: the close of the last minute at or before that time - NaN when the
// day ends first (no label from the next morning).
function spotLater(d1, m, minutes) {
  const target = d1.t[m] + minutes * MIN
  if (target > d1.t[d1.n - 1]) return NaN
  let k = m
  while (k + 1 < d1.n && d1.t[k + 1] <= target) k++
  return d1.spot.c[k]
}

/**
 * The table of one prepared day: a row a candle of the `timeframe` whose last minute is inside the entry window - its
 * features (read at the candle's close) and labels (after it). `levels` - the trade's { slPct, targetPct, levelUnit,
 * trailGap, trailStart, timeStopMin, moneyness, entryFrom, lastEntry } (the page's).
 */
export function dayRows(day, { timeframe = 5, ...levels } = {}) {
  if (!day?.ok) return []
  const d1 = day
  const d = timeframeView(day, timeframe)
  const at = (k) => (d.at ? d.at[k] : k)
  const from = clockMinute(levels.entryFrom) ?? 9 * 60 + 30
  const last = clockMinute(levels.lastEntry) ?? 14 * 60 + 45
  const trade = {
    slPct: levels.slPct ?? 0, targetPct: levels.targetPct ?? 0, levelUnit: levels.levelUnit ?? 'pct',
    trailGap: levels.trailGap ?? 0, trailStart: levels.trailStart ?? 0, timeStopMin: levels.timeStopMin ?? 0, squareOff: levels.squareOff ?? '15:10',
  }
  const rows = []
  for (let k = 0; k < d.n; k++) {
    const m = at(k)
    const minute = istMinute(d1.t[m])
    if (minute < from || minute > last) continue
    const row = { date: d1.date, time: d1.t[m], expiry: Boolean(d1.isExpiry), f: {}, y: {} }
    for (const f of FEATURES) { const v = f.read(d, k); row.f[f.key] = fin(v) ? v : NaN }
    const spot = d1.spot.c[m]
    for (const l of LABELS) {
      if (l.minutes) { row.y[l.key] = pct(spotLater(d1, m, l.minutes), spot); continue }
      const option = optionFor(l.trade, 'buy', d1.atm[m], d1.step, levels.moneyness ?? 0)
      const t = simulateTrade(d1, m, option, trade)
      row.y[l.key] = t && t.entry > 0 ? (t.points / t.entry) * 100 : NaN
    }
    rows.push(row)
  }
  return rows
}

/** Spearman's rank correlation of the pairs (x, y) with both numbers (ties take their average rank); NaN under 10 pairs. */
export function spearman(xs, ys) {
  const pairs = []
  for (let k = 0; k < xs.length; k++) if (fin(xs[k]) && fin(ys[k])) pairs.push([xs[k], ys[k]])
  if (pairs.length < 10) return NaN
  const ranks = (vals) => {
    const order = vals.map((v, k) => [v, k]).sort((a, b) => a[0] - b[0])
    const r = new Float64Array(vals.length)
    for (let s = 0; s < order.length;) {
      let e = s
      while (e + 1 < order.length && order[e + 1][0] === order[s][0]) e++
      const avg = (s + e) / 2 + 1
      for (let q = s; q <= e; q++) r[order[q][1]] = avg
      s = e + 1
    }
    return r
  }
  const rx = ranks(pairs.map((p) => p[0])), ry = ranks(pairs.map((p) => p[1]))
  const n = pairs.length
  const mean = (n + 1) / 2
  let num = 0, dx = 0, dy = 0
  for (let k = 0; k < n; k++) { const a = rx[k] - mean, b = ry[k] - mean; num += a * b; dx += a * a; dy += b * b }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0
}

// The rows' trades in the top / bottom fifth of a feature: how many, their win rate and average return.
function fifths(rows, fkey, ykey) {
  const pairs = rows.map((r) => [r.f[fkey], r.y[ykey]]).filter(([x, y]) => fin(x) && fin(y)).sort((a, b) => a[0] - b[0])
  if (pairs.length < 25) return null
  const cut = Math.floor(pairs.length / 5)
  const stats = (list) => ({ n: list.length, win: (list.filter(([, y]) => y > 0).length / list.length) * 100, avg: list.reduce((a, [, y]) => a + y, 0) / list.length })
  return { low: stats(pairs.slice(0, cut)), high: stats(pairs.slice(pairs.length - cut)), all: stats(pairs), lowMax: pairs[cut - 1][0], highMin: pairs[pairs.length - cut][0] }
}

/** The smallest |correlation| on the later days, with the same sign as on the earlier ones, for a feature to "hold". */
export const HOLD_IC = 0.05
/** The later days' share of the days (the rest - the earlier ones - first). */
export const TEST_SHARE = 1 / 3

/**
 * The report: for every feature and the label `target`, the correlation on the EARLIER days (the first 2/3 of the dates)
 * and on the LATER ones; it HOLDS when both have the same sign and the later one is at least HOLD_IC; `dayAgree` = the
 * share of the later days whose own correlation has the earlier sign (one big day cannot carry it); `fifths` - the trades'
 * win rate in the feature's top and bottom fifth on the later days (a trade label) or the move's average (a spot label).
 * Sorted: what holds first, by the later correlation's size. With under 6 days there is no honest split - every day is
 * in both, `split: false`.
 */
export function featureReport(rows, target = 'fwd30') {
  const dates = [...new Set(rows.map((r) => r.date))].sort()
  const split = dates.length >= 6
  const firstLater = split ? dates[Math.floor(dates.length * (1 - TEST_SHARE))] : null
  const early = split ? rows.filter((r) => r.date < firstLater) : rows
  const later = split ? rows.filter((r) => r.date >= firstLater) : rows
  const laterDays = split ? dates.filter((x) => x >= firstLater) : dates
  const out = FEATURES.map((f) => {
    const ic = (list) => spearman(list.map((r) => r.f[f.key]), list.map((r) => r.y[target]))
    const icEarly = ic(early), icLater = ic(later)
    let agree = 0, counted = 0
    for (const day of laterDays) {
      const own = ic(later.filter((r) => r.date === day))
      if (!fin(own) || !fin(icEarly) || own === 0) continue
      counted++
      if (Math.sign(own) === Math.sign(icEarly)) agree++
    }
    const holds = split && fin(icEarly) && fin(icLater) && Math.sign(icEarly) === Math.sign(icLater) && Math.abs(icLater) >= HOLD_IC
    return {
      key: f.key, group: f.group, name: f.name, icEarly, icLater, holds,
      dayAgree: counted ? (agree / counted) * 100 : NaN, days: counted,
      fifths: fifths(later, f.key, target),
      coverage: (later.filter((r) => fin(r.f[f.key])).length / Math.max(1, later.length)) * 100,
    }
  })
  out.sort((a, b) => (b.holds - a.holds) || (Math.abs(b.icLater || 0) - Math.abs(a.icLater || 0)))
  return {
    target, split, days: dates.length, earlyDays: split ? dates.length - laterDays.length : dates.length, laterDays: laterDays.length,
    firstLater, rows: rows.length, earlyRows: early.length, laterRows: later.length, features: out,
  }
}

const cell = (v) => {
  if (typeof v === 'number') return fin(v) ? String(Math.round(v * 10000) / 10000) : ''
  const s = String(v ?? '')
  return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const istClock = (ms) => { const m = istMinute(ms); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` }

/** The table as CSV - date, time, expiry, every feature, every label - for a spreadsheet or your own model. */
export function rowsCsv(rows) {
  const head = ['date', 'time', 'expiry', ...FEATURES.map((f) => f.key), ...LABELS.map((l) => l.key)]
  const lines = [head.join(',')]
  for (const r of rows) lines.push([r.date, istClock(r.time), r.expiry ? 1 : 0, ...FEATURES.map((f) => r.f[f.key]), ...LABELS.map((l) => r.y[l.key])].map(cell).join(','))
  return `${lines.join('\n')}\n`
}

/** The features' names, keys first - the CSV's legend. */
export const featureLegend = () => FEATURES.map((f) => `${f.key}: ${f.name}`).concat(LABELS.map((l) => `${l.key}: ${l.name}`))
