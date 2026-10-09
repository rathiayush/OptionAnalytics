// The SPOT + OPTIONS strategies: they trade the index price itself - the 1-minute spot candles - read against the
// option chain's OI (the S/R OI walls, CE and PE rising or falling, delta and since the open, the day type). No
// futures, no footprint, tape or order book: spot has none. Entry = the last finished spot minute's close,
// stop / target in spot points; the options each setup carries (BUY / SELL at the ATM strike) are priced from the
// OI replay like the futures strategies'. No look-ahead: a setup at clock T uses only spot minutes and OI points
// that had FINISHED by T (the replay context is built with live: false).
//
// Measured by the Strategy tuning ("Spot + options only", scanSpotDay -> strategyTuning.js). The live scanner
// does not run them yet, so applying a tuned spot setting only records it.

import {
  SPOT_STRATEGIES, SQUARE_OFF, applyTradeFilter, dayTypeAt, optionOiRead, optionTradesFor, oiRows, sideOiChanges, strategyFilters,
  valueAt, wallOiChanges, wallsAhead, wallsAt,
} from './strategyEngine.js'

const MIN = 60_000
const msOf = (t) => (typeof t === 'number' ? t : Date.parse(t))
const istMinute = (ms) => Math.floor((ms / MIN + 330) % 1440)
const FIRST_ENTRY = 9 * 60 + 30
const LAST_ENTRY = 14 * 60 + 45
const SIDE_BAR = 0.003 // a side's OI really rising / falling: 0.3% of its OI in 15 minutes (as the filters)
const WALL_BAR = 0.005 // a wall's OI really growing / shrinking: 0.5% in 15 minutes
const BY_ID = Object.fromEntries(SPOT_STRATEGIES.map((s) => [s.id, s]))

/** Spot candles as the engine reads them: { t (start, ms), time, open, high, low, close }. */
export const spotBarsOf = (candles) => (candles ?? []).map((c) => ({ t: msOf(c.time), time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }))
  .filter((b) => b.close > 0 && b.high >= b.low).sort((a, b) => a.t - b.t)

/** What a side pair (CE, PE OI change as a fraction) says for a trade `dir`: PE rising and CE falling are the two
 *  bullish sides - +2 both with the trade ... -2 both against. */
export function sideScore(dir, ce, pe, bar = SIDE_BAR) {
  if (!Number.isFinite(ce) || !Number.isFinite(pe)) return null
  const st = (x) => (x >= bar ? 1 : x <= -bar ? -1 : 0)
  return dir * (st(pe) - st(ce))
}

const avgRange = (bars, n = 14) => {
  const last = bars.slice(-n)
  return last.length ? last.reduce((s, b) => s + (b.high - b.low), 0) / last.length : 0
}

/**
 * Every spot setup whose rules pass at `nowMs` (a whole minute). `bars` - the FINISHED spot minutes up to it (spotBarsOf,
 * start + 1 minute <= nowMs), `oi` - buildOiContext(run, expiry, { live: false }), `filters` - { [id]: overrides }.
 * Setups have the futures setups' shape (id, name, side, t, entry, stop, target, timeStopMs, options, oiCtx, checks).
 */
export function evaluateSpotStrategies({ nowMs, bars, oi, filters = {} }) {
  if (!oi || bars.length < 15) return []
  const minute = istMinute(nowMs)
  if (minute < FIRST_ENTRY || minute > LAST_ENTRY) return []
  const last = bars.at(-1)
  const prev = bars.at(-2)
  const spotNow = last.close
  const rows = oiRows(oi, nowMs)
  if (!rows.length || !(valueAt(oi.spot, nowMs)?.close > 0)) return []
  const atr = Math.max(avgRange(bars), spotNow * 0.0004)
  const read = optionOiRead(oi, spotNow, nowMs, 15)
  if (!read) return []
  const { support, resistance } = wallsAt(oi, rows, spotNow)
  const ahead = wallsAhead(oi, rows, spotNow)
  const sides = sideOiChanges(read, false) // ceD, peD
  const cum = sideOiChanges(read, true) // ceC, peC
  let regimeMemo
  const regime = () => (regimeMemo ??= dayTypeAt(oi, bars, nowMs))
  const out = []

  const ctx = () => ({
    flow: read.lean, cum: read.leanOpen, futOiPct: null, futPricePct: null,
    ...wallOiChanges(oi, ahead, nowMs, 15), ...sides, ...cum, dayType: regime()?.type ?? null,
    byWindow: Object.fromEntries([1, 3, 5].map((m) => {
      const r = optionOiRead(oi, spotNow, nowMs, m)
      return [m, { flow: r?.lean ?? null, futOiPct: null, futPricePct: null, ...wallOiChanges(oi, ahead, nowMs, m), ...sideOiChanges(r, false) }]
    })),
    support, resistance, spot: spotNow, ...ahead,
  })
  const push = (id, dir, stopPts, targetPts, timeStopMin, checks) => {
    if (!(stopPts > 0) || !(targetPts > 0)) return
    out.push({
      id, name: BY_ID[id].name, side: dir > 0 ? 'LONG' : 'SHORT', t: nowMs, entry: spotNow,
      stop: spotNow - dir * stopPts, target: spotNow + dir * targetPts,
      timeStopMs: Math.min(nowMs + timeStopMin * MIN, nowMs + (SQUARE_OFF - minute) * MIN),
      estimated: false, spot: true, options: optionTradesFor(oi, dir, spotNow, nowMs), oiCtx: ctx(), checks,
    })
  }
  const pct = (v) => (v == null ? 'no read' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(2)}%`)

  for (const dir of [1, -1]) {
    const wall = dir > 0 ? resistance : support // the call wall above a long / the put wall below a short
    const wallChg = wall == null ? null : wallOiChanges(oi, dir > 0 ? { resistanceAhead: wall, supportAhead: null } : { resistanceAhead: null, supportAhead: wall }, nowMs, 15)[dir > 0 ? 'resChg' : 'supChg']
    const score = sideScore(dir, sides.ceD, sides.peD)

    // 1. Wall break: the price closes through the wall it was under, the wall's writers are leaving, the two sides
    //    are not against the trade.
    if (wall != null && prev && dir * (prev.close - wall) <= 0 && dir * (spotNow - wall) > 0.15 * atr && wallChg != null && wallChg <= -WALL_BAR && score != null && score >= 0) {
      const stopPts = Math.max(1.2 * atr, Math.abs(spotNow - wall) + 0.8 * atr)
      push('spotWallBreak', dir, stopPts, 2 * stopPts, 45, {
        OI: `closed ${Math.abs(spotNow - wall).toFixed(1)} pts ${dir > 0 ? 'above' : 'below'} the ${dir > 0 ? 'call' : 'put'} wall ${wall}; its OI ${pct(wallChg)} in 15m; CE ${pct(sides.ceD)} / PE ${pct(sides.peD)}`,
      })
    }

    // 2. Wall holds: the price touched the wall the trade leans on (a put wall below a long, a call wall above a short)
    //    and closed back off it on a rejection candle, and that wall's OI is GROWING.
    const rejection = dir > 0 ? last.close > last.open : last.close < last.open
    const holdWall = dir > 0 ? support : resistance
    const holdChg = holdWall == null ? null : wallOiChanges(oi, dir > 0 ? { resistanceAhead: null, supportAhead: holdWall } : { resistanceAhead: holdWall, supportAhead: null }, nowMs, 15)[dir > 0 ? 'supChg' : 'resChg']
    const touchedHold = holdWall != null && (dir > 0 ? last.low <= holdWall + 0.001 * spotNow && last.close > holdWall : last.high >= holdWall - 0.001 * spotNow && last.close < holdWall)
    if (touchedHold && rejection && holdChg != null && holdChg >= WALL_BAR && score != null && score >= 0) {
      const stopPts = Math.max(1.2 * atr, Math.abs(spotNow - holdWall) + 0.8 * atr)
      push('spotWallHold', dir, stopPts, 1.5 * stopPts, 30, {
        OI: `rejected at the ${dir > 0 ? 'put' : 'call'} wall ${holdWall}; its OI ${pct(holdChg)} in 15m (growing); CE ${pct(sides.ceD)} / PE ${pct(sides.peD)}`,
      })
    }

    // 3. Sides with the move: CE and PE both back the trade now (PE rising and CE falling for a long) and since the
    //    open, and the price breaks out of its last 10 minutes.
    const cumScore = sideScore(dir, cum.ceC, cum.peC, 0.01)
    const recent = bars.slice(-11, -1)
    const broke = recent.length === 10 && (dir > 0 ? spotNow > Math.max(...recent.map((b) => b.high)) : spotNow < Math.min(...recent.map((b) => b.low)))
    if (broke && score === 2 && cumScore != null && cumScore >= 1) {
      push('spotSides', dir, 1.5 * atr, 3 * atr, 60, {
        OI: `broke the last 10 minutes' ${dir > 0 ? 'high' : 'low'}; CE ${pct(sides.ceD)} / PE ${pct(sides.peD)} now, CE ${pct(cum.ceC)} / PE ${pct(cum.peC)} since the open`,
      })
    }

    // 4. Pullback to the day's average on a trending day: the session's average price (spot has no volume, so each
    //    minute counts the same), a pullback to it after a real run away from it, a candle turning back with the trend.
    const typical = bars.map((b) => (b.high + b.low + b.close) / 3)
    const avg = typical.reduce((s, v) => s + v, 0) / typical.length
    const ran = bars.slice(-60).reduce((m, b) => Math.max(m, dir * ((dir > 0 ? b.high : b.low) - avg)), -Infinity)
    const pulled = dir * ((dir > 0 ? last.low : last.high) - avg) <= 0.5 * atr && dir * (last.close - avg) > 0 && rejection
    if (pulled && ran >= 1.5 * atr && regime()?.type === (dir > 0 ? 'trend-up' : 'trend-down') && score != null && score >= 0) {
      const stopPts = Math.max(1.2 * atr, dir * (spotNow - ((dir > 0 ? Math.min(last.low, avg) : Math.max(last.high, avg)) - dir * 0.5 * atr)))
      push('spotAvgPullback', dir, stopPts, 2 * stopPts, 60, {
        OI: `${regime().label}; pulled back to the day's average ${avg.toFixed(1)} after a ${(ran).toFixed(1)} pt run; CE ${pct(sides.ceD)} / PE ${pct(sides.peD)}`,
      })
    }
  }
  // The trade filters (sides, entry window, stop / target size, time stop, trailing, OI filters) - defaults change nothing.
  return out.map((s) => applyTradeFilter(s, strategyFilters(s.id, filters?.[s.id]))).filter(Boolean)
}

/**
 * Every spot setup of every minute of a day (from 15 minutes after the first candle): `bars` - spotBarsOf the day's
 * 1-minute candles, `oi` - the replay context (live: false). The tuning dedupes after its own filters, like the futures'.
 */
export function scanSpotDay({ bars, oi, filters = {}, until = null }) {
  if (!bars?.length || !oi) return []
  const found = []
  const first = bars[0].t + 15 * MIN
  const end = (until ?? bars.at(-1).t + MIN)
  let done = 0 // bars finished by the clock
  for (let clock = first; clock <= end; clock += MIN) {
    while (done < bars.length && bars[done].t + MIN <= clock) done++
    found.push(...evaluateSpotStrategies({ nowMs: clock, bars: bars.slice(0, done), oi, filters }))
  }
  return found
}
