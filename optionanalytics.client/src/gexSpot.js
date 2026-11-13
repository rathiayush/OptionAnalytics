// OI Replay's "GEX levels on spot" card (GexSpotCard.jsx; asked for - "on OI Replay show the GEX levels with the spot
// chart"): the spot candles with the day's GEX levels drawn THROUGH the day as each was at that candle - the call wall,
// the put wall, max gamma and the gamma flip (gex.js gexDay's, under the Sign picked) - and the net GEX's regime under
// the candles (dealers long gamma green / short gamma red). Pure, so it is tested: a candle reads the GEX minute at its
// LAST minute (or the clock, whichever is earlier) - never a later one.

const MIN = 60_000

/** The levels drawn, in the GEX card's colours (call wall green, put wall red, flip yellow, max gamma purple). */
export const GEX_SPOT_LINES = [
  { key: 'callWall', title: 'Call wall', short: 'CW', color: '#26a69a', width: 2, style: 0 },
  { key: 'putWall', title: 'Put wall', short: 'PW', color: '#ef5350', width: 2, style: 0 },
  { key: 'maxGamma', title: 'Max gamma', short: 'Max γ', color: '#b37feb', width: 1, style: 2 },
  { key: 'flip', title: 'Gamma flip', short: 'Flip', color: '#ffd54f', width: 1, style: 1 },
]
export const GEX_SPOT_KEYS = GEX_SPOT_LINES.map((l) => l.key)
export const GEX_SPOT_TIMEFRAMES = [1, 3, 5, 15]

/** 1-minute candles ({ time (chart seconds), open, high, low, close }) into `minutes`-minute candles from 09:15 (chart
 *  time is IST, so the session's minutes are whole multiples). */
export function spotCandles(bars, minutes) {
  if (!(minutes > 1)) return (bars ?? []).map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }))
  const size = minutes * 60
  const out = []
  for (const b of bars ?? []) {
    const t = Math.floor(b.time / size) * size
    const last = out.at(-1)
    if (last?.time === t) { last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close } else out.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close })
  }
  return out
}

/**
 * Each level's line and the regime strip over `candles` (chart time; `minutes` a candle): `minutes` of GEX (gexDay's -
 * `time` in epoch ms) read at each candle's LAST minute - the last GEX minute at or before it and at or before `asOfMs`
 * (the replay clock; null = live, every minute) - so a candle never shows a level from after it. `toMs` turns a candle's
 * chart time into epoch ms. Returns `{ lines: { callWall: [{ time, value? }] ... }, regime: [{ time, value, net }], at }` -
 * a candle with no level has a whitespace point (the line breaks there); `at[i]` the GEX minute candle i read (or null).
 */
export function gexLevelSeries(gexMinutes, candles, minutes, { asOfMs = null, toMs }) {
  const lines = Object.fromEntries(GEX_SPOT_KEYS.map((k) => [k, []]))
  const regime = []
  const at = []
  const list = gexMinutes ?? []
  let j = -1
  for (const c of candles ?? []) {
    let until = toMs(c.time) + (Math.max(1, minutes) - 1) * MIN
    if (asOfMs != null) until = Math.min(until, asOfMs)
    while (j + 1 < list.length && list[j + 1].time <= until) j++
    const m = j >= 0 ? list[j] : null
    at.push(m)
    for (const k of GEX_SPOT_KEYS) {
      const v = m?.[k]
      lines[k].push(Number.isFinite(v) ? { time: c.time, value: v } : { time: c.time })
    }
    if (m && Number.isFinite(m.net)) regime.push({ time: c.time, value: 1, net: m.net })
  }
  return { lines, regime, at }
}

/** Where spot stands against the levels of one GEX minute: `[{ key, title, price, distance (level - spot, points),
 *  pct }]` for each level there is, nearest first; the flip's side says the regime spot is in. */
export function levelsAround(minute) {
  if (!minute || !(minute.spot > 0)) return []
  return GEX_SPOT_LINES
    .filter((l) => Number.isFinite(minute[l.key]))
    .map((l) => ({ key: l.key, title: l.title, color: l.color, price: minute[l.key], distance: minute[l.key] - minute.spot, pct: ((minute[l.key] - minute.spot) / minute.spot) * 100 }))
    .sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance))
}

/** The range the walls fence in at a minute: 'inside' (put wall < spot < call wall), 'above' (over the call wall),
 *  'below' (under the put wall), or null without both walls. */
export function wallRange(minute) {
  if (!minute || !Number.isFinite(minute.callWall) || !Number.isFinite(minute.putWall) || !(minute.spot > 0)) return null
  if (minute.spot > minute.callWall) return 'above'
  if (minute.spot < minute.putWall) return 'below'
  return 'inside'
}
