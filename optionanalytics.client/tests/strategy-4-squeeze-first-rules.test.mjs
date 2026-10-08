// Strategy 4, the short-covering squeeze (LONG), on the rules it was first written with (04 Oct, 1a5a95b):
// it fires where the three gates added after it - the VWAP-stretch skip, the volatility floor and the
// options-OI veto - used to drop it, and does not fire when one of its own conditions is missing.
// #5 (the long-unwinding flush, its SHORT mirror) keeps those gates.
// Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, evaluateStrategies } from '../src/strategyEngine.js'
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN // minutes after 09:15 IST
const iso = (ms) => new Date(ms).toISOString()
let fails = 0
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name} ${cond ? '' : extra}`); if (!cond) fails++ }

// A squeeze (dir 1) or a flush (dir -1) at 11:20: flat until 11:10, then futures `rate` points a minute
// with the move while the futures OI falls; the last bars' delta with it, a sweep, 80% aggression, the
// book with it. Every option can take one of the conditions away.
function scenario(dir, o = {}) {
  const rate = o.rate ?? 5
  const move = (m) => (m < 115 ? 0 : (m - 115) * rate * dir)
  const now = at(125) + 20_000
  const spot = [], fut = [], cePoints = [], pePoints = []
  for (let m = 0; m <= 125; m++) {
    const s = 22700 + (o.noMove ? 0 : move(m))
    spot.push({ time: iso(at(m)), open: s, high: s, low: s, close: s })
    const futOi = o.futOiFlat || m < 115 ? 1e7 : 1e7 - (m - 115) * 6000
    fut.push({ time: iso(at(m)), open: s + 60, high: s + 60, low: s + 60, close: s + 60, volume: 1000, openInterest: futOi })
    for (let k = 22300; k <= 23200; k += 50) {
      const ce = o.ce?.[k] ? o.ce[k](m) : 1e6
      const pe = o.pe?.[k] ? o.pe[k](m) : 1e6
      cePoints.push({ time: iso(at(m)), strike: k, openInterest: Math.round(ce), price: 10 })
      pePoints.push({ time: iso(at(m)), strike: k, openInterest: Math.round(pe), price: 10 })
    }
  }
  const oi = buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: spot, futuresBars: fut, cePoints, pePoints })
  const half = o.wideBars ? 15 : 2
  let cvd = 0
  const bars = []
  for (let m = 0; m <= 124; m++) {
    const p = 22760 + (o.noMove ? 0 : move(m))
    const withMove = m >= 120 && !(o.prevAgainst && m === 123)
    const b = { time: at(m), open: p - dir, high: p + half, low: p - half, close: p, absorption: [], exhaustion: [], stacked: [],
      buy: withMove ? (dir > 0 ? 1200 : 400) : 500, sell: withMove ? (dir > 0 ? 400 : 1200) : 500 }
    b.delta = b.buy - b.sell; cvd += b.delta; b.cvd = cvd
    bars.push(b)
  }
  const buyPct = o.tapeBuyPct ?? (dir > 0 ? 80 : 20)
  const prints = Array.from({ length: 50 }, (_, i) => ({ seq: i, time: now - 50_000 + i * 1000, price: 1, quantity: 75, buy: ((i * 37) % 100) < buyPct }))
  const sweeps = [{ id: 1, buy: dir > 0, startedAt: iso(now - 30000), endedAt: iso(now - 29000), fromPrice: 1, toPrice: 2, quantity: 900, prints: 3, levels: 3 }]
  const withBook = o.domAgainst ? -dir : dir
  const book = withBook > 0 ? { bids: [{ quantity: 700 }], asks: [{ quantity: 300 }] } : { bids: [{ quantity: 300 }], asks: [{ quantity: 700 }] }
  const price = fut.at(-1).close
  return evaluateStrategies({ nowMs: o.nowMs ?? now, price, bars, minuteBars: bars, prints, book, liquidity: [], pullStack: [], sweeps, icebergs: [], oi, estimated: false, lotSize: 75, bigLots: 10 })
}
const has = (setups, id) => setups.find((x) => x.id === id)
const ids = (setups) => setups.map((x) => `${x.id}:${x.side}`).join() || 'none'

// Fires on its rules - LONG; its stop is 0.12% of the price, its target 1.3x that.
{
  const setups = scenario(1)
  const s = has(setups, 'squeeze')
  check('#4 squeeze fires LONG on its rules', s?.side === 'LONG', ids(setups))
  check('#4 stop 0.12% / target 1.3R as first written', s && Math.abs((s.entry - s.stop) - 0.0012 * s.entry) < 0.01 && Math.abs((s.target - s.entry) - 1.3 * 0.0012 * s.entry) < 0.01, JSON.stringify(s && { entry: s.entry, stop: s.stop, target: s.target }))
  check('#5 flush fires SHORT on the mirror picture', has(scenario(-1), 'flush')?.side === 'SHORT', ids(scenario(-1)))
}

// The three gates added after the first rules: #4 fires through them, #5 still stops at them.
{
  // Fast bars: 1.2x the average 1-minute range is over the 0.12% stop.
  const wide = scenario(1, { wideBars: true })
  const s = has(wide, 'squeeze')
  check('#4 fires on fast bars, its 0.12% stop not widened (no volatility floor)', s?.side === 'LONG' && Math.abs((s.entry - s.stop) - 0.0012 * s.entry) < 0.01, ids(wide))
  check('#5 still dropped by the volatility floor on fast bars', !has(scenario(-1, { wideBars: true }), 'flush'), ids(scenario(-1, { wideBars: true })))

  // Calls written all morning at the money (the trapped shorts' side), flat in the last 15 minutes:
  // the options-OI read leans against the long - shown, not a veto.
  const callsWritten = { 22750: (m) => 1e6 + Math.min(m, 105) * 40000, 22800: (m) => 1e6 + Math.min(m, 105) * 40000 }
  const against = scenario(1, { ce: callsWritten })
  const a = has(against, 'squeeze')
  check('#4 fires with the call writers since the open leaning against it', a?.side === 'LONG', ids(against))
  check('#4 shows the options-OI lean against it', a && /lean against/.test(a.checks['Options OI']), a?.checks['Options OI'])
  const putsWritten = { 22650: (m) => 1e6 + Math.min(m, 105) * 40000, 22600: (m) => 1e6 + Math.min(m, 105) * 40000 }
  check('#5 still vetoed by the put writers against it', !has(scenario(-1, { pe: putsWritten }), 'flush'), ids(scenario(-1, { pe: putsWritten })))

  // Stretched: 12 points a minute, over 0.4% above VWAP.
  const stretched = scenario(1, { rate: 12 })
  check('#4 fires stretched from VWAP (no VWAP-stretch skip)', has(stretched, 'squeeze')?.side === 'LONG', ids(stretched))
  check('#5 still skipped stretched from VWAP', !has(scenario(-1, { rate: 12 }), 'flush'), ids(scenario(-1, { rate: 12 })))
}

// Does NOT fire when one of its own conditions is missing.
{
  check('no #4 without the futures move (0.1%+ in 10 min)', !has(scenario(1, { noMove: true }), 'squeeze'))
  check('no #4 without the futures OI falling (short covering)', !has(scenario(1, { futOiFlat: true }), 'squeeze'))
  const growingWall = { 22800: (m) => 4e6 + Math.max(0, m - 110) * 60000 }
  check('no #4 when the call wall ahead is growing', !has(scenario(1, { ce: growingWall }), 'squeeze'), ids(scenario(1, { ce: growingWall })))
  check('no #4 without two bars of delta with the move', !has(scenario(1, { prevAgainst: true }), 'squeeze'))
  check('no #4 without 70%+ aggressive buying', !has(scenario(1, { tapeBuyPct: 60 }), 'squeeze'))
  check('no #4 with the book against it', !has(scenario(1, { domAgainst: true }), 'squeeze'))
  check('no #4 before 10:00', !has(scenario(1, { nowMs: at(40) }), 'squeeze'))
}

console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
