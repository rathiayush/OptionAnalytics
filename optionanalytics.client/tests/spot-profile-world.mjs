// Scenario days for the spot + options strategies that read the day's OWN spot profile (#111 - #113, spotEngine.js
// spotProfile - time at price over the spot minutes finished 15+ minutes before the clock) - shared by spot-strategies-4
// (their rules) and spot-strategies-3 (every spot strategy at every scale). Each day's first 75 minutes build the profile
// the setup at 10:45 reads: two balance areas (volume nodes) with a fast move between them (a thin area, the LVN).
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

/** A day at `scale`: `candle(m)` a spot candle, `ce` / `pe` (k, m) the OI, all in NIFTY terms. */
export function world({ candle, ce = () => 2e6, pe = () => 2e6, minutes = 91, scale = NIFTY }) {
  const f = scale.step / 50
  const px = (p) => scale.base + (p - 22500) * f
  const spot = Array.from({ length: minutes }, (_, m) => {
    const x = candle(m)
    return { time: iso(m), open: px(x.open), high: px(x.high), low: px(x.low), close: px(x.close) }
  })
  const points = (oiF) => spot.flatMap((_, m) => STRIKES.map((k) => ({ time: iso(m), strike: px(k), openInterest: Math.round(oiF(k, m)), price: 60 * f })))
  const run = { success: true, date: '2026-10-09', step: scale.step, cePoints: points(ce), pePoints: points(pe), futuresBars: [], spotCandlesOneMinute: spot }
  return { oi: buildOiContext(run, null, { live: false }), bars: spotBarsOf(spot), scale }
}

export const c = (open, close, pad = 3) => ({ open, close, high: Math.max(open, close) + pad, low: Math.min(open, close) - pad })
const chop = (level) => (m) => c(level + ((m % 4) - 1.5), level + (((m + 1) % 4) - 1.5))
// A balance area: price swings evenly between `level` - 30 and `level` + 30, 10 points a minute.
const swing = (m) => { const x = ((m % 12) + 12) % 12; return x <= 6 ? -30 + 10 * x : 90 - 10 * x }
const balance = (level) => (m) => c(level + swing(m), level + swing(m + 1), 2)
/** A path in NIFTY terms mirrored about `axis` (a SHORT's day from a LONG's). */
const mirror = (candle, axis) => (m) => { const x = candle(m); return { open: 2 * axis - x.open, close: 2 * axis - x.close, high: 2 * axis - x.low, low: 2 * axis - x.high } }

// The first 75 minutes - the profile at 10:45. 'up': a balance round 22400 (30 min), three fast candles up across
// 22430 - 22590, a balance round 22620 (42 min) - the POC; the thin area between the two nodes. 'down': round 22620
// first (42 min - still the POC), down across, round 22400 (30 min). 'flat': one balance round `flat` - no thin area.
export const morning = (o = {}) => (m) => {
  if (o.flat != null) return balance(o.flat)(m)
  if (o.order === 'down') return m < 42 ? balance(22620)(m) : m === 42 ? c(22590, 22535, 2) : m === 43 ? c(22535, 22480, 2) : m === 44 ? c(22480, 22430, 2) : balance(22400)(m)
  return m < 30 ? balance(22400)(m) : m === 30 ? c(22430, 22485, 2) : m === 31 ? c(22485, 22540, 2) : m === 32 ? c(22540, 22590, 2) : balance(22620)(m)
}

// #111 LVN refused - LONG: the 'up' morning ends round the POC 22610 (the thin area 22432.5 - 22582.5 under it); down to
// 22592 by 10:41, into the thin area (low 22577) and refused: no close past its middle, the 10:44 candle up 22580 ->
// 22584. Back to the node it came from, the POC 22610. `from`: at that price since 10:12 instead - it did not come from
// away.
export const lvnRefusedLongCandle = (o = {}) => (m) => (o.from != null && m >= 57 && m < 87 ? chop(o.from)(m) : m < 75 ? morning({ order: 'up', ...o })(m)
  : m < 87 ? c(22620 - (m - 75) * 28 / 12, 22620 - (m - 74) * 28 / 12, 2)
    : m === 87 ? c(22592, 22589, 2) : m === 88 ? (o.accepted ? c(22589, 22500, 2) : c(22589, 22581, 2)) : m === 89 ? (o.noTurn ? c(22584, 22580, 3) : c(22580, 22584, 3)) : c(22584, 22584))
export const lvnRefusedLong = (o = {}) => world({ candle: lvnRefusedLongCandle(o), ...o })
export const lvnRefusedShort = (o = {}) => world({ candle: mirror(lvnRefusedLongCandle(o), 22500), ...o })

// #112 LVN filled fast - LONG: the 'down' morning ends round 22400; under the thin area at 22425 (its low 22432.5), then
// the 10:44 candle runs 22430 -> 22462, 29.5 into it - across to the next node beyond it, the POC 22610 (3x the stop
// first). `slow`: it crept in (22425 -> 22455 over 10:40 - 10:43) and the last candle is small; `close`: the big candle
// closes only 3.5 into the area; `before`: price was inside the area already.
export const lvnFillLongCandle = (o = {}) => (m) => (m < 75 ? morning({ order: 'down', ...o })(m)
  : o.slow && m >= 85 && m < 89 ? c(22425 + (m - 85) * 7.5, 22425 + (m - 84) * 7.5, 2) : m < 89 ? chop(o.before ?? 22425)(m)
    : m === 89 ? (o.slow ? c(22455, 22462, 2) : o.close ? c(22420, 22436, 2) : c(22430, 22462, 2)) : c(22462, 22462))
export const lvnFillLong = (o = {}) => world({ candle: lvnFillLongCandle(o), ...o })
export const lvnFillShort = (o = {}) => world({ candle: mirror(lvnFillLongCandle(o), 22500), ...o })

// #113 POC rejection - SHORT: the 'down' morning (the POC 22610); at 22540 until 10:35, a fast run up into the POC (high
// 22611 at 10:43), no close above it, and the 10:44 candle turns down 22607 -> 22597.
export const pocRejectShortCandle = (o = {}) => (m) => (m < 75 ? morning({ order: 'down', ...o })(m)
  : m < 81 ? chop(o.from ?? 22540)(m)
    : m < 87 ? c((o.from ?? 22540) + (m - 81) * (22595 - (o.from ?? 22540)) / 6, (o.from ?? 22540) + (m - 80) * (22595 - (o.from ?? 22540)) / 6, 2)
      : m === 87 ? c(22595, 22603, 2) : m === 88 ? (o.accepted ? c(22603, 22622, 2) : c(22603, 22608, 3)) : m === 89 ? (o.noTurn ? c(22597, 22607, 3) : c(22607, 22597, 3)) : c(22597, 22597))
export const pocRejectShort = (o = {}) => world({ candle: pocRejectShortCandle(o), ...o })
export const pocRejectLong = (o = {}) => world({ candle: mirror(pocRejectShortCandle(o), 22610), ...o })
