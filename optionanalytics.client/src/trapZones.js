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

import { deltaZones, futuresDeltaProfileOf, optionDeltaProfileOf } from './deltaProfile.js'
import { rowOf } from './orderFlowMath.js'

const MIN = 60_000
const minuteOf = (ms) => Math.floor(ms / MIN) * MIN
const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())
const round2 = (x) => Math.round(x * 100) / 100
const fmtPrice = (v) => (Math.round(v * 10) / 10).toLocaleString('en-IN')

export const TRAP_SOURCES = [
  { id: 'oi', name: 'OI (CE − PE)', short: 'OI' },
  { id: 'cdv', name: 'Net CE − PE (option CDV)', short: 'Net/CDV' },
  { id: 'obv', name: 'Option OBV', short: 'OBV' },
  { id: 'fut', name: 'Futures Δ', short: 'Fut' },
]

/** What each kind of zone means, its lean (+1 helps a rise, −1 a fall) and its colour. */
export const ZONE_KINDS = {
  support: { label: 'Floor', short: 'Floor', tiny: 'Floor', lean: 1, color: '#52c41a', text: 'buyers / put writers in profit below - they defend it' },
  trappedShorts: { label: 'Trapped shorts - squeeze fuel', short: 'Trapped shorts', tiny: 'Tr. shorts', lean: 1, color: '#13c2c2', text: 'sellers / call writers under water below - their covering pushes price up; a pullback into it is where they get out flat' },
  resistance: { label: 'Ceiling', short: 'Ceiling', tiny: 'Ceiling', lean: -1, color: '#ff4d4f', text: 'sellers / call writers in profit above - they defend it' },
  trappedLongs: { label: 'Trapped longs - liquidation fuel', short: 'Trapped longs', tiny: 'Tr. longs', lean: -1, color: '#fa8c16', text: 'buyers / put writers under water above - their exits are supply on any rally into it, and add to a fall' },
  insideBull: { label: 'Price inside a bullish cluster', short: 'Bull zone at price', tiny: 'Bull @ price', lean: 0, color: '#95de64', text: 'the buyers\' own zone - holding it keeps them in control' },
  insideBear: { label: 'Price inside a bearish cluster', short: 'Bear zone at price', tiny: 'Bear @ price', lean: 0, color: '#ff7875', text: 'the sellers\' own zone - holding under it keeps them in control' },
}

/** A cluster is kept when its size is at least this share of its profile's largest cluster; at most PER_SIDE a side. */
export const SIGNIFICANT = 0.2
export const PER_SIDE = 4
/** The open rule: the OI written on one side of the open must be at least this share of all the OI added that day. */
export const OPEN_RULE_SHARE = 0.15
/** The day's own zones count in full once the day has this many minutes, in proportion before (a few minutes' profile is
 *  noise against the sessions before). */
export const DAY_MATURE_MIN = 30
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
 * THE FIRST VERSION'S ZONES, kept to compare (asked for - "just to see this version as well, give a checkbox"): EACH PROFILE'S
 * OWN clusters (runs of adjacent rows of one sign in its own `parts`; a gap or the other sign ends one), kept at >=
 * SIGNIFICANT of that profile's largest, PER_SIDE a side, then clusters of the SAME side that overlap or touch joined into one
 * zone (the profiles behind it listed, `score` = the joined clusters' strengths added - 1 = one profile's largest). Nothing
 * cancels, so a bullish and a bearish zone can sit on the same prices, and joining touching clusters makes wide bands.
 * Same shape as compositeZones' zones (`against` empty), by price.
 */
export function unionZones({ rows = [], used = [] } = {}, rowSize = 5) {
  const clusters = []
  for (const id of used) {
    const runs = []
    let run = null
    for (const r of rows) {
      const v = r.parts?.[id] ?? 0
      const sgn = Math.sign(v)
      if (sgn && run && run.sign === sgn && Math.abs(r.price - run.top - rowSize) < 1e-6) { run.top = r.price; run.sum += v; continue }
      if (run) runs.push(run)
      run = sgn ? { sign: sgn, low: r.price, top: r.price, sum: v } : null
    }
    if (run) runs.push(run)
    const max = Math.max(0, ...runs.map((x) => Math.abs(x.sum)))
    if (!(max > 0)) continue
    for (const bullish of [true, false]) {
      runs.filter((x) => (x.sign > 0) === bullish && Math.abs(x.sum) >= SIGNIFICANT * max)
        .sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum)).slice(0, PER_SIDE)
        .forEach((x) => clusters.push({ source: id, bullish, low: x.low, high: round2(x.top + rowSize), strength: Math.abs(x.sum) / max }))
    }
  }
  const out = []
  for (const bullish of [true, false]) {
    let cur = null
    for (const c of clusters.filter((x) => x.bullish === bullish).sort((a, b) => a.low - b.low)) {
      if (cur && c.low <= cur.high + 1e-6) {
        cur.high = Math.max(cur.high, c.high)
        cur.score += c.strength
        if (!cur.sources.includes(c.source)) cur.sources.push(c.source)
        continue
      }
      if (cur) out.push(cur)
      cur = { bullish, low: c.low, high: c.high, sources: [c.source], score: c.strength }
    }
    if (cur) out.push(cur)
  }
  return out.sort((a, b) => a.low - b.low)
    .map((z) => ({ ...z, score: round2(z.score), sources: TRAP_SOURCES.map((x) => x.id).filter((id) => z.sources.includes(id)), against: [] }))
}

/** A Total (OI − Net) row is an OUTLIER when its size is past the median row's by this many robust deviations (Hampel's
 *  rule: median + Z x 1.4826 x MAD of the rows' sizes). */
export const OUTLIER_Z = 3

/**
 * THE HIGHEST TOTAL (OI − NET) AND ITS OUTLIERS (asked for - "can you also show the highest total OI net outlier"): the option
 * delta profile card's third column ("+ Total (OI − Net)") - at each price row the OI's CE − PE less the net CE − PE flow,
 * the flow scaled to the OI's size so both count equally - read from the composite's rows: each profile there is scaled by
 * its own largest row and signed bullish positive, so (parts.oi + parts.cdv) IS the card's Total divided by the OI's
 * largest row, sign flipped - the same rows, the same order (+ here = the card's negative = BULLISH: puts written and / or
 * calls bought). Needs both the OI and the flow (null otherwise). { bull, bear } - the HIGHEST row of each side { low, high,
 * level (the row's middle), total, times (its size over the median row's), outlier, kind (zoneKind against `price`) } or
 * null; `outliers` - the rows past the rule as BANDS (adjacent rows of one side joined, each with its peak row's level / size),
 * largest first (at most 6); `typical` - the median row's size.
 */
export function totalOutliers(rows = [], used = [], rowSize = 5, price = null) {
  if (!used.includes('oi') || !used.includes('cdv')) return null
  const list = (rows ?? []).map((r) => ({ price: r.price, total: (r.parts?.oi ?? 0) + (r.parts?.cdv ?? 0) })).filter((r) => Math.abs(r.total) > 1e-9)
  if (!list.length) return null
  const median = (xs) => { const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2 }
  const sizes = list.map((r) => Math.abs(r.total))
  const typical = median(sizes)
  const mad = median(sizes.map((x) => Math.abs(x - typical)))
  const cut = typical + OUTLIER_Z * 1.4826 * mad
  const view = (r) => {
    const bullish = r.total > 0
    const zone = { bullish, low: r.price, high: round2(r.price + rowSize) }
    return {
      low: zone.low, high: zone.high, level: round2(r.price + rowSize / 2), total: round2(r.total),
      times: typical > 0 ? round2(Math.abs(r.total) / typical) : null, outlier: mad > 0 ? Math.abs(r.total) > cut : false, kind: zoneKind(zone, price),
    }
  }
  const top = (bullish) => list.filter((r) => (r.total > 0) === bullish).sort((a, b) => Math.abs(b.total) - Math.abs(a.total))[0]
  const bull = top(true), bear = top(false)
  // The outlier rows as BANDS: adjacent rows of one side are one cluster, not several outliers - each band by its peak row.
  const bands = []
  if (mad > 0) {
    for (const r of list.filter((x) => Math.abs(x.total) > cut).sort((a, b) => a.price - b.price)) {
      const last = bands[bands.length - 1]
      if (last && (r.total > 0) === last.bullish && Math.abs(r.price - last.top - rowSize) < 1e-6) {
        last.top = r.price
        if (Math.abs(r.total) > Math.abs(last.peak.total)) last.peak = r
      } else bands.push({ bullish: r.total > 0, low: r.price, top: r.price, peak: r })
    }
  }
  return {
    bull: bull ? view(bull) : null, bear: bear ? view(bear) : null, typical: round2(typical),
    outliers: bands.sort((a, b) => Math.abs(b.peak.total) - Math.abs(a.peak.total)).slice(0, 6)
      .map((b) => ({ ...view(b.peak), low: b.low, high: round2(b.top + rowSize) })),
  }
}

/** How the zones are built: 'composite' (the default - one profile, disagreements cancel) or 'union' (the first version). */
export const ZONE_MODES = ['composite', 'union']

/**
 * LEVELS BY PROFILE (asked for - "is anything missing ... levels of OI net CE − PE, OBV, CDV, OI delta, net CE − PE, futures
 * delta"): the composite adds the profiles, so where two disagree they cancel and neither's level shows - here each profile
 * is read ON ITS OWN from the composite's rows (`parts` - scaled by its own largest row, bullish positive: OI CE − PE negated,
 * the futures already on spot): its strongest BULLISH cluster (adjacent rows of one sign, the largest added up - deltaZones'
 * green) and BEARISH one, each { low, high, level (the middle of its busiest row), kind (zoneKind against `price`) } or null.
 * One entry a profile READ (`used`), in TRAP_SOURCES' order: [{ id, bull, bear }]. The net CE − PE flow is the CDV ('cdv').
 */
export function profileLevels(rows = [], used = [], rowSize = 5, price = null) {
  return TRAP_SOURCES.filter((src) => used.includes(src.id)).map(({ id }) => {
    const own = rows.map((r) => ({ price: r.price, delta: r.parts?.[id] ?? 0 }))
    const { green, red } = deltaZones(own, rowSize)
    const of = (z, bullish) => {
      if (!z) return null
      let peak = null
      for (const r of own) if (r.price >= z.low - 1e-6 && r.price < z.high - 1e-6 && (bullish ? r.delta > 0 : r.delta < 0) && (!peak || Math.abs(r.delta) > Math.abs(peak.delta))) peak = r
      const zone = { bullish, low: z.low, high: z.high }
      return { low: z.low, high: z.high, level: round2((peak?.price ?? z.low) + rowSize / 2), kind: zoneKind(zone, price) }
    }
    return { id, bull: of(green, true), bear: of(red, false) }
  })
}

/**
 * The profiles of some sessions as ONE composite (compositeProfile) and its zones, in spot terms. `options` [{ items, oi }]
 * (optionDeltaMinutes / optionOiMinutes of each session), `futures` [[footprint bars]], `basis` = futures − spot. The
 * futures are LEFT OUT when they are not there (no bars - `futures: 'none'`) or cannot be put on spot (no basis -
 * 'noBasis'). The NET CE − PE flow IS the option CDV here (the option delta profile's Net side, the CDV / OBV profile's CDV
 * column - the same numbers), so it is counted once, as "Net / CDV". { zones, used, futures: 'used' | 'none' | 'noBasis' }.
 */
export function positionProfile({ options = [], futures = [], basis = null, rowSize = 5, mode = 'composite' }) {
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
  return { zones: mode === 'union' ? unionZones(profile, rowSize) : compositeZones(profile, rowSize), rows: profile.rows, used: profile.used, futures: futStatus === 'used' && !profile.used.includes('fut') ? 'none' : futStatus }
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

/** futures − spot AT THE SAME MINUTE: the last futures bar with a close against the spot close of that minute (the last
 *  spot bar at or before it, within 5 minutes); null when there is none. The two last closes could be minutes apart (a
 *  futures feed behind the spot's), and every futures zone would then sit off by the move in between. */
export function basisOf(futures, spot) {
  for (let i = (futures?.length ?? 0) - 1; i >= 0; i--) {
    const f = futures[i]
    if (!(f?.close > 0)) continue
    const t = minuteOf(msOf(f.time))
    for (let j = (spot?.length ?? 0) - 1; j >= 0; j--) {
      const b = spot[j]
      if (!(b?.close > 0)) continue
      const st = minuteOf(msOf(b.time))
      if (st > t) continue
      return t - st <= 5 * MIN ? f.close - b.close : null
    }
    return null
  }
  return null
}

/**
 * THE BIGGEST CDV SUPPORT AND RESISTANCE (asked for - "add the biggest CDV support and resistance of the previous day from
 * the start and the current developing"): the net CE − PE flow (CDV) profile of `sessions` (optionDeltaMinutes each), its
 * strongest BUYING cluster - adjacent rows of net buying, the largest added up (deltaZones' green) - = SUPPORT, its strongest
 * SELLING cluster = RESISTANCE. Each { low, high, level (the middle of the cluster's busiest row), sum (lots) } or null;
 * `net` the profile's total. The sessions before give it for the day from its start (fixed); the day's own minutes up to the
 * clock give the DEVELOPING one.
 */
export function cdvLevels(sessions, rowSize = 5) {
  const p = optionDeltaProfileOf(sessions, { rowSize, metric: 'cdv' })
  const { green, red } = deltaZones(p.rows, rowSize)
  const of = (z, sgn) => {
    if (!z) return null
    let peak = null
    for (const r of p.rows) if (r.price >= z.low - 1e-6 && r.price < z.high - 1e-6 && Math.sign(r.delta) === sgn && (!peak || Math.abs(r.delta) > Math.abs(peak.delta))) peak = r
    return { low: z.low, high: z.high, level: round2((peak?.price ?? z.low) + rowSize / 2), sum: z.sum }
  }
  return { support: of(green, 1), resistance: of(red, -1), net: p.totals?.net ?? 0 }
}

const lastClose = (bars) => { for (let i = (bars?.length ?? 0) - 1; i >= 0; i--) if (bars[i]?.close > 0) return bars[i].close; return null }

/**
 * BEFORE THE OPEN: the previous session(s) - `prevOptions` [{ date, items, oi, candles }] and `prevFutures` [{ items }] -
 * read against the last session's close. { close, zones, lean, basis, used (the profiles read), futures (positionProfile) }.
 */
export function openingRead({ prevOptions = [], prevFutures = [], rowSize = 5, mode = 'composite' }) {
  const last = prevOptions[prevOptions.length - 1]
  const close = lastClose(last?.candles)
  const lastFut = prevFutures[prevFutures.length - 1]
  // The basis from the same session's two closes only - another day's futures would put their zones off by its own basis.
  const sameDay = lastFut && (!last?.date || !lastFut.date || lastFut.date === last.date)
  const basis = sameDay && close > 0 ? basisOf(lastFut.items ?? [], last?.candles ?? []) : null
  const { zones, rows, used, futures } = positionProfile({ options: prevOptions, futures: prevFutures.map((f) => f.items ?? []), basis, rowSize, mode })
  return { close, basis, used, futures, rows, ...readZones(zones, close) }
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
export function dayRead({ opening, options = [], oi = [], futures = [], spot = [], rowSize = 5, mode = 'composite' }) {
  const bars = spot.filter((b) => b?.close > 0)
  if (!bars.length) return null
  const open = bars[0].open > 0 ? bars[0].open : bars[0].close
  const price = bars[bars.length - 1].close
  const basis = basisOf(futures, bars)
  const own = positionProfile({ options: [{ items: options, oi }], futures: [futures], basis, rowSize, mode })
  // Each profile is scaled by its own largest row, so a day of 3 minutes would give zones as strong as a whole session's:
  // the day's own zones count in full from its DAY_MATURE_MIN-th minute, less before it.
  const mature = Math.min(1, bars.length / DAY_MATURE_MIN)
  const today = own.zones.map((z) => ({ ...z, score: round2(z.score * mature), from: 'today' }))
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
  return { open, price, basis, used: own.used, futures: own.futures, rows: own.rows, zones, lean, openRule, crossings, flows, score, verdict, reasons, liveSqueeze: live ?? null }
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

const overlaps = (a, b) => !!a && !!b && a.low < b.high && b.low < a.high
const zoneKey = (z) => `${z.from ?? ''}|${z.bullish}|${z.low}|${z.high}`

/**
 * THE BEST ZONE (asked for - "identify the best zone and show it on the chart"): every zone read against price (readZones)
 * rated - its strength (score), x (1 + 0.5 per profile beyond the first agreeing), x (1 − 0.25 per profile against, at
 * least 0.4), x 1.5 when the other read built a zone of the same side on the same prices (the sessions before AND today),
 * x 1.3 for each biggest CDV level of its side inside it (`cdv` { prev, today } - cdvLevels: support for a bullish zone,
 * resistance for a bearish one), x nearness 1 / (1 + distance / 0.5%). { support, resistance, best } - the best of each side
 * (supportResistance's split) and the better of the two, each { zone, quality, reasons } or null.
 */
export function bestZones({ zones = [], cdv = {} } = {}) {
  const rate = (z) => {
    const reasons = []
    let q = z.score ?? 0
    const n = z.sources?.length ?? 0
    if (n > 1) { q *= 1 + 0.5 * (n - 1); reasons.push(`${n} profiles agree`) }
    if (z.against?.length) { q *= Math.max(0.4, 1 - 0.25 * z.against.length); reasons.push(`${z.against.length} against`) }
    if (zones.some((o) => o !== z && o.from !== z.from && o.bullish === z.bullish && overlaps(o, z))) {
      q *= 1.5
      reasons.push('the sessions before and today both built it')
    }
    const side = z.bullish ? 'support' : 'resistance'
    for (const [key, name] of [['prev', 'previous'], ['today', 'today\'s']]) {
      if (overlaps(cdv[key]?.[side], z)) { q *= 1.3; reasons.push(`${name} biggest CDV ${side} in it`) }
    }
    q /= 1 + Math.abs(z.distance ?? 0) / 0.5
    return { zone: z, quality: round2(q), reasons }
  }
  const { support, resistance } = supportResistance(zones)
  const top = (list) => list.map(rate).sort((a, b) => b.quality - a.quality)[0] ?? null
  const sup = top(support), res = top(resistance)
  return { support: sup, resistance: res, best: !sup ? res : !res ? sup : sup.quality >= res.quality ? sup : res }
}

/** The day re-read every `stepMin` minutes (asked for - "continuously analyse these profiles and update the zones"): at
 *  each step only the minutes up to it, the changes from the step before - a NEW zone of the day's own (no same-side zone
 *  of the step before overlapped it), a zone that CHANGED ROLE against price, the verdict CHANGING. [{ t, type, ... }],
 *  oldest first. The steps end at the last completed step of the data given (nothing after it is read). */
export function dayTimeline({ opening, options = [], oi = [], futures = [], spot = [], rowSize = 5, stepMin = 5, mode = 'composite' }) {
  const bars = spot.filter((b) => b?.close > 0)
  if (!bars.length) return []
  const first = minuteOf(msOf(bars[0].time)), last = minuteOf(msOf(bars[bars.length - 1].time))
  const events = []
  let before = null
  const keyOf = (z) => `${z.from}|${z.bullish}|${z.low}|${z.high}`
  for (let t = first + (stepMin - 1) * MIN; t <= last; t += stepMin * MIN) {
    const upTo = (x) => minuteOf(msOf(x)) <= t
    const read = dayRead({
      opening, rowSize, mode,
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

/** A "nice" axis step - 1, 2, 2.5 or 5 x a power of ten - giving about `count` ticks over `range`. */
function niceStep(range, count) {
  const raw = range / Math.max(1, count)
  const pow = 10 ** Math.floor(Math.log10(raw))
  return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((x) => x >= raw) ?? 10 * pow
}

/**
 * THE LADDER, drawn to scale (asked for - "previous day, current day like the older way, so I know what is happening"): a
 * price scale of `price` ± `span` and two lanes - the PREVIOUS day(s)' zones ('prev') and the CURRENT day's ('today') -
 * each zone a band at its real price (clipped to the scale, at least 3 px tall), the price lines (`marks` [{ price, label,
 * color, dashed }] - open, previous close, the CDV levels; the price itself always) across both. One read's zones never
 * overlap (compositeZones), so neither do a lane's bands; the LABELS are what could: a lane's labels are placed from the
 * top down at their band's middle, pushed down by `labelPx` when they would touch the one above, and a label pushed off its
 * band (more than half a label past it) is DROPPED - the band stays; the lines' labels sit in a gutter, pushed apart the
 * same way (none dropped - a line's label may sit off its line, joined to it by a leader). `height` px, `pad` above and
 * below. `rows` { prev, today } (the composite rows of each read) also give each lane's PROFILE STRIPS - every profile's own
 * part at each row (`rowSize` points). { lo, hi, ticks: [{ price, y }], bands: [{ zone, lane, top, height, mid, labelY |
 * null }], lines: [{ price, label, color, dashed, now, y, labelY }], strips: [{ lane, id, price, top, height, value }] } or
 * null without a price.
 */
export function ladderLayout({ zones = [], price, marks = [], span = 0.01, height = 340, pad = 14, labelPx = 14, rows = null, rowSize = 5 } = {}) {
  if (!(price > 0)) return null
  const lo = price * (1 - span), hi = price * (1 + span)
  const y = (v) => pad + ((hi - v) / (hi - lo)) * (height - 2 * pad)
  const step = niceStep(hi - lo, 6)
  const ticks = []
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push({ price: round2(v), y: y(v) })
  const bands = []
  for (const lane of ['prev', 'today']) {
    const list = zones.filter((z) => (z.from === 'today' ? 'today' : 'prev') === lane && z.high > lo && z.low < hi)
      .map((zone) => {
        const top = y(Math.min(zone.high, hi)), bottom = y(Math.max(zone.low, lo))
        const h = Math.max(3, bottom - top)
        return { zone, lane, top: bottom - top < 3 ? (top + bottom) / 2 - 1.5 : top, height: h, mid: (top + bottom) / 2 }
      })
      .sort((p, q) => p.mid - q.mid)
    let last = -Infinity
    for (const b of list) {
      const want = Math.max(b.mid, last + labelPx)
      const fits = want <= b.top + b.height + labelPx / 2 && want <= height - pad / 2
      b.labelY = fits ? want : null
      if (fits) last = want
      bands.push(b)
    }
  }
  const lines = [{ price, label: 'Price', color: '#1677ff', now: true }, ...marks]
    .filter((m) => Number.isFinite(m.price) && m.price >= lo && m.price <= hi)
    .map((m) => ({ dashed: false, now: false, ...m, y: y(m.price) }))
    .sort((p, q) => p.y - q.y)
  let prev = -Infinity
  for (const l of lines) { l.labelY = Math.max(l.y, prev + labelPx); prev = l.labelY }
  // Pushed past the bottom: move the stack up as one, keeping the spacing.
  const over = lines.length ? lines[lines.length - 1].labelY - (height - pad / 2) : 0
  if (over > 0) for (let i = lines.length - 1, floor = height - pad / 2; i >= 0; i--) { lines[i].labelY = Math.min(lines[i].labelY, floor); floor = lines[i].labelY - labelPx }
  // THE PROFILE STRIPS: each lane's composite rows (`rows` { prev, today }) cut into one strip a profile - every row's own
  // part (bullish +) where it is at least 5% of that profile's largest, clipped to the scale.
  const strips = []
  for (const lane of ['prev', 'today']) {
    for (const r of rows?.[lane] ?? []) {
      if (!(r.price + rowSize > lo && r.price < hi)) continue
      const top = y(Math.min(r.price + rowSize, hi)), bottom = y(Math.max(r.price, lo))
      for (const [id, value] of Object.entries(r.parts ?? {})) if (Math.abs(value) >= 0.05) strips.push({ lane, id, price: r.price, top, height: Math.max(1, bottom - top), value })
    }
  }
  return { lo, hi, ticks, bands, lines, strips }
}

const hexA = (hex, a) => {
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`
}
/** Zones (read against price) as the boxes the primitive draws. `best` (bestZones): its best support / resistance drawn
 *  first (their labels placed first), brighter, a thicker outline and a ★ label - shown even when their layer is hidden. */
/**
 * THE SPOT READOUT over the card's chart (asked about - "this component spot price does not move"): the price on the axis is
 * one of seven labels stacked at the same level (the CDV and Total lines, the open, the previous close), so a live price that
 * had stopped looked just like one that was moving. `spotFeedRead(bars, asOfMs, { live, inSession })` - the last spot minute
 * and its close, and, LIVE inside the session, how far behind the clock its end is: more than `SPOT_STALE_MS` (2 min - the
 * forming minute is never that old) = the feed is behind, said on the card with the minute it stopped at. Never for a
 * replayed day (its clock is the slider) or outside the session. { price, minute, behindMs, stale } or null with no bar.
 */
export const SPOT_STALE_MS = 2 * 60_000
export function spotFeedRead(bars = [], asOfMs = null, { live = false, inSession = true } = {}) {
  let last = null
  for (let i = (bars?.length ?? 0) - 1; i >= 0; i--) if (bars[i]?.close > 0 && Number.isFinite(bars[i].time)) { last = bars[i]; break }
  if (!last) return null
  const behind = live && inSession && Number.isFinite(asOfMs) ? asOfMs - (last.time + 60_000) : 0
  return { price: last.close, minute: last.time, behindMs: Math.max(0, behind), stale: behind > SPOT_STALE_MS }
}

/**
 * THE PRICE SCALE OF THE CARD'S SPOT CHART (asked about - "this component spot price does not move"): the candles' own range
 * (`low` - `high`, what the chart shows) widened to take in the zones just off them - but only up to `reach` each way,
 * `ZONE_REACH_RANGE` x the candles' range or `ZONE_REACH_PRICE` of the price, whichever is more - and each zone only as far
 * as that. The scale used to hold every zone within 1% of price whole, so a floor from the day before a point and a half
 * under the candles stretched it until a minute's move was a pixel and the live candle looked stuck. A zone beyond the reach
 * stays in the ladder and the table; here it is a band running off the edge. { min, max } or null with no range.
 */
export const ZONE_REACH_RANGE = 0.75
export const ZONE_REACH_PRICE = 0.0025
export function zoneScaleRange(low, high, zones = [], price = null) {
  if (!Number.isFinite(low) || !Number.isFinite(high) || high < low) return null
  const ref = Number.isFinite(price) && price > 0 ? price : (low + high) / 2
  const reach = Math.max((high - low) * ZONE_REACH_RANGE, ref * ZONE_REACH_PRICE)
  const lo = low - reach
  const hi = high + reach
  let min = low
  let max = high
  for (const z of zones ?? []) {
    if (!Number.isFinite(z?.low) || !Number.isFinite(z?.high) || z.high < lo || z.low > hi) continue
    min = Math.min(min, Math.max(z.low, lo))
    max = Math.max(max, Math.min(z.high, hi))
  }
  return { min, max }
}

export function zoneBoxes(zones, { showPrev = true, showToday = true, best = null } = {}) {
  const starred = new Map([[best?.support?.zone, 'support'], [best?.resistance?.zone, 'resistance']].filter(([z]) => z).map(([z, side]) => [zoneKey(z), side]))
  const list = (zones ?? []).filter((z) => starred.has(zoneKey(z)) || (z.from === 'today' ? showToday : showPrev))
  return [...list.filter((z) => starred.has(zoneKey(z))), ...list.filter((z) => !starred.has(zoneKey(z)))].map((z) => {
    const k = ZONE_KINDS[z.kind]
    const color = k?.color ?? '#8c8c8c'
    const star = starred.get(zoneKey(z))
    const name = `${k?.label.split(' - ')[0] ?? ''} ${fmtPrice(z.low)}–${fmtPrice(z.high)} ${z.from === 'today' ? '(today)' : '(before)'} · ${z.sources.map((x) => TRAP_SOURCES.find((y) => y.id === x)?.short).join('+')}`
    return {
      low: z.low, high: z.high,
      fill: hexA(color, star ? 0.4 : Math.min(0.32, 0.1 + z.score * 0.06)), stroke: hexA(color, star ? 1 : 0.85), dashed: !star && z.from !== 'today',
      lineWidth: star ? 2 : 1,
      label: star ? `★ BEST ${star.toUpperCase()} · ${name}` : name,
      labelColor: color,
    }
  })
}


/**
 * TRADE SETUPS (asked for - "in this component only, suggest trade setups"): ideas from the read at the clock - never an
 * order. Each { id, name, side 'long' | 'short', option ('Buy CE' / 'Buy PE'), status 'ready' (price is at the trigger now)
 * or 'watch' (wait for it), entry, stop, targets [t1, t2?], rr (t1's reward / risk), entryText, why, aligned (with the day's
 * read - the verdict's score, else the bias from the open; null = no lean) }:
 *   FLOOR BOUNCE - the best support (`best` - bestZones; none given: the nearest): a dip into it that closes back above;
 *     stop under it.
 *   CEILING REJECTION - the best resistance (else the nearest): a rally into it that closes back below.
 *   SQUEEZE CONTINUATION - a short squeeze still standing: buy the retest of the broken sellers' zone (now support); the
 *     long liquidation the mirror.
 *   OPEN-RULE TREND - the open rule on: buy dips toward the open (the writers' floor), the mirror under the open.
 *   FAILED SQUEEZE - back inside a sellers' zone within 15 min of breaking above it: the breakout trapped its buyers - short,
 *     stop over the zone; the failed liquidation the mirror.
 * Targets are the next zones the other way (their near edge); none = no target given. Ready first, then those with the read,
 * then the better reward / risk; at most 4.
 */
export function tradeSetups({ day, bias = null, rowSize = 5, best = null }) {
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
  // The bounce / rejection trade the BEST zone of each side (bestZones - strength, agreement, nearness), not merely the
  // nearest: a weak cluster next to price is noise, not a level anyone defends.
  const s = best?.support?.zone ?? support[0]
  if (s) {
    const entry = Math.min(price, s.high)
    out.push(make({
      id: 'floorBounce', name: 'Floor bounce', side: 'long',
      status: price >= s.low - buf && price <= s.high * 1.0015 ? 'ready' : 'watch',
      entry, stop: s.low - buf, targets: above(entry),
      entryText: `On a dip into ${s.low}–${s.high} that closes back above ${s.high}`,
      why: `${best?.support ? 'Best' : 'Nearest'} support: ${zoneName(s)} - its side defends it.`,
    }))
  }
  const r = best?.resistance?.zone ?? resistance[0]
  if (r) {
    const entry = Math.max(price, r.low)
    out.push(make({
      id: 'ceilingReject', name: 'Ceiling rejection', side: 'short',
      status: price <= r.high + buf && price >= r.low * 0.9985 ? 'ready' : 'watch',
      entry, stop: r.high + buf, targets: below(entry),
      entryText: `On a rally into ${r.low}–${r.high} that closes back below ${r.low}`,
      why: `${best?.resistance ? 'Best' : 'Nearest'} resistance: ${zoneName(r)} - its side defends it.`,
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
