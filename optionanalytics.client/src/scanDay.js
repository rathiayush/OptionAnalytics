// A whole day scanned minute by minute - the scanner's "Scan day" / "Scan today so far" and the strategy
// tuning (strategyTuning.js) both run this, so a tuned setting is measured on exactly what the scanner fires.
// React-free; the page yields to the browser between minutes (onProgress), Node does not need to.

import { evaluateStrategies, simulateOutcome } from './strategyEngine.js'
import { liquiditySignals, pullStackSignals, replayRange, replayView } from './orderFlowMath.js'
import { MIN, COOLDOWN_MS, completedBars, priceAt, upTo, trailOf } from './scannerCore.js'
import { toColumn } from './liveFeeds.js'

/** The replay day the Order Flow page builds from GET /api/order-flow/{u}/day/{date}. */
export function dayFromOrderFlow(body, date, underlying) {
  return {
    meta: body.meta, minuteBars: body.bars ?? [], trades: body.trades ?? [], icebergs: body.icebergs ?? [], heatmap: (body.heatmap ?? []).map(toColumn),
    sweeps: body.sweeps ?? [], source: body.source, note: body.note, date, underlying, backfill: body.backfill ?? [], recordedFrom: body.recordedFrom ?? null,
  }
}

/**
 * Every setup the strategies give at each whole minute of the day (from 15 minutes after the first bar),
 * each as of that minute: `keepAll` - every one, every minute (the tuning dedupes after its own filters);
 * otherwise the scanner's list - the same strategy and side fire again only after COOLDOWN_MS - each with its
 * trailing stop (`trail`, or its strategy's own). `until` - stop at that clock (today so far).
 * Returns the setups (no outcomes).
 */
export async function scanDaySetups({ day, prints, oi, profile, rowSize, lotSize, largeLots, estimated, filters, trail = null, until = null, keepAll = false }, onProgress = null) {
  const range = replayRange(day)
  if (!range) return []
  const found = []
  const start = Math.ceil((range.start + 15 * MIN) / MIN) * MIN
  const end = until != null ? Math.min(range.end, until) : range.end
  const steps = Math.max(1, Math.floor((end - start) / MIN))
  for (let i = 0; i <= steps; i++) {
    const clock = start + i * MIN
    const v = replayView(day, clock)
    const bars = completedBars(v.minuteBars, clock, rowSize, lotSize, estimated)
    if (bars.length >= 5) {
      const cols = v.heatmap.slice(-300)
      const liq = estimated ? [] : liquiditySignals({ columns: cols, trades: v.trades, minuteBars: v.minuteBars, rowSize, lotSize })
      const ps = estimated ? { signals: [] } : pullStackSignals({ columns: cols.slice(-60), rowSize, lotSize })
      const clockPrints = prints ? upTo(prints, clock) : null
      const price = priceAt(v, clockPrints, clock, bars)
      const setups = evaluateStrategies({
        nowMs: clock, price, bars, minuteBars: v.minuteBars, prints: clockPrints,
        book: v.book, liquidity: liq, pullStack: ps.signals, sweeps: v.sweeps, icebergs: v.icebergs, oi, estimated, lotSize, bigLots: largeLots, profile, heatmap: v.heatmap, rowSize,
        filters,
      })
      for (const s of setups) {
        if (keepAll) { found.push(s); continue }
        if (!found.some((f) => f.id === s.id && f.side === s.side && s.t - f.t < COOLDOWN_MS)) found.push({ ...s, trail: trailOf(s, trail) })
      }
    }
    if (onProgress && i % 10 === 0) await onProgress(i, steps)
  }
  return found
}

/** The scanner's list from every setup of every minute: the first of each strategy and side, then again
 *  only after COOLDOWN_MS - what scanDaySetups (without keepAll) gives, in time order. */
export function firstPerCooldown(setups, cooldownMs = COOLDOWN_MS) {
  const found = []
  for (const s of setups) if (!found.some((f) => f.id === s.id && f.side === s.side && s.t - f.t < cooldownMs)) found.push(s)
  return found
}

/** A finished day's setups with their outcomes - Scan day's result. */
export function withDayOutcomes(setups, day) {
  const range = replayRange(day)
  return setups.map((s) => ({ ...s, outcome: simulateOutcome(s, day.minuteBars, (range?.end ?? 0) + MIN, true) }))
}
