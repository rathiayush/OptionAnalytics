// Day type (dayRegime) and the adaptive what-if (adaptiveDecision / adaptiveStats) - TRACKING ONLY: every
// setup still fires. Each day type is recognised, nothing after the clock is read, every strategy has a
// style, and the adaptive tally adds up.
// Run: npm test (node --test) - see CLAUDE.md.
import { dayRegime, adaptiveDecision, adaptiveStats, STRATEGY_STYLE, REGIME_LABELS, sessionOpenMs, oiDayVote, cvdDayVote, combineRegime } from '../src/dayRegime.js'
import { STRATEGIES, buildOiContext, dayTypeAt } from '../src/strategyEngine.js'
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

// ---- the OI vote: option writers + futures ----
const up = { options: { leanOpen: 0.4, lean30: 0.3 }, futures: { pricePct: 0.004, oiPct: 0.01 } }
check('OI: puts written + futures long build-up = trend up', oiDayVote(up).type === 'trend-up' && /long build-up/.test(oiDayVote(up).text))
check('OI: calls written + futures short build-up = trend down', oiDayVote({ options: { leanOpen: -0.4, lean30: -0.3 }, futures: { pricePct: -0.004, oiPct: 0.01 } }).type === 'trend-down')
check('OI: short covering also backs an up trend', oiDayVote({ options: { leanOpen: 0.4, lean30: 0.3 }, futures: { pricePct: 0.004, oiPct: -0.01 } }).type === 'trend-up')
check('OI: writers and futures disagreeing = no trend call', oiDayVote({ options: { leanOpen: 0.4, lean30: 0.3 }, futures: { pricePct: -0.004, oiPct: 0.01 } }).type === 'unclear')
check('OI: the ATM straddle sold (both sides adding) = range', oiDayVote({ options: { leanOpen: 0.1, lean30: 0 }, straddle: { ce: 0.05, pe: 0.06, ceRising: true, peRising: true }, futures: { pricePct: 0.0005, oiPct: 0.001 } }).type === 'range')
check('OI: nobody leaning, futures flat = range', oiDayVote({ options: { leanOpen: 0.05, lean30: 0.1 }, futures: { pricePct: 0.0003, oiPct: 0.003 } }).type === 'range')
check('OI: writers flipped sides in the last 30 min = two-sided', oiDayVote({ options: { leanOpen: 0.35, lean30: -0.4 }, futures: { pricePct: 0.0005, oiPct: 0.001 } }).type === 'two-sided')
check('OI: nothing known = no view', oiDayVote({}).type === null)

// ---- the CVD vote ----
const withDelta = (n, deltaAt) => Array.from({ length: n }, (_, m) => { const d = deltaAt(m); return { time: at(m), open: 1, high: 1, low: 1, close: 1, buy: 500 + Math.max(0, d), sell: 500 + Math.max(0, -d) } })
check('CVD climbing steadily = trend up', cvdDayVote(withDelta(150, () => 300), at(150), T915).type === 'trend-up')
check('CVD falling steadily = trend down', cvdDayVote(withDelta(150, () => -300), at(150), T915).type === 'trend-down')
check('CVD going up and down, getting nowhere = range', cvdDayVote(withDelta(150, (m) => (Math.floor(m / 15) % 2 ? -300 : 300)), at(150), T915).type === 'range', cvdDayVote(withDelta(150, (m) => (Math.floor(m / 15) % 2 ? -300 : 300)), at(150), T915).text)
check('CVD: no buy / sell volume = no view', cvdDayVote(trendUp.map((b) => ({ ...b, buy: 0, sell: 0 })), at(200), T915).type === null)
check('CVD: later bars not read', JSON.stringify(cvdDayVote(withDelta(150, (m) => (m < 120 ? 300 : -900)), at(120), T915)) === JSON.stringify(cvdDayVote(withDelta(120, () => 300), at(120), T915)))

// ---- combining ----
const P = (type) => ({ type, label: REGIME_LABELS[type], reasons: 'p' })
const V = (type) => ({ type, text: type ?? 'none' })
check('price trend confirmed by OI and CVD stays trend', combineRegime(P('trend-up'), V('trend-up'), V('trend-up')).type === 'trend-up' && combineRegime(P('trend-up'), V('trend-up'), V('trend-up')).votes.oi === 'agrees')
check('price trend, one vote for and one against: kept (2 to 1)', combineRegime(P('trend-up'), V('trend-up'), V('range')).type === 'trend-up')
check('price trend, OI against and CVD no view: unclear (outvoted)', combineRegime(P('trend-up'), V('range'), V(null)).type === 'unclear')
check('price trend, both against: unclear', combineRegime(P('trend-down'), V('trend-up'), V('range')).type === 'unclear')
check('price trend, no OI / CVD view: price kept', combineRegime(P('trend-up'), V(null), V('unclear')).type === 'trend-up')
check('price range, OI says the straddle is sold: range (two-sided counts as balance too)', combineRegime(P('range'), V('range'), V('unclear')).type === 'range' && combineRegime(P('two-sided'), V('range'), V(null)).type === 'two-sided')
check('price range but OI and CVD both trending: unclear', combineRegime(P('range'), V('trend-up'), V('trend-up')).type === 'unclear')
check('no price read yet: OI + CVD agreeing call the trend early; one alone does not', combineRegime(P('unclear'), V('trend-down'), V('trend-down')).type === 'trend-down' && combineRegime(P('unclear'), V('trend-down'), V(null)).type === 'unclear')
check('before 10:15 it stays early whatever the votes', combineRegime(P('early'), V('trend-up'), V('trend-up')).type === 'early')
check('the price read is kept beside the combined one', combineRegime(P('trend-up'), V('range'), V(null)).priceType === 'trend-up')
// The engine's dayTypeAt from a real OI context: a trend-up price day with puts written and a futures
// long build-up is a confirmed trend up.
{
  const spot = [], futures = [], ce = [], pe = []
  for (let m = 0; m <= 200; m++) {
    const f = trendUp[Math.min(m, 199)].close
    spot.push({ time: new Date(at(m)).toISOString(), open: f - 60, high: f - 60, low: f - 60, close: f - 60 })
    futures.push({ time: new Date(at(m)).toISOString(), open: f, high: f, low: f, close: f, volume: 1000, openInterest: 1e7 + m * 5000 })
    for (let k = 22500; k <= 23000; k += 50) {
      pe.push({ time: new Date(at(m)).toISOString(), strike: k, openInterest: 1e6 + m * 8000 })
      ce.push({ time: new Date(at(m)).toISOString(), strike: k, openInterest: 1e6 })
    }
  }
  const oi = buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: spot, futuresBars: futures, cePoints: ce, pePoints: pe })
  const bars = trendUp.map((b, m) => ({ ...b, buy: m >= 60 ? 800 : 500, sell: 500 }))
  const r = dayTypeAt(oi, bars, at(200) + 10_000)
  check('engine: price + OI (puts written, long build-up) + CVD all say trend up', r.type === 'trend-up' && r.votes.oi === 'agrees' && r.votes.cvd === 'agrees', JSON.stringify(r))
  const rNoOi = dayTypeAt(null, bars, at(200) + 10_000)
  check('engine: without OI the vote is "no view" and price + CVD decide', rNoOi.type === 'trend-up' && rNoOi.votes.oi === 'no view', JSON.stringify(rNoOi.votes))
}
const st2 = adaptiveStats([{ id: 'range', outcome: { status: 'win', r: 1 }, regime: { type: 'unclear' }, adaptive: { take: true, priceOnly: false } }])
check('the tally also counts what adaptive on price alone would have taken', st2.take.trades === 1 && st2.takePrice.trades === 0)
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
