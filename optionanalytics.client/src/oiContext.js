// The day's options and futures OI as the Order Flow page reads it (useDayOi.js builds it, liveFeeds.js keeps it live):
// each strike's CE / PE minute series, the futures and the index - and the reads made from it: the OI part of the order
// flow bias, the market's OI picture (walls, max pain, the futures' regime) and sudden OI walls. It was part of the
// strategy scanner's engine (strategyEngine.js - removed with the scanner, on request); these are the parts the page,
// the profile / OI break alerts and the server's alert runner still read.

import { findSuddenWalls } from './suddenOi.js'

const MIN = 60_000
const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())
const istMinute = (ms) => Math.floor((ms / MIN + 330) % 1440) // minutes since IST midnight
const hm = (h, m) => h * 60 + m

function sortedSeries(points, lag = 0) {
  const byStrike = new Map()
  for (const p of points ?? []) {
    if (p.openInterest == null) continue
    const strike = Number(p.strike)
    if (!byStrike.has(strike)) byStrike.set(strike, [])
    byStrike.get(strike).push({ t: msOf(p.time) + lag, oi: p.openInterest, price: p.price, open: p.open ?? null, high: p.high ?? p.price, low: p.low ?? p.price })
  }
  for (const list of byStrike.values()) list.sort((a, b) => a.t - b.t)
  return byStrike
}

function valueAt(series, ms) {
  if (!series?.length || series[0].t > ms) return null
  let lo = 0
  let hi = series.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (series[mid].t <= ms) lo = mid; else hi = mid - 1
  }
  return series[lo]
}

// From an /api/oi-replay/{u}/run response (+ the day's expiry date, if known).
//
// Every point of a run is a 1-minute bar stamped at its START but holding its CLOSE (OI, premium,
// price at the minute's end). A replayed day (`live` false) stamps each point at its END instead
// (`lag`), so the replay clock - and Scan day - only ever read minutes that are over: at 12:11:00 the
// latest reading is 12:10's close, never 12:11's, which is a minute in the future. Live, the current
// minute's point holds the latest tick (useDayOi folds them in), so it is read as it comes.
export function buildOiContext(run, expiryDate = null, { live = false } = {}) {
  if (!run?.success) return null
  const lag = live ? 0 : MIN
  const futures = (run.futuresBars ?? []).map((b) => ({ t: msOf(b.time) + lag, close: b.close, oi: b.openInterest })).sort((a, b) => a.t - b.t)
  const spot = (run.spotCandlesOneMinute ?? run.spotCandles ?? []).map((c) => ({ t: msOf(c.time) + lag, close: c.close })).sort((a, b) => a.t - b.t)
  return {
    step: run.step || 50,
    lag,
    live,
    ce: sortedSeries(run.cePoints, lag),
    pe: sortedSeries(run.pePoints, lag),
    futures,
    spot,
    isExpiryDay: expiryDate != null && expiryDate === run.date,
    expiry: expiryDate,
    date: run.date,
  }
}

/** Today's LIVE context read the way a replay is (each minute once it is over) - for scanning today so
 *  far, minute by minute, without a minute's look-ahead. A replayed day's context is returned as is. */

function oiOf(map, strike, ms) {
  return valueAt(map.get(strike), ms)?.oi ?? null
}

function oiChange(map, strike, ms, minutes) {
  const now = oiOf(map, strike, ms)
  const then = oiOf(map, strike, ms - minutes * MIN)
  return now != null && then != null ? now - then : null
}

// Strike rows (CE / PE OI) as of `ms`.
function oiRows(oi, ms) {
  const strikes = new Set([...oi.ce.keys(), ...oi.pe.keys()])
  return [...strikes].sort((a, b) => a - b).map((strike) => ({ strike, ceOi: oiOf(oi.ce, strike, ms) ?? 0, peOi: oiOf(oi.pe, strike, ms) ?? 0 }))
}

export function maxPainOf(rows) {
  let best = null
  let bestPain = Infinity
  for (const c of rows) {
    let pain = 0
    for (const r of rows) pain += r.ceOi * Math.max(0, c.strike - r.strike) + r.peOi * Math.max(0, r.strike - c.strike)
    if (pain < bestPain) { bestPain = pain; best = c.strike }
  }
  return best
}

/**
 * The OPTIONS OI read every strategy is checked against - over the WHOLE option chain loaded for the
 * day (every strike, not just the ones near the money), on two clocks: the last `minutes` and since
 * the open. Put writing ahead of call writing = writers expect support (bullish); call writing ahead =
 * resistance (bearish).
 *   lean / leanOpen: (put OI added - call OI added) / (both added), -1..+1 (+ = puts written more =
 *     bullish) - damped when the change is too small to mean anything (noise).
 *   combined: 45% the recent lean, 55% the since-open one, nudged by the PCR's move since the open.
 * `near` (strikes each side of ATM) restricts it to the money - used only as an optional confirmation.
 */
export function optionOiRead(oi, spot, ms, minutes = 15, near = null) {
  if (!oi || !spot) return null
  const atm = Math.round(spot / oi.step) * oi.step
  const openMs = dayOpenMs(oi, ms)
  const strikes = near == null
    ? [...new Set([...oi.ce.keys(), ...oi.pe.keys()])]
    : Array.from({ length: 2 * near + 1 }, (_, i) => atm + (i - near) * oi.step)
  let peNow = 0, ceNow = 0, peChg = 0, ceChg = 0, peOpen = 0, ceOpen = 0, seen = 0
  for (const strike of strikes) {
    const pe = oiOf(oi.pe, strike, ms)
    const ce = oiOf(oi.ce, strike, ms)
    if (pe == null || ce == null) continue
    seen++
    peNow += pe
    ceNow += ce
    peChg += oiChange(oi.pe, strike, ms, minutes) ?? 0
    ceChg += oiChange(oi.ce, strike, ms, minutes) ?? 0
    peOpen += pe - (openOi(oi.pe, strike, openMs) ?? pe)
    ceOpen += ce - (openOi(oi.ce, strike, openMs) ?? ce)
  }
  if (!seen || peNow + ceNow <= 0 || ceNow <= 0) return null
  const total = peNow + ceNow
  const lean = (pe, ce, floor) => (pe - ce) / Math.max(Math.abs(pe) + Math.abs(ce), floor * total)
  const pcr = peNow / ceNow
  const pcrBefore = ceNow - ceChg > 0 ? (peNow - peChg) / (ceNow - ceChg) : pcr
  const pcrAtOpen = ceNow - ceOpen > 0 ? (peNow - peOpen) / (ceNow - ceOpen) : pcr
  const recent = lean(peChg, ceChg, 0.003)
  const sinceOpen = lean(peOpen, ceOpen, 0.01)
  const combined = Math.max(-1, Math.min(1, 0.45 * recent + 0.55 * sinceOpen + 0.2 * Math.max(-1, Math.min(1, (pcr - pcrAtOpen) / 0.2))))
  return {
    atm, minutes, near, strikes: seen, peNow, ceNow, peChg, ceChg, peOpen, ceOpen, net: peChg - ceChg,
    lean: recent, leanOpen: sinceOpen, combined, pcr, pcrChange: pcr - pcrBefore, pcrOpenChange: pcr - pcrAtOpen,
  }
}

// The day's first minute (the open) - from the index series, else the first OI point.
function dayOpenMs(oi, ms) {
  const first = oi.spot?.[0]?.t ?? oi.futures?.[0]?.t
  return first != null && first <= ms ? first : ms
}
function openOi(map, strike, openMs) {
  const series = map.get(strike)
  return valueAt(series, openMs)?.oi ?? series?.[0]?.oi ?? null
}

/** Options OI vs a trade's direction: 'agrees', 'neutral' or 'against'. */

const lakh = (v) => `${v >= 0 ? '+' : '-'}${(Math.abs(v) / 1e5).toFixed(1)}L`
export function optionOiText(read) {
  if (!read) return 'no options OI'
  const scope = read.near == null ? `chain (${read.strikes} strikes)` : `ATM ${read.atm} ±${read.near}`
  return `${scope}: since open puts ${lakh(read.peOpen)}, calls ${lakh(read.ceOpen)}, PCR ${read.pcr.toFixed(2)} (${read.pcrOpenChange >= 0 ? '+' : ''}${read.pcrOpenChange.toFixed(2)})`
    + ` · ${read.minutes}m puts ${lakh(read.peChg)}, calls ${lakh(read.ceChg)}`
}

/** Options OI and futures OI as parts of the order flow read (orderFlowBias's `extra`), each on two
 *  clocks - the last 15 min and since the open:
 *  options - put vs call writing over the whole chain, with the PCR's move (+ = puts written = bullish);
 *  futures - the price / OI regime (long build-up strongest bullish, short covering weaker; short
 *  build-up strongest bearish, long unwinding weaker). */
export function oiBiasParts(oi, ms) {
  const parts = []
  const spot = oi ? valueAt(oi.spot, ms)?.close : null
  if (!spot) return parts
  const read = optionOiRead(oi, spot, ms, 15)
  if (read) {
    const pcrNudge = (v) => 0.2 * Math.max(-1, Math.min(1, v / 0.15))
    parts.push({ name: 'Options OI · since open', weight: 15, score: Math.max(-1, Math.min(1, read.leanOpen + pcrNudge(read.pcrOpenChange))),
      detail: `chain puts ${lakh(read.peOpen)}, calls ${lakh(read.ceOpen)} · PCR ${read.pcr.toFixed(2)} (${read.pcrOpenChange >= 0 ? '+' : ''}${read.pcrOpenChange.toFixed(2)})` })
    parts.push({ name: 'Options OI · 15 min', weight: 10, score: Math.max(-1, Math.min(1, read.lean + pcrNudge(read.pcrChange))),
      detail: `chain puts ${lakh(read.peChg)}, calls ${lakh(read.ceChg)} · PCR ${read.pcrChange >= 0 ? '+' : ''}${read.pcrChange.toFixed(2)}` })
  }
  const futuresPart = (name, weight, f, scale, when) => {
    if (f?.oiPct == null) return
    const move = Math.max(-1, Math.min(1, f.pricePct / scale))
    const conviction = f.oiPct >= 0 ? 1 : 0.6
    const regime = f.pricePct >= 0 ? (f.oiPct >= 0 ? 'long build-up' : 'short covering') : (f.oiPct >= 0 ? 'short build-up' : 'long unwinding')
    parts.push({ name, weight, score: move * conviction, detail: `${regime} · price ${(f.pricePct * 100).toFixed(2)}%, OI ${f.oiPct >= 0 ? '+' : ''}${(f.oiPct * 100).toFixed(2)}% ${when}` })
  }
  futuresPart('Futures OI · since open', 10, futuresSince(oi, ms, dayOpenMs(oi, ms)), 0.005, 'since open')
  futuresPart('Futures OI · 15 min', 10, futuresChange(oi, ms, 15), 0.002, 'in 15m')
  return parts
}

/** Sudden OI walls (see suddenOi.js) on the chain at `ms`, biggest add first - none in the first 10
 *  minutes of the session (the open reshuffles OI everywhere). */
export function suddenOiWalls(oi, ms, options = {}) {
  const spot = oi ? valueAt(oi.spot, ms)?.close : null
  if (!spot || istMinute(ms) < hm(9, 25)) return []
  const strikes = [...new Set([...oi.ce.keys(), ...oi.pe.keys()])]
  return findSuddenWalls({ strikes, oiAt: (side, k, t) => oiOf(side === 'CE' ? oi.ce : oi.pe, k, t), ms, spot, step: oi.step, ...options })
}

/** What the scanner shows as the market's OI picture right now. */
export function oiSummary(oi, ms) {
  const spot = oi ? valueAt(oi.spot, ms)?.close : null
  if (!spot) return null
  const rows = oiRows(oi, ms)
  const { support, resistance } = wallsAt(oi, rows, spot)
  const f = futuresChange(oi, ms, 15)
  const regime = !f || f.oiPct == null ? null
    : f.pricePct >= 0 ? (f.oiPct >= 0 ? 'long build-up' : 'short covering') : (f.oiPct >= 0 ? 'short build-up' : 'long unwinding')
  return {
    spot, options: optionOiRead(oi, spot, ms, 15),
    support, supportChg: support != null ? oiChange(oi.pe, support, ms, 15) : null,
    resistance, resistanceChg: resistance != null ? oiChange(oi.ce, resistance, ms, 15) : null,
    maxPain: maxPainOf(rows.filter((r) => Math.abs(r.strike - spot) <= 15 * oi.step)),
    futures: f ? { ...f, regime } : null,
    sudden: suddenOiWalls(oi, ms).slice(0, 6),
  }
}

function futuresChange(oi, ms, minutes) {
  return futuresSince(oi, ms, ms - minutes * MIN)
}

function futuresSince(oi, ms, fromMs) {
  const now = valueAt(oi.futures, ms)
  const then = valueAt(oi.futures, fromMs) ?? (oi.futures?.[0]?.t <= ms ? oi.futures[0] : null)
  if (!now || !then || !then.close) return null
  return {
    pricePct: (now.close - then.close) / then.close,
    oiPct: now.oi && then.oi ? (now.oi - then.oi) / then.oi : null,
  }
}

// Walls around the index price: the biggest PUT OI strike at / below it (support) and the biggest
// CALL OI strike at / above it (resistance), within 8 strikes.
function wallsAt(oi, rows, spot) {
  const near = rows.filter((r) => Math.abs(r.strike - spot) <= 8 * oi.step)
  const below = near.filter((r) => r.strike <= spot + oi.step * 0.5)
  const above = near.filter((r) => r.strike >= spot - oi.step * 0.5)
  const support = below.reduce((a, r) => (r.peOi > (a?.peOi ?? 0) ? r : a), null)
  const resistance = above.reduce((a, r) => (r.ceOi > (a?.ceOi ?? 0) ? r : a), null)
  return { support: support?.strike ?? null, resistance: resistance?.strike ?? null }
}

// The strike with the biggest PUT (or CALL) OI ADDED since the open, as of `ms`.

export function vwapOf(minuteBars, ms) {
  let pv = 0
  let v = 0
  for (const b of minuteBars) {
    if (msOf(b.time) > ms) break
    const vol = (b.buy ?? 0) + (b.sell ?? 0)
    pv += ((b.high + b.low + b.close) / 3) * vol
    v += vol
  }
  return v > 0 ? pv / v : null
}
