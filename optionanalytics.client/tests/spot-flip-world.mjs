// Scenario days for #101, the CE / PE flip (spotEngine.js). LONG: the spot climbs all morning (1.2 points a minute from
// 22,400), calls were added faster than puts until 10:15 (the chain's since-open CE - PE leans to calls), then puts are added
// much faster and overtake them - the since-open CE - PE flips to puts - with the OI round the ATM held by puts. SHORT: the
// same day mirrored about 22,500 (calls and puts swapped). Written at NIFTY (22,500, step 50).
import { buildOiContext } from '../src/strategyEngine.js'
import { spotBarsOf } from '../src/spotEngine.js'

export const MIN = 60_000
export const T = Date.parse('2026-10-09T03:45:00Z') // 09:15 IST
const iso = (m) => new Date(T + m * MIN).toISOString()
const STRIKES = [22300, 22350, 22400, 22450, 22500, 22550, 22600, 22650, 22700]
const AXIS = 22500
const c = (open, close, pad = 1.5) => ({ open, close, high: Math.max(open, close) + pad, low: Math.min(open, close) - pad })
const near = (k) => k >= 22400 && k <= 22600

function build(spotAt, ceAt, peAt, minutes, priceAt = () => 60) {
  const spot = Array.from({ length: minutes }, (_, m) => ({ time: iso(m), ...spotAt(m) }))
  const points = (f, side) => spot.flatMap((_, m) => STRIKES.map((k) => ({ time: iso(m), strike: k, openInterest: Math.round(f(k, m)), price: priceAt(side, k, m) })))
  const run = { success: true, date: '2026-10-09', step: 50, cePoints: points(ceAt, 'CE'), pePoints: points(peAt, 'PE'), futuresBars: [], spotCandlesOneMinute: spot }
  return { oi: buildOiContext(run, null, { live: false }), bars: spotBarsOf(spot) }
}

// Options: `noTrend` - the spot chops sideways (the 3-minute EMAs do not agree); `peStall` - puts stop being added after
// 10:15, so the last minutes' change is not with the trade (and no flip comes); `ceHeavy` - the calls round the ATM outweigh
// the puts; `slow` - puts overtake calls 10+ minutes later (the flip comes later in the day); `bothShed` - the since-open
// flip comes from BOTH sides shedding OI (calls faster) after 10:15, so the last minutes' CE / PE change is not with a long.
const longDay = (o = {}) => {
  const spotAt = (m) => (o.noTrend ? c(22500 + ((m % 4) - 1.5), 22500 + (((m + 1) % 4) - 1.5)) : c(22400 + 1.2 * m, 22400 + 1.2 * (m + 1)))
  const ceAt = (k, m) => (near(k) && o.ceHeavy ? 4e6 : 2e6) * (1 + 0.0006 * Math.min(m, 60) - (o.bothShed ? 0.0012 * Math.max(0, m - 60) : 0))
  const peRate = o.slow ? 0.0011 : 0.0016
  const peAt = (k, m) => (near(k) ? 3e6 : 2e6) * (1 + 0.0002 * Math.min(m, 60) + (o.bothShed ? -0.0003 * Math.max(0, m - 60) : o.peStall ? 0 : peRate * Math.max(0, m - 60)))
  return { spotAt, ceAt, peAt }
}
export const flipLong = (o = {}) => { const d = longDay(o); return build(d.spotAt, d.ceAt, d.peAt, o.minutes ?? 140) }
export const flipShort = (o = {}) => {
  const d = longDay(o)
  const mirror = (x) => ({ open: 2 * AXIS - x.open, close: 2 * AXIS - x.close, high: 2 * AXIS - x.low, low: 2 * AXIS - x.high })
  return build((m) => mirror(d.spotAt(m)), (k, m) => d.peAt(2 * AXIS - k, m), (k, m) => d.ceAt(2 * AXIS - k, m), o.minutes ?? 140)
}

// The CROSSOVER trigger's days. LONG: the spot drifts down 0.2 a minute until 11:00 (minute 105), then climbs 1.2 points a
// minute - the 3-minute EMA 7 crosses over 21 on the first candles of the climb; puts were added faster than calls all
// morning (the since-open CE - PE leans to puts), the OI round the ATM is held by puts, the last minutes' change is with
// puts, and the ATM CE's premium climbs with the spot while the PE's falls (their EMAs line up with it). SHORT: mirrored.
// Options: `sideways` - neither side's OI moves (the since-open CE - PE stays balanced: no OI behind the cross); `ceLead` -
// calls added faster than puts (the OI leans against a long); `ceHeavy` - the calls round the ATM outweigh the puts;
// `optFlat` - the option premiums do not move (the ATM CE / PE EMAs do not line up); `late` - the climb starts at minute 130.
export const CLIMB = 105
const crossDay = (o = {}) => {
  const at = o.late ? 130 : CLIMB
  const base = (m) => 22500 - 0.2 * Math.min(m, at) + 1.2 * Math.max(0, m - at)
  const spotAt = (m) => c(base(m), base(m + 1))
  const rate = (up) => (o.sideways ? 0 : up ? 0.0016 : 0)
  const ceAt = (k, m) => (near(k) && o.ceHeavy ? 4e6 : 2e6) * (1 + (o.ceLead ? rate(true) : rate(false)) * m)
  const peAt = (k, m) => (near(k) ? 3e6 : 2e6) * (1 + (o.ceLead ? rate(false) : rate(true)) * m)
  const priceAt = (side, k, m) => (o.optFlat ? 60 : side === 'CE' ? 60 + 0.6 * Math.max(0, m - at) : Math.max(20, 60 - 0.6 * Math.max(0, m - at)))
  return { spotAt, ceAt, peAt, priceAt }
}
export const crossLong = (o = {}) => { const d = crossDay(o); return build(d.spotAt, d.ceAt, d.peAt, o.minutes ?? 140, d.priceAt) }
export const crossShort = (o = {}) => {
  const d = crossDay(o)
  const mirror = (x) => ({ open: 2 * AXIS - x.open, close: 2 * AXIS - x.close, high: 2 * AXIS - x.low, low: 2 * AXIS - x.high })
  return build((m) => mirror(d.spotAt(m)), (k, m) => d.peAt(2 * AXIS - k, m), (k, m) => d.ceAt(2 * AXIS - k, m), o.minutes ?? 140,
    (side, k, m) => d.priceAt(side === 'CE' ? 'PE' : 'CE', 2 * AXIS - k, m))
}
