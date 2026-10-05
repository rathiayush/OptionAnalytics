// Day type (dayRegime) and the adaptive what-if (adaptiveDecision / adaptiveStats) - TRACKING ONLY: every
// setup still fires. Each day type is recognised, nothing after the clock is read, every strategy has a
// style, and the adaptive tally adds up.
// Run: npm test (node --test) - see CLAUDE.md.
import { dayRegime, adaptiveDecision, adaptiveStats, STRATEGY_STYLE, REGIME_LABELS, sessionOpenMs } from '../src/dayRegime.js'
import { STRATEGIES } from '../src/strategyEngine.js'
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }

// A day from a close-price path: each bar 2 pts high / low around its close.
const day = (n, path) => Array.from({ length: n }, (_, m) => { const c = path(m); return { time: at(m), open: path(Math.max(0, m - 1)), high: c + 2, low: c - 2, close: c, buy: 500, sell: 500 } })
const read = (bars, m) => dayRegime(bars, at(m), T915)

// Trend up: a 40-pt IB (oscillation) then a steady climb far beyond it.
const trendUp = day(200, (m) => (m < 60 ? 22700 + ((m % 10) - 5) * 4 : 22720 + (m - 60) * 1.2))
const tu = read(trendUp, 200)
check('trend up: one IB side broken, a wide efficient day, held above VWAP', tu.type === 'trend-up', JSON.stringify(tu))
const trendDown = day(200, (m) => (m < 60 ? 22700 + ((m % 10) - 5) * 4 : 22680 - (m - 60) * 1.2))
check('trend down (the mirror)', read(trendDown, 200).type === 'trend-down', JSON.stringify(read(trendDown, 200)))
// Range: oscillating inside the IB all day.
const range = day(200, (m) => 22700 + ((m % 10) - 5) * 4)
check('range: still inside the IB', read(range, 200).type === 'range', JSON.stringify(read(range, 200)))
// Two-sided: breaks above the IB, then below it.
const twoSided = day(200, (m) => (m < 60 ? 22700 + ((m % 10) - 5) * 4 : m < 110 ? 22700 + (m - 60) * 1.2 : 22760 - (m - 110) * 1.5))
check('two-sided: broke both IB sides', read(twoSided, 200).type === 'two-sided', JSON.stringify(read(twoSided, 200)))
check('early: before the IB is complete', read(trendUp, 45).type === 'early')
// No look-ahead: the read at 11:15 (m 120) is the same whether or not the later bars are in the list.
check('no look-ahead: later bars do not change the read at the clock', JSON.stringify(read(twoSided.slice(0, 121), 120)) === JSON.stringify(read(twoSided, 120))
  && read(twoSided, 100).type !== 'two-sided', `${read(twoSided, 100).type}`)
// A bar still running at the clock is not read: the clock mid-way through minute 120 reads bars 0-119.
check('the running minute is not read', JSON.stringify(dayRegime(twoSided, at(120) + 30_000, T915)) === JSON.stringify(read(twoSided, 120)))

check('the session open is 09:15 IST of the clock\'s day', sessionOpenMs(at(200) + 25_000) === T915 && sessionOpenMs(T915) === T915)
check('every strategy has a style (trend / fade / any)', STRATEGIES.every((s) => ['trend', 'fade', 'any'].includes(STRATEGY_STYLE[s.id])), STRATEGIES.filter((s) => !STRATEGY_STYLE[s.id]).map((s) => s.id).join())
const take = (id, side, type) => adaptiveDecision({ id, side }, { type }).take
check('trend day: takes what goes WITH the trend, skips what goes against it', take('ibBreakout', 'LONG', 'trend-up') && take('trap', 'LONG', 'trend-up') && !take('trap', 'SHORT', 'trend-up') && !take('ibBreakout', 'LONG', 'trend-down'))
check('range / two-sided day: takes fades, skips trend / breakout setups', take('range', 'SHORT', 'range') && take('ibFailed', 'LONG', 'two-sided') && !take('ibBreakout', 'LONG', 'range') && !take('vwapOi', 'SHORT', 'two-sided') && take('maxPain', 'LONG', 'range'))
check('unclear / early: takes everything', take('ibBreakout', 'LONG', 'unclear') && take('range', 'SHORT', 'early'))

const st = adaptiveStats([
  { id: 'ibBreakout', outcome: { status: 'win', r: 2 }, regime: { type: 'trend-up' }, adaptive: { take: true } },
  { id: 'range', outcome: { status: 'loss', r: -1 }, regime: { type: 'trend-up' }, adaptive: { take: false } },
  { id: 'range', outcome: { status: 'win', r: 1.5 }, regime: { type: 'range' }, adaptive: { take: true } },
  { id: 'ibBreakout', outcome: { status: 'loss', r: -1 }, regime: { type: 'range' }, adaptive: { take: false } },
  { id: 'trap', outcome: { status: 'open', r: 0.5 }, regime: { type: 'range' }, adaptive: { take: true } },
  { id: 'trap', outcome: { status: 'win', r: 1 } },
])
check('adaptive tally: all = taken + skipped; open trades left out; untracked counted apart', st.all.trades === 4 && st.take.trades === 2 && st.skip.trades === 2
  && st.take.totalR === 3.5 && st.skip.totalR === -2 && st.all.totalR === 1.5 && st.untracked === 1 && st.take.winRate === 1, JSON.stringify(st))
check('...and per day type, in a fixed order', st.byType.map((x) => x.type).join() === 'trend-up,range' && st.byType[0].take.totalR === 2 && st.byType[1].skip.totalR === -1 && Object.keys(REGIME_LABELS).includes('two-sided'))
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
