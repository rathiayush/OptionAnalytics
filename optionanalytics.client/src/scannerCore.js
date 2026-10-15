// The strategy scanner's logic without React - the server-side scanner runner (scanner-runner/) and the OI Replay page's
// spot + options card (SpotStrategyScanner) run it, so they fire, trade and close exactly the same way.
// Everything here is pure: no storage, no timers, no network; the caller owns state and side effects.

import {
  ACTIVE_STRATEGIES, STRATEGY_BY_ID, evaluateStrategies, simulateOutcome, DEFAULT_TRAIL, RANGE_IDS,
  exitLabel, premiumAt, closePremiumAt, optionStopTargetHit, squareOffMs, marketAt, lotsFor, pinnedTrailOf, optionExitText, capPoints, optionTradesFor, valueAt,
  optionPlanFor, optionTradeAt, filtersForIndex, SPOT_STRATEGIES,
} from './strategyEngine.js'
// The market at a signal now lives with the strategies (the order-flow trade filters read it) - re-exported here.
export { marketAt, MARKET_KEYS } from './strategyEngine.js'
import { aggregateBars, analyzeBars, findWalls } from './orderFlowMath.js'
import { chargeRates, tradeCharges } from './tradeCharges.js'
import { sessionVolumeProfile, tpoProfile, tpoRowFor } from './profiles.js'
import { evaluateSpotStrategies } from './spotEngine.js'
import { defaultIndexTrade, defaultTradeLevels } from './tradeDefaults.js'

export const MIN = 60_000
// One alert per strategy and direction at most every 20 minutes - a setup that stays true is one trade.
export const COOLDOWN_MS = 20 * MIN
export const ALL_IDS = ACTIVE_STRATEGIES.map((s) => s.id)
// The spot + options family (Set 1) and every active strategy of both sets - what "Every strategy" alerts on.
export const ALL_SPOT_IDS = SPOT_STRATEGIES.filter((s) => !s.retired).map((s) => s.id)
export const EVERY_ID = [...ALL_IDS, ...ALL_SPOT_IDS]
export const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())

// 1-minute analyzed bars that had COMPLETED by `nowMs`.
export function completedBars(minuteBars, nowMs, rowSize, lotSize, estimated) {
  const done = (minuteBars ?? []).filter((b) => msOf(b.time) + MIN <= nowMs)
  return analyzeBars(aggregateBars(done, 1), { rowSize, minVolume: lotSize, estimated })
}

// The futures price at the clock: the tape's last print (it has every print) when it is recent, else
// the view's own last price.
export function priceAt(view, prints, ms, bars) {
  const p = prints?.at(-1)
  if (p && p.price > 0 && msOf(p.time) <= ms && msOf(p.time) >= ms - 2 * MIN) return p.price
  return view?.meta?.lastPrice || bars.at(-1).close
}

// The prints at or before `ms` (prints are in time order).
export function upTo(prints, ms) {
  if (!prints?.length) return prints
  let lo = 0
  let hi = prints.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (msOf(prints[mid].time) <= ms) lo = mid + 1; else hi = mid }
  return prints.slice(0, lo)
}

// The trailing stop a new setup gets from the scanner's settings (null = a fixed stop).
// Trailing SL in futures (index) POINTS by default - "after +start pts, follow gap pts behind the best
// price" - set per underlying (its points move differently); or in R (x the trade's own risk).
export const DEFAULT_TRAIL_PTS = { NIFTY: { start: 30, gap: 30 }, BANKNIFTY: { start: 75, gap: 75 }, SENSEX: { start: 100, gap: 100 } }
export const FALLBACK_TRAIL_PTS = { start: 30, gap: 30 }
export const trailUnit = (cfg) => (cfg.trail?.unit === 'R' ? 'R' : 'pts')
export const trailPtsFor = (cfg, underlying) => {
  const key = String(underlying ?? '').toUpperCase()
  return { ...(DEFAULT_TRAIL_PTS[key] ?? FALLBACK_TRAIL_PTS), ...cfg.trail?.pts?.[key] }
}
export const trailFor = (cfg, underlying) => {
  if (cfg.trail?.on === false) return null
  const pts = trailPtsFor(cfg, underlying)
  return {
    startR: cfg.trail?.startR ?? DEFAULT_TRAIL.startR, gapR: cfg.trail?.gapR ?? DEFAULT_TRAIL.gapR,
    ...(trailUnit(cfg) === 'pts' ? { unit: 'pts', startPts: pts.start, gapPts: pts.gap } : {}),
    ...(cfg.trail?.runner ? { runner: true } : {}),
  }
}

// The strategies alerted on: every active strategy of both sets (by default), the Top 15, the OI / profile five,
// the range-bound ones, all the futures ones, or a custom list. `top` is topFifteen(strategyStats(...)).
export function alertIdsFor(settings, top) {
  const top15Ids = [...top.ids, ...top.trial]
  return settings.pick === 'top15' ? top15Ids : settings.pick === 'oi5' ? top.oi.ids : settings.pick === 'profile5' ? top.profile.ids
    : settings.pick === 'range' ? RANGE_IDS : settings.pick === 'all' ? ALL_IDS : settings.pick === 'every' ? EVERY_ID : settings.custom ?? []
}

// Paper trades' lot size per index - the multiplier that turns premium POINTS into rupees (points x lots x lot size).
// The exchange's own default; the index's Trade settings can set it (trade-settings.csv lot_size), which is what
// `lotSizeOf` reads. A live trade still takes the contract's real lot size from Dhan.
export const PAPER_TRADE_LOT_SIZE = { NIFTY: 65, BANKNIFTY: 30, SENSEX: 20 }

/** The lot size to size an index's paper trade (and every "what it would have made" number) by: its Trade settings'
 *  own, else the exchange's default. `config` is the runner config (GET /api/scanner-runner/config). */
export const lotSizeOf = (config, underlying) => {
  const own = Number(config?.trade?.[underlying]?.lotSize)
  return own > 0 ? own : PAPER_TRADE_LOT_SIZE[underlying] ?? 1
}

// The scanner's profile input from the previous session's bars: its volume profile (POC, value area,
// HVN / LVN), its TPO profile and its high / low - null without a volume profile.
export function scannerProfileOf(prevBars, underlying, rowSize) {
  if (!prevBars?.length) return null
  const vp = sessionVolumeProfile(prevBars)
  if (vp?.poc == null) return null
  const tpoPrev = tpoProfile(prevBars, tpoRowFor(underlying, rowSize))
  const bars = prevBars.filter((b) => b.high > 0 && b.low > 0)
  const range = bars.length ? { prevHigh: Math.max(...bars.map((b) => b.high)), prevLow: Math.min(...bars.map((b) => b.low)) } : null
  return { vp, tpoPrev, ...range }
}

// When a paper / live position's setup fired (older positions only carry it in their key).
export function setupTimeOf(p) {
  return p.setupT ?? Number(String(p.setupKey).split('-').at(-1))
}

// The same signal: the same strategy, direction and side (buy / sell) within the alert cooldown.
export const sameSignal = (p, setup, trade) => p.strategy === setup.id && p.setupSide === setup.side && p.action === trade.action && Math.abs(setupTimeOf(p) - setup.t) < COOLDOWN_MS

/**
 * One look at the market at the clock - the live loop's body. `memory` is the caller's { fired }. Returns
 * null when there is nothing to judge yet (no OI, too few bars, a tape that has not caught up); otherwise
 * what is being watched, the setups that fire now and the day's fired list with them. A setup fires at
 * once - no strategy waits for a cool-off.
 */
export function scanTick(input, memory) {
  const { nowMs, view, tapePrints, liquidity, pullStack, oi, estimated, lotSize, largeLots, profile, rowSize, filters, trail } = input
  if (!oi || !view?.minuteBars?.length || !nowMs) return null
  // An exact day's tape must have caught up with the clock (a replay jump fetches it afresh) -
  // judging aggression on a stale tape would be judging the wrong minute.
  if (!estimated && !(tapePrints?.length && msOf(tapePrints.at(-1).time) >= nowMs - 3 * MIN)) return null
  const bars = completedBars(view.minuteBars, nowMs, rowSize, lotSize, estimated)
  if (bars.length < 5) return null
  const price = priceAt(view, estimated ? null : tapePrints, nowMs, bars)
  const watchNow = []
  const setups = evaluateStrategies({
    nowMs, price, bars, minuteBars: view.minuteBars, prints: estimated ? null : tapePrints,
    book: view.book, walls: findWalls(view.book), liquidity, pullStack, sweeps: view.sweeps, icebergs: view.icebergs, oi, estimated, lotSize, bigLots: largeLots, profile, watch: watchNow, heatmap: view.heatmap, rowSize,
    filters,
  })
  const watching = watchNow.filter((w) => w.missing.length)
  const recentlyFired = (s) => memory.fired.some((f) => f.id === s.id && f.side === s.side && s.t - f.t < COOLDOWN_MS)
  const fresh0 = setups.filter((s) => !recentlyFired(s))
  // What the market looked like at the signal (evaluateStrategies puts it on every setup) - kept with it in the scanner
  // record, so which conditions win can be learned from the live signals (only what was known at the clock).
  const market = fresh0.length && fresh0.some((s) => !s.market) ? marketAt({ nowMs, price, bars, tapePrints: estimated ? null : tapePrints, oi, heatmap: view.heatmap, lotSize, largeLots }) : null
  const fresh = fresh0.map((s) => ({ ...withOwnTrail(s, filters?.[s.id], trail), market: s.market ?? market }))
  return { price, watching, fresh, fired: fresh.length ? [...memory.fired, ...fresh] : memory.fired }
}

// A setup's trailing stop: its strategy's own (the tradeTrail filter - applyTradeFilter's trailOverride, null =
// none), else the scanner's.
export const trailOf = (s, trail) => (s.trailOverride !== undefined ? s.trailOverride : trail)

/** A fresh setup with the trailing stop it trades with: its strategy's own (the tradeTrail filter), else the one its
 *  applied setting was applied with (`_trail` - pinnedTrailOf), else the scanner's. Either of the first two is the
 *  strategy's OWN (`trailOverride`), which a later change of the scanner's trailing stop does not touch. */
export function withOwnTrail(s, raw, trail) {
  const pinned = s.trailOverride === undefined ? pinnedTrailOf(raw) : undefined
  const own = pinned !== undefined ? { ...s, trailOverride: pinned } : s
  return { ...own, trail: trailOf(own, trail) }
}

// Each fired setup with its outcome so far (its trailing stop following any change of the SCANNER's trailing stop
// logged after it fired - a setup trailing its strategy's own keeps it). `dayOver`: the day's minutes are complete
// (its session has closed and the bars were read back whole), so a setup that never reached its stop or target is
// closed at the last price instead of staying "open" for ever (simulateOutcome's dayOver).
export function followSetups(fired, trailLog, minuteBars, nowMs, dayOver = false) {
  return fired.map((s) => {
    const withLog = s.trailOverride === undefined && trailLog.some((c) => c.t > s.t) ? { ...s, trailLog: trailLog.filter((c) => c.t > s.t) } : s
    return { ...withLog, outcome: simulateOutcome(withLog, minuteBars ?? [], nowMs ?? 0, dayOver) }
  })
}

/**
 * The SPOT + OPTIONS strategies' look at the start of `minute` (a whole minute): `bars` - the day's FINISHED 1-minute
 * spot candles by then (spotBarsOf; the last one must be the minute that just ended - its close is the entry), `oi` -
 * the OI context. The setups evaluateSpotStrategies gives the Strategy tuning for the same minute, each strategy and
 * side at most once per COOLDOWN_MS (the tuning's firstPerCooldown). The server scanner and the OI Replay page both
 * judge them with this. Null when the minute's candle is not in yet (look again).
 */
export function spotScanTick({ minute, bars, oi, filters, trail }, memory) {
  if (!oi || !bars?.length || bars.at(-1).t !== minute - MIN) return null
  const done = bars.at(-1).t + MIN <= minute ? bars : bars.filter((b) => b.t + MIN <= minute)
  const setups = evaluateSpotStrategies({ nowMs: minute, bars: done, oi, filters })
  const recentlyFired = (s) => memory.fired.some((f) => f.id === s.id && f.side === s.side && s.t - f.t < COOLDOWN_MS)
  const fresh = setups.filter((s) => !recentlyFired(s)).map((s) => ({ ...withOwnTrail(s, filters?.[s.id], trail), market: null }))
  return { fresh, fired: fresh.length ? [...memory.fired, ...fresh] : memory.fired }
}

/**
 * The spot strategies at every whole minute in (`from`, `to`] - each on the spot candles finished by it (`bars`, the
 * day's, oldest first) and `oi` (a context, or (minute) => context). What a replay that moved several minutes, or a
 * page opened part-way through today, has not judged yet. Returns { fresh, fired } like spotScanTick.
 */
export function spotScanMinutes({ from, to, bars, oi, filters, trail }, memory) {
  let fired = memory.fired
  const fresh = []
  let done = 0
  for (let minute = Math.floor(from / MIN) * MIN + MIN; minute <= to; minute += MIN) {
    while (done < bars.length && bars[done].t + MIN <= minute) done++
    const tick = spotScanTick({ minute, bars: bars.slice(0, done), oi: typeof oi === 'function' ? oi(minute) : oi, filters, trail }, { fired })
    if (!tick?.fresh.length) continue
    fired = tick.fired
    fresh.push(...tick.fresh)
  }
  return { fresh, fired }
}

/** Every fired setup with its outcome so far: the futures ones on the futures minutes, the spot ones on the spot
 *  minutes (their stop / target are spot prices) - in time order when both are there. */
export function followAllSetups(fired, trailLog, futuresBars, spotBars, nowMs, dayOver = false) {
  const spot = fired.filter((s) => s.spot)
  // The day is only over for the side whose minutes actually came back: with no spot candles for the day, a spot
  // setup closed "at the last price" would be closed at its own entry, which is not what happened.
  const over = (bars) => dayOver && (bars?.length ?? 0) > 0
  if (!spot.length) return followSetups(fired, trailLog, futuresBars, nowMs, over(futuresBars))
  const futures = fired.filter((s) => !s.spot)
  return [...followSetups(futures, trailLog, futuresBars, nowMs, over(futuresBars)), ...followSetups(spot, trailLog, spotBars, nowMs, over(spotBars))].sort((a, b) => a.t - b.t)
}

export const newSetupEventMemory = () => ({ closed: new Set(), trail: new Map(), primed: new Set(), restored: new Set() })

/**
 * What changed for the day's setups since the last look: a trailing stop that moved by half a risk unit
 * or more ({ type: 'trail', s, last, locked }), or a setup that ended ({ type: 'exit', s }). `memory`
 * (newSetupEventMemory) is updated in place. Setups in memory.restored were brought back after a
 * restart / refresh: what already happened to them is not news - they are primed once `barsReady`.
 */
export function setupEvents(withOutcome, memory, barsReady) {
  const events = []
  for (const s of withOutcome) {
    const key = `${s.id}-${s.t}`
    if (memory.restored.has(key) && !memory.primed.has(key)) {
      // ...judged once the day's bars are in (before that every outcome still reads "open").
      if (!barsReady) continue
      memory.primed.add(key)
      if (s.outcome.status !== 'open') memory.closed.add(key)
      else if (s.outcome.trailed) memory.trail.set(key, s.outcome.stop)
      continue
    }
    if (s.outcome.status === 'open' && s.outcome.trailed && !memory.closed.has(key)) {
      const risk = Math.abs(s.entry - s.stop)
      const last = memory.trail.get(key) ?? s.stop
      if (Math.abs(s.outcome.stop - last) < 0.5 * risk - 1e-9) continue
      memory.trail.set(key, s.outcome.stop)
      const dir = s.side === 'LONG' ? 1 : -1
      events.push({ type: 'trail', s, key, last, locked: (dir * (s.outcome.stop - s.entry)) / risk })
      continue
    }
    if (s.outcome.status === 'open' || memory.closed.has(key)) continue
    memory.closed.add(key)
    events.push({ type: 'exit', s, key })
  }
  return events
}

// A paper (or live) option position opened from a setup.
/** A new option position for an alert. `plan` (optionPlanFor with the premium): the strategy's own exit (`optExit`), its
 *  own SL / target (`ownSlPts` / `ownTargetPts`, null = none) and the SL / target in force - those held to the index's max
 *  rules (null = none) - and no option trailing stop; the Trade settings' SL / target / trail (a manual trade's) never
 *  reach it. A later change of the max rules reaches it from that minute (withCapChange). No plan: `cfg`'s levels. */
export function newPosition({ setup, trade, which, lots, lotSize, premium, cfg, at, plan = null }) {
  const own = plan?.own ? {
    slPts: plan.slPts ?? null, targetPts: plan.targetPts ?? null, ownSlPts: plan.ownSlPts ?? null, ownTargetPts: plan.ownTargetPts ?? null,
    trailStart: 0, trailGap: 0, optExit: plan.exit,
  } : null
  return {
    key: `${setup.id}-${setup.t}-${which}`, setupKey: `${setup.id}-${setup.t}`, setupT: setup.t, strategy: setup.id, setupSide: setup.side,
    adaptive: setup.adaptive ?? null, regime: setup.regime ?? null, action: trade.action, side: trade.side, strike: trade.strike,
    lots, lotSize, premium, slPts: cfg.paperSl ?? 20, targetPts: cfg.paperTarget ?? 30,
    trailStart: cfg.paperTrailStart ?? 0, trailGap: cfg.paperTrailGap ?? 0, ...own, entryTime: at, exitTime: null, exitPremium: null, exitReason: null,
  }
}

/** The Dhan super order's SL / target legs (premium points) for an alert taken with `plan`: the ones in force (its own,
 *  held to the index's max rules). Where there is none (out with the index trade and no max) a super order still needs
 *  the leg, so it is a SAFETY leg at the signal's own stop / target distance on the index - an option's premium moves no
 *  more than the index (delta at most 1), so it does not close the trade before the strategy's own index exit would
 *  (only an IV spike could reach it first). */
export function liveLegsFor(plan, setup) {
  if (!plan?.own) return { slPts: plan?.slPts, targetPts: plan?.targetPts }
  return {
    slPts: plan.slPts > 0 ? plan.slPts : Math.abs(setup.entry - setup.stop),
    targetPts: plan.targetPts > 0 ? plan.targetPts : Math.abs(setup.target - setup.entry),
  }
}

/** The SL / target legs an open LIVE trade must have on Dhan now (premium points from its entry): its SL / target in
 *  force - after any change, from the minute it was made (withCapChange / withLevelChange) - else the safety legs it was
 *  placed with (`liveSafety`, liveLegsFor). The scanner moves the legs whenever these differ from what Dhan has. */
export function liveLegsNow(p) {
  return {
    slPts: p?.slPts > 0 ? p.slPts : p?.liveSafety?.slPts > 0 ? p.liveSafety.slPts : null,
    targetPts: p?.targetPts > 0 ? p.targetPts : p?.liveSafety?.targetPts > 0 ? p.liveSafety.targetPts : null,
  }
}

/** Whether two sets of legs are the same (to a hundredth of a point; none = none). */
export function sameLegs(a, b) {
  const same = (x, y) => (x > 0 ? y > 0 && Math.abs(x - y) < 0.01 : !(y > 0))
  return same(a?.slPts, b?.slPts) && same(a?.targetPts, b?.targetPts)
}

/**
 * A change of the index's max rules (`caps` { maxSl, maxTarget }, premium points, 0 = none) for the strategy trades still
 * OPEN (keys in `openKeys`), from the minute `changeAt`: each one's SL / target in force becomes its own held to the new
 * max (capPoints), kept in its levelLog - what already happened is never rewritten.
 */
export function withCapChange(positions, openKeys, caps, changeAt) {
  return positions.map((p) => {
    if (!openKeys.has(p.key) || !p.optExit) return p
    const sl = capPoints(p.ownSlPts, Number(caps?.maxSl) || 0)
    const target = capPoints(p.ownTargetPts, Number(caps?.maxTarget) || 0)
    if (sl === p.slPts && target === p.targetPts) return p
    const before = p.levelLog?.length ? p.levelLog.filter((c) => c.t < changeAt) : [{ t: p.entryTime, sl: p.slPts, target: p.targetPts, trailStart: 0, trailGap: 0 }]
    return { ...p, slPts: sl, targetPts: target, levelLog: [...before, { t: changeAt, sl, target, trailStart: 0, trailGap: 0 }] }
  })
}

/**
 * A new Max SL / Target / trail applied to the positions still OPEN (keys in `openKeys`) from the minute
 * `changeAt`: each keeps a levelLog - the levels it had until now, then the new ones - which
 * optionStopTargetHit follows, so what already happened is never rewritten. `cur` is the settings before
 * the change; `patch` holds paperSl / paperTarget / paperTrailStart / paperTrailGap (any of them). A position with
 * its strategy's own option exit (`optExit`) is left as it is.
 */
export function withLevelChange(positions, openKeys, patch, changeAt, cur) {
  // A trade with its strategy's own option exit keeps it - the index's levels were never its levels.
  return positions.map((p) => (openKeys.has(p.key) && !p.optExit ? {
    ...p,
    levelLog: [
      ...(p.levelLog?.length ? p.levelLog.filter((c) => c.t < changeAt) : [{ t: p.entryTime, sl: p.slPts ?? cur.paperSl ?? 20, target: p.targetPts ?? cur.paperTarget ?? 30, trailStart: p.trailStart ?? cur.paperTrailStart ?? 0, trailGap: p.trailGap ?? cur.paperTrailGap ?? 0 }]),
      { t: changeAt, sl: patch.paperSl ?? p.slPts ?? cur.paperSl ?? 20, target: patch.paperTarget ?? p.targetPts ?? cur.paperTarget ?? 30, trailStart: patch.paperTrailStart ?? p.trailStart ?? cur.paperTrailStart ?? 0, trailGap: patch.paperTrailGap ?? p.trailGap ?? cur.paperTrailGap ?? 0 },
    ],
    ...(patch.paperSl != null ? { slPts: patch.paperSl } : {}),
    ...(patch.paperTarget != null ? { targetPts: patch.paperTarget } : {}),
    ...(patch.paperTrailStart != null ? { trailStart: patch.paperTrailStart } : {}),
    ...(patch.paperTrailGap != null ? { trailGap: patch.paperTrailGap } : {}),
  } : p))
}

/**
 * The day's option positions, each closed by its own premium stop / target / trail, or by its setup's
 * exit (or by hand), with P&L at the clock. `dayResults` and `withOutcome` are the day's setups with
 * their outcomes. Paper trades are all sized by the lots set now; a live trade keeps its quantity.
 */
export function positionRows({ positions, dayResults, withOutcome, oi, nowMs, settings, dayOver = false }) {
  // A position's setup: the alerted one (live / replay outcomes, followed up to the clock), else the
  // same strategy and side within two minutes in the day's list (a scanned day's setups are timed to
  // the minute, an alert to 10 s).
  const exact = new Map([...dayResults, ...withOutcome].map((s) => [`${s.id}-${s.t}`, s]))
  const setupOf = (p) => exact.get(p.setupKey) ?? [...withOutcome, ...dayResults]
    .filter((s) => s.id === p.strategy && s.side === p.setupSide && Math.abs(s.t - setupTimeOf(p)) < 2 * MIN)
    .sort((a, b) => Math.abs(a.t - p.entryTime) - Math.abs(b.t - p.entryTime))[0]
  const outcomeOf = (p) => setupOf(p)?.outcome
  // Paper trades are sized by the lots set NOW - the strategy's own lot size on this index when one was applied with it
  // (`settings.filters` = that index's filters), else the index's lots.
  const paperLotsOf = (id) => lotsFor(id, settings.filters, settings.paperLots ?? 1)
  return (positions ?? []).filter((p) => !nowMs || p.entryTime <= nowMs).map((stored) => {
    // The adaptive call of the trade's signal (stored when punched; older trades look it up).
    const sig = stored.adaptive ? null : setupOf(stored)
    const tagged = { ...stored, adaptive: stored.adaptive ?? sig?.adaptive ?? null, regime: stored.regime ?? sig?.regime ?? null }
    const p = tagged.live ? tagged : { ...tagged, lots: paperLotsOf(tagged.strategy) }
    let exitTime = p.exitTime && p.exitTime <= (nowMs ?? Infinity) ? p.exitTime : null
    let exitPremium = exitTime ? p.exitPremium : null
    let exitReason = exitTime ? p.exitReason : null
    // Its strategy's own option exit 'option': only its own SL / target, else the 15:10 square-off - the signal's exit does
    // not close it (the tuning's optionOutcome).
    const o = p.optExit === 'option' ? { status: 'square-off', exitAt: squareOffMs(p.entryTime) - MIN, timeStop: true, squareOff: true } : outcomeOf(p)
    if ((p.live && p.exitSent) || (p.exitFinal && p.exitTime != null && p.exitPremium != null && p.exitTime <= (nowMs ?? Infinity))) {
      // A live trade whose exit has gone to Dhan keeps the exit it was sent with; a paper trade whose exit was announced
      // (exitFinal - the scanner keeps it on the position) keeps that one - never re-priced afterwards.
      const points = p.exitPremium == null ? null : p.action === 'BUY' ? p.exitPremium - p.premium : p.premium - p.exitPremium
      return { ...p, exitTime: p.exitTime, exitReason: p.exitReason, current: p.exitPremium, points, rupees: points == null ? null : points * p.lots * p.lotSize }
    }
    // The trade's own premium stop / target (positions from before they existed use today's setting),
    // checked up to the setup's exit - whichever comes first closes it. A strategy's trade has exactly its own (held to
    // the max rules; null = none, no trailing stop; a change of the max rules in its levelLog) - never today's setting.
    const setupExitAt = o && o.status !== 'open' ? (o.exitAt != null ? o.exitAt + MIN : squareOffMs(p.entryTime)) : Infinity
    const ownExit = !!p.optExit
    const own = oi && setupExitAt > p.entryTime
      ? optionStopTargetHit(oi, p, p.entryTime, Math.min(setupExitAt, exitTime ?? Infinity, nowMs ?? Infinity),
        ownExit ? p.slPts : p.slPts ?? settings.paperSl ?? 20, ownExit ? p.targetPts : p.targetPts ?? settings.paperTarget ?? 30,
        ownExit ? null : { start: p.trailStart ?? settings.paperTrailStart ?? 0, gap: p.trailGap ?? settings.paperTrailGap ?? 0 }, p.levelLog)
      : null
    if (own) { exitTime = own.at; exitPremium = own.premium; exitReason = own.reason }
    if (!exitTime && o && o.status !== 'open') {
      // Closed by its setup once the clock has passed the setup's exit (a scanned day's outcomes are
      // already known for the whole day; a trade still running when the data ended closes at 15:10).
      const exitAt = o.exitAt != null ? o.exitAt + MIN : squareOffMs(p.entryTime)
      if (exitAt <= p.entryTime) {
        // Punched after its setup had already ended (older positions): never a trade - flat at entry.
        exitTime = p.entryTime; exitPremium = p.premium; exitReason = 'Setup had already ended'
      } else {
        const at = nowMs == null || exitAt <= nowMs ? exitAt : null
        // At the close of the minute it ended in - the same live as replayed (closePremiumAt), and final then.
        const premium = oi && at ? closePremiumAt(oi, p.side, p.strike, at) : null
        if (premium != null) { exitTime = at; exitPremium = premium; exitReason = exitLabel(o) }
        // A LIVE trade whose signal has ended is closed even when its option's premium is not known then (a strike with no
        // fresh tick) - it is closed on Dhan at the market; only its P&L here waits for a price.
        else if (at && p.live) { exitTime = at; exitPremium = null; exitReason = exitLabel(o) }
        // The day is over: a paper trade is NEVER left running. Its strike had no tick in the last five minutes before the
        // exit (a far strike, a thin minute), so it leaves at the last premium the day ever had for it; with no premium at
        // all after the entry, at the premium it went in at (flat) - said so in the reason, not quietly priced.
        else if (at && dayOver) {
          const last = oi ? closePremiumAt(oi, p.side, p.strike, at, Infinity) : null
          exitTime = at
          exitPremium = last ?? p.premium
          exitReason = `${exitLabel(o)}${last == null ? ' (no option price after the entry - flat)' : ' (at the last premium of the day)'}`
        }
      }
    }
    const now = exitTime ? { premium: exitPremium } : oi && nowMs ? { premium: premiumAt(oi, p.side, p.strike, nowMs) } : { premium: null }
    const points = now.premium == null ? null : p.action === 'BUY' ? now.premium - p.premium : p.premium - now.premium
    return { ...p, exitTime, exitReason, current: now.premium, points, rupees: points == null ? null : points * p.lots * p.lotSize }
  })
}

// ---- Message texts (the page and the server runner say the same thing) ----------------------------

/** The paper trade's entry message. `plan` (optionPlanFor with the premium) says how its option leaves the trade -
 *  without one, the index's levels in `cfg`. */
export function paperEntryText({ underlying, trade, lots, premium, setup, cfg, plan = null }) {
  const meta = STRATEGY_BY_ID[setup.id]
  const exit = plan ? optionExitText(plan) : `option SL ${cfg.paperSl ?? 20} / target ${cfg.paperTarget ?? 30} pts`
  return `Paper ${trade.action} ${underlying} ${trade.strike} ${trade.side} x${lots} lot(s) @ ${premium.toFixed(1)} - #${meta?.no} ${meta?.name} ${setup.side}, ${setup.spot ? 'spot' : 'futures'} ${setup.entry.toFixed(1)} (SL ${setup.stop.toFixed(1)}, target ${setup.target.toFixed(1)}${trailText(setup)}); ${exit}`
}

/** The signal's trailing stop, for messages: whose it is and how far. */
export function trailText(setup) {
  const t = setup.trail
  const whose = setup.trailOverride !== undefined ? 'its own' : 'the scanner\'s'
  if (!t) return setup.trailOverride !== undefined ? ', no trailing stop (its own)' : ''
  return t.unit === 'pts' ? `, trailing after +${t.startPts} pts, ${t.gapPts} behind (${whose})` : `, trailing after ${t.startR}R, ${t.gapR}R behind (${whose})`
}

export function setupExitText(s) {
  const meta = STRATEGY_BY_ID[s.id]
  const good = s.outcome.r > 0
  return `${exitLabel(s.outcome)}: #${meta.no} ${meta.name} ${s.side} - entry ${s.entry.toFixed(1)}, out ${s.outcome.exitPrice != null ? s.outcome.exitPrice.toFixed(1) : '-'} (${good ? '+' : ''}${s.outcome.r.toFixed(2)}R)`
}

export function paperExitResult(r, underlying) {
  return `${r.action === 'SELL' ? 'sold' : 'bought'} ${underlying} ${r.strike} ${r.side} x${r.lots} @ ${r.premium.toFixed(1)} -> ${r.current != null ? r.current.toFixed(1) : '-'} = ${r.points != null ? `${r.points >= 0 ? '+' : ''}${r.points.toFixed(1)} pts, Rs ${Math.round(r.rupees).toLocaleString('en-IN')}` : '-'}`
}

export function paperExitText(r, underlying) {
  const meta = STRATEGY_BY_ID[r.strategy]
  return `${r.live ? 'LIVE' : 'Paper'} exit - ${String(r.exitReason)}: ${paperExitResult(r, underlying)} (#${meta?.no} ${meta?.name})`
}

// Was a setup traded as an option (then its exit is reported by the trade's own message)?
export function setupWasTraded(positions, s) {
  const key = `${s.id}-${s.t}`
  return (positions ?? []).some((p) => p.setupKey === key || (p.strategy === s.id && p.setupSide === s.side && Math.abs(setupTimeOf(p) - s.t) < 2 * MIN))
}

// ---- The day's record for the server's scanner log (POST /api/scanner-log/day) ----------------------

// The server scanner's own defaults for anything its config does not say (the page's StrategyScanner / OrderFlowPage).
// autoPaper 'strategy': each strategy buys or sells what its own tuned setting says (Apply to the scanner), falling back
// to selling where there is none - nobody is sitting there to choose, unlike the Order Flow page, where the trader's own
// Buy / Sell always wins.
export const RUNNER_DEFAULT_SETTINGS = { alerts: true, telegram: true, pick: 'every', custom: [], filters: {}, trail: { on: true, ...DEFAULT_TRAIL }, autoPaper: 'strategy', paperLots: 1, moneyness: 0 }

/**
 * The scanner settings the server scanner trades ONE index with, from its config (GET /api/scanner-runner/config):
 * its saved settings, each strategy's filters on this index (a setting applied there, else the all-index ones), the
 * index's SL / target / trail and max rules, its lots and what an alert trades (trade-settings.csv). The runner and the
 * Trades page (redoing the record's If bought / If sold) read the same.
 */
export function runnerSettingsOf(config, underlying) {
  const s = { ...RUNNER_DEFAULT_SETTINGS, ...(config?.settings ?? {}) }
  // The index's levels from the server (its max rules with them); none sent at all: its defaults, max rules included. Levels
  // sent without max rules (from before them) take their SL / target as the max, as the server does.
  const own = config?.levels?.[underlying]
  const d = own ? null : defaultIndexTrade(underlying)
  const levels = { ...defaultTradeLevels(underlying), ...(d ? { maxSl: d.maxSl, maxTarget: d.maxTarget } : {}), trailStart: 0, trailGap: 0, ...(own ?? {}) }
  const trade = config?.trade?.[underlying] ?? {}
  return {
    ...s, filters: filtersForIndex({ filters: s.filters, filtersByIndex: config?.filtersByIndex }, underlying), paperSl: levels.sl, paperTarget: levels.target, paperTrailStart: levels.trailStart ?? 0, paperTrailGap: levels.trailGap ?? 0,
    // The max rules every strategy's option trade is held to (Trade settings - Max SL / Max target; 0 = none).
    paperMaxSl: Number(levels.maxSl ?? levels.sl) || 0, paperMaxTarget: Number(levels.maxTarget ?? levels.target) || 0,
    ...(trade.lots > 0 ? { paperLots: trade.lots } : {}), ...(trade.autoTrade ? { autoPaper: trade.autoTrade } : {}),
    paperLotSize: Number(trade.lotSize) > 0 ? Number(trade.lotSize) : PAPER_TRADE_LOT_SIZE[underlying] ?? 1,
  }
}

/**
 * What each option of a signal would have done, to compare with the one traded: the option to BUY and the option to SELL,
 * each taken EXACTLY the way the scanner trades a strategy's signal (newPosition / positionRows, the tuning's
 * optionOutcome) - at the strategy's own strike (`optionPlanFor`'s moneyness), from the signal's minute (its premium
 * then), out at ITS OWN option exit: its SL / target (its own %, held to the index's Max SL / Max target) checked from
 * the first full minute, else with the index trade (its stop / target / trailing stop / time stop - the premium once that
 * bar is over), or at 15:10 for an 'option' exit. So the leg of the side that was traded is the trade itself. In premium
 * points, with when and why each left; and the signal's own points on the index. Only for a signal that has closed, and
 * only with the day's OI (`oi`) - nothing past the exit. `filters` (the index's - filtersForIndex) / `cfg` (the scanner
 * settings: autoPaper, moneyness, paperMaxSl, paperMaxTarget) as the trade read them; none = ATM, out with the index trade.
 */
export function signalLegs(x, oi, { filters = {}, cfg = {} , nowMs = null } = {}) {
  const o = x.outcome ?? {}
  const closed = o.status && o.status !== 'open'
  // Still running: with a clock (`nowMs` - the live screener, never the record) each leg is priced AS IT STANDS NOW -
  // what it went in at, what it is worth at this minute and the points so far, marked `running`. Without one, nothing:
  // the record only ever keeps a leg that has left.
  const live = !closed && nowMs != null
  if (!closed && !live) return {}
  const dir = x.side === 'LONG' ? 1 : -1
  // Running: the points so far come from the outcome's R (it is (dir x (last close - entry)) / risk), so the index
  // and the spot signals each use the bars they are actually followed on.
  const out = live
    ? { running: true, indexPoints: Number.isFinite(o.r) ? o.r * Math.abs(x.entry - x.stop) : null }
    : { indexPoints: Number.isFinite(o.exitPrice) ? dir * (o.exitPrice - x.entry) : null }
  if (!oi) return out
  const indexExitAt = live ? nowMs : o.exitAt != null ? o.exitAt + MIN : squareOffMs(x.t)
  // The options the signal carries, with ANY SIDE IT IS MISSING filled from the chain at its own minute.
  // A setup is built at the clock, which for the futures strategies is part-way through a minute: a strike with no
  // tick yet made optionTradesFor return that side as null, and the setup kept the null for the rest of the day - so
  // the order-flow signals showed only one option, or none, in If bought / If sold. Taking the stored pair wholesale
  // (`x.options ?? ...`) never recovered it, because a half-filled pair is not nullish. The chain is read at the
  // signal's own minute, so nothing from after it is used. A signal read back from the log carries no options at all
  // (fillRecordLegs) and gets the ATM pair the same way.
  const atm = optionTradesFor(oi, dir, valueAt(oi.spot, x.t)?.close, x.t)
  const options = x.options?.buy && x.options?.sell ? x.options : { ...(atm ?? {}), ...(x.options?.buy ? { buy: x.options.buy } : {}), ...(x.options?.sell ? { sell: x.options.sell } : {}) }
  const setup = { ...x, options }
  const plan = optionPlanFor(x.id, filters, cfg)
  for (const which of ['buy', 'sell']) {
    const trade = optionTradeAt(oi, setup, which, plan.moneyness, x.t)
    if (!trade?.strike) continue
    // The last finished minute's premium at the signal (closePremiumAt: the same live as replayed).
    const entry = closePremiumAt(oi, trade.side, trade.strike, x.t) ?? trade.premium ?? null
    out[`${which}Option`] = `${trade.action ?? which.toUpperCase()} ${trade.strike} ${trade.side}`
    out[`${which}Entry`] = entry
    if (entry == null) continue
    const levels = optionPlanFor(x.id, filters, cfg, entry)
    const untilMs = live ? indexExitAt : levels.exit === 'option' ? squareOffMs(x.t) : indexExitAt
    const hit = untilMs > x.t ? optionStopTargetHit(oi, { ...trade, premium: entry }, x.t, untilMs, levels.slPts, levels.targetPts) : null
    const exitAt = hit ? hit.at : untilMs
    // Running and still open: the premium NOW (the running minute's live tick, premiumAt - not the finished minute's).
    const exit = hit ? hit.premium : live ? premiumAt(oi, trade.side, trade.strike, untilMs) : closePremiumAt(oi, trade.side, trade.strike, untilMs)
    out[`${which}Exit`] = exit ?? null
    out[`${which}ExitTime`] = exit != null && (!live || hit) ? exitAt : null
    out[`${which}ExitReason`] = exit == null ? null
      : hit ? hit.reason
        : live ? null
          : levels.exit === 'option' ? 'square-off 15:10' : `with the index trade - ${exitLabel(o)}`
    out[`${which}Points`] = exit != null ? (which === 'buy' ? exit - entry : entry - exit) : null
    // Its own SL / target, so the screener can say how far each leg is from leaving.
    out[`${which}Sl`] = levels.slPts ?? null
    out[`${which}Target`] = levels.targetPts ?? null
  }
  return out
}

export function scannerLogBody({ underlying, date, source, dayResults, rows, charges, oi = null, cfg = null }) {
  const signals = dayResults.map((x) => {
    const o = x.outcome ?? {}
    const meta = STRATEGY_BY_ID[x.id]
    const closed = o.status && o.status !== 'open'
    const legs = signalLegs(x, oi, { filters: cfg?.filters ?? {}, cfg: cfg ?? {} })
    return {
      time: x.t, strategyNo: meta?.no ?? null, strategyId: x.id, strategy: meta?.name ?? x.id, side: x.side, entry: x.entry, stop: x.stop, target: x.target,
      estimated: !!x.estimated, dayType: x.regime?.type ?? null, dayTypePrice: x.regime?.priceType ?? null,
      voteOi: x.regime?.votes?.oi ?? null, voteCvd: x.regime?.votes?.cvd ?? null, adaptiveTake: x.adaptive?.take ?? null,
      adaptivePriceOnly: x.adaptive?.priceOnly ?? null, adaptiveReason: x.adaptive?.reason ?? null, status: o.status ?? null, r: o.r ?? null,
      exitTime: closed ? o.exitAt ?? null : null, exitPrice: closed ? o.exitPrice ?? null : null, exitReason: closed ? exitLabel(o) : null,
      market: x.market ?? null,
      // Both options, each out at the strategy's own option exit as the trade is (signalLegs), and its index points - to
      // compare with the option actually traded.
      buyOption: legs.buyOption ?? null, buyEntry: legs.buyEntry ?? null, buyExit: legs.buyExit ?? null, buyPoints: legs.buyPoints ?? null,
      buyExitTime: legs.buyExitTime ?? null, buyExitReason: legs.buyExitReason ?? null,
      sellOption: legs.sellOption ?? null, sellEntry: legs.sellEntry ?? null, sellExit: legs.sellExit ?? null, sellPoints: legs.sellPoints ?? null,
      sellExitTime: legs.sellExitTime ?? null, sellExitReason: legs.sellExitReason ?? null,
      indexPoints: legs.indexPoints ?? null,
    }
  })
  // Each trade names its signal: the exact one, else the same strategy and side within two minutes.
  const signalOf = (r) => {
    const at = r.setupT ?? r.entryTime
    return signals.find((x) => `${x.strategyId}-${x.time}` === r.setupKey)
      ?? signals.filter((x) => x.strategyId === r.strategy && x.side === r.setupSide && Math.abs(x.time - at) < 2 * MIN).sort((a, b) => Math.abs(a.time - at) - Math.abs(b.time - at))[0]
  }
  // The option side a signal was TRADED on is that trade - its own entry, exit, time and reason (the If bought / If sold
  // of that side can never differ from the trade beside it); the other side stays what signalLegs measured.
  for (const r of rows ?? []) {
    const sig = signalOf(r)
    if (!sig || !r.exitTime || r.current == null || r.premium == null) continue
    const which = r.action === 'BUY' ? 'buy' : 'sell'
    Object.assign(sig, {
      [`${which}Option`]: `${r.action} ${r.strike} ${r.side}`, [`${which}Entry`]: r.premium, [`${which}Exit`]: r.current,
      [`${which}Points`]: r.action === 'BUY' ? r.current - r.premium : r.premium - r.current, [`${which}ExitTime`]: r.exitTime, [`${which}ExitReason`]: r.exitReason ?? null,
    })
  }
  const trades = (rows ?? []).map((r) => {
    const at = r.setupT ?? r.entryTime
    const sig = signalOf(r)
    const c = tradeCharges(r, chargeRates(charges))
    return {
      key: r.key, entryTime: r.entryTime, exitTime: r.exitTime ?? null, live: !!r.live, action: r.action, option: r.side, strike: r.strike, lots: r.lots,
      lotSize: r.lotSize ?? null, entryPremium: r.premium, exitPremium: r.exitTime ? r.current ?? null : null, points: r.points ?? null, rupees: r.rupees ?? null,
      exitReason: r.exitReason ?? null, signalTime: sig?.time ?? at, strategyNo: STRATEGY_BY_ID[r.strategy]?.no ?? null, strategyId: r.strategy,
      signalSide: r.setupSide, dayType: r.regime?.type ?? null, adaptiveTake: r.adaptive?.take ?? null, adaptiveReason: r.adaptive?.reason ?? null,
      // Its signal's index points and what each option would have made, out at the strategy's own option exit (signalLegs).
      indexPoints: sig?.indexPoints ?? null, buyPoints: sig?.buyPoints ?? null, sellPoints: sig?.sellPoints ?? null,
      ...(c ? { stt: c.stt, brokerage: c.brokerage, otherCharges: c.other, netRupees: c.net, netPerLot: c.netPerLot } : {}),
    }
  })
  return { underlying, date, source, signals, trades }
}

// A fingerprint of a day's record - post it again only when this changes.
export const scannerLogSig = (dayKey, body) => JSON.stringify([dayKey, body.signals.map((x) => [x.strategyId, x.side, x.time, x.status, x.r, x.buyPoints, x.sellPoints]), body.trades.map((t) => [t.key, t.exitTime, t.exitTime ? t.points : null])])
