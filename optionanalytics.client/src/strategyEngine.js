// The OI + Order Flow playbook's 10 strategies as objective rules, run on the Order Flow page live and
// at the replay clock (and over a whole day by "Scan day"). Each strategy reads all five screens:
//
//   OI        - the OI Replay data for the day (/api/oi-replay/{u}/run): option OI per strike (walls,
//               OI change, writer migration, max pain) and the futures' own OI (build-up / covering).
//   Footprint - 1-minute analyzed bars: delta, cumulative delta, stacked imbalances, absorption,
//               exhaustion.
//   Tape      - Time & Sales prints: aggression over 30s / 1m, big prints, speed, sweeps.
//   DOM       - the book: bid share of the top levels, walls.
//   Heatmap   - liquidity signals (wall absorption, spoofing, magnet), pulled / stacked liquidity, icebergs.
//
// Rule: OI + Footprint + Tape required, DOM or Heatmap confirming. On a day ESTIMATED from 1-minute
// candles there is no tape, book or heatmap: the tape checks use each minute's estimated buy/sell
// split instead and the DOM/Heatmap confirmation is waived - such results are marked "estimated".
//
// Prices: order flow is read on the FUTURES; option strikes are in INDEX (spot) terms, so a strike is
// moved into futures terms with the current basis (futures - spot).
//
// Every setup carries an entry (the futures price), a stop and a target in futures points and a time
// stop; simulateOutcome walks the minute bars after it to see which came first. That is the outcome
// of the futures move the strategy calls - the option you would trade moves with it, but its own
// P&L (premium, decay) is not modelled.

const MIN = 60_000
const msOf = (t) => (typeof t === 'number' ? t : new Date(t).getTime())
const istMinute = (ms) => Math.floor((ms / MIN + 330) % 1440) // minutes since IST midnight
const hm = (h, m) => h * 60 + m
const EOD = hm(15, 10)

export const STRATEGIES = [
  { id: 'wallDefence', no: 1, name: 'OI wall defence', short: 'Wall defence' },
  { id: 'wallBreak', no: 2, name: 'OI wall break - writers run', short: 'Wall break' },
  { id: 'migration', no: 3, name: 'Writer migration', short: 'Migration' },
  { id: 'squeeze', no: 4, name: 'Short-covering squeeze', short: 'Squeeze' },
  { id: 'flush', no: 5, name: 'Long-unwinding flush', short: 'Flush' },
  { id: 'buildUp', no: 6, name: 'Fresh build-up trend', short: 'Build-up trend' },
  { id: 'range', no: 7, name: 'Range between two growing walls', short: 'Range fade' },
  { id: 'openingBias', no: 8, name: 'Opening OI bias + range breakout', short: 'Opening bias ORB' },
  { id: 'iceberg', no: 9, name: 'Iceberg on an OI strike', short: 'Iceberg at OI wall' },
  { id: 'maxPain', no: 10, name: 'Expiry-day max-pain pull', short: 'Max-pain pull' },
]
export const STRATEGY_BY_ID = Object.fromEntries(STRATEGIES.map((s) => [s.id, s]))
// The playbook's own picks, used for alerts until enough trades have been scored to rank them.
export const DEFAULT_TOP5 = ['wallDefence', 'wallBreak', 'buildUp', 'openingBias', 'iceberg']

// ---- OI context -----------------------------------------------------------------------------------

function sortedSeries(points) {
  const byStrike = new Map()
  for (const p of points ?? []) {
    if (p.openInterest == null) continue
    const strike = Number(p.strike)
    if (!byStrike.has(strike)) byStrike.set(strike, [])
    byStrike.get(strike).push({ t: msOf(p.time), oi: p.openInterest })
  }
  for (const list of byStrike.values()) list.sort((a, b) => a.t - b.t)
  return byStrike
}

function valueAt(series, ms) {
  if (!series?.length || series[0].t > ms) return null
  let lo = 0
  let hi = series.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (series[mid].t <= ms) lo = mid; else hi = mid - 1
  }
  return series[lo]
}

// From an /api/oi-replay/{u}/run response (+ the day's expiry date, if known).
export function buildOiContext(run, expiryDate = null) {
  if (!run?.success) return null
  const futures = (run.futuresBars ?? []).map((b) => ({ t: msOf(b.time), close: b.close, oi: b.openInterest })).sort((a, b) => a.t - b.t)
  const spot = (run.spotCandlesOneMinute ?? run.spotCandles ?? []).map((c) => ({ t: msOf(c.time), close: c.close })).sort((a, b) => a.t - b.t)
  return {
    step: run.step || 50,
    ce: sortedSeries(run.cePoints),
    pe: sortedSeries(run.pePoints),
    futures,
    spot,
    isExpiryDay: expiryDate != null && expiryDate === run.date,
    date: run.date,
  }
}

function oiOf(map, strike, ms) {
  return valueAt(map.get(strike), ms)?.oi ?? null
}

function oiChange(map, strike, ms, minutes) {
  const now = oiOf(map, strike, ms)
  const then = oiOf(map, strike, ms - minutes * MIN)
  return now != null && then != null ? now - then : null
}

// Strike rows (CE / PE OI) as of `ms`.
function oiRows(oi, ms) {
  const strikes = new Set([...oi.ce.keys(), ...oi.pe.keys()])
  return [...strikes].sort((a, b) => a - b).map((strike) => ({ strike, ceOi: oiOf(oi.ce, strike, ms) ?? 0, peOi: oiOf(oi.pe, strike, ms) ?? 0 }))
}

export function maxPainOf(rows) {
  let best = null
  let bestPain = Infinity
  for (const c of rows) {
    let pain = 0
    for (const r of rows) pain += r.ceOi * Math.max(0, c.strike - r.strike) + r.peOi * Math.max(0, r.strike - c.strike)
    if (pain < bestPain) { bestPain = pain; best = c.strike }
  }
  return best
}

function futuresChange(oi, ms, minutes) {
  const now = valueAt(oi.futures, ms)
  const then = valueAt(oi.futures, ms - minutes * MIN)
  if (!now || !then || !then.close) return null
  return {
    pricePct: (now.close - then.close) / then.close,
    oiPct: now.oi && then.oi ? (now.oi - then.oi) / then.oi : null,
  }
}

// Walls around the index price: the biggest PUT OI strike at / below it (support) and the biggest
// CALL OI strike at / above it (resistance), within 8 strikes.
function wallsAt(oi, rows, spot) {
  const near = rows.filter((r) => Math.abs(r.strike - spot) <= 8 * oi.step)
  const below = near.filter((r) => r.strike <= spot + oi.step * 0.5)
  const above = near.filter((r) => r.strike >= spot - oi.step * 0.5)
  const support = below.reduce((a, r) => (r.peOi > (a?.peOi ?? 0) ? r : a), null)
  const resistance = above.reduce((a, r) => (r.ceOi > (a?.ceOi ?? 0) ? r : a), null)
  return { support: support?.strike ?? null, resistance: resistance?.strike ?? null }
}

// The strike with the biggest PUT (or CALL) OI ADDED since the open, as of `ms`.
function topWriting(map, ms, openMs, spot, step) {
  let best = null
  let bestAdd = 0
  for (const [strike, series] of map) {
    if (Math.abs(strike - spot) > 10 * step) continue
    const now = valueAt(series, ms)?.oi
    const open = valueAt(series, openMs)?.oi ?? series[0]?.oi
    if (now == null || open == null) continue
    if (now - open > bestAdd) { bestAdd = now - open; best = strike }
  }
  return best
}

// ---- order-flow helpers ---------------------------------------------------------------------------

export function vwapOf(minuteBars, ms) {
  let pv = 0
  let v = 0
  for (const b of minuteBars) {
    if (msOf(b.time) > ms) break
    const vol = (b.buy ?? 0) + (b.sell ?? 0)
    pv += ((b.high + b.low + b.close) / 3) * vol
    v += vol
  }
  return v > 0 ? pv / v : null
}

function tapeRead(prints, ms, lot, bigLots, lastBar) {
  if (!prints?.length) {
    // Estimated / no tape: the last minute's buy/sell split stands in for aggression.
    const total = (lastBar?.buy ?? 0) + (lastBar?.sell ?? 0)
    const pct = total > 0 ? Math.round((lastBar.buy / total) * 100) : 50
    return { agg30: pct, agg60: pct, bigBuy: 0, bigSell: 0, speedRatio: 1, proxy: true }
  }
  let b30 = 0, s30 = 0, b60 = 0, s60 = 0, n60 = 0, n300 = 0, bigBuy = 0, bigSell = 0
  for (let i = prints.length - 1; i >= 0; i--) {
    const p = prints[i]
    const t = msOf(p.time)
    if (t > ms) continue
    if (t < ms - 5 * MIN) break
    n300++
    if (t >= ms - MIN) {
      n60++
      if (p.buy) b60 += p.quantity; else s60 += p.quantity
      if (p.quantity >= bigLots * lot) { if (p.buy) bigBuy++; else bigSell++ }
      if (t >= ms - 30_000) { if (p.buy) b30 += p.quantity; else s30 += p.quantity }
    }
  }
  const pct = (b, s) => (b + s > 0 ? Math.round((b / (b + s)) * 100) : 50)
  return { agg30: pct(b30, s30), agg60: pct(b60, s60), bigBuy, bigSell, speedRatio: n300 > 0 ? n60 / (n300 / 5) : 1, proxy: false }
}

function bookShare(book) {
  const bids = (book?.bids ?? []).slice(0, 20).reduce((s, l) => s + (l.quantity ?? l[1] ?? 0), 0)
  const asks = (book?.asks ?? []).slice(0, 20).reduce((s, l) => s + (l.quantity ?? l[1] ?? 0), 0)
  return bids + asks > 0 ? bids / (bids + asks) : null
}

const recent = (items, ms, within, timeOf) => items.filter((x) => { const t = timeOf(x); return t <= ms && t >= ms - within })

// ---- evaluation -------------------------------------------------------------------------------------

/**
 * Every strategy whose checklist passes at `nowMs`. Input:
 *   nowMs, price (futures last), bars (1-minute analyzed bars, completed only), minuteBars (raw, up to now),
 *   prints (tape, oldest first, or null), book, liquidity, pullStack (signals), sweeps, icebergs,
 *   oi (buildOiContext), estimated, lotSize, bigLots.
 * Returns setups: { id, name, side, t, entry, stop, target, timeStopMs, confidence, checks: { OI, Footprint, Tape, DOM, Heatmap } }.
 */
export function evaluateStrategies(input) {
  const { nowMs, bars, minuteBars, oi, estimated } = input
  const price = input.price
  if (!oi || !bars?.length || !(price > 0)) return []
  const minute = istMinute(nowMs)
  if (minute < hm(9, 30) || minute > hm(14, 45)) return []
  const spotNow = valueAt(oi.spot, nowMs)?.close
  if (!spotNow) return []
  const basis = price - spotNow
  const rows = oiRows(oi, nowMs)
  if (!rows.length) return []
  const { support, resistance } = wallsAt(oi, rows, spotNow)
  const lot = Math.max(1, input.lotSize ?? 1)
  const last = bars.at(-1)
  const prev = bars.at(-2)
  const last3 = bars.slice(-3)
  const tape = tapeRead(input.prints, nowMs, lot, input.bigLots ?? 10, last)
  const share = estimated ? null : bookShare(input.book)
  const liq = recent(input.liquidity ?? [], nowMs, 3 * MIN, (s) => s.t)
  const ps = recent(input.pullStack ?? [], nowMs, 2 * MIN, (s) => s.t)
  const sweeps = recent(input.sweeps ?? [], nowMs, 2 * MIN, (w) => msOf(w.endedAt))
  const icebergs = (input.icebergs ?? []).filter((i) => msOf(i.detectedAt) <= nowMs && (!i.endedAt || msOf(i.endedAt) > nowMs))
  const vwap = vwapOf(minuteBars, nowMs)
  const pct = (v) => price * v
  const out = []

  const confirm = (dir, extraHeat = false) => {
    if (estimated) return { ok: true, dom: 'waived (estimated day)', heat: 'waived (estimated day)' }
    const domOk = share != null && (dir > 0 ? share >= 0.5 : share <= 0.5)
    const heatOk = extraHeat || ps.some((s) => s.bullish === dir > 0) || liq.some((s) => s.bullish === dir > 0)
    const domAgainst = share != null && (dir > 0 ? share < 0.4 : share > 0.6)
    const heatAgainst = ps.some((s) => s.bullish !== dir > 0 && s.confidence >= 70)
    return {
      ok: (domOk || heatOk) && !domAgainst && !heatAgainst,
      dom: share == null ? 'no book' : `bids ${Math.round(share * 100)}% of the book`,
      heat: heatOk ? 'liquidity on your side' : heatAgainst ? 'liquidity against' : 'neutral',
    }
  }
  const tapeText = `${tape.proxy ? 'est. ' : ''}aggression 30s ${tape.agg30}% / 1m ${tape.agg60}% buy`
  const push = (id, dir, stopPts, targetPts, timeStopMin, confidence, checks) => {
    if (!(stopPts > 0) || !(targetPts > 0)) return
    const timeStop = Math.min(nowMs + timeStopMin * MIN, nowMs + (EOD - minute) * MIN)
    out.push({
      id, name: STRATEGY_BY_ID[id].name, side: dir > 0 ? 'LONG' : 'SHORT', t: nowMs, entry: price,
      stop: price - dir * stopPts, target: price + dir * targetPts, timeStopMs: timeStop,
      confidence: Math.round(Math.max(40, Math.min(92, confidence))), estimated: !!estimated, checks,
    })
  }
  const absorbed = (dir) => last3.some((b) => (b.absorption ?? []).some((a) => (a.side === 'buy') === dir > 0))
  const exhausted = (dir) => last3.some((b) => (b.exhaustion ?? []).some((e) => (e.side === 'buy') === dir > 0))
  const stackWith = (dir, n = 3) => bars.slice(-n).some((b) => (b.stacked ?? []).some((z) => (z.side === 'buy') === dir > 0))
  const stackAgainst = (dir, n = 3) => stackWith(-dir, n)
  const sweepWith = (dir) => sweeps.some((w) => w.buy === dir > 0)
  const aggWith = (dir, level, which = 'agg60') => (dir > 0 ? tape[which] >= level : tape[which] <= 100 - level)
  const cvdNewExtreme = (dir, n = 15) => {
    const window = bars.slice(-n - 1, -1)
    if (!window.length) return false
    return dir > 0 ? last.cvd >= Math.max(...window.map((b) => b.cvd)) : last.cvd <= Math.min(...window.map((b) => b.cvd))
  }

  // 1. OI wall defence - 09:45-14:30.
  if (minute >= hm(9, 45) && minute <= hm(14, 30)) {
    for (const dir of [1, -1]) {
      const wall = dir > 0 ? support : resistance
      const other = dir > 0 ? resistance : support
      if (wall == null || other == null) continue
      const nearWall = dir > 0 ? spotNow - wall <= spotNow * 0.0012 && spotNow - wall >= -spotNow * 0.0005 : wall - spotNow <= spotNow * 0.0012 && wall - spotNow >= -spotNow * 0.0005
      const wallChg = oiChange(dir > 0 ? oi.pe : oi.ce, wall, nowMs, 15)
      if (!nearWall || !(wallChg > 0)) continue
      const stopPts = Math.max(pct(0.001), Math.abs(spotNow - wall) + pct(0.0008))
      const room = Math.abs(other - spotNow)
      if (room < 1.5 * stopPts) continue
      const footprint = (absorbed(dir) || liq.some((s) => s.kind === 'Wall absorption' && s.bullish === dir > 0)) && dir * last.delta > 0 && !stackAgainst(dir)
      const tapeOk = aggWith(dir, 55, 'agg30') && !sweepWith(-dir)
      const c = confirm(dir)
      if (!footprint || !tapeOk || !c.ok) continue
      push('wallDefence', dir, stopPts, Math.min(room * 0.8, 2.5 * stopPts), 45, 62 + (tape.proxy ? 0 : 5) + (absorbed(dir) ? 8 : 0), {
        OI: `${dir > 0 ? 'PUT' : 'CALL'} wall ${wall} (OI +${Math.round(wallChg).toLocaleString('en-IN')} in 15m), other wall ${other}`,
        Footprint: `${absorbed(dir) ? 'absorption' : 'wall absorption'}, last bar Δ ${last.delta > 0 ? '+' : ''}${last.delta}`, Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
      })
    }
  }

  // 2. OI wall break - writers run - 09:30-14:30.
  if (minute <= hm(14, 30)) {
    for (const dir of [1, -1]) {
      const wall = dir > 0 ? resistance : support
      if (wall == null) continue
      const broke = dir > 0 ? spotNow > wall && prev && prev.close - basis <= wall + oi.step * 0.6 : spotNow < wall && prev && prev.close - basis >= wall - oi.step * 0.6
      const wallChg = oiChange(dir > 0 ? oi.ce : oi.pe, wall, nowMs, 20)
      const otherWall = dir > 0 ? support : resistance
      const otherChg = otherWall != null ? oiChange(dir > 0 ? oi.pe : oi.ce, otherWall, nowMs, 20) : null
      if (!broke || !(wallChg < 0) || !(otherChg > 0)) continue
      const footprint = dir * last.delta > 0 && (stackWith(dir, 2) || cvdNewExtreme(dir))
      const tapeOk = (sweepWith(dir) || aggWith(dir, 65)) && aggWith(dir, 60)
      const c = confirm(dir, liq.some((s) => s.kind === 'Spoofing' && s.bullish === dir > 0))
      if (!footprint || !tapeOk || !c.ok) continue
      const stopPts = pct(0.0015)
      push('wallBreak', dir, stopPts, 2 * stopPts, 45, 60 + (sweepWith(dir) ? 12 : 0) + (stackWith(dir, 2) ? 6 : 0), {
        OI: `${dir > 0 ? 'CALL' : 'PUT'} wall ${wall} broken, its OI ${Math.round(wallChg).toLocaleString('en-IN')} in 20m (writers covering)`,
        Footprint: `${stackWith(dir, 2) ? 'stacked imbalance' : 'ΣΔ new extreme'}, Δ ${last.delta}`, Tape: `${sweepWith(dir) ? 'sweep · ' : ''}${tapeText}`, DOM: c.dom, Heatmap: c.heat,
      })
    }
  }

  // 3. Writer migration - 10:00-14:30.
  if (minute >= hm(10, 0) && minute <= hm(14, 30) && vwap != null) {
    const openMs = nowMs - (minute - hm(9, 15)) * MIN
    for (const dir of [1, -1]) {
      const map = dir > 0 ? oi.pe : oi.ce
      const nowTop = topWriting(map, nowMs, openMs, spotNow, oi.step)
      const thenTop = topWriting(map, nowMs - 45 * MIN, openMs, spotNow, oi.step)
      if (nowTop == null || thenTop == null || dir * (nowTop - thenTop) < oi.step) continue
      if (dir * (price - vwap) <= 0) continue
      const pulledBack = prev && dir * prev.delta < 0 && dir * last.delta > 0
      const footprint = stackWith(dir, 10) && pulledBack && !stackAgainst(dir, 2)
      const tapeOk = aggWith(dir, 55, 'agg30')
      const c = confirm(dir, icebergs.some((i) => i.isBid === dir > 0))
      if (!footprint || !tapeOk || !c.ok) continue
      const stopPts = pct(0.0015)
      push('migration', dir, stopPts, 2 * stopPts, 60, 62, {
        OI: `${dir > 0 ? 'PUT' : 'CALL'} writing moved ${thenTop} → ${nowTop} in 45m`, Footprint: 'trend stack + pullback bar turned', Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
      })
    }
  }

  // 4 / 5. Short-covering squeeze (long) / long-unwinding flush (short) - 10:00-14:45.
  if (minute >= hm(10, 0)) {
    const f = futuresChange(oi, nowMs, 10)
    for (const dir of [1, -1]) {
      if (!f || f.oiPct == null || !(dir * f.pricePct > 0.001) || !(f.oiPct < -0.001)) continue
      const wall = dir > 0 ? resistance : support
      const wallChg = wall != null ? oiChange(dir > 0 ? oi.ce : oi.pe, wall, nowMs, 10) : null
      if (wallChg != null && wallChg > 0) continue
      const footprint = dir * last.delta > 0 && prev && dir * prev.delta > 0 && !exhausted(-dir)
      const tapeOk = aggWith(dir, 70) && (sweepWith(dir) || tape.speedRatio >= 1.5 || tape.proxy)
      const c = confirm(dir)
      if (!footprint || !tapeOk || !c.ok) continue
      const stopPts = pct(0.0012)
      push(dir > 0 ? 'squeeze' : 'flush', dir, stopPts, 1.3 * stopPts, 20, 58 + (sweepWith(dir) ? 10 : 0), {
        OI: `futures ${dir > 0 ? '+' : ''}${(f.pricePct * 100).toFixed(2)}% with OI ${(f.oiPct * 100).toFixed(2)}% (${dir > 0 ? 'short covering' : 'long unwinding'})`,
        Footprint: 'two bars of Δ with the move, no exhaustion', Tape: `${sweepWith(dir) ? 'sweep · ' : ''}${tapeText}`, DOM: c.dom, Heatmap: c.heat,
      })
    }
  }

  // 6. Fresh build-up trend - 10:00-14:45.
  if (minute >= hm(10, 0) && vwap != null) {
    const f = futuresChange(oi, nowMs, 30)
    for (const dir of [1, -1]) {
      if (!f || f.oiPct == null || !(dir * f.pricePct > 0.0015) || !(f.oiPct > 0.003)) continue
      const nearVwap = dir * (price - vwap) >= 0 && Math.abs(price - vwap) <= pct(0.0008)
      if (!nearVwap) continue
      const footprint = (absorbed(dir) || stackWith(dir)) && dir * last.delta > 0
      const tapeOk = aggWith(dir, 55, 'agg30')
      const c = confirm(dir)
      if (!footprint || !tapeOk || !c.ok) continue
      const stopPts = Math.abs(price - vwap) + pct(0.0008)
      push('buildUp', dir, stopPts, 2.5 * stopPts, 60, 64 + (absorbed(dir) ? 6 : 0), {
        OI: `futures ${(f.pricePct * 100).toFixed(2)}% with OI +${(f.oiPct * 100).toFixed(2)}% in 30m (${dir > 0 ? 'long' : 'short'} build-up)`,
        Footprint: `pullback to VWAP ${vwap.toFixed(1)} with ${absorbed(dir) ? 'absorption' : 'a stack'}`, Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
      })
    }
  }

  // 7. Range between two growing walls - 10:30-14:30.
  if (minute >= hm(10, 30) && minute <= hm(14, 30) && support != null && resistance != null && resistance > support) {
    const f = futuresChange(oi, nowMs, 30)
    const sChg = oiChange(oi.pe, support, nowMs, 30)
    const rChg = oiChange(oi.ce, resistance, nowMs, 30)
    if (f && Math.abs(f.pricePct) < 0.0015 && sChg > 0 && rChg > 0) {
      for (const dir of [1, -1]) {
        const edge = dir > 0 ? support : resistance
        if (Math.abs(spotNow - edge) > spotNow * 0.0012) continue
        const footprint = (exhausted(dir > 0 ? 1 : -1) || absorbed(dir)) && !stackAgainst(dir, 2)
        const tapeOk = dir > 0 ? tape.agg60 >= 45 : tape.agg60 <= 55
        const c = confirm(dir, liq.some((s) => s.kind === 'Exhaustion into wall' && s.bullish === dir > 0))
        if (!footprint || !tapeOk || !c.ok) continue
        const stopPts = Math.abs(spotNow - edge) + pct(0.0008)
        const mid = (support + resistance) / 2
        push('range', dir, stopPts, Math.max(stopPts * 1.2, Math.abs(mid - spotNow)), 45, 58, {
          OI: `both walls growing: PUT ${support} +${Math.round(sChg).toLocaleString('en-IN')}, CALL ${resistance} +${Math.round(rChg).toLocaleString('en-IN')} in 30m`,
          Footprint: 'exhaustion / absorption at the edge', Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
        })
      }
    }
  }

  // 8. Opening OI bias + range breakout - 09:30-11:00, first break only (the caller's cooldown).
  if (minute <= hm(11, 0)) {
    const dayOpen = nowMs - (minute - hm(9, 15)) * MIN
    const rangeEnd = dayOpen + 15 * MIN
    const openBars = minuteBars.filter((b) => msOf(b.time) >= dayOpen && msOf(b.time) < rangeEnd)
    if (openBars.length >= 10) {
      const hi = Math.max(...openBars.map((b) => b.high))
      const lo = Math.min(...openBars.map((b) => b.low))
      const atm = Math.round(valueAt(oi.spot, rangeEnd)?.close / oi.step) * oi.step
      let bias = 0
      for (let k = -3; k <= 3; k++) {
        const strike = atm + k * oi.step
        bias += (oiChange(oi.pe, strike, rangeEnd, 15) ?? 0) - (oiChange(oi.ce, strike, rangeEnd, 15) ?? 0)
      }
      const dir = Math.sign(bias)
      const broke = dir > 0 ? last.close > hi && (prev?.close ?? hi) <= hi : dir < 0 && last.close < lo && (prev?.close ?? lo) >= lo
      if (dir !== 0 && broke) {
        const footprint = dir * last.delta > 0
        const tapeOk = sweepWith(dir) || aggWith(dir, 65)
        const c = confirm(dir)
        if (footprint && tapeOk && c.ok) {
          const stopPts = Math.max(pct(0.001), Math.min(pct(0.0035), Math.abs(price - (hi + lo) / 2)))
          push('openingBias', dir, stopPts, 2 * stopPts, 60, 60 + (sweepWith(dir) ? 10 : 0), {
            OI: `09:15-09:30 ${dir > 0 ? 'put' : 'call'} writing led near ATM (net ${Math.round(bias).toLocaleString('en-IN')})`,
            Footprint: `close beyond the opening range ${lo}-${hi}, Δ ${last.delta}`, Tape: `${sweepWith(dir) ? 'sweep · ' : ''}${tapeText}`, DOM: c.dom, Heatmap: c.heat,
          })
        }
      }
    }
  }

  // 9. Iceberg on an OI strike - any time in the window; exact days only.
  if (!estimated) {
    for (const ice of icebergs) {
      const dir = ice.isBid ? 1 : -1
      const wall = dir > 0 ? support : resistance
      if (wall == null) continue
      if (Math.abs(ice.price - (wall + basis)) > price * 0.0015 || Math.abs(price - ice.price) > price * 0.001) continue
      const wallChg = oiChange(dir > 0 ? oi.pe : oi.ce, wall, nowMs, 15)
      if (!(wallChg > 0)) continue
      const footprint = dir * last.delta > 0
      const tapeOk = aggWith(dir, 50, 'agg30')
      if (!footprint || !tapeOk) continue
      const stopPts = Math.abs(price - ice.price) + pct(0.001)
      push('iceberg', dir, stopPts, 2 * stopPts, 45, 66, {
        OI: `${dir > 0 ? 'PUT' : 'CALL'} wall ${wall} (OI +${Math.round(wallChg).toLocaleString('en-IN')} in 15m)`,
        Footprint: `Δ ${last.delta} turning`, Tape: tapeText, DOM: `iceberg at ${ice.price} (${ice.refills} refills)`, Heatmap: 'iceberg active',
      })
    }
  }

  // 10. Expiry-day max-pain pull - 13:00-14:30 entries.
  if (oi.isExpiryDay && minute >= hm(13, 0) && minute <= hm(14, 30)) {
    const mp = maxPainOf(rows.filter((r) => Math.abs(r.strike - spotNow) <= 15 * oi.step))
    if (mp != null && Math.abs(mp - spotNow) >= spotNow * 0.003) {
      const dir = mp > spotNow ? 1 : -1
      const drift = bars.length > 10 ? last.cvd - bars.at(-11).cvd : 0
      const footprint = dir * drift > 0 && !stackAgainst(dir, 5)
      const tapeOk = aggWith(dir, 60)
      const c = confirm(dir, liq.some((s) => s.kind === 'Magnet' && s.bullish === dir > 0))
      if (footprint && tapeOk && c.ok) {
        const stopPts = pct(0.0015)
        const timeLeft = hm(14, 55) - minute
        push('maxPain', dir, stopPts, Math.abs(mp - spotNow) * 0.8, timeLeft, 56, {
          OI: `expiry day, max pain ${mp} vs index ${spotNow.toFixed(0)}`, Footprint: 'ΣΔ drifting toward max pain', Tape: tapeText, DOM: c.dom, Heatmap: c.heat,
        })
      }
    }
  }
  return out
}

// ---- outcome --------------------------------------------------------------------------------------

/** What happened after a setup, from the minute bars up to `untilMs`: stop first if a bar touches both.
 *  `dayOver`: the day's data is complete (a scanned past day) - a trade still running when it ends is
 *  closed at the last price, like the 15:10 exit. */
export function simulateOutcome(setup, minuteBars, untilMs, dayOver = false) {
  const dir = setup.side === 'LONG' ? 1 : -1
  const risk = Math.abs(setup.entry - setup.stop)
  const rTarget = Math.abs(setup.target - setup.entry) / risk
  let mfe = 0
  let lastClose = setup.entry
  for (const b of minuteBars) {
    const t = msOf(b.time)
    if (t <= setup.t) continue
    if (t + MIN > untilMs) return { status: 'open', r: (dir * (lastClose - setup.entry)) / risk, mfe }
    const adverse = dir > 0 ? b.low <= setup.stop : b.high >= setup.stop
    const favourable = dir > 0 ? b.high >= setup.target : b.low <= setup.target
    mfe = Math.max(mfe, (dir * ((dir > 0 ? b.high : b.low) - setup.entry)) / risk)
    if (adverse) return { status: 'loss', r: -1, mfe, exitAt: t }
    if (favourable) return { status: 'win', r: rTarget, mfe, exitAt: t }
    lastClose = b.close
    if (t + MIN >= setup.timeStopMs) {
      const r = (dir * (b.close - setup.entry)) / risk
      return { status: r > 0 ? 'win' : 'loss', r, mfe, exitAt: t, timeStop: true }
    }
  }
  const r = (dir * (lastClose - setup.entry)) / risk
  return dayOver ? { status: r > 0 ? 'win' : 'loss', r, mfe, timeStop: true } : { status: 'open', r, mfe }
}

// ---- scoring --------------------------------------------------------------------------------------

export function strategyStats(trades) {
  const by = Object.fromEntries(STRATEGIES.map((s) => [s.id, { id: s.id, trades: 0, wins: 0, totalR: 0, bestR: 0, grossWin: 0, grossLoss: 0 }]))
  for (const t of trades) {
    const s = by[t.id]
    if (!s || t.outcome?.status === 'open' || !t.outcome) continue
    s.trades++
    s.totalR += t.outcome.r
    s.bestR = Math.max(s.bestR, t.outcome.r)
    if (t.outcome.r > 0) { s.wins++; s.grossWin += t.outcome.r } else s.grossLoss += -t.outcome.r
  }
  return STRATEGIES.map((meta) => {
    const s = by[meta.id]
    const winRate = s.trades ? s.wins / s.trades : null
    const avgR = s.trades ? s.totalR / s.trades : null
    // Rank: expectancy (average R per trade) - win rate and size of wins together - shrunk toward 0
    // for a small sample so three lucky trades do not top the table.
    const score = s.trades ? avgR * (s.trades / (s.trades + 5)) : null
    return { ...meta, ...s, winRate, avgR, profitFactor: s.grossLoss > 0 ? s.grossWin / s.grossLoss : s.grossWin > 0 ? Infinity : null, score }
  })
}

export const MIN_TRADES_TO_RANK = 5

/** The five strategies to alert on: the best-scoring PROFITABLE ones once enough trades are scored,
 *  topped up with the playbook's picks that have not been measured yet - never a strategy whose
 *  scored trades lose money on average. */
export function topFive(stats) {
  const ranked = stats.filter((s) => s.trades >= MIN_TRADES_TO_RANK && s.score > 0).sort((a, b) => b.score - a.score)
  const losers = new Set(stats.filter((s) => s.trades >= MIN_TRADES_TO_RANK && !(s.score > 0)).map((s) => s.id))
  const ids = ranked.slice(0, 5).map((s) => s.id)
  for (const id of DEFAULT_TOP5) if (ids.length < 5 && !ids.includes(id) && !losers.has(id)) ids.push(id)
  return { ids, measured: ranked.length >= 5 }
}
