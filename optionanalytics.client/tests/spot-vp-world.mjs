// Scenario days for the spot + options strategies that read the previous day's SPOT volume profile (#111 - #113,
// spotEngine.js) - shared by spot-strategies-4 (their rules) and spot-strategies-3 (every spot strategy at every scale).
// Written at NIFTY (22,500, step 50) and mapped strike for strike onto BANKNIFTY / SENSEX like spot-strategies-3's.
import { buildOiContext } from '../src/strategyEngine.js'
import { spotBarsOf } from '../src/spotEngine.js'

export const MIN = 60_000
export const T = Date.parse('2026-10-09T03:45:00Z') // 09:15 IST
const iso = (m) => new Date(T + m * MIN).toISOString()
const STRIKES = [22300, 22350, 22400, 22450, 22500, 22550, 22600, 22650, 22700]
export const NIFTY = { base: 22500, step: 50 }
export const BANKNIFTY = { base: 52000, step: 100 }
export const SENSEX = { base: 82000, step: 100 }
export const ramp = (m) => Math.max(0, m - 74) // the 15 minutes before the clock at minute 90

// The previous day's profile: the POC 22560 (a high-volume node 22530-22590), an HVN 22420, the value area 22410 - 22620,
// and ONE thin area - bins 22480 / 22490 / 22500 (the LVN 22490): the zone 22475 - 22505, its middle 22490.
export function vpAt(scale = NIFTY, o = {}) {
  const f = scale.step / 50
  const px = (p) => scale.base + (p - 22500) * f
  const vol = (p) => (Math.abs(p - 22560) <= 30 ? 1000 - 10 * Math.abs(p - 22560) : Math.abs(p - 22420) <= 20 ? 700 : p >= 22480 && p <= 22500 ? (p === 22490 ? 20 : 30) : 300)
  const bins = Array.from({ length: 41 }, (_, i) => 22300 + 10 * i).map((p) => ({ price: px(p), volume: vol(p) }))
  return { poc: px(o.poc ?? 22560), vah: px(o.vah ?? 22620), val: px(22410), hvn: [px(22420), px(22650)], lvn: [px(22490)], bins }
}

/** A day at `scale`: `candle(m)` a spot candle, `ce` / `pe` (k, m) the OI, all in NIFTY terms; `vp` the previous day's. */
export function world({ candle, ce = () => 2e6, pe = () => 2e6, minutes = 91, scale = NIFTY, vp = vpAt(scale) }) {
  const f = scale.step / 50
  const px = (p) => scale.base + (p - 22500) * f
  const spot = Array.from({ length: minutes }, (_, m) => {
    const x = candle(m)
    return { time: iso(m), open: px(x.open), high: px(x.high), low: px(x.low), close: px(x.close) }
  })
  const points = (oiF) => spot.flatMap((_, m) => STRIKES.map((k) => ({ time: iso(m), strike: px(k), openInterest: Math.round(oiF(k, m)), price: 60 * f })))
  const run = { success: true, date: '2026-10-09', step: scale.step, cePoints: points(ce), pePoints: points(pe), futuresBars: [], spotCandlesOneMinute: spot }
  return { oi: buildOiContext(run, null, { live: false }), bars: spotBarsOf(spot), scale, vp }
}

export const c = (open, close, pad = 3) => ({ open, close, high: Math.max(open, close) + pad, low: Math.min(open, close) - pad })
const chop = (level) => (m) => c(level + ((m % 4) - 1.5), level + (((m + 1) % 4) - 1.5))
/** A path in NIFTY terms mirrored about `axis` (a SHORT's day from a LONG's). */
const mirror = (candle, axis) => (m) => { const x = candle(m); return { open: 2 * axis - x.open, close: 2 * axis - x.close, high: 2 * axis - x.low, low: 2 * axis - x.high } }

// #111 LVN refused - LONG: at 22560 until 10:25, down to 22515 by 10:41, then into the thin area (low 22503 under its top
// 22505) and refused: no close past its middle, the 10:44 candle up 22507 -> 22516.
export const lvnRefusedLongCandle = (o = {}) => (m) => (m < 70 ? chop(o.from ?? 22560)(m)
  : m < 87 ? c((o.from ?? 22560) - (m - 70) * ((o.from ?? 22560) - 22515) / 17, (o.from ?? 22560) - (m - 69) * ((o.from ?? 22560) - 22515) / 17, 2)
    : m === 87 ? c(22515, 22511) : m === 88 ? (o.accepted ? c(22511, 22486) : c(22511, 22508)) : m === 89 ? (o.noTurn ? c(22516, 22507, 4) : c(22507, 22516, 4)) : c(22516, 22516))
export const lvnRefusedLong = (o = {}) => world({ candle: lvnRefusedLongCandle(o), ...o })
export const lvnRefusedShort = (o = {}) => world({ candle: mirror(lvnRefusedLongCandle(o), 22490), ...o })

// #112 LVN filled fast - LONG: under the thin area at 22455-22458, then the 10:44 candle runs 22466 -> 22496, past its
// middle (22490) - target the next volume node beyond it, the POC 22560.
export const lvnFillLongCandle = (o = {}) => (m) => (m < 89 ? chop(o.before ?? 22457)(m) : m === 89 ? (o.slow ? c(22488, 22496, 2) : c(22466, o.close ?? 22496, 2)) : c(22496, 22496))
export const lvnFillLong = (o = {}) => world({ candle: lvnFillLongCandle(o), ...o })
export const lvnFillShort = (o = {}) => world({ candle: mirror(lvnFillLongCandle(o), 22490), ...o })

// #113 POC rejection - SHORT: at 22490 until 10:35, a fast run up into the POC 22560 (high 22562 at 10:43), no close above
// it, and the 10:44 candle turns down 22558 -> 22548.
export const pocRejectShortCandle = (o = {}) => (m) => (m < 81 ? chop(o.from ?? 22490)(m)
  : m < 87 ? c((o.from ?? 22490) + (m - 81) * (22545 - (o.from ?? 22490)) / 6, (o.from ?? 22490) + (m - 80) * (22545 - (o.from ?? 22490)) / 6, 2)
    : m === 87 ? c(22545, 22555, 2) : m === 88 ? (o.accepted ? c(22555, 22572, 2) : c(22555, 22559, 3)) : m === 89 ? (o.noTurn ? c(22548, 22558, 3) : c(22558, 22548, 3)) : c(22548, 22548))
export const pocRejectShort = (o = {}) => world({ candle: pocRejectShortCandle(o), ...o })
export const pocRejectLong = (o = {}) => world({ candle: mirror(pocRejectShortCandle(o), 22560), ...o })
