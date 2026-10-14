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
// 7. The trail in futures POINTS (unit 'pts'): LONG 100, stop 90 - after +8 pts it follows 3 pts behind.
{
  const pts = { unit: 'pts', startPts: 8, gapPts: 3 }
  ok(trailedStop({ ...base, trail: pts }, 107) === 90 && trailedStop({ ...base, trail: pts }, 108) === 105 && trailedStop({ ...base, trail: pts }, 115) === 112, 'points: none before +8, then 3 pts behind the best')
  const b7 = [bar(at(10,1),100,108,99,107), bar(at(10,2),107,115,106,114), bar(at(10,3),114,114,104,105)]
  o = run({ ...base, trail: pts }, b7)
  ok(o.stopHit && o.trailed && o.stop === 112 && Math.abs(o.r - 1.2) < 1e-9, `points trail locks +12 pts (1.2R): ${JSON.stringify(o)}`)
  const sp = { side: 'SHORT', t: at(10,0), entry: 100, stop: 110, target: 70, timeStopMs: at(12,0), trail: pts }
  ok(trailedStop(sp, 93) === 110 && trailedStop(sp, 90) === 93, 'points: short mirror')
  ok(trailedStop({ ...base, trail: { unit: 'pts', startPts: 20, gapPts: 25 } }, 125) === 100, 'points over the old 5 limit work (start 20, follow 25)')
  ok(trailedStop({ ...base, trail: { unit: 'pts', startPts: 5, gapPts: 0 } }, 130) === 90, 'points with no distance: a fixed stop')
  ok(trailedStop({ ...base, trail: { startR: 10, gapR: 8 } }, 200) === 120, 'R over the old 5 limit (start 10R, follow 8R)')
}
// 8. The trail changed MID-TRADE (setup.trailLog): it applies from the change on, the stop only tightens, and
// what already happened is not rewritten.
{
  const pts = { unit: 'pts', startPts: 8, gapPts: 3 }
  const tight = { unit: 'pts', startPts: 8, gapPts: 1 }
  const wide = { unit: 'pts', startPts: 8, gapPts: 6 }
  // Best 115 by 10:02 with a 3-pt trail (stop 112). At 10:03 the trader tightens it to 1 pt: the stop is 114 at once.
  const bars8 = [bar(at(10,1),100,108,99,107), bar(at(10,2),107,115,106,114)]
  const change = (trail) => [{ t: at(10, 3), trail }]
  o = run({ ...base, trail: pts }, bars8, at(10, 3) + 20000, false)
  ok(o.status === 'open' && o.stop === 112, `before the change: stop 112: ${JSON.stringify(o)}`)
  o = run({ ...base, trail: pts, trailLog: change(tight) }, bars8, at(10, 3) + 20000, false)
  ok(o.status === 'open' && o.stop === 114 && o.trailed, `tightened to 1 pt at 10:03: the stop is 114 at once: ${JSON.stringify(o)}`)
  // ...and the next bar's dip to 113.5 now stops it at 114 (the old 3-pt trail, stop 112, would have held).
  const more = [...bars8, bar(at(10,3),114,114.5,113.5,114)]
  o = run({ ...base, trail: pts, trailLog: change(tight) }, more)
  ok(o.stopHit && o.stop === 114 && Math.abs(o.r - 1.4) < 1e-9, `the tighter trail closes it at 114 (+1.4R): ${JSON.stringify(o)}`)
  o = run({ ...base, trail: pts }, more, at(10, 4), false)
  ok(o.status === 'open' && o.stop === 112, 'without the change the same bar leaves it open (stop 112)')
  // A change made at 10:02 tightens the stop at once (107 = best 108 - 1) - the 10:02 bar's dip to 106 stops it.
  o = run({ ...base, trail: pts, trailLog: [{ t: at(10, 2), trail: tight }] }, [bar(at(10,1),100,108,99,107), bar(at(10,2),107,107.5,106,107)], at(10, 4), false)
  ok(o.stopHit && o.stop === 107, `tightened at 10:02: stop 107 at once, hit by the 10:02 bar: ${JSON.stringify(o)}`)
  // Made at 10:03 instead, the same 10:02 bar is judged with the old 3-pt trail (stop 105): not closed.
  o = run({ ...base, trail: pts, trailLog: [{ t: at(10, 3), trail: tight }] }, [bar(at(10,1),100,108,99,107), bar(at(10,2),107,107.5,106,107)], at(10, 3), false)
  ok(o.status === 'open', `tightened at 10:03: the earlier bar is not judged again with it: ${JSON.stringify(o)}`)
  // Widening never loosens a stop already earned.
  o = run({ ...base, trail: pts, trailLog: change(wide) }, bars8, at(10, 3) + 20000, false)
  ok(o.stop === 112, `widened to 6 pts: the stop stays 112, never loosens: ${JSON.stringify(o)}`)
  // Trail off (null) from 10:03: the earned stop stays, nothing more is trailed.
  o = run({ ...base, trail: pts, trailLog: change(null) }, [...bars8, bar(at(10,3),114,129,113,128)], at(10, 4), false)
  ok(o.status === 'open' && o.stop === 112, `trail turned off: stop stays 112 while price runs to 130: ${JSON.stringify(o)}`)
  // Turned ON mid-trade for a setup that fired without one.
  o = run({ ...base, trail: undefined, trailLog: change(pts) }, bars8, at(10, 3) + 20000, false)
  ok(o.stop === 112 && o.trailed, `turned on at 10:03: the stop moves to 112 at once: ${JSON.stringify(o)}`)
  // A change dated before the setup, or after the replay clock, is ignored.
  o = run({ ...base, trail: pts, trailLog: [{ t: at(9, 0), trail: tight }, { t: at(10, 30), trail: tight }] }, bars8, at(10, 3), false)
  ok(o.stop === 112, 'changes before the signal / after the clock do nothing')
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
