// What kind of day it is - read at the clock from the completed 1-minute bars only (no look-ahead) - and
// what an ADAPTIVE scanner would do with a setup on such a day. Tracking only: nothing here stops a
// trigger; the scanner tags every setup with it and scores "what if we had gone adaptive" beside the real
// results.
//
// Day types (once the initial balance - the first hour - is complete):
//   trend-up / trend-down - broke ONE side of the IB, the day's range 1.4x+ the IB, the move from the
//                           open 55%+ of the range (efficient), 80%+ of the last 60 closes on one side of
//                           VWAP;
//   two-sided             - swings both ways: broke BOTH sides of the IB, or a wide day (1.4x+ the IB)
//                           going nowhere (under 35% net) while crossing VWAP 4+ times in 90 minutes;
//   range                 - sideways: inside the IB so far, or barely out (under 1.25x the IB) and
//                           crossing VWAP 3+ times in 90 minutes;
//   unclear               - none of these yet (a developing day); early - the IB is not complete.

const MIN = 60_000
const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())

export const REGIME_LABELS = {
  'trend-up': 'Trend up',
  'trend-down': 'Trend down',
  range: 'Range (sideways)',
  'two-sided': 'Two-sided (swings both ways)',
  unclear: 'Unclear (developing)',
  early: 'Early (IB forming)',
}

/** 09:15 IST of the session `nowMs` falls in (the day's first minute). */
export function sessionOpenMs(nowMs) {
  const minute = Math.floor((nowMs / MIN + 330) % 1440)
  return Math.floor(nowMs / MIN) * MIN - (minute - (9 * 60 + 15)) * MIN
}

/** The day type at `nowMs` from the session's completed 1-minute bars (`sessionOpenMs` = 09:15 IST).
 *  Returns { type, label, reasons, metrics }. */
export function dayRegime(minuteBars, nowMs, sessionOpenMs) {
  const bars = (minuteBars ?? []).filter((b) => msOf(b.time) >= sessionOpenMs && msOf(b.time) + MIN <= nowMs)
  const result = (type, reasons, metrics = null) => ({ type, label: REGIME_LABELS[type], reasons, metrics })
  if (bars.length < 60) return result('early', 'the initial balance (first hour) is not complete')
  const ib = bars.slice(0, 60)
  const ibHigh = Math.max(...ib.map((b) => b.high))
  const ibLow = Math.min(...ib.map((b) => b.low))
  const ibRange = ibHigh - ibLow
  const high = Math.max(...bars.map((b) => b.high))
  const low = Math.min(...bars.map((b) => b.low))
  const range = high - low
  const open = bars[0].open
  const last = bars.at(-1).close
  if (!(ibRange > 0) || !(range > 0)) return result('unclear', 'no range yet')
  const tol = last * 0.0002
  const brokeUp = high > ibHigh + tol
  const brokeDown = low < ibLow - tol
  const ext = range / ibRange
  const net = (last - open) / range
  // VWAP at each bar (volume-weighted typical price so far) - the side of each close, and the crossings.
  let pv = 0
  let v = 0
  const side = []
  for (const b of bars) {
    const vol = (b.buy ?? 0) + (b.sell ?? 0) || b.volume || 1
    pv += ((b.high + b.low + b.close) / 3) * vol
    v += vol
    const vwap = pv / v
    side.push(b.close > vwap ? 1 : b.close < vwap ? -1 : 0)
  }
  const last60 = side.slice(-60)
  const above = last60.filter((x) => x > 0).length / last60.length
  const below = last60.filter((x) => x < 0).length / last60.length
  let crosses = 0
  let prevSide = 0
  for (const x of side.slice(-90)) {
    if (x === 0) continue
    if (prevSide !== 0 && x !== prevSide) crosses++
    prevSide = x
  }
  const metrics = { ibHigh, ibLow, high, low, ext, net, above, below, crosses, brokeUp, brokeDown }
  const facts = `range ${ext.toFixed(1)}x the IB, net ${Math.round(net * 100)}% of it, ${Math.round(Math.max(above, below) * 100)}% of the last 60 closes ${above >= below ? 'above' : 'below'} VWAP, ${crosses} VWAP cross${crosses === 1 ? '' : 'es'} in 90m`
  const breaks = brokeUp && brokeDown ? 'broke both IB sides' : brokeUp ? 'broke the IB high' : brokeDown ? 'broke the IB low' : 'inside the IB'
  const reasons = `${breaks}, ${facts}`
  if (brokeUp !== brokeDown && ext >= 1.4 && Math.abs(net) >= 0.55) {
    if (brokeUp && net > 0 && above >= 0.8) return result('trend-up', reasons, metrics)
    if (brokeDown && net < 0 && below >= 0.8) return result('trend-down', reasons, metrics)
  }
  if ((brokeUp && brokeDown) || (ext >= 1.4 && Math.abs(net) < 0.35 && crosses >= 4)) return result('two-sided', reasons, metrics)
  if ((!brokeUp && !brokeDown) || (ext < 1.25 && crosses >= 3)) return result('range', reasons, metrics)
  return result('unclear', reasons, metrics)
}

/**
 * Each strategy's style, for the adaptive read:
 *   trend - continuation / breakout (it needs the market to travel);
 *   fade  - reversal / mean reversion (it needs the market to come back);
 *   any   - works either way.
 */
export const STRATEGY_STYLE = {
  wallDefence: 'fade', wallBreak: 'trend', migration: 'trend', squeeze: 'trend', flush: 'trend', buildUp: 'trend',
  range: 'fade', openingBias: 'trend', iceberg: 'fade', maxPain: 'any',
  vaRejection: 'fade', tpo80: 'fade', pocReaction: 'fade', lvnRun: 'trend', ibBreakout: 'trend',
  weakWall: 'trend', trap: 'fade', cvdDivergence: 'fade', blockTrade: 'trend', imbalanceRetest: 'trend', atmFlip: 'trend',
  vwapFade: 'fade', ibFade: 'fade', oiSqueeze: 'trend', suddenWall: 'any', heatmapOi: 'any', vwapPullback: 'trend',
  oiStructure: 'any', vwapOi: 'trend', ibFailed: 'fade',
}

/**
 * Would an adaptive scanner take `setup` on a day of type `regime.type`? (Tracking only.)
 *   trend day       - only trades WITH the trend (a trend setup or a fade of a pullback alike);
 *   range/two-sided - fades and either-way setups; no trend / breakout setups;
 *   unclear / early - everything (nothing known to go against).
 * Returns { take, reason }.
 */
export function adaptiveDecision(setup, regime) {
  const style = STRATEGY_STYLE[setup.id] ?? 'any'
  const dir = setup.side === 'LONG' ? 1 : -1
  const type = regime?.type ?? 'unclear'
  if (type === 'trend-up' || type === 'trend-down') {
    const trendDir = type === 'trend-up' ? 1 : -1
    return dir === trendDir
      ? { take: true, reason: `with the ${type === 'trend-up' ? 'up' : 'down'} trend` }
      : { take: false, reason: `against the ${type === 'trend-up' ? 'up' : 'down'} trend` }
  }
  if (type === 'range' || type === 'two-sided') {
    return style === 'trend'
      ? { take: false, reason: `a ${style} setup on a ${type === 'range' ? 'range' : 'two-sided'} day` }
      : { take: true, reason: `a ${style === 'fade' ? 'fade' : 'either-way setup'} on a ${type === 'range' ? 'range' : 'two-sided'} day` }
  }
  return { take: true, reason: type === 'early' ? 'day type not known yet' : 'day type unclear' }
}

/** Real results vs "what if adaptive": all scored setups, the ones an adaptive scanner would have taken,
 *  the ones it would have skipped - overall and per day type. Setups scored before tracking (no
 *  `adaptive` on them) are counted apart as untracked. */
export function adaptiveStats(setups) {
  const empty = () => ({ trades: 0, wins: 0, totalR: 0 })
  const add = (s, r) => { s.trades++; s.totalR += r; if (r > 0) s.wins++ }
  const all = empty()
  const take = empty()
  const skip = empty()
  const byType = {}
  let untracked = 0
  for (const t of setups ?? []) {
    if (!t.outcome || t.outcome.status === 'open') continue
    if (!t.adaptive) { untracked++; continue }
    const r = t.outcome.r
    add(all, r)
    add(t.adaptive.take ? take : skip, r)
    const k = t.regime?.type ?? 'unclear'
    byType[k] ??= { type: k, label: REGIME_LABELS[k] ?? k, all: empty(), take: empty(), skip: empty() }
    add(byType[k].all, r)
    add(t.adaptive.take ? byType[k].take : byType[k].skip, r)
  }
  const fin = (s) => ({ ...s, winRate: s.trades ? s.wins / s.trades : null, avgR: s.trades ? s.totalR / s.trades : null })
  const order = Object.keys(REGIME_LABELS)
  return {
    all: fin(all), take: fin(take), skip: fin(skip), untracked,
    byType: Object.values(byType).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type))
      .map((x) => ({ ...x, all: fin(x.all), take: fin(x.take), skip: fin(x.skip) })),
  }
}
