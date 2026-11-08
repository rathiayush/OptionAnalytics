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
import { dayVolumeProfile, volumeZones } from './profileZones.js'

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

// Spreads `amounts` (an object of numbers) evenly over the `rowSize` rows from `low` to `high` into `rows` (a Map by row);
// the rows touched.
function spread(rows, low, high, rowSize, amounts) {
  const bottom = rowOf(low, rowSize), top = rowOf(high, rowSize)
  const n = Math.max(1, Math.round((top - bottom) / rowSize) + 1)
  const touched = []
  for (let i = 0; i < n; i++) {
    const price = Math.round((bottom + i * rowSize) * 100) / 100
    let row = rows.get(price)
    if (!row) rows.set(price, row = { price, ceVol: 0, peVol: 0, ce: 0, pe: 0 })
    for (const [key, value] of Object.entries(amounts)) row[key] += value / n
    touched.push(row)
  }
  return touched
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

// Adds option minutes into rows one at a time (`add` returns the rows it touched); `profile(side)` - the profile so far.
function optionDeltaAccumulator(rowSize) {
  const rows = new Map()
  const totals = { ce: 0, pe: 0 }
  let count = 0
  return {
    rows,
    add(m) {
      totals.ce += m.ce
      totals.pe += m.pe
      count++
      return spread(rows, m.low, m.high, rowSize, { ceVol: m.ceVol, peVol: m.peVol, ce: m.ce, pe: m.pe })
    },
    profile(side = 'net') {
      const pick = side === 'ce' ? (r) => [r.ceVol, r.ce] : side === 'pe' ? (r) => [r.peVol, r.pe] : (r) => [r.ceVol + r.peVol, r.ce - r.pe]
      const list = [...rows.values()].map((r) => { const [volume, delta] = pick(r); return { ...r, volume, delta } })
      return { ...finishDeltaProfile(list, rowSize), side, totals: { ce: totals.ce, pe: totals.pe, net: totals.ce - totals.pe }, minutes: count }
    },
  }
}

/**
 * The OPTIONS' delta profile over one or more SESSIONS - each an array of `optionDeltaMinutes` - `rowSize` (spot points
 * a row), `side` ('net' / 'ce' / 'pe'). Several sessions are a COMPOSITE: every minute of each laid on the rows it
 * covered, added up. Rows: [{ price, volume, delta, ce, pe, ceVol, peVol }] - volume and delta of the side picked, in
 * delta-weighted contracts; `totals` { ce, pe, net } (the sessions' deltas); `minutes` - the minutes counted.
 */
export function optionDeltaProfileOf(sessions, { rowSize = 5, side = 'net' } = {}) {
  const acc = optionDeltaAccumulator(rowSize)
  for (const minutes of sessions ?? []) for (const m of minutes ?? []) acc.add(m)
  return acc.profile(side)
}

/**
 * The NET option profile MINUTE BY MINUTE - what the Signal backtest reads: `past` (whole sessions before the day, each
 * `optionDeltaMinutes` - known before it opens) and then the day's `minutes` one at a time. `steps` [{ t, levels
 * (`deltaProfileLevels`), delta, volume, maxAbsDelta }] - the first (t -Infinity) the past alone, then one a minute: the
 * profile with every minute up to t, nothing after it; `history` - each row's delta as it changed ([t, delta] pairs, by
 * row price). `optionDeltaAt` reads them at a clock.
 */
export function optionDeltaSteps(past, minutes, { rowSize = 5 } = {}) {
  const acc = optionDeltaAccumulator(rowSize)
  for (const s of past ?? []) for (const m of s ?? []) acc.add(m)
  const summary = (t) => {
    const p = acc.profile('net')
    return { t, levels: deltaProfileLevels(p), delta: p.delta, volume: p.volume, maxAbsDelta: p.maxAbsDelta }
  }
  const history = new Map()
  for (const [price, r] of acc.rows) history.set(price, [[-Infinity, r.ce - r.pe]])
  const steps = [summary(-Infinity)]
  for (const m of minutes ?? []) {
    for (const r of acc.add(m)) {
      const h = history.get(r.price)
      if (h) h.push([m.t, r.ce - r.pe]); else history.set(r.price, [[m.t, r.ce - r.pe]])
    }
    steps.push(summary(m.t))
  }
  return { steps, history, rowSize }
}

// The last of `list` (sorted by its [0] / .t) at or before `t` - its index, -1 for none.
function lastAtOrBefore(list, t, at) {
  let lo = 0, hi = list.length - 1, found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (at(list[mid]) <= t) { found = mid; lo = mid + 1 } else hi = mid - 1
  }
  return found
}

/** `optionDeltaSteps` read at the clock `t` (ms - the minute starting then counts): the step - { levels, delta, volume,
 *  maxAbsDelta } - and `rowDelta(price)`, the net delta of the row holding `price` then (0 when none traded there). */
export function optionDeltaAt(read, t) {
  if (!read) return null
  const k = lastAtOrBefore(read.steps, t, (x) => x.t)
  if (k < 0) return null
  const step = read.steps[k]
  const rowDelta = (price) => {
    const h = Number.isFinite(price) ? read.history.get(Math.round(rowOf(price, read.rowSize) * 100) / 100) : null
    const j = h ? lastAtOrBefore(h, t, (x) => x[0]) : -1
    return j < 0 ? 0 : h[j][1]
  }
  return { ...step, rowDelta }
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

/**
 * A delta profile's LEVELS, as prices - what its cards draw and the Signal backtest reads: the volume profile's POC (the
 * middle of its row), VAH (the value area's top - the top of its top row), VAL (its bottom), ONE HVN and ONE LVN as the
 * Profiles page picks them (`volumeZones` on the profile's volume: the busiest row of the busy areas, the POC's aside -
 * `topHvn`; the thinnest row of the thin areas inside the range - `thinLvn`; null when there is none), and the rows with the
 * most BUYING (the largest + delta - `buy`) and the most SELLING (the largest − delta - `sell`), their middles. null for
 * a profile with no volume.
 */
export function deltaProfileLevels(profile) {
  const row = profile?.rowSize
  if (!profile?.rows?.length || profile.poc == null || !(row > 0)) return null
  const vz = volumeZones({ rows: profile.rows.map((r) => ({ price: r.price, total: Math.max(0, r.volume) })), poc: profile.poc }, row)
  let buy = null, sell = null
  for (const r of profile.rows) {
    if (r.delta > 0 && (!buy || r.delta > buy.delta)) buy = r
    if (r.delta < 0 && (!sell || r.delta < sell.delta)) sell = r
  }
  const mid = (price) => Math.round((price + row / 2) * 100) / 100
  return {
    poc: mid(profile.poc), vah: Math.round((profile.vah + row) * 100) / 100, val: profile.val,
    hvn: vz.topHvn ?? null, lvn: vz.thinLvn ?? null, buy: buy ? mid(buy.price) : null, sell: sell ? mid(sell.price) : null,
  }
}

/** The row holding `price` in a profile (its rows' bottoms, `rowSize` apart), or null - what the crosshair reads. */
export function rowAt(profile, price) {
  if (!profile?.rows?.length || !Number.isFinite(price) || !(profile.rowSize > 0)) return null
  const bottom = rowOf(price, profile.rowSize)
  return profile.rows.find((r) => Math.abs(r.price - bottom) < 1e-6) ?? null
}
