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

import { clockMinute, emaSeries, istMinute, optionFor, premiumCandles, premiumRsi, rsiSeries, simulateTrade, timeframeView } from './signalBacktest.js'
import { atr, bollinger, cci, dmi, macd, stochastic, supertrend } from './taIndicators.js'

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

// The TECHNICAL INDICATORS of the spot candles of the view (taIndicators.js - TradingView's definitions): run on from the
// previous session's candles of the same timeframe (`prevDay` - its minutes put into candles from 09:15, as the rule
// builder's RSI / EMAs warm up) when they are loaded, else from the day's first candle. Each worked out once a view; a
// value at candle k from candles up to k only. `at(name, k)` - the value at the day's candle k (NaN before it has one).
const SESSION_FIRST = 9 * 60 + 15
const TA = new WeakMap()
function ta(d) {
  let kept = TA.get(d)
  if (kept) return kept
  const tf = d.tf ?? 1
  const ph = [], pl = [], pc = []
  const prev = d.prevDay
  if (prev?.t?.length && prev.h?.length === prev.t.length && prev.l?.length === prev.t.length) {
    let bucket = null
    prev.t.forEach((ms, k) => {
      const b = Math.floor((istMinute(ms) - SESSION_FIRST) / tf)
      if (b !== bucket) { ph.push(prev.h[k]); pl.push(prev.l[k]); pc.push(prev.c[k]); bucket = b; return }
      const j = pc.length - 1
      ph[j] = Math.max(ph[j], prev.h[k]); pl[j] = Math.min(pl[j], prev.l[k]); pc[j] = prev.c[k]
    })
  }
  const warm = pc.length
  const H = Float64Array.from([...ph, ...d.spot.h]), L = Float64Array.from([...pl, ...d.spot.l]), C = Float64Array.from([...pc, ...d.spot.c])
  const m = macd(C), st = stochastic(H, L, C), bb = bollinger(C), di = dmi(H, L, C), sup = supertrend(H, L, C)
  const series = {
    macd: m.macd, macdHist: m.hist, stochK: st.k, stochD: st.d, cci: cci(H, L, C), bbPctB: bb.pctB, bbWidth: bb.width,
    atr: atr(H, L, C), plusDi: di.plus, minusDi: di.minus, adx: di.adx, stLine: sup.line, stDir: sup.dir,
  }
  kept = { at: (name, k) => series[name][warm + k] ?? NaN }
  TA.set(d, kept)
  return kept
}
const ofPrice = (v, price) => (fin(v) && price > 0 ? (v / price) * 100 : NaN)
// The ATM strike's premium (`side` 'ce' / 'pe') at candle k: its own candles, VWAP and RSI (the rule builder's premium TA).
const premium = (d, side, k) => premiumCandles(d, side, d.atm[k])

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
  { key: 'vwapZ', group: 'Price', name: 'Price vs VWAP in standard deviations (the VWAP bands, futures)', read: (d, i) => {
    const sd = d.vwapSd?.[i]
    return sd > 0 && fin(d.vwap?.[i]) ? (d.price.c[i] - d.vwap[i]) / sd : NaN
  } },
  { key: 'relVolume', group: 'Price', name: "The candle's volume vs the day's average candle so far (futures)", read: (d, i) => {
    const v = d.price?.v
    if (!v) return NaN
    let sum = 0
    for (let k = 0; k <= i; k++) sum += v[k]
    return sum > 0 ? v[i] / (sum / (i + 1)) : NaN
  } },
  { key: 'basis', group: 'Price', name: 'Futures over spot % (the basis)', read: (d, i) => (d.priceSource === 'futures' ? pct(d.price.c[i], d.spot.c[i]) : NaN) },
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
  { key: 'gap', group: 'Profile & pivots', name: "Today's open vs yesterday's close % (the gap)", read: (d) => pct(d.spot.o[0], d.prevDay?.close) },
  { key: 'prevRange', group: 'Profile & pivots', name: "Where spot is in yesterday's range (0 its low - 100 its high)", read: (d, i) => {
    const p = d.prevDay
    return p && p.high > p.low ? ((d.spot.c[i] - p.low) / (p.high - p.low)) * 100 : NaN
  } },
  // The ATM options' own premiums (the strike nearest spot at the candle)
  { key: 'cePremVwap', group: 'Options', name: 'ATM CE premium vs its own VWAP %', read: (d, i) => { const p = premium(d, 'ce', i); return pct(p.c[i], p.vwap[i]) } },
  { key: 'pePremVwap', group: 'Options', name: 'ATM PE premium vs its own VWAP %', read: (d, i) => { const p = premium(d, 'pe', i); return pct(p.c[i], p.vwap[i]) } },
  { key: 'cePremRsi', group: 'Options', name: 'ATM CE premium RSI 14', read: (d, i) => premiumRsi(d, 'ce', d.atm[i], 14)[i] },
  { key: 'pePremRsi', group: 'Options', name: 'ATM PE premium RSI 14', read: (d, i) => premiumRsi(d, 'pe', d.atm[i], 14)[i] },
  { key: 'straddle15', group: 'Options', name: 'ATM straddle: change over 15 min %', read: (d, i) => pct(d.straddle?.[i]?.value, d.straddle?.[back(d, i, 15)]?.value) },
  // TA on the spot candles of the timeframe
  { key: 'rsi', group: 'TA', name: 'RSI 14', read: (d, i) => rsiSeries(d, 14)[i] },
  { key: 'ema9_21', group: 'TA', name: 'EMA 9 over EMA 21 %', read: (d, i) => pct(emaSeries(d, 9)[i], emaSeries(d, 21)[i]) },
  { key: 'ema20', group: 'TA', name: 'Spot vs EMA 20 %', read: (d, i) => pct(d.spot.c[i], emaSeries(d, 20)[i]) },
  { key: 'ema50', group: 'TA', name: 'Spot vs EMA 50 %', read: (d, i) => pct(d.spot.c[i], emaSeries(d, 50)[i]) },
  { key: 'ema200', group: 'TA', name: 'Spot vs EMA 200 % (1 / 3-minute candles - needs 200 of them)', read: (d, i) => pct(d.spot.c[i], emaSeries(d, 200)[i]) },
  { key: 'rsi7', group: 'TA', name: 'RSI 7', read: (d, i) => rsiSeries(d, 7)[i] },
  { key: 'macd', group: 'TA', name: 'MACD (12, 26) line, % of price', read: (d, i) => ofPrice(ta(d).at('macd', i), d.spot.c[i]) },
  { key: 'macdHist', group: 'TA', name: 'MACD histogram (line − signal 9), % of price', read: (d, i) => ofPrice(ta(d).at('macdHist', i), d.spot.c[i]) },
  { key: 'macdHistChange', group: 'TA', name: 'MACD histogram: change from the candle before, % of price', read: (d, i) => ofPrice(ta(d).at('macdHist', i) - ta(d).at('macdHist', i - 1), d.spot.c[i]) },
  { key: 'stochK', group: 'TA', name: 'Stochastic %K (14, 3)', read: (d, i) => ta(d).at('stochK', i) },
  { key: 'stochD', group: 'TA', name: 'Stochastic %D (14, 3, 3)', read: (d, i) => ta(d).at('stochD', i) },
  { key: 'cci', group: 'TA', name: 'CCI 20', read: (d, i) => ta(d).at('cci', i) },
  { key: 'bbPctB', group: 'TA', name: 'Bollinger %B (20, 2) - 0 lower band, 1 upper', read: (d, i) => ta(d).at('bbPctB', i) },
  { key: 'bbWidth', group: 'TA', name: 'Bollinger band width % (a squeeze is low)', read: (d, i) => ta(d).at('bbWidth', i) },
  { key: 'atrPct', group: 'TA', name: 'ATR 14, % of price', read: (d, i) => ofPrice(ta(d).at('atr', i), d.spot.c[i]) },
  { key: 'adx', group: 'TA', name: 'ADX 14 (trend strength)', read: (d, i) => ta(d).at('adx', i) },
  { key: 'diSpread', group: 'TA', name: '+DI − −DI (14)', read: (d, i) => ta(d).at('plusDi', i) - ta(d).at('minusDi', i) },
  { key: 'superTrend', group: 'TA', name: 'SuperTrend (10, 3): +1 up, −1 down', read: (d, i) => ta(d).at('stDir', i) },
  { key: 'superTrendDist', group: 'TA', name: 'Spot vs the SuperTrend line %', read: (d, i) => pct(d.spot.c[i], ta(d).at('stLine', i)) },
  { key: 'candleBody', group: 'TA', name: "The candle's body in its range (−1 all red … +1 all green)", read: (d, i) => {
    const r = d.spot.h[i] - d.spot.l[i]
    return r > 0 ? (d.spot.c[i] - d.spot.o[i]) / r : 0
  } },
  { key: 'candleRange', group: 'TA', name: "The candle's range, % of price", read: (d, i) => ofPrice(d.spot.h[i] - d.spot.l[i], d.spot.c[i]) },
  // When
  { key: 'minute', group: 'When', name: 'Minutes since 09:15', read: (d, i) => istMinute(d.t[i]) - (9 * 60 + 15) },
  { key: 'expiry', group: 'When', name: "Options' expiry day (1 = yes)", read: (d) => (d.isExpiry ? 1 : 0) },
  { key: 'daysToExpiry', group: 'When', name: "Days to the options' expiry", read: (d) => (d.expiry ? (Date.parse(`${d.expiry}T00:00:00Z`) - Date.parse(`${d.date}T00:00:00Z`)) / 864e5 : NaN) },
  { key: 'weekday', group: 'When', name: 'Day of the week (1 Monday - 5 Friday)', read: (d) => new Date(`${d.date}T00:00:00Z`).getUTCDay() },
]

/** What happened after the candle (`key`, its name): spot `minutes` later; the highest / lowest spot in the next `extreme`
 *  minutes (`up` - the high); `trade` - an option BOUGHT or SOLD there with the page's levels (the backtest's own trade,
 *  `optionFor(dir, mode)` - a sold PE is the bullish sell): its return in % of the entry premium, a sale's positive when the
 *  premium fell. */
export const LABELS = [
  { key: 'fwd15', name: 'Spot 15 min later %', minutes: 15 },
  { key: 'fwd30', name: 'Spot 30 min later %', minutes: 30 },
  { key: 'fwd60', name: 'Spot 60 min later %', minutes: 60 },
  { key: 'ceBuy', name: 'CE bought there (return %)', trade: { dir: 1, mode: 'buy' } },
  { key: 'peBuy', name: 'PE bought there (return %)', trade: { dir: -1, mode: 'buy' } },
  { key: 'ceSell', name: 'CE sold there (return %)', trade: { dir: -1, mode: 'sell' } },
  { key: 'peSell', name: 'PE sold there (return %)', trade: { dir: 1, mode: 'sell' } },
  { key: 'up30', name: 'Highest spot in the next 30 min %', extreme: 30, up: true },
  { key: 'down30', name: 'Lowest spot in the next 30 min %', extreme: 30, up: false },
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
// The highest high (`up`) / lowest low of spot over the minutes after `m` up to `minutes` later - NaN when the day ends first.
function spotExtreme(d1, m, minutes, up) {
  const target = d1.t[m] + minutes * MIN
  if (target > d1.t[d1.n - 1]) return NaN
  let x = up ? -Infinity : Infinity
  for (let k = m + 1; k < d1.n && d1.t[k] <= target; k++) x = up ? Math.max(x, d1.spot.h[k]) : Math.min(x, d1.spot.l[k])
  return fin(x) ? x : NaN
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
      if (l.extreme) { row.y[l.key] = pct(spotExtreme(d1, m, l.extreme, l.up), spot); continue }
      const option = optionFor(l.trade.dir, l.trade.mode, d1.atm[m], d1.step, levels.moneyness ?? 0)
      const t = simulateTrade(d1, m, option, trade)
      row.y[l.key] = t && t.entry > 0 ? (t.points / t.entry) * 100 : NaN
    }
    rows.push(row)
  }
  return rows
}

/** Spearman's rank correlation of the pairs (x, y) with both numbers (ties take their average rank); NaN under 10 pairs.
 *  Typed arrays throughout - a background run's later days are 150 000+ pairs a feature. */
export function spearman(xs, ys) {
  const X = new Float64Array(xs.length), Y = new Float64Array(xs.length)
  let n = 0
  for (let k = 0; k < xs.length; k++) if (fin(xs[k]) && fin(ys[k])) { X[n] = xs[k]; Y[n] = ys[k]; n++ }
  if (n < 10) return NaN
  const rx = ranks(X.subarray(0, n)), ry = ranks(Y.subarray(0, n))
  const mean = (n + 1) / 2
  let num = 0, dx = 0, dy = 0
  for (let k = 0; k < n; k++) { const a = rx[k] - mean, b = ry[k] - mean; num += a * b; dx += a * a; dy += b * b }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0
}
// 1-based ranks, ties their average rank.
function ranks(vals) {
  const n = vals.length
  const order = new Uint32Array(n)
  for (let k = 0; k < n; k++) order[k] = k
  order.sort((a, b) => vals[a] - vals[b])
  const r = new Float64Array(n)
  for (let s = 0; s < n;) {
    let e = s
    while (e + 1 < n && vals[order[e + 1]] === vals[order[s]]) e++
    const avg = (s + e) / 2 + 1
    for (let q = s; q <= e; q++) r[order[q]] = avg
    s = e + 1
  }
  return r
}

// The trades in the top / bottom fifth of a feature (`xs` / `ys` - a column each): how many, their win rate and average
// return - the pairs with both numbers, in a stable sort by the feature.
function fifths(xs, ys) {
  const idx = []
  for (let k = 0; k < xs.length; k++) if (fin(xs[k]) && fin(ys[k])) idx.push(k)
  if (idx.length < 25) return null
  idx.sort((a, b) => xs[a] - xs[b])
  const cut = Math.floor(idx.length / 5)
  const stats = (list) => {
    let wins = 0, sum = 0
    for (const k of list) { if (ys[k] > 0) wins++; sum += ys[k] }
    return { n: list.length, win: (wins / list.length) * 100, avg: sum / list.length }
  }
  return { low: stats(idx.slice(0, cut)), high: stats(idx.slice(idx.length - cut)), all: stats(idx), lowMax: xs[idx[cut - 1]], highMin: xs[idx[idx.length - cut]] }
}

/** The smallest |correlation| on the later days, with the same sign as on the earlier ones, for a feature to "hold". */
export const HOLD_IC = 0.05
/** The later days' share of the days (the rest - the earlier ones - first). */
export const TEST_SHARE = 1 / 3

/** One day's rows as COLUMNS - { date, n, f: { key: Float64Array }, y: { key: Float64Array } }, in the rows' order: what
 *  the report reads. A background run keeps only these (8 bytes a number - 1 500 days of 1-minute rows as objects did not
 *  fit), the page makes them from its rows (`dayTables`). */
export function dayTable(date, rows) {
  const col = (pick) => Float64Array.from(rows, pick)
  return {
    date, n: rows.length,
    f: Object.fromEntries(FEATURES.map((f) => [f.key, col((r) => r.f[f.key])])),
    y: Object.fromEntries(LABELS.map((l) => [l.key, col((r) => r.y[l.key])])),
  }
}
/** Rows (any order of days) as day tables in date order, each day's rows in their order. */
export function dayTables(rows) {
  const byDate = new Map()
  for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, [])
    byDate.get(r.date).push(r)
  }
  return [...byDate.keys()].sort().map((date) => dayTable(date, byDate.get(date)))
}
// The days' column `kind` ('f' / 'y') `key`, one after the other.
function joined(days, kind, key) {
  let n = 0
  for (const d of days) n += d.n
  const out = new Float64Array(n)
  let at = 0
  for (const d of days) { out.set(d[kind][key], at); at += d.n }
  return out
}

/**
 * The report: for every feature and the label `target`, the correlation on the EARLIER days (the first 2/3 of the dates)
 * and on the LATER ones; it HOLDS when both have the same sign and the later one is at least HOLD_IC; `dayAgree` = the
 * share of the later days whose own correlation has the earlier sign (one big day cannot carry it); `fifths` - the trades'
 * win rate in the feature's top and bottom fifth on the later days (a trade label) or the move's average (a spot label).
 * Sorted: what holds first, by the later correlation's size. With under 6 days there is no honest split - every day is
 * in both, `split: false`. `featureReport(rows)` = `featureReportOfDays(dayTables(rows))`.
 */
export function featureReport(rows, target = 'fwd30') {
  return featureReportOfDays(dayTables(rows), target)
}
/** The report of day tables in date order (`dayTable`). `cache` - the labels' columns joined once, shared by every label's
 *  report; a feature's column is joined when it is read and dropped after (1 500 days of 1-minute rows kept them all
 *  twice over - 800 MB). */
export function featureReportOfDays(days, target = 'fwd30', cache = new Map()) {
  const dates = days.map((d) => d.date)
  const split = dates.length >= 6
  const firstLater = split ? dates[Math.floor(dates.length * (1 - TEST_SHARE))] : null
  const earlyDays = split ? days.filter((d) => d.date < firstLater) : days
  const laterDays = split ? days.filter((d) => d.date >= firstLater) : days
  const column = (part, list, kind, key) => {
    const k = `${part}|${kind}|${key}`
    if (!cache.has(k)) cache.set(k, joined(list, kind, key))
    return cache.get(k)
  }
  const earlyY = column('early', earlyDays, 'y', target), laterY = column('later', laterDays, 'y', target)
  const out = FEATURES.map((f) => {
    const earlyX = joined(earlyDays, 'f', f.key), laterX = joined(laterDays, 'f', f.key)
    const icEarly = spearman(earlyX, earlyY), icLater = spearman(laterX, laterY)
    let agree = 0, counted = 0
    for (const d of laterDays) {
      const own = spearman(d.f[f.key], d.y[target])
      if (!fin(own) || !fin(icEarly) || own === 0) continue
      counted++
      if (Math.sign(own) === Math.sign(icEarly)) agree++
    }
    let filled = 0
    for (let k = 0; k < laterX.length; k++) if (fin(laterX[k])) filled++
    const holds = split && fin(icEarly) && fin(icLater) && Math.sign(icEarly) === Math.sign(icLater) && Math.abs(icLater) >= HOLD_IC
    return {
      key: f.key, group: f.group, name: f.name, icEarly, icLater, holds,
      dayAgree: counted ? (agree / counted) * 100 : NaN, days: counted,
      fifths: fifths(laterX, laterY),
      coverage: (filled / Math.max(1, laterX.length)) * 100,
    }
  })
  out.sort((a, b) => (b.holds - a.holds) || (Math.abs(b.icLater || 0) - Math.abs(a.icLater || 0)))
  return {
    target, split, days: dates.length, earlyDays: split ? dates.length - laterDays.length : dates.length, laterDays: laterDays.length,
    firstLater, rows: earlyY.length + (split ? laterY.length : 0), earlyRows: earlyY.length, laterRows: laterY.length, features: out,
  }
}

/** The report for EVERY label ({ fwd15: featureReport(rows, 'fwd15'), ... }) - what a background Feature finder run keeps,
 *  so its card switches label as the page's does, with nothing worked out again. */
export const featureReports = (rows) => featureReportsOfDays(dayTables(rows))
/** The same from day tables (a background run's), each feature's columns joined once for all the labels. */
export function featureReportsOfDays(days) {
  const cache = new Map()
  return Object.fromEntries(LABELS.map((l) => [l.key, featureReportOfDays(days, l.key, cache)]))
}

const cell = (v) => {
  if (typeof v === 'number') return fin(v) ? String(Math.round(v * 10000) / 10000) : ''
  const s = String(v ?? '')
  return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const istClock = (ms) => { const m = istMinute(ms); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` }

/** The table as CSV - date, time, every feature (the expiry day one of them), every label - for a spreadsheet or your own
 *  model. One column a name: an `expiry` column of the row's own beside the `expiry` feature came out twice. */
export function rowsCsv(rows) {
  return `${csvHeader()}${csvLines(rows)}`
}
/** The CSV's header line (with its newline). */
export const csvHeader = () => `${['date', 'time', ...FEATURES.map((f) => f.key), ...LABELS.map((l) => l.key)].join(',')}\n`
/** The CSV's lines for `rows` (each with its newline) - a background run writes a day's at a time. */
export function csvLines(rows) {
  let out = ''
  for (const r of rows) out += `${[r.date, istClock(r.time), ...FEATURES.map((f) => r.f[f.key]), ...LABELS.map((l) => r.y[l.key])].map(cell).join(',')}\n`
  return out
}

/** The features' names, keys first - the CSV's legend. */
export const featureLegend = () => FEATURES.map((f) => `${f.key}: ${f.name}`).concat(LABELS.map((l) => `${l.key}: ${l.name}`))
