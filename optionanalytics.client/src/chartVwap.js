import { sanitizeLine } from './chartLine.js'

// Session VWAP for a candle chart, on the chart's OWN candles - one point per candle, at the candle's
// time, never anywhere else.
//
// Why this exists: lightweight-charts lays its time axis out from EVERY series' time points. A VWAP
// line with points the candles do not have - 1-minute VWAP on a 5-minute chart, or the server's
// whole in-memory history (several days) on a one-day chart - adds those points to the axis: the
// candles get squeezed into a corner with gaps between them. Aligned to the candles, VWAP adds none.
//
// Times are chart times (seconds, already shifted to IST - see shared.jsx toChartTime), so the IST
// trading day of a candle is floor(time / 86400); the VWAP restarts every day.

const DAY = 86400
const dayOf = (chartTime) => Math.floor(chartTime / DAY)
const volumeOf = (b) => b.volume ?? (b.buy != null || b.sell != null ? (b.buy ?? 0) + (b.sell ?? 0) : null)

/** VWAP from the candles themselves: cumulative (typical price x volume) / cumulative volume, typical
 *  price = (high + low + close) / 3, restarting each IST day. No point before a day's first volume.
 *  Null when no candle carries volume (the caller then aligns the server's VWAP instead). */
export function sessionVwapFromBars(bars) {
  if (!bars?.length || !bars.some((b) => volumeOf(b) > 0)) return null
  const out = []
  let day = null
  let pv = 0
  let vol = 0
  for (const b of bars) {
    const d = dayOf(b.time)
    if (d !== day) { day = d; pv = 0; vol = 0 }
    const v = volumeOf(b) ?? 0
    if (v > 0 && b.high > 0 && b.low > 0 && b.close > 0) {
      pv += ((b.high + b.low + b.close) / 3) * v
      vol += v
    }
    if (vol > 0) out.push({ time: b.time, value: pv / vol })
  }
  return out
}

/** A VWAP series (any cadence, any span) moved onto the candles: for each candle, the last VWAP
 *  point from its start up to the next candle's start (the last candle: up to now), at the candle's
 *  time. Points before the first candle or in a candle with none are dropped - so the line never adds
 *  a time point the candles do not have. */
export function alignToBars(series, bars) {
  if (!series?.length || !bars?.length) return []
  const points = [...series].sort((a, b) => a.time - b.time)
  const out = []
  let j = 0
  for (let i = 0; i < bars.length; i++) {
    const start = bars[i].time
    const end = i + 1 < bars.length ? bars[i + 1].time : Infinity
    let value = null
    while (j < points.length && points[j].time < end) {
      // Only the same IST day: the last candle of a day must not take tomorrow's first VWAP.
      if (points[j].time >= start && dayOf(points[j].time) === dayOf(start) && Number.isFinite(points[j].value) && points[j].value > 0) value = points[j].value
      j++
    }
    if (value != null) out.push({ time: start, value })
  }
  return out
}

/** The VWAP line for a candle chart: from its own candles when they carry volume, else the given
 *  server series aligned to them. */
export function chartVwap(bars, serverSeries = null) {
  return sanitizeLine(sessionVwapFromBars(bars) ?? alignToBars(serverSeries ?? [], bars))
}

// ---- VWAP standard deviation bands (asked for - "vwap +2 deviation ... visible only when it is ticked") --------------
// The standard VWAP bands (TradingView's built-in VWAP "Bands Multiplier", Sierra Chart, the brokers' charts): the
// session's VOLUME-WEIGHTED standard deviation of the typical price about the VWAP - sd = sqrt(sum(v x tp^2) / sum(v) -
// VWAP^2) - and the bands VWAP +/- k x sd, restarting with the VWAP each IST day.

export const VWAP_BAND_K = 2

/** Each candle's session VWAP and its volume-weighted standard deviation, from the candles' own volume
 *  ({ time, vwap, sd }); null when no candle carries volume. Same points as sessionVwapFromBars. */
export function sessionVwapSdFromBars(bars) {
  if (!bars?.length || !bars.some((b) => volumeOf(b) > 0)) return null
  const out = []
  let day = null
  let pv = 0
  let pv2 = 0
  let vol = 0
  for (const b of bars) {
    const d = dayOf(b.time)
    if (d !== day) { day = d; pv = 0; pv2 = 0; vol = 0 }
    const v = volumeOf(b) ?? 0
    if (v > 0 && b.high > 0 && b.low > 0 && b.close > 0) {
      const tp = (b.high + b.low + b.close) / 3
      pv += tp * v
      pv2 += tp * tp * v
      vol += v
    }
    if (vol > 0) {
      const vwap = pv / vol
      out.push({ time: b.time, vwap, sd: Math.sqrt(Math.max(0, pv2 / vol - vwap * vwap)) })
    }
  }
  return out
}

/** { upper, lower } lines, VWAP +/- k x sd, from { time, vwap, sd } points. */
export function vwapBandLines(points, k = VWAP_BAND_K) {
  const upper = []
  const lower = []
  for (const p of points ?? []) {
    if (!Number.isFinite(p.vwap) || !Number.isFinite(p.sd) || p.vwap <= 0) continue
    upper.push({ time: p.time, value: p.vwap + k * p.sd })
    lower.push({ time: p.time, value: p.vwap - k * p.sd })
  }
  return { upper, lower }
}

/** The server's VWAP and deviation series (the same times) joined into { time, vwap, sd } points. */
export function joinVwapSd(vwapSeries, sdSeries) {
  const sdAt = new Map((sdSeries ?? []).map((p) => [p.time, p.value]))
  return (vwapSeries ?? []).filter((p) => sdAt.has(p.time)).map((p) => ({ time: p.time, vwap: p.value, sd: sdAt.get(p.time) }))
}

const NO_BANDS = { upper: [], lower: [] }

/** The bands for a candle chart, on its own candles (as chartVwap): from the candles' own volume when they carry it,
 *  else the server's VWAP / deviation series aligned to them. */
export function chartVwapBands(bars, vwapSeries = null, sdSeries = null, k = VWAP_BAND_K) {
  if (!bars?.length) return NO_BANDS
  const own = sessionVwapSdFromBars(bars)
  if (own) {
    const lines = vwapBandLines(own, k)
    return { upper: sanitizeLine(lines.upper), lower: sanitizeLine(lines.lower) }
  }
  const lines = vwapBandLines(joinVwapSd(vwapSeries, sdSeries), k)
  return { upper: sanitizeLine(alignToBars(lines.upper, bars)), lower: sanitizeLine(alignToBars(lines.lower, bars)) }
}
