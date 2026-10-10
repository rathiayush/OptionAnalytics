// Strategies 6 (fresh build-up trend), 12 (market profile 80% rule), 13 (previous POC reaction) and 14 (LVN run):
// each fires on its rules, LONG and SHORT, and not when a key condition is missing.
// Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, evaluateStrategies } from '../src/strategyEngine.js'
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${x}`); if (!c) fails++ }
const BASIS = 60
// A SHORT is the LONG picture mirrored: the index around C, the futures around C + BASIS (the basis stays
// +60), CALL <-> PUT, buyers <-> sellers.
const C = 22650
const F = 2 * (C + BASIS)
const mirrorLevel = (p, dir) => (dir > 0 ? p : F - p)

// A day: `fut(m)` the futures close each minute (the index = fut - 60), `vol(m)` its volume, `pe` / `ce` per-strike
// OI functions (for the LONG picture), `futOi(m)`. Returns the OI context and the completed futures bars at `nowM`.
function day({ fut, vol = () => 1000, pe = {}, ce = {}, futOi = () => 1e7, nowM, dir = 1, last = {} }) {
  const sp = [], fu = [], cePts = [], pePts = []
  for (let m = 0; m <= nowM + 5; m++) {
    const f = mirrorLevel(fut(m), dir)
    sp.push({ time: iso(at(m)), open: f - BASIS, high: f - BASIS, low: f - BASIS, close: f - BASIS })
    fu.push({ time: iso(at(m)), open: f, high: f, low: f, close: f, volume: 1, openInterest: futOi(m) })
    for (let k = 22300; k <= 23000; k += 50) {
      const kk = dir > 0 ? k : 2 * C - k
      pePts.push({ time: iso(at(m)), strike: kk, openInterest: (pe[k] ?? (() => 1e6))(m), price: 20 })
      cePts.push({ time: iso(at(m)), strike: kk, openInterest: (ce[k] ?? (() => 1e6))(m), price: 20 })
    }
  }
  // (mirrored: the LONG picture's PUT series are the SHORT's CALLs)
  const oi = buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: sp, futuresBars: fu, cePoints: dir > 0 ? cePts : pePts, pePoints: dir > 0 ? pePts : cePts })
  const bars = []
  let cvd = 0
  const flipSide = (list) => list.map((a) => ({ ...a, side: a.side === 'buy' ? 'sell' : 'buy' }))
  for (let m = 0; m < nowM; m++) {
    const c = fut(m)
    const o = m ? fut(m - 1) : c
    const v = vol(m)
    const up = c >= o
    let b = { time: at(m), open: o, high: Math.max(o, c) + 2, low: Math.min(o, c) - 2, close: c, buy: Math.round(v * (up ? 0.55 : 0.45)), sell: Math.round(v * (up ? 0.45 : 0.55)), absorption: [], exhaustion: [], stacked: [] }
    if (m === nowM - 1) b = { ...b, ...last }
    if (dir < 0) b = { ...b, open: F - b.open, high: F - b.low, low: F - b.high, close: F - b.close, buy: b.sell, sell: b.buy, absorption: flipSide(b.absorption), exhaustion: flipSide(b.exhaustion), stacked: flipSide(b.stacked) }
    b.delta = b.buy - b.sell; cvd += b.delta; b.cvd = cvd
    bars.push(b)
  }
  return { oi, bars }
}
function evalAt({ oi, bars }, nowM, dir, o = {}) {
  const nowMs = at(nowM) + 10_000
  const buyPct = o.tapeAgainst ? 50 : dir > 0 ? 70 : 30
  const tape = Array.from({ length: 60 }, (_, i) => ({ seq: i, time: nowMs - 59_000 + i * 1000, price: 1, quantity: 75, buy: ((i * 37) % 100) < buyPct }))
  const book = dir > 0 ? { bids: [{ quantity: 600 }], asks: [{ quantity: 400 }] } : { bids: [{ quantity: 400 }], asks: [{ quantity: 600 }] }
  return evaluateStrategies({ nowMs, price: bars.at(-1).close, bars, minuteBars: bars, prints: tape, book, liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi, estimated: false, lotSize: 75, bigLots: 10, profile: o.profile ?? null })
}
const brief = (s, all) => JSON.stringify(s ? { side: s.side, entry: s.entry, stop: s.stop, target: s.target } : all.map((x) => x.id))

// ---- 6. Fresh build-up trend (10:00-14:45): futures +0.15%+ with OI +0.3%+ in 30 minutes, puts written over
// those 30 minutes, the price pulled back to VWAP (on its side, within 0.08%), absorption / a stack with it.
{
  const NOW = 100
  const P = 22700
  const fut = (m) => (m < 75 ? P : m <= 85 ? P + (m - 75) * 4.5 : P + 45)
  const vol = (m) => (m < 75 ? 100 : 3000)
  const puts = (m) => 3e6 + Math.max(0, m - 60) * 20000
  const build = (dir, o = {}) => {
    const d = day({ fut: o.flat ? () => P : fut, vol, nowM: NOW, dir, futOi: (m) => 1e7 + (o.noOiRise ? 0 : Math.max(0, m - 70) * 2000), pe: o.noPuts ? {} : { 22600: puts, 22650: puts }, last: o.noAbsorption ? {} : { absorption: [{ side: 'buy', price: P + 45 }] } })
    const all = evalAt(d, NOW, dir, o)
    return { s: all.find((x) => x.id === 'buildUp'), all }
  }
  const L = build(1)
  check('#6 build-up fires LONG: futures up with OI up, puts written, pullback to VWAP', L.s?.side === 'LONG' && L.s.target > L.s.entry, brief(L.s, L.all))
  const S = build(-1)
  check('#6 build-up fires SHORT (the mirror: calls written, futures down with OI up)', S.s?.side === 'SHORT' && S.s.target < S.s.entry, brief(S.s, S.all))
  for (const dir of [1, -1]) {
    const side = dir > 0 ? 'LONG' : 'SHORT'
    check(`#6 ${side}: not without the futures OI rising`, !build(dir, { noOiRise: true }).s)
    check(`#6 ${side}: not without the price move`, !build(dir, { flat: true }).s)
    check(`#6 ${side}: not without the option writers building the same way`, !build(dir, { noPuts: true }).s)
    check(`#6 ${side}: not without absorption / a stack`, !build(dir, { noAbsorption: true }).s)
    check(`#6 ${side}: not without the tape`, !build(dir, { tapeAgainst: true }).s)
  }
}

// The previous session's profile, in futures terms, mirrored for a SHORT.
function profileOf(dir, { poc, vah, val, hvn = [], lvn = [], tpo = null }) {
  const m = (p) => mirrorLevel(p, dir)
  const [lo, hi] = dir > 0 ? [val, vah] : [m(vah), m(val)]
  return {
    vp: { poc: m(poc), vah: hi, val: lo, hvn: hvn.map(m), lvn: lvn.map(m) },
    tpoPrev: tpo && (dir > 0 ? { val: tpo.val, vah: tpo.vah, poc: tpo.poc } : { val: m(tpo.vah), vah: m(tpo.val), poc: m(tpo.poc) }),
  }
}

// ---- 12. Market profile 80% rule (10:00-14:00): opened outside the previous TPO value area (22700-22800 here),
// the last 30 minutes all inside it, ΣΔ toward the far edge, no growing wall before it -> the other edge.
{
  const NOW = 100
  const tpo80 = (dir, o = {}) => {
    const fut = (m) => (m === 0 ? (o.openInside ? 22720 : 22680) : m < 40 ? 22690 : (o.slip && m === 85 ? 22690 : 22715))
    // A growing CALL wall at 22700 (22760 in futures) - between the price and the target.
    const ce = o.wallInWay ? { 22700: (m) => 3e6 + m * 20000 } : {}
    const d = day({ fut, nowM: NOW, dir, ce })
    if (!o.openInside) d.bars[0] = dir > 0 ? { ...d.bars[0], open: 22680 } : { ...d.bars[0], open: F - 22680 }
    const profile = profileOf(dir, { poc: 22750, vah: 22800, val: 22700, tpo: { val: 22700, vah: 22800, poc: 22750 } })
    const all = evalAt(d, NOW, dir, { ...o, profile })
    return { s: all.find((x) => x.id === 'tpo80'), all }
  }
  const L = tpo80(1)
  check('#12 80% rule fires LONG: opened under the TPO value area, 30 min back inside -> the VAH', L.s?.side === 'LONG' && Math.abs(L.s.target - 22800) < 0.01, brief(L.s, L.all))
  const S = tpo80(-1)
  check('#12 80% rule fires SHORT (opened above, back inside -> the VAL)', S.s?.side === 'SHORT' && Math.abs(S.s.target - (F - 22800)) < 0.01, brief(S.s, S.all))
  for (const dir of [1, -1]) {
    const side = dir > 0 ? 'LONG' : 'SHORT'
    check(`#12 ${side}: not when the day opened inside the value area`, !tpo80(dir, { openInside: true }).s)
    check(`#12 ${side}: not when a close in the last 30 minutes was outside it`, !tpo80(dir, { slip: true }).s)
    check(`#12 ${side}: not with a growing wall before the target`, !tpo80(dir, { wallInWay: true }).s)
    check(`#12 ${side}: not without the tape`, !tpo80(dir, { tapeAgainst: true }).s)
  }
}

// ---- 13. Previous POC reaction (09:45-14:30): back at the previous POC (22710) after being 0.3%+ away, an OI
// wall there being written, absorption and the tape defending it.
{
  const NOW = 100
  const poc = (dir, o = {}) => {
    const fut = o.neverAway ? () => 22712 : (m) => (m < 85 ? 22800 : m <= 95 ? 22800 - (m - 85) * 8.8 : 22712)
    const pe = o.noWall ? {} : { 22650: (m) => 3e6 + m * 20000 }
    const d = day({ fut, nowM: NOW, dir, pe, last: o.noAbsorption ? {} : { absorption: [{ side: 'buy', price: 22712 }] } })
    const profile = profileOf(dir, { poc: 22710, vah: 22760, val: 22660, hvn: [22780] })
    const all = evalAt(d, NOW, dir, { ...o, profile })
    return { s: all.find((x) => x.id === 'pocReaction'), all }
  }
  const L = poc(1)
  check('#13 POC reaction fires LONG: back down at the previous POC, PUT wall written there, absorption', L.s?.side === 'LONG' && L.s.target > L.s.entry, brief(L.s, L.all))
  const S = poc(-1)
  check('#13 POC reaction fires SHORT (the mirror: up to the POC, CALL wall written)', S.s?.side === 'SHORT' && S.s.target < S.s.entry, brief(S.s, S.all))
  for (const dir of [1, -1]) {
    const side = dir > 0 ? 'LONG' : 'SHORT'
    check(`#13 ${side}: not when the price was never away from the POC`, !poc(dir, { neverAway: true }).s)
    check(`#13 ${side}: not without a growing OI wall at the POC`, !poc(dir, { noWall: true }).s)
    check(`#13 ${side}: not without absorption`, !poc(dir, { noAbsorption: true }).s)
    check(`#13 ${side}: not without the tape`, !poc(dir, { tapeAgainst: true }).s)
  }
}

// ---- 14. LVN run (09:30-14:30): a close through a previous-session LVN (22720) with delta and a new ΣΔ extreme,
// aggressive tape, no growing wall before the next HVN (22800) - the target.
{
  const NOW = 100
  const lvn = (dir, o = {}) => {
    const fut = (m) => (m < NOW - 1 ? 22700 : o.notCrossed ? 22715 : 22725)
    const ce = o.wallInWay ? { 22700: (m) => 3e6 + m * 20000 } : {}
    const d = day({ fut, nowM: NOW, dir, ce, last: o.noDelta ? { buy: 400, sell: 600 } : {} })
    const profile = profileOf(dir, { poc: 22800, vah: 22820, val: 22600, hvn: [22800], lvn: [22720] })
    const all = evalAt(d, NOW, dir, { ...o, profile })
    return { s: all.find((x) => x.id === 'lvnRun'), all }
  }
  const L = lvn(1)
  check('#14 LVN run fires LONG: closed up through the LVN, target the next HVN', L.s?.side === 'LONG' && Math.abs(L.s.target - 22800) < 0.01, brief(L.s, L.all))
  const S = lvn(-1)
  check('#14 LVN run fires SHORT (the mirror: down through it)', S.s?.side === 'SHORT' && Math.abs(S.s.target - (F - 22800)) < 0.01, brief(S.s, S.all))
  for (const dir of [1, -1]) {
    const side = dir > 0 ? 'LONG' : 'SHORT'
    check(`#14 ${side}: not when the close did not cross the LVN`, !lvn(dir, { notCrossed: true }).s)
    check(`#14 ${side}: not with a growing wall before the HVN`, !lvn(dir, { wallInWay: true }).s)
    check(`#14 ${side}: not without delta with it`, !lvn(dir, { noDelta: true }).s)
    check(`#14 ${side}: not without aggressive tape`, !lvn(dir, { tapeAgainst: true }).s)
  }
}

console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
