// Strategy 10, the expiry-day max-pain pull - and how a REPLAYED day knows it was an expiry day.
// Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, evaluateStrategies, wasExpiryDay, STRATEGIES, ACTIVE_STRATEGIES } from '../src/strategyEngine.js'
const MIN = 60000
// Tuesday 06 Oct 2026 (NIFTY's weekly expiry weekday; its October futures expire on Tuesday 27 Oct).
const DATE = '2026-10-06'
const T915 = Date.parse(`${DATE}T03:45:00Z`)
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${x}`); if (!c) fails++ }
check('#10 is the max-pain pull, active', STRATEGIES.find((s) => s.no === 10)?.id === 'maxPain' && ACTIVE_STRATEGIES.some((s) => s.id === 'maxPain'))

// 13:15 (minute 240): the index at 22650, the chain's OI piled at 22800 (LONG: max pain above) or 22500
// (SHORT: below), the ΣΔ drifting toward it, the tape and the book with it.
const NOW_M = 240
function runOf(dir, o = {}) {
  const spotAt = 22650
  const pin = o.pin ?? (dir > 0 ? 22800 : 22500)
  const sp = [], fut = [], ce = [], pe = []
  for (let m = 0; m <= NOW_M + 10; m++) {
    sp.push({ time: iso(at(m)), open: spotAt, high: spotAt, low: spotAt, close: spotAt })
    fut.push({ time: iso(at(m)), open: spotAt + 60, high: spotAt + 60, low: spotAt + 60, close: spotAt + 60, volume: 1, openInterest: 1e7 })
    for (let k = 22300; k <= 23000; k += 50) {
      const heavy = k === pin ? 8e6 : 1e6
      pe.push({ time: iso(at(m)), strike: k, openInterest: heavy, price: 20 })
      ce.push({ time: iso(at(m)), strike: k, openInterest: heavy, price: 20 })
    }
  }
  return { success: true, date: o.date ?? DATE, step: 50, expiryFlag: o.expiryFlag ?? 'WEEK', futuresExpiry: o.futuresExpiry ?? '2026-10-27', spotCandlesOneMinute: sp, futuresBars: fut, cePoints: ce, pePoints: pe }
}
function maxPainCase(dir, o = {}) {
  // The expiry listed today: the replayed day itself (o.listed), or - a past day replayed - a later one.
  const oi = buildOiContext(runOf(dir, o), o.listed === undefined ? DATE : o.listed, { live: !!o.live })
  const bars = []
  let cvd = 0
  for (let m = 0; m < NOW_M; m++) {
    const p = 22710
    const withMove = o.drift === false ? 500 : 650
    const b = { time: at(m), open: p, high: p + 2, low: p - 2, close: p, buy: dir > 0 ? withMove : 500, sell: dir > 0 ? 500 : withMove, absorption: [], exhaustion: [], stacked: [] }
    b.delta = b.buy - b.sell; cvd += b.delta; b.cvd = cvd
    bars.push(b)
  }
  const nowMs = o.nowMs ?? at(NOW_M) + 10_000
  const buyPct = o.tapeAgainst ? 50 : dir > 0 ? 70 : 30
  const tape = Array.from({ length: 60 }, (_, i) => ({ seq: i, time: nowMs - 59_000 + i * 1000, price: 1, quantity: 75, buy: ((i * 37) % 100) < buyPct }))
  const book = dir > 0 ? { bids: [{ quantity: 600 }], asks: [{ quantity: 400 }] } : { bids: [{ quantity: 400 }], asks: [{ quantity: 600 }] }
  const visible = bars.filter((b) => b.time + MIN <= nowMs)
  const setups = evaluateStrategies({ nowMs, price: visible.at(-1).close, bars: visible, minuteBars: visible, prints: tape, book, liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi, estimated: false, lotSize: 75, bigLots: 10, profile: null })
  return { s: setups.find((x) => x.id === 'maxPain'), setups, oi }
}
const show = (r) => JSON.stringify(r.s ? { side: r.s.side, entry: r.s.entry, stop: r.s.stop, target: r.s.target, OI: r.s.checks.OI } : r.setups.map((x) => x.id))

const L = maxPainCase(1)
check('fires LONG on an expiry day, max pain above the index (target 80% of the way)', L.s?.side === 'LONG' && /max pain 22800/.test(L.s.checks.OI) && Math.abs((L.s.target - L.s.entry) - 0.8 * 150) < 0.01, show(L))
const S = maxPainCase(-1)
check('fires SHORT on an expiry day, max pain below the index', S.s?.side === 'SHORT' && /max pain 22500/.test(S.s.checks.OI) && S.s.target < S.s.entry, show(S))
for (const dir of [1, -1]) {
  const side = dir > 0 ? 'LONG' : 'SHORT'
  check(`${side}: not on a day that is not an expiry`, !maxPainCase(dir, { listed: '2026-10-13', futuresExpiry: '2026-10-29', date: '2026-10-06' }).s)
  check(`${side}: not before 13:00`, !maxPainCase(dir, { nowMs: at(220) + 10_000 }).s)
  check(`${side}: not when max pain is within 0.3% of the index`, !maxPainCase(dir, { pin: 22650 }).s)
  check(`${side}: not without the ΣΔ drifting toward it`, !maxPainCase(dir, { drift: false }).s)
  check(`${side}: not without the tape with it`, !maxPainCase(dir, { tapeAgainst: true }).s)
}

// A past expiry day replayed: the listed expiry is a later date now - it still runs (it never did before).
const R = maxPainCase(1, { listed: '2026-10-13' })
check('a REPLAYED past expiry day is an expiry day (weekly weekday + its futures month agree) - #10 fires', R.oi.isExpiryDay && R.s?.side === 'LONG', show(R))
check('...and the listed expiry (the one an option order uses) is left as it is', R.oi.expiry === '2026-10-13')
check('live: only the listed expiry being today counts (unchanged)', !maxPainCase(1, { listed: '2026-10-13', live: true }).oi.isExpiryDay)
check('a replayed Monday is not an expiry day', !maxPainCase(1, { listed: '2026-10-13', date: '2026-10-05' }).oi.isExpiryDay)

// wasExpiryDay: the calendar only (known before the day - no look-ahead), and only when the dates agree.
const r = (date, futuresExpiry, expiryFlag = 'WEEK') => ({ date, futuresExpiry, expiryFlag })
check('the listed expiry is the date', wasExpiryDay(r('2026-10-06', null), '2026-10-06'))
check('weekly: the listed weekly expiry\'s weekday and the futures month\'s weekday', wasExpiryDay(r('2026-10-20', '2026-10-27'), '2026-11-03'))
check('the date is its front-month futures expiry (monthly options expire with it) - any cycle', wasExpiryDay(r('2026-10-27', '2026-10-27', 'MONTH'), '2026-11-24') && wasExpiryDay(r('2026-10-27', '2026-10-27'), null))
check('monthly options (BANKNIFTY): a Tuesday that is not the futures expiry is not', !wasExpiryDay(r('2026-10-20', '2026-10-27', 'MONTH'), '2026-11-24'))
check('the listed weekly expiry on another weekday (holiday-shifted) - not counted', !wasExpiryDay(r('2026-10-20', '2026-10-27'), '2026-11-02'))
check('the futures month on another weekday (an older expiry convention) - not counted', !wasExpiryDay(r('2025-08-19', '2025-08-28'), '2026-11-03'))
check('a futures contract more than 35 days out (not that day\'s front month) - not counted', !wasExpiryDay(r('2026-08-18', '2026-10-27'), '2026-11-03'))
check('no futures expiry, no listed expiry, or no date - false', !wasExpiryDay(r('2026-10-20', null), '2026-11-03') && !wasExpiryDay(r('2026-10-20', '2026-10-27'), null) && !wasExpiryDay({}, '2026-10-20') && !wasExpiryDay(null, null))
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
