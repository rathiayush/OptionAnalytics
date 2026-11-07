// An INDEPENDENT reference for the technical indicators the Feature finder reads - written apart from taIndicators.js, as
// TradingView's Pine scripts read (ta.sma / ta.ema / ta.rma, the built-in MACD, Stoch, CCI, BB, ATR, DMI and SuperTrend
// scripts, their na / nz rules transliterated), naive loops and all - so a mistake in one shows as a disagreement.
const NA = NaN
const na = (v) => !Number.isFinite(v)
const nz = (v) => (na(v) ? 0 : v)

export function smaRef(x, len) {
  return x.map((_, k) => {
    if (k < len - 1) return NA
    let s = 0
    for (let j = k - len + 1; j <= k; j++) { if (na(x[j])) return NA; s += x[j] }
    return s / len
  })
}

// ta.ema: na until `len` values, then started at their sma (Pine's built-in seeds the first value with sma).
export function emaRef(x, len) {
  const out = []
  const alpha = 2 / (len + 1)
  let prev = NA
  for (let k = 0; k < x.length; k++) {
    if (na(prev)) { const s = smaRef(x.slice(0, k + 1), len)[k]; prev = s; out.push(s); continue }
    prev = alpha * x[k] + (1 - alpha) * prev
    out.push(prev)
  }
  return out
}

// ta.rma: sum := na(sum[1]) ? ta.sma(src, length) : alpha * src + (1 - alpha) * nz(sum[1])
export function rmaRef(x, len) {
  const out = []
  const alpha = 1 / len
  const sma = smaRef(x, len)
  let prev = NA
  for (let k = 0; k < x.length; k++) {
    prev = na(prev) ? sma[k] : alpha * x[k] + (1 - alpha) * nz(prev)
    out.push(prev)
  }
  return out
}

export function macd(c, fast = 12, slow = 26, sig = 9) {
  const f = emaRef(c, fast), s = emaRef(c, slow)
  const line = c.map((_, k) => f[k] - s[k])
  // Pine: ta.ema(macd, 9) over a series that is na at first - its sma window starts where the line does.
  const start = line.findIndex((v) => !na(v))
  const signal = line.map(() => NA)
  if (start >= 0) emaRef(line.slice(start), sig).forEach((v, j) => { signal[start + j] = v })
  return { macd: line, signal, hist: line.map((v, k) => v - signal[k]) }
}

const highest = (x, len, k) => (k < len - 1 ? NA : Math.max(...x.slice(k - len + 1, k + 1)))
const lowest = (x, len, k) => (k < len - 1 ? NA : Math.min(...x.slice(k - len + 1, k + 1)))

export function stochastic(h, l, c, len = 14, smoothK = 3, smoothD = 3) {
  const raw = c.map((v, k) => {
    const hh = highest(h, len, k), ll = lowest(l, len, k)
    return na(hh) || hh === ll ? NA : (100 * (v - ll)) / (hh - ll)
  })
  const k = smaRef(raw, smoothK)
  return { k, d: smaRef(k, smoothD) }
}

export function cci(h, l, c, len = 20) {
  const tp = c.map((v, k) => (h[k] + l[k] + v) / 3)
  const ma = smaRef(tp, len)
  return tp.map((v, k) => {
    if (na(ma[k])) return NA
    let dev = 0
    for (let j = k - len + 1; j <= k; j++) dev += Math.abs(tp[j] - ma[k])
    dev /= len
    return dev === 0 ? 0 : (v - ma[k]) / (0.015 * dev)
  })
}

export function bollinger(c, len = 20, mult = 2) {
  const basis = smaRef(c, len)
  const pctB = [], width = []
  for (let k = 0; k < c.length; k++) {
    if (na(basis[k])) { pctB.push(NA); width.push(NA); continue }
    let v = 0
    for (let j = k - len + 1; j <= k; j++) v += (c[j] - basis[k]) ** 2
    const dev = mult * Math.sqrt(v / len)
    const up = basis[k] + dev, lo = basis[k] - dev
    pctB.push(up === lo ? NA : (c[k] - lo) / (up - lo))
    width.push(((up - lo) / basis[k]) * 100)
  }
  return { pctB, width }
}

// ta.tr(handle_na): na(high[1]) ? (handle_na ? high - low : na) : max(high - low, abs(high - close[1]), abs(low - close[1]))
const trRef = (h, l, c, handleNa) => c.map((_, k) => (k === 0 ? (handleNa ? h[0] - l[0] : NA) : Math.max(h[k] - l[k], Math.abs(h[k] - c[k - 1]), Math.abs(l[k] - c[k - 1]))))

// rma over a series that starts na: Pine's sma window starts where the series does.
function rmaFrom(x, len) {
  const start = x.findIndex((v) => !na(v))
  const out = x.map(() => NA)
  if (start >= 0) rmaRef(x.slice(start), len).forEach((v, j) => { out[start + j] = v })
  return out
}

export const atr = (h, l, c, len = 14) => rmaRef(trRef(h, l, c, true), len)

export function dmi(h, l, c, len = 14, adxLen = 14) {
  const plusDm = c.map((_, k) => { if (k === 0) return NA; const up = h[k] - h[k - 1], down = l[k - 1] - l[k]; return up > down && up > 0 ? up : 0 })
  const minusDm = c.map((_, k) => { if (k === 0) return NA; const up = h[k] - h[k - 1], down = l[k - 1] - l[k]; return down > up && down > 0 ? down : 0 })
  const trur = rmaFrom(trRef(h, l, c, false), len)
  const p = rmaFrom(plusDm, len), m = rmaFrom(minusDm, len)
  const plus = c.map((_, k) => (100 * p[k]) / trur[k])
  const minus = c.map((_, k) => (100 * m[k]) / trur[k])
  const dx = c.map((_, k) => { const sum = plus[k] + minus[k]; return (100 * Math.abs(plus[k] - minus[k])) / (sum === 0 ? 1 : sum) })
  return { plus, minus, adx: rmaFrom(dx, adxLen) }
}

// The built-in SuperTrend (Pine's ta.supertrend), its direction turned round: +1 = up.
export function supertrend(h, l, c, factor = 3, atrLen = 10) {
  const a = atr(h, l, c, atrLen)
  const line = [], dir = []
  let lowerPrev = NA, upperPrev = NA, stPrev = NA
  for (let k = 0; k < c.length; k++) {
    const src = (h[k] + l[k]) / 2
    let upper = src + factor * a[k], lower = src - factor * a[k]
    const prevLower = nz(lowerPrev), prevUpper = nz(upperPrev)
    lower = lower > prevLower || c[k - 1] < prevLower ? lower : prevLower
    upper = upper < prevUpper || c[k - 1] > prevUpper ? upper : prevUpper
    let direction
    if (na(a[k - 1])) direction = 1
    else if (stPrev === prevUpper) direction = c[k] > upper ? -1 : 1
    else direction = c[k] < lower ? 1 : -1
    const st = direction === -1 ? lower : upper
    if (na(a[k])) { line.push(NA); dir.push(NA); lowerPrev = NA; upperPrev = NA; stPrev = NA; continue }
    line.push(st); dir.push(-direction)
    lowerPrev = lower; upperPrev = upper; stPrev = st
  }
  return { line, dir }
}
