// Scenario days for #101 (spotEngine.js): the since-open CE - PE lines cross on the 1-minute clock (the alert), then the spot's
// 3-minute EMA 7 / 21 crosses the trade's way and the entry is taken when that candle closes - with the cumulative CE / PE change,
// the S / R OI near the ATM and the strikes right round it all going the trade's way. Written at NIFTY (22,500, step 50).
// LONG: calls were added until 10:15 (the since-open CE - PE leans to calls), then calls LEAVE and puts are ADDED - the lines cross
// to puts a few minutes later; the spot drifts down until 10:15, then climbs 1.2 points a minute, so its 3-minute EMA 7 crosses over
// 21 a few candles after the lines. The OI round the ATM is held by puts (3.5M against 2M, a big net difference). SHORT: the mirror.
import { buildOiContext } from '../src/strategyEngine.js'
import { spotBarsOf } from '../src/spotEngine.js'

export const MIN = 60_000
export const T = Date.parse('2026-10-09T03:45:00Z') // 09:15 IST
const iso = (m) => new Date(T + m * MIN).toISOString()
const STRIKES = [22300, 22350, 22400, 22450, 22500, 22550, 22600, 22650, 22700]
const AXIS = 22500
const c = (open, close, pad = 1.5) => ({ open, close, high: Math.max(open, close) + pad, low: Math.min(open, close) - pad })
const near = (k) => k >= 22400 && k <= 22600

function build(spotAt, ceAt, peAt, minutes) {
  const spot = Array.from({ length: minutes }, (_, m) => ({ time: iso(m), ...spotAt(m) }))
  const points = (f, price) => spot.flatMap((_, m) => STRIKES.map((k) => ({ time: iso(m), strike: k, openInterest: Math.round(f(k, m)), price })))
  const run = { success: true, date: '2026-10-09', step: 50, cePoints: points(ceAt, 60), pePoints: points(peAt, 60), futuresBars: [], spotCandlesOneMinute: spot }
  return { oi: buildOiContext(run, null, { live: false }), bars: spotBarsOf(spot) }
}

// Options (each takes ONE thing away from the LONG day): `noCross` - the spot never turns up (no EMA crossover); `callsStay` - the
// calls are not leaving (they only stop being added), so the OI round the ATM is not going the trade's way; `ceHeavy` - the calls
// round the ATM outweigh the puts (no net difference for a long); `smallNet` - the puts are only a little heavier (a small net
// difference); `atmCalls` - the strikes right round the ATM keep ADDING calls while the wider strikes still shed them (the S / R OI over ATM +/- 2 goes the way, the strikes round the ATM do not);
// `bothUp` - the calls were added much more before 10:15 (both sides up since the open: the cumulative change is neither with nor against a long);
// `farCalls` - the strikes away from the ATM keep ADDING calls (the whole chain's calls are not leaving) while the ones near the ATM leave;
// `emaFirst` - the spot turns up 14 minutes BEFORE the lines cross (the EMA crossover comes first, the lines after it);
// `noFlip` - puts are not added, so the CE - PE lines never cross; `lateTurn` - the spot turns up 40 minutes after the lines cross
// (too late to wait for); `minutes` - the length of the day.
export const TURN = 60
const longDay = (o = {}) => {
  const turn = o.lateTurn ? TURN + 60 : o.emaFirst ? TURN - 14 : TURN
  const base = (m) => 22500 - 0.2 * Math.min(m, turn) + (o.noCross ? -0.2 * Math.max(0, m - TURN) : 1.2 * Math.max(0, m - turn))
  const spotAt = (m) => c(base(m), base(m + 1))
  const pe = (k) => (near(k) ? (o.ceHeavy ? 2e6 : o.smallNet ? 2.4e6 : 3.5e6) : 2e6)
  const ce = (k) => (near(k) ? (o.ceHeavy ? 4e6 : 2e6) : 2e6)
  const leave = o.callsStay ? 0 : 0.003
  const ceRate = (k) => (o.farCalls && !near(k) ? -0.004 : o.atmCalls ? (Math.abs(k - AXIS) <= 50 ? -0.002 : near(k) ? 0.012 : leave) : leave)
  const ceAt = (k, m) => ce(k) * (1 + (o.bothUp ? 0.0016 : 0.0006) * Math.min(m, TURN) - ceRate(k) * Math.max(0, m - TURN))
  const peAt = (k, m) => pe(k) * (1 + (o.bothUp ? 0.0008 : 0.0002) * Math.min(m, TURN) + (o.noFlip ? 0 : 0.0016) * Math.max(0, m - TURN))
  return { spotAt, ceAt, peAt }
}
export const crossLong = (o = {}) => { const d = longDay(o); return build(d.spotAt, d.ceAt, d.peAt, o.minutes ?? 140) }
export const crossShort = (o = {}) => {
  const d = longDay(o)
  const mirror = (x) => ({ open: 2 * AXIS - x.open, close: 2 * AXIS - x.close, high: 2 * AXIS - x.low, low: 2 * AXIS - x.high })
  return build((m) => mirror(d.spotAt(m)), (k, m) => d.peAt(2 * AXIS - k, m), (k, m) => d.ceAt(2 * AXIS - k, m), o.minutes ?? 140)
}
