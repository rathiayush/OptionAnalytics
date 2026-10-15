// Strategies 34-37: a rejection at the previous session's POC (34), VAH / VAL (35), HVN (36) or LVN (37), with the
// option writers near the money leaning the trade's way. Each fires LONG and SHORT on its rule and does not fire when
// any one condition is missing; loosening each filter lets its case through.
// Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, evaluateStrategies, STRATEGIES, ACTIVE_STRATEGIES, STRATEGY_FILTERS, strategyFilters } from '../src/strategyEngine.js'
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }

// RETIRED: they reject at the previous session's VOLUME-profile levels, which are made up on an estimated day
// (see STRATEGIES / tests/no-volume-profile.test.mjs). Their rules stay and are still run here, with includeRetired.
check('37 strategies (22 running), 34-37 in the profile group, on trial and retired', STRATEGIES.length === 37 && ACTIVE_STRATEGIES.length === 22
  && ['pocReject', 'vaEdgeReject', 'hvnReject', 'lvnReject'].every((id, i) => { const s = STRATEGIES.find((x) => x.id === id); return s?.no === 34 + i && s.group === 'profile' && s.trial && s.retired }))
check('their filters default to the rule as written', ['pocReject', 'vaEdgeReject', 'hvnReject', 'lvnReject'].every((id) => ['bandPct', 'awayPct', 'touchBars', 'minWriting', 'futuresNotAgainst', 'needDelta', 'minRoomR', 'maxTargetR', 'timeStopMin'].every((k) => STRATEGY_FILTERS[id].some((f) => f.key === k)) && strategyFilters(id, undefined).minWriting === 0.1 && strategyFilters(id, undefined).touchBars === 3))

const L0 = 22700 // the level, in futures terms (spot = futures - 60)
const mir = (dir, p) => (dir > 0 ? p : 2 * L0 - p)

// The OI: puts (LONG) or calls (SHORT) written near the money over the last 15 minutes - or none / the other side.
// futOi: the futures OI over the day (a rise with a falling price = a fresh short build-up against a LONG).
function oiOf(dir, path, o) {
  const sp = [], fut = [], ce = [], pe = []
  const writeSide = o.writing === 'none' ? null : (o.writing === 'against' ? -dir : dir) > 0 ? 'pe' : 'ce'
  for (let m = 0; m <= 100; m++) {
    const f = path(m)
    sp.push({ time: iso(at(m)), open: f - 60, high: f - 60, low: f - 60, close: f - 60 })
    fut.push({ time: iso(at(m)), open: f, high: f, low: f, close: f, volume: 1, openInterest: o.futOi ? 1e7 + m * 3e4 : 1e7 })
    for (let k = 22300; k <= 23100; k += 50) {
      const near = Math.abs(k - (f - 60)) <= 100
      const grow = (side) => (writeSide === side && near && m >= 85 ? 2e6 + (m - 85) * 60000 : 2e6)
      ce.push({ time: iso(at(m)), strike: k, openInterest: grow('ce') })
      pe.push({ time: iso(at(m)), strike: k, openInterest: grow('pe') })
    }
  }
  return buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: sp, futuresBars: fut, cePoints: ce, pePoints: pe })
}

// LONG at 10:55: away above the level (22770), down to it, touched at m98 (low 22698), the last bar turns up to
// 22716 on positive delta. SHORT: the mirror around the level.
function rejectCase(dir, o = {}) {
  const now = at(100) + 10000
  const away = o.near ? 22720 : 22770
  const touchAt = o.touchAt ?? 98
  const p = (m) => (m < 88 ? away : m < touchAt ? away - ((m - 87) / (touchAt - 87)) * (away - 22706) : m === touchAt ? 22704 : m < 99 ? 22706 : (o.noTurn ? 22702 : 22716))
  const path = (m) => mir(dir, p(m))
  const oi = oiOf(dir, path, o)
  const bs = []
  let cvd = 0
  for (let m = 0; m <= 99; m++) {
    const c = path(m)
    const open = m === 99 ? mir(dir, 22704) : c
    let low = Math.min(open, c) - 1, high = Math.max(open, c) + 1
    if (m === touchAt) { if (dir > 0) low = 22698; else high = mir(dir, 22698) }
    if (o.closeThrough && m === 98) { const x = mir(dir, 22680); if (dir > 0) low = Math.min(low, x - 1); else high = Math.max(high, x + 1) }
    const close = o.closeThrough && m === 98 ? mir(dir, 22680) : c
    const withTrade = m === 99 ? (o.deltaAgainst ? 300 : 900) : 500
    const b = { time: at(m), open, high, low, close, buy: dir > 0 ? withTrade : 500, sell: dir > 0 ? 500 : withTrade, absorption: [], exhaustion: [], stacked: [] }
    b.delta = b.buy - b.sell
    cvd += b.delta
    b.cvd = cvd
    bs.push(b)
  }
  // The profile: the level is the POC / VAL / HVN / LVN, other levels around (mirrored for a SHORT).
  const m2 = (x) => mir(dir, x)
  const sortA = (xs) => xs.map(m2).sort((a, b) => a - b)
  const kind = o.kind ?? 'poc'
  const ahead = o.blocked ? 22735 : 22760
  const base = { poc: 22620, vah: 22800, val: 22560, hvn: [22620, ahead], lvn: [22650] }
  if (kind === 'poc') Object.assign(base, { poc: L0, hvn: [L0, ahead] })
  if (kind === 'va') Object.assign(base, { val: L0 })
  if (kind === 'hvn') Object.assign(base, { hvn: [22620, L0, ahead] })
  if (kind === 'lvn') Object.assign(base, { lvn: [L0] })
  const vp = { poc: m2(base.poc), vah: dir > 0 ? base.vah : m2(base.val), val: dir > 0 ? base.val : m2(base.vah), hvn: sortA(base.hvn), lvn: sortA(base.lvn) }
  const price = bs.at(-1).close
  const tape = Array.from({ length: 50 }, (_, i) => ({ seq: i, time: now - 50000 + i * 1000, price: 1, quantity: 75, buy: ((i * 37) % 100) < (dir > 0 ? 60 : 40) }))
  const setups = evaluateStrategies({ nowMs: now, price, bars: bs, minuteBars: bs, prints: tape, book: { bids: [{ quantity: 500 }], asks: [{ quantity: 500 }] }, liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi, estimated: false, lotSize: 75, bigLots: 10, profile: { vp, tpoPrev: null }, filters: o.filters, includeRetired: true })
  const id = { poc: 'pocReject', va: 'vaEdgeReject', hvn: 'hvnReject', lvn: 'lvnReject' }[kind]
  return { s: setups.find((x) => x.id === id), setups, price }
}

const show = (r) => JSON.stringify(r.s?.checks ?? r.setups.map((x) => x.id))
for (const kind of ['poc', 'va', 'hvn', 'lvn']) {
  const L = rejectCase(1, { kind })
  const S = rejectCase(-1, { kind })
  check(`${kind}: LONG - rejected at the level from above, puts written, target the next level`, L.s?.side === 'LONG' && L.s.stop < 22698 && Math.abs(L.s.target - 22760) < 0.5 && /writers near the money lean PUT/.test(L.s.checks.OI), show(L))
  check(`${kind}: SHORT - the mirror, calls written`, S.s?.side === 'SHORT' && S.s.stop > mir(-1, 22698) && Math.abs(S.s.target - mir(-1, 22760)) < 0.5 && /lean CALL/.test(S.s.checks.OI), show(S))
}
// Each key condition missing -> no trade (LONG and SHORT).
const none = (o) => [1, -1].every((d) => !rejectCase(d, o).s)
check('not without option writing', none({ writing: 'none' }))
check('not with the writers on the other side', none({ writing: 'against' }))
check('not when it did not come from away (drifting at the level)', none({ near: true }))
check('not when a bar closed through the level', none({ closeThrough: true }))
check('not when the last bar does not turn away from it', none({ noTurn: true }))
check('not on the rejection bar\'s delta against it', none({ deltaAgainst: true }))
check('not when the next profile level is too close (no room)', none({ blocked: true }))
check('not with a fresh futures build-up against it', !rejectCase(1, { futOi: true }).s, show(rejectCase(1, { futOi: true })))
check('not when the touch was longer ago than 3 bars', none({ touchAt: 94 }))
// Loosening each filter lets its case through.
const F = (o) => ({ pocReject: o })
check('filter: min writing 0 -> fires with no writing', rejectCase(1, { writing: 'none', filters: F({ minWriting: 0 }) }).s?.side === 'LONG' && rejectCase(-1, { writing: 'none', filters: F({ minWriting: 0 }) }).s?.side === 'SHORT')
check('filter: futures check off -> fires with a build-up against', rejectCase(1, { futOi: true, filters: F({ futuresNotAgainst: false }) }).s?.side === 'LONG')
check('filter: delta check off -> fires on delta against', rejectCase(1, { deltaAgainst: true, filters: F({ needDelta: false }) }).s?.side === 'LONG')
check('filter: room 0.5x -> fires with the next level close', rejectCase(1, { blocked: true, filters: F({ minRoomR: 0.5 }) }).s?.side === 'LONG')
check('filter: away 0.05% -> fires when it came from nearby', rejectCase(1, { near: true, filters: F({ awayPct: 0.05 }) }).s?.side === 'LONG')
check('filter: touch within 8 bars -> fires on an older touch', rejectCase(1, { touchAt: 94, filters: F({ touchBars: 8 }) }).s?.side === 'LONG')
const tight = rejectCase(1, { filters: F({ maxTargetR: 1, timeStopMin: 30 }) }).s
check('filter: target capped at 1x the stop, 30-min time stop', tight && Math.abs((tight.target - tight.entry) - (tight.entry - tight.stop)) < 0.01 && tight.timeStopMs - tight.t === 30 * MIN, JSON.stringify(tight))
check('a filter of one strategy leaves the others as written', !rejectCase(1, { kind: 'hvn', writing: 'none', filters: F({ minWriting: 0 }) }).s)

console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
