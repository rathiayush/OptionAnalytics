// NO ACTIVE STRATEGY TRADES THE PREVIOUS SESSION'S VOLUME PROFILE.
// Its POC / value area / HVN / LVN come from the volume at each PRICE inside the previous day's bars
// (sessionVolumeProfile), and the server only keeps the last few days of real order flow - every older day comes back
// "estimated", rebuilt from Dhan's 1-minute candles, where that split is made up. So the levels were often never
// there. #11, #13, #14 and #34 - #37 are retired for it; #12 reads the MARKET (TPO) profile instead - time at price,
// which needs only each bar's high and low, real on an estimated day too.
// The guard: take the volume profile away and nothing an active strategy does changes.
// Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ACTIVE_STRATEGIES, STRATEGY_BY_ID, STRATEGIES, buildOiContext, evaluateStrategies } from '../src/strategyEngine.js'
import { scanTick, MIN } from '../src/scannerCore.js'
import { sessionVolumeProfile, tpoProfile } from '../src/profiles.js'
import { day } from './synthetic-day.mjs'

const { minuteBars, prints, oi, T915, at } = day()

// A previous session built from the day's own bars, so the profile has a real POC, value area, HVNs and LVNs.
const vp = sessionVolumeProfile(minuteBars)
const tpoPrev = tpoProfile(minuteBars, 5)
const profile = { vp, tpoPrev, high: Math.max(...minuteBars.map((b) => b.high)), low: Math.min(...minuteBars.map((b) => b.low)) }

const viewAt = (t) => ({
  meta: { securityId: 1, lotSize: 75, day: '2026-10-05' },
  minuteBars: minuteBars.filter((b) => Date.parse(b.time) <= t), trades: [], icebergs: [], sweeps: [],
  heatmap: [{ t, bids: [], asks: [] }], book: { bids: [{ price: 1, quantity: 500 }], asks: [{ price: 2, quantity: 500 }] }, source: 'live',
})

/** Every setup the scanner finds through the day with this profile, as "id side minute". */
function firedWith(prof) {
  const out = []
  for (let m = 20; m <= 300; m += 5) {
    const t = at(m)
    const tick = scanTick({
      nowMs: t, view: viewAt(t), tapePrints: prints.filter((p) => p.time <= t), liquidity: [], pullStack: [],
      oi, estimated: false, lotSize: 75, largeLots: 10, profile: prof, rowSize: 1, filters: {}, trail: null,
    }, { fired: [] })
    for (const s of tick?.fresh ?? []) out.push(`${s.id} ${s.side} ${Math.round((s.t - T915) / MIN)}`)
  }
  return out.sort()
}

test('the previous session\'s volume profile is gone: it changes nothing an active strategy does', () => {
  const withVp = firedWith(profile)
  const withoutVp = firedWith({ ...profile, vp: null })
  assert.ok(withVp.length > 0, 'the day fires something to compare')
  assert.deepEqual(withoutVp, withVp, 'taking the volume profile away changes no active strategy\'s setups')
})

// The value-area rejection's own case (tests/strategies-profile.test.mjs): it DOES fire on these rules, so it proves
// the retirement rather than a day where it would never have fired anyway.
function vaRejectionCase(includeRetired) {
  const now = at(100) + 10_000
  const sp = [], fut = [], ce = [], pe = []
  for (let m = 0; m <= 130; m++) {
    const spot = m < 95 ? 22700 - m : 22605
    sp.push({ time: new Date(at(m)).toISOString(), open: spot, high: spot, low: spot, close: spot })
    fut.push({ time: new Date(at(m)).toISOString(), open: spot + 60, high: spot + 60, low: spot + 60, close: spot + 60, volume: 1, openInterest: 1e7 })
    for (let k = 22300; k <= 23000; k += 50) {
      pe.push({ time: new Date(at(m)).toISOString(), strike: k, openInterest: k === 22600 ? 5e6 + m * 20_000 : 1e6 })
      ce.push({ time: new Date(at(m)).toISOString(), strike: k, openInterest: 1e6 })
    }
  }
  const oiCtx = buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: sp, futuresBars: fut, cePoints: ce, pePoints: pe })
  const bs = []
  let cvd = 0
  for (let m = 0; m <= 99; m++) {
    const p = m < 95 ? 22760 - m : (m === 97 ? 22660 : 22668)
    const b = { time: at(m), absorption: [], exhaustion: [], stacked: [], open: p, high: p + 2, low: m === 97 ? 22645 : p - 2, close: p, buy: m === 99 ? 900 : 500, sell: 600 }
    b.delta = b.buy - b.sell
    cvd += b.delta
    b.cvd = cvd
    bs.push(b)
  }
  bs[99].absorption = [{ side: 'buy', price: 22650 }]
  const prints = Array.from({ length: 50 }, (_, i) => ({ seq: i, time: now - 50_000 + i * 1000, price: 1, quantity: 75, buy: ((i * 37) % 100) < 70 }))
  return evaluateStrategies({
    nowMs: now, price: 22668, bars: bs, minuteBars: bs, prints, book: { bids: [{ quantity: 600 }], asks: [{ quantity: 400 }] },
    liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi: oiCtx, estimated: false, lotSize: 75, bigLots: 10,
    profile: { vp: { poc: 22720, vah: 22760, val: 22655, hvn: [22720], lvn: [] }, tpoPrev: null }, includeRetired,
  })
}

test('a volume-profile strategy on its own firing case: its rules still work, but the scanner no longer trades it', () => {
  const kept = vaRejectionCase(true).find((s) => s.id === 'vaRejection')
  assert.equal(kept?.side, 'LONG', 'the rules are intact - it fires with includeRetired')
  assert.ok(!vaRejectionCase(false).some((s) => s.id === 'vaRejection'), 'and never reaches the scanner')
})

test('the market (TPO) profile still counts - #12 is not retired and reads it', () => {
  assert.equal(STRATEGY_BY_ID.tpo80.retired, undefined, '#12 Market profile 80% rule keeps running')
  // With no TPO profile at all, #12 can no longer fire - so it really is reading it.
  const noTpo = firedWith({ ...profile, tpoPrev: null })
  assert.ok(!noTpo.some((x) => x.startsWith('tpo80 ')), '#12 needs the TPO profile')
})

test('every strategy whose rules are volume-profile levels is retired', () => {
  for (const id of ['vaRejection', 'pocReaction', 'lvnRun', 'pocReject', 'vaEdgeReject', 'hvnReject', 'lvnReject']) {
    assert.equal(STRATEGY_BY_ID[id]?.retired, true, `#${STRATEGY_BY_ID[id]?.no} ${id} must be retired`)
    assert.ok(!ACTIVE_STRATEGIES.some((s) => s.id === id), `${id} is not active`)
  }
  // Retired, not deleted - the rules stay so they can come back with a real volume profile.
  assert.equal(STRATEGIES.filter((s) => s.group === 'profile').length, 10)
})
