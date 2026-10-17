// Scenario days for #115, the adaptive spot strategy (spotEngine.js): a TREND day (buy the option), a RANGE day (sell it
// at the wall) and a failed SWEEP of the previous day's high / low (buy the turn). Written at NIFTY (22,500, step 50) - the
// clock at 10:45 (minute 90) - and mapped strike for strike onto BANKNIFTY / SENSEX by spot-profile-world's `world`.
import { buildOiContext } from '../src/strategyEngine.js'
import { spotBarsOf } from '../src/spotEngine.js'
import { MIN, T, NIFTY, c } from './spot-profile-world.mjs'

const STRIKES = [22300, 22350, 22400, 22450, 22500, 22550, 22600, 22650, 22700]
const iso = (m) => new Date(T + m * MIN).toISOString()
/** spot-profile-world's day, with option premiums that MOVE with the index (#115 reads the ATM option's own EMA): a
 *  strike's call is 40 plus half the index's distance over the strike (a delta of 0.5), its put 40 plus half the distance
 *  under it - so on a rally the call climbs and the put falls.
 *  `prem: 'flat'`: every premium stays 60 (the option going nowhere). */
function world({ candle, ce = () => 2e6, pe = () => 2e6, minutes = 91, scale = NIFTY, prem = 'moves' }) {
  const f = scale.step / 50
  const px = (p) => scale.base + (p - 22500) * f
  const spot = Array.from({ length: minutes }, (_, m) => {
    const x = candle(m)
    return { time: iso(m), open: px(x.open), high: px(x.high), low: px(x.low), close: px(x.close) }
  })
  const price = (side, k, m) => (prem === 'flat' ? 60 : Math.max(1, 40 + 0.5 * (side === 'CE' ? candle(m).close - k : k - candle(m).close))) * f
  const points = (side, oiF) => spot.flatMap((_, m) => STRIKES.map((k) => ({ time: iso(m), strike: px(k), openInterest: Math.round(oiF(k, m)), price: price(side, k, m) })))
  const run = { success: true, date: '2026-10-09', step: scale.step, cePoints: points('CE', ce), pePoints: points('PE', pe), futuresBars: [], spotCandlesOneMinute: spot }
  return { oi: buildOiContext(run, null, { live: false }), bars: spotBarsOf(spot), scale }
}

const mirror = (candle, axis) => (m) => { const x = candle(m); return { open: 2 * axis - x.open, close: 2 * axis - x.close, high: 2 * axis - x.low, low: 2 * axis - x.high } }
const flip = (oi, axis) => (k, m) => oi(2 * axis - k, m)
const later = (oi, sign) => (k, m) => oi(k, m) * (m > 90 ? 1 + sign * 0.01 * (m - 90) : 1)
const scaled = (o) => ({ ...(o.scale ? { scale: o.scale } : {}), ...(o.prem ? { prem: o.prem } : {}) })

// ---- TREND (LONG): the opening drives up (three 5-minute candles up, 22400 -> 22430), the climb goes on all morning,
// a pullback to EMA 9 over 10:39 - 10:43 and the 10:44 candle resumes up, closing over the one before's high.
// `driveDown`: the opening candles fall (22430 -> 22400) before the climb; `noResume`: the last candle turns down;
// `noDip`: the climb never pulls back (RSI runs hot, nothing to enter on); `after`: a crash after the clock.
export const trendLongCandle = (o = {}) => (m) => {
  if (o.after && m >= 90) return c(22520 - 8 * (m - 90), 22520 - 8 * (m - 89))
  if (m < 15) return o.driveDown ? c(22430 - 2 * m, 22430 - 2 * (m + 1)) : c(22400 + 2 * m, 22400 + 2 * (m + 1))
  const climb = (x) => (o.driveDown ? 22400 : 22430) + (x - 15) * (o.driveDown ? 1.45 : 1.05)
  if (o.noDip || m < 84) return c(climb(m), climb(m + 1))
  const top = climb(84)
  const dip = [[top, top - 5], [top - 5, top - 9], [top - 9, top - 12], [top - 12, top - 13], [top - 13, top - 11]][m - 84]
  if (dip) return c(dip[0], dip[1])
  return o.noResume ? c(top - 11, top - 15, 2) : c(top - 11, top - 1, 2)
}
// The chain for a trend LONG: puts written all day (every strike +0.04% a minute), calls shed slowly (-0.01%); walls:
// puts 22400, calls 22700 (the support OI under the price outweighs the resistance OI over it). `oiFlat`: neither side moves all day (no writers on the trade's side since the open);
// `sidesFlat`: both sides flat over the last 15 minutes and the S/R OI even (only one confirmation left).
export const trendLongCe = (o = {}) => (k, m) => (k === 22700 ? 6e6 : 2e6) * (o.oiFlat ? 1 : 1 - 0.0001 * (o.sidesFlat ? Math.min(m, 75) : m)) * (o.sidesFlat && k >= 22550 && k <= 22650 ? 1.7 : 1)
export const trendLongPe = (o = {}) => (k, m) => (k === 22400 ? 6e6 : 2e6) * (o.oiFlat ? 1 : 1 + 0.0004 * (o.sidesFlat ? Math.min(m, 75) : m))
export const trendLong = (o = {}) => world({
  candle: trendLongCandle(o), ce: later(trendLongCe(o), o.after ? 1 : 0), pe: later(trendLongPe(o), o.after ? -1 : 0),
  ...(o.after ? { minutes: 121 } : {}), ...scaled(o),
})
export const trendShort = (o = {}) => world({ candle: mirror(trendLongCandle(o), 22500), ce: flip(trendLongPe(o), 22500), pe: flip(trendLongCe(o), 22500), ...scaled(o) })

// ---- RANGE (LONG - fade the put wall, SELL the put): the price swings round 22500 all morning (VWAP 22500, crossed
// back and forth), puts 22450 and calls 22550 the walls, both written at the same pace (the OI not one-sided, S/R OI
// balanced); at 10:37 - 10:43 it falls to the put wall (low 22448) and the 10:44 candle turns up. `oneSided`: puts
// written much faster than calls since the open; `wallLeaving`: the put wall shed 1% in the last 15 minutes;
// `noTurn`: the last candle keeps falling; `trend`: no swings - a steady fall to the wall (VWAP not crossed).
const swing30 = (m) => { const x = ((m % 30) + 30) % 30; return x <= 15 ? -40 + (80 * x) / 15 : 40 - (80 * (x - 15)) / 15 }
export const rangeLongCandle = (o = {}) => (m) => {
  const path = (x) => (o.trend ? 22560 - x * 1.1 : 22500 + swing30(x))
  if (m < 82) return c(path(m), path(m + 1), 2)
  const fall = [[22490, 22480], [22480, 22470], [22470, 22462], [22462, 22456], [22456, 22452], [22452, 22451], [22451, 22452]][m - 82]
  if (fall) return c(fall[0], fall[1], 3)
  return o.noTurn ? c(22452, 22447, 2) : c(22451, 22457, 2)
}
export const rangeLongCe = () => (k, m) => (k === 22550 ? 6e6 : 2e6) * (1 + 0.0002 * m)
export const rangeLongPe = (o = {}) => (k, m) => (k === 22450 ? 6e6 : 2e6) * (1 + (o.oneSided ? 0.001 : 0.0002) * m) * (o.wallLeaving && k === 22450 ? 1 - 0.01 * Math.max(0, m - 75) / 15 : 1)
export const rangeLong = (o = {}) => world({ candle: rangeLongCandle(o), ce: rangeLongCe(o), pe: rangeLongPe(o), ...scaled(o) })
export const rangeShort = (o = {}) => world({ candle: mirror(rangeLongCandle(o), 22500), ce: flip(rangeLongPe(o), 22500), pe: flip(rangeLongCe(o), 22500), ...scaled(o) })

// ---- SWEEP (SHORT - yesterday's high 22530 taken out and lost; BUY the put): the price climbs under 22530 all morning
// (22440 -> 22515), runs to 22546 over 10:37 - 10:41 - over yesterday's high for the first time - and falls back to 22522
// by 10:44; the call wall 22550 written 0.8% in the last 15 minutes (defending). `prev` is yesterday.
// `noBack`: it stays over the level; `earlier`: it was over 22530 already at 10:00 (not the first time today);
// `noDefence`: the call wall not written and ATM +/- 2 flat.
export const SWEEP_PREV = { date: '2026-10-08', high: 22530, low: 22380, close: 22480 }
export const sweepShortCandle = (o = {}) => (m) => {
  if (o.earlier && m >= 45 && m < 50) return c(22520, 22536, 2)
  if (m < 81) return c(22440 + m * 0.9, 22440 + (m + 1) * 0.9, 2)
  const run = [[22513, 22520], [22520, 22530], [22530, 22540], [22540, 22545], [22545, 22541], [22541, 22533], [22533, 22527], [22527, 22524]][m - 81]
  if (run) return c(run[0], run[1], 2)
  return o.noBack ? c(22536, 22538, 2) : c(22526, 22521, 2)
}
export const sweepShortCe = (o = {}) => (k, m) => (k === 22550 ? 6e6 : 2e6) * (!o.noDefence && k === 22550 ? 1 + 0.008 * Math.max(0, m - 75) / 15 : 1)
export const sweepShortPe = () => (k) => (k === 22400 ? 6e6 : 2e6)
export const sweepShort = (o = {}) => world({ candle: sweepShortCandle(o), ce: sweepShortCe(o), pe: sweepShortPe(o), ...scaled(o) })
export const sweepLong = (o = {}) => world({ candle: mirror(sweepShortCandle(o), 22475), ce: flip(sweepShortPe(o), 22475), pe: flip(sweepShortCe(o), 22475), ...scaled(o) })
/** Yesterday in the scale's terms (a LONG's yesterday is the SHORT's mirrored about 22475: its high 22530 becomes the low 22420). */
export const sweepPrev = (scale, long = false) => {
  const f = (scale?.step ?? 50) / 50
  const px = (p) => (scale?.base ?? 22500) + (p - 22500) * f
  const m = (p) => (long ? 2 * 22475 - p : p)
  const hi = Math.max(m(SWEEP_PREV.high), m(SWEEP_PREV.low))
  const lo = Math.min(m(SWEEP_PREV.high), m(SWEEP_PREV.low))
  return { date: SWEEP_PREV.date, high: px(hi), low: px(lo), close: px(m(SWEEP_PREV.close)) }
}
