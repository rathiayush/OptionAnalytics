// Strategy 16, the weak OI wall second-retest break.
// Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, evaluateStrategies, STRATEGIES } from '../src/strategyEngine.js'
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${x}`); if (!c) fails++ }
check('30 strategies, #16 is the weak wall', STRATEGIES.length === 30 && STRATEGIES.find((s) => s.no === 16)?.id === 'weakWall')

const NOW_M = 85
function oiRun(opts = {}) { return buildOiContext(rawRun(opts)) }
function rawRun({ levelOi = (m) => (m < 70 ? 4.6e6 : 4.6e6 - (m - 70) * 40000), neighbour = 3e6, futuresUp = true, futuresOi = true } = {}) {
  const sp = [], fut = [], ce = [], pe = []
  for (let m = 0; m <= NOW_M + 5; m++) {
    const s = 22630 + (m >= 70 ? (m - 70) * 0.5 : 0)
    sp.push({ time: iso(at(m)), open: s, high: s, low: s, close: s })
    fut.push({ time: iso(at(m)), open: s + 60, high: s + 60, low: s + 60, close: s + 60 + (futuresUp ? 0 : -(m >= 70 ? (m - 70) * 1.2 : 0)), volume: 1, openInterest: futuresOi ? 1e7 + m * 4000 : null })
    for (let k = 22400; k <= 22900; k += 50) {
      const ceOi = k === 22800 ? 10e6 : k === 22650 ? levelOi(m) : (k === 22600 || k === 22700) ? neighbour : 1e6
      ce.push({ time: iso(at(m)), strike: k, openInterest: ceOi, price: 50 })
      pe.push({ time: iso(at(m)), strike: k, openInterest: k === 22550 ? 6e6 : 1e6, price: 50 })
    }
  }
  return { success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: sp, futuresBars: fut, cePoints: ce, pePoints: pe }
}
// Futures bars: first test of 22710 (=22650 + basis 60) around m 40, away, back now at m 85.
function futBars({ secondTest = true } = {}) {
  const out = []; let cvd = 0
  for (let m = 0; m <= NOW_M - 1; m++) {
    let p = 22680
    if (m >= 38 && m <= 42) p = 22705          // 1st test
    if (m > 42 && m < 75) p = 22660           // away
    if (m >= 75) p = secondTest ? 22690 + (m - 75) * 1.6 : 22660
    const b = { time: at(m), open: p - 1, high: p + 2, low: p - 2, close: p, buy: m === NOW_M - 1 ? 1500 : 600, sell: 500, absorption: [], exhaustion: [], stacked: [] }
    b.delta = b.buy - b.sell; cvd += b.delta; b.cvd = cvd
    out.push(b)
  }
  return out
}
const tape = (now, pct) => Array.from({ length: 60 }, (_, i) => ({ seq: i, time: now - 59000 + i * 1000, price: 1, quantity: 75, buy: ((i * 37) % 100) < pct }))
const run = (oi, bars) => {
  const now = at(NOW_M) + 10000
  const price = bars.at(-1).close
  return evaluateStrategies({ nowMs: now, price, bars, minuteBars: bars, prints: tape(now, 70), book: { bids: [{ quantity: 600 }], asks: [{ quantity: 400 }] }, liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi, estimated: false, lotSize: 75, bigLots: 10, profile: null })
}
let s = run(oiRun(), futBars()).find((x) => x.id === 'weakWall')
check('fires LONG on the 2nd test of a weak, covered secondary CALL wall', s?.side === 'LONG' && s.target > s.entry && s.stop < s.entry, JSON.stringify(s ? { entry: s.entry, stop: s.stop, target: s.target, conf: s.confidence, checks: s.checks } : null))
check('not on the first test', !run(oiRun(), futBars({ secondTest: false })).some((x) => x.id === 'weakWall'))
check('not when the wall stands out (OI far above its neighbours)', !run(oiRun({ neighbour: 1e6 }), futBars()).some((x) => x.id === 'weakWall'))
check('not when writers are adding to it', !run(oiRun({ levelOi: (m) => 4e6 + m * 20000 }), futBars()).some((x) => x.id === 'weakWall'))
check('not without futures confirmation (futures falling)', !run(oiRun({ futuresUp: false }), futBars()).some((x) => x.id === 'weakWall'))
// The NIFTY setup is pinned: the strike-step caps on the band / stop (for BANKNIFTY and SENSEX) leave NIFTY as it was.
check('NIFTY setup unchanged (entry / stop / target)', s?.entry === 22704.4 && Math.abs(s.stop - 22681.6956) < 1e-6 && Math.abs(s.target - 22761.161) < 1e-6,
  JSON.stringify(s ? { entry: s.entry, stop: s.stop, target: s.target } : null))

// ---- The same scenario at BANKNIFTY and SENSEX scale (strike step 100), LONG and mirrored SHORT --------------------
// The same structure in strikes: the weak level K, its neighbours K ± step, the biggest wall 3 strikes beyond, the
// opposite wall 2 strikes behind. Prices x f (level, spot, basis); the bars' moves around the level x `move` - by price
// (f) or by strike (step / 50: the same moves measured in strikes). The spot follows the futures (spot = futures -
// basis), so the futures level is K + basis. The tape / footprint in the index's lots.
function scaled({ f, step, K, lot, move, dir = 1, secondTest = true, neighbour = 3e6, levelOi = (m) => (m < 70 ? 4.6e6 : 4.6e6 - (m - 70) * 40000), futuresUp = true }) {
  const g = move === 'strike' ? step / 50 : f
  const basis = 60 * f, L = K + basis, up = dir > 0
  const bars = []; let cvd = 0
  for (let m = 0; m <= NOW_M - 1; m++) {
    let d = -30                               // below (above) the level
    if (m >= 38 && m <= 42) d = -5            // 1st test
    if (m > 42 && m < 75) d = -50             // away
    if (m >= 75) d = secondTest ? -20 + (m - 75) * 1.6 : -50
    const p = L + dir * d * g
    const lastBar = m === NOW_M - 1
    const b = { time: at(m), open: p - dir * g, high: p + 2 * g, low: p - 2 * g, close: p, absorption: [], exhaustion: [], stacked: [],
      buy: (lastBar ? (up ? 1500 : 500) : (up ? 600 : 500)) * lot / 75, sell: (lastBar ? (up ? 500 : 1500) : (up ? 500 : 600)) * lot / 75 }
    b.delta = b.buy - b.sell; cvd += b.delta; b.cvd = cvd
    bars.push(b)
  }
  const sp = [], fut = [], ce = [], pe = []
  for (let m = 0; m <= NOW_M + 5; m++) {
    const fp = bars[Math.min(m, NOW_M - 1)].close
    sp.push({ time: iso(at(m)), open: fp - basis, high: fp - basis, low: fp - basis, close: fp - basis })
    const fc = futuresUp ? fp : L - dir * (50 + m * 0.5) * g
    fut.push({ time: iso(at(m)), open: fc, high: fc, low: fc, close: fc, volume: 1, openInterest: 1e7 + m * 4000 })
    for (let i = -5; i <= 5; i++) {
      const j = dir * i                        // strikes from the level, in the trade's direction
      const wall = j === 3 ? 10e6 : j === 0 ? levelOi(m) : Math.abs(j) === 1 ? neighbour : 1e6
      const other = j === -2 ? 6e6 : 1e6
      ce.push({ time: iso(at(m)), strike: K + i * step, openInterest: up ? wall : other, price: 50 })
      pe.push({ time: iso(at(m)), strike: K + i * step, openInterest: up ? other : wall, price: 50 })
    }
  }
  const oiCtx = buildOiContext({ success: true, date: '2026-10-05', step, spotCandlesOneMinute: sp, futuresBars: fut, cePoints: ce, pePoints: pe })
  const now = at(NOW_M) + 10000
  const prints = Array.from({ length: 60 }, (_, i) => ({ seq: i, time: now - 59000 + i * 1000, price: 1, quantity: lot, buy: ((i * 37) % 100) < (up ? 70 : 30) }))
  const book = up ? { bids: [{ quantity: 600 }], asks: [{ quantity: 400 }] } : { bids: [{ quantity: 400 }], asks: [{ quantity: 600 }] }
  return evaluateStrategies({ nowMs: now, price: bars.at(-1).close, bars, minuteBars: bars, prints, book, liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi: oiCtx, estimated: false, lotSize: lot, bigLots: 10, profile: null })
    .find((x) => x.id === 'weakWall')
}
const INDICES = [['BANKNIFTY', { f: 52000 / 22630, step: 100, K: 52000, lot: 30 }], ['SENSEX', { f: 82000 / 22630, step: 100, K: 82000, lot: 20 }]]
for (const [name, ix] of INDICES) {
  for (const move of ['price', 'strike']) {
    for (const dir of [1, -1]) {
      const sc = { ...ix, K: dir > 0 ? ix.K : ix.K - ix.step, move, dir }
      const side = dir > 0 ? 'LONG' : 'SHORT'
      const w = scaled(sc)
      check(`${name} (moves by ${move}): fires ${side} on the 2nd test of a weak, covered secondary wall`,
        w?.side === side && dir * (w.target - w.entry) > 0 && dir * (w.entry - w.stop) > 0, JSON.stringify(w ? { entry: w.entry, stop: w.stop, target: w.target } : null))
      check(`${name} (moves by ${move}) ${side}: not on the first test`, !scaled({ ...sc, secondTest: false }))
      check(`${name} (moves by ${move}) ${side}: not when the wall stands out`, !scaled({ ...sc, neighbour: 1e6 }))
      check(`${name} (moves by ${move}) ${side}: not when writers are adding`, !scaled({ ...sc, levelOi: (m) => 4e6 + m * 20000 }))
      check(`${name} (moves by ${move}) ${side}: not without futures confirmation`, !scaled({ ...sc, futuresUp: false }))
    }
  }
}
// The scaled scenario at NIFTY scale fires too (the builder is the same strategy, not a SENSEX-only shape).
check('NIFTY (scaled builder): fires LONG and SHORT', scaled({ f: 1, step: 50, K: 22650, lot: 75, move: 'price' })?.side === 'LONG'
  && scaled({ f: 1, step: 50, K: 22600, lot: 75, move: 'price', dir: -1 })?.side === 'SHORT')


// No futures OI (a past day after its contract expired: Dhan / the archive give the bars without OI) - the
// futures PRICE direction alone confirms it; with futures OI nothing changes.
const brief = (x) => x && { side: x.side, entry: x.entry, stop: x.stop, target: x.target, timeStopMs: x.timeStopMs }
const noOi = run(oiRun({ futuresOi: false }), futBars()).find((x) => x.id === 'weakWall')
check('no futures OI: still fires LONG on the futures price direction alone (same entry, stop, target)', noOi?.side === 'LONG' && JSON.stringify(brief(noOi)) === JSON.stringify(brief(s)) && /no futures OI/.test(noOi.checks['Futures confirm']), JSON.stringify(noOi?.checks['Futures confirm']))
check('no futures OI: not when the futures price is falling', !run(oiRun({ futuresOi: false, futuresUp: false }), futBars()).some((x) => x.id === 'weakWall'))
check('with futures OI the setup is unchanged (build-up read shown)', /long build-up: price/.test(s?.checks['Futures confirm'] ?? ''), s?.checks['Futures confirm'])
// The SHORT mirror (around 22650 for the index, 22710 for the futures - the basis stays +60): a weak PUT wall
// being unwound, tested twice from above, the futures falling.
const C = 22650
const mirrorPts = (list, fn) => list.map((p) => fn(p))
function mirrorRun(raw) {
  const sp = mirrorPts(raw.spotCandlesOneMinute, (c) => ({ ...c, open: 2 * C - c.open, high: 2 * C - c.low, low: 2 * C - c.high, close: 2 * C - c.close }))
  const F = 2 * (C + 60)
  const fut = mirrorPts(raw.futuresBars, (b) => ({ ...b, open: F - b.open, high: F - b.low, low: F - b.high, close: F - b.close }))
  const flip = (list) => mirrorPts(list, (p) => ({ ...p, strike: 2 * C - p.strike }))
  return { ...raw, spotCandlesOneMinute: sp, futuresBars: fut, cePoints: flip(raw.pePoints), pePoints: flip(raw.cePoints) }
}
function mirrorBars(bars) {
  const F = 2 * (C + 60)
  return bars.map((b) => ({ ...b, open: F - b.open, high: F - b.low, low: F - b.high, close: F - b.close, buy: b.sell, sell: b.buy, delta: -b.delta, cvd: -b.cvd }))
}
const runShort = (oi, bars) => {
  const now = at(NOW_M) + 10000
  return evaluateStrategies({ nowMs: now, price: bars.at(-1).close, bars, minuteBars: bars, prints: tape(now, 30), book: { bids: [{ quantity: 400 }], asks: [{ quantity: 600 }] }, liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi, estimated: false, lotSize: 75, bigLots: 10, profile: null })
}
const sh = runShort(buildOiContext(mirrorRun(rawRun())), mirrorBars(futBars())).find((x) => x.id === 'weakWall')
check('fires SHORT on the mirror (a weak PUT wall unwound, futures falling)', sh?.side === 'SHORT' && sh.target < sh.entry && sh.stop > sh.entry, JSON.stringify(brief(sh)))
const shNoOi = runShort(buildOiContext(mirrorRun(rawRun({ futuresOi: false }))), mirrorBars(futBars())).find((x) => x.id === 'weakWall')
check('no futures OI: the SHORT still fires on the price direction alone (same levels)', shNoOi?.side === 'SHORT' && JSON.stringify(brief(shNoOi)) === JSON.stringify(brief(sh)), JSON.stringify(brief(shNoOi)))
check('no futures OI: the SHORT not when the futures price is rising', !runShort(buildOiContext(mirrorRun(rawRun({ futuresOi: false, futuresUp: false }))), mirrorBars(futBars())).some((x) => x.id === 'weakWall'))
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
