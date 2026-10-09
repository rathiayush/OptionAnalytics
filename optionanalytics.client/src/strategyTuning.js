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

import { ACTIVE_STRATEGIES, STRATEGY_BY_ID, TRADE_FILTERS, applyTradeFilter, oiGateText, simulateOutcome } from './strategyEngine.js'
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
  { key: 'tradeFutWindow', label: 'Futures OI timeframe: 1, 3, 5, 15 minutes (for the futures OI and the move size)' },
  { key: 'tradeWallOi', label: 'Support / resistance OI: the wall in the way shrinking or growing' },
  { key: 'tradeOiFlow', label: 'Options OI change: net CE vs PE (delta on the timeframe)' },
  { key: 'tradeOiCum', label: 'Options OI cumulative: net CE - PE since the open' },
  { key: 'tradeSideOi', label: 'CE and PE each rising / falling (delta on the timeframe)' },
  { key: 'tradeSideCum', label: 'CE and PE each rising / falling since the open (cumulative)' },
  { key: 'tradeFutOi', label: 'Futures OI (build-up, covering, short squeeze)' },
  { key: 'tradeMoveSize', label: 'Futures move size: small move or real move' },
  { key: 'tradeDayType', label: 'Day type: trending (my way), range, not against a trend' },
  { key: 'tradeWallRoom', label: 'Room to the next OI wall (support / resistance)' },
]
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
  if (!day.byId) {
    day.byId = new Map()
    for (const s of day.setups) day.byId.set(s.id, [...(day.byId.get(s.id) ?? []), s])
  }
  const own = day.byId.get(id) ?? []
  const taken = firstPerCooldown(own.map((s) => applyTradeFilter(s, variant)).filter(Boolean))
  return taken.map((s) => {
    const withTrail = { ...s, trail: s.trailOverride !== undefined ? s.trailOverride : trail }
    return simulateOutcome(withTrail, day.minuteBars, day.endMs, true).r
  }).filter(Number.isFinite)
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
export function tuneStrategy(days, id, { trail = null, minTrades = 8, trainFraction = 0.7, grid = null, keep = 10, what = 'trade', base = DEFAULT_VARIANT, oiKeys = null, search = 'step', onProgress = null } = {}) {
  if (what === 'both') {
    // The OI confirmation first (chosen on the train days only), then the trade settings on top of it.
    const oi = tuneStrategy(days, id, { trail, minTrades, trainFraction, keep, what: 'oi', base, oiKeys, search, onProgress })
    const onTop = tuneStrategy(days, id, { trail, minTrades, trainFraction, keep, what: 'trade', base: oi.best?.params ?? base })
    return { ...onTop, what, tried: oi.tried + onTop.tried, qualified: oi.qualified + onTop.qualified, oiStage: { best: oi.best, reason: oi.reason } }
  }
  const explicitGrid = grid != null
  grid = grid ?? (what === 'oi' ? oiGridOf(oiKeys) : TUNING_GRID)
  const { train, test } = splitDays(days, trainFraction)
  const baseline = { params: DEFAULT_VARIANT, train: scoreR(run(train, id, DEFAULT_VARIANT, trail)), test: scoreR(run(test, id, DEFAULT_VARIANT, trail)) }
  let rows = []
  let tried = 0
  if (what === 'oi' && !explicitGrid && search !== 'full') {
    // Step by step (stepSearch): each OI filter takes its best value given the others, then a second pass.
    const found = stepSearch(grid, base, (v) => scoreR(run(train, id, v, trail)), { minTrades })
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
    for (const v of variants(grid, base)) {
      // The timeframe only means something with an OI change or futures OI filter on; without one, 1 / 3 / 5 / 15
      // are the same trades - tried once (at 15).
      if (oiVariantRedundant(v)) continue
      tried++
      if (onProgress && tried % 250 === 0) onProgress({ tried, of })
      const tr = scoreR(run(train, id, v, trail))
      if (tr.n < minTrades || tr.score == null) continue
      rows.push({ params: v, train: tr })
    }
  }
  rows.sort((a, b) => b.train.score - a.train.score || b.train.total - a.train.total)
  const top = rows.slice(0, keep).map((r) => ({ ...r, test: scoreR(run(test, id, r.params, trail)) }))
  const best = top[0] ?? null
  let recommend = false
  let reason
  if (!best) reason = `no combination had ${minTrades}+ trades on the ${train.length} train day(s)`
  else if (!test.length) reason = `only ${days.length} day(s) - too few to check on unseen days (need 5+); not recommended yet`
  else if (best.test.n < 3) reason = `the best combination took only ${best.test.n} trade(s) on the ${test.length} test day(s) - not enough to trust`
  else if (!(best.test.total > 0)) reason = `the best combination lost on the test days (${best.test.total.toFixed(2)}R) - it fitted the past`
  else if (baseline.test.n && !(best.test.avg > (baseline.test.avg ?? -Infinity))) reason = `on the test days it did not beat the strategy as written (${best.test.avg.toFixed(2)}R vs ${baseline.test.avg.toFixed(2)}R a trade)`
  else { recommend = true; reason = `better on the train days and on the ${test.length} unseen test day(s)` }
  return {
    id, name: STRATEGY_BY_ID[id]?.name ?? id, no: STRATEGY_BY_ID[id]?.no ?? null, what,
    days: days.length, trainDays: train.map((d) => d.date), testDays: test.map((d) => d.date),
    tried, qualified: rows.length, baseline, best, top, recommend, reason,
  }
}

/** A scanned day for the tuning: its setups (every minute) and the bars / end its outcomes are read to. */
export function tuningDay(date, setups, replayDay) {
  const range = replayRange(replayDay)
  return { date, setups, minuteBars: replayDay.minuteBars, endMs: (range?.end ?? 0) + MIN }
}

/** The filters to save for a tuned strategy: its own entry filters kept, the tuned trade filters on top (only
 *  the ones that differ from the default). */
export function filtersFromTuning(current, params) {
  const out = { ...(current ?? {}) }
  for (const f of TRADE_FILTERS) {
    if (params[f.key] === undefined || params[f.key] === f.default) delete out[f.key]
    else out[f.key] = params[f.key]
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
