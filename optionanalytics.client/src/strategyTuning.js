// Strategy tuning: at what settings does a strategy do best? Each day is scanned ONCE with the strategies'
// rules (scanDaySetups, keepAll - every setup of every minute); then for each strategy every combination of
// its trade filters (TRADE_FILTERS: sides, entry window, stop / target size, time stop, trailing stop - and the
// OI confirmation: options OI change and since the open, futures OI, room to the OI wall) is taken through
// exactly what the scanner does - applyTradeFilter, first per cooldown, the trailing stop, simulateOutcome on
// the day's bars - and scored in R. What is tuned (`what`): 'trade' the trade settings (TUNING_GRID), 'oi' the
// OI confirmation (OI_GRID), 'both' the OI confirmation first, then the trade settings on top of the best one.
//
// Against fitting the past: the days are split in time - the first 70% choose (train), the last 30% check
// (test, days the choice never saw). A combination needs a minimum number of trades, is ranked by a cautious
// score (average R minus one standard error), and is only recommended when it also beats the strategy as
// written on the test days.

import { ACTIVE_STRATEGIES, OPTION_TRADE_FILTERS, STRATEGY_BY_ID, TRADE_FILTERS, applyTradeFilter, capPoints, oiGateText, optionStopTargetHit, optionTradeAt, premiumAt, simulateOutcome } from './strategyEngine.js'
import { replayRange } from './orderFlowMath.js'
import { MIN } from './scannerCore.js'
import { firstPerCooldown } from './scanDay.js'

/** The combinations tried (each strategy): 3 x 6 x 4 x 5 x 4 x 5 = 7,200. */
export const TUNING_GRID = {
  tradeSide: ['both', 'long', 'short'],
  window: [[930, 1445], [930, 1100], [930, 1230], [1000, 1300], [1100, 1445], [1230, 1445]],
  tradeStopX: [0.75, 1, 1.25, 1.5],
  tradeTargetX: [0.75, 1, 1.5, 2, 2.5],
  tradeTimeStop: [0, 30, 60, 120],
  tradeTrail: ['scanner', 'off', '0.5/0.5', '1/1', '2/1'],
}
/** The OI confirmation tried (each strategy): the options OI and futures OI each on 1 / 3 / 5 / 15 minutes, the
 *  options OI change and since the open (net CE - PE, and CE and PE each rising / falling), the futures OI (with
 *  short squeeze), the futures move size, the day type, the support / resistance OI (shrinking / growing) and the
 *  room to it. Far too many to try every combination (and a lucky one would win), so the OI is tuned step by step
 *  (stepSearch); the trade settings as they are. A combination whose timeframe changes nothing is skipped
 *  (oiVariantRedundant). */
export const OI_GRID = {
  tradeOiWindow: [15, 1, 3, 5],
  tradeFutWindow: [15, 1, 3, 5],
  tradeWallOi: ['any', 'shrinking', 'growing'],
  tradeOiFlow: ['any', 'notAgainst', 'with'],
  tradeOiCum: ['any', 'notAgainst', 'with'],
  tradeSideOi: ['any', 'notAgainst', 'lean', 'both'],
  tradeSideCum: ['any', 'notAgainst', 'lean', 'both'],
  tradeFutOi: ['any', 'notAgainst', 'withMove', 'buildUp', 'squeeze'],
  tradeMoveSize: ['any', 'small', 'large'],
  tradeDayType: ['any', 'trend', 'withTrend', 'notAgainstTrend', 'range'],
  tradeWallRoom: ['any', 'oneR', 'target'],
  // Order flow at the signal (tape, big orders, book, delta, volume) - judged only where the day has them (a live or
  // recorded day); on an estimated day they let every trade through, so they can only be learned from real days.
  tradeTape: ['any', 'notAgainst', 'with', 'strong'],
  tradeBig: ['any', 'notAgainst', 'with'],
  tradeBook: ['any', 'notAgainst', 'with'],
  tradeCvd: ['any', 'with'],
  tradeVolume: ['any', 'above', 'below'],
}
/** A combination whose timeframe changes nothing: the options OI timeframe with neither an options OI change nor
 *  a wall OI filter on, the futures OI timeframe with no futures OI filter on - tried once, at 15. */
export const oiVariantRedundant = (v) =>
  (v.tradeOiWindow !== 15 && (v.tradeOiFlow ?? 'any') === 'any' && (v.tradeWallOi ?? 'any') === 'any')
  || (v.tradeFutWindow !== 15 && (v.tradeFutOi ?? 'any') === 'any' && (v.tradeMoveSize ?? 'any') === 'any')

/** The OI inputs the tuning can use (a subset of OI_GRID's keys) - what the Strategy tuning page lists. */
export const OI_FACTORS = [
  { key: 'tradeOiWindow', label: 'Options OI timeframe: 1, 3, 5, 15 minutes (for the OI change and the wall OI)' },
  { key: 'tradeFutWindow', label: 'Futures OI timeframe: 1, 3, 5, 15 minutes (for the futures OI and the move size)', futures: true },
  { key: 'tradeWallOi', label: 'Support / resistance OI: the wall in the way shrinking or growing' },
  { key: 'tradeOiFlow', label: 'Options OI change: net CE vs PE (delta on the timeframe)' },
  { key: 'tradeOiCum', label: 'Options OI cumulative: net CE - PE since the open' },
  { key: 'tradeSideOi', label: 'CE and PE each rising / falling (delta on the timeframe)' },
  { key: 'tradeSideCum', label: 'CE and PE each rising / falling since the open (cumulative)' },
  { key: 'tradeFutOi', label: 'Futures OI (build-up, covering, short squeeze)', futures: true },
  { key: 'tradeMoveSize', label: 'Futures move size: small move or real move', futures: true },
  { key: 'tradeDayType', label: 'Day type: trending (my way), range, not against a trend' },
  { key: 'tradeWallRoom', label: 'Room to the next OI wall (support / resistance)' },
  { key: 'tradeTape', label: 'Tape aggression with the trade (live / recorded days only)', flow: true },
  { key: 'tradeBig', label: 'Big orders with the trade, last 5 min (live / recorded days only)', flow: true },
  { key: 'tradeBook', label: 'Order book near the price (heatmap) with the trade (live / recorded days only)', flow: true },
  { key: 'tradeCvd', label: 'Delta of the last 15 minutes with the trade', flow: true },
  { key: 'tradeVolume', label: 'Volume of the last 15 minutes vs the day', flow: true },
]

/** The OI inputs worth tuning for a data mode. Spot + options has no futures at all - its setups carry no futures OI
 *  and no futures move (spotEngine leaves both null), so a futures filter there could only ever block a trade, never
 *  confirm one. Those inputs are left out rather than offered and silently wasted. */
export const oiFactorsFor = (data) => (data === 'spot' ? OI_FACTORS.filter((f) => !f.futures && !f.flow) : OI_FACTORS)

// ---- the option trade ------------------------------------------------------------------------------------
/**
 * How the trade is taken in options (tuned by `what: 'option'`), on top of the index trade the signal gives:
 *   optLeg        'sell' (write the option that loses value with the move - the scanner's default) or 'buy' (the one
 *                 that gains with it);
 *   optMoneyness  0 = ATM, +n = n strikes in the money, -n = n out of the money (optionTradeAt);
 *   optExit       'index' - out when the index trade exits (stop / target / trail / time stop): what the tuning did
 *                 before; 'first' - the option's own SL / target, or the index trade's exit, whichever comes first;
 *                 'option' - only the option's own SL / target (else the 15:10 square-off);
 *                 'indexSl' - out with the index trade, but never losing more than the option's Max SL (optSlPct) on
 *                 the way: a cap on a long loss in the premium, with no option target;
 *   optSlPct / optTargetPct - the option's SL / target as a % of its entry premium, so they scale with moneyness.
 * The option's levels are checked minute by minute on its premium from the first full minute after the entry, filled
 * at the level (optionStopTargetHit - the scanner's own rule). Scored in premium points.
 */
export const OPTION_GRID = {
  optLeg: ['sell', 'buy'],
  optMoneyness: [0, 1, -1, 2, -2],
  optExit: ['index', 'indexSl', 'first', 'option'],
  optSlPct: [20, 15, 25, 30, 40],
  optTargetPct: [30, 20, 50, 75, 100],
}
export const OPTION_DEFAULT = { optLeg: 'sell', optMoneyness: 0, optExit: 'index', optSlPct: 20, optTargetPct: 30 }
/** Out with the index trade: the option's SL / target are not used - tried once; with the Max SL only, no target. */
export const optionVariantRedundant = (v) => {
  const exit = v.optExit ?? 'index'
  if (exit === 'index') return (v.optSlPct ?? 20) !== 20 || (v.optTargetPct ?? 30) !== 30
  return exit === 'indexSl' && (v.optTargetPct ?? 30) !== 30
}
/** Does the option's own target apply (its Max SL applies in every mode but 'index')? */
const ownTarget = (exit) => exit === 'first' || exit === 'option'

const SQUARE_OFF_MIN = 15 * 60 + 10
const istMinuteOf = (ms) => Math.floor((ms / MIN + 330) % 1440)

/**
 * The option's SL / target in force (premium points, null = none) for a trade taken as `v` at `premium`: its own exit's
 * (its SL where the exit has one, its target with 'first' / 'option'), held to the index's max rules `caps` ({ maxSl,
 * maxTarget } - Trade settings; a tuning day carries them as `day.optionCaps`) - the scanner's own rule (optionPlanFor).
 */
export function optionLevelsOf(v, premium, caps = null) {
  const exit = v.optExit ?? 'index'
  const ownSl = exit === 'index' ? null : (premium * (v.optSlPct ?? 20)) / 100
  const ownTg = ownTarget(exit) ? (premium * (v.optTargetPct ?? 30)) / 100 : null
  return { sl: capPoints(ownSl, Number(caps?.maxSl) || 0), target: capPoints(ownTg, Number(caps?.maxTarget) || 0) }
}

/** One setup traded in options as `v` says: the option, its entry and exit premium, the points and why it closed - or
 *  null when the option has no premium (that strike was not traded / not loaded). Held to the day's max rules
 *  (`day.optionCaps`), as the scanner holds it. */
export function optionOutcome(day, s, outcome, v) {
  if (!day.oi) return null
  const trade = optionTradeAt(day.oi, s, v.optLeg ?? 'sell', v.optMoneyness ?? 0, s.t)
  if (!trade?.premium) return null
  const indexExit = (outcome.exitAt ?? (day.endMs - MIN)) + MIN // the index trade's exit bar has finished
  const squareOff = Math.min(day.endMs, Math.floor(s.t / MIN) * MIN + (SQUARE_OFF_MIN - istMinuteOf(s.t)) * MIN)
  const exitMode = v.optExit ?? 'index'
  let exitMs = exitMode === 'option' ? squareOff : indexExit
  let exitPremium = null
  let reason = exitMode === 'option' ? 'square-off 15:10' : 'the index trade exited'
  const levels = optionLevelsOf(v, trade.premium, day.optionCaps)
  if (levels.sl != null || levels.target != null) {
    const hit = optionStopTargetHit(day.oi, trade, s.t, exitMs, levels.sl, levels.target)
    if (hit) { exitMs = hit.at; exitPremium = hit.premium; reason = hit.reason }
  }
  if (exitPremium == null) exitPremium = premiumAt(day.oi, trade.side, trade.strike, exitMs)
  if (exitPremium == null) return null
  return { trade, exitMs, exitPremium, reason, points: trade.action === 'BUY' ? exitPremium - trade.premium : trade.premium - exitPremium }
}

/** The premium points of strategy `id`'s trades over `days`, taken with trade filters + option settings `v`. */
export function optionRun(days, id, v, trail) {
  return days.flatMap((day) => takenTrades(day, id, v, trail).map(({ s, outcome }) => optionOutcome(day, s, outcome, v)?.points)).filter(Number.isFinite)
}

/** Every option trade of `id` with `v` over `days`: the index trade (as tradeDetails) and the option - name, moneyness,
 *  premium in / out, the points (`points` is the option's here, `indexPoints` the index's), when and why it closed. */
export function optionDetails(days, id, v, trail, underlying) {
  const out = []
  for (const day of days) {
    for (const { s, outcome } of takenTrades(day, id, v, trail)) {
      const o = optionOutcome(day, s, outcome, v)
      if (!o || !Number.isFinite(outcome.r)) continue
      const dir = s.side === 'LONG' ? 1 : -1
      const exitPrice = Number.isFinite(outcome.exitPrice) ? outcome.exitPrice : s.entry + dir * outcome.r * Math.abs(s.entry - s.stop)
      // The option's SL / target in force (its own, held to the day's max rules) - none when it only goes out with the index.
      const lv = optionLevelsOf(v, o.trade.premium, day.optionCaps)
      const own = lv.sl != null || lv.target != null
      const slPrem = lv.sl
      const tgPrem = lv.target
      const buy = o.trade.action === 'BUY'
      out.push({
        date: day.date, t: s.t, exitT: o.exitMs - MIN, index: underlying ?? null, side: s.side, entry: s.entry, exit: exitPrice,
        indexPoints: dir * (exitPrice - s.entry), r: outcome.r, points: o.points, stopHit: /SL/.test(o.reason) && o.points < 0,
        ...levelsOf(s, outcome),
        opt: {
          label: `${o.trade.action} ${o.trade.strike} ${o.trade.side}`, moneyness: v.optMoneyness ?? 0, entry: o.trade.premium, exit: o.exitPremium, points: o.points, reason: o.reason,
          sl: slPrem != null ? o.trade.premium + (buy ? -slPrem : slPrem) : null, target: tgPrem != null ? o.trade.premium + (buy ? tgPrem : -tgPrem) : null,
          slPts: own ? slPrem : null, targetPts: own ? tgPrem : null,
          // R: premium points made over the premium points risked (its SL); none when it only exits with the index.
          r: slPrem > 0 ? o.points / slPrem : null, rr: slPrem > 0 && tgPrem != null ? tgPrem / slPrem : null,
        },
      })
    }
  }
  return out
}

/** One line for an option setting. */
export function optionText(v) {
  const m = v.optMoneyness ?? 0
  const where = m === 0 ? 'ATM' : `${Math.abs(m)} ${m > 0 ? 'ITM' : 'OTM'}`
  const exit = (v.optExit ?? 'index') === 'index' ? 'out with the index trade'
    : v.optExit === 'indexSl' ? `out with the index trade, Max SL ${v.optSlPct}% of the premium`
    : `SL ${v.optSlPct}% / target ${v.optTargetPct}% of the premium${v.optExit === 'first' ? ', or the index trade\'s exit first' : ''}`
  return `${(v.optLeg ?? 'sell').toUpperCase()} ${where} · ${exit}`
}

/** The most OI combinations one "every combination" search will try (each is a pass over the train days). */
export const OI_COMBO_CAP = 50_000

/** How many OI combinations "every combination" would try with the OI inputs `keys` ticked (the combinations where a
 *  timeframe changes nothing left out) - counted up to `cap`, `over` when there are more. */
export function countOiCombinations(keys, cap = OI_COMBO_CAP) {
  let count = 0
  for (const v of variants(oiGridOf(keys), DEFAULT_VARIANT)) {
    if (oiVariantRedundant(v)) continue
    if (++count > cap) return { count: cap, over: true }
  }
  return { count, over: false }
}

/** OI_GRID restricted to `keys` (unknown keys ignored; none given = all of them). */
export const oiGridOf = (keys) => {
  const chosen = Array.isArray(keys) ? OI_FACTORS.map((f) => f.key).filter((k) => keys.includes(k)) : OI_FACTORS.map((f) => f.key)
  return Object.fromEntries(chosen.map((k) => [k, OI_GRID[k]]))
}
export const DEFAULT_VARIANT = Object.fromEntries(TRADE_FILTERS.map((f) => [f.key, f.default]))

/** The fewest trading days a setting may be chosen on and still be recommended (about three months). A setting picked on
 *  one short stretch - the last month, say - is the one that fitted THAT stretch: it is shown, never recommended. */
export const MIN_TUNE_DAYS = 60
/** A tuning result held to MIN_TUNE_DAYS: chosen on fewer days it is not recommended, and says why. */
export function heldToMinDays(result, days, min = MIN_TUNE_DAYS) {
  if (!result?.recommend || days >= min) return result
  return { ...result, recommend: false, tooFewDays: { days, min },
    reason: `chosen on only ${days} trading day(s) - a setting picked on one short stretch fits that stretch, not the market; tune on ${min}+ trading days (about three months or more) before trusting it (${result.reason})` }
}

/** Every combination of `grid` (key -> values; 'window' -> [from, to] pairs), each on top of `base` (the
 *  trade filters not in the grid). */
export function* variants(grid = TUNING_GRID, base = DEFAULT_VARIANT) {
  const keys = Object.keys(grid)
  function* walk(i, acc) {
    if (i === keys.length) { yield { ...base, ...acc }; return }
    const key = keys[i]
    for (const v of grid[key]) yield* walk(i + 1, key === 'window' ? { ...acc, tradeFrom: v[0], tradeTo: v[1] } : { ...acc, [key]: v })
  }
  yield* walk(0, {})
}

/** The R of each trade strategy `id` takes on a scanned day with trade filters `variant` - as the scanner
 *  would take them. `day` = { setups (every setup of every minute), minuteBars, endMs }, `trail` = the
 *  scanner's trailing stop. */
export function dayTrades(day, id, variant, trail) {
  return takenTrades(day, id, variant, trail).map((t) => t.outcome.r).filter(Number.isFinite)
}

/** What a setup's OUTCOME depends on: the stop / target size, the time stop and the trailing stop. The sides, the entry
 *  window and the OI confirmation decide only WHICH setups are taken, never what a taken one then does - so the same
 *  setup at the same four settings always ends the same way, and is worked out once (outcomeKey / the day's cache)
 *  instead of once per combination. 7,200 trade combinations hold only 400 different answers. */
export const outcomeKey = (v, trail) =>
  `${v.tradeStopX ?? 1}|${v.tradeTargetX ?? 1}|${v.tradeTimeStop ?? 0}|${v.tradeTrail ?? 'scanner'}|${trail ? `${trail.startR}/${trail.gapR}` : 'none'}`

/** The trades strategy `id` takes on a scanned day with `variant` - each { s (the setup as traded), outcome }. */
function takenTrades(day, id, variant, trail) {
  if (!day.byId) {
    day.byId = new Map()
    for (const s of day.setups) day.byId.set(s.id, [...(day.byId.get(s.id) ?? []), s])
  }
  const own = day.byId.get(id) ?? []
  // The setups this combination takes, and which setup each came from (the filter returns a copy with the scaled
  // stop / target).
  const from = new Map()
  const passed = []
  for (const s of own) {
    const f = applyTradeFilter(s, variant)
    if (!f) continue
    from.set(f, s)
    passed.push(f)
  }
  // One answer per setup per outcome setting, kept while that setting is being tried (the caller walks the
  // combinations in that order, so this holds one setting's worth of a day, not every combination's).
  const key = outcomeKey(variant, trail)
  let cache = day.outcomeCache
  if (!cache || cache.key !== key) { cache = { key, map: new Map() }; day.outcomeCache = cache }
  return firstPerCooldown(passed).map((s) => {
    const origin = from.get(s) ?? s
    let outcome = cache.map.get(origin)
    if (outcome === undefined) {
      const withTrail = { ...s, trail: s.trailOverride !== undefined ? s.trailOverride : trail }
      outcome = simulateOutcome(withTrail, day.minuteBars, day.endMs, true)
      cache.map.set(origin, outcome)
    }
    return { s, outcome }
  })
}

/**
 * The trades of strategy `id` with `variant` over `days`, each with what it captured in POINTS as well as R: the
 * index, the futures entry and exit and the points (in the trade's direction), and the two options the setup
 * carries - BUY (the one that gains with the move) and SELL (the writer's side) - with the option's entry premium,
 * its premium at the exit minute and the points that made. Premiums are the replay's finished-minute premiums
 * (the day's `oi`); an option with no premium at the exit is null.
 */
export function tradeDetails(days, id, variant, trail, underlying, { checks = false, optionLevels = null } = {}) {
  const out = []
  for (const day of days) {
    for (const { s, outcome } of takenTrades(day, id, variant, trail)) {
      if (!Number.isFinite(outcome.r)) continue
      const dir = s.side === 'LONG' ? 1 : -1
      const risk = Math.abs(s.entry - s.stop)
      const exitPrice = Number.isFinite(outcome.exitPrice) ? outcome.exitPrice : s.entry + dir * outcome.r * risk
      const exitMs = (outcome.exitAt ?? (day.endMs - MIN)) + MIN // the exit bar has finished
      // Each option the setup carries, as the trade would have gone in it: held until the index trade exited (a strategy's
      // own exit) and - when the index has max rules (Trade settings: Max SL / Max target, the day's `optionCaps`) -
      // whether one of those came first, which is what the scanner's trade does. `points` is the net on that leg either way.
      const caps = day.optionCaps ?? (optionLevels ? { maxSl: optionLevels.maxSl ?? optionLevels.sl, maxTarget: optionLevels.maxTarget ?? optionLevels.target } : null)
      const leg = (o) => {
        if (!o) return null
        const held = day.oi ? premiumAt(day.oi, o.side, o.strike, exitMs) : null
        const net = (px) => (px == null ? null : o.action === 'BUY' ? px - o.premium : o.premium - px)
        const base = { label: `${o.action} ${o.strike} ${o.side}`, entry: o.premium, exit: held, points: net(held), closedBy: held == null ? null : 'index exit' }
        const sl = caps?.maxSl > 0 ? caps.maxSl : null
        const target = caps?.maxTarget > 0 ? caps.maxTarget : null
        if (!day.oi || (!sl && !target)) return base
        // R on the option: the premium points made over the premium points risked (its SL); risk : reward = 1 : target / SL.
        const rOf = (pts) => (sl && Number.isFinite(pts) ? pts / sl : null)
        const rr = sl && target ? target / sl : null
        const hit = optionStopTargetHit(day.oi, o, s.t, exitMs, sl, target)
        if (!hit) return { ...base, sl, target, r: rOf(base.points), rr, closedBy: held == null ? null : 'index exit (neither the Max SL nor the Max target)' }
        const closedBy = /SL/i.test(hit.reason) ? 'the Max SL' : 'the Max target'
        return { ...base, sl, target, exit: hit.premium, points: net(hit.premium), r: rOf(net(hit.premium)), rr, at: hit.at, closedBy }
      }
      out.push({
        date: day.date, t: s.t, exitT: outcome.exitAt ?? null, index: underlying ?? null, side: s.side,
        entry: s.entry, exit: exitPrice, points: dir * (exitPrice - s.entry), r: outcome.r, status: outcome.status, stopHit: !!outcome.stopHit,
        ...levelsOf(s, outcome),
        buy: leg(s.options?.buy), sell: leg(s.options?.sell),
        ...(checks ? { estimated: !!day.estimated, checks: s.checks ?? null } : {}),
      })
    }
  }
  return out
}

/** A trade's stop-loss and target as traded (after the trade filters' stop / target size), their distance in points,
 *  the stop where it stood at the exit (moved by the trailing stop) and why it closed. */
function levelsOf(s, outcome) {
  const dir = s.side === 'LONG' ? 1 : -1
  const finalStop = Number.isFinite(outcome.stop) ? outcome.stop : s.stop
  return {
    stop: s.stop, target: s.target, slPts: Math.abs(s.entry - s.stop), targetPts: Number.isFinite(s.target) ? Math.abs(s.target - s.entry) : null,
    finalStop, trailed: !!outcome.trailed, lockedPts: outcome.trailed ? dir * (finalStop - s.entry) : null,
    exitReason: outcome.timeStop ? (outcome.squareOff ? 'square-off 15:10' : 'time stop') : outcome.stopHit ? (outcome.trailed ? 'trailing SL' : 'stop-loss') : outcome.status === 'open' ? 'open' : 'target',
  }
}

/** Points captured over trades: the futures' total and average, and each option leg's (BUY / SELL) over the
 *  trades that have its premiums. */
export function pointsSummary(trades) {
  const sum = (xs) => xs.reduce((a, b) => a + b, 0)
  // captured: the points of the winning trades; lost: of the losing ones; net = captured + lost (lost is negative).
  // slN / slPoints: the trades the futures stop-loss ended at a loss (a trailing stop that locked a profit is not one).
  const stats = (rows) => {
    const pts = rows.map((r) => r.points)
    const captured = sum(pts.filter((p) => p > 0))
    const lost = sum(pts.filter((p) => p < 0))
    return { n: rows.length, total: captured + lost, avg: rows.length ? (captured + lost) / rows.length : null, captured, lost, wins: pts.filter((p) => p > 0).length, losses: pts.filter((p) => p < 0).length }
  }
  const leg = (key) => stats(trades.filter((t) => Number.isFinite(t[key]?.points)).map((t) => ({ points: t[key].points })))
  const sl = trades.filter((t) => t.stopHit && t.points < 0)
  return { ...stats(trades), slN: sl.length, slPoints: sum(sl.map((t) => t.points)), buy: leg('buy'), sell: leg('sell') }
}

/** Several points summaries (pointsSummary) added up - the index points and each option leg's (BUY / SELL): captured,
 *  lost, net, trades, wins / losses - e.g. every strategy of a Strategy lab run together. Missing ones are left out. */
export function sumPoints(list) {
  const add = (legs) => {
    const xs = legs.filter((l) => l?.n > 0)
    const sum = (k) => xs.reduce((a, l) => a + (Number(l[k]) || 0), 0)
    const n = sum('n')
    const captured = sum('captured')
    const lost = sum('lost')
    return { n, total: captured + lost, avg: n ? (captured + lost) / n : null, captured, lost, wins: sum('wins'), losses: sum('losses') }
  }
  const ps = (list ?? []).filter(Boolean)
  return { ...add(ps), buy: add(ps.map((p) => p.buy)), sell: add(ps.map((p) => p.sell)) }
}

/** Trades in R -> n, total, average, win rate, profit factor, worst run (max drawdown), and the cautious score
 *  (average minus one standard error; null under 2 trades). */
export function scoreR(rs) {
  const n = rs.length
  if (!n) return { n: 0, total: 0, avg: null, winRate: null, pf: null, maxDD: 0, score: null }
  const total = rs.reduce((a, r) => a + r, 0)
  const avg = total / n
  const wins = rs.filter((r) => r > 0)
  const gain = wins.reduce((a, r) => a + r, 0)
  const loss = -rs.filter((r) => r < 0).reduce((a, r) => a + r, 0)
  let peak = 0, eq = 0, maxDD = 0
  for (const r of rs) { eq += r; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq) }
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, r) => a + (r - avg) ** 2, 0) / (n - 1)) : null
  return { n, total, avg, winRate: wins.length / n, pf: loss > 0 ? gain / loss : gain > 0 ? Infinity : null, maxDD, score: sd != null ? avg - sd / Math.sqrt(n) : null }
}

/**
 * Tunes the OI confirmation step by step instead of trying every combination: starting from `base`, each filter
 * in turn takes the value that scores best on the train days (cautious score, at least `minTrades` trades) given
 * the others as they are now; a second pass revisits them (a timeframe only matters once the filter it reads is
 * on, so the timeframes come last). Far fewer combinations are tried than the full grid - and far fewer chances
 * for a lucky one to win. Returns every combination it scored, best first, and how many it tried.
 */
const WINDOW_OF = { tradeOiFlow: 'tradeOiWindow', tradeSideOi: 'tradeOiWindow', tradeWallOi: 'tradeOiWindow', tradeFutOi: 'tradeFutWindow', tradeMoveSize: 'tradeFutWindow' }
export function stepSearch(grid, base, scoreOf, { passes = 2, minTrades = 0, onProgress = null } = {}) {
  const keys = Object.keys(grid)
  const order = [...keys.filter((k) => !/Window$/.test(k)), ...keys.filter((k) => /Window$/.test(k))]
  const seen = new Map()
  // It reports as it goes, like every other search: on months of days each try is a pass over all of them, and a search
  // that said nothing until it was done looked stuck - and could not be stopped by the job's time budget (which is
  // checked in this callback). `of` is the most it can try: every value of every filter (with its timeframes), each pass.
  const perPass = order.reduce((n, k) => n + grid[k].reduce((m, value) => m + (WINDOW_OF[k] && grid[WINDOW_OF[k]] && value !== 'any' ? grid[WINDOW_OF[k]].length : 1), 0), 0)
  const of = 1 + perPass * passes
  if (onProgress) onProgress({ tried: 0, of, part: 'oi', step: true })
  const evaluate = (v) => {
    const id = JSON.stringify(order.map((k) => v[k]))
    if (!seen.has(id)) {
      seen.set(id, { params: v, train: scoreOf(v) })
      if (onProgress && seen.size % 10 === 0) onProgress({ tried: seen.size, of, part: 'oi', step: true })
    }
    return seen.get(id)
  }
  const qualifies = (r) => r.train.score != null && r.train.n >= minTrades
  let current = { ...base }
  const first = evaluate(current)
  let currentScore = first.train.score ?? -Infinity
  for (let pass = 0; pass < passes; pass++) {
    let moved = false
    for (const key of order) {
      let bestV = null
      for (const value of grid[key]) {
        // A filter that reads a timeframe is tried on each of them together - one that only helps on 3 minutes
        // would show nothing on the 15 it starts from.
        const dep = WINDOW_OF[key]
        const windows = dep && grid[dep] && value !== 'any' ? grid[dep] : [undefined]
        for (const w of windows) {
          if (value === current[key] && w === undefined) continue
          const cand = { ...current, [key]: value, ...(w !== undefined ? { [dep]: w } : {}) }
          if (oiVariantRedundant(cand)) continue
          const r = evaluate(cand)
          if (!qualifies(r)) continue
          if (r.train.score > currentScore + 1e-9 && (!bestV || r.train.score > bestV.train.score)) bestV = r
        }
      }
      if (bestV) { current = bestV.params; currentScore = bestV.train.score; moved = true }
    }
    if (!moved) break
  }
  const rows = [...seen.values()].filter(qualifies)
  rows.sort((a, b) => b.train.score - a.train.score || b.train.total - a.train.total)
  return { rows, tried: seen.size }
}

/** Days in date order split into train (the first `trainFraction`) and test (the rest) - no test under 5 days. */
export function splitDays(days, trainFraction = 0.7) {
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  if (sorted.length < 5) return { train: sorted, test: [] }
  const cut = Math.max(1, Math.min(sorted.length - 1, Math.round(sorted.length * trainFraction)))
  return { train: sorted.slice(0, cut), test: sorted.slice(cut) }
}

/**
 * The train days in the stretches a setting is CHOSEN on, so one lucky stretch cannot pick it: calendar months (a month
 * of under 5 days joins the one before it - the first one the next); with under two such months, blocks of about 10
 * days (two at least, from 15 days); fewer days - one stretch (scored as one, as before).
 */
export function periodsOf(days) {
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const months = []
  for (const d of sorted) {
    const key = String(d.date).slice(0, 7)
    if (months.at(-1)?.key === key) months.at(-1).days.push(d)
    else months.push({ key, days: [d] })
  }
  const merged = []
  for (const m of months) {
    if (m.days.length < 5 && merged.length) merged.at(-1).days.push(...m.days)
    else merged.push({ key: m.key, days: [...m.days] })
  }
  if (merged.length > 1 && merged[0].days.length < 5) { merged[1].days.unshift(...merged[0].days); merged.shift() }
  if (merged.length >= 2) return merged.map((m) => m.days)
  if (sorted.length < 15) return [sorted]
  const blocks = Math.max(2, Math.floor(sorted.length / 10))
  const size = Math.ceil(sorted.length / blocks)
  return Array.from({ length: blocks }, (_, i) => sorted.slice(i * size, (i + 1) * size)).filter((b) => b.length)
}

/** How a setting is CHOSEN (`score`): stretch by stretch (periodsOf), not on the days added up - a setting that made all
 *  its money in one month loses to one that made a little in every month. Each stretch's average a trade (shrunk for few
 *  trades: x n / (n + 3); a stretch it did not trade in counts 0), then their mean less their spread (sd / sqrt(stretches)).
 *  Not chosen at all (score null) when it trades less than `minPerMonth` times a month (on the `tradingDays`), or - over 3+
 *  stretches - made money in fewer than half of them. One stretch: the cautious score of scoreR, as before. The rest of
 *  scoreR (n, total, avg, win rate ...) is the days added up; `cautious` that score, `periods` / `periodsWon` /
 *  `perMonth` / `why` (rare / inconsistent) beside it. */
export function robustScore(perPeriod, { tradingDays = null, minPerMonth = 0 } = {}) {
  const all = perPeriod.flat()
  const s = scoreR(all)
  const P = perPeriod.length
  const sums = perPeriod.map((rs) => rs.reduce((a, r) => a + r, 0))
  const periodsWon = sums.filter((x) => x > 0).length
  const perMonth = tradingDays ? (s.n / tradingDays) * 21 : null
  const out = { ...s, cautious: s.score, periods: P, periodsWon, perMonth }
  if (s.score == null) return out
  if (minPerMonth > 0 && perMonth != null && perMonth < minPerMonth) return { ...out, score: null, why: 'rare' }
  if (P < 2) return out
  if (P >= 3 && periodsWon * 2 < P) return { ...out, score: null, why: 'inconsistent' }
  const avgs = perPeriod.map((rs, i) => (rs.length ? (sums[i] / rs.length) * (rs.length / (rs.length + 3)) : 0))
  const mean = avgs.reduce((a, x) => a + x, 0) / P
  const sd = Math.sqrt(avgs.reduce((a, x) => a + (x - mean) ** 2, 0) / (P - 1))
  return { ...out, score: mean - sd / Math.sqrt(P) }
}

/** Among the settings scoring within this share of the top one, the one changing the fewest parameters from as written
 *  is chosen - each change has to earn its place, or it is fitting the days. */
export const NEAR_BEST = 0.15
/** How many parameters a setting changes from `from` (as written). */
export const changesFrom = (v, from) => Object.keys(v).filter((k) => String(v[k]) !== String(from[k] ?? '')).length

/** From rows sorted best score first: the one changing the fewest parameters from `asWritten` among those within
 *  NEAR_BEST of the top score (ties: the higher score). { chosen, nearBest (how many were that close) }. */
export function pickSimplest(rows, asWritten) {
  const top = rows[0] ?? null
  if (!top || !(top.train.score > 0)) return { chosen: top, nearBest: 0 }
  const floor = top.train.score * (1 - NEAR_BEST)
  const near = rows.filter((r) => r.train.score >= floor)
  near.sort((a, b) => changesFrom(a.params, asWritten) - changesFrom(b.params, asWritten) || b.train.score - a.train.score || (a.at ?? 0) - (b.at ?? 0))
  return { chosen: near[0], nearBest: near.length }
}

const run = (days, id, variant, trail) => days.flatMap((d) => dayTrades(d, id, variant, trail))

/** Strategy `id`'s trades with `variant` on each day: date -> { n, total, wins } in R (unit 'R', the index trade) or in
 *  option premium points (unit 'pts', the option trade as tuned) - the same measure the tuning scored it in. */
export function perDay(days, id, variant, unit = 'R', trail = null) {
  const out = new Map()
  for (const day of days) {
    const xs = unit === 'pts' ? optionRun([day], id, variant, trail) : run([day], id, variant, trail)
    out.set(day.date, { n: xs.length, total: xs.reduce((a, b) => a + b, 0), wins: xs.filter((x) => x > 0).length })
  }
  return out
}

/** A tuned setting's params as tried (the trade filters' defaults - and for the option trade the option defaults -
 *  under what was tuned), and the strategy as written in the same measure. */
export const checkVariant = (params, unit = 'R') => (unit === 'pts' ? { ...DEFAULT_VARIANT, ...OPTION_DEFAULT, ...params } : { ...DEFAULT_VARIANT, ...params })
export const asWrittenVariant = (unit = 'R') => (unit === 'pts' ? { ...DEFAULT_VARIANT, ...OPTION_DEFAULT } : DEFAULT_VARIANT)

/**
 * THE CROSS-CHECK. Tuning one month and then another gives two different "best" settings, each judged only on its
 * own month's held-back days - so they cannot be compared, and either may just fit its own month. Here a setting is
 * measured on days it was NOT chosen on (`days` - the caller leaves its train days out): per day its trades, and the
 * strategy as written on the same day. Every run checks every setting found so far for its index this way, so each
 * one builds up a record on unseen days across months, and the best is the one that keeps winning there.
 * Rows only for days where either traded.
 */
export function checkSetting(days, id, params, unit = 'R', trail = null, asWritten = null) {
  const mine = perDay(days, id, checkVariant(params, unit), unit, trail)
  const base = asWritten ?? perDay(days, id, asWrittenVariant(unit), unit, trail)
  return days.map((d) => {
    const m = mine.get(d.date) ?? { n: 0, total: 0, wins: 0 }
    const b = base.get(d.date) ?? { n: 0, total: 0, wins: 0 }
    return { date: d.date, n: m.n, total: m.total, wins: m.wins, baseN: b.n, baseTotal: b.total }
  }).filter((r) => r.n > 0 || r.baseN > 0)
}

/** The strategies as written (default trade filters), ranked by their cautious score on all the days -
 *  the "top" to tune first. Strategies with fewer than `minTrades` trades are listed after, unranked. */
export function rankStrategies(days, { trail = null, minTrades = 8, ids = ACTIVE_STRATEGIES.map((s) => s.id) } = {}) {
  return ids.map((id) => ({ id, ...scoreR(run(days, id, DEFAULT_VARIANT, trail)) }))
    .sort((a, b) => ((b.n >= minTrades) - (a.n >= minTrades)) || ((b.score ?? -Infinity) - (a.score ?? -Infinity)) || (b.total - a.total))
}

/**
 * Every combination of trade filters for strategy `id` on the scanned `days`. Returns the strategy as written
 * (baseline) and the best combination - chosen on the train days, checked on the test days - with the top
 * `keep` combinations, and whether the best one is worth applying.
 */
export function tuneStrategy(days, id, { trail = null, minTrades = 8, minPerMonth = 0, simplest = true, trainFraction = 0.7, grid = null, keep = 10, what = 'trade', base = DEFAULT_VARIANT, oiKeys = null, search = 'step', onProgress = null, underlying = null } = {}) {
  const rules = { minPerMonth, simplest }
  if (what === 'all') {
    // Everything in turn: the OI confirmation, the trade settings on top, then how it is taken in options.
    const oi = tuneStrategy(days, id, { trail, minTrades, ...rules, trainFraction, keep, what: 'oi', base, oiKeys, search, onProgress, underlying })
    const tr = tuneStrategy(days, id, { trail, minTrades, ...rules, trainFraction, keep, what: 'trade', base: oi.best?.params ?? base, onProgress, underlying })
    const op = tuneStrategy(days, id, { trail, minTrades, ...rules, trainFraction, keep, what: 'option', base: tr.best?.params ?? oi.best?.params ?? base, onProgress, underlying })
    return { ...op, what, tried: oi.tried + tr.tried + op.tried, factors: [...(oi.factors ?? []), ...(tr.factors ?? []), ...(op.factors ?? [])], oiStage: { best: oi.best, reason: oi.reason }, tradeStage: { best: tr.best, reason: tr.reason } }
  }
  if (what === 'both') {
    // The OI confirmation first (chosen on the train days only), then the trade settings on top of it.
    const oi = tuneStrategy(days, id, { trail, minTrades, ...rules, trainFraction, keep, what: 'oi', base, oiKeys, search, onProgress, underlying })
    const onTop = tuneStrategy(days, id, { trail, minTrades, ...rules, trainFraction, keep, what: 'trade', base: oi.best?.params ?? base, onProgress, underlying })
    return { ...onTop, what, tried: oi.tried + onTop.tried, qualified: oi.qualified + onTop.qualified, factors: [...(oi.factors ?? []), ...(onTop.factors ?? [])], oiStage: { best: oi.best, reason: oi.reason } }
  }
  const explicitGrid = grid != null
  const isOpt = what === 'option'
  grid = grid ?? (what === 'oi' ? oiGridOf(oiKeys) : isOpt ? OPTION_GRID : TUNING_GRID)
  if (isOpt) base = { ...OPTION_DEFAULT, ...base }
  // Scored in R on the index trade, or - the option trade - in premium points.
  const score = (ds, v) => (isOpt ? optionRun(ds, id, v, trail) : run(ds, id, v, trail))
  const asWritten = isOpt ? { ...DEFAULT_VARIANT, ...OPTION_DEFAULT } : DEFAULT_VARIANT
  const { train, test } = splitDays(days, trainFraction)
  // Chosen month by month (robustScore): each setting is scored on every stretch of the train days, not on them added up.
  const periods = periodsOf(train)
  const trainScore = (v) => robustScore(periods.map((p) => score(p, v)), { tradingDays: train.length, minPerMonth })
  const baseline = { params: asWritten, train: robustScore(periods.map((p) => score(p, asWritten)), { tradingDays: train.length }), test: scoreR(score(test, asWritten)) }
  // What each tuned input did: for every value it was tried at, the best train score of a combination with it.
  const tally = new FactorTally(grid, base, minTrades)
  let rows = []
  let tried = 0
  if (what === 'oi' && !explicitGrid && search !== 'full') {
    // Step by step (stepSearch): each OI filter takes its best value given the others, then a second pass.
    const found = stepSearch(grid, base, (v) => tally.add(v, trainScore(v)), { minTrades, onProgress })
    rows = found.rows
    tried = found.tried
  } else {
    // Every combination (the trade settings always; the OI inputs when asked: search 'full').
    let of = null
    if (what === 'oi' && !explicitGrid) {
      const n = countOiCombinations(oiKeys)
      if (n.over) throw new Error(`more than ${OI_COMBO_CAP.toLocaleString('en-IN')} OI combinations - untick some OI inputs, or search step by step`)
    }
    // Walked in the order the outcome cache wants - every combination that ends its trades the same way together (see
    // outcomeKey), so each day works a setup's outcome out once instead of once per combination. `at` keeps each
    // combination's place in the plain order, so the same one still wins a tie as before.
    const list = []
    let at = 0
    for (const v of variants(grid, base)) {
      // The timeframe only means something with an OI change or futures OI filter on; without one, 1 / 3 / 5 / 15
      // are the same trades - tried once (at 15).
      if (oiVariantRedundant(v) || (isOpt && optionVariantRedundant(v))) continue
      list.push({ v, at: at++, key: isOpt ? '' : outcomeKey(v, trail) })
    }
    list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || a.at - b.at)
    // Every stage says where it is - the trade settings and the option trade too, not only the OI search: a stage that
    // reports nothing looks like a job that stopped, and cannot be stopped by the job's time budget either.
    of = list.length
    const part = what
    if (onProgress) onProgress({ tried: 0, of, part })
    for (const { v, at: i } of list) {
      tried++
      if (onProgress && tried % 250 === 0) onProgress({ tried, of, part })
      const tr = tally.add(v, trainScore(v))
      if (tr.n < minTrades || tr.score == null) continue
      rows.push({ params: v, train: tr, at: i })
    }
  }
  rows.sort((a, b) => b.train.score - a.train.score || b.train.total - a.train.total || (a.at ?? 0) - (b.at ?? 0))
  // Of the settings within NEAR_BEST of the top score, the one closest to as written: a change has to earn its place.
  const { chosen, nearBest } = simplest ? pickSimplest(rows, asWritten) : { chosen: rows[0] ?? null, nearBest: 0 }
  const ordered = chosen ? [chosen, ...rows.filter((r) => r !== chosen)] : rows
  const top = ordered.slice(0, keep).map((r) => ({ ...r, test: scoreR(score(test, r.params)) }))
  // Nothing reached the minimum trades (in all, or a month): show what there is anyway - the best setting with even a couple of trades -
  // marked "below the minimum", never recommended. (Under 2 trades there is no score to rank by.)
  if (!top.length && (minTrades > 2 || minPerMonth > 0)) {
    const loose = tuneStrategy(days, id, { trail, minTrades: 2, minPerMonth: 0, simplest, trainFraction, grid: explicitGrid ? grid : null, keep, what, base, oiKeys, search, onProgress: onProgress && ((p) => onProgress({ ...p, again: true })), underlying })
    if (loose.best) {
      const few = loose.best.train.n < minTrades
      return { ...loose, belowMin: true, minTradesWanted: minTrades, recommend: false,
        reason: few ? `only ${loose.best.train.n} trade(s) on the ${train.length} train day(s), below the minimum of ${minTrades} - shown for information, not enough to trust`
          : `no setting traded ${minPerMonth}+ times a month on the train days and held up month by month - the one shown trades ${loose.best.train.perMonth?.toFixed(1) ?? '?'} a month; for information, not enough to trust` }
    }
  }
  let best = top[0] ?? null
  // What the best setting and the strategy as written captured, in points, on all the days.
  const details = (params) => (isOpt ? optionDetails(days, id, params, trail, underlying) : tradeDetails(days, id, params, trail, underlying))
  const detail = (params) => { const trades = details(params); return { points: pointsSummary(trades), trades } }
  if (best) best = { ...best, ...detail(best.params) }
  baseline.points = pointsSummary(details(asWritten))
  // The option setting in the scanner's terms: its SL / target in premium points on a typical (median) entry premium.
  if (best && isOpt && best.trades.length && (best.params.optExit ?? 'index') !== 'index') {
    const premiums = best.trades.map((t) => t.opt.entry).sort((a, b) => a - b)
    const median = premiums[Math.floor(premiums.length / 2)]
    best = { ...best, suggest: { premium: median, slPoints: median * best.params.optSlPct / 100, targetPoints: ownTarget(best.params.optExit) ? median * best.params.optTargetPct / 100 : null, moneyness: best.params.optMoneyness, leg: best.params.optLeg } }
  }
  const unit = isOpt ? ' pts' : 'R'
  let recommend = false
  let reason
  const monthsText = best?.train.periods >= 2 ? ` - made money in ${best.train.periodsWon} of the ${best.train.periods} ${periods.length && String(periods[0][0]?.date).slice(0, 7) !== String(periods[1]?.[0]?.date).slice(0, 7) ? 'months' : 'stretches'} it was chosen on` : ''
  const simplerText = nearBest > 1 && chosen !== rows[0] ? `; the simplest of ${nearBest} settings within ${Math.round(NEAR_BEST * 100)}% of the top score` : ''
  if (!best) reason = `no combination had ${minTrades}+ trades${minPerMonth ? ` (and ${minPerMonth}+ a month)` : ''} and held up month by month on the ${train.length} train day(s)`
  else if (!test.length) reason = `only ${days.length} day(s) - too few to check on unseen days (need 5+); not recommended yet`
  else if (best.test.n < 3) reason = `the best combination took only ${best.test.n} trade(s) on the ${test.length} test day(s) - not enough to trust`
  else if (!(best.test.total > 0)) reason = `the best combination lost on the test days (${best.test.total.toFixed(2)}${unit}) - it fitted the past`
  else if (baseline.test.n && !(best.test.avg > (baseline.test.avg ?? -Infinity))) reason = `on the test days it did not beat the ${isOpt ? 'option taken as before (ATM sell, out with the index trade)' : 'strategy as written'} (${best.test.avg.toFixed(2)}${unit} vs ${baseline.test.avg.toFixed(2)}${unit} a trade)`
  else if (best.train.periods >= 2 && best.train.periodsWon * 2 < best.train.periods) reason = `it made money in only ${best.train.periodsWon} of the ${best.train.periods} stretches it was chosen on - one stretch carried it`
  else { recommend = true; reason = `better on the train days${monthsText} and on the ${test.length} unseen test day(s)${simplerText}` }
  if (best && !recommend) reason += simplerText
  return {
    id, name: STRATEGY_BY_ID[id]?.name ?? id, no: STRATEGY_BY_ID[id]?.no ?? null, what, unit: isOpt ? 'pts' : 'R',
    days: days.length, trainDays: train.map((d) => d.date), testDays: test.map((d) => d.date),
    tried, qualified: rows.length, baseline, best, top, recommend, reason, factors: tally.report(best?.params),
    selection: { periods: periods.length, minPerMonth, nearBest, simplest: !!chosen && chosen !== rows[0], changes: best ? changesFrom(best.params, asWritten) : 0 },
  }
}

/**
 * WALK-FORWARD: the whole way of choosing a setting, tested the way it will be used. The days in date order: the first
 * half is the first training window; the rest is cut into `folds` blocks. For each block the setting is CHOSEN again on
 * every day before it (tuneStrategy on those days only) and then traded on the block, which it has never seen; the next
 * block adds the last one to its training days. { folds: [...], n, avg, total, baseAvg, foldsWon, passed, reason } - null
 * when there are too few days (about 30, a block of 5+).
 *  passed = out of sample over all the blocks it took 3+ trades, made money, beat the strategy as written on the same
 *  blocks, and made money in at least half the blocks.
 */
export function walkForward(days, id, tuneOpts = {}, { folds = 3, firstFraction = 0.5 } = {}) {
  const sorted = [...days].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const first = Math.max(15, Math.floor(sorted.length * firstFraction))
  const rest = sorted.length - first
  const k = Math.min(folds, Math.floor(rest / 5))
  if (k < 2) return null
  const size = Math.floor(rest / k)
  const { trail = null } = tuneOpts
  const out = []
  for (let i = 0; i < k; i++) {
    const from = first + i * size
    const to = i === k - 1 ? sorted.length : from + size
    const trainDays = sorted.slice(0, from)
    const block = sorted.slice(from, to)
    const r = tuneStrategy(trainDays, id, { ...tuneOpts, keep: 1, onProgress: tuneOpts.onProgress && ((p) => tuneOpts.onProgress({ ...p, fold: i + 1, folds: k })) })
    const isOpt = r.unit === 'pts'
    const asWritten = r.baseline.params
    const measure = (v) => scoreR(isOpt ? optionRun(block, id, v, trail) : run(block, id, v, trail))
    const written = measure(asWritten)
    // A fold that finds nothing it would apply trades as written - the setting it would really have run.
    const chosen = r.best && r.recommend ? r.best.params : asWritten
    const m = chosen === asWritten ? written : measure(chosen)
    out.push({ trainDays: trainDays.length, days: block.map((d) => d.date), params: chosen, changed: chosen !== asWritten, n: m.n, avg: m.avg, total: m.total, baseN: written.n, baseAvg: written.avg, baseTotal: written.total })
  }
  const n = out.reduce((a, f) => a + f.n, 0)
  const total = out.reduce((a, f) => a + f.total, 0)
  const baseN = out.reduce((a, f) => a + f.baseN, 0)
  const baseTotal = out.reduce((a, f) => a + f.baseTotal, 0)
  const avg = n ? total / n : null
  const baseAvg = baseN ? baseTotal / baseN : null
  const foldsWon = out.filter((f) => f.total > 0).length
  let reason
  if (n < 3) reason = `chosen again before each of ${k} blocks, it took only ${n} trade(s) on them - not enough to trust`
  else if (!(total > 0)) reason = `chosen again before each of ${k} blocks, it lost on the blocks it had not seen (${total.toFixed(2)})`
  else if (baseAvg != null && !(avg > baseAvg)) reason = `on the ${k} unseen blocks it did not beat the strategy as written (${avg.toFixed(2)} vs ${baseAvg.toFixed(2)} a trade)`
  else if (foldsWon * 2 < k) reason = `it made money in only ${foldsWon} of the ${k} unseen blocks`
  else reason = `chosen again before each of ${k} blocks it had not seen, it made money in ${foldsWon} of ${k} (${avg.toFixed(2)} a trade over ${n} trades)`
  return { folds: out, count: k, n, avg, total, baseN, baseAvg, foldsWon, passed: n >= 3 && total > 0 && !(baseAvg != null && !(avg > baseAvg)) && foldsWon * 2 >= k, reason }
}

/** `result` (a tuneStrategy result) with its walk-forward added; one that fails it is no longer recommended. */
export function withWalkForward(result, days, id, tuneOpts, folds) {
  if (!folds || !result.best || result.belowMin) return result
  const wf = walkForward(days, id, tuneOpts, { folds })
  if (!wf) return { ...result, walkForward: null }
  const recommend = result.recommend && wf.passed
  return { ...result, walkForward: wf, recommend, reason: result.recommend && !wf.passed ? `walk-forward: ${wf.reason} - not recommended (${result.reason})` : `${result.reason}; walk-forward: ${wf.reason}` }
}

/** The best train score each value of each tuned input reached (over the combinations tried with that value), so the
 *  result can show that every ticked input was tried - and what it did - even when it stays at Any. 'window' is the
 *  entry window (tradeFrom / tradeTo). */
const factorValue = (key, v) => (key === 'window' ? `${v.tradeFrom}-${v.tradeTo}` : v[key])
const gridValue = (key, x) => (key === 'window' ? `${x[0]}-${x[1]}` : x)
class FactorTally {
  constructor(grid, base, minTrades) {
    this.minTrades = minTrades
    this.keys = Object.keys(grid)
    this.grid = grid
    this.base = base
    this.by = new Map(this.keys.map((k) => [k, new Map()]))
  }
  add(v, s) {
    const ok = s.score != null && s.n >= this.minTrades
    for (const k of this.keys) {
      const val = factorValue(k, v)
      const m = this.by.get(k)
      const cur = m.get(val) ?? { tried: 0, best: null, maxN: 0 }
      cur.tried++
      cur.maxN = Math.max(cur.maxN, s.n)
      if (ok && (!cur.best || s.score > cur.best.score)) cur.best = { n: s.n, avg: s.avg, total: s.total, winRate: s.winRate, score: s.score }
      m.set(val, cur)
    }
    return s
  }
  report(bestParams) {
    return this.keys.map((key) => ({
      key,
      start: factorValue(key, this.base),
      chosen: bestParams ? factorValue(key, bestParams) : null,
      values: this.grid[key].map((x) => ({ value: gridValue(key, x), ...(this.by.get(key).get(gridValue(key, x)) ?? { tried: 0, best: null, maxN: 0 }) })),
    }))
  }
}

/** A scanned day for the tuning: its setups (every minute) and the bars / end its outcomes are read to. */
export function tuningDay(date, setups, replayDay, oi = null) {
  const range = replayRange(replayDay)
  return { date, setups, minuteBars: replayDay.minuteBars, endMs: (range?.end ?? 0) + MIN, oi }
}

/** The filters to save for a tuned strategy: its own entry filters kept, the tuned trade filters on top (only
 *  the ones that differ from the default). */
export function filtersFromTuning(current, params, { option = false } = {}) {
  const out = { ...(current ?? {}) }
  // Every trade filter is either set to what was tuned or removed, so applying a new result REPLACES the last one
  // rather than leaving half of it behind. The strategy's own entry filters (its rules) are untouched.
  for (const f of TRADE_FILTERS) {
    if (params[f.key] === undefined || params[f.key] === f.default) delete out[f.key]
    else out[f.key] = params[f.key]
  }
  // How it is taken in OPTIONS. The option tuning speaks in optLeg / optMoneyness / optSlPct / optTargetPct; the
  // scanner reads tradeOptLeg / tradeOptMoneyness / tradeOptSlPct / tradeOptTargetPct (optionPlanFor), so they are
  // carried across here - otherwise "buy instead of sell" was found and then never actually used.
  for (const key of OPTION_TRADE_FILTERS) delete out[key]
  // ... but only when the option itself was tuned. A run that only tuned the trade settings carries the option
  // defaults along for the ride, and applying those would pin the strategy to "sell ATM" the trader never chose.
  if (!option) return out
  if (params.optLeg === 'buy' || params.optLeg === 'sell') out.tradeOptLeg = params.optLeg
  if (Number.isFinite(params.optMoneyness)) out.tradeOptMoneyness = params.optMoneyness
  // The exit EXACTLY as measured (tradeOptExit - optionPlanFor then adds none of the index's option points or its option
  // trailing stop): its own SL / target only where the tuning used them ('first' or 'option'; 'indexSl' - the Max SL
  // only); with 'index' the option goes out with the index trade and nothing else.
  out.tradeOptExit = OPTION_GRID.optExit.includes(params.optExit) ? params.optExit : 'index'
  if (ownTarget(params.optExit) || params.optExit === 'indexSl') {
    if (params.optSlPct > 0) out.tradeOptSlPct = params.optSlPct
    if (ownTarget(params.optExit) && params.optTargetPct > 0) out.tradeOptTargetPct = params.optTargetPct
  }
  return out
}

/** One line for a combination. */
export function variantText(v) {
  const hm = (x) => `${String(Math.floor(x / 100)).padStart(2, '0')}:${String(x % 100).padStart(2, '0')}`
  const parts = [v.tradeSide === 'both' ? 'long & short' : `${v.tradeSide} only`, `${hm(v.tradeFrom)}-${hm(v.tradeTo)}`]
  if (v.tradeStopX !== 1) parts.push(`stop x${v.tradeStopX}`)
  if (v.tradeTargetX !== 1) parts.push(`target x${v.tradeTargetX}`)
  if (v.tradeTimeStop > 0) parts.push(`time stop ${v.tradeTimeStop}m`)
  if (v.tradeTrail !== 'scanner') parts.push(v.tradeTrail === 'off' ? 'no trail' : `trail ${v.tradeTrail}R`)
  const oi = oiGateText(v)
  if (oi) parts.push(oi)
  return parts.join(' · ')
}

/** The parameters a tuned setting is made of - one column each in the tuning history's settings CSV
 *  (scanner-runner/tuneHistory.mjs SETTING_KEYS is this list). */
export const TUNED_SETTING_KEYS = [
  'tradeSide', 'tradeFrom', 'tradeTo', 'tradeStopX', 'tradeTargetX', 'tradeTimeStop', 'tradeTrail',
  'tradeOiWindow', 'tradeFutWindow', 'tradeOiFlow', 'tradeOiCum', 'tradeWallOi', 'tradeSideOi', 'tradeSideCum',
  'tradeFutOi', 'tradeMoveSize', 'tradeDayType', 'tradeWallRoom',
  'optLeg', 'optMoneyness', 'optExit', 'optSlPct', 'optTargetPct',
]

/** A tuned setting's identity, exactly as the server makes it (TuningPerformance.SignatureOf): its non-empty
 *  parameter columns, sorted, "key=value" joined by "|". From a settings row (strings) or from params as tuned (only
 *  the columns the history keeps). Applied with the setting (`_tuned` in the strategy's filters), so the live list can
 *  judge the strategy by that setting's record on unseen days. */
export function settingSignature(rowOrParams) {
  return TUNED_SETTING_KEYS.filter((k) => rowOrParams?.[k] != null && String(rowOrParams[k]) !== '')
    .sort().map((k) => `${k}=${String(rowOrParams[k])}`).join('|')
}

/** Every parameter of a tuned setting beside its default: [{ key, label, value, changed }] - the trade settings, the
 *  OI confirmation, and how it is taken in options. `from`: 'row' (a settings CSV row - strings), 'params' (as tuned)
 *  or 'filters' (a strategy's applied filters: tradeOpt* for the option). */
export function settingParams(source, from = 'params') {
  const p = from === 'row' ? paramsFromSettingsRow(source) : (source ?? {})
  const show = (f, v) => f.options?.find((o) => String(o.value) === String(v))?.label ?? String(v)
  const out = TRADE_FILTERS.filter((f) => TUNED_SETTING_KEYS.includes(f.key)).map((f) => {
    const v = p[f.key] ?? f.default
    return { key: f.key, label: f.label, value: show(f, v), changed: String(v) !== String(f.default) }
  })
  const opt = from === 'filters'
    ? { leg: p.tradeOptLeg, m: p.tradeOptMoneyness, exit: null, sl: p.tradeOptSlPct, tg: p.tradeOptTargetPct }
    : { leg: p.optLeg, m: p.optMoneyness, exit: p.optExit, sl: p.optExit && p.optExit !== 'index' ? p.optSlPct : null, tg: ownTarget(p.optExit) ? p.optTargetPct : null }
  if (opt.leg === 'buy' || opt.leg === 'sell') {
    const m = Number(opt.m) || 0
    out.push({ key: 'optLeg', label: 'Option: buy or sell', value: opt.leg.toUpperCase(), changed: true })
    out.push({ key: 'optMoneyness', label: 'Option: strike', value: m === 0 ? 'ATM' : `${Math.abs(m)} ${m > 0 ? 'ITM' : 'OTM'}`, changed: m !== 0 })
  }
  if (opt.exit) out.push({ key: 'optExit', label: 'Option: exit', value: { index: 'with the index trade', indexSl: 'with the index trade, capped at a Max SL', first: 'own SL / target or the index exit, first', option: 'own SL / target only' }[opt.exit] ?? opt.exit, changed: opt.exit !== 'index' })
  if (opt.sl > 0) out.push({ key: 'optSl', label: 'Option: SL (% of the premium)', value: `${opt.sl}%`, changed: true })
  if (opt.tg > 0) out.push({ key: 'optTarget', label: 'Option: target (% of the premium)', value: `${opt.tg}%`, changed: true })
  return out
}

/** A tuned setting read back from the tuning history (a row of {run}-settings.csv: every value a string) as the params
 *  `filtersFromTuning` / `applyTunedFilters` take: a value that is one of the filter's options becomes that option's
 *  own value (930 the number, 'long' the text), a number becomes a number, an empty field is left out. */
export function paramsFromSettingsRow(row) {
  const keys = [...TRADE_FILTERS.map((f) => f.key), ...Object.keys(OPTION_DEFAULT)]
  const out = {}
  for (const key of keys) {
    const raw = row?.[key]
    if (raw == null || raw === '') continue
    const f = TRADE_FILTERS.find((x) => x.key === key)
    const option = f?.options?.find((o) => String(o.value) === String(raw))
    if (option) out[key] = option.value
    else if (/^-?\d+(\.\d+)?$/.test(String(raw))) out[key] = Number(raw)
    else out[key] = raw
  }
  return out
}

/** The parameters a tuned setting is made of, as the lab and the tuning speak them (opt* for the option), read back from
 *  a strategy's APPLIED filters (tradeOpt* - filtersFromTuning's way round): what is applied, to start the lab from. */
export function paramsFromFilters(filters) {
  const f = filters ?? {}
  const out = {}
  for (const tf of TRADE_FILTERS) if (TUNED_SETTING_KEYS.includes(tf.key) && f[tf.key] !== undefined && f[tf.key] !== tf.default) out[tf.key] = f[tf.key]
  if (f.tradeOptLeg === 'buy' || f.tradeOptLeg === 'sell') {
    out.optLeg = f.tradeOptLeg
    out.optMoneyness = Number.isFinite(Number(f.tradeOptMoneyness)) ? Number(f.tradeOptMoneyness) : 0
    // Its exit as stored (tradeOptExit); from before that was stored: its own target too = out at whichever of its SL /
    // target comes first; its SL only = the Max SL, out with the index.
    out.optExit = OPTION_GRID.optExit.includes(f.tradeOptExit) ? f.tradeOptExit : f.tradeOptTargetPct > 0 ? 'first' : f.tradeOptSlPct > 0 ? 'indexSl' : 'index'
    if (f.tradeOptSlPct > 0) out.optSlPct = f.tradeOptSlPct
    if (f.tradeOptTargetPct > 0) out.optTargetPct = f.tradeOptTargetPct
  }
  return out
}

const optionStats = (trades) => {
  const pts = trades.map((t) => t.opt.points).filter(Number.isFinite)
  const rs = trades.map((t) => t.opt.r).filter(Number.isFinite)
  const captured = pts.filter((p) => p > 0).reduce((a, b) => a + b, 0)
  const lost = pts.filter((p) => p < 0).reduce((a, b) => a + b, 0)
  return { n: pts.length, wins: pts.filter((p) => p > 0).length, losses: pts.filter((p) => p < 0).length, winRate: pts.length ? pts.filter((p) => p > 0).length / pts.length : null,
    captured, lost, total: captured + lost, avg: pts.length ? (captured + lost) / pts.length : null, totalR: rs.length ? rs.reduce((a, b) => a + b, 0) : null }
}

/**
 * THE STRATEGY LAB: strategy `id` with ONE setting (`params` - the tuned-setting keys, TUNED_SETTING_KEYS; {} = as
 * written) measured over the scanned `days` - with the same functions the tuning measures by (takenTrades: the same
 * filters, the same outcome rules), so a setting shows here exactly what the tuning would have counted for it. The index
 * trades (R, points captured / lost, both options the setup carries - held to the index's Max SL / Max target when
 * `optionLevels` is given) and, when the setting takes the option its own way (optLeg buy / sell), those option trades.
 */
export function evaluateSetting(days0, id, params = {}, { trail = null, underlying = null, optionLevels = null } = {}) {
  // The index's max rules on every day (Max SL / Max target - optionLevels), as the scanner holds every option trade to them.
  const days = optionLevels ? days0.map((d) => (d.optionCaps ? d : { ...d, optionCaps: { maxSl: optionLevels.maxSl ?? optionLevels.sl, maxTarget: optionLevels.maxTarget ?? optionLevels.target } })) : days0
  const variant = { ...DEFAULT_VARIANT }
  for (const f of TRADE_FILTERS) if (params[f.key] !== undefined && params[f.key] !== null && params[f.key] !== '') variant[f.key] = params[f.key]
  const trades = tradeDetails(days, id, variant, trail, underlying, { optionLevels })
  const leg = params.optLeg === 'buy' || params.optLeg === 'sell' ? params.optLeg : null
  const opt = leg
    ? { ...OPTION_DEFAULT, ...variant, optLeg: leg, optMoneyness: Number(params.optMoneyness) || 0, optExit: params.optExit ?? 'index', optSlPct: Number(params.optSlPct) || OPTION_DEFAULT.optSlPct, optTargetPct: Number(params.optTargetPct) || OPTION_DEFAULT.optTargetPct }
    : null
  const optionTrades = opt ? optionDetails(days, id, opt, trail, underlying) : null
  return {
    params: { ...Object.fromEntries(Object.entries(variant).filter(([k, v]) => v !== DEFAULT_VARIANT[k])), ...(opt ? { optLeg: opt.optLeg, optMoneyness: opt.optMoneyness, optExit: opt.optExit, optSlPct: opt.optSlPct, optTargetPct: opt.optTargetPct } : {}) },
    text: `${variantText(variant)}${opt ? ` · ${optionText(opt)}` : ''}`,
    r: scoreR(trades.map((t) => t.r)),
    points: pointsSummary(trades),
    trades,
    option: opt ? { text: optionText(opt), ...optionStats(optionTrades), trades: optionTrades } : null,
  }
}

// ---- The Strategy lab's setting ---------------------------------------------------------------------------------------
// The order-flow confirmation the learning found (not tuned by a run, but a setting all the same - futures only).
const LAB_FLOW_KEYS = ['tradeTape', 'tradeBig', 'tradeBook', 'tradeCvd', 'tradeVolume']
const LAB_OPT_KEYS = ['optLeg', 'optMoneyness', 'optExit', 'optSlPct', 'optTargetPct']

/** The keys a lab setting is edited with, for a data mode: the trade settings and OI confirmation the tuning tunes (no
 *  futures / order-flow input for spot + options - it has no futures), and the order-flow ones (futures only). */
export function labEditableKeys(data) {
  const usable = new Set(oiFactorsFor(data).map((f) => f.key))
  const allOi = new Set(OI_FACTORS.map((f) => f.key))
  const tuned = TUNED_SETTING_KEYS.filter((k) => !LAB_OPT_KEYS.includes(k) && (!allOi.has(k) || usable.has(k)))
  return data === 'spot' ? tuned : [...tuned, ...LAB_FLOW_KEYS]
}

/** The Strategy lab's CHANGES for several strategies at once, put on top of each one's own starting point (the job's
 *  labBase): every key set - one set back to its default too, since a starting point may have another - the option part
 *  as labParams has it, or optLeg 'none' to take an option leg off. Nothing set = each as its starting point. */
export function labOverrides(params, data) {
  const out = {}
  for (const k of labEditableKeys(data)) if (params?.[k] !== undefined && params[k] !== null && params[k] !== '') out[k] = params[k]
  if (params?.optLeg === 'buy' || params?.optLeg === 'sell') {
    const full = labParams(params, data)
    for (const k of ['optLeg', 'optMoneyness', 'optExit', 'optSlPct', 'optTargetPct']) if (full[k] !== undefined) out[k] = full[k]
  } else if (params?.optLeg === 'none') out.optLeg = 'none'
  return out
}

/** A lab setting as sent to the job (and applied): only what differs from the strategy as written, the option part only
 *  when an option leg is chosen, and of it only what that exit uses. */
export function labParams(params, data) {
  const out = {}
  for (const k of labEditableKeys(data)) {
    const f = TRADE_FILTERS.find((x) => x.key === k)
    if (params?.[k] !== undefined && params[k] !== null && params[k] !== '' && params[k] !== f?.default) out[k] = params[k]
  }
  if (params?.optLeg === 'buy' || params?.optLeg === 'sell') {
    const n = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
    out.optLeg = params.optLeg
    out.optMoneyness = n(params.optMoneyness) ?? 0
    out.optExit = OPTION_GRID.optExit.includes(params.optExit) ? params.optExit : 'index'
    if (out.optExit !== 'index') out.optSlPct = n(params.optSlPct) ?? OPTION_DEFAULT.optSlPct
    if (ownTarget(out.optExit)) out.optTargetPct = n(params.optTargetPct) ?? OPTION_DEFAULT.optTargetPct
  }
  return out
}
