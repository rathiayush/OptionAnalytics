// Footprint absorption / exhaustion (analyzeBars): only the real thing, not every bar with thin tails.
// Run: npm test (node --test) - see CLAUDE.md.
import { analyzeBars } from '../src/orderFlowMath.js'

let fails = 0
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ` ${extra}`}`); if (!cond) fails++ }

// A bar over 1-point rows from `low` to `high`: volume bell-shaped around `center`, each row split
// buy / sell by `buyShare(price)`.
function bar(time, { low, high, open, close, center = (low + high) / 2, width = (high - low) / 3, peak = 400, buyShare = () => 0.5, tweak = null }) {
  const levels = []
  for (let p = low; p <= high; p++) {
    const v = Math.max(4, Math.round(peak * Math.exp(-(((p - center) / width) ** 2))))
    const buy = Math.round(v * buyShare(p))
    levels.push({ price: p, buy, sell: v - buy })
  }
  if (tweak) tweak(levels)
  const buy = levels.reduce((s, l) => s + l.buy, 0)
  const sell = levels.reduce((s, l) => s + l.sell, 0)
  return { time, open, high, low, close, buy, sell, delta: buy - sell, volume: buy + sell, levels }
}
const analyze = (bars) => analyzeBars(bars, { rowSize: 1, minVolume: 1 })
const t = (m) => Date.parse('2026-10-05T04:00:00Z') + m * 300_000

// 1. Ordinary wide bars - thin tails at both ends (what the screenshot showed EXH on, both ends, every bar).
{
  const bars = [
    bar(t(0), { low: 22640, high: 22665, open: 22650, close: 22660 }),
    bar(t(1), { low: 22650, high: 22690, open: 22660, close: 22684 }),
    bar(t(2), { low: 22678, high: 22712, open: 22684, close: 22700 }),
  ]
  const a = analyze(bars)
  const flagged = a.map((b) => `${b.exhaustion.map((e) => e.side).join('+') || '-'}/${b.absorption.map((e) => e.side).join('+') || '-'}`)
  check('ordinary trending bars with thin tails: no exhaustion / absorption', a.every((b) => !b.exhaustion.length && !b.absorption.length), flagged.join(' '))
}
// 2. Real buying exhaustion: a new high where buying dried up at the top and the bar closed well off it.
{
  const prev = bar(t(0), { low: 22650, high: 22690, open: 22655, close: 22685 })
  const exhausted = bar(t(1), {
    low: 22675, high: 22705, open: 22685, close: 22684, center: 22688,
    tweak: (levels) => { const top = levels.at(-1); top.buy = 1; top.sell = 6; levels.at(-2).buy = 30; levels.at(-3).buy = 40; levels.at(-4).buy = 40 },
  })
  const a = analyze([prev, exhausted])
  check('buying exhaustion at a new high, closed off it: flagged (bearish)', a[1].exhaustion.some((e) => e.side === 'sell'), JSON.stringify(a[1].exhaustion))
  // The same bar but it did NOT make a new high (stayed under the previous high) - not exhaustion.
  const lower = bar(t(1), { low: 22660, high: 22688, open: 22670, close: 22668, center: 22672, tweak: (levels) => { const top = levels.at(-1); top.buy = 1; top.sell = 6; levels.at(-2).buy = 30 } })
  check('...not when the bar did not reach past the previous high', !analyze([prev, lower])[1].exhaustion.some((e) => e.side === 'sell'))
  // ...nor when it closed at the high (buyers still in control).
  const atHigh = bar(t(1), { low: 22675, high: 22705, open: 22680, close: 22704, center: 22688, tweak: (levels) => { const top = levels.at(-1); top.buy = 1; top.sell = 6; levels.at(-2).buy = 30 } })
  check('...nor when it closed at the high', !analyze([prev, atHigh])[1].exhaustion.some((e) => e.side === 'sell'))
}
// 3. Real selling absorption: a new low hit with heavy selling at the bottom, bar closed well up.
{
  const prev = bar(t(0), { low: 22660, high: 22690, open: 22685, close: 22665 })
  const absorbed = bar(t(1), {
    low: 22645, high: 22672, open: 22662, close: 22668, center: 22660,
    tweak: (levels) => { levels[0].sell = 900; levels[0].buy = 120; levels[1].sell = 800; levels[1].buy = 150 },
  })
  const a = analyze([prev, absorbed])
  check('selling absorbed at a new low, bar closed well up: flagged (bullish)', a[1].absorption.some((x) => x.side === 'buy'), JSON.stringify(a[1].absorption))
  const closedLow = bar(t(1), { low: 22645, high: 22672, open: 22670, close: 22647, center: 22660, tweak: (levels) => { levels[0].sell = 900; levels[1].sell = 800 } })
  check('...not when the bar closed at the low (sellers won)', !analyze([prev, closedLow])[1].absorption.some((x) => x.side === 'buy'))
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
