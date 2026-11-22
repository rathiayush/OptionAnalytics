// TRAPPED / SQUEEZE ZONES (asked for - "from the start of day you get the previous session's idea ... identify trapped zones,
// short squeeze zones ... keep updating as it goes ... a separate component"; and the trader's own rule: "when OI CE − PE is
// negative below the day's open - a bullish bunch of positions - and price moved up, it runs through the day; vice versa").
//
// The four position profiles OI Replay already draws - OI (CE − PE), the option CDV, the option OBV and the futures delta -
// each give CLUSTERS: runs of adjacent price rows where one side stacked up (`profileRuns`). A cluster is a group of
// positions opened at those prices, so where price is now against it says who is in profit and who is TRAPPED:
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
  { id: 'cdv', name: 'Option CDV', short: 'CDV' },
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

/** Every run of ADJACENT rows (each one row size above the last) of one sign: [{ low, high, sum, rows, bullish }]. Bullish =
 *  positive delta, or negative when `bullishNegative` (OI: puts written / calls unwound). */
export function profileRuns(rows, rowSize, { bullishNegative = false } = {}) {
  const list = (rows ?? []).filter((r) => Number.isFinite(r.price) && Number.isFinite(r.delta)).sort((a, b) => a.price - b.price)
  const out = []
  let run = null
  const close = () => {
    if (run) out.push({ low: run.low, high: round2(run.top + rowSize), sum: run.sum, rows: run.rows, bullish: bullishNegative ? run.sum < 0 : run.sum > 0 })
    run = null
  }
  for (const r of list) {
    const sign = Math.sign(r.delta)
    if (!sign) { close(); continue }
    if (run && sign === run.sign && Math.abs(r.price - run.top - rowSize) < 1e-6) { run.top = r.price; run.sum += r.delta; run.rows++; continue }
    close()
    run = { sign, low: r.price, top: r.price, sum: r.delta, rows: 1 }
  }
  close()
  return out
}

/** One profile's significant clusters: `source`, each { source, bullish, low, high, strength (0 - 1 of its largest) },
 *  `shift` subtracted from the prices (the futures' basis, so they read in spot terms). */
export function sourceZones(source, rows, rowSize, { bullishNegative = false, shift = 0 } = {}) {
  const runs = profileRuns(rows, rowSize, { bullishNegative })
  const max = Math.max(0, ...runs.map((r) => Math.abs(r.sum)))
  if (!(max > 0)) return []
  const keep = (bullish) => runs.filter((r) => r.bullish === bullish && Math.abs(r.sum) >= SIGNIFICANT * max)
    .sort((a, b) => Math.abs(b.sum) - Math.abs(a.sum)).slice(0, PER_SIDE)
  return [...keep(true), ...keep(false)].map((r) => ({
    source, bullish: r.bullish, low: round2(r.low - shift), high: round2(r.high - shift), strength: Math.abs(r.sum) / max,
  }))
}

/** Clusters of the same side that overlap (or touch) joined into one zone: { bullish, low, high, sources, score }. */
export function mergeZones(zones) {
  const out = []
  for (const bullish of [true, false]) {
    const list = zones.filter((z) => z.bullish === bullish).sort((a, b) => a.low - b.low)
    let cur = null
    for (const z of list) {
      if (cur && z.low <= cur.high + 1e-6) {
        cur.high = Math.max(cur.high, z.high)
        cur.score += z.strength
        if (!cur.sources.includes(z.source)) cur.sources.push(z.source)
        continue
      }
      if (cur) out.push(cur)
      cur = { bullish, low: z.low, high: z.high, sources: [z.source], score: z.strength }
    }
    if (cur) out.push(cur)
  }
  return out.map((z) => ({ ...z, score: round2(z.score), sources: TRAP_SOURCES.map((s) => s.id).filter((id) => z.sources.includes(id)) }))
}

/** The zone's role against `price` (ZONE_KINDS). */
export function zoneKind(z, price) {
  if (!Number.isFinite(price)) return null
  if (price >= z.low && price <= z.high) return z.bullish ? 'insideBull' : 'insideBear'
  if (z.bullish) return z.high < price ? 'support' : 'trappedLongs'
  return z.low > price ? 'resistance' : 'trappedShorts'
}

const distancePct = (z, price) => (price >= z.low && price <= z.high ? 0 : (price > z.high ? z.high - price : z.low - price) / price * 100)

/** The four profiles' zones of some sessions, merged, in spot terms. `options` [{ items, oi }] (optionDeltaMinutes /
 *  optionOiMinutes of each session), `futures` [[footprint bars]], `basis` = futures − spot (null: futures left out). */
export function positionZones({ options = [], futures = [], basis = null, rowSize = 5 }) {
  const items = options.map((s) => s.items ?? [])
  const zones = []
  zones.push(...sourceZones('oi', oiRowsOf(options.map((s) => s.oi ?? []), rowSize), rowSize, { bullishNegative: true }))
  zones.push(...sourceZones('cdv', optionDeltaProfileOf(items, { rowSize, metric: 'cdv' }).rows, rowSize))
  zones.push(...sourceZones('obv', optionDeltaProfileOf(items, { rowSize, metric: 'obv' }).rows, rowSize))
  if (Number.isFinite(basis) && futures.some((f) => f?.length)) {
    zones.push(...sourceZones('fut', futuresDeltaProfileOf(futures, { rowSize }).rows, rowSize, { shift: basis }))
  }
  return mergeZones(zones)
}

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
 * read against the last session's close. { close, zones, lean, basis }.
 */
export function openingRead({ prevOptions = [], prevFutures = [], rowSize = 5 }) {
  const last = prevOptions[prevOptions.length - 1]
  const close = lastClose(last?.candles)
  const lastFut = prevFutures[prevFutures.length - 1]
  // The basis from the same session's two closes only - another day's futures would put their zones off by its own basis.
  const futClose = lastFut && (!last?.date || !lastFut.date || lastFut.date === last.date) ? lastClose(lastFut.items) : null
  const basis = close > 0 && futClose > 0 ? futClose - close : null
  const zones = positionZones({ options: prevOptions, futures: prevFutures.map((f) => f.items ?? []), basis, rowSize })
  return { close, basis, ...readZones(zones, close) }
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
  const today = positionZones({ options: [{ items: options, oi }], futures: [futures], basis, rowSize }).map((z) => ({ ...z, from: 'today' }))
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
  return { open, price, basis, zones, lean, openRule, crossings, flows, score, verdict, reasons, liveSqueeze: live ?? null }
}
