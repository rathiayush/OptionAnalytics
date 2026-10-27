// The OI Replay page's entry checklist: for a CE buy and a PE buy, which of the conditions a good option-buying entry
// usually has are true at the replay clock (or now, live) - each from data up to that moment only:
//
//  - direction: spot above (CE) / below (PE) the session VWAP, else its 20-minute EMA when there is no VWAP;
//  - writers: over the last `windowMin` minutes (from the open, early on), PE OI added at ATM and the two strikes below
//    beats CE OI added at ATM and the two above (CE buy - put writers defending below), or the reverse (PE buy);
//  - no wall ahead: the strike just above spot (CE) / below (PE) does not hold one of the band's biggest OI walls
//    (at least `wallShare` of the side's largest, that largest `wallProminence` x the median), which price would have to
//    break first;
//  - option flow: over the last `windowMin` minutes CE CDV rose and PE CDV did not (CE buy), or the reverse (optionFlow.js);
//  - location: spot within `levelTolerance` of a previous-day volume-profile level (POC / VAH / VAL / HVN / LVN) -
//    entries at a level, not in the middle of nowhere;
//  - IV not stretched: the ATM option's IV now is at most `ivStretch` x its median so far today (buying after IV has
//    spiked tends to lose to the IV falling back);
//  - time: between 09:30 and 14:45 IST (not the opening whipsaw, not the last stretch where theta and the square-off bite);
//  - gamma (GEX, gex.js - `gex`: that minute under the Standard and the OI build-up sign): the dealers SHORT gamma - net GEX
//    negative, moves run instead of being damped and the premium decaying - with both signs agreeing (disagreeing: unknown);
//  - room to the GEX wall: the call wall (CE buy) / put wall (PE buy) at least `gexRoomSteps` strikes away in the trade's
//    direction, or none there - the move has room before the biggest hedging flows lean against it.
//
// A check without the data to judge it is `null` (shown as unknown), never a pass. Only the session of `asOfMs`'s day
// counts (09:15 on): before it - the index's pre-open prints, yesterday's VWAP, no option data yet - there is nothing to
// judge, and the result says when the session opens. It is a checklist, not a signal: it places nothing and alerts
// nothing.

import { optionFlowSeries } from './optionFlow.js'
import { gexAgreement } from './gex.js'

const MIN = 60_000
const DAY = 24 * 60 * MIN
const IST_OFFSET_MS = 330 * MIN
const SESSION_OPEN_MIN = 9 * 60 + 15

/** 09:15 IST of the IST day `ms` falls in (epoch ms). */
export function sessionOpenMs(ms) {
  return Math.floor((ms + IST_OFFSET_MS) / DAY) * DAY - IST_OFFSET_MS + SESSION_OPEN_MIN * MIN
}

const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())

/** The last entry of an ascending-by-`ms` array at or before `ms` (binary search), else null. */
function lastAtOrBefore(sorted, ms) {
  let lo = 0, hi = sorted.length - 1, found = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid].ms <= ms) { found = sorted[mid]; lo = mid + 1 } else hi = mid - 1
  }
  return found
}

/** Each strike's readings, ascending by time: `Map(strike -> [{ ms, oi, iv, price }])`. */
export function indexByStrike(points) {
  const byStrike = new Map()
  for (const p of points ?? []) {
    if (!p || !Number.isFinite(p.strike)) continue
    const ms = msOf(p.time)
    if (!Number.isFinite(ms)) continue
    let list = byStrike.get(p.strike)
    if (!list) byStrike.set(p.strike, list = [])
    list.push({ ms, oi: p.openInterest ?? null, iv: p.impliedVolatility ?? null, price: p.price ?? null })
  }
  for (const list of byStrike.values()) list.sort((a, b) => a.ms - b.ms)
  return byStrike
}

const oiAt = (index, strike, ms) => lastAtOrBefore(index.get(strike) ?? [], ms)?.oi ?? null

/** OI added (+) or cut (-) over (from, to] across `strikes` - from the strike's first reading of the day when `from` is
 *  before it (early in the session), as long as that is at least `minSpanMs` back; null when no strike can be measured. */
function oiChange(index, strikes, fromMs, toMs, minSpanMs = 5 * MIN) {
  let total = 0, seen = false
  for (const k of strikes) {
    const list = index.get(k) ?? []
    const first = list[0]
    const a = oiAt(index, k, fromMs) ?? (first && first.ms <= toMs - minSpanMs ? first.oi : null)
    const b = oiAt(index, k, toMs)
    if (a == null || b == null) continue
    total += b - a
    seen = true
  }
  return seen ? total : null
}

function ema(values, len) {
  const k = 2 / (len + 1)
  let e = null
  for (const v of values) e = e == null ? v : v * k + e * (1 - k)
  return e
}

const median = (values) => {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

const fmtM = (n) => `${n >= 0 ? '+' : ''}${(n / 1e6).toFixed(2)}M`
const fmtCr = (n) => (Number.isFinite(n) ? `${n < 0 ? '−' : ''}₹${Math.round(Math.abs(n) / 1e7).toLocaleString('en-IN')} Cr` : '-')

/**
 * The checklist at `asOfMs`. Inputs: the day's spot (`[{ time, close }]`), session VWAP (`[{ time, value }]`, may be
 * empty), the CE / PE option points (the OI Replay run's - time, strike, openInterest, impliedVolatility, price,
 * open / high / low / volume), the strike step, the previous day's volume profile (`{ poc, vah, val, hvn, lvn }`) and
 * optionally a precomputed `flow` (optionFlowSeries of the same points) and `gex` - the GEX at the clock under both signs
 * (`{ standard, buildup }`, gexDay minutes; absent = the gamma checks unknown). Times are ISO strings or epoch ms.
 * Returns `{ spot, atm, ce, pe }` - each side `{ checks: [{ key, label, pass, detail }], passed, judged, strikes }` - or
 * `{ waiting: true, opensAt }` before the session's first minute (null without spot or a strike step).
 */
export function entryChecklist({
  asOfMs, spotBars, vwap = [], cePoints, pePoints, step, profile = null, flow = null,
  ceIndex = null, peIndex = null, windowMin = 15, wallShare = 0.8, wallProminence = 1.5, levelTolerance = 0.0015, ivStretch = 1.1,
  gex = null, gexRoomSteps = 2,
}) {
  if (!(step > 0) || !(spotBars?.length)) return null
  const open = sessionOpenMs(asOfMs)
  const spots = spotBars.map((b) => ({ ms: msOf(b.time), close: b.close })).filter((b) => b.ms >= open && b.ms <= asOfMs && b.close > 0)
  if (spots.length === 0) return { waiting: true, opensAt: open }
  const spot = spots.at(-1).close
  const atm = Math.round(spot / step) * step
  const fromMs = asOfMs - windowMin * MIN
  const ce = ceIndex ?? indexByStrike(cePoints)
  const pe = peIndex ?? indexByStrike(pePoints)

  // Direction: VWAP, else EMA(20) of the closes so far.
  const vwapNow = (vwap ?? []).map((p) => ({ ms: msOf(p.time), value: p.value })).filter((p) => p.ms >= open && p.ms <= asOfMs && p.value > 0).at(-1)?.value
  const reference = vwapNow ?? (spots.length >= 5 ? ema(spots.map((b) => b.close), 20) : null)
  const refName = vwapNow != null ? 'VWAP' : 'EMA20'
  const direction = (side) => {
    if (reference == null) return { pass: null, detail: 'no VWAP yet' }
    const above = spot > reference
    return { pass: side === 'CE' ? above : spot < reference, detail: `spot ${spot.toFixed(1)} ${above ? 'above' : 'below'} ${refName} ${reference.toFixed(1)}` }
  }

  // Writers: puts written at / below ATM vs calls written at / above.
  const peAdded = oiChange(pe, [atm, atm - step, atm - 2 * step], fromMs, asOfMs)
  const ceAdded = oiChange(ce, [atm, atm + step, atm + 2 * step], fromMs, asOfMs)
  const writers = (side) => {
    if (peAdded == null || ceAdded == null) return { pass: null, detail: `not ${windowMin} min of OI yet` }
    const detail = `${windowMin} min: PE OI ${fmtM(peAdded)} at/below ATM, CE OI ${fmtM(ceAdded)} at/above`
    return { pass: side === 'CE' ? peAdded > 0 && peAdded > ceAdded : ceAdded > 0 && ceAdded > peAdded, detail }
  }

  // Wall ahead: the next strike in the trade's direction holding one of the side's biggest walls - a wall being a strike
  // that stands out (at least `wallShare` of the side's largest OI, and that largest well above the side's median).
  const wallAhead = (side) => {
    const index = side === 'CE' ? ce : pe
    const next = side === 'CE' ? Math.floor(spot / step) * step + step : Math.ceil(spot / step) * step - step
    const oi = oiAt(index, next, asOfMs)
    const all = [...index.keys()].map((k) => oiAt(index, k, asOfMs)).filter((v) => v > 0)
    const max = all.length ? Math.max(...all) : 0
    if (oi == null || max <= 0) return { pass: null, detail: 'no OI at the next strike' }
    const share = oi / max
    const standsOut = max >= wallProminence * median(all)
    const wall = standsOut && share >= wallShare
    return {
      pass: !wall,
      detail: standsOut
        ? `${side} OI at ${next} is ${Math.round(share * 100)}% of the biggest ${side} wall${wall ? ' - a wall right ahead' : ''}`
        : `no ${side} strike stands out (biggest ${(max / 1e6).toFixed(2)}M, near the median)`,
    }
  }

  // Option flow: CDV change over the window.
  const series = flow ?? optionFlowSeries(cePoints, pePoints, spotBars)
  const cdvAt = (s, ms) => lastAtOrBefore(s.map((p) => ({ ms: p.time, value: p.value })), ms)?.value ?? null
  const ceNow = cdvAt(series.ceCdv, asOfMs), ceThen = cdvAt(series.ceCdv, fromMs)
  const peNow = cdvAt(series.peCdv, asOfMs), peThen = cdvAt(series.peCdv, fromMs)
  const optionFlow = (side) => {
    if (ceNow == null || peNow == null) return { pass: null, detail: 'no option volume yet' }
    const ceDelta = ceNow - (ceThen ?? 0), peDelta = peNow - (peThen ?? 0)
    const detail = `${windowMin} min: CE CDV ${fmtM(ceDelta)}, PE CDV ${fmtM(peDelta)}`
    return { pass: side === 'CE' ? ceDelta > 0 && peDelta <= 0 : peDelta > 0 && ceDelta <= 0, detail }
  }

  // Location: the nearest previous-day level.
  const levels = profile
    ? [['POC', profile.poc], ['VAH', profile.vah], ['VAL', profile.val], ...(profile.hvn ?? []).map((p) => ['HVN', p]), ...(profile.lvn ?? []).map((p) => ['LVN', p])]
        .filter(([, p]) => Number.isFinite(p) && p > 0)
    : []
  const nearest = levels.map(([name, price]) => ({ name, price, away: Math.abs(spot - price) })).sort((a, b) => a.away - b.away)[0]
  const tolerance = spot * levelTolerance
  const location = nearest
    ? { pass: nearest.away <= tolerance, detail: `${nearest.away <= tolerance ? 'at' : 'nearest'} previous-day ${nearest.name} ${nearest.price.toFixed(1)} (${nearest.away.toFixed(1)} pts away)` }
    : { pass: null, detail: 'no previous-day profile' }

  // IV: the ATM option's IV now vs its median so far today (strikes within one step of today's ATM).
  const ivCheck = (side) => {
    const index = side === 'CE' ? ce : pe
    const now = lastAtOrBefore(index.get(atm) ?? [], asOfMs)?.iv
    const day = [atm - step, atm, atm + step].flatMap((k) => (index.get(k) ?? []).filter((r) => r.ms <= asOfMs && r.iv > 0).map((r) => r.iv))
    const mid = median(day)
    if (!(now > 0) || mid == null) return { pass: null, detail: 'no IV' }
    return { pass: now <= mid * ivStretch, detail: `ATM ${side} IV ${now.toFixed(1)} vs ${mid.toFixed(1)} median today` }
  }

  // Time: 09:30 - 14:45 IST.
  const istMinutes = Math.floor(((asOfMs + IST_OFFSET_MS) % (24 * 60 * MIN)) / MIN)
  const time = { pass: istMinutes >= 9 * 60 + 30 && istMinutes <= 14 * 60 + 45, detail: 'between 09:30 and 14:45' }

  // Gamma: dealers short gamma (net GEX negative) under both signs - the regime option buying wants.
  const gamma = () => {
    if (!gex?.standard || !gex?.buildup) return { pass: null, detail: 'no GEX yet' }
    const read = gexAgreement(gex.standard, gex.buildup)
    const nets = `net GEX ${fmtCr(gex.standard.net)} Standard, ${fmtCr(gex.buildup.net)} OI build-up`
    if (!read.agree) return { pass: null, detail: `${nets} - the two signs disagree` }
    return { pass: read.regime === 'negative', detail: `${nets} - ${read.regime === 'negative' ? 'dealers short gamma: moves run' : 'dealers long gamma: moves damped, premium decays'}` }
  }
  // Room to the GEX wall ahead (the walls are the same under both signs).
  const gexRoom = (name) => {
    const minute = gex?.standard
    if (!minute) return { pass: null, detail: 'no GEX yet' }
    const wall = name === 'CE' ? minute.callWall : minute.putWall
    const what = name === 'CE' ? 'call wall above' : 'put wall below'
    if (wall == null) return { pass: true, detail: `no GEX ${what} in the strikes loaded` }
    const room = name === 'CE' ? wall - spot : spot - wall
    return { pass: room >= gexRoomSteps * step, detail: `GEX ${what} ${wall}, ${room.toFixed(0)} pts away (${gexRoomSteps * step}+ wanted)` }
  }

  const premiumOf = (index, strike) => lastAtOrBefore(index.get(strike) ?? [], asOfMs)?.price ?? null
  const side = (name) => {
    const d = (fn) => fn(name)
    const checks = [
      { key: 'direction', label: name === 'CE' ? 'Spot above VWAP (EMA20 without it)' : 'Spot below VWAP (EMA20 without it)', ...d(direction) },
      { key: 'writers', label: name === 'CE' ? 'Put writers defending below' : 'Call writers capping above', ...d(writers) },
      { key: 'wall', label: name === 'CE' ? 'No CE wall just above' : 'No PE wall just below', ...d(wallAhead) },
      { key: 'flow', label: name === 'CE' ? 'Calls being bought (CE CDV up)' : 'Puts being bought (PE CDV up)', ...d(optionFlow) },
      { key: 'location', label: 'At a previous-day level', ...location },
      { key: 'iv', label: 'IV not stretched', ...d(ivCheck) },
      { key: 'time', label: 'Good time of day', ...time },
      { key: 'gamma', label: 'Gamma lets the move run (dealers short gamma)', ...gamma() },
      { key: 'gexRoom', label: name === 'CE' ? 'Room to the GEX call wall above' : 'Room to the GEX put wall below', ...d(gexRoom) },
    ]
    const index = name === 'CE' ? ce : pe
    const itm = name === 'CE' ? atm - step : atm + step
    return {
      checks,
      passed: checks.filter((c) => c.pass === true).length,
      judged: checks.filter((c) => c.pass != null).length,
      strikes: [{ label: 'ATM', strike: atm, premium: premiumOf(index, atm) }, { label: '1 ITM', strike: itm, premium: premiumOf(index, itm) }],
    }
  }
  return { spot, atm, ce: side('CE'), pe: side('PE') }
}
