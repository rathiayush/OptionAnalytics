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

import { ACTIVE_STRATEGIES, OPTION_TRADE_FILTERS, STRATEGY_BY_ID, TRADE_FILTERS, applyTradeFilter, oiGateText, optionStopTargetHit, optionTradeAt, premiumAt, simulateOutcome } from './strategyEngine.js'
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
]

/** The OI inputs worth tuning for a data mode. Spot + options has no futures at all - its setups carry no futures OI
 *  and no futures move (spotEngine leaves both null), so a futures filter there could only ever block a trade, never
 *  confirm one. Those inputs are left out rather than offered and silently wasted. */
export const oiFactorsFor = (data) => (data === 'spot' ? OI_FACTORS.filter((f) => !f.futures) : OI_FACTORS)

// ---- the option trade ------------------------------------------------------------------------------------
/**
 * How the trade is taken in options (tuned by `what: 'option'`), on top of the index trade the signal gives:
 *   optLeg        'sell' (write the option that loses value with the move - the scanner's default) or 'buy' (the one
 *                 that gains with it);
 *   optMoneyness  0 = ATM, +n = n strikes in the money, -n = n out of the money (optionTradeAt);
 *   optExit       'index' - out when the index trade exits (stop / target / trail / time stop): what the tuning did
 *                 before; 'first' - the option's own SL / target, or the index trade's exit, whichever comes first;
 *                 'option' - only the option's own SL / target (else the 15:10 square-off);
 *   optSlPct / optTargetPct - the option's SL / target as a % of its entry premium, so they scale with moneyness.
 * The option's levels are checked minute by minute on its premium from the first full minute after the entry, filled
 * at the level (optionStopTargetHit - the scanner's own rule). Scored in premium points.
 */
export const OPTION_GRID = {
  optLeg: ['sell', 'buy'],
  optMoneyness: [0, 1, -1, 2, -2],
  optExit: ['index', 'first', 'option'],
  optSlPct: [20, 15, 25, 30, 40],
  optTargetPct: [30, 20, 50, 75, 100],
}
export const OPTION_DEFAULT = { optLeg: 'sell', optMoneyness: 0, optExit: 'index', optSlPct: 20, optTargetPct: 30 }
/** Out with the index trade: the option's SL / target are not used - tried once. */
export const optionVariantRedundant = (v) => (v.optExit ?? 'index') === 'index' && ((v.optSlPct ?? 20) !== 20 || (v.optTargetPct ?? 30) !== 30)

const SQUARE_OFF_MIN = 15 * 60 + 10
const istMinuteOf = (ms) => Math.floor((ms / MIN + 330) % 1440)

/** One setup traded in options as `v` says: the option, its entry and exit premium, the points and why it closed - or
 *  null when the option has no premium (that strike was not traded / not loaded). */
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
  if (exitMode !== 'index') {
    const hit = optionStopTargetHit(day.oi, trade, s.t, exitMs, trade.premium * (v.optSlPct ?? 20) / 100, trade.premium * (v.optTargetPct ?? 30) / 100)
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
      // The option's own SL / target premiums (used unless it goes out with the index trade).
      const own = (v.optExit ?? 'index') !== 'index'
      const slPrem = o.trade.premium * (v.optSlPct ?? 20) / 100
      const tgPrem = o.trade.premium * (v.optTargetPct ?? 30) / 100
      const buy = o.trade.action === 'BUY'
      out.push({
        date: day.date, t: s.t, exitT: o.exitMs - MIN, index: underlying ?? null, side: s.side, entry: s.entry, exit: exitPrice,
        indexPoints: dir * (exitPrice - s.entry), r: outcome.r, points: o.points, stopHit: /SL/.test(o.reason) && o.points < 0,
        ...levelsOf(s, outcome),
        opt: {
          label: `${o.trade.action} ${o.trade.strike} ${o.trade.side}`, moneyness: v.optMoneyness ?? 0, entry: o.trade.premium, exit: o.exitPremium, points: o.points, reason: o.reason,
          sl: own ? o.trade.premium + (buy ? -slPrem : slPrem) : null, target: own ? o.trade.premium + (buy ? tgPrem : -tgPrem) : null,
          slPts: own ? slPrem : null, targetPts: own ? tgPrem : null,
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
      // Each option the setup carries, as the trade would have gone in it: held until the index trade exited, and -
      // when an option SL / target is set (Trade settings) - whether its OWN stop or target came first, which is what
      // a trade taken in options actually does. `points` is the net on that leg either way.
      const leg = (o) => {
        if (!o) return null
        const held = day.oi ? premiumAt(day.oi, o.side, o.strike, exitMs) : null
        const net = (px) => (px == null ? null : o.action === 'BUY' ? px - o.premium : o.premium - px)
        const base = { label: `${o.action} ${o.strike} ${o.side}`, entry: o.premium, exit: held, points: net(held), closedBy: held == null ? null : 'index exit' }
        const sl = optionLevels?.sl > 0 ? optionLevels.sl : null
        const target = optionLevels?.target > 0 ? optionLevels.target : null
        if (!day.oi || (!sl && !target)) return base
        const hit = optionStopTargetHit(day.oi, o, s.t, exitMs, sl, target)
        if (!hit) return { ...base, sl, target, closedBy: held == null ? null : 'index exit (neither its SL nor its target)' }
        return { ...base, sl, target, exit: hit.premium, points: net(hit.premium), at: hit.at, closedBy: /SL/i.test(hit.reason) ? 'its SL' : 'its target' }
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
export function stepSearch(grid, base, scoreOf, { passes = 2, minTrades = 0 } = {}) {
  const keys = Object.keys(grid)
  const order = [...keys.filter((k) => !/Window$/.test(k)), ...keys.filter((k) => /Window$/.test(k))]
  const seen = new Map()
  const evaluate = (v) => {
    const id = JSON.stringify(order.map((k) => v[k]))
    if (!seen.has(id)) seen.set(id, { params: v, train: scoreOf(v) })
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

const run = (days, id, variant, trail) => days.flatMap((d) => dayTrades(d, id, variant, trail))

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
export function tuneStrategy(days, id, { trail = null, minTrades = 8, trainFraction = 0.7, grid = null, keep = 10, what = 'trade', base = DEFAULT_VARIANT, oiKeys = null, search = 'step', onProgress = null, underlying = null } = {}) {
  if (what === 'all') {
    // Everything in turn: the OI confirmation, the trade settings on top, then how it is taken in options.
    const oi = tuneStrategy(days, id, { trail, minTrades, trainFraction, keep, what: 'oi', base, oiKeys, search, onProgress, underlying })
    const tr = tuneStrategy(days, id, { trail, minTrades, trainFraction, keep, what: 'trade', base: oi.best?.params ?? base, underlying })
    const op = tuneStrategy(days, id, { trail, minTrades, trainFraction, keep, what: 'option', base: tr.best?.params ?? oi.best?.params ?? base, underlying })
    return { ...op, what, tried: oi.tried + tr.tried + op.tried, factors: [...(oi.factors ?? []), ...(tr.factors ?? []), ...(op.factors ?? [])], oiStage: { best: oi.best, reason: oi.reason }, tradeStage: { best: tr.best, reason: tr.reason } }
  }
  if (what === 'both') {
    // The OI confirmation first (chosen on the train days only), then the trade settings on top of it.
    const oi = tuneStrategy(days, id, { trail, minTrades, trainFraction, keep, what: 'oi', base, oiKeys, search, onProgress, underlying })
    const onTop = tuneStrategy(days, id, { trail, minTrades, trainFraction, keep, what: 'trade', base: oi.best?.params ?? base, underlying })
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
  const baseline = { params: asWritten, train: scoreR(score(train, asWritten)), test: scoreR(score(test, asWritten)) }
  // What each tuned input did: for every value it was tried at, the best train score of a combination with it.
  const tally = new FactorTally(grid, base, minTrades)
  let rows = []
  let tried = 0
  if (what === 'oi' && !explicitGrid && search !== 'full') {
    // Step by step (stepSearch): each OI filter takes its best value given the others, then a second pass.
    const found = stepSearch(grid, base, (v) => tally.add(v, scoreR(score(train, v))), { minTrades })
    rows = found.rows
    tried = found.tried
  } else {
    // Every combination (the trade settings always; the OI inputs when asked: search 'full').
    let of = null
    if (what === 'oi' && !explicitGrid) {
      const n = countOiCombinations(oiKeys)
      if (n.over) throw new Error(`more than ${OI_COMBO_CAP.toLocaleString('en-IN')} OI combinations - untick some OI inputs, or search step by step`)
      of = n.count
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
    for (const { v, at: i } of list) {
      tried++
      if (onProgress && tried % 250 === 0) onProgress({ tried, of })
      const tr = tally.add(v, scoreR(score(train, v)))
      if (tr.n < minTrades || tr.score == null) continue
      rows.push({ params: v, train: tr, at: i })
    }
  }
  rows.sort((a, b) => b.train.score - a.train.score || b.train.total - a.train.total || (a.at ?? 0) - (b.at ?? 0))
  const top = rows.slice(0, keep).map((r) => ({ ...r, test: scoreR(score(test, r.params)) }))
  // Nothing reached the minimum trades: show what there is anyway - the best setting with even a couple of trades -
  // marked "below the minimum", never recommended. (Under 2 trades there is no score to rank by.)
  if (!top.length && minTrades > 2) {
    const loose = tuneStrategy(days, id, { trail, minTrades: 2, trainFraction, grid: explicitGrid ? grid : null, keep, what, base, oiKeys, search, onProgress, underlying })
    if (loose.best) return { ...loose, belowMin: true, minTradesWanted: minTrades, recommend: false, reason: `only ${loose.best.train.n} trade(s) on the ${train.length} train day(s), below the minimum of ${minTrades} - shown for information, not enough to trust` }
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
    best = { ...best, suggest: { premium: median, slPoints: median * best.params.optSlPct / 100, targetPoints: median * best.params.optTargetPct / 100, moneyness: best.params.optMoneyness, leg: best.params.optLeg } }
  }
  const unit = isOpt ? ' pts' : 'R'
  let recommend = false
  let reason
  if (!best) reason = `no combination had ${minTrades}+ trades on the ${train.length} train day(s)`
  else if (!test.length) reason = `only ${days.length} day(s) - too few to check on unseen days (need 5+); not recommended yet`
  else if (best.test.n < 3) reason = `the best combination took only ${best.test.n} trade(s) on the ${test.length} test day(s) - not enough to trust`
  else if (!(best.test.total > 0)) reason = `the best combination lost on the test days (${best.test.total.toFixed(2)}${unit}) - it fitted the past`
  else if (baseline.test.n && !(best.test.avg > (baseline.test.avg ?? -Infinity))) reason = `on the test days it did not beat the ${isOpt ? 'option taken as before (ATM sell, out with the index trade)' : 'strategy as written'} (${best.test.avg.toFixed(2)}${unit} vs ${baseline.test.avg.toFixed(2)}${unit} a trade)`
  else { recommend = true; reason = `better on the train days and on the ${test.length} unseen test day(s)` }
  return {
    id, name: STRATEGY_BY_ID[id]?.name ?? id, no: STRATEGY_BY_ID[id]?.no ?? null, what, unit: isOpt ? 'pts' : 'R',
    days: days.length, trainDays: train.map((d) => d.date), testDays: test.map((d) => d.date),
    tried, qualified: rows.length, baseline, best, top, recommend, reason, factors: tally.report(best?.params),
  }
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
  // The option's own SL / target only apply when the tuning chose to use them ('first' or 'option'); with 'index' the
  // option simply goes out with the index trade, which is the scanner's own behaviour.
  if ((params.optExit === 'first' || params.optExit === 'option')) {
    if (params.optSlPct > 0) out.tradeOptSlPct = params.optSlPct
    if (params.optTargetPct > 0) out.tradeOptTargetPct = params.optTargetPct
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
