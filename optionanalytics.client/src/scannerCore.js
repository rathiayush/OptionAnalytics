// The strategy scanner's logic without React - shared by the Order Flow page's StrategyScanner and the
// server-side scanner runner (scanner-runner/), so both fire, trade and close exactly the same way.
// Everything here is pure: no storage, no timers, no network; the caller owns state and side effects.

import {
  ACTIVE_STRATEGIES, STRATEGY_BY_ID, evaluateStrategies, simulateOutcome, coolOffGate, DEFAULT_TRAIL, RANGE_IDS,
  exitLabel, premiumAt, optionStopTargetHit, squareOffMs,
} from './strategyEngine.js'
import { aggregateBars, analyzeBars, findWalls } from './orderFlowMath.js'
import { chargeRates, tradeCharges } from './tradeCharges.js'

export const MIN = 60_000
// One alert per strategy and direction at most every 20 minutes - a setup that stays true is one trade.
export const COOLDOWN_MS = 20 * MIN
export const ALL_IDS = ACTIVE_STRATEGIES.map((s) => s.id)
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

// The strategies alerted on: the Top 15 (by default), the OI / profile five, the range-bound ones, all,
// or a custom list. `top` is topFifteen(strategyStats(...)).
export function alertIdsFor(settings, top) {
  const top15Ids = [...top.ids, ...top.trial]
  return settings.pick === 'top15' ? top15Ids : settings.pick === 'oi5' ? top.oi.ids : settings.pick === 'profile5' ? top.profile.ids
    : settings.pick === 'range' ? RANGE_IDS : settings.pick === 'all' ? ALL_IDS : settings.custom ?? []
}

// When a paper / live position's setup fired (older positions only carry it in their key).
export function setupTimeOf(p) {
  return p.setupT ?? Number(String(p.setupKey).split('-').at(-1))
}

// The same signal: the same strategy, direction and side (buy / sell) within the alert cooldown.
export const sameSignal = (p, setup, trade) => p.strategy === setup.id && p.setupSide === setup.side && p.action === trade.action && Math.abs(setupTimeOf(p) - setup.t) < COOLDOWN_MS

/**
 * One look at the market at the clock - the live loop's body. `memory` is the caller's { fired, pending }
 * (pending is the cool-off Map and is updated in place, as coolOffGate does). Returns null when there is
 * nothing to judge yet (no OI, too few bars, a tape that has not caught up); otherwise what is being
 * watched, what is held for the cool-off, the setups that fire now and the day's fired list with them.
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
  // Price ran too far too fast into a setup: it is held and entered on the pullback / pause.
  const gate = coolOffGate(memory.pending, setups.filter((s) => !recentlyFired(s)), { nowMs, price, bars, oi })
  const held = [...memory.pending.values()].map((p) => p.setup)
  const fresh = gate.fire.filter((s) => !recentlyFired(s)).map((s) => ({ ...s, trail }))
  return { price, watching, held, fresh, fired: fresh.length ? [...memory.fired, ...fresh] : memory.fired }
}

// Each fired setup with its outcome so far (its trailing stop following any change logged after it fired).
export function followSetups(fired, trailLog, minuteBars, nowMs) {
  return fired.map((s) => {
    const withLog = trailLog.some((c) => c.t > s.t) ? { ...s, trailLog: trailLog.filter((c) => c.t > s.t) } : s
    return { ...withLog, outcome: simulateOutcome(withLog, minuteBars ?? [], nowMs ?? 0) }
  })
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
export function newPosition({ setup, trade, which, lots, lotSize, premium, cfg, at }) {
  return {
    key: `${setup.id}-${setup.t}-${which}`, setupKey: `${setup.id}-${setup.t}`, setupT: setup.t, strategy: setup.id, setupSide: setup.side,
    adaptive: setup.adaptive ?? null, regime: setup.regime ?? null, action: trade.action, side: trade.side, strike: trade.strike,
    lots, lotSize, premium, slPts: cfg.paperSl ?? 20, targetPts: cfg.paperTarget ?? 30,
    trailStart: cfg.paperTrailStart ?? 0, trailGap: cfg.paperTrailGap ?? 0, entryTime: at, exitTime: null, exitPremium: null, exitReason: null,
  }
}

/**
 * The day's option positions, each closed by its own premium stop / target / trail, or by its setup's
 * exit (or by hand), with P&L at the clock. `dayResults` and `withOutcome` are the day's setups with
 * their outcomes. Paper trades are all sized by the lots set now; a live trade keeps its quantity.
 */
export function positionRows({ positions, dayResults, withOutcome, oi, nowMs, settings }) {
  // A position's setup: the alerted one (live / replay outcomes, followed up to the clock), else the
  // same strategy and side within two minutes in the day's list (a scanned day's setups are timed to
  // the minute, an alert to 10 s).
  const exact = new Map([...dayResults, ...withOutcome].map((s) => [`${s.id}-${s.t}`, s]))
  const setupOf = (p) => exact.get(p.setupKey) ?? [...withOutcome, ...dayResults]
    .filter((s) => s.id === p.strategy && s.side === p.setupSide && Math.abs(s.t - setupTimeOf(p)) < 2 * MIN)
    .sort((a, b) => Math.abs(a.t - p.entryTime) - Math.abs(b.t - p.entryTime))[0]
  const outcomeOf = (p) => setupOf(p)?.outcome
  const paperLots = Math.max(1, settings.paperLots ?? 1)
  return (positions ?? []).filter((p) => !nowMs || p.entryTime <= nowMs).map((stored) => {
    // The adaptive call of the trade's signal (stored when punched; older trades look it up).
    const sig = stored.adaptive ? null : setupOf(stored)
    const tagged = { ...stored, adaptive: stored.adaptive ?? sig?.adaptive ?? null, regime: stored.regime ?? sig?.regime ?? null }
    const p = tagged.live ? tagged : { ...tagged, lots: paperLots }
    let exitTime = p.exitTime && p.exitTime <= (nowMs ?? Infinity) ? p.exitTime : null
    let exitPremium = exitTime ? p.exitPremium : null
    let exitReason = exitTime ? p.exitReason : null
    const o = outcomeOf(p)
    if (p.live && p.exitSent) {
      // A live trade whose exit has gone to Dhan keeps the exit it was sent with.
      const points = p.exitPremium == null ? null : p.action === 'BUY' ? p.exitPremium - p.premium : p.premium - p.exitPremium
      return { ...p, exitTime: p.exitTime, exitReason: p.exitReason, current: p.exitPremium, points, rupees: points == null ? null : points * p.lots * p.lotSize }
    }
    // The trade's own premium stop / target (positions from before they existed use today's setting),
    // checked up to the setup's exit - whichever comes first closes it.
    const setupExitAt = o && o.status !== 'open' ? (o.exitAt != null ? o.exitAt + MIN : squareOffMs(p.entryTime)) : Infinity
    const own = oi && setupExitAt > p.entryTime
      ? optionStopTargetHit(oi, p, p.entryTime, Math.min(setupExitAt, exitTime ?? Infinity, nowMs ?? Infinity), p.slPts ?? settings.paperSl ?? 20, p.targetPts ?? settings.paperTarget ?? 30,
        { start: p.trailStart ?? settings.paperTrailStart ?? 0, gap: p.trailGap ?? settings.paperTrailGap ?? 0 }, p.levelLog)
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
        const premium = oi && at ? premiumAt(oi, p.side, p.strike, at) : null
        if (premium != null) { exitTime = at; exitPremium = premium; exitReason = exitLabel(o) }
      }
    }
    const now = exitTime ? { premium: exitPremium } : oi && nowMs ? { premium: premiumAt(oi, p.side, p.strike, nowMs) } : { premium: null }
    const points = now.premium == null ? null : p.action === 'BUY' ? now.premium - p.premium : p.premium - now.premium
    return { ...p, exitTime, exitReason, current: now.premium, points, rupees: points == null ? null : points * p.lots * p.lotSize }
  })
}

// ---- Message texts (the page and the server runner say the same thing) ----------------------------

export function paperEntryText({ underlying, trade, lots, premium, setup, cfg }) {
  const meta = STRATEGY_BY_ID[setup.id]
  return `Paper ${trade.action} ${underlying} ${trade.strike} ${trade.side} x${lots} lot(s) @ ${premium.toFixed(1)} - #${meta?.no} ${meta?.name} ${setup.side}, futures ${setup.entry.toFixed(1)} (SL ${setup.stop.toFixed(1)}, target ${setup.target.toFixed(1)}); option SL ${cfg.paperSl ?? 20} / target ${cfg.paperTarget ?? 30} pts`
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
  return `Paper exit - ${String(r.exitReason)}: ${paperExitResult(r, underlying)} (#${meta?.no} ${meta?.name})`
}

// Was a setup traded as an option (then its exit is reported by the trade's own message)?
export function setupWasTraded(positions, s) {
  const key = `${s.id}-${s.t}`
  return (positions ?? []).some((p) => p.setupKey === key || (p.strategy === s.id && p.setupSide === s.side && Math.abs(setupTimeOf(p) - s.t) < 2 * MIN))
}

// ---- The day's record for the server's scanner log (POST /api/scanner-log/day) ----------------------

export function scannerLogBody({ underlying, date, source, dayResults, rows, charges }) {
  const signals = dayResults.map((x) => {
    const o = x.outcome ?? {}
    const meta = STRATEGY_BY_ID[x.id]
    const closed = o.status && o.status !== 'open'
    return {
      time: x.t, strategyNo: meta?.no ?? null, strategyId: x.id, strategy: meta?.name ?? x.id, side: x.side, entry: x.entry, stop: x.stop, target: x.target,
      confidence: x.confidence ?? null, estimated: !!x.estimated, dayType: x.regime?.type ?? null, dayTypePrice: x.regime?.priceType ?? null,
      voteOi: x.regime?.votes?.oi ?? null, voteCvd: x.regime?.votes?.cvd ?? null, adaptiveTake: x.adaptive?.take ?? null,
      adaptivePriceOnly: x.adaptive?.priceOnly ?? null, adaptiveReason: x.adaptive?.reason ?? null, status: o.status ?? null, r: o.r ?? null,
      exitTime: closed ? o.exitAt ?? null : null, exitPrice: closed ? o.exitPrice ?? null : null, exitReason: closed ? exitLabel(o) : null,
    }
  })
  // Each trade names its signal: the exact one, else the same strategy and side within two minutes.
  const trades = (rows ?? []).map((r) => {
    const at = r.setupT ?? r.entryTime
    const sig = signals.find((x) => `${x.strategyId}-${x.time}` === r.setupKey)
      ?? signals.filter((x) => x.strategyId === r.strategy && x.side === r.setupSide && Math.abs(x.time - at) < 2 * MIN).sort((a, b) => Math.abs(a.time - at) - Math.abs(b.time - at))[0]
    const c = tradeCharges(r, chargeRates(charges))
    return {
      key: r.key, entryTime: r.entryTime, exitTime: r.exitTime ?? null, live: !!r.live, action: r.action, option: r.side, strike: r.strike, lots: r.lots,
      lotSize: r.lotSize ?? null, entryPremium: r.premium, exitPremium: r.exitTime ? r.current ?? null : null, points: r.points ?? null, rupees: r.rupees ?? null,
      exitReason: r.exitReason ?? null, signalTime: sig?.time ?? at, strategyNo: STRATEGY_BY_ID[r.strategy]?.no ?? null, strategyId: r.strategy,
      signalSide: r.setupSide, dayType: r.regime?.type ?? null, adaptiveTake: r.adaptive?.take ?? null, adaptiveReason: r.adaptive?.reason ?? null,
      ...(c ? { stt: c.stt, brokerage: c.brokerage, otherCharges: c.other, netRupees: c.net, netPerLot: c.netPerLot } : {}),
    }
  })
  return { underlying, date, source, signals, trades }
}

// A fingerprint of a day's record - post it again only when this changes.
export const scannerLogSig = (dayKey, body) => JSON.stringify([dayKey, body.signals.map((x) => [x.strategyId, x.side, x.time, x.status, x.r]), body.trades.map((t) => [t.key, t.exitTime, t.exitTime ? t.points : null])])
