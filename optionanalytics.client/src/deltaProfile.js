// DELTA PROFILES (asked for - "like volume profile and market profile we need to build a delta profile: the delta profile
// of option data on the spot chart, and on the futures chart"): at each PRICE ROW, how much traded there (the volume
// profile) and who was the aggressor there - buyers minus sellers (the delta profile). A row where heavy volume met
// sellers ("and sellers hit it hard") reads red; where buyers lifted the offer, green.
//
//  - FUTURES (`futuresDeltaProfile`): the Order Flow server's footprint - each minute's buy and sell volume AT EACH PRICE
//    (the aggressor side of every trade, OrderFlowEngine), added up by price row; a minute the server did not record
//    (a restart part way, or a day older than its 30 days on disk) is its estimate from Dhan's 1-minute candles, spread
//    over the minute's range - marked, never mistaken for traded sides.
//  - OPTIONS ON THE SPOT CHART (`optionDeltaProfile`): options have no trade-by-trade side either, so each strike's
//    1-minute bar gives one the dashboard's way (optionFlow.js - the Option CDV's own formula): buy minus sell from
//    where its close sits in its range (BarProxyDelta), each strike weighted by its delta at that minute's spot (a near-ATM
//    contract counts close to its full volume, a far-OTM one barely - ComputeDeltaWeight). Added up across the strikes
//    for each minute and laid on the SPOT price rows the index traded in that minute (spread evenly over its range): at
//    which spot levels call / put buyers and writers were active. NET = CE delta - PE delta - positive is bullish (calls
//    bought / puts sold), negative bearish (puts bought / calls sold); CE or PE alone shows that side's own buying (+) and
//    selling (-).
//
// SESSIONS: one profile can be of several days - the composite of the day so far and the sessions before it, or of the
// sessions before the day alone (`optionDeltaProfileOf` / `futuresDeltaProfileOf` take a list; OI Replay's "Previous
// day" / "Days" - deltaProfileDays.js loads the days before), each day's rows added up price by price.
//
// NO LOOK-AHEAD: only the minutes up to the clock (`asOfMs` - the minute shown, whose bar is complete on a replayed day;
// live, the latest) count - a profile cut at any clock equals the whole day's built only from the minutes before it.
// Pure: no page, no network.

import { barProxyDelta, deltaWeight, optionBars, spotLookup } from './optionFlow.js'
import { pocIndexOf, rowOf, valueAreaOf } from './orderFlowMath.js'
import { dayVolumeProfile } from './profileZones.js'

const MIN = 60_000
const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())
const minuteOf = (ms) => Math.floor(ms / MIN) * MIN

/** The option profile's sides: NET (CE delta - PE delta, + bullish), CE, PE. */
export const OPTION_DELTA_SIDES = [
  { value: 'net', label: 'Net (CE − PE)' },
  { value: 'ce', label: 'CE' },
  { value: 'pe', label: 'PE' },
]

/**
 * A delta profile from its rows [{ price (the row's bottom), volume, delta, ... }]: low to high, with the POC (the row
 * with the most volume), the value area's edges (70% of the volume around it - vah / val, the rows' bottoms), the
 * largest volume and |delta| (what the bars are drawn against) and the totals.
 */
export function finishDeltaProfile(list, rowSize) {
  const rows = (list ?? []).filter((r) => r.volume > 0 || r.delta !== 0).sort((a, b) => a.price - b.price)
  const empty = { rows: [], rowSize, poc: null, vah: null, val: null, maxVolume: 0, maxAbsDelta: 0, volume: 0, delta: 0 }
  if (!rows.length) return empty
  const counts = rows.map((r) => Math.max(0, r.volume))
  const volume = counts.reduce((a, b) => a + b, 0)
  let maxAbsDelta = 0, delta = 0
  for (const r of rows) { maxAbsDelta = Math.max(maxAbsDelta, Math.abs(r.delta)); delta += r.delta }
  if (!(volume > 0)) return { ...empty, rows, maxAbsDelta, delta }
  const pocIndex = pocIndexOf(counts)
  const { lo, hi } = valueAreaOf(counts, pocIndex, 0.7)
  return {
    rows, rowSize, poc: rows[pocIndex].price, vah: rows[hi].price, val: rows[lo].price,
    maxVolume: counts[pocIndex], maxAbsDelta, volume, delta,
  }
}

// Spreads `amounts` (an object of numbers) evenly over the `rowSize` rows from `low` to `high` into `rows` (a Map by row).
function spread(rows, low, high, rowSize, amounts) {
  const bottom = rowOf(low, rowSize), top = rowOf(high, rowSize)
  const n = Math.max(1, Math.round((top - bottom) / rowSize) + 1)
  for (let i = 0; i < n; i++) {
    const price = Math.round((bottom + i * rowSize) * 100) / 100
    let row = rows.get(price)
    if (!row) rows.set(price, row = { price, ceVol: 0, peVol: 0, ce: 0, pe: 0 })
    for (const [key, value] of Object.entries(amounts)) row[key] += value / n
  }
}

/**
 * The OPTIONS' flow minute by minute, what their delta profile on the spot chart is built from: `cePoints` / `pePoints`
 * (the run's 1-minute option bars - strike, open / high / low / close as price, volume; live, with the live minutes),
 * `spotBars` [{ time (ms), open, high, low, close }] (1-minute), `asOfMs` (the clock - null: everything). Each minute
 * [{ t, low, high, ceVol, peVol, ce, pe }], by time: the CE / PE delta-weighted volume and bar-proxy delta of every
 * strike, and the spot's range that minute (its last price when it has no bar) - the rows it is laid on. A day already
 * replayed is kept as this (a few hundred numbers, not the run).
 */
export function optionDeltaMinutes(cePoints, pePoints, spotBars, { asOfMs = null } = {}) {
  const clock = asOfMs == null ? null : minuteOf(asOfMs)
  const spot = (spotBars ?? []).filter((b) => b && b.close > 0 && Number.isFinite(msOf(b.time)) && (clock == null || minuteOf(msOf(b.time)) <= clock))
  const spotAt = spotLookup(spot.map((b) => ({ time: msOf(b.time), close: b.close })))
  const spotBar = new Map(spot.map((b) => [minuteOf(msOf(b.time)), b]))
  const minutes = new Map()
  const add = (points, isCall) => {
    for (const b of optionBars(points)) {
      if (clock != null && b.t > clock) continue
      const s = spotAt(b.t)
      if (!s) continue
      const w = deltaWeight(b.strike, s, isCall)
      let m = minutes.get(b.t)
      if (!m) {
        // The spot's range in that minute, else its last price (a minute the spot did not trade in - one row).
        const bar = spotBar.get(b.t)
        const low = bar ? Math.min(bar.low ?? bar.close, bar.close) : s
        const high = bar ? Math.max(bar.high ?? bar.close, bar.close) : s
        minutes.set(b.t, m = { t: b.t, low, high, ceVol: 0, peVol: 0, ce: 0, pe: 0 })
      }
      if (isCall) { m.ceVol += b.volume * w; m.ce += barProxyDelta(b) * w } else { m.peVol += b.volume * w; m.pe += barProxyDelta(b) * w }
    }
  }
  add(cePoints, true)
  add(pePoints, false)
  return [...minutes.values()].sort((a, b) => a.t - b.t)
}

/**
 * The OPTIONS' delta profile over one or more SESSIONS - each an array of `optionDeltaMinutes` - `rowSize` (spot points
 * a row), `side` ('net' / 'ce' / 'pe'). Several sessions are a COMPOSITE: every minute of each laid on the rows it
 * covered, added up. Rows: [{ price, volume, delta, ce, pe, ceVol, peVol }] - volume and delta of the side picked, in
 * delta-weighted contracts; `totals` { ce, pe, net } (the sessions' deltas); `minutes` - the minutes counted.
 */
export function optionDeltaProfileOf(sessions, { rowSize = 5, side = 'net' } = {}) {
  const rows = new Map()
  const totals = { ce: 0, pe: 0, net: 0 }
  let count = 0
  for (const minutes of sessions ?? []) {
    for (const m of minutes ?? []) {
      spread(rows, m.low, m.high, rowSize, { ceVol: m.ceVol, peVol: m.peVol, ce: m.ce, pe: m.pe })
      totals.ce += m.ce
      totals.pe += m.pe
      count++
    }
  }
  totals.net = totals.ce - totals.pe
  const pick = side === 'ce' ? (r) => [r.ceVol, r.ce] : side === 'pe' ? (r) => [r.peVol, r.pe] : (r) => [r.ceVol + r.peVol, r.ce - r.pe]
  const list = [...rows.values()].map((r) => { const [volume, delta] = pick(r); return { ...r, volume, delta } })
  return { ...finishDeltaProfile(list, rowSize), side, totals, minutes: count }
}

/**
 * The OPTIONS' delta profile on the spot chart of one day: `optionDeltaMinutes` of the bars up to the clock, as its
 * profile (`optionDeltaProfileOf` - one session).
 */
export function optionDeltaProfile(cePoints, pePoints, spotBars, { asOfMs = null, rowSize = 5, side = 'net' } = {}) {
  return optionDeltaProfileOf([optionDeltaMinutes(cePoints, pePoints, spotBars, { asOfMs })], { rowSize, side })
}

/**
 * The FUTURES' delta profile: `bars` - the Order Flow day's minute bars (time, levels [{ price, buy, sell }] - the
 * footprint; an estimated minute flagged `estimated`, its levels a spread of the candle's volume), `rowSize` (points a
 * row), `asOfMs` (the clock). Rows: [{ price, volume, delta, buy, sell }] in contracts; `estimatedMinutes` - how many of
 * the minutes counted are estimates, `minutes` - all counted.
 */
export function futuresDeltaProfile(bars, { asOfMs = null, rowSize = 5 } = {}) {
  return futuresDeltaProfileOf([barsUpTo(bars, asOfMs)], { rowSize })
}

/** The minute bars up to the clock (`asOfMs` - its minute counts; null: all). */
export function barsUpTo(bars, asOfMs = null) {
  const clock = asOfMs == null ? null : minuteOf(asOfMs)
  return (bars ?? []).filter((b) => Number.isFinite(msOf(b.time)) && (clock == null || minuteOf(msOf(b.time)) <= clock))
}

/** The FUTURES' delta profile over one or more SESSIONS - each an array of the Order Flow day's minute bars, as
 *  `futuresDeltaProfile` takes them - added up price by price (a COMPOSITE when there are several). */
export function futuresDeltaProfileOf(sessions, { rowSize = 5 } = {}) {
  const all = (sessions ?? []).flatMap((bars) => bars ?? [])
  const vp = dayVolumeProfile(all, rowSize)
  const list = (vp.rows ?? []).map((r) => ({ price: r.price, buy: r.buy, sell: r.sell, volume: r.buy + r.sell, delta: r.buy - r.sell }))
  return { ...finishDeltaProfile(list, rowSize), minutes: all.length, estimatedMinutes: all.filter((b) => b.estimated).length }
}

/** The row holding `price` in a profile (its rows' bottoms, `rowSize` apart), or null - what the crosshair reads. */
export function rowAt(profile, price) {
  if (!profile?.rows?.length || !Number.isFinite(price) || !(profile.rowSize > 0)) return null
  const bottom = rowOf(price, profile.rowSize)
  return profile.rows.find((r) => Math.abs(r.price - bottom) < 1e-6) ?? null
}
