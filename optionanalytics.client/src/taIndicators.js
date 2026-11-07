// The common technical indicators over a series of candles, as TradingView's built-ins work them out (Pine's ta.*): each
// value at candle k from candles 0..k only (no look-ahead), NaN until it has the candles it needs. Pure - arrays in,
// Float64Arrays out. The Feature finder reads them on the spot candles of the timeframe (featureFinder.js); EMA and RSI are
// signalBacktest.js' own (emaOver / rsiOver - the rule builder's), reused here.
//
//   sma / rma            simple / Wilder's moving average (rma: alpha 1/len, started at the simple average - ta.rma)
//   macd                 EMA(fast) - EMA(slow), its signal EMA and the histogram (ta.macd, 12 / 26 / 9)
//   stochastic           %K = SMA(smoothK) of 100 (close - lowest low) / (highest high - lowest low), %D its SMA (ta.stoch)
//   cci                  (hlc3 - SMA) / (0.015 x mean absolute deviation) (ta.cci on hlc3)
//   bollinger            SMA(len) +- mult x population standard deviation: %B and the band width in % of the middle
//   atr                  Wilder's average of the true range (ta.atr - the first candle's true range is its high - low)
//   dmi                  +DI, -DI and ADX (ta.dmi - Wilder's averages from the second candle)
//   supertrend           ATR bands around hl2 that only tighten, the direction flipping when the close crosses one
//                        (ta.supertrend; here +1 = up, the line under price - TradingView writes it -1)

import { emaOver } from './signalBacktest.js'

const nan = (n) => new Float64Array(n).fill(NaN)
const fin = Number.isFinite

/** The simple average of the last `len` values (NaN while any of them is). */
export function sma(values, len) {
  const out = nan(values.length)
  let sum = 0, count = 0
  for (let k = 0; k < values.length; k++) {
    if (fin(values[k])) { sum += values[k]; count++ } else { sum = 0; count = 0; continue }
    if (count > len) { sum -= values[k - len]; count = len }
    if (count === len) out[k] = sum / len
  }
  return out
}

/** Wilder's moving average (ta.rma): from the first finite value, the simple average of the first `len`, then
 *  (previous x (len - 1) + value) / len. */
export function rma(values, len) {
  const out = nan(values.length)
  const start = Array.prototype.findIndex.call(values, fin)
  if (start < 0) return out
  let sum = 0, e = NaN
  for (let k = start; k < values.length; k++) {
    const v = fin(values[k]) ? values[k] : 0
    if (k - start < len) {
      sum += v
      if (k - start === len - 1) out[k] = e = sum / len
      continue
    }
    e = (e * (len - 1) + v) / len
    out[k] = e
  }
  return out
}

// An indicator of values that start NaN, worked out from the first finite one on.
function fromFirst(values, fn) {
  const out = nan(values.length)
  const start = Array.prototype.findIndex.call(values, fin)
  if (start >= 0) out.set(fn(values.subarray ? values.subarray(start) : values.slice(start)), start)
  return out
}

/** MACD (ta.macd): { macd, signal, hist } - EMA(fast) - EMA(slow) of `close`, the signal the EMA(signalLen) of it. */
export function macd(close, fast = 12, slow = 26, signalLen = 9) {
  const f = emaOver(close, fast), s = emaOver(close, slow)
  const line = nan(close.length)
  for (let k = 0; k < close.length; k++) if (fin(f[k]) && fin(s[k])) line[k] = f[k] - s[k]
  const signal = fromFirst(line, (x) => emaOver(x, signalLen))
  const hist = nan(close.length)
  for (let k = 0; k < close.length; k++) if (fin(line[k]) && fin(signal[k])) hist[k] = line[k] - signal[k]
  return { macd: line, signal, hist }
}

// The highest / lowest of the last `len` values.
function windowExtreme(values, len, pick) {
  const out = nan(values.length)
  for (let k = len - 1; k < values.length; k++) {
    let x = values[k]
    for (let j = k - len + 1; j < k; j++) x = pick(x, values[j])
    out[k] = x
  }
  return out
}

/** The stochastic oscillator (ta.stoch, 14 / 3 / 3): { k, d } - %K the SMA(smoothK) of the raw 100 (c - LL) / (HH - LL),
 *  %D the SMA(smoothD) of %K; a flat window (HH = LL) has no raw value. */
export function stochastic(high, low, close, len = 14, smoothK = 3, smoothD = 3) {
  const hh = windowExtreme(high, len, Math.max), ll = windowExtreme(low, len, Math.min)
  const raw = nan(close.length)
  for (let k = 0; k < close.length; k++) if (fin(hh[k]) && hh[k] > ll[k]) raw[k] = (100 * (close[k] - ll[k])) / (hh[k] - ll[k])
  const k = sma(raw, smoothK)
  return { k, d: sma(k, smoothD) }
}

/** The commodity channel index (ta.cci on hlc3, 20): (tp - SMA(tp)) / (0.015 x the mean absolute deviation from it). */
export function cci(high, low, close, len = 20) {
  const n = close.length
  const tp = new Float64Array(n)
  for (let k = 0; k < n; k++) tp[k] = (high[k] + low[k] + close[k]) / 3
  const mean = sma(tp, len)
  const out = nan(n)
  for (let k = len - 1; k < n; k++) {
    if (!fin(mean[k])) continue
    let dev = 0
    for (let j = k - len + 1; j <= k; j++) dev += Math.abs(tp[j] - mean[k])
    dev /= len
    out[k] = dev > 0 ? (tp[k] - mean[k]) / (0.015 * dev) : 0
  }
  return out
}

/** Bollinger bands (20, 2 - the population standard deviation, as ta.stdev): { mid, upper, lower, pctB, width } - %B =
 *  (close - lower) / (upper - lower), width = (upper - lower) / mid x 100. */
export function bollinger(close, len = 20, mult = 2) {
  const n = close.length
  const mid = sma(close, len)
  const upper = nan(n), lower = nan(n), pctB = nan(n), width = nan(n)
  for (let k = len - 1; k < n; k++) {
    if (!fin(mid[k])) continue
    let sq = 0
    for (let j = k - len + 1; j <= k; j++) sq += (close[j] - mid[k]) ** 2
    const sd = Math.sqrt(sq / len)
    upper[k] = mid[k] + mult * sd
    lower[k] = mid[k] - mult * sd
    if (upper[k] > lower[k]) pctB[k] = (close[k] - lower[k]) / (upper[k] - lower[k])
    if (mid[k] !== 0) width[k] = ((upper[k] - lower[k]) / mid[k]) * 100
  }
  return { mid, upper, lower, pctB, width }
}

// The true range: the largest of the candle's range and its high / low from the close before (`firstHasRange` - the
// first candle's is its high - low, as ta.tr(true); else none, as ta.tr(false)).
function trueRange(high, low, close, firstHasRange) {
  const n = close.length
  const tr = nan(n)
  for (let k = 0; k < n; k++) {
    if (k === 0) { if (firstHasRange) tr[k] = high[k] - low[k]; continue }
    tr[k] = Math.max(high[k] - low[k], Math.abs(high[k] - close[k - 1]), Math.abs(low[k] - close[k - 1]))
  }
  return tr
}

/** The average true range (ta.atr, 14): Wilder's average of the true range. */
export function atr(high, low, close, len = 14) {
  return rma(trueRange(high, low, close, true), len)
}

/** The directional movement index (ta.dmi, 14 / 14): { plus, minus, adx } - +DI / -DI = 100 x Wilder's average of +DM /
 *  -DM over that of the true range (from the second candle), ADX = Wilder's average of 100 |+DI - -DI| / (+DI + -DI). */
export function dmi(high, low, close, len = 14, adxLen = 14) {
  const n = close.length
  const plusDm = nan(n), minusDm = nan(n)
  for (let k = 1; k < n; k++) {
    const up = high[k] - high[k - 1], down = low[k - 1] - low[k]
    plusDm[k] = up > down && up > 0 ? up : 0
    minusDm[k] = down > up && down > 0 ? down : 0
  }
  const tr = rma(trueRange(high, low, close, false), len)
  const p = rma(plusDm, len), m = rma(minusDm, len)
  const plus = nan(n), minus = nan(n), dx = nan(n)
  for (let k = 0; k < n; k++) {
    if (!(tr[k] > 0)) continue
    plus[k] = (100 * p[k]) / tr[k]
    minus[k] = (100 * m[k]) / tr[k]
    const sum = plus[k] + minus[k]
    dx[k] = (100 * Math.abs(plus[k] - minus[k])) / (sum === 0 ? 1 : sum)
  }
  return { plus, minus, adx: rma(dx, adxLen) }
}

/** SuperTrend (ta.supertrend, factor 3, ATR 10): { line, dir } - bands hl2 +- factor x ATR that only tighten (the lower one
 *  rises unless the close before fell under it, the upper one falls unless the close before rose over it); `dir` +1 = up
 *  (the line is the lower band, under price), -1 = down (the upper band) - it starts down, at the first ATR. */
export function supertrend(high, low, close, factor = 3, atrLen = 10) {
  const n = close.length
  const a = atr(high, low, close, atrLen)
  const line = nan(n), dir = nan(n)
  let lower = NaN, upper = NaN, prevLine = NaN
  for (let k = 0; k < n; k++) {
    if (!fin(a[k])) continue
    const src = (high[k] + low[k]) / 2
    const lowRaw = src - factor * a[k], upRaw = src + factor * a[k]
    const first = !fin(lower)
    const prevLower = lower, prevUpper = upper
    lower = first || lowRaw > prevLower || close[k - 1] < prevLower ? lowRaw : prevLower
    upper = first || upRaw < prevUpper || close[k - 1] > prevUpper ? upRaw : prevUpper
    let d
    if (first) d = -1
    else if (prevLine === prevUpper) d = close[k] > upper ? 1 : -1
    else d = close[k] < lower ? -1 : 1
    dir[k] = d
    line[k] = prevLine = d === 1 ? lower : upper
  }
  return { line, dir }
}
