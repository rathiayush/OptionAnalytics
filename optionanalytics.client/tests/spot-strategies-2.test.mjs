// The option-chain spot strategies #105-#107 (spotEngine.js): fresh writing in the OI heatmap, the since-open CE / PE
// flip, and the S/R OI ladder. Each fires on its rules - LONG and SHORT - and not when each key condition is missing.
// Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildOiContext } from '../src/strategyEngine.js'
import { evaluateSpotStrategies, spotBarsOf } from '../src/spotEngine.js'

const MIN = 60_000
const T = Date.parse('2026-10-09T03:45:00Z') // 09:15 IST
const iso = (m) => new Date(T + m * MIN).toISOString()
const STRIKES = [22300, 22350, 22400, 22450, 22500, 22550, 22600, 22650, 22700]
const ramp = (m) => Math.max(0, m - 74) // the last 15 minutes before the clock at minute 90

function world({ candle, ce, pe, minutes = 91 }) {
  const spot = Array.from({ length: minutes }, (_, m) => ({ time: iso(m), ...candle(m) }))
  const points = (f) => spot.flatMap((_, m) => STRIKES.map((k) => ({ time: iso(m), strike: k, openInterest: Math.round(f(k, m)), price: 60 })))
  return { oi: buildOiContext({ success: true, date: '2026-10-09', step: 50, cePoints: points(ce), pePoints: points(pe), futuresBars: [], spotCandlesOneMinute: spot }, null, { live: false }), bars: spotBarsOf(spot) }
}
const fires = (w, id, side, minute = 90) => {
  const nowMs = T + minute * MIN
  return evaluateSpotStrategies({ nowMs, bars: w.bars.filter((b) => b.t + MIN <= nowMs), oi: w.oi }).some((s) => s.id === id && s.side === side)
}
const c = (open, close, pad = 3) => ({ open, close, high: Math.max(open, close) + pad, low: Math.min(open, close) - pad })
const around = (level, last) => (m) => (m < 89 ? c(level + ((m % 4) - 1.5), level + (((m + 1) % 4) - 1.5)) : last)
const flat = () => 2e6

test('#105 fresh writing: the hottest heatmap strike on the trade\'s side at / under the price, the other side covering', () => {
  // LONG: puts written at 22500 (+3% in 15m) under the price 22512; calls at 22550 / 22600 covered (-1.5%).
  const peWrite = (k, m, rate = 0.002) => 2e6 * (k === 22500 ? 1 + rate * ramp(m) : 1)
  const ceCover = (k, m) => 2e6 * (k === 22550 || k === 22600 ? 1 - 0.001 * ramp(m) : 1)
  const long = (o = {}) => world({ candle: around(22510, c(22508, 22512)), ce: ceCover, pe: peWrite, ...o })
  assert.ok(fires(long(), 'spotFreshWriting', 'LONG'))
  assert.ok(!fires(long({ pe: (k, m) => peWrite(k, m, 0.0007) }), 'spotFreshWriting', 'LONG'), 'only +1%: no fresh writing')
  assert.ok(!fires(long({ ce: flat }), 'spotFreshWriting', 'LONG'), 'the calls above are not being covered')
  assert.ok(!fires(long({ candle: around(22510, c(22512, 22508)) }), 'spotFreshWriting', 'LONG'), 'the price is not ticking on with it')
  assert.ok(!fires(long({ pe: (k, m) => 2e6 * (k === 22550 ? 1 + 0.002 * ramp(m) : 1) }), 'spotFreshWriting', 'LONG'), 'the puts are written over the price, not under it')
  // SHORT: calls written at 22500 over the price 22488; puts at 22450 / 22400 covered.
  const ceWrite = (k, m) => 2e6 * (k === 22500 ? 1 + 0.002 * ramp(m) : 1)
  const peCover = (k, m) => 2e6 * (k === 22450 || k === 22400 ? 1 - 0.001 * ramp(m) : 1)
  const short = (o = {}) => world({ candle: around(22490, c(22492, 22488)), ce: ceWrite, pe: peCover, ...o })
  assert.ok(fires(short(), 'spotFreshWriting', 'SHORT'))
  assert.ok(!fires(short({ pe: flat }), 'spotFreshWriting', 'SHORT'))
  assert.ok(!fires(short({ candle: around(22490, c(22488, 22492)) }), 'spotFreshWriting', 'SHORT'))
})

test('#106 since-open flip: puts added since the open overtake calls (or the reverse) in the last 10 minutes', () => {
  // LONG: calls added steadily all day; puts nothing until minute 80, then fast - they overtake by minute 89.
  const callsAll = (k, m) => 2e6 * (1 + 0.0002 * m)
  const putsLate = (k, m, rate = 0.006) => 2e6 * (1 + rate * Math.max(0, m - 79))
  const up = (m) => { const x = (y) => 22480 + y * 0.35; return c(x(m), x(m + 1), 2) }
  const long = (o = {}) => world({ candle: up, ce: callsAll, pe: putsLate, ...o })
  assert.ok(fires(long(), 'spotCumFlip', 'LONG'))
  assert.ok(!fires(long({ candle: (m) => { const x = (y) => 22540 - y * 0.35; return c(x(m), x(m + 1), 2) } }), 'spotCumFlip', 'LONG'), 'the price is below the day\'s open')
  assert.ok(!fires(long({ pe: (k, m) => 2e6 * (1 + 0.0006 * m) }), 'spotCumFlip', 'LONG'), 'the puts led all day: no flip in the last 10 minutes')
  assert.ok(!fires(long({ pe: (k, m) => putsLate(k, m, 0.0019) }), 'spotCumFlip', 'LONG'), 'the puts barely overtook: under 0.2% of the chain')
  // SHORT: the mirror - calls overtake the puts; the price below the open.
  const down = (m) => { const x = (y) => 22540 - y * 0.35; return c(x(m), x(m + 1), 2) }
  const short = (o = {}) => world({ candle: down, ce: (k, m) => putsLate(k, m), pe: callsAll, ...o })
  assert.ok(fires(short(), 'spotCumFlip', 'SHORT'))
  assert.ok(!fires(short({ candle: up }), 'spotCumFlip', 'SHORT'))
  assert.ok(!fires(short({ ce: (k, m) => 2e6 * (1 + 0.0006 * m) }), 'spotCumFlip', 'SHORT'))
})

test('#107 S/R OI ladder: support OI outgrowing resistance OI, the price in the lower half, a candle turning', () => {
  // LONG: puts on 22350 / 22400 (the put wall) / 22450 grow 18% in 15m; calls on 22500 / 22550 / 22600 (the call wall) flat.
  const peLadder = (k, m, rate = 0.012) => (k === 22400 ? 3.5e6 : k === 22350 || k === 22450 ? 3e6 : 2e6) * (k >= 22350 && k <= 22450 ? 1 + rate * ramp(m) : 1)
  const ceWall = (k) => (k === 22600 ? 4e6 : 2e6)
  const long = (o = {}) => world({ candle: around(22470, c(22466, 22471, 2)), ce: ceWall, pe: peLadder, ...o })
  assert.ok(fires(long(), 'spotLadder', 'LONG'))
  assert.ok(!fires(long({ pe: (k, m) => peLadder(k, 89) }), 'spotLadder', 'LONG'), 'the support OI did not grow against the resistance')
  assert.ok(!fires(long({ candle: around(22470, c(22471, 22466, 2)) }), 'spotLadder', 'LONG'), 'a bearish candle')
  assert.ok(!fires(long({ candle: around(22520, c(22516, 22521, 2)) }), 'spotLadder', 'LONG'), 'the price is in the upper half between the walls')
  assert.ok(!fires(long({ pe: (k, m) => (k === 22400 ? 2.3e6 : 2e6) * (k >= 22350 && k <= 22450 ? 1 + 0.012 * ramp(m) : 1) }), 'spotLadder', 'LONG'), 'support under 1.3x the resistance')
  // SHORT: calls on 22550 / 22600 (the call wall) / 22650 grow; puts on 22400 (the put wall) / 22450 / 22500 flat.
  const ceLadder = (k, m) => (k === 22600 ? 3.5e6 : k === 22550 || k === 22650 ? 3e6 : 2e6) * (k >= 22550 && k <= 22650 ? 1 + 0.012 * ramp(m) : 1)
  const peWall = (k) => (k === 22400 ? 4e6 : 2e6)
  const short = (o = {}) => world({ candle: around(22530, c(22534, 22529, 2)), ce: ceLadder, pe: peWall, ...o })
  assert.ok(fires(short(), 'spotLadder', 'SHORT'))
  assert.ok(!fires(short({ ce: (k) => ceLadder(k, 89) }), 'spotLadder', 'SHORT'))
  assert.ok(!fires(short({ candle: around(22530, c(22529, 22534, 2)) }), 'spotLadder', 'SHORT'))
  assert.ok(!fires(short({ candle: around(22480, c(22484, 22479, 2)) }), 'spotLadder', 'SHORT'), 'in the lower half')
})
