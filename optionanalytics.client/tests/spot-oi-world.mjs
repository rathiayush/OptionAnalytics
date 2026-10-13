// Scenario days for #114, the spot OI confluence (spotEngine.js): the option chain's OI reads - the ones the Strategy lab
// tunes as filters - all on the trade's side, and a dip bought (a pop sold) with them. Shared by spot-strategies-5 (its
// rules) and spot-strategies-3 (every spot strategy at every scale). Written at NIFTY (22,500, step 50) - the clock at
// 10:45 (minute 90) - and mapped strike for strike onto BANKNIFTY / SENSEX by spot-profile-world's `world`.
import { world, c } from './spot-profile-world.mjs'

/** A path in NIFTY terms mirrored about `axis` (a SHORT's day from a LONG's). */
const mirror = (candle, axis) => (m) => { const x = candle(m); return { open: 2 * axis - x.open, close: 2 * axis - x.close, high: 2 * axis - x.low, low: 2 * axis - x.high } }
/** OI mirrored: a SHORT's CE is the LONG's PE at the mirrored strike, and the other way round. */
const flip = (oi, axis) => (k, m) => oi(2 * axis - k, m)

// LONG: a climb all morning (22400 -> 22470, then faster to 22519 at 10:38), a dip to 22491 over 10:39 - 10:43 (1 ATR+ off
// the high), and the 10:44 candle resumes up, 22496 -> 22512, closing over the one before's high. `noDip`: the climb goes
// on with no pullback; `noResume`: the last candle turns down.
const base = (m) => (m < 70 ? 22400 + m : 22470 + (m - 69) * 3.5)
export const confluenceLongCandle = (o = {}) => (m) => {
  if (o.after && m >= 90) return c(22512 - 8 * (m - 90), 22512 - 8 * (m - 89)) // `after`: a crash after the clock
  if (o.noDip && m < 90) return c(base(m), base(m) + 3.5)
  if (m < 84) return c(base(m), base(m) + 3.5)
  const dip = [[22519, 22512], [22512, 22505], [22505, 22498], [22498, 22494], [22494, 22496]][m - 84]
  if (dip) return c(dip[0], dip[1])
  return o.noResume ? c(22500, 22493, 2) : c(22496, 22512, 2)
}

// The chain for a LONG: puts written all day (every strike +0.04% a minute - 3.6% since the open, 0.6% of it in the
// last 15 minutes), calls shed slowly (-0.01% a minute); the walls: puts 22400, calls 22650 (138 pts over the entry).
// `cumAgainst`: calls written faster than puts until 10:30, flat after - since the open the chain leans to calls, while
// the last 15 minutes still back the long; `sidesFlat`: both sides flat over the last 15 minutes; `wallGrowing`: the call
// wall 22650 written 0.8% in the last 15 minutes; `wallClose`: the call wall at 22550 - inside the target.
export const confluenceLongCe = (o = {}) => (k, m) => {
  const wall = o.wallClose ? 22550 : 22650
  const t = o.sidesFlat ? Math.min(m, 75) : m
  const grow = o.cumAgainst ? 1 + 0.04 * Math.min(m, 75) / 75 : 1 - 0.0001 * t
  const fresh = o.wallGrowing && k === wall ? 1 + 0.008 * Math.max(0, m - 75) / 15 : 1
  return (k === wall ? 6e6 : 2e6) * grow * fresh
}
export const confluenceLongPe = (o = {}) => (k, m) => (k === 22400 ? 6e6 : 2e6) * (1 + 0.0004 * (o.sidesFlat ? Math.min(m, 75) : m))

// `cumSideAgainst`: puts are the big side (6e6 a strike) and added only 0.9% since the open (0.6% of it in the last 15
// minutes), calls (1e6 a strike) added 1.2% in the morning, flat since - the net CE - PE still leans to puts, but since the
// open CE is up (with the bar) and PE is not: the CE / PE pair against the long.
export const cumSideAgainstCe = () => (k, m) => (k === 22650 ? 3e6 : 1e6) * (1 + 0.012 * Math.min(m, 60) / 60)
export const cumSideAgainstPe = () => (k, m) => (k === 22400 ? 12e6 : 6e6) * (1 + 0.003 * Math.min(m, 75) / 75 + 0.006 * Math.max(0, m - 75) / 15)

// `after`: the day goes on past the clock (to 11:15) - a crash, calls piling in, puts shed - which the setup at 10:45
// must not see.
const later = (oi, sign) => (k, m) => oi(k, m) * (m > 90 ? 1 + sign * 0.01 * (m - 90) : 1)
export const confluenceLong = (o = {}) => world({
  candle: confluenceLongCandle(o),
  ce: later(o.cumSideAgainst ? cumSideAgainstCe() : confluenceLongCe(o), o.after ? 1 : 0),
  pe: later(o.cumSideAgainst ? cumSideAgainstPe() : confluenceLongPe(o), o.after ? -1 : 0),
  ...(o.after ? { minutes: 121 } : {}),
  ...(o.scale ? { scale: o.scale } : {}),
})
export const confluenceShort = (o = {}) => world({
  candle: mirror(confluenceLongCandle(o), 22500),
  ce: flip(o.cumSideAgainst ? cumSideAgainstPe() : confluenceLongPe(o), 22500),
  pe: flip(o.cumSideAgainst ? cumSideAgainstCe() : confluenceLongCe(o), 22500),
  ...(o.scale ? { scale: o.scale } : {}),
})

// The same bounce, dip and resume at 12:05 - 12:14 (the clock at minute 180) at the end of a day that went one way since
// the open, 1 pt a minute: UP for `against: false` (the long fires), DOWN for `against: true` - the price alone calls it a
// down trend (the OI has no futures vote on spot), so the long is against the day and does not fire. Mirrored for a short.
const lateCandle = (o = {}) => (m) => {
  const at = 166
  const start = o.against ? 22700 : 22300
  const dir = o.against ? -1 : 1
  if (m < at) return c(start + dir * m, start + dir * (m + 1))
  const low = start + dir * at
  const k = m - at
  if (k < 8) return c(low + k * 30 / 8, low + (k + 1) * 30 / 8)
  const top = low + 30
  const d = [[top, top - 6], [top - 6, top - 12], [top - 12, top - 17], [top - 17, top - 21], [top - 21, top - 19]][k - 8]
  return d ? c(d[0], d[1]) : c(top - 19, top - 3, 2)
}
const lateCe = (k, m) => (k === 22650 || k === 22350 ? 6e6 : 2e6) * (1 - 0.0001 * m)
const latePe = (k, m) => (k === 22400 || k === 22600 ? 6e6 : 2e6) * (1 + 0.0004 * m)
export const LATE = 180
export const confluenceLateLong = (o = {}) => world({ candle: lateCandle(o), ce: lateCe, pe: latePe, minutes: LATE + 1, ...(o.scale ? { scale: o.scale } : {}) })
export const confluenceLateShort = (o = {}) => world({ candle: mirror(lateCandle(o), 22500), ce: flip(latePe, 22500), pe: flip(lateCe, 22500), minutes: LATE + 1, ...(o.scale ? { scale: o.scale } : {}) })
