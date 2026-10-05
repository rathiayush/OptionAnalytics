// Trailing stop, last entry 14:45 and the 15:10 square-off.
// Run: npm test (node --test) - see CLAUDE.md.
import { simulateOutcome, trailedStop, squareOffMs, exitLabel, LAST_ENTRY, SQUARE_OFF } from '../src/strategyEngine.js'
const MIN = 60000
const at = (h, m) => Date.parse(`2026-09-25T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+05:30`)
let fails = 0
const ok = (c, msg) => { if (!c) { fails++; console.log('FAIL', msg) } else console.log('ok  ', msg) }
const bar = (t, o, h, l, c) => ({ time: new Date(t).toISOString(), open: o, high: h, low: l, close: c })
// LONG at 100, stop 90 (risk 10), target 130, trail after +1R, 1R behind.
const base = { side: 'LONG', t: at(10, 0), entry: 100, stop: 90, target: 130, timeStopMs: at(12, 0) }
const trail = { startR: 1, gapR: 1 }
const run = (setup, bars, until = at(16, 0), dayOver = true) => simulateOutcome(setup, bars, until, dayOver)
// 1. Up to 115 (1.5R), then back down to 100: trail stop = 105 -> exit +0.5R
const b1 = [bar(at(10,1),100,108,99,107), bar(at(10,2),107,115,106,112), bar(at(10,3),112,112,104,104)]
let o = run({ ...base, trail }, b1)
ok(o.status === 'win' && Math.abs(o.r - 0.5) < 1e-9 && o.trailed && o.stop === 105 && exitLabel(o) === 'Trailing SL hit', `trail locks +0.5R: ${JSON.stringify(o)}`)
// Same without trail: no stop hit (low 104 > 90) -> stays open until time stop
o = run(base, b1, at(10, 4), false)
ok(o.status === 'open' && !o.trailed && o.stop === 90, 'fixed stop does not move')
// 2. Reaches exactly +1R then back to entry -> breakeven (flat)
const b2 = [bar(at(10,1),100,110,99,108), bar(at(10,2),108,108,99,100)]
o = run({ ...base, trail }, b2)
ok(o.status === 'flat' && Math.abs(o.r) < 1e-9 && exitLabel(o) === 'Trailing SL hit', `breakeven at +1R: ${JSON.stringify(o)}`)
// 3. Same bar touches target and trail: trail stop is from previous bars only
const b3 = [bar(at(10,1),100,125,99,124), bar(at(10,2),124,131,114,120)]
o = run({ ...base, trail }, b3)
ok(o.status === 'win' && Math.abs(o.r - 1.5) < 1e-9 && o.stopHit && o.stop === 115, `stop (115) counted first when one bar touches both: ${JSON.stringify(o)}`)
// 4. SHORT trail mirror
const s = { side: 'SHORT', t: at(10,0), entry: 100, stop: 110, target: 70, timeStopMs: at(12,0), trail }
o = run(s, [bar(at(10,1),100,101,88,90), bar(at(10,2),90,99,89,98)])
ok(o.stopHit && o.stop === 98 && Math.abs(o.r - 0.2) < 1e-9, `short trails down: ${JSON.stringify(o)}`)
ok(trailedStop(s, 95) === 110 && trailedStop(s, 90) === 100, 'short: no trail before +1R, breakeven at +1R')
// 5. 15:10 cut-off: a setup with a time stop past 15:10 closes on the 15:09 bar
const late = { ...base, t: at(14, 40), timeStopMs: at(16, 0), trail }
const lateBars = []; for (let m = 41; m <= 79; m++) lateBars.push(bar(at(14, 0) + m * MIN, 100, 102, 98, 101))
o = run(late, lateBars)
ok(o.timeStop && o.squareOff && o.exitAt === at(15, 9) && exitLabel(o) === '15:10 square-off', `closed at 15:10: ${JSON.stringify({ ...o, exitAt: new Date(o.exitAt).toISOString() })}`)
ok(squareOffMs(at(11, 23) + 17000) === at(15, 10), 'squareOffMs is 15:10 of the same day')
ok(LAST_ENTRY === 14 * 60 + 45 && SQUARE_OFF === 15 * 60 + 10, 'last entry 14:45, square-off 15:10')
// 6. "Let winners run" (trail.runner): past the 130 target and the 12:00 time stop, out only on the trail.
const runBars = [bar(at(10,1),100,131,99,130), bar(at(10,2),130,150,129,149), bar(at(12,30),149,160,150,158), bar(at(12,31),158,158,148,149)]
o = run({ ...base, trail: { ...trail, runner: true } }, runBars)
ok(o.stopHit && o.trailed && o.stop === 150 && Math.abs(o.r - 5) < 1e-9 && exitLabel(o) === 'Trailing SL hit', `runner: through the target and the time stop, out on the trail at +5R: ${JSON.stringify(o)}`)
o = run({ ...base, trail }, runBars)
ok(o.status === 'win' && Math.abs(o.r - 3) < 1e-9, 'without it: the same move ends at the 130 target (+3R)')
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
