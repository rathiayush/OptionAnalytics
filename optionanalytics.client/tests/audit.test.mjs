// Audit of the strategy scanner's core guarantees, checked independently of the engine's own code:
//  1. No look-ahead: a setup at clock T depends only on what was known at T - replacing everything from
//     minute T on (OI, premiums, spot, futures, bars, prints) must not change a single setup.
//  2. Outcomes: an independently written stop / target / trailing-stop / time-stop simulator agrees
//     with simulateOutcome on thousands of random trades, plus the edge cases spelled out.
//  3. Option premium stop / target: from the first full minute after the entry, at the level.
import { buildOiContext, evaluateStrategies, simulateOutcome, trailedStop, optionStopTargetHit, premiumAt, squareOffMs, SQUARE_OFF } from '../src/strategyEngine.js'

const MIN = 60_000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
let fails = 0
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ` ${extra}`}`); if (!cond) fails++ }
let seed = 1
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646 }

// ---- a random day ---------------------------------------------------------------------------------
function randomDay(daySeed) {
  seed = daySeed
  const N = 375
  const regime = daySeed % 3
  const bars = []
  let p = 22760
  let cvd = 0
  for (let m = 0; m < N; m++) {
    const o = p
    p += (regime === 0 ? 0.3 : regime === 1 ? -0.3 : -0.03 * (p - 22760)) + (rnd() - 0.5) * 12
    const c = Math.round(p * 20) / 20
    const buy = Math.round(400 + rnd() * 600 + (c > o ? 250 : 0))
    const sell = Math.round(400 + rnd() * 600 + (c < o ? 250 : 0))
    cvd += buy - sell
    const r = rnd()
    bars.push({ time: at(m), open: o, high: Math.max(o, c) + rnd() * 6, low: Math.min(o, c) - rnd() * 6, close: c, buy, sell, delta: buy - sell, cvd,
      stacked: r < 0.1 ? [{ side: c > o ? 'buy' : 'sell', low: c - 4, high: c + 2, rows: 3 }] : [],
      absorption: r > 0.92 ? [{ side: c > o ? 'buy' : 'sell', price: c }] : [],
      exhaustion: r > 0.86 && r < 0.92 ? [{ side: c > o ? 'buy' : 'sell', price: c }] : [] })
  }
  const spot = [], fut = [], ce = [], pe = []
  const state = new Map()
  for (let m = 0; m < N; m++) {
    const f = bars[m].close
    spot.push({ time: iso(at(m)), open: f - 60, high: f - 60, low: f - 60, close: f - 60 })
    fut.push({ time: iso(at(m)), open: f, high: f, low: f, close: f, volume: 1000, openInterest: Math.round(1e7 + m * (regime < 2 ? 4000 : -1000) + (rnd() - 0.5) * 30000) })
    for (let k = 22300; k <= 23200; k += 50) {
      const s = state.get(k) ?? { ce: 1e6 + rnd() * 4e6, pe: 1e6 + rnd() * 4e6 }
      s.ce = Math.max(1e5, s.ce + (rnd() - (regime === 1 ? 0.3 : 0.5)) * 40000)
      s.pe = Math.max(1e5, s.pe + (rnd() - (regime === 0 ? 0.3 : 0.5)) * 40000)
      state.set(k, s)
      const prem = (side) => Math.max(1, 80 + (side === 'CE' ? 1 : -1) * (f - 60 - k) * 0.5 + rnd() * 4)
      const cp = prem('CE'), pp = prem('PE')
      ce.push({ time: iso(at(m)), strike: k, openInterest: Math.round(s.ce), price: cp, high: cp + 3, low: cp - 3 })
      pe.push({ time: iso(at(m)), strike: k, openInterest: Math.round(s.pe), price: pp, high: pp + 3, low: pp - 3 })
    }
  }
  const prints = []
  for (let m = 0; m < N; m++) for (let i = 0; i < 20; i++) prints.push({ seq: prints.length, time: at(m) + i * 3000, price: bars[m].close, quantity: rnd() < 0.04 ? 1500 : 75, buy: rnd() < bars[m].buy / (bars[m].buy + bars[m].sell) })
  return { bars, run: { success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: spot, futuresBars: fut, cePoints: ce, pePoints: pe }, prints }
}

// Everything from minute T on replaced with nonsense - what a look-ahead would pick up.
function scrambledFrom(day, T) {
  const later = (time) => new Date(time).getTime() >= T
  const run = {
    ...day.run,
    spotCandlesOneMinute: day.run.spotCandlesOneMinute.map((c) => (later(c.time) ? { ...c, close: c.close + 400, open: c.open + 400 } : c)),
    futuresBars: day.run.futuresBars.map((b) => (later(b.time) ? { ...b, close: b.close - 400, openInterest: b.openInterest * 3 } : b)),
    cePoints: day.run.cePoints.map((p) => (later(p.time) ? { ...p, openInterest: p.openInterest * 4, price: p.price * 3, high: p.high * 3, low: p.low * 3 } : p)),
    pePoints: day.run.pePoints.map((p) => (later(p.time) ? { ...p, openInterest: Math.round(p.openInterest / 4), price: p.price / 3 } : p)),
  }
  return run
}

const evalAt = (day, run, T) => {
  const done = day.bars.filter((b) => b.time + MIN <= T) // completed minutes, as the scanner passes them
  const prints = day.prints.filter((p) => p.time <= T)
  // Retired strategies keep their code, so the look-ahead check covers them too (includeRetired).
  return evaluateStrategies({
    includeRetired: true, nowMs: T, price: prints.at(-1)?.price ?? done.at(-1).close, bars: done, minuteBars: done, prints, book: { bids: [{ quantity: 600 }], asks: [{ quantity: 400 }] },
    liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi: buildOiContext(run), estimated: false, lotSize: 75, bigLots: 10,
    profile: { vp: { poc: 22760, vah: 22800, val: 22720, hvn: [22740, 22790], lvn: [22770] }, tpoPrev: { poc: 22760, vah: 22800, val: 22720 }, prevHigh: 22840, prevLow: 22680 },
  })
}
const sig = (setups) => setups.map((s) => `${s.id}:${s.side}:${s.entry}:${s.stop.toFixed(2)}:${s.target.toFixed(2)}:${s.options?.sell?.premium?.toFixed(2)}`).sort().join('|')

// ---- 1. no look-ahead -------------------------------------------------------------------------------
{
  let clocks = 0, withSetups = 0, differ = []
  for (let d = 1; d <= 12; d++) {
    const day = randomDay(d * 7919)
    for (let m = 31; m <= 330; m += 3) {
      const T = at(m)
      const a = evalAt(day, day.run, T)
      const b = evalAt(day, scrambledFrom(day, T), T)
      clocks++
      if (a.length) withSetups++
      if (sig(a) !== sig(b)) differ.push(`day ${d} ${m}: ${sig(a)} != ${sig(b)}`)
    }
  }
  console.log(`   ${clocks} clocks checked, ${withSetups} with setups`)
  check('no look-ahead: a setup never changes when everything from its minute on is replaced', differ.length === 0, differ.slice(0, 3).join(' || '))
  check('the look-ahead check had setups to compare', withSetups >= 10, String(withSetups))
  // ...and the premium a trade is punched at is the last FINISHED minute's.
  const day = randomDay(4242)
  const oi = buildOiContext(day.run)
  const T = at(120)
  const p119 = day.run.cePoints.find((p) => p.strike === 22700 && new Date(p.time).getTime() === at(119)).price
  check('premium at a minute boundary = the previous minute\'s close (not the running minute\'s)', premiumAt(oi, 'CE', 22700, T) === p119 && premiumAt(oi, 'CE', 22700, T + 30_000) === p119)
  const live = buildOiContext(day.run, null, { live: true })
  const p120 = day.run.cePoints.find((p) => p.strike === 22700 && new Date(p.time).getTime() === at(120)).price
  check('live: the running minute holds the latest tick and is read as it comes', premiumAt(live, 'CE', 22700, T + 30_000) === p120)
}

// ---- 2. outcomes vs an independent simulator ---------------------------------------------------------------
// Written from the rules, not from the engine: bars from the one starting at the entry; a bar already
// running at the entry is skipped; stop before target in the same bar, filled at the worse of the stop
// and the bar's open; target at the target; then the trail moves (startR / gapR on the best price so
// far); time stop / 15:10 at the bar's close.
function reference(setup, bars, untilMs, dayOver) {
  const dir = setup.side === 'LONG' ? 1 : -1
  const risk = Math.abs(setup.entry - setup.stop)
  const end = Math.min(setup.timeStopMs ?? Infinity, squareOffMs(setup.t))
  let stop = setup.stop
  let best = setup.entry
  let last = setup.entry
  for (const b of bars) {
    if (b.time < setup.t) continue
    if (b.time + MIN > untilMs) return { status: 'open' }
    const hitStop = dir > 0 ? b.low <= stop : b.high >= stop
    const hitTarget = dir > 0 ? b.high >= setup.target : b.low <= setup.target
    if (hitStop) {
      const fill = dir > 0 ? Math.min(stop, b.open) : Math.max(stop, b.open)
      return { exitAt: b.time, exitPrice: fill, r: (dir * (fill - setup.entry)) / risk }
    }
    if (hitTarget) return { exitAt: b.time, exitPrice: setup.target, r: Math.abs(setup.target - setup.entry) / risk }
    last = b.close
    best = dir > 0 ? Math.max(best, b.high) : Math.min(best, b.low)
    // The trail in R (x the risk) or, unit 'pts', in futures points.
    const trailStart = setup.trail?.unit === 'pts' ? setup.trail.startPts : setup.trail?.startR * risk
    const trailGap = setup.trail?.unit === 'pts' ? setup.trail.gapPts : setup.trail?.gapR * risk
    if (setup.trail && dir * (best - setup.entry) >= trailStart) {
      const trailed = best - dir * trailGap
      stop = dir > 0 ? Math.max(stop, trailed) : Math.min(stop, trailed)
    }
    if (b.time + MIN >= end) return { exitAt: b.time, exitPrice: b.close, r: (dir * (b.close - setup.entry)) / risk }
  }
  return dayOver ? { exitPrice: last, r: (dir * (last - setup.entry)) / risk } : { status: 'open' }
}
{
  let compared = 0
  const bad = []
  for (let d = 1; d <= 6; d++) {
    const day = randomDay(d * 104729)
    for (let i = 0; i < 400; i++) {
      seed = d * 1000 + i + 17
      const m = 20 + Math.floor(rnd() * 330)
      const t = at(m) + (rnd() < 0.5 ? 0 : Math.floor(rnd() * 59) * 1000) // on the minute (scan) or mid-minute (live alert)
      const entry = day.bars[m - 1].close
      const dir = rnd() < 0.5 ? 1 : -1
      const riskPts = 5 + rnd() * 40
      const setup = {
        side: dir > 0 ? 'LONG' : 'SHORT', t, entry, stop: entry - dir * riskPts, target: entry + dir * riskPts * (1 + rnd() * 2.5),
        timeStopMs: t + (20 + Math.floor(rnd() * 70)) * MIN, trail: rnd() < 0.4 ? { startR: 0.5 + rnd() * 1.5, gapR: 0.5 + rnd() * 1.5 } : rnd() < 0.5 ? { unit: 'pts', startR: 1, gapR: 1, startPts: 2 + rnd() * 15, gapPts: 1 + rnd() * 10 } : null,
      }
      const until = rnd() < 0.3 ? t + Math.floor(rnd() * 60) * MIN : Infinity
      const dayOver = until === Infinity
      const got = simulateOutcome(setup, day.bars, until, dayOver)
      const want = reference(setup, day.bars, until, dayOver)
      compared++
      const same = want.status === 'open'
        ? got.status === 'open'
        : got.status !== 'open' && Math.abs(got.r - want.r) < 1e-9 && Math.abs(got.exitPrice - want.exitPrice) < 1e-9 && (want.exitAt == null || got.exitAt === want.exitAt)
      if (!same) bad.push(`${JSON.stringify({ m, t: iso(t), side: setup.side, entry, stop: setup.stop, target: setup.target, trail: setup.trail })} got ${JSON.stringify(got)} want ${JSON.stringify(want)}`)
    }
  }
  check(`outcomes match the independent simulator (${compared} random trades)`, bad.length === 0, bad.slice(0, 2).join(' || '))
}

// ---- 2b. the edge cases, spelled out ---------------------------------------------------------------------------
{
  const bar = (m, o, h, l, c) => ({ time: at(m), open: o, high: h, low: l, close: c })
  const base = { side: 'LONG', entry: 100, stop: 90, target: 120, timeStopMs: Infinity, trail: null }
  // An entry ON the minute (Scan day, Go to): the bar starting then is the first one counted.
  const s1 = { ...base, t: at(10) }
  const o1 = simulateOutcome(s1, [bar(10, 100, 121, 99, 118)], Infinity, true)
  check('entry on the minute: the bar starting at the entry counts (target hit in it)', o1.status === 'win' && o1.exitAt === at(10) && o1.exitPrice === 120)
  // A live alert mid-minute: that minute's bar is not counted (part of it came before the trade).
  const o2 = simulateOutcome({ ...s1, t: at(10) + 20_000 }, [bar(10, 100, 121, 99, 118), bar(11, 118, 119, 117, 118)], Infinity, true)
  check('entry mid-minute: the running bar is not counted', o2.exitAt == null && o2.status === 'win' && Math.abs(o2.r - 1.8) < 1e-9)
  // Both levels touched in one bar: the stop.
  const o3 = simulateOutcome(s1, [bar(10, 100, 125, 85, 110)], Infinity, true)
  check('stop and target in the same bar: the stop counts', o3.status === 'loss' && o3.r === -1 && o3.exitPrice === 90)
  // A gap through the stop: filled at the open.
  const o4 = simulateOutcome(s1, [bar(10, 100, 101, 99, 100), bar(11, 85, 86, 80, 82)], Infinity, true)
  check('a bar opening beyond the stop fills at its open', o4.exitPrice === 85 && o4.r === -1.5 && o4.stopHit)
  // Trailing stop: +1R moves the stop to breakeven, and it only tightens.
  const s5 = { ...s1, trail: { startR: 1, gapR: 1 } }
  check('trail: below +1R the stop stays', trailedStop(s5, 109) === 90)
  check('trail: at +1R it is at breakeven, then follows 1R behind', trailedStop(s5, 110) === 100 && trailedStop(s5, 115) === 105)
  const o5 = simulateOutcome(s5, [bar(10, 100, 112, 99, 111), bar(11, 111, 111, 101, 104), bar(12, 104, 105, 101, 102)], Infinity, true)
  check('trail: the trailed stop exits the trade (at 102 after a 112 high)', o5.stopHit && o5.trailed && o5.exitPrice === 102 && Math.abs(o5.r - 0.2) < 1e-9 && o5.exitAt === at(11))
  // Time stop at the close of the bar it ends in.
  const o6 = simulateOutcome({ ...s1, timeStopMs: at(12) }, [bar(10, 100, 101, 99, 100), bar(11, 100, 104, 99, 103), bar(12, 103, 106, 102, 105)], Infinity, true)
  check('time stop: closed at the close of the bar it ends in', o6.timeStop && o6.exitAt === at(11) && o6.exitPrice === 103)
  // 15:10 square-off at the latest.
  const mSq = SQUARE_OFF - (9 * 60 + 15) // minutes from 09:15 to 15:10
  const late = { ...s1, t: at(mSq - 3), timeStopMs: at(mSq + 60) }
  const o7 = simulateOutcome(late, [mSq - 3, mSq - 2, mSq - 1, mSq].map((m) => bar(m, 100, 101, 99, 100.5)), Infinity, true)
  check('15:10: every trade closed by the square-off', o7.squareOff && o7.exitAt === at(mSq - 1))
  // Still running while the clock has not passed the bar.
  check('a bar not finished at the clock leaves the trade open', simulateOutcome(s1, [bar(10, 100, 121, 99, 118)], at(10) + 30_000).status === 'open')
}

// ---- 3. option premium stop / target ---------------------------------------------------------------------------------
{
  const pts = (k, side, list) => list.map(([m, price, high, low]) => ({ time: iso(at(m)), strike: k, openInterest: 1e6, price, high, low }))
  const run = { success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: [{ time: iso(at(0)), close: 22700 }], futuresBars: [], pePoints: [],
    cePoints: pts(22700, 'CE', [[9, 100, 101, 99], [10, 100, 104, 96], [11, 98, 99, 84], [12, 90, 92, 88]]) }
  const oi = buildOiContext(run)
  const sell = { action: 'SELL', side: 'CE', strike: 22700, premium: 100 }
  // Entry on the minute at 09:25:00 (the 09:24 close, 100): 09:25 is the first full minute after it.
  const hit = optionStopTargetHit(oi, sell, at(10), Infinity, 20, 15)
  check('option target from the first full minute after the entry, filled at the level', hit?.premium === 85 && hit.at === at(12) && /Target 15/.test(hit.reason), JSON.stringify(hit))
  const stopFirst = optionStopTargetHit(oi, sell, at(10), Infinity, 3, 15)
  check('option stop counts first when one minute touches both / is reached first', stopFirst?.premium === 103 && stopFirst.at === at(11), JSON.stringify(stopFirst))
  // A live entry mid-minute skips that running minute.
  const midLive = optionStopTargetHit(buildOiContext(run, null, { live: true }), sell, at(10) + 20_000, Infinity, 3, 15)
  check('live, mid-minute entry: the running minute is skipped', midLive?.at === at(12) && midLive.premium === 85, JSON.stringify(midLive))
}

console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
