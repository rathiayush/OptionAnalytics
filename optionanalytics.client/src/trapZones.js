// TRAPPED / SQUEEZE ZONES (asked for - "from the start of day you get the previous session's idea ... identify trapped zones,
// short squeeze zones ... keep updating as it goes ... a separate component"; and the trader's own rule: "when OI CE − PE is
// negative below the day's open - a bullish bunch of positions - and price moved up, it runs through the day; vice versa").
//
// The position profiles OI Replay already draws - OI (CE − PE), the net CE − PE flow (= the option CDV), the option OBV
// and the futures delta (left out when there is none) - are added into ONE composite profile (`compositeProfile` - each
// scaled by its own largest row, bullish positive), whose CLUSTERS - runs of adjacent rows of one sign, cut to their core
// (`compositeZones`) - are where the positions stacked up: profiles that agree make a zone strong, profiles that disagree
// cancel (no bullish and bearish zone on the same prices). A cluster is a group of positions opened at those prices, so
// where price is now against it says who is in profit and who is TRAPPED:
//   bullish cluster BELOW price  -> FLOOR: buyers / put writers in profit, they defend it (support);
//   bullish cluster ABOVE price  -> TRAPPED LONGS: buyers / put writers under water - their exits (selling futures, buying
//                                   back puts) are supply on the way down: a LONG LIQUIDATION zone;
//   bearish cluster ABOVE price  -> CEILING: sellers / call writers in profit, they defend it (resistance);
//   bearish cluster BELOW price  -> TRAPPED SHORTS: sellers / call writers under water - their covering (buying futures,
//                                   buying back calls) is fuel on the way up: a SHORT SQUEEZE zone.
// The same cluster changes role when price crosses it (yesterday's ceiling crossed = yesterday's sellers trapped = squeeze).
//
// BEFORE THE OPEN the previous session(s)' clusters are read against their last close (known before the day starts);
// THROUGH THE DAY the same zones are read against the price at the clock, the day's own clusters join them, and the OPEN
// RULE is checked minute by minute: the OI added at rows BELOW the day's open net CE − PE NEGATIVE (puts written under the
// open) with price ABOVE the open = a floor under a rising market - a trend-day-up setup; calls written above the open with
// price below it = trend-day-down. Every reading is built only from minutes up to the clock (the inputs are cut there).
// A read - it places nothing and feeds no strategy or alert.

import { futuresDeltaProfileOf, optionDeltaProfileOf } from './deltaProfile.js'
import { rowOf } from './orderFlowMath.js'

const MIN = 60_000
const minuteOf = (ms) => Math.floor(ms / MIN) * MIN
const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())
const round2 = (x) => Math.round(x * 100) / 100

export const TRAP_SOURCES = [
  { id: 'oi', name: 'OI (CE − PE)', short: 'OI' },
  { id: 'cdv', name: 'Net CE − PE (option CDV)', short: 'Net/CDV' },
  { id: 'obv', name: 'Option OBV', short: 'OBV' },
  { id: 'fut', name: 'Futures Δ', short: 'Fut' },
]

/** What each kind of zone means, its lean (+1 helps a rise, −1 a fall) and its colour. */
export const ZONE_KINDS = {
  support: { label: 'Floor', lean: 1, color: '#52c41a', text: 'buyers / put writers in profit below - they defend it' },
  trappedShorts: { label: 'Trapped shorts - squeeze fuel', lean: 1, color: '#13c2c2', text: 'sellers / call writers under water below - their covering pushes price up; a pullback into it is where they get out flat' },
  resistance: { label: 'Ceiling', lean: -1, color: '#ff4d4f', text: 'sellers / call writers in profit above - they defend it' },
  trappedLongs: { label: 'Trapped longs - liquidation fuel', lean: -1, color: '#fa8c16', text: 'buyers / put writers under water above - their exits are supply on any rally into it, and add to a fall' },
  insideBull: { label: 'Price inside a bullish cluster', lean: 0, color: '#95de64', text: 'the buyers\' own zone - holding it keeps them in control' },
  insideBear: { label: 'Price inside a bearish cluster', lean: 0, color: '#ff7875', text: 'the sellers\' own zone - holding under it keeps them in control' },
}

/** A cluster is kept when its size is at least this share of its profile's largest cluster; at most PER_SIDE a side. */
export const SIGNIFICANT = 0.2
export const PER_SIDE = 4
/** The open rule: the OI written on one side of the open must be at least this share of all the OI added that day. */
export const OPEN_RULE_SHARE = 0.15
/** A state of the open rule counts once it holds this many minutes in a row (no flicker). */
export const OPEN_RULE_HOLD = 3

/** The OI added at each spot row over `sessions` (each `optionOiMinutes` - { t, low, high, ce, pe }): [{ price, delta: ce − pe }]. */
export function oiRowsOf(sessions, rowSize) {
  const rows = new Map()
  for (const s of sessions ?? []) {
    for (const m of s ?? []) {
      if (!Number.isFinite(m.low) || !Number.isFinite(m.high)) continue
      const bottom = rowOf(m.low, rowSize), top = rowOf(m.high, rowSize)
      const n = Math.max(1, Math.round((top - bottom) / rowSize) + 1)
      for (let i = 0; i < n; i++) {
        const price = round2(bottom + i * rowSize)
        const r = rows.get(price) ?? { price, ce: 0, pe: 0 }
        r.ce += (m.ce ?? 0) / n
        r.pe += (m.pe ?? 0) / n
        rows.set(price, r)
      }
    }
  }
  return [...rows.values()].map((r) => ({ price: r.price, delta: r.ce - r.pe }))
}

/** A composite row under this share of its largest row is NEUTRAL - it ends a zone. */
export const NEUTRAL = 0.1
/** A zone is cut to the rows around its peak that hold this share of its run's total (its CORE - a tight band). */
export const CORE = 0.7
/** A profile is named on a zone when its own part over the zone's rows is at least this share of the zone's total. */
export const SOURCE_SHARE = 0.15

/**
 * THE COMPOSITE POSITIONING PROFILE (asked for - "use net CE − PE, OI CE − PE, option CDV and OBV and the futures delta
 * profile; if futures data is not present do not consider it"): every profile's rows put on ONE grid of spot rows, each
 * scaled by its own largest row (so no profile outweighs another by its units - OI in contracts, the flows in lots) and
 * signed BULLISH POSITIVE (the OI's CE − PE negated: puts written / calls unwound = bullish), then added row by row - where
 * the profiles agree the row is large, where they disagree they cancel. `sources` [{ id, rows: [{ price, delta }],
 * bullishNegative, shift }] - `shift` subtracted from a profile's prices (the futures' basis, so they read in spot terms;
 * rounded to the nearest row). A profile with no non-zero row is not used. { rows: [{ price, total, parts: { id: n } }]
 * (by price), used: [ids] }.
 */
export function compositeProfile(sources, rowSize) {
  const grid = new Map()
  const used = new Set()
  for (const s of sources ?? []) {
    const rows = (s.rows ?? []).filter((r) => Number.isFinite(r.price) && Number.isFinite(r.delta) && r.delta)
    const max = Math.max(0, ...rows.map((r) => Math.abs(r.delta)))
    if (!(max > 0)) continue
    used.add(s.id)
    for (const r of rows) {
      const price = rowOf(r.price - (s.shift ?? 0) + rowSize / 2, rowSize)
      const n = (s.bullishNegative ? -r.delta : r.delta) / max
      const g = grid.get(price) ?? { price, total: 0, parts: {} }
      g.total += n
      g.parts[s.id] = (g.parts[s.id] ?? 0) + n
      grid.set(price, g)
    }
  }
  return { rows: [...grid.values()].sort((a, b) => a.price - b.price), used: TRAP_SOURCES.map((x) => x.id).filter((id) => used.has(id)) }
}

/** The run's CORE: from its peak row out to the larger neighbour each step until CORE of the run's total is held. */
function coreOf(rows) {
  const abs = rows.map((r) => Math.abs(r.total))
  const total = abs.reduce((a, b) => a + b, 0)
  let i = abs.indexOf(Math.max(...abs)), j = i, held = abs[i]
  while (held < CORE * total - 1e-9) {
    const left = i > 0 ? abs[i - 1] : -1, right = j < rows.length - 1 ? abs[j + 1] : -1
    if (left < 0 && right < 0) break
    if (right > left) held += abs[++j]; else held += abs[--i]
  }
  return rows.slice(i, j + 1)
}

/**
 * The composite's ZONES: runs of adjacent rows of one sign (a neutral row - under NEUTRAL of the largest - or a gap ends
 * one), each cut to its CORE; kept at >= SIGNIFICANT of the largest zone's total, at most PER_SIDE a side. Each { bullish,
 * low, high, score (the peak row: 1 = one profile at its largest, up to the number of profiles agreeing there), sources
 * (the profiles behind it), against (profiles pushing the other way there) }, by price.
 */
export function compositeZones({ rows = [], used = [] } = {}, rowSize = 5) {
  const maxAbs = Math.max(0, ...rows.map((r) => Math.abs(r.total)))
  if (!(maxAbs > 0)) return []
  const runs = []
  let run = null
  for (const r of rows) {
    const sgn = Math.abs(r.total) >= NEUTRAL * maxAbs ? Math.sign(r.total) : 0
    if (sgn && run && run.sign === sgn && Math.abs(r.price - run.rows[run.rows.length - 1].price - rowSize) < 1e-6) { run.rows.push(r); continue }
    if (run) runs.push(run)
    run = sgn ? { sign: sgn, rows: [r] } : null
  }
  if (run) runs.push(run)
  const zones = runs.map((x) => {
    const core = coreOf(x.rows)
    const sum = core.reduce((a, r) => a + r.total, 0)
    const part = (id) => core.reduce((a, r) => a + (r.parts[id] ?? 0), 0)
    const named = (same) => used.filter((id) => { const p = part(id); return (same ? p * sum > 0 : p * sum < 0) && Math.abs(p) >= SOURCE_SHARE * Math.abs(sum) })
    return {
      bullish: x.sign > 0, low: core[0].price, high: round2(core[core.length - 1].price + rowSize), size: Math.abs(sum),
      score: round2(Math.max(...core.map((r) => Math.abs(r.total)))), sources: named(true), against: named(false),
    }
  })
  const max = Math.max(0, ...zones.map((z) => z.size))
  const keep = (bullish) => zones.filter((z) => z.bullish === bullish && z.size >= SIGNIFICANT * max).sort((a, b) => b.size - a.size).slice(0, PER_SIDE)
  return [...keep(true), ...keep(false)].sort((a, b) => a.low - b.low).map(({ size, ...z }) => z) // eslint-disable-line no-unused-vars
}

/** The zone's role against `price` (ZONE_KINDS). */
export function zoneKind(z, price) {
  if (!Number.isFinite(price)) return null
  if (price >= z.low && price <= z.high) return z.bullish ? 'insideBull' : 'insideBear'
  if (z.bullish) return z.high < price ? 'support' : 'trappedLongs'
  return z.low > price ? 'resistance' : 'trappedShorts'
}

const distancePct = (z, price) => (price >= z.low && price <= z.high ? 0 : (price > z.high ? z.high - price : z.low - price) / price * 100)

/**
 * The profiles of some sessions as ONE composite (compositeProfile) and its zones, in spot terms. `options` [{ items, oi }]
 * (optionDeltaMinutes / optionOiMinutes of each session), `futures` [[footprint bars]], `basis` = futures − spot. The
 * futures are LEFT OUT when they are not there (no bars - `futures: 'none'`) or cannot be put on spot (no basis -
 * 'noBasis'). The NET CE − PE flow IS the option CDV here (the option delta profile's Net side, the CDV / OBV profile's CDV
 * column - the same numbers), so it is counted once, as "Net / CDV". { zones, used, futures: 'used' | 'none' | 'noBasis' }.
 */
export function positionProfile({ options = [], futures = [], basis = null, rowSize = 5 }) {
  const items = options.map((s) => s.items ?? [])
  const sources = [
    { id: 'oi', rows: oiRowsOf(options.map((s) => s.oi ?? []), rowSize), bullishNegative: true },
    { id: 'cdv', rows: optionDeltaProfileOf(items, { rowSize, metric: 'cdv' }).rows },
    { id: 'obv', rows: optionDeltaProfileOf(items, { rowSize, metric: 'obv' }).rows },
  ]
  const hasFutures = (futures ?? []).some((f) => f?.length)
  const futStatus = !hasFutures ? 'none' : Number.isFinite(basis) ? 'used' : 'noBasis'
  if (futStatus === 'used') sources.push({ id: 'fut', rows: futuresDeltaProfileOf(futures, { rowSize }).rows, shift: basis })
  const profile = compositeProfile(sources, rowSize)
  return { zones: compositeZones(profile, rowSize), used: profile.used, futures: futStatus === 'used' && !profile.used.includes('fut') ? 'none' : futStatus }
}

/** The zones only (positionProfile). */
export function positionZones(args) { return positionProfile(args).zones }

/** The zones read against `price`: each with its kind and distance (% of price, + above), nearest first; and the LEAN -
 *  (helping a rise − helping a fall) / both, each zone's score weighted by nearness (1 / (1 + distance / 0.3%)). */
export function readZones(zones, price) {
  const read = zones.map((z) => ({ ...z, kind: zoneKind(z, price), distance: round2(distancePct(z, price)) }))
    .sort((a, b) => Math.abs(a.distance) - Math.abs(b.distance))
  let up = 0, down = 0
  for (const z of read) {
    const w = z.score / (1 + Math.abs(z.distance) / 0.3)
    const lean = ZONE_KINDS[z.kind]?.lean ?? 0
    if (lean > 0) up += w; else if (lean < 0) down += w
  }
  return { zones: read, lean: up + down > 0 ? round2((up - down) / (up + down)) : 0 }
}

const lastClose = (bars) => { for (let i = (bars?.length ?? 0) - 1; i >= 0; i--) if (bars[i]?.close > 0) return bars[i].close; return null }

/**
 * BEFORE THE OPEN: the previous session(s) - `prevOptions` [{ date, items, oi, candles }] and `prevFutures` [{ items }] -
 * read against the last session's close. { close, zones, lean, basis, used (the profiles read), futures (positionProfile) }.
 */
export function openingRead({ prevOptions = [], prevFutures = [], rowSize = 5 }) {
  const last = prevOptions[prevOptions.length - 1]
  const close = lastClose(last?.candles)
  const lastFut = prevFutures[prevFutures.length - 1]
  // The basis from the same session's two closes only - another day's futures would put their zones off by its own basis.
  const futClose = lastFut && (!last?.date || !lastFut.date || lastFut.date === last.date) ? lastClose(lastFut.items) : null
  const basis = close > 0 && futClose > 0 ? futClose - close : null
  const { zones, used, futures } = positionProfile({ options: prevOptions, futures: prevFutures.map((f) => f.items ?? []), basis, rowSize })
  return { close, basis, used, futures, ...readZones(zones, close) }
}

/**
 * THE OPEN RULE minute by minute over the day's OI minutes (`oi` - optionOiMinutes, up to the clock) and spot bars (ms):
 * the OI added at rows below / above the day's `open`; each minute's state 'bull' (puts written below the open - net CE − PE
 * there negative by >= OPEN_RULE_SHARE of all the OI added - and the close above the open), 'bear' (calls written above the
 * open, the close below it) or null, a state counting once it holds OPEN_RULE_HOLD minutes. { state, since, below, above,
 * gross, events: [{ t, state }] }.
 */
export function openRuleDay({ oi = [], spot = [], open, rowSize = 5 }) {
  const empty = { state: null, since: null, below: 0, above: 0, gross: 0, events: [] }
  if (!(open > 0)) return empty
  const closeAt = new Map(spot.map((b) => [minuteOf(msOf(b.time)), b.close]))
  const byMinute = new Map()
  for (const m of oi) { const t = minuteOf(m.t); if (!byMinute.has(t)) byMinute.set(t, []); byMinute.get(t).push(m) }
  const minutes = [...new Set([...closeAt.keys(), ...byMinute.keys()])].sort((a, b) => a - b)
  let below = 0, above = 0, gross = 0, close = open
  let state = null, since = null, cand = null, candFrom = null, run = 0
  const events = []
  for (const t of minutes) {
    for (const m of byMinute.get(t) ?? []) {
      if (!Number.isFinite(m.low) || !Number.isFinite(m.high)) continue
      const bottom = rowOf(m.low, rowSize), top = rowOf(m.high, rowSize)
      const n = Math.max(1, Math.round((top - bottom) / rowSize) + 1)
      for (let i = 0; i < n; i++) {
        const mid = bottom + i * rowSize + rowSize / 2
        const net = ((m.ce ?? 0) - (m.pe ?? 0)) / n
        if (mid < open) below += net; else if (mid > open) above += net
      }
      gross += Math.abs(m.ce ?? 0) + Math.abs(m.pe ?? 0)
    }
    if (closeAt.has(t)) close = closeAt.get(t)
    const need = OPEN_RULE_SHARE * gross
    const now = gross > 0 && below < 0 && -below >= need && close > open ? 'bull'
      : gross > 0 && above > 0 && above >= need && close < open ? 'bear' : null
    if (now === cand) run++; else { cand = now; candFrom = t; run = 1 }
    if (cand !== state && run >= OPEN_RULE_HOLD) {
      state = cand
      since = candFrom
      events.push({ t: candFrom, state })
    }
  }
  return { state, since, below, above, gross, events }
}

/**
 * Crossings of the previous session's zones (fixed all day) by the day's spot closes (ms, up to the clock): a bearish zone
 * closed ABOVE = its sellers trapped (short squeeze), a bullish zone closed BELOW = its buyers trapped (long liquidation);
 * back inside = the move failed. [{ t, type: 'shortSqueeze' | 'longLiquidation' | 'failedUp' | 'failedDown', zone }].
 */
export function zoneCrossings(zones, spot) {
  const events = []
  for (const z of zones) {
    let side = null
    for (const b of spot) {
      const c = b.close
      if (!(c > 0)) continue
      const now = c > z.high ? 'above' : c < z.low ? 'below' : 'inside'
      if (side && now !== side) {
        const t = minuteOf(msOf(b.time))
        if (!z.bullish && now === 'above') events.push({ t, type: 'shortSqueeze', zone: z })
        else if (z.bullish && now === 'below') events.push({ t, type: 'longLiquidation', zone: z })
        else if (!z.bullish && side === 'above') events.push({ t, type: 'failedUp', zone: z })
        else if (z.bullish && side === 'below') events.push({ t, type: 'failedDown', zone: z })
      }
      side = now
    }
  }
  return events.sort((a, b) => a.t - b.t)
}

const sign = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0)

/**
 * THROUGH THE DAY - everything up to the clock (the inputs are cut there): `opening` (openingRead), the day's `options`
 * minutes (optionDeltaMinutes) and `oi` (optionOiMinutes), `futures` footprint bars, `spot` bars (ms). { open, price,
 * zones (yesterday's and the day's, read against the price), lean, openRule, crossings, flows, verdict, reasons }.
 */
export function dayRead({ opening, options = [], oi = [], futures = [], spot = [], rowSize = 5 }) {
  const bars = spot.filter((b) => b?.close > 0)
  if (!bars.length) return null
  const open = bars[0].open > 0 ? bars[0].open : bars[0].close
  const price = bars[bars.length - 1].close
  const futClose = lastClose(futures)
  const basis = futClose > 0 ? futClose - price : null
  const own = positionProfile({ options: [{ items: options, oi }], futures: [futures], basis, rowSize })
  const today = own.zones.map((z) => ({ ...z, from: 'today' }))
  const prev = (opening?.zones ?? []).map(({ kind, distance, ...z }) => ({ ...z, from: 'prev' })) // eslint-disable-line no-unused-vars
  const { zones, lean } = readZones([...prev, ...today], price)
  const openRule = openRuleDay({ oi, spot: bars, open, rowSize })
  const crossings = zoneCrossings(prev, bars)
  const cdv = optionDeltaProfileOf([options], { rowSize, metric: 'cdv' }).totals.net
  const obv = optionDeltaProfileOf([options], { rowSize, metric: 'obv' }).totals.net
  const oiNet = oi.reduce((s, m) => s + (m.ce ?? 0) - (m.pe ?? 0), 0)
  const fut = futures.reduce((s, b) => s + (b.levels ?? []).reduce((x, l) => x + (l.buy ?? 0) - (l.sell ?? 0), 0), 0)
  const flows = { cdv: sign(cdv), obv: sign(obv), oi: -sign(oiNet), fut: futures.length ? sign(fut) : 0 }
  // The last crossing still standing: a squeeze while price is beyond the zone, gone once it is back inside.
  const live = [...crossings].reverse().find((e) => (e.type === 'shortSqueeze' && price > e.zone.high) || (e.type === 'longLiquidation' && price < e.zone.low))
  const reasons = []
  let score = 0
  if (openRule.state === 'bull') { score += 2; reasons.push('Open rule: puts written below the open and price above it - writers defend the floor (trend-day-up setup)') }
  if (openRule.state === 'bear') { score -= 2; reasons.push('Open rule: calls written above the open and price below it - writers defend the ceiling (trend-day-down setup)') }
  const flowSum = flows.cdv + flows.obv + flows.oi + flows.fut
  score += flowSum
  const named = (v) => TRAP_SOURCES.filter((s) => flows[s.id] === v).map((s) => s.short).join(', ')
  if (named(1)) reasons.push(`Bullish today: ${named(1)}`)
  if (named(-1)) reasons.push(`Bearish today: ${named(-1)}`)
  if (live) {
    score += live.type === 'shortSqueeze' ? 1 : -1
    reasons.push(live.type === 'shortSqueeze'
      ? `Short squeeze: price broke above yesterday's sellers' zone ${live.zone.low}–${live.zone.high} and holds above it`
      : `Long liquidation: price broke below yesterday's buyers' zone ${live.zone.low}–${live.zone.high} and holds below it`)
  }
  if (Math.abs(lean) >= 0.3) reasons.push(`Zones near price lean ${lean > 0 ? 'up (floors / trapped shorts closer)' : 'down (ceilings / trapped longs closer)'}`)
  const verdict = score >= 4 ? 'Strong bullish' : score >= 2 ? 'Bullish' : score <= -4 ? 'Strong bearish' : score <= -2 ? 'Bearish' : 'Mixed'
  return { open, price, basis, used: own.used, futures: own.futures, zones, lean, openRule, crossings, flows, score, verdict, reasons, liveSqueeze: live ?? null }
}

/**
 * THE DAY BIAS FROM THE OPEN (asked for - "from day starting, day bias"): fixed for the day once its first minute is in,
 * from what was known then - the previous session(s)' zones (`opening`), their last session's own flows and the open:
 *   the zones' lean at the previous close (floors / trapped shorts nearer = up), ±1;
 *   the zones re-read at the OPEN price (a gap can put price through a zone), ±1;
 *   a gap THROUGH a zone: opened above a ceiling the close was under (its sellers trapped at the open) +1, below a floor
 *   the close was over (its buyers trapped) −1;
 *   the last session's OI (puts written ahead = +1, calls = −1) and CDV (net buying +1 / selling −1).
 * `open` null = before the open: the same read without the open's parts ("pre-open"). { bias, score, reasons, open }.
 */
export function openingBias({ opening, prevOptions = [], open = null, rowSize = 5 }) {
  const reasons = []
  let score = 0
  const close = opening?.close
  const zones = opening?.zones ?? []
  if (Math.abs(opening?.lean ?? 0) >= 0.25) {
    score += opening.lean > 0 ? 1 : -1
    reasons.push(opening.lean > 0 ? 'At the previous close floors / trapped shorts were nearer than ceilings' : 'At the previous close ceilings / trapped longs were nearer than floors')
  }
  if (open > 0 && close > 0) {
    const atOpen = readZones(zones.map(({ kind, distance, ...z }) => z), open) // eslint-disable-line no-unused-vars
    if (Math.abs(atOpen.lean) >= 0.25) {
      score += atOpen.lean > 0 ? 1 : -1
      reasons.push(`At the open (${Math.round(open)}) the zones around price lean ${atOpen.lean > 0 ? 'up' : 'down'}`)
    }
    const upThrough = zones.find((z) => !z.bullish && close <= z.high && open > z.high)
    const downThrough = zones.find((z) => z.bullish && close >= z.low && open < z.low)
    if (upThrough) { score += 1; reasons.push(`Opened above the sellers' zone ${upThrough.low}–${upThrough.high}: they are trapped from the open`) }
    if (downThrough) { score -= 1; reasons.push(`Opened below the buyers' zone ${downThrough.low}–${downThrough.high}: they are trapped from the open`) }
  }
  const last = prevOptions[prevOptions.length - 1]
  if (last) {
    const oiNet = (last.oi ?? []).reduce((s, m) => s + (m.ce ?? 0) - (m.pe ?? 0), 0)
    if (oiNet) { score += oiNet < 0 ? 1 : -1; reasons.push(oiNet < 0 ? 'Last session: puts written ahead of calls (writers bullish)' : 'Last session: calls written ahead of puts (writers bearish)') }
    const cdv = optionDeltaProfileOf([last.items ?? []], { rowSize, metric: 'cdv' }).totals.net
    if (cdv) { score += cdv > 0 ? 1 : -1; reasons.push(cdv > 0 ? 'Last session: option CDV net buying' : 'Last session: option CDV net selling') }
  }
  const bias = score >= 3 ? 'Strong bullish' : score >= 1 ? 'Bullish' : score <= -3 ? 'Strong bearish' : score <= -1 ? 'Bearish' : 'Neutral'
  return { bias, score, reasons, open: open > 0 ? open : null }
}

/** The zones read against price split into SUPPORT below it (floors, trapped shorts) and RESISTANCE above it (ceilings,
 *  trapped longs), nearest first; a zone price is inside goes to the side its own cluster defends. */
export function supportResistance(zones) {
  const support = [], resistance = []
  for (const z of zones ?? []) {
    if (z.kind === 'support' || z.kind === 'trappedShorts' || z.kind === 'insideBull') support.push(z)
    else if (z.kind === 'resistance' || z.kind === 'trappedLongs' || z.kind === 'insideBear') resistance.push(z)
  }
  const near = (a, b) => Math.abs(a.distance) - Math.abs(b.distance)
  return { support: support.sort(near), resistance: resistance.sort(near) }
}

/** The day re-read every `stepMin` minutes (asked for - "continuously analyse these profiles and update the zones"): at
 *  each step only the minutes up to it, the changes from the step before - a NEW zone of the day's own (no same-side zone
 *  of the step before overlapped it), a zone that CHANGED ROLE against price, the verdict CHANGING. [{ t, type, ... }],
 *  oldest first. The steps end at the last completed step of the data given (nothing after it is read). */
export function dayTimeline({ opening, options = [], oi = [], futures = [], spot = [], rowSize = 5, stepMin = 5 }) {
  const bars = spot.filter((b) => b?.close > 0)
  if (!bars.length) return []
  const first = minuteOf(msOf(bars[0].time)), last = minuteOf(msOf(bars[bars.length - 1].time))
  const events = []
  let before = null
  const keyOf = (z) => `${z.from}|${z.bullish}|${z.low}|${z.high}`
  for (let t = first + (stepMin - 1) * MIN; t <= last; t += stepMin * MIN) {
    const upTo = (x) => minuteOf(msOf(x)) <= t
    const read = dayRead({
      opening, rowSize,
      options: options.filter((m) => m.t <= t), oi: oi.filter((m) => m.t <= t),
      futures: futures.filter((b) => upTo(b.time)), spot: bars.filter((b) => upTo(b.time)),
    })
    if (!read) continue
    if (before) {
      if (read.verdict !== before.verdict) events.push({ t, type: 'verdict', from: before.verdict, to: read.verdict })
      const oldToday = before.zones.filter((z) => z.from === 'today')
      for (const z of read.zones.filter((x) => x.from === 'today' && x.score >= 0.8)) {
        if (!oldToday.some((o) => o.bullish === z.bullish && o.low <= z.high && z.low <= o.high)) events.push({ t, type: 'newZone', zone: z })
      }
      const was = new Map(before.zones.filter((z) => z.from === 'prev').map((z) => [keyOf(z), z.kind]))
      for (const z of read.zones.filter((x) => x.from === 'prev')) {
        const k = was.get(keyOf(z))
        if (k && k !== z.kind) events.push({ t, type: 'roleChange', zone: z, fromKind: k })
      }
    }
    before = read
  }
  return events
}

const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}
/** Zones (read against price) as the boxes the primitive draws. */
export function zoneBoxes(zones, { showPrev = true, showToday = true } = {}) {
  return (zones ?? []).filter((z) => (z.from === 'today' ? showToday : showPrev)).map((z) => {
    const k = ZONE_KINDS[z.kind]
    const color = k?.color ?? '#8c8c8c'
    return {
      low: z.low, high: z.high,
      fill: hexA(color, Math.min(0.32, 0.1 + z.score * 0.06)), stroke: hexA(color, 0.85), dashed: z.from !== 'today',
      label: `${k?.label.split(' - ')[0] ?? ''} ${z.from === 'today' ? '(today)' : '(before)'} · ${z.sources.map((x) => TRAP_SOURCES.find((y) => y.id === x)?.short).join('+')}`,
      labelColor: color,
    }
  })
}


/**
 * TRADE SETUPS (asked for - "in this component only, suggest trade setups"): ideas from the read at the clock - never an
 * order. Each { id, name, side 'long' | 'short', option ('Buy CE' / 'Buy PE'), status 'ready' (price is at the trigger now)
 * or 'watch' (wait for it), entry, stop, targets [t1, t2?], rr (t1's reward / risk), entryText, why, aligned (with the day's
 * read - the verdict's score, else the bias from the open; null = no lean) }:
 *   FLOOR BOUNCE - the nearest support below (floor / trapped shorts): a dip into it that closes back above; stop under it.
 *   CEILING REJECTION - the nearest resistance above (ceiling / trapped longs): a rally into it that closes back below.
 *   SQUEEZE CONTINUATION - a short squeeze still standing: buy the retest of the broken sellers' zone (now support); the
 *     long liquidation the mirror.
 *   OPEN-RULE TREND - the open rule on: buy dips toward the open (the writers' floor), the mirror under the open.
 *   FAILED SQUEEZE - back inside a sellers' zone within 15 min of breaking above it: the breakout trapped its buyers - short,
 *     stop over the zone; the failed liquidation the mirror.
 * Targets are the next zones the other way (their near edge); none = no target given. Ready first, then those with the read,
 * then the better reward / risk; at most 4.
 */
export function tradeSetups({ day, bias = null, rowSize = 5 }) {
  if (!day || !(day.price > 0)) return []
  const price = day.price
  const buf = Math.max(rowSize, price * 0.0005)
  const lean = Math.sign(day.score || 0) || Math.sign(bias?.score || 0)
  const { support, resistance } = supportResistance(day.zones)
  const above = (x) => resistance.filter((z) => z.low > x).sort((a, b) => a.low - b.low).map((z) => z.low)
  const below = (x) => support.filter((z) => z.high < x).sort((a, b) => b.high - a.high).map((z) => z.high)
  const make = (o) => {
    const risk = Math.abs(o.entry - o.stop)
    const t1 = o.targets[0]
    const rr = Number.isFinite(t1) && risk > 0 ? round2(Math.abs(t1 - o.entry) / risk) : null
    const sideSign = o.side === 'long' ? 1 : -1
    return {
      ...o, entry: round2(o.entry), stop: round2(o.stop), targets: o.targets.slice(0, 2).map(round2), rr,
      option: o.side === 'long' ? 'Buy CE (or sell PE)' : 'Buy PE (or sell CE)',
      aligned: lean ? lean === sideSign : null,
    }
  }
  const out = []
  const zoneName = (z) => `${ZONE_KINDS[z.kind]?.label.split(' - ')[0]} ${z.low}–${z.high} (${z.sources.map((x) => TRAP_SOURCES.find((y) => y.id === x)?.short).join('+')})`
  const s = support[0]
  if (s) {
    const entry = Math.min(price, s.high)
    out.push(make({
      id: 'floorBounce', name: 'Floor bounce', side: 'long',
      status: price >= s.low - buf && price <= s.high * 1.0015 ? 'ready' : 'watch',
      entry, stop: s.low - buf, targets: above(entry),
      entryText: `On a dip into ${s.low}–${s.high} that closes back above ${s.high}`,
      why: `Nearest support: ${zoneName(s)} - its side defends it.`,
    }))
  }
  const r = resistance[0]
  if (r) {
    const entry = Math.max(price, r.low)
    out.push(make({
      id: 'ceilingReject', name: 'Ceiling rejection', side: 'short',
      status: price <= r.high + buf && price >= r.low * 0.9985 ? 'ready' : 'watch',
      entry, stop: r.high + buf, targets: below(entry),
      entryText: `On a rally into ${r.low}–${r.high} that closes back below ${r.low}`,
      why: `Nearest resistance: ${zoneName(r)} - its side defends it.`,
    }))
  }
  const live = day.liveSqueeze
  if (live) {
    const z = live.zone
    if (live.type === 'shortSqueeze') {
      out.push(make({
        id: 'squeezeLong', name: 'Short squeeze continuation', side: 'long',
        status: price <= z.high * 1.002 ? 'ready' : 'watch',
        entry: z.high, stop: z.low - buf, targets: above(Math.max(price, z.high)),
        entryText: `Buy the retest of ${z.high} (the broken sellers' zone, now support)`,
        why: `Price broke above the previous sellers' zone ${z.low}–${z.high} and holds - they are trapped and cover on the way up.`,
      }))
    } else {
      out.push(make({
        id: 'liquidationShort', name: 'Long liquidation continuation', side: 'short',
        status: price >= z.low * 0.998 ? 'ready' : 'watch',
        entry: z.low, stop: z.high + buf, targets: below(Math.min(price, z.low)),
        entryText: `Sell the retest of ${z.low} (the broken buyers' zone, now resistance)`,
        why: `Price broke below the previous buyers' zone ${z.low}–${z.high} and holds - they are trapped and sell on the way down.`,
      }))
    }
  }
  const rule = day.openRule?.state
  if (rule && day.open > 0) {
    const o = day.open
    if (rule === 'bull') {
      const floor = below(o)[0]
      out.push(make({
        id: 'openTrendLong', name: 'Open-rule trend day (up)', side: 'long',
        status: price <= o * 1.0025 ? 'ready' : 'watch',
        entry: Math.max(o, Math.min(price, o * 1.0025)), stop: Math.min(o - buf * 2, floor != null ? floor - buf : Infinity), targets: above(price),
        entryText: `Buy dips toward the open ${round2(o)} - trend days rarely give it back; trail the rest`,
        why: 'Puts written below the open with price above it: the writers defend the floor (your open rule).',
      }))
    } else {
      const ceil = above(o)[0]
      out.push(make({
        id: 'openTrendShort', name: 'Open-rule trend day (down)', side: 'short',
        status: price >= o * 0.9975 ? 'ready' : 'watch',
        entry: Math.min(o, Math.max(price, o * 0.9975)), stop: Math.max(o + buf * 2, ceil != null ? ceil + buf : -Infinity), targets: below(price),
        entryText: `Sell rallies toward the open ${round2(o)}; trail the rest`,
        why: 'Calls written above the open with price below it: the writers defend the ceiling (your open rule).',
      }))
    }
  }
  const lastT = day.crossings?.length ? Math.max(...day.crossings.map((e) => e.t)) : null
  const fresh = (day.crossings ?? []).filter((e) => lastT != null && lastT - e.t <= 15 * MIN)
  const failUp = [...fresh].reverse().find((e) => e.type === 'failedUp' && price >= e.zone.low && price <= e.zone.high)
  if (failUp) {
    const z = failUp.zone
    out.push(make({
      id: 'failedSqueeze', name: 'Failed squeeze - short the trap', side: 'short', status: 'ready',
      entry: price, stop: z.high + buf, targets: below(price),
      entryText: `Short while back inside ${z.low}–${z.high}; out on a close above ${z.high}`,
      why: 'Price broke above the sellers\' zone and fell back inside within 15 min - the breakout buyers are trapped.',
    }))
  }
  const failDown = [...fresh].reverse().find((e) => e.type === 'failedDown' && price >= e.zone.low && price <= e.zone.high)
  if (failDown) {
    const z = failDown.zone
    out.push(make({
      id: 'failedLiquidation', name: 'Failed breakdown - buy the trap', side: 'long', status: 'ready',
      entry: price, stop: z.low - buf, targets: above(price),
      entryText: `Buy while back inside ${z.low}–${z.high}; out on a close below ${z.low}`,
      why: 'Price broke below the buyers\' zone and came back inside within 15 min - the breakdown sellers are trapped.',
    }))
  }
  const rank = (x) => (x.status === 'ready' ? 0 : 2) + (x.aligned === false ? 1 : 0)
  return out.sort((a, b) => rank(a) - rank(b) || (b.rr ?? -1) - (a.rr ?? -1)).slice(0, 4)
}
