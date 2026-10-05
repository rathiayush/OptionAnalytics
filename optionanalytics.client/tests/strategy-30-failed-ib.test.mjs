// Strategy 30, failed IB breakout: a break beyond the initial balance that leaves a tail / traps the
// breakout side and comes back inside - target the other IB edge. LONG (a failed break down) and SHORT
// (the mirror), not when a key condition is missing, and each filter loosened lets its case through.
// Run: npm test (node --test) - see CLAUDE.md.
import { ACTIVE_STRATEGIES, buildOiContext, evaluateStrategies, STRATEGIES, strategyStats, topFifteen } from '../src/strategyEngine.js'
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
const NOW = at(85) + 10_000 // 10:40
const C = 22700 // the IB middle (futures); IB 22650-22750
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }

// The LONG picture (a failed break DOWN through the IB low 22650); a SHORT mirrors prices around C and
// swaps buyers / sellers and calls / puts.
function scenario(d, o = {}) {
  const mir = (p) => (d > 0 ? p : 2 * C - p)
  const bar = (m, open, high, low, close, buy = 500, sell = 500) => {
    const [h, l] = d > 0 ? [high, low] : [mir(low), mir(high)]
    return { time: at(m), open: mir(open), high: h, low: l, close: mir(close), buy: d > 0 ? buy : sell, sell: d > 0 ? sell : buy, absorption: [], exhaustion: [], stacked: [] }
  }
  const bars = []
  for (let m = 0; m < 85; m++) {
    if (m < 60) { const c = C + ((m % 11) - 5) * 9; bars.push(bar(m, c, c + 5, c - 5, c)); continue } // IB 22650-22750
    const brokeAt = o.accepted ? 70 : o.old ? 66 : 80
    const brokeTo = o.old ? 69 : 83
    if (m >= brokeAt && m < brokeTo) { const c = 22638 + (m % 3); bars.push(bar(m, c + 2, c + 3, c - 3, c)); continue } // closes under the IB low
    if (m === 83 && !o.old) {
      // The extreme bar: down to 22630 (22540 when too deep) and - with a tail - back up to close 22655.
      const low = o.deep ? 22540 : 22630
      bars.push(o.noTail ? bar(m, 22640, 22642, low, 22632) : bar(m, 22636, 22657, low, 22655))
      continue
    }
    if (m === 84) {
      const close = o.stillOut ? 22645 : 22662
      bars.push(o.deltaAgainst ? bar(m, 22655, close + 2, 22652, close, 400, 700) : bar(m, 22655, close + 2, 22652, close, 700, 400))
      continue
    }
    const c = C + ((m % 5) - 2) * 5 - 30 // back inside, in the lower half
    bars.push(bar(m, c, c + 3, c - 3, c))
  }
  let cvd = 0
  for (const b of bars) { b.delta = b.buy - b.sell; cvd += b.delta; b.cvd = cvd }
  const price = bars[84].close
  // OI: the writers defend the edge - PUT OI at 22550 (just under the IB low, in spot terms) for a long,
  // CALL OI at 22700 (just over the IB high) for a short - added through the last 15 minutes.
  const defend = d > 0 ? 22550 : 22700
  const spot = [], futures = [], cePoints = [], pePoints = []
  for (let m = 0; m <= 85; m++) {
    const f = m < 85 ? bars[m].close : price
    spot.push({ time: iso(at(m)), open: f - 60, high: f - 60, low: f - 60, close: f - 60 })
    futures.push({ time: iso(at(m)), open: f, high: f, low: f, close: f, volume: 1000, openInterest: 1e7 })
    for (let k = 22300; k <= 23100; k += 50) {
      const written = k === defend && !o.noWriters ? 3e6 + Math.max(0, m - 60) * 20000 : 1e6
      pePoints.push({ time: iso(at(m)), strike: k, openInterest: d > 0 ? written : 1e6, price: 10 })
      cePoints.push({ time: iso(at(m)), strike: k, openInterest: d > 0 ? 1e6 : written, price: 10 })
    }
  }
  const oi = buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: spot, futuresBars: futures, cePoints, pePoints })
  const setups = evaluateStrategies({ nowMs: NOW, price, bars, minuteBars: bars, prints: null, book: { bids: [{ quantity: d > 0 ? 600 : 400 }], asks: [{ quantity: d > 0 ? 400 : 600 }] },
    liquidity: [], pullStack: [], sweeps: o.sweep ? [{ buy: d < 0, endedAt: iso(NOW - 3 * MIN) }] : [], icebergs: [], oi, estimated: !!o.estimated, lotSize: 75, bigLots: 10, profile: null, filters: o.filters })
  return { s: setups.find((x) => x.id === 'ibFailed'), all: setups }
}
const show = ({ s, all }) => JSON.stringify(s ? { side: s.side, entry: s.entry, stop: +s.stop.toFixed(1), target: +s.target.toFixed(1), checks: s.checks } : all.map((x) => `${x.id}:${x.side}`))

check('30 strategies, #30 is the failed IB breakout, a profile strategy in the line-up', STRATEGIES.length === 30 && STRATEGIES.find((x) => x.no === 30)?.id === 'ibFailed'
  && STRATEGIES.find((x) => x.no === 30).group === 'profile' && ACTIVE_STRATEGIES.some((x) => x.id === 'ibFailed'))
const L = scenario(1)
check('LONG: broke under the IB low, a tail, back inside, put writers defend - target the IB high', L.s?.side === 'LONG' && L.s.stop < 22630 && Math.abs(L.s.target - 22750) < 0.01
  && /tail/.test(L.s.checks.Trapped) && /put writers defend/.test(L.s.checks.OI), show(L))
console.log('   ', L.s?.checks.Profile, '|', L.s?.checks.Trapped, '|', L.s?.checks.Plan)
const S = scenario(-1)
check('SHORT (the mirror): broke over the IB high, a tail, back inside, call writers defend - target the IB low', S.s?.side === 'SHORT' && S.s.stop > 2 * C - 22630 && Math.abs(S.s.target - 22650) < 0.01
  && /call writers defend/.test(S.s.checks.OI), show(S))
check('every setup carries the day type and the adaptive what-if (tracking only - it fires either way)', !!L.s?.regime?.type && typeof L.s.adaptive?.take === 'boolean' && /tracking only/.test(L.s.checks['Day type']), JSON.stringify(L.s?.checks['Day type']))
console.log('   ', L.s?.checks['Day type'])
check('fires on an estimated day too (the tail is in the candles)', scenario(1, { estimated: true }).s?.side === 'LONG')
check('a sweep counts as trapped traders without a tail', scenario(1, { noTail: true, sweep: true }).s?.side === 'LONG' && scenario(-1, { noTail: true, sweep: true }).s?.side === 'SHORT')
check('not without a tail, sweep or big prints (nobody trapped)', !scenario(1, { noTail: true }).s && !scenario(-1, { noTail: true }).s)
check('not while still outside the IB', !scenario(1, { stillOut: true }).s && !scenario(-1, { stillOut: true }).s)
check('not after an accepted breakout (14 closes out there)', !scenario(1, { accepted: true }).s)
check('not after a break that went too far (0.48% beyond)', !scenario(1, { deep: true }).s)
check('not on an old break (back inside for 15 minutes) - not even with a 30-min lookback (the return must be fresh)', !scenario(1, { old: true }).s && !scenario(1, { old: true, filters: { ibFailed: { lookbackMin: 30 } } }).s)
check('not without the writers defending the edge', !scenario(1, { noWriters: true }).s && !scenario(-1, { noWriters: true }).s)
check('not with the delta against it', !scenario(1, { deltaAgainst: true }).s)
// The trader's filters (STRATEGY_FILTERS.ibFailed).
const F = (v) => ({ ibFailed: v })
check('filter: trapped off -> fires without a tail', scenario(1, { noTail: true, filters: F({ needTrapped: false }) }).s?.side === 'LONG')
check('filter: tail 95% -> this tail (93%) is not enough; 90% is', !scenario(1, { filters: F({ tailPct: 95 }) }).s && scenario(1, { filters: F({ tailPct: 90 }) }).s?.side === 'LONG')
check('filter: 15 closes allowed -> the long-held break counts as failed', scenario(1, { accepted: true, filters: F({ maxClosesBeyond: 15 }) }).s?.side === 'LONG')
check('filter: at most 0.05% beyond -> this 0.09% break is too far (a deep one stays out on risk: stop > 0.5%)', !scenario(1, { filters: F({ maxExcursionPct: 0.05 }) }).s && !scenario(1, { deep: true, filters: F({ maxExcursionPct: 1 }) }).s)
check('filter: writers off -> fires without them', scenario(1, { noWriters: true, filters: F({ needWriters: false }) }).s?.side === 'LONG')
check('filter: delta off -> fires with the delta against it', scenario(1, { deltaAgainst: true, filters: F({ needDelta: false }) }).s?.side === 'LONG')
const mid = scenario(1, { filters: F({ targetFrac: 0.5, minRR: 0.5, timeStopMin: 30 }) }).s
check('filter: target the IB middle, 30-min time stop', mid && Math.abs(mid.target - 22700) < 0.01 && mid.timeStopMs - mid.t === 30 * MIN, show({ s: mid, all: [] }))
check('filter: 3R room required -> 2R to the other edge is not enough', !scenario(1, { filters: F({ minRR: 3 }) }).s)
check('unmeasured, #30 is alerted on trial beside the Top 15 (which it does not change)', !topFifteen(strategyStats([])).ids.includes('ibFailed') && topFifteen(strategyStats([])).trial.includes('ibFailed'))
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
