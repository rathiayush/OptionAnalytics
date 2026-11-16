// The COMPONENT CHECK page (asked for - "a page where each component is tested on historical data and gives the correlation
// between price and what they are meant for"): every OI Replay card's own READ replayed over past days, each read turned
// into an EVENT at the minute it became known (each card's code, the data up to that minute only), and what spot did after
// it measured (telegramSignals.js' `reaction`: the price at the event = the close of the minute the read was made on, the
// close 5 / 15 / 30 / 60 minutes later, the best / worst in the hour).
//
// Two kinds of read, tested for what each is MEANT for:
//   DIRECTIONAL (`kind: 'dir'`, `dir` +1 bullish / -1 bearish) - an OI totals S/R break, a 🎯, a straddle trend up / down,
//     a straddle trade idea, a skew read, a GEX smart-detection row with a side, spot at a GEX wall, an absorption /
//     exhaustion, charm into the close: did spot go that way? (hit %, the average move its way, the correlation of the side
//     with the move that followed);
//   VOLATILITY (`kind: 'vol'`, `expect` 'bigger' / 'smaller') - the straddle sideways / trending, the GEX regime (dealers
//     long / short gamma), max gamma (pin / weak magnet), dealer hedging lean-against / chase: were the moves after it
//     bigger or smaller than USUAL? (the move's size against the same days' typical move at the same horizon from any
//     minute - `baseline`; the correlation of the expectation, +1 bigger / -1 smaller, with the move's size over usual).
//
// A STATE read (the skew, the GEX regime and detection, the straddle trend, the dealers' lean) is an event when it CHANGES
// and holds `HOLD` minutes (dated the minute it is confirmed) - not every minute it lasts. Each read is the card's own
// function on the run of the day (the OI Replay run - the current expiry, Standard sign); a read made at minute t is known
// at the END of it, so its reaction is from t + 1 minute (`at`). Nothing after the event is read to make it.
// It places nothing and feeds no strategy or alert.

import { gexDay } from './gex.js'
import { dexDay, dexRead } from './dex.js'
import { gexLevelsNear, gexTrendDay } from './gexTrend.js'
import { straddleRead } from './straddle.js'
import { SKEW_DEFAULTS, SKEW_READ_TABLE, skewDay } from './volSkew.js'
import { oiAbsorptionEvents } from './oiAbsorption.js'
import { REACTION_WINDOW, correlation, reaction } from './telegramSignals.js'
import { prepareDay } from './signalBacktest.js'
import { DHAN_CALLS_HEADER, runUrl } from './signalBacktestJob.js'

const MIN = 60_000
/** The horizons the price after a read is measured at (minutes) - 90 / 120 for the slower reads (asked for - "add higher
 *  timeframe as well like 90 120 min"); an event too late in the day for one has none there. */
export const HORIZONS = [5, 15, 30, 60, 90, 120]
const IST_MS = 330 * MIN
const SESSION_FIRST = 9 * 60 + 15
const SESSION_LAST = 15 * 60 + 29
/** Minutes a state read must hold before its change counts. */
export const HOLD = 3
/** Minutes before a GEX level can be "reached" again. */
const LEVEL_COOLDOWN = 15
/** Charm into the close is read at this IST time. */
const CHARM_AT = '14:30'

const istMinute = (ms) => { const d = new Date(ms + IST_MS); return d.getUTCHours() * 60 + d.getUTCMinutes() }
const istDate = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10)

/** The cards tested, in the page's order: id, title, what each read is meant for. */
export const CARDS = [
  { id: 'oiBreak', title: 'OI totals S/R break', meant: 'A break of the CE / PE / Net cumulative Δ line\'s support / resistance - price follows the side it means.' },
  { id: 'oiHp', title: '🎯 High probability', meant: 'An OI break with the ATM ± 1 OI shifting the same way - a stronger directional signal.' },
  { id: 'straddleTrend', title: 'ATM straddle trend', meant: 'Trending ↑ / ↓ = price keeps going that way and moves get bigger; Sideways = smaller moves.' },
  { id: 'straddleIdea', title: 'Straddle trade idea', meant: 'BUY CE / BUY PE - premium expanding with the futures moving: price continues.' },
  { id: 'skew', title: 'Volatility skew read', meant: 'Fear confirms / rally hedged / protection building = bearish; selling exhausting / calls chased / fear easing = bullish.' },
  { id: 'gexTrend', title: 'GEX smart detection', meant: 'The truth table\'s bullish / bearish rows - price goes that way.' },
  { id: 'gexRegime', title: 'GEX regime', meant: 'Dealers long gamma (net GEX +) = smaller moves; short gamma (−) = bigger moves.' },
  { id: 'gexLevel', title: 'Spot at a GEX level', meant: 'Put wall: bounce (long gamma) / break (short); call wall: rejection / squeeze; max gamma: pin / weak magnet.' },
  { id: 'dexLean', title: 'Dealer hedging lean', meant: 'Dealers lean against moves = smaller moves; chase moves = bigger moves.' },
  { id: 'dexCharm', title: 'Charm into the close', meant: `At ${CHARM_AT}, dealers buying (selling) from time alone = a drift up (down) into 15:30.` },
  { id: 'absorption', title: 'Absorption / exhaustion (OI)', meant: 'Absorption: price holds where the writers soak up the push; exhaustion: the move runs out - price turns.' },
]
export const CARD_TITLE = Object.fromEntries(CARDS.map((c) => [c.id, c.title]))

// A state read's changes: `states` [{ time, key, ...extra }] a minute each (key null = no read, holds nothing), an event
// for each new key held `hold` minutes, at the minute it is confirmed.
function stateChanges(states, hold = HOLD) {
  const out = []
  let current = null
  let run = { key: null, count: 0, first: null }
  for (const s of states) {
    if (s.key == null) { run = { key: null, count: 0, first: null }; continue }
    if (s.key === run.key) run.count++
    else run = { key: s.key, count: 1, first: s }
    if (run.key !== current && run.count >= hold) {
      current = run.key
      out.push({ ...run.first, time: s.time, started: run.first.time })
    }
  }
  return out
}

/** The day's spot minutes of the run (session only, one a minute, ms): [{ t, o, h, l, c }]. */
export function sessionBars(run) {
  const seen = new Map()
  for (const b of run?.spotCandlesOneMinute ?? []) {
    const t = Math.floor(Date.parse(b.time) / MIN) * MIN
    const m = istMinute(t)
    if (!Number.isFinite(t) || !(b.close > 0) || m < SESSION_FIRST || m > SESSION_LAST) continue
    seen.set(t, { t, o: b.open, h: b.high, l: b.low, c: b.close })
  }
  return [...seen.values()].sort((a, b) => a.t - b.t)
}

/**
 * Every card's reads of one day's OI Replay run as events: [{ card, read, kind ('dir' | 'vol'), dir?, expect?, time (the
 * minute the read was made on), at (when it was known - its end), text }], in time order. `prepared` - the day's
 * prepareDay (its OI breaks / 🎯 - the Signal backtest's own), worked out when not given.
 */
export function dayEvents(run, { prepared = null } = {}) {
  const bars = sessionBars(run)
  if (bars.length < 30) return { ok: false, reason: 'not enough spot minutes for the day' }
  const date = istDate(bars[0].t)
  const expiry = /^\d{4}-\d{2}-\d{2}/.test(String(run?.optionExpiry ?? '')) ? String(run.optionExpiry).slice(0, 10) : null
  const ce = run?.cePoints ?? [], pe = run?.pePoints ?? []
  if (!ce.length || !pe.length) return { ok: false, reason: 'no option data for the day' }
  const spotMs = bars.map((b) => ({ time: b.t, close: b.c }))
  const events = []
  const add = (e) => events.push({ ...e, at: e.time + MIN })
  const dirEvent = (card, read, dir, time, text) => add({ card, read, kind: 'dir', dir, time, text })
  const volEvent = (card, read, expect, time, text) => add({ card, read, kind: 'vol', expect, time, text })

  // OI totals S/R breaks and 🎯 (1-minute buckets) - the Signal backtest's prepared day.
  const day = prepared ?? prepareDay(run, { underlying: run?.underlying })
  if (day?.ok) {
    for (const b of day.breaks ?? []) dirEvent('oiBreak', `${b.line.toUpperCase()} ${b.up ? 'broke resistance' : 'broke support'} (${b.dir > 0 ? 'bullish' : 'bearish'})`, b.dir, day.t[b.i], b.text)
    for (const h of day.hp ?? []) dirEvent('oiHp', h.dir > 0 ? '🎯 bullish' : '🎯 bearish', h.dir, day.t[h.i], h.text)
  }

  // The ATM straddle: its trend changes and its trade ideas.
  const straddle = straddleRead(ce, pe, spotMs, { expiry })
  for (const c of straddle.trend?.changes ?? []) {
    if (c.to === 'range') volEvent('straddleTrend', 'Sideways (premium melting)', 'smaller', c.time, 'Straddle under its VWAP, EMA 9 under EMA 21')
    else if (c.to === 'trend' && c.dir) dirEvent('straddleTrend', `Trending ${c.dir === 'up' ? '↑' : '↓'}`, c.dir === 'up' ? 1 : -1, c.time, `Straddle over its VWAP, EMA 9 over EMA 21, futures ${c.dir}`)
    if (c.to === 'trend') volEvent('straddleTrend', 'Trending (any)', 'bigger', c.time, 'Straddle over its VWAP, EMA 9 over EMA 21')
  }
  for (const t of [...(straddle.trades?.list ?? []), ...(straddle.trades?.open ? [straddle.trades.open] : [])]) {
    dirEvent('straddleIdea', t.side === 'CE' ? 'BUY CE' : 'BUY PE', t.side === 'CE' ? 1 : -1, t.time, t.why)
  }

  // The volatility skew read (each minute over the card's default window), its changes.
  const skew = skewDay(ce, pe, spotMs, { expiry }).filter((m) => m.rr25 != null)
  const skewStates = []
  let s0 = 0
  for (let j = 0; j < skew.length; j++) {
    const now = skew[j]
    while (s0 + 1 < j && skew[s0 + 1].time <= now.time - SKEW_DEFAULTS.window * MIN) s0++
    const start = skew[s0]
    if (!start || start.time > now.time - SKEW_DEFAULTS.window * MIN) { skewStates.push({ time: now.time, key: null }); continue }
    const rr = now.rr25 - start.rr25, px = ((now.spot - start.spot) / start.spot) * 100
    const price = px >= SKEW_DEFAULTS.priceMovePct ? 'rising' : px <= -SKEW_DEFAULTS.priceMovePct ? 'falling' : 'flat'
    const rrDir = rr >= SKEW_DEFAULTS.rrMove ? 'rising' : rr <= -SKEW_DEFAULTS.rrMove ? 'falling' : 'steady'
    const row = rrDir === 'steady' ? SKEW_READ_TABLE.at(-1) : SKEW_READ_TABLE.find((r) => r.price === price && r.rr === rrDir)
    skewStates.push({ time: now.time, key: row?.key ?? null, row })
  }
  const SKEW_SIDE = { fearConfirms: -1, hedgedRally: -1, fearBuilding: -1, putsFade: 1, callChase: 1, fearEasing: 1 }
  for (const c of stateChanges(skewStates)) {
    if (SKEW_SIDE[c.key]) dirEvent('skew', c.row.read, SKEW_SIDE[c.key], c.time, c.row.detail)
  }

  // GEX (Standard sign): the smart detection, the regime, the levels - and the dealers' hedging from it.
  const gex = gexDay(ce, pe, spotMs, { expiry, flips: false })
  const trend = gexTrendDay(gex)
  for (const c of stateChanges(trend.map((d) => (d?.row ? { time: d.time, key: d.row.read, row: d.row } : { time: d?.time ?? 0, key: null })))) {
    if (c.row.tone === 'bull' || c.row.tone === 'bear') dirEvent('gexTrend', c.row.read, c.row.tone === 'bull' ? 1 : -1, c.time, `GEX ${c.row.gex}, price ${c.row.price}`)
  }
  for (const c of stateChanges(gex.map((m) => ({ time: m.time, key: m.net > 0 ? 'positive' : m.net < 0 ? 'negative' : null })))) {
    if (c.key === 'positive') volEvent('gexRegime', 'Long gamma (net GEX +)', 'smaller', c.time, 'Net GEX turned positive - dealers sell rallies / buy dips')
    else volEvent('gexRegime', 'Short gamma (net GEX −)', 'bigger', c.time, 'Net GEX turned negative - dealers chase moves')
  }
  const lastNear = new Map()
  const wasNear = new Set()
  for (const m of gex) {
    const near = gexLevelsNear(m)
    const now = new Set(near.map((x) => x.level))
    for (const x of near) {
      if (wasNear.has(x.level) || (lastNear.has(x.level) && m.time - lastNear.get(x.level) < LEVEL_COOLDOWN * MIN)) continue
      lastNear.set(x.level, m.time)
      const read = `${x.label}, ${x.regime} GEX`
      if (x.tone === 'bull' || x.tone === 'bear') dirEvent('gexLevel', read, x.tone === 'bull' ? 1 : -1, m.time, x.read)
      else volEvent('gexLevel', read, x.regime === 'positive' ? 'smaller' : 'bigger', m.time, x.read)
    }
    wasNear.clear()
    for (const l of now) wasNear.add(l)
  }
  const dex = dexDay(gex, { flips: false })
  const leanOf = (d) => (d.up < 0 && d.down > 0 ? 'damp' : d.up > 0 && d.down < 0 ? 'chase' : null)
  for (const c of stateChanges(dex.map((d) => ({ time: d.time, key: leanOf(d) })))) {
    if (c.key === 'damp') volEvent('dexLean', 'Dealers lean against moves', 'smaller', c.time, 'A 1% rally = dealer selling, a fall = buying')
    else volEvent('dexLean', 'Dealers chase moves', 'bigger', c.time, 'A 1% rally = dealer buying, a fall = selling')
  }
  const [hh, mm] = CHARM_AT.split(':').map(Number)
  const charmMinute = dex.find((d) => istMinute(d.time) >= hh * 60 + mm)
  const charm = charmMinute ? dexRead(charmMinute).find((r) => r.key === 'charm') : null
  if (charm && charm.tone !== 'calm') dirEvent('dexCharm', charm.tone === 'bull' ? 'Charm: dealers buy into the close' : 'Charm: dealers sell into the close', charm.tone === 'bull' ? 1 : -1, charmMinute.time, charm.text)

  // Absorption / exhaustion by OI, on 5-minute candles (the card's default).
  const step = Number(run?.step) || stepOf(ce)
  const byStrike = (points) => {
    const out = new Map()
    for (const p of points) { if (!out.has(p.strike)) out.set(p.strike, []); out.get(p.strike).push(p) }
    return out
  }
  const chartBars = bars.map((b) => ({ time: (b.t + IST_MS) / 1000, open: b.o, high: b.h, low: b.l, close: b.c }))
  for (const e of oiAbsorptionEvents({ spotBars: chartBars, ceByStrike: byStrike(ce), peByStrike: byStrike(pe), step, timeframe: 5 })) {
    const time = e.lastBar * 1000 - IST_MS
    dirEvent('absorption', `${e.side === 'bull' ? 'Bullish' : 'Bearish'} ${e.kind}`, e.side === 'bull' ? 1 : -1, time, e.text)
  }

  events.sort((a, b) => a.time - b.time || a.card.localeCompare(b.card))
  return { ok: true, date, bars, events }
}

function stepOf(points) {
  const ks = [...new Set(points.map((p) => p.strike))].sort((a, b) => a - b)
  let step = null
  for (let i = 1; i < ks.length; i++) if (step == null || ks[i] - ks[i - 1] < step) step = ks[i] - ks[i - 1]
  return step
}

/** The day's USUAL move from any minute (the volatility reads' yardstick): at each horizon the sum and count of |move| in %
 *  of the price from the close of a minute to the close h minutes later, and of the next hour's range (high - low) - as
 *  sums, so days add up. */
export function dayBaseline(bars, { horizons = HORIZONS, window = REACTION_WINDOW } = {}) {
  const out = { abs: Object.fromEntries(horizons.map((h) => [h, [0, 0]])), range: [0, 0] }
  const index = new Map(bars.map((b, i) => [b.t, i]))
  for (let i = 0; i < bars.length; i++) {
    const base = bars[i].c
    for (const h of horizons) {
      const k = index.get(bars[i].t + h * MIN)
      if (k == null) continue
      out.abs[h][0] += (Math.abs(bars[k].c - base) / base) * 100
      out.abs[h][1]++
    }
    if (bars[i].t + window * MIN > bars.at(-1).t + MIN) continue
    let hi = -Infinity, lo = Infinity
    for (let x = i + 1; x < bars.length && bars[x].t <= bars[i].t + window * MIN; x++) { hi = Math.max(hi, bars[x].h); lo = Math.min(lo, bars[x].l) }
    if (Number.isFinite(hi)) { out.range[0] += ((hi - lo) / base) * 100; out.range[1]++ }
  }
  return out
}

/** One day's outcome: its events each with its reaction (the price after it), and its baseline. Small - the run is dropped
 *  (`keepBars` keeps its spot minutes, for a day chart). */
export function dayOutcome(run, { keepBars = false, ...options } = {}) {
  const d = dayEvents(run, options)
  if (!d.ok) return { ok: false, date: run?.date ?? null, reason: d.reason }
  const events = d.events.map((e) => {
    const r = reaction({ time: e.at, dir: e.kind === 'dir' ? e.dir : 0 }, d.bars, { horizons: HORIZONS })
    return { ...e, reaction: r ? { base: r.base, moves: r.moves, best: r.best, worst: r.worst, range: r.best != null && r.worst != null ? r.best + r.worst : null } : null }
  })
  return { ok: true, date: d.date, events, baseline: dayBaseline(d.bars), ...(keepBars ? { bars: d.bars } : {}) }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

/** The yardstick of all the days: the usual |move| % at each horizon and the usual hour's range %. */
export function baselineOf(outcomes, { horizons = HORIZONS } = {}) {
  const abs = {}, sums = Object.fromEntries(horizons.map((h) => [h, [0, 0]]))
  const range = [0, 0]
  for (const o of outcomes) {
    if (!o?.ok) continue
    for (const h of horizons) { sums[h][0] += o.baseline.abs[h]?.[0] ?? 0; sums[h][1] += o.baseline.abs[h]?.[1] ?? 0 }
    range[0] += o.baseline.range[0]; range[1] += o.baseline.range[1]
  }
  for (const h of horizons) abs[h] = sums[h][1] ? sums[h][0] / sums[h][1] : null
  return { abs, range: range[1] ? range[0] / range[1] : null }
}

// The verdict of a row against what its reads are meant for, at horizon `h`.
export const VERDICT_MIN_EVENTS = 10
function verdictOf(row, h) {
  const n = row[`n${h}`] ?? 0
  if (n < VERDICT_MIN_EVENTS) return { key: 'few', label: `Too few (${n})` }
  if (row.kind === 'dir') {
    const hit = row[`hit${h}`], avg = row[`avgPct${h}`]
    if (hit >= 55 && avg > 0) return { key: 'works', label: 'Works as meant' }
    if (hit <= 45 && avg < 0) return { key: 'opposite', label: 'Opposite of meant' }
    return { key: 'none', label: 'No edge' }
  }
  const ratio = row[`ratio${h}`]
  if (ratio == null) return { key: 'none', label: 'No edge' }
  const asMeant = row.expect === 'bigger' ? ratio >= 1.15 : row.expect === 'smaller' ? ratio <= 0.87 : null
  const against = row.expect === 'bigger' ? ratio <= 0.87 : row.expect === 'smaller' ? ratio >= 1.15 : null
  if (asMeant) return { key: 'works', label: 'Works as meant' }
  if (against) return { key: 'opposite', label: 'Opposite of meant' }
  return { key: 'none', label: 'No edge' }
}

// One summary row of `list` (events with a reaction).
function summaryRow(list, { card, read = null, label }, base, horizons) {
  const kinds = new Set(list.map((e) => e.kind))
  const kind = kinds.size === 1 ? [...kinds][0] : 'mixed'
  const expects = new Set(list.filter((e) => e.kind === 'vol').map((e) => e.expect))
  const out = {
    card, read, label, kind, events: list.length, days: new Set(list.map((e) => e.date)).size,
    bullish: list.filter((e) => e.dir > 0).length, bearish: list.filter((e) => e.dir < 0).length,
    expect: expects.size === 1 ? [...expects][0] : expects.size ? 'mixed' : null,
  }
  const dirs = list.filter((e) => e.kind === 'dir')
  const vols = list.filter((e) => e.kind === 'vol')
  for (const h of horizons) {
    if (kind === 'dir' || kind === 'mixed') {
      const pairs = dirs.filter((e) => e.reaction.moves[h] != null)
      const pct = pairs.map((e) => (e.dir * e.reaction.moves[h] / e.reaction.base) * 100)
      out[`n${h}`] = pairs.length
      out[`hit${h}`] = pct.length ? (pct.filter((v) => v > 0).length / pct.length) * 100 : null
      out[`avgPct${h}`] = mean(pct)
      out[`avgPts${h}`] = mean(pairs.map((e) => e.dir * e.reaction.moves[h]))
      // The read's side against the raw move (% of the price) that followed: + = the bullish ones rose more.
      out[`corr${h}`] = correlation(pairs.map((e) => e.dir), pairs.map((e) => (e.reaction.moves[h] / e.reaction.base) * 100))
    }
    if (kind === 'vol' || (kind === 'mixed' && !dirs.length)) {
      const usual = base.abs[h]
      const pairs = vols.filter((e) => e.reaction.moves[h] != null && usual > 0)
      const size = pairs.map((e) => (Math.abs(e.reaction.moves[h]) / e.reaction.base) * 100)
      out[`n${h}`] = pairs.length
      out[`ratio${h}`] = size.length ? mean(size) / usual : null
      out[`bigger${h}`] = size.length ? (size.filter((v) => v > usual).length / size.length) * 100 : null
      // The expectation (+1 bigger / -1 smaller) against the move's size over usual: + = it told big moves from small.
      out[`corr${h}`] = correlation(pairs.map((e) => (e.expect === 'bigger' ? 1 : -1)), size.map((v) => v / usual - 1))
    }
  }
  const withRange = (kind === 'vol' ? vols : []).filter((e) => e.reaction.range != null)
  out.rangeRatio = withRange.length && base.range > 0 ? mean(withRange.map((e) => (e.reaction.range / e.reaction.base) * 100)) / base.range : null
  out.avgBest = dirs.length ? mean(dirs.map((e) => e.reaction.best).filter((v) => v != null)) : null
  out.avgWorst = dirs.length ? mean(dirs.map((e) => e.reaction.worst).filter((v) => v != null)) : null
  return out
}

/**
 * The page's report over the days' outcomes: per CARD a row (its reads together) with a row per READ under it - events,
 * days, and at each horizon: directional reads - hit %, the average move their way (% / points), the correlation of their
 * side with the move; volatility reads - the move's size against usual (`ratio`), how often bigger than usual, the
 * correlation of the expectation with the size; each with a `verdict` at `horizon`. `baseline` - the usual moves; `days` /
 * `failed` - the days run / not. Only events with a reaction count.
 */
export function componentReport(outcomes, { horizons = HORIZONS, horizon = 30 } = {}) {
  const ok = outcomes.filter((o) => o?.ok)
  const base = baselineOf(ok, { horizons })
  const all = ok.flatMap((o) => o.events.filter((e) => e.reaction).map((e) => ({ ...e, date: o.date })))
  const cards = []
  for (const c of CARDS) {
    const list = all.filter((e) => e.card === c.id)
    if (!list.length) { cards.push({ card: c.id, label: c.title, meant: c.meant, events: 0, reads: [] }); continue }
    const reads = [...new Set(list.map((e) => e.read))].map((read) => {
      const row = summaryRow(list.filter((e) => e.read === read), { card: c.id, read, label: read }, base, horizons)
      return { ...row, verdict: verdictOf(row, horizon) }
    }).sort((a, b) => b.events - a.events)
    // The card's own row: its directional reads together when it has them (a card mixing kinds is read by its directions;
    // a card of volatility reads by those).
    const dirList = list.filter((e) => e.kind === 'dir')
    const row = summaryRow(dirList.length ? dirList : list, { card: c.id, label: c.title }, base, horizons)
    cards.push({ ...row, meant: c.meant, verdict: verdictOf(row, horizon), reads })
  }
  return {
    horizons, horizon, baseline: base, cards,
    days: ok.length, events: all.length,
    failed: outcomes.filter((o) => o && !o.ok).map((o) => ({ date: o.date, reason: o.reason })),
  }
}

/** Every event as CSV: date, time, card, read, kind, side / expectation, price, the moves, best / worst, the text. */
export function eventsCsv(outcomes, { horizons = HORIZONS } = {}) {
  const cell = (v) => {
    const s = v == null ? '' : String(v)
    const safe = /^[=+\-@\t]/.test(s) && !Number.isFinite(Number(s)) ? `'${s}` : s
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  const r2 = (v) => (v == null || !Number.isFinite(v) ? '' : Math.round(v * 100) / 100)
  const head = ['date', 'time_ist', 'card', 'read', 'kind', 'side_or_expect', 'price', ...horizons.map((h) => `move_${h}m_pts`), 'best_60m', 'worst_60m', 'text']
  const lines = []
  for (const o of outcomes) {
    if (!o?.ok) continue
    for (const e of o.events) {
      lines.push([
        o.date, new Date(e.at + IST_MS).toISOString().slice(11, 16), CARD_TITLE[e.card] ?? e.card, e.read, e.kind,
        e.kind === 'dir' ? (e.dir > 0 ? 'bullish' : 'bearish') : e.expect, r2(e.reaction?.base), ...horizons.map((h) => r2(e.reaction?.moves?.[h])),
        r2(e.reaction?.best), r2(e.reaction?.worst), e.text,
      ].map(cell).join(','))
    }
  }
  return [head.join(','), ...lines].join('\n')
}

/**
 * One past day loaded (the OI Replay run - `/api/oi-replay/{u}/run`, the server's disk cache, Dhan once for a day it has not
 * kept) and turned into its outcome (`dayOutcome` - the run itself dropped): { ok, date, events, baseline, dhanCalls } or
 * { ok: false, date, reason, retry? } - `retry` when it failed on the way (a timeout, the network, a server error). Throws
 * only when `signal` stops it.
 */
export async function loadComponentDay(underlying, date, { signal, timeoutMs = 240_000, fetch: fetchImpl, keepBars = false } = {}) {
  const get = fetchImpl ?? globalThis.fetch
  const timeout = new AbortController()
  const timer = setTimeout(() => timeout.abort('timeout'), timeoutMs)
  const abort = () => timeout.abort('stopped')
  signal?.addEventListener('abort', abort)
  if (signal?.aborted) abort()
  try {
    const r = await get(runUrl(underlying, date), { signal: timeout.signal })
    const said = r.headers?.get?.(DHAN_CALLS_HEADER)
    const dhanCalls = said == null || said === '' || !Number.isFinite(Number(said)) ? null : Number(said)
    const body = await r.json().catch(() => null)
    if (!r.ok || !body?.success) return { ok: false, date, reason: body?.error ?? `HTTP ${r.status}`, retry: r.status >= 500 || r.status === 429, dhanCalls }
    await new Promise((resolve) => setTimeout(resolve, 0))
    const out = dayOutcome({ ...body, underlying, date }, { keepBars })
    return { ...out, date: out.date ?? date, dhanCalls }
  } catch (err) {
    if (signal?.aborted) throw err
    return { ok: false, date, reason: timeout.signal.aborted ? 'took too long to load' : String(err?.message ?? err), retry: true }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
