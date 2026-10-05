// Strategies 11-15 (volume / market profile) and the top-15 selection.
// Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, evaluateStrategies, topFifteen, strategyStats, STRATEGIES } from '../src/strategyEngine.js'
import { sessionVolumeProfile, tpoProfile } from '../src/profiles.js'
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${x}`); if (!c) fails++ }
check('30 strategies, 6 in the profile group, 3 range-bound', STRATEGIES.length === 30 && STRATEGIES.filter((s) => s.group === 'profile').length === 6 && STRATEGIES.filter((s) => s.group === 'range').length === 3)

// Profiles: two humps (HVN around 100 and 110) with a thin area (LVN) at 105.
{
  const bars = []
  for (let m = 0; m < 375; m++) {
    const p = m < 180 ? 100 + (m % 3) : m < 190 ? 103 + (m - 180) * 0.7 : 110 + (m % 3)
    const levels = [{ price: Math.round(p), buy: m < 180 || m >= 190 ? 500 : 20, sell: m < 180 || m >= 190 ? 500 : 20 }]
    bars.push({ time: iso(at(m)), open: p, high: p + 0.5, low: p - 0.5, close: p, buy: 500, sell: 500, levels })
  }
  const vp = sessionVolumeProfile(bars)
  check('volume profile POC in a busy area, LVN between the humps', [100, 101, 102, 110, 111, 112].includes(vp.poc) && vp.lvn.some((l) => l > 103 && l < 110), JSON.stringify({ poc: vp.poc, hvn: vp.hvn, lvn: vp.lvn, vah: vp.vah, val: vp.val }))
  const tpo = tpoProfile(bars, 1)
  check('TPO profile: letters A.., IB from the first hour, value area around the POC', tpo.rows.some((r) => r.letters.includes('A')) && tpo.ib.high >= 102 && tpo.ib.low <= 100 && tpo.val <= tpo.poc && tpo.vah >= tpo.poc, JSON.stringify({ poc: tpo.poc, va: [tpo.val, tpo.vah], ib: tpo.ib, periods: tpo.periods }))
}

// IB breakout at 10:40 (LONG; the SHORT mirrors it around 22712): writers leaning the trade's way over the
// last hour, the break ACCEPTED (two closes beyond the IB), the first break of the day, on 1.5x volume.
function run(spot, pe = {}) {
  const sp = [], fut = [], ce = [], pes = []
  for (let m = 0; m <= 130; m++) {
    const s = spot(m)
    sp.push({ time: iso(at(m)), open: s, high: s, low: s, close: s })
    fut.push({ time: iso(at(m)), open: s + 60, high: s + 60, low: s + 60, close: s + 60, volume: 1, openInterest: 1e7 })
    for (let k = 22300; k <= 23000; k += 50) {
      pes.push({ time: iso(at(m)), strike: k, openInterest: (pe[k] ?? (() => 1e6))(m) })
      ce.push({ time: iso(at(m)), strike: k, openInterest: 1e6 })
    }
  }
  return buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: sp, futuresBars: fut, cePoints: ce, pePoints: pes })
}
function bars(from, to, f) { const out = []; let cvd = 0; for (let m = from; m <= to; m++) { const b = { time: at(m), absorption: [], exhaustion: [], stacked: [], ...f(m) }; b.delta = b.buy - b.sell; cvd += b.delta; b.cvd = cvd; out.push(b) } return out }
const tape = (now, pct) => Array.from({ length: 50 }, (_, i) => ({ seq: i, time: now - 50000 + i * 1000, price: 1, quantity: 75, buy: ((i * 37) % 100) < pct }))
const MID = 22712
// #15's stricter options, off by default (the old rule: one close beyond the edge): two closes in a row to
// accept the break, the first break of a side per day, and a break bar of 1.5x the IB's average volume.
const STRICT_IB = { closesBeyond: 2, firstBreakOnly: true, breakVolumeX: 1.5 }
function ibCase(dir, o = {}) {
  const now = at(85) + 10000
  const mir = (p) => (dir > 0 ? p : 2 * MID - p)
  const breakAt = o.breakAt ?? 83
  const inside = (m) => 22710 + (m % 5)
  const out = (m) => (o.earlier?.includes(m) ? true : m >= breakAt && !(o.poke && m === 84))
  const writers = { 22650: (m) => 3e6 + m * 20000, 22600: (m) => 3e6 + m * 20000 }
  const oi = dir > 0
    ? run((m) => (out(m) ? 22662 : inside(m) - 60), writers)
    : runShort((m) => mir(out(m) ? 22722 : inside(m)) - 60)
  const bs = bars(0, 84, (m) => {
    const p = mir(out(m) ? 22722 : inside(m))
    // The break bar heavy (2x the IB's average, 1.2x when weak), the acceptance bar still with the trade.
    const withTrade = m === breakAt ? (o.weak ? 700 : 1500) : m === 84 && out(m) ? 800 : 500
    const b = { open: p - dir, high: p + 1, low: p - 1, close: p, buy: dir > 0 ? withTrade : 500, sell: dir > 0 ? 500 : withTrade }
    // The 09:15 bar spikes to 22690 (the mirror 22734 for a short): it sets that IB extreme.
    if (o.firstBarSpike && m === 0) Object.assign(b, dir > 0 ? { low: 22690 } : { high: mir(22690) })
    return b
  })
  const price = bs.at(-1).close
  const setups = evaluateStrategies({ nowMs: now, price, bars: bs, minuteBars: bs, prints: tape(now, dir > 0 ? 70 : 30), book: dir > 0 ? { bids: [{ quantity: 600 }], asks: [{ quantity: 400 }] } : { bids: [{ quantity: 400 }], asks: [{ quantity: 600 }] }, liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi, estimated: false, lotSize: 75, bigLots: 10, profile: null,
    // The stricter options (Filters) are switched on here unless the case is about the DEFAULT rule.
    filters: o.defaults ? o.filters : { ibBreakout: { ...STRICT_IB, ...o.filters?.ibBreakout } } })
  return { ib: setups.find((s) => s.id === 'ibBreakout'), setups }
}
// Call writing for the short: the whole chain's calls written over the last hour.
function runShort(spot) {
  const sp = [], fut = [], ce = [], pes = []
  for (let m = 0; m <= 130; m++) {
    const s = spot(m)
    sp.push({ time: iso(at(m)), open: s, high: s, low: s, close: s })
    fut.push({ time: iso(at(m)), open: s + 60, high: s + 60, low: s + 60, close: s + 60, volume: 1, openInterest: 1e7 })
    for (let k = 22300; k <= 23000; k += 50) {
      ce.push({ time: iso(at(m)), strike: k, openInterest: k === 22700 || k === 22750 ? 3e6 + m * 20000 : 1e6 })
      pes.push({ time: iso(at(m)), strike: k, openInterest: 1e6 })
    }
  }
  return buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: sp, futuresBars: fut, cePoints: ce, pePoints: pes })
}
{
  const show = (r) => JSON.stringify(r.ib?.checks ?? r.setups.map((s) => s.id))
  // The DEFAULT is the old rule: a close beyond the edge with the bar before inside - one close is enough,
  // no first-break-only, no volume test.
  const dflt = (dir, o = {}) => ibCase(dir, { ...o, defaults: true }).ib
  check('default (the old rule): one close beyond the first-hour edge fires, LONG and SHORT', dflt(1, { breakAt: 84 })?.side === 'LONG' && dflt(-1, { breakAt: 84 })?.side === 'SHORT')
  check('default: a weak break bar and a re-break after a failed one still fire (those are the optional filters)', dflt(1, { breakAt: 84, weak: true })?.side === 'LONG' && dflt(1, { breakAt: 84, earlier: [70, 71] })?.side === 'LONG')
  check('default: not once the break is a bar old (the bar before is already beyond)', !dflt(1, { breakAt: 83 }) && !dflt(-1, { breakAt: 83 }))
  const L = ibCase(1)
  check('IB breakout LONG (strict options on): two closes above the first-hour high, first break, 2x volume', L.ib?.side === 'LONG' && L.ib.target > L.ib.entry && L.ib.stop < L.ib.entry && /2 closes beyond/.test(L.ib.checks.Footprint), show(L))
  const S = ibCase(-1)
  check('IB breakout SHORT (strict options on, the mirror): two closes below the first-hour low', S.ib?.side === 'SHORT' && S.ib.target < S.ib.entry && S.ib.stop > S.ib.entry, show(S))
  check('not on a one-bar poke (the second close back inside the IB)', !ibCase(1, { poke: true }).ib && !ibCase(-1, { poke: true }).ib)
  check('not on the first close beyond only (no acceptance yet)', !ibCase(1, { breakAt: 84 }).ib && !ibCase(-1, { breakAt: 84 }).ib)
  check('not once the break has already been running (third close beyond)', !ibCase(1, { breakAt: 82 }).ib)
  check('not when an earlier break of that side was accepted and failed', !ibCase(1, { earlier: [70, 71] }).ib && !ibCase(-1, { earlier: [70, 71] }).ib)
  check('...but an earlier one-bar poke does not block it', ibCase(1, { earlier: [70] }).ib?.side === 'LONG')
  check('not when the break bar trades under 1.5x the IB\'s average volume', !ibCase(1, { weak: true }).ib && !ibCase(-1, { weak: true }).ib)
  // A live, mid-minute clock (10:40:10) reads the IB from 09:15:00: the 09:15 bar was once dropped (the
  // session open taken as 09:15:10) - and the 10:15 bar taken in.
  const fb = ibCase(1, { firstBarSpike: true }).ib
  const fbS = ibCase(-1, { firstBarSpike: true }).ib
  check('a mid-minute clock: the 09:15 bar\'s spike is the IB extreme (LONG and SHORT)', /initial balance 22690-/.test(fb?.checks.Profile ?? '') && new RegExp(`initial balance [\\d.]+-${2 * MID - 22690}`).test(fbS?.checks.Profile ?? ''), `${fb?.checks.Profile} | ${fbS?.checks.Profile}`)
  // The trader's filters (STRATEGY_FILTERS.ibBreakout) - each one loosened lets its case through.
  const ibF = (o) => ({ ibBreakout: o })
  check('filter: 1 close to accept -> the first close beyond fires', ibCase(1, { breakAt: 84, filters: ibF({ closesBeyond: 1 }) }).ib?.side === 'LONG' && ibCase(-1, { breakAt: 84, filters: ibF({ closesBeyond: 1 }) }).ib?.side === 'SHORT')
  check('filter: 3 closes to accept -> two are not enough', !ibCase(1, { filters: ibF({ closesBeyond: 3 }) }).ib)
  check('filter: first break only off -> fires after an earlier failed break', ibCase(1, { earlier: [70, 71], filters: ibF({ firstBreakOnly: false }) }).ib?.side === 'LONG')
  check('filter: volume 0 (off) -> fires on a weak break bar; 1.2x lets a 1.2x bar through', ibCase(1, { weak: true, filters: ibF({ breakVolumeX: 0 }) }).ib?.side === 'LONG' && ibCase(1, { weak: true, filters: ibF({ breakVolumeX: 1.2 }) }).ib?.side === 'LONG')
  check('filter: volume 2.5x -> the 2x break bar is not enough', !ibCase(1, { filters: ibF({ breakVolumeX: 2.5 }) }).ib)
  const t2 = ibCase(1, { filters: ibF({ targetIb: 2, timeStopMin: 30 }) }).ib
  // (This IB is ~4 pts, so the 1.5x-stop floor sets the target here; the plan shows the filter.)
  check('filter: target 2x the IB range (in the plan), 30-min time stop', t2 && /2x the range beyond/.test(t2.checks.Profile) && t2.target - t2.entry >= L.ib.target - L.ib.entry && t2.timeStopMs - t2.t === 30 * MIN, JSON.stringify(t2?.checks.Profile))
}
// VA rejection long at the previous VAL with a put wall there.
{
  const now = at(100) + 10000
  // spot path drifts down to 22590; put wall 22600 (OI rising). futures = spot + 60 -> 22650 ~ VAL.
  const oi = run((m) => (m < 95 ? 22700 - m : 22605), { 22600: (m) => 5e6 + m * 20000 })
  const bs = bars(0, 99, (m) => { const p = m < 95 ? 22760 - m : (m === 97 ? 22660 : 22668); return { open: p, high: p + 2, low: m === 97 ? 22645 : p - 2, close: p, buy: m === 99 ? 900 : 500, sell: 600 } })
  bs[99].absorption = [{ side: 'buy', price: 22650 }]
  const profile = { vp: { poc: 22720, vah: 22760, val: 22655, hvn: [22720], lvn: [] }, tpoPrev: null }
  const setups = evaluateStrategies({ nowMs: now, price: 22668, bars: bs, minuteBars: bs, prints: tape(now, 70), book: { bids: [{ quantity: 600 }], asks: [{ quantity: 400 }] }, liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi, estimated: false, lotSize: 75, bigLots: 10, profile })
  const va = setups.find((s) => s.id === 'vaRejection')
  check('value-area rejection long at the previous VAL + put wall, target the POC', va?.side === 'LONG' && Math.abs(va.target - 22720) < 1, JSON.stringify(va?.checks ?? setups.map((s) => s.id)))
}
// Top 15 selection.
{
  const mk = (id, rs) => rs.map((r, i) => ({ id, t: i, outcome: { status: r > 0 ? 'win' : 'loss', r } }))
  const t = topFifteen(strategyStats([...mk('range', [-1, -1, -1, -1, -1]), ...mk('lvnRun', [2, 2, 2, -1, 2])]))
  check('top 15 (the measured loser left out), profile group led by its best', t.ids.length === 15 && !t.ids.includes('range') && t.profile.ids[0] === 'lvnRun', t.ids.join())
  const inst = ['oiSqueeze', 'trap', 'cvdDivergence', 'blockTrade', 'imbalanceRetest']
  const active = new Set(STRATEGIES.filter((x) => !x.retired).map((x) => x.id))
  check('unmeasured: top 15 = the 4 OI picks left + profile top 5 + the OI squeeze + the institutional setups, topped up from the rest - nothing retired', inst.every((id) => t.ids.includes(id))
    && ['wallBreak', 'buildUp', 'openingBias', 'iceberg'].every((id) => t.ids.includes(id)) && t.ids.length === 15 && t.ids.every((id) => active.has(id)) && !t.ids.includes('wallDefence') && !t.ids.includes('migration'), t.ids.join())
  // A measured, profitable range strategy outranks an unmeasured institutional one for the last five.
  const t2 = topFifteen(strategyStats([...mk('vwapFade', [1.5, 1.5, -1, 1.5, 1.5, 1.5])]))
  check('a measured profitable range fade gets into the top 15', t2.ids.includes('vwapFade') && t2.ids.length === 15, t2.ids.join())
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
