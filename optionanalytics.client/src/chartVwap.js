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
