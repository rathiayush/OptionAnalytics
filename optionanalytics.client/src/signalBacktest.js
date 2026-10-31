// The SIGNAL BACKTEST (the Signal backtest page): past days replayed minute by minute through buy / sell signals read
// from what the OI Replay page and the Volume & Market Profile page show - OI since the open, the OI totals' cumulative
// Δ breaks (and the 🎯 high-probability signal), the OI support / resistance walls, GEX, VWAP, the ATM straddle, the
// Initial Balance and the developing volume profile - each strategy's signal turned into an option trade (BUY the call /
// put in the signal's direction, or SELL the put / call against it) and the trades summed up per strategy.
//
// Two steps, so a change of settings re-runs in an instant:
//   prepareDay(run)       - the day's features at every minute, each from data up to the END of that minute only (a
//                           point / bar stamped at a minute's start holds its close): nothing after a minute is known at
//                           it. Kept per day (compact - the option bars as typed arrays, ~0.5 MB a day).
//   simulateDay(day, s)   - each strategy's signals and their trades under the settings `s`.
//
// NO LOOK-AHEAD: a signal at minute i is read from the features of minutes <= i; the trade enters at minute i's option
// close (the last finished minute's premium) and is managed from minute i + 1 on the option's own 1-minute bars: a bar
// opening through the stop fills at its open, the stop before the target in the same bar, the target at the target; a
// time stop and the 15:10 square-off at the bar's close. No entry before 09:30 or after 14:45. `tests/signal-backtest.test.mjs`.
//
// It is a backtest of fixed rules, not a tuning: the rules below are what each strategy is.

import { chainOiTotalsAt } from './chainOiTotals.js'
import { oiWalls } from './marketRead.js'
import {
  IST_OFFSET_SECONDS, breakMeaning, changesFromLevels, completedLevelReads, newBreakWatch, newHighProbabilityWatch, perStrikeLevels,
  watchBreaks, watchHighProbability,
} from './oiLevelBreaks.js'
import { buildOiTotalsRows } from './oiTotalsHeatmap.js'
import { gexDay } from './gex.js'
import { straddleRead } from './straddle.js'
import { PROFILE_ROWS } from './profileZones.js'
import { tradeCharges } from './tradeCharges.js'

const MIN = 60_000
const DAY = 24 * 60 * MIN
const IST_MS = 330 * MIN
const STALE_MINUTES = 5
const SESSION_FIRST = 9 * 60 + 15     // 09:15
const SESSION_LAST = 15 * 60 + 29     // 15:29
const IB_LAST = 10 * 60 + 14          // the Initial Balance: 09:15 - 10:14 (the first hour)

const msOf = (t) => (typeof t === 'number' ? t : Date.parse(t))
const minuteOf = (ms) => Math.floor(ms / MIN) * MIN
/** Minutes since IST midnight of `ms`. */
export const istMinute = (ms) => Math.floor((((ms + IST_MS) % DAY) + DAY) % DAY / MIN)
const hhmm = (minute) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
/** "HH:mm" -> minutes since midnight. */
export const clockMinute = (text) => {
  const [h, m] = String(text ?? '').split(':').map(Number)
  return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : null
}

// ---- The day's features -------------------------------------------------------------------------------------------

// Each strike's option bars keyed by minute (a later point of the same minute is the newer reading).
function legsByStrike(points) {
  const byStrike = new Map()
  for (const p of points ?? []) {
    if (!p || !Number.isFinite(p.strike) || !(p.price > 0)) continue
    const t = minuteOf(msOf(p.time))
    if (!Number.isFinite(t)) continue
    let m = byStrike.get(p.strike)
    if (!m) byStrike.set(p.strike, m = new Map())
    m.set(t, { o: p.open > 0 ? p.open : p.price, h: p.high > 0 ? p.high : p.price, l: p.low > 0 ? p.low : p.price, c: p.price, oi: p.openInterest ?? null })
  }
  return byStrike
}

/** A side's bars as one Float64Array per strike: [o, h, l, c] per minute of `times`, NaN where the minute has none. */
function packBars(byStrike, times) {
  const out = new Map()
  for (const [strike, minutes] of byStrike) {
    const a = new Float64Array(times.length * 4).fill(NaN)
    times.forEach((t, i) => {
      const b = minutes.get(t)
      if (b) { a[i * 4] = b.o; a[i * 4 + 1] = b.h; a[i * 4 + 2] = b.l; a[i * 4 + 3] = b.c }
    })
    out.set(strike, a)
  }
  return out
}

// A developing volume profile, one minute at a time: each bar's volume spread over the rows of its range; POC / VAH / VAL
// (70% value area grown from the POC, the bigger neighbour first).
function developingProfile(rowSize) {
  const rows = new Map()
  let total = 0
  return {
    add(bar) {
      const v = bar.volume
      if (!(v > 0) || !(bar.high >= bar.low) || !(bar.low > 0)) return
      const bottom = Math.floor(bar.low / rowSize + 1e-9)
      const top = Math.floor(bar.high / rowSize + 1e-9)
      const share = v / (top - bottom + 1)
      for (let r = bottom; r <= top; r++) rows.set(r, (rows.get(r) ?? 0) + share)
      total += v
    },
    read() {
      if (!(total > 0)) return null
      const keys = [...rows.keys()].sort((a, b) => a - b)
      let poc = keys[0]
      for (const k of keys) if (rows.get(k) > rows.get(poc)) poc = k
      let lo = keys.indexOf(poc), hi = lo, inside = rows.get(poc)
      while (inside < total * 0.7 && (lo > 0 || hi < keys.length - 1)) {
        const below = lo > 0 ? rows.get(keys[lo - 1]) : -1
        const above = hi < keys.length - 1 ? rows.get(keys[hi + 1]) : -1
        if (above >= below) inside += rows.get(keys[++hi]); else inside += rows.get(keys[--lo])
      }
      return { poc: (poc + 0.5) * rowSize, vah: (keys[hi] + 1) * rowSize, val: keys[lo] * rowSize }
    },
  }
}

/**
 * The day's features at every session minute - each from what was known at the END of that minute. `run`: the OI
 * Replay run (`/api/oi-replay/{u}/run` - spotCandlesOneMinute, cePoints / pePoints, futuresBars, spotVwap, step,
 * optionExpiry). Returns `{ ok: true, date, underlying, step, n, t, spot, price, priceSource, vwap, oi, breaks, hp,
 * walls, gex, straddle, ib, profile, atm, ce, pe, netCum }` - or `{ ok: false, reason }`.
 */
export function prepareDay(run, { underlying = null } = {}) {
  const u = String(underlying ?? run?.underlying ?? '').toUpperCase()
  const session = (ms) => { const m = istMinute(ms); return m >= SESSION_FIRST && m <= SESSION_LAST }
  const spotBars = (run?.spotCandlesOneMinute ?? [])
    .map((b) => ({ t: minuteOf(msOf(b.time)), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume ?? 0 }))
    .filter((b) => Number.isFinite(b.t) && b.c > 0 && session(b.t))
    .sort((a, b) => a.t - b.t)
    .filter((b, i, all) => i === 0 || b.t !== all[i - 1].t)
  if (spotBars.length < 30) return { ok: false, reason: 'not enough spot minutes for the day' }
  const n = spotBars.length
  const t = spotBars.map((b) => b.t)
  const date = new Date(t[0] + IST_MS).toISOString().slice(0, 10)

  // The price the VWAP / profile / Initial Balance are read on: the futures (they carry volume) when they cover the day,
  // else the index (its own VWAP from the server, when it had volume).
  const fut = new Map()
  for (const b of run?.futuresBars ?? []) {
    const ms = minuteOf(msOf(b.time))
    if (Number.isFinite(ms) && b.close > 0 && session(ms)) fut.set(ms, b)
  }
  const useFutures = fut.size >= n * 0.8
  const priceBars = []
  let lastFut = null
  for (let i = 0; i < n; i++) {
    if (useFutures) {
      const f = fut.get(t[i])
      if (f) lastFut = { o: f.open, h: f.high, l: f.low, c: f.close, v: f.volume ?? 0 }
      priceBars.push(lastFut ?? { o: spotBars[i].o, h: spotBars[i].h, l: spotBars[i].l, c: spotBars[i].c, v: 0 })
    } else {
      const s = spotBars[i]
      priceBars.push({ o: s.o, h: s.h, l: s.l, c: s.c, v: s.v })
    }
  }
  const vwap = new Float64Array(n).fill(NaN)
  if (useFutures) {
    let pv = 0, vol = 0
    for (let i = 0; i < n; i++) {
      const b = fut.get(t[i])
      if (b && b.volume > 0) { pv += ((b.high + b.low + b.close) / 3) * b.volume; vol += b.volume }
      if (vol > 0) vwap[i] = pv / vol
    }
  } else {
    const points = (run?.spotVwap ?? []).map((p) => ({ t: minuteOf(msOf(p.time)), v: p.obv ?? p.value })).filter((p) => p.v > 0).sort((a, b) => a.t - b.t)
    let k = 0, last = NaN
    for (let i = 0; i < n; i++) {
      while (k < points.length && points[k].t <= t[i]) last = points[k++].v
      vwap[i] = last
    }
  }

  // Options.
  const ceLegs = legsByStrike(run?.cePoints)
  const peLegs = legsByStrike(run?.pePoints)
  const strikes = [...new Set([...ceLegs.keys(), ...peLegs.keys()])].sort((a, b) => a - b)
  let step = run?.step > 0 ? run.step : null
  if (!step) for (let k = 1; k < strikes.length; k++) { const d = strikes[k] - strikes[k - 1]; if (d > 0 && (step == null || d < step)) step = d }
  if (!step || !strikes.length) return { ok: false, reason: 'no option data for the day' }
  const atm = t.map((_, i) => Math.round(spotBars[i].c / step) * step)

  // OI since the open, chain-wide (a strike joining the band later counts from its first reading - chainOiTotals.js).
  const byStrikeSeries = (legs) => new Map([...legs].map(([k, minutes]) => [k, [...minutes].sort((a, b) => a[0] - b[0])
    .filter(([, b]) => Number.isFinite(b.oi)).map(([ms, b]) => ({ ms, openInterest: b.oi }))]))
  const ceSeries = byStrikeSeries(ceLegs)
  const peSeries = byStrikeSeries(peLegs)
  const totals = chainOiTotalsAt(ceSeries, peSeries, t[0], t)
  const oi = totals.map((x) => ({ ce: x.ce - totals[0].ce, pe: x.pe - totals[0].pe }))

  // The OI totals' cumulative Δ breaks (CE / PE / Net) and the 🎯 high-probability signal, stepped minute by minute on
  // the completed 1-minute buckets (the OI Replay page's own step, `oiLevelBreaks.js`).
  const levelSeries = (series) => new Map([...series].map(([k, list]) => [k, list.map((p) => ({ t: p.ms, oi: p.openInterest }))]))
  const ceLevels = perStrikeLevels(levelSeries(ceSeries), 60)
  const peLevels = perStrikeLevels(levelSeries(peSeries), 60)
  const oiTotals = buildOiTotalsRows(changesFromLevels(ceLevels), changesFromLevels(peLevels))
  const breakWatch = newBreakWatch()
  const hpWatch = newHighProbabilityWatch()
  const breaks = []
  const hp = []
  const netCum = new Float64Array(n).fill(NaN)
  for (let i = 0; i < n; i++) {
    const nowSec = Math.floor(t[i] / 1000) + IST_OFFSET_SECONDS + 60     // the end of minute i
    const reads = completedLevelReads(oiTotals, 60, nowSec)
    if (!reads) continue
    netCum[i] = oiTotals.rows.netCum.get(reads.last) ?? NaN
    const fresh = watchBreaks(breakWatch, reads, 60)
    for (const b of fresh) breaks.push({ i, dir: breakMeaning(b.side.key, b.up), text: `OI ${b.side.label} cumulative Δ broke ${b.up ? 'above resistance' : 'below support'} (${b.up ? b.side.up : b.side.down})` })
    const signals = watchHighProbability(hpWatch, fresh, { totals: oiTotals, ceLevels, peLevels, last: reads.last, atmStrike: atm[i], bucketSeconds: 60 })
    for (const s of signals) hp.push({ i, dir: s.hp.bullish ? 1 : -1, text: `🎯 ${s.hp.bullish ? 'bullish' : 'bearish'}: OI ${s.b.side.label} break + ${s.hp.side} OI at ATM ± 1 ${s.hp.pct >= 0 ? '+' : ''}${s.hp.pct.toFixed(0)}%` })
  }

  // The OI walls (the spot chart's S-R): the most call OI at or above spot, the most put OI at or below it - the strikes'
  // latest OI at the end of each minute.
  const walls = []
  {
    const cursors = strikes.map((k) => ({ k, ce: [...(ceLegs.get(k) ?? new Map())].sort((a, b) => a[0] - b[0]), pe: [...(peLegs.get(k) ?? new Map())].sort((a, b) => a[0] - b[0]), ci: 0, pi: 0, ceOi: null, peOi: null }))
    for (let i = 0; i < n; i++) {
      for (const c of cursors) {
        while (c.ci < c.ce.length && c.ce[c.ci][0] <= t[i]) { const v = c.ce[c.ci++][1].oi; if (Number.isFinite(v)) c.ceOi = v }
        while (c.pi < c.pe.length && c.pe[c.pi][0] <= t[i]) { const v = c.pe[c.pi++][1].oi; if (Number.isFinite(v)) c.peOi = v }
      }
      const { resistance, support } = oiWalls(cursors.map((c) => ({ strike: c.k, ceOi: c.ceOi ?? 0, peOi: c.peOi ?? 0 })), spotBars[i].c)
      walls.push({ resistance: resistance?.strike ?? null, support: support?.strike ?? null })
    }
  }

  // GEX (standard sign) - each minute from readings up to it (gex.js).
  const spotForOptions = spotBars.map((b) => ({ time: b.t, close: b.c }))
  const gexByMinute = new Map(gexDay(run?.cePoints, run?.pePoints, spotForOptions, { expiry: run?.optionExpiry ?? null, flips: false }).map((m) => [m.time, m]))
  const gex = t.map((ms) => {
    const m = gexByMinute.get(ms)
    return m ? { net: m.net, callWall: m.callWall, putWall: m.putWall } : null
  })

  // The Auto ATM straddle against its VWAP, its decay-only line and the synthetic futures (straddle.js).
  const read = straddleRead(run?.cePoints, run?.pePoints, spotForOptions, { expiry: run?.optionExpiry ?? null })
  const straddleByMinute = new Map((read?.series ?? []).map((p) => [p.time, p]))
  const straddle = t.map((ms) => {
    const p = straddleByMinute.get(ms)
    return p ? { value: p.value, vwap: p.vwap, decay: p.decay, forward: p.forward } : null
  })

  // The Initial Balance (09:15 - 10:14) and the developing volume profile, on the price series.
  let ibHigh = -Infinity, ibLow = Infinity, ibDone = null
  const rowSize = PROFILE_ROWS[u] ?? Math.max(1, Math.round(step / 10))
  const vp = developingProfile(rowSize)
  const profile = []
  for (let i = 0; i < n; i++) {
    const b = priceBars[i]
    const m = istMinute(t[i])
    if (m <= IB_LAST) { ibHigh = Math.max(ibHigh, b.h); ibLow = Math.min(ibLow, b.l); if (m === IB_LAST) ibDone = i }
    vp.add({ high: b.h, low: b.l, volume: b.v })
    profile.push(vp.read())
  }

  return {
    ok: true, date, underlying: u, step, n, t, atm, oi, breaks, hp, walls, gex, straddle, profile, netCum,
    spot: { o: spotBars.map((b) => b.o), h: spotBars.map((b) => b.h), l: spotBars.map((b) => b.l), c: spotBars.map((b) => b.c) },
    price: { o: priceBars.map((b) => b.o), h: priceBars.map((b) => b.h), l: priceBars.map((b) => b.l), c: priceBars.map((b) => b.c) },
    priceSource: useFutures ? 'futures' : 'spot', vwap: Array.from(vwap),
    straddleWidth: read?.day?.width ?? null,
    ib: ibDone == null ? null : { high: ibHigh, low: ibLow, done: ibDone },
    ce: packBars(ceLegs, t), pe: packBars(peLegs, t),
  }
}

// ---- The strategies -------------------------------------------------------------------------------------------------
// Each reads the day's features up to minute i and says +1 (bullish), -1 (bearish) or 0, with why. A condition that stays
// true signals once - on the minute it BECOMES true (`edges`) - so a strategy does not fire every minute of a trend.

const above = (d, i) => (Number.isFinite(d.vwap[i]) ? Math.sign(d.price.c[i] - d.vwap[i]) : 0)
const oiBias = (d, i) => {
  const { ce, pe } = d.oi[i]
  const size = Math.abs(ce) + Math.abs(pe)
  return size > 0 ? (pe - ce) / size : 0
}
const fmtL = (v) => `${v >= 0 ? '+' : '−'}${(Math.abs(v) / 1e5).toFixed(1)}L`

/** The minutes where `cond(i)` (a direction, or { dir, why }) becomes non-zero or flips. */
function edges(d, cond, from = 0) {
  const out = []
  let prev = 0
  for (let i = from; i < d.n; i++) {
    const r = cond(i)
    const dir = typeof r === 'number' ? r : r?.dir ?? 0
    if (dir !== 0 && dir !== prev) out.push({ i, dir, why: typeof r === 'object' ? r.why : '' })
    prev = dir
  }
  return out
}

const sideWord = (dir) => (dir > 0 ? 'bullish' : 'bearish')

export const SIGNAL_STRATEGIES = [
  {
    id: 'dayOi', name: 'OI since open + VWAP',
    rule: 'Chain-wide OI added since 09:15: put writing beats call writing by 25% of the OI added (PE added − CE added ≥ 0.25 × both) with price above VWAP = bullish; call writing ahead and price below VWAP = bearish. From 09:45 (enough OI to read).',
    signals: (d) => edges(d, (i) => {
      if (istMinute(d.t[i]) < 9 * 60 + 45) return 0
      const b = oiBias(d, i)
      const side = above(d, i)
      const dir = b >= 0.25 && side > 0 ? 1 : b <= -0.25 && side < 0 ? -1 : 0
      return dir ? { dir, why: `OI since open CE ${fmtL(d.oi[i].ce)} · PE ${fmtL(d.oi[i].pe)} (bias ${(b * 100).toFixed(0)}%), price ${dir > 0 ? 'above' : 'below'} VWAP` } : 0
    }),
  },
  {
    id: 'cumDelta', name: 'Cumulative Δ S/R break',
    rule: 'An OI totals cumulative Δ line (CE, PE or Net) breaks its own support / resistance (the "broke S / R" on the OI totals charts): calls unwinding / put writing = bullish, call writing / puts unwinding = bearish - with price on the same side of VWAP.',
    signals: (d) => d.breaks.filter((b) => above(d, b.i) === b.dir).map((b) => ({ i: b.i, dir: b.dir, why: `${b.text}, price ${b.dir > 0 ? 'above' : 'below'} VWAP` })),
  },
  {
    id: 'hp', name: '🎯 High probability',
    rule: 'The OI Replay page\'s 🎯 signal: a cumulative Δ break AND the CE or PE OI at ATM ± 1 shifting 20% of its size the same way within 5 minutes.',
    signals: (d) => d.hp.map((h) => ({ i: h.i, dir: h.dir, why: h.text })),
  },
  {
    id: 'oiWalls', name: 'OI S-R wall bounce',
    rule: 'Spot touches the OI support (the most put OI at or below it) within a quarter strike and the minute closes up, back above it = bullish; touches the OI resistance (the most call OI at or above it) and closes down, under it = bearish.',
    signals: (d) => edges(d, (i) => {
      if (i === 0) return 0
      const { support, resistance } = d.walls[i - 1]
      const near = 0.25 * d.step
      const { o, h, l, c } = d.spot
      if (support != null && l[i] <= support + near && c[i] > o[i] && c[i] > support) return { dir: 1, why: `bounced off the OI support ${support} (low ${l[i].toFixed(1)}, close ${c[i].toFixed(1)})` }
      if (resistance != null && h[i] >= resistance - near && c[i] < o[i] && c[i] < resistance) return { dir: -1, why: `rejected at the OI resistance ${resistance} (high ${h[i].toFixed(1)}, close ${c[i].toFixed(1)})` }
      return 0
    }),
  },
  {
    id: 'gex', name: 'GEX walls',
    rule: 'Dealers SHORT gamma (net GEX < 0, moves run): spot closing through the call wall = bullish, through the put wall = bearish. Dealers LONG gamma (net GEX ≥ 0, moves damped): spot touching the call wall and closing down = bearish, touching the put wall and closing up = bullish.',
    signals: (d) => edges(d, (i) => {
      const g = d.gex[i - 1]
      if (i === 0 || !g) return 0
      const near = 0.25 * d.step
      const { o, h, l, c } = d.spot
      const prev = c[i - 1]
      if (g.net < 0) {
        if (g.callWall != null && prev <= g.callWall && c[i] > g.callWall) return { dir: 1, why: `short gamma, spot through the call wall ${g.callWall}` }
        if (g.putWall != null && prev >= g.putWall && c[i] < g.putWall) return { dir: -1, why: `short gamma, spot through the put wall ${g.putWall}` }
      } else {
        if (g.callWall != null && h[i] >= g.callWall - near && c[i] < o[i] && c[i] < g.callWall) return { dir: -1, why: `long gamma, faded at the call wall ${g.callWall}` }
        if (g.putWall != null && l[i] <= g.putWall + near && c[i] > o[i] && c[i] > g.putWall) return { dir: 1, why: `long gamma, held at the put wall ${g.putWall}` }
      }
      return 0
    }),
  },
  {
    id: 'vwap', name: 'VWAP cross',
    rule: 'Price crosses VWAP and holds two closes on the new side: above = bullish, below = bearish.',
    signals: (d) => edges(d, (i) => {
      if (i < 2) return 0
      const s = [above(d, i - 2), above(d, i - 1), above(d, i)]
      if (s[0] <= 0 && s[1] > 0 && s[2] > 0) return { dir: 1, why: `price held above VWAP ${d.vwap[i].toFixed(1)} for 2 min` }
      if (s[0] >= 0 && s[1] < 0 && s[2] < 0) return { dir: -1, why: `price held below VWAP ${d.vwap[i].toFixed(1)} for 2 min` }
      return 0
    }),
  },
  {
    id: 'straddle', name: 'Straddle expansion',
    rule: 'The ATM straddle\'s card trade idea: the Auto ATM straddle over its VWAP 3 minutes (and over its decay-only line) - premium being bought - and the synthetic futures moved 25% of the day\'s priced half-range over 15 minutes and still going: up = bullish, down = bearish.',
    signals: (d) => edges(d, (i) => {
      if (i < 15 || !(d.straddleWidth > 0)) return 0
      const p = d.straddle[i], back = d.straddle[i - 15], start = d.straddle[i - 2]
      if (!p || !back || !start) return 0
      for (let k = i - 2; k <= i; k++) if (!d.straddle[k] || !(d.straddle[k].value > d.straddle[k].vwap)) return 0
      if (p.decay != null && !(p.value > p.decay)) return 0
      const move = p.forward - back.forward
      const going = p.forward - start.forward
      const need = 0.25 * d.straddleWidth
      const dir = move >= need && going > 0 ? 1 : move <= -need && going < 0 ? -1 : 0
      return dir ? { dir, why: `straddle over its VWAP 3 min, futures ${move >= 0 ? '+' : '−'}${Math.abs(move).toFixed(0)} in 15 min` } : 0
    }),
  },
  {
    id: 'profile', name: 'IB / value-area breakout',
    rule: 'After the Initial Balance (09:15 - 10:14): two closes above the IB high and above the developing volume POC = bullish; two closes below the IB low and below the POC = bearish (the Volume & Market Profile page\'s levels).',
    signals: (d) => (!d.ib ? [] : edges(d, (i) => {
      if (i <= d.ib.done + 1) return 0
      const p = d.profile[i]
      const c = d.price.c
      if (!p) return 0
      if (c[i - 1] > d.ib.high && c[i] > d.ib.high && c[i] > p.poc) return { dir: 1, why: `2 closes over the IB high ${d.ib.high.toFixed(1)}, over the POC ${p.poc.toFixed(1)}` }
      if (c[i - 1] < d.ib.low && c[i] < d.ib.low && c[i] < p.poc) return { dir: -1, why: `2 closes under the IB low ${d.ib.low.toFixed(1)}, under the POC ${p.poc.toFixed(1)}` }
      return 0
    }, d.ib.done + 1)),
  },
  {
    id: 'confluence', name: 'Confluence (all of them)',
    rule: 'All four directions agree - OI since open (bias ≥ 15%), the net cumulative Δ (put writers ahead = bullish), room to the OI walls (more room to the resistance than to the support = bullish) and price vs VWAP - and the two gates pass for the mode: GEX (buying needs dealers short gamma, selling long gamma) and the straddle (buying needs it over its VWAP - premium expanding, selling under it - premium melting).',
    signals: (d, s) => edges(d, (i) => {
      if (istMinute(d.t[i]) < 9 * 60 + 45) return 0
      const b = oiBias(d, i)
      const votes = [
        Math.abs(b) >= 0.15 ? Math.sign(b) : 0,
        Number.isFinite(d.netCum[i]) && d.netCum[i] !== 0 ? -Math.sign(d.netCum[i]) : 0,
        (() => { const { support, resistance } = d.walls[i]; const c = d.spot.c[i]; return support != null && resistance != null ? Math.sign((resistance - c) - (c - support)) : 0 })(),
        above(d, i),
      ]
      const sum = votes.reduce((a, v) => a + v, 0)
      if (Math.abs(sum) < 4) return 0
      const g = d.gex[i]
      const st = d.straddle[i]
      if (!g || !st) return 0
      const buying = s?.mode !== 'sell'
      if (buying ? !(g.net < 0) : !(g.net >= 0)) return 0
      if (buying ? !(st.value > st.vwap) : !(st.value < st.vwap)) return 0
      return { dir: Math.sign(sum), why: `OI since open, cumulative Δ, OI walls and VWAP all ${sideWord(sum)}; GEX ${g.net < 0 ? 'short' : 'long'} gamma, straddle ${st.value > st.vwap ? 'over' : 'under'} its VWAP` }
    }),
  },
]
export const SIGNAL_STRATEGY_IDS = SIGNAL_STRATEGIES.map((s) => s.id)

// ---- Trades ---------------------------------------------------------------------------------------------------------

export const BACKTEST_DEFAULTS = {
  mode: 'buy', moneyness: 0, slPct: 30, targetPct: 50, timeStopMin: 0, maxTradesPerDay: 2, cooldownMin: 10,
  lots: 1, entryFrom: '09:30', lastEntry: '14:45', squareOff: '15:10', charges: true,
}

/** The option a signal trades: BUY the call (put) for a bullish (bearish) signal, or SELL the put (call). `moneyness`:
 *  0 ATM, 1 one strike in the money, -1 one out of the money. */
export function optionFor(dir, mode, atm, step, moneyness = 0) {
  const side = mode === 'sell' ? (dir > 0 ? 'PE' : 'CE') : (dir > 0 ? 'CE' : 'PE')
  // In the money: a call below spot, a put above it.
  const shift = (side === 'CE' ? -1 : 1) * moneyness * step
  return { side, strike: atm + shift, action: mode === 'sell' ? 'SELL' : 'BUY' }
}

const barAt = (packed, i) => {
  if (!packed) return null
  const o = packed[i * 4]
  return Number.isFinite(o) ? { o, h: packed[i * 4 + 1], l: packed[i * 4 + 2], c: packed[i * 4 + 3] } : null
}
// The option's close at minute i, else its last within STALE_MINUTES.
function premiumAt(packed, i) {
  for (let k = i; k >= 0 && k >= i - STALE_MINUTES; k--) {
    const b = barAt(packed, k)
    if (b) return b.c
  }
  return null
}

/** One trade, entered at minute `i`'s close of the option and managed from minute i + 1. */
export function simulateTrade(d, i, option, { slPct, targetPct, timeStopMin = 0, squareOff = '15:10' }) {
  const packed = (option.side === 'CE' ? d.ce : d.pe).get(option.strike)
  const entry = premiumAt(packed, i)
  if (!(entry > 0)) return null
  const short = option.action === 'SELL'
  const stop = short ? entry * (1 + slPct / 100) : entry * (1 - slPct / 100)
  const target = short ? entry * (1 - targetPct / 100) : entry * (1 + targetPct / 100)
  const off = clockMinute(squareOff) ?? 15 * 60 + 10
  let last = entry, exit = null
  for (let j = i + 1; j < d.n; j++) {
    const b = barAt(packed, j)
    const minute = istMinute(d.t[j])
    if (b) {
      if (short ? b.o >= stop : b.o <= stop) exit = { j, price: b.o, reason: 'Stop (opened through it)' }
      else if (short ? b.h >= stop : b.l <= stop) exit = { j, price: stop, reason: 'Stop' }
      else if (short ? b.l <= target : b.h >= target) exit = { j, price: target, reason: 'Target' }
      last = b.c
    }
    if (!exit && timeStopMin > 0 && d.t[j] - d.t[i] >= timeStopMin * MIN) exit = { j, price: last, reason: `Time stop ${timeStopMin} min` }
    if (!exit && minute >= off) exit = { j, price: last, reason: `${squareOff} square-off` }
    if (exit) break
  }
  if (!exit) exit = { j: d.n - 1, price: last, reason: 'Day end' }
  const points = short ? entry - exit.price : exit.price - entry
  return { entryIndex: i, exitIndex: exit.j, entry, exit: exit.price, exitReason: exit.reason, points, stop, target }
}

/**
 * Every enabled strategy's signals and trades for one prepared day under the settings (BACKTEST_DEFAULTS + `settings`:
 * `strategies` the ids to run, `lotSize`, `chargesCfg`). One trade at a time per strategy, `cooldownMin` after an exit,
 * at most `maxTradesPerDay`, entries only from `entryFrom` to `lastEntry`. Returns `{ trades, signals }` - every trade
 * `{ date, strategy, dir, why, side, strike, action, entryTime, exitTime, entry, exit, exitReason, points, gross,
 * charges, net, holdMin }`; every signal `{ strategy, time, dir, why, taken, skipped }`.
 */
export function simulateDay(d, settings = {}) {
  const s = { ...BACKTEST_DEFAULTS, ...settings }
  const ids = s.strategies ?? SIGNAL_STRATEGY_IDS
  const from = clockMinute(s.entryFrom) ?? 9 * 60 + 30
  const lastEntry = clockMinute(s.lastEntry) ?? 14 * 60 + 45
  const lotSize = s.lotSize ?? 1
  const trades = []
  const signals = []
  if (!d?.ok) return { trades, signals }
  for (const strategy of SIGNAL_STRATEGIES) {
    if (!ids.includes(strategy.id)) continue
    let busyUntil = -1
    let count = 0
    for (const sig of strategy.signals(d, s).sort((a, b) => a.i - b.i)) {
      const minute = istMinute(d.t[sig.i])
      const row = { strategy: strategy.id, time: d.t[sig.i], dir: sig.dir, why: sig.why, taken: false, skipped: null }
      signals.push(row)
      if (minute < from || minute > lastEntry) { row.skipped = `outside ${s.entryFrom} - ${s.lastEntry}`; continue }
      if (sig.i <= busyUntil) { row.skipped = 'a trade still open, or cooling down'; continue }
      if (count >= s.maxTradesPerDay) { row.skipped = `${s.maxTradesPerDay} trades already today`; continue }
      const option = optionFor(sig.dir, s.mode, d.atm[sig.i], d.step, s.moneyness)
      const trade = simulateTrade(d, sig.i, option, s)
      if (!trade) { row.skipped = `no premium for ${option.strike} ${option.side}`; continue }
      row.taken = true
      count++
      busyUntil = trade.exitIndex + Math.max(0, Math.round(s.cooldownMin))
      const qty = { lots: s.lots, lotSize }
      const money = tradeCharges({ action: option.action, premium: trade.entry, current: trade.exit, ...qty }, s.chargesCfg)
      const gross = trade.points * s.lots * lotSize
      trades.push({
        date: d.date, strategy: strategy.id, dir: sig.dir, why: sig.why, ...option,
        entryTime: d.t[trade.entryIndex], exitTime: d.t[trade.exitIndex], entry: trade.entry, exit: trade.exit, exitReason: trade.exitReason,
        points: trade.points, gross, charges: s.charges && money ? money.charges : 0, net: s.charges && money ? money.net : gross,
        holdMin: Math.round((d.t[trade.exitIndex] - d.t[trade.entryIndex]) / MIN),
      })
    }
  }
  trades.sort((a, b) => a.entryTime - b.entryTime)
  return { trades, signals }
}

// ---- The report -----------------------------------------------------------------------------------------------------

export const MAX_BACKTEST_DAYS = 60

/** The days a backtest runs: the weekdays from `from` to `to` ('YYYY-MM-DD'), before `today`, at most `max` (the latest
 *  kept). A holiday is in the list - the server says it has no data and the day is shown as not run. */
export function backtestDays(from, to, today, max = MAX_BACKTEST_DAYS) {
  const out = []
  const start = Date.parse(`${from}T00:00:00Z`)
  const end = Date.parse(`${to}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return out
  for (let ms = start; ms <= end; ms += DAY) {
    const d = new Date(ms)
    const key = d.toISOString().slice(0, 10)
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && (!today || key < today)) out.push(key)
  }
  return out.slice(-max)
}

/** How a list of trades did: { trades, wins, losses, winRate, points, gross, charges, net, avgWin, avgLoss, profitFactor,
 *  expectancy, maxDrawdown, best, worst, days, winningDays, avgHoldMin } (rupees; drawdown on the running net, trade by
 *  trade in time order). */
export function summarize(trades) {
  const list = [...(trades ?? [])].sort((a, b) => a.entryTime - b.entryTime)
  const wins = list.filter((t) => t.net > 0)
  const losses = list.filter((t) => t.net <= 0)
  const sum = (xs, k) => xs.reduce((a, t) => a + t[k], 0)
  const winSum = sum(wins, 'net')
  const lossSum = sum(losses, 'net')
  let run = 0, peak = 0, maxDrawdown = 0
  for (const t of list) { run += t.net; peak = Math.max(peak, run); maxDrawdown = Math.max(maxDrawdown, peak - run) }
  const byDay = new Map()
  for (const t of list) byDay.set(t.date, (byDay.get(t.date) ?? 0) + t.net)
  return {
    trades: list.length, wins: wins.length, losses: losses.length,
    winRate: list.length ? (wins.length / list.length) * 100 : null,
    points: sum(list, 'points'), gross: sum(list, 'gross'), charges: sum(list, 'charges'), net: sum(list, 'net'),
    avgWin: wins.length ? winSum / wins.length : null, avgLoss: losses.length ? lossSum / losses.length : null,
    profitFactor: lossSum < 0 ? winSum / -lossSum : wins.length ? Infinity : null,
    expectancy: list.length ? sum(list, 'net') / list.length : null,
    maxDrawdown,
    best: list.length ? Math.max(...list.map((t) => t.net)) : null, worst: list.length ? Math.min(...list.map((t) => t.net)) : null,
    days: byDay.size, winningDays: [...byDay.values()].filter((v) => v > 0).length,
    avgHoldMin: list.length ? sum(list, 'holdMin') / list.length : null,
  }
}

/** The trades as CSV text (one row a trade). */
export function tradesCsv(trades) {
  const name = Object.fromEntries(SIGNAL_STRATEGIES.map((s) => [s.id, s.name]))
  const time = (ms) => hhmm(istMinute(ms))
  const cell = (v) => {
    const text = v == null ? '' : String(v)
    const safe = /^[=+\-@]/.test(text) && !/^-?\d/.test(text) ? `'${text}` : text
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  const head = ['date', 'strategy', 'signal', 'action', 'option', 'entry time', 'entry', 'exit time', 'exit', 'exit reason', 'points', 'gross', 'charges', 'net', 'why']
  const rows = trades.map((t) => [
    t.date, name[t.strategy] ?? t.strategy, t.dir > 0 ? 'bullish' : 'bearish', t.action, `${t.strike} ${t.side}`, time(t.entryTime), t.entry.toFixed(2),
    time(t.exitTime), t.exit.toFixed(2), t.exitReason, t.points.toFixed(2), t.gross.toFixed(0), t.charges.toFixed(0), t.net.toFixed(0), t.why,
  ])
  return [head, ...rows].map((r) => r.map(cell).join(',')).join('\n')
}
