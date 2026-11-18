// Footprint absorption / exhaustion (analyzeBars): only the real thing, not every bar with thin tails.
// Run: npm test (node --test) - see CLAUDE.md.
import { analyzeBars, autoBigLots, pullStackSignals } from '../src/orderFlowMath.js'

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
// 4. Imbalances need real volume: a thin row's few lots against nothing is not one; a heavy row is.
{
  const mkBar = (levels) => {
    const buy = levels.reduce((s, l) => s + l.buy, 0), sell = levels.reduce((s, l) => s + l.sell, 0)
    return { time: t(0), open: 100, high: 104, low: 100, close: 103, buy, sell, delta: buy - sell, volume: buy + sell, levels }
  }
  const rows = (top) => [{ price: 100, buy: 200, sell: 200 }, { price: 101, buy: 200, sell: 200 }, { price: 102, buy: 200, sell: 200 }, { price: 103, buy: 200, sell: 0 }, top]
  // 104: 3 bought vs 0 sold at 103 -> ratio infinite but only 3 contracts (avg row ~ 320).
  const thin = analyzeBars([mkBar(rows({ price: 104, buy: 3, sell: 0 }))], { rowSize: 1, minVolume: 1 })[0]
  check('thin row (3 vs 0) is not an imbalance', thin.imbalances.get(104) !== 'buy', JSON.stringify([...thin.imbalances]))
  const heavy = analyzeBars([mkBar(rows({ price: 104, buy: 900, sell: 0 }))], { rowSize: 1, minVolume: 1 })[0]
  check('heavy row (900 vs 0 under it) is a buy imbalance', heavy.imbalances.get(104) === 'buy', JSON.stringify([...heavy.imbalances]))
}
// 5. Big orders, automatic: the top 2.5% of prints, rounded up, never under 5 lots.
{
  const prints = (lots) => lots.map((q, i) => ({ seq: i, quantity: q * 75 }))
  const quiet = prints(Array.from({ length: 1000 }, (_, i) => (i % 40 === 0 ? 12 : 1 + (i % 3))))
  check('quiet tape (1-3 lots, a 12-lot print 1 in 40): big = 15 lots', autoBigLots(quiet, 75) === 15, autoBigLots(quiet, 75))
  const busy = prints(Array.from({ length: 1000 }, (_, i) => (i % 25 === 0 ? 60 : 5 + (i % 10))))
  check('busy tape (5-14 lots, 60-lot prints 1 in 25): big = 75 lots', autoBigLots(busy, 75) === 75, autoBigLots(busy, 75))
  check('tiny prints only: floor of 5 lots', autoBigLots(prints(Array(500).fill(1)), 75) === 5)
  check('too few prints to judge: none', autoBigLots(prints([50, 60]), 75) === null)
}
// 6. PULL / STACK: resting orders taken away from, or added to, the book away from the touch.
//    (It used to return a `pressure` readout as well - the Order Flow tape's one-line book read - which
//    was removed on request; the signals themselves are what the heatmap's pills show.)
{
  const LOT = 65
  const rows = (from, to, qty) => Array.from({ length: to - from + 1 }, (_, i) => [from + i, qty(from + i)])
  // 40 columns 2s apart: 20 bid rows under 25399 and 20 offer rows over 25400, 650 (10 lots) each.
  // From column 20: four bid rows inside the band go to 0 (pulled) and four offer rows double (stacked).
  const columns = Array.from({ length: 40 }, (_, i) => ({
    t: 1_000_000 + i * 2000,
    bids: rows(25380, 25399, (p) => (i >= 20 && p >= 25389 && p <= 25392 ? 0 : 650)),
    asks: rows(25400, 25419, (p) => (i >= 20 && p >= 25405 && p <= 25408 ? 1300 : 650)),
  }))
  const out = pullStackSignals({ columns, rowSize: 1, lotSize: LOT })
  const kinds = out.signals.map((s) => `${s.side} ${s.kind}`)
  check('bids pulled away from the touch is a signal', kinds.includes('bid Liquidity pulled'), JSON.stringify(kinds))
  check('offers added away from the touch is a signal', kinds.includes('ask Liquidity stacked'), JSON.stringify(kinds))
  const pulled = out.signals.find((s) => s.side === 'bid' && s.kind === 'Liquidity pulled')
  const stacked = out.signals.find((s) => s.side === 'ask' && s.kind === 'Liquidity stacked')
  check('bids pulled = support withdrawn (bearish)', pulled?.bullish === false && /40 lots .* pulled/.test(pulled?.text ?? ''), pulled?.text)
  check('offers stacked = resistance building (bearish)', stacked?.bullish === false && /40 lots .* added/.test(stacked?.text ?? ''), stacked?.text)
  check('a book that never changes gives none', pullStackSignals({ columns: columns.slice(0, 19), rowSize: 1, lotSize: LOT }).signals.length === 0)
  check('too few columns to judge: none', pullStackSignals({ columns: columns.slice(0, 2), rowSize: 1, lotSize: LOT }).signals.length === 0)
  check('it returns the signals alone', Object.keys(out).join() === 'signals', Object.keys(out).join())
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
