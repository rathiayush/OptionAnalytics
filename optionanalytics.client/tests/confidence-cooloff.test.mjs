// Smart confidence (options OI + futures OI + price action parts) and the cool-off: a setup whose price
// ran too far too fast into it is held and entered on the pullback / pause, never at the spike.
// Run: npm test (node --test) - see CLAUDE.md.
import { paceOf, confluenceParts, coolOffGate, gradeOf, confidenceText, COOL_OFF_MAX_MS } from '../src/strategyEngine.js'

let fails = 0
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ` ${extra}`}`); if (!cond) fails++ }
const MIN = 60_000
const T = Date.parse('2026-10-05T05:00:00Z') // 10:30 IST
const bar = (m, o, h, l, c) => ({ time: T + m * MIN, open: o, high: h, low: l, close: c })
// 14 quiet bars (10-pt range), then whatever the test adds.
const quiet = Array.from({ length: 14 }, (_, i) => bar(i - 14, 22700, 22705, 22695, 22700))

// ---- pace ----
{
  const ran = [...quiet, bar(0, 22700, 22715, 22698, 22714), bar(1, 22714, 22730, 22712, 22728), bar(2, 22728, 22745, 22726, 22744)]
  const p = paceOf(ran, 22746, 1)
  check('a 48-pt run in 3 min (avg range ~11) is too fast for a LONG', p.fast && Math.abs(p.run - 48) < 0.01, JSON.stringify(p))
  check('...but not "too fast" for a SHORT (it ran the other way)', !paceOf(ran, 22746, -1).fast)
  check('a normal 3-min move is not too fast', !paceOf([...quiet, bar(0, 22700, 22708, 22698, 22706)], 22707, 1).fast)
}
// ---- confidence parts ----
{
  const bars = [bar(0, 22700, 22706, 22698, 22704), bar(1, 22704, 22710, 22700, 22708), bar(2, 22708, 22714, 22703, 22712)]
  const longBuild = { pricePct: 0.003, oiPct: 0.01 }
  const L = confluenceParts(1, { futures: longBuild, price: 22712, vwap: 22690, bars })
  const S = confluenceParts(-1, { futures: longBuild, price: 22712, vwap: 22690, bars })
  const sum = (ps) => ps.reduce((a, p) => a + p.points, 0)
  check('LONG with futures long build-up, above VWAP, higher lows: +6 +3 +3', sum(L) === 12 && L.some((p) => p.name === 'futures long build-up' && p.points === 6), JSON.stringify(L))
  check('SHORT into the same: -6 -3 -3', sum(S) === -12, JSON.stringify(S))
  const cover = confluenceParts(1, { futures: { pricePct: 0.003, oiPct: -0.01 }, price: 22712, vwap: null, bars: [] })
  check('short covering backs a LONG less (+3)', cover.length === 1 && cover[0].points === 3 && /short covering/.test(cover[0].name))
  check('a flat futures move adds nothing', confluenceParts(1, { futures: { pricePct: 0.0001, oiPct: 0.02 }, price: 1, vwap: null, bars: [] }).length === 0)
  check('grades: 75+ High, 60+ Medium, else Low', gradeOf(80) === 'High' && gradeOf(75) === 'High' && gradeOf(70) === 'Medium' && gradeOf(59) === 'Low')
  check('text lists each part', confidenceText(72, [{ name: 'strategy', points: 60 }, ...L]) === '72% Medium - strategy 60 · futures long build-up +6 · price above VWAP +3 · higher lows +3')
}
// ---- cool-off gate ----
const signal = (over = {}) => ({
  id: 'wallBreak', name: 'x', side: 'LONG', t: T + 3 * MIN, entry: 22746, stop: 22726, target: 22800, timeStopMs: T + 23 * MIN,
  confidence: 70, confidenceParts: [{ name: 'strategy', points: 70 }], checks: { Confidence: 'x' },
  coolOff: { run: 48, atr: 11, extreme: 22746 }, ...over,
})
const ran = [...quiet, bar(0, 22700, 22715, 22698, 22714), bar(1, 22714, 22730, 22712, 22728), bar(2, 22728, 22745, 22726, 22744)]
{
  const pending = new Map()
  const plain = signal({ id: 'iceberg', coolOff: undefined })
  delete plain.coolOff
  const g0 = coolOffGate(pending, [plain, signal()], { nowMs: T + 3 * MIN, price: 22746, bars: ran, oi: null })
  check('a setup not chased fires at once; the spike one is held', g0.fire.length === 1 && g0.fire[0].id === 'iceberg' && pending.size === 1)
  // Still running up: no entry.
  const up = [...ran, bar(3, 22744, 22756, 22743, 22755)]
  const g1 = coolOffGate(pending, [], { nowMs: T + 4 * MIN, price: 22755, bars: up, oi: null })
  check('still running: not entered', g1.fire.length === 0 && pending.size === 1)
  // Pulls back 35% of the run (48 * 0.35 = 16.8) from the 22756 peak -> 22738.
  const back = [...up, bar(4, 22755, 22756, 22737, 22738)]
  const g2 = coolOffGate(pending, [], { nowMs: T + 5 * MIN, price: 22738, bars: back, oi: null })
  const s = g2.fire[0]
  check('pulled back: entered at the pullback price, target kept, stop at the setup\'s level or 1.2x the 1-min range if that is wider', s && s.entry === 22738 && s.stop < 22726 && Math.abs(22738 - s.stop - 1.2 * (back.slice(-14).reduce((a, b) => a + b.high - b.low, 0) / 14)) < 1e-9 && s.target === 22800 && s.t === T + 5 * MIN && pending.size === 0, JSON.stringify(s))
  check('...noted: signal time and price, Pace text, +3 for the cool-off', s && s.signal.entry === 22746 && /pullback of 18\.0 pts/.test(s.checks.Pace) && s.confidence === 73 && /cool-off \+3/.test(s.checks.Confidence) && !('coolOff' in s), JSON.stringify(s?.checks))
}
{
  // Pause: two bars after the signal without a new high (and not running) -> entered.
  const pending = new Map()
  coolOffGate(pending, [signal()], { nowMs: T + 3 * MIN, price: 22746, bars: ran, oi: null })
  const flat = [...ran, bar(3, 22744, 22746, 22738, 22742), bar(4, 22742, 22745, 22737, 22741)]
  const g = coolOffGate(pending, [], { nowMs: T + 5 * MIN, price: 22741, bars: flat, oi: null })
  check('paused 2 bars under the high: entered', g.fire.length === 1 && /pause/.test(g.fire[0].checks.Pace), JSON.stringify(g))
  // Only one bar so far: still waiting.
  const p2 = new Map()
  coolOffGate(p2, [signal()], { nowMs: T + 3 * MIN, price: 22746, bars: ran, oi: null })
  check('...not after one bar', coolOffGate(p2, [], { nowMs: T + 4 * MIN, price: 22744, bars: flat.slice(0, -1), oi: null }).fire.length === 0)
}
{
  // Ran on to the target: dropped. Never cooled in 10 min: dropped. Through the stop: dropped.
  const mk = () => { const m = new Map(); coolOffGate(m, [signal()], { nowMs: T + 3 * MIN, price: 22746, bars: ran, oi: null }); return m }
  let m = mk()
  let g = coolOffGate(m, [], { nowMs: T + 6 * MIN, price: 22801, bars: [...ran, bar(3, 22744, 22802, 22744, 22801)], oi: null })
  check('ran to the target first: dropped, not chased', !g.fire.length && g.dropped[0]?.reason.includes('target') && m.size === 0)
  m = mk()
  const climb = [...ran]; for (let i = 3; i < 15; i++) climb.push(bar(i, 22744 + (i - 3) * 4, 22748 + (i - 3) * 4, 22743 + (i - 3) * 4, 22747 + (i - 3) * 4))
  g = coolOffGate(m, [], { nowMs: T + 3 * MIN + COOL_OFF_MAX_MS + MIN, price: 22790, bars: climb, oi: null })
  check('no cool-off within 10 min: dropped', !g.fire.length && g.dropped[0]?.reason.includes('time'))
  m = mk()
  g = coolOffGate(m, [], { nowMs: T + 5 * MIN, price: 22720, bars: [...ran, bar(3, 22744, 22745, 22719, 22720)], oi: null })
  check('fell back through the stop: dropped', !g.fire.length && g.dropped[0]?.reason.includes('stop'))
  // A pullback that leaves under 1.2R of room is dropped too.
  m = new Map(); coolOffGate(m, [signal({ stop: 22700, target: 22760 })], { nowMs: T + 3 * MIN, price: 22746, bars: ran, oi: null })
  g = coolOffGate(m, [], { nowMs: T + 5 * MIN, price: 22729, bars: [...ran, bar(3, 22744, 22747, 22728, 22729)], oi: null })
  check('not enough room left: dropped', !g.fire.length && g.dropped[0]?.reason.includes('room'), JSON.stringify(g))
  // The same held setup reported again while waiting keeps its first signal.
  m = mk()
  coolOffGate(m, [signal({ t: T + 4 * MIN, entry: 22755 })], { nowMs: T + 4 * MIN, price: 22755, bars: ran, oi: null })
  check('reported again while held: keeps the first signal', m.size === 1 && [...m.values()][0].setup.t === T + 3 * MIN)
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
