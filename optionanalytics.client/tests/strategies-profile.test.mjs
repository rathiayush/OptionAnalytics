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
check('28 strategies, 5 in the profile group, 3 range-bound', STRATEGIES.length === 28 && STRATEGIES.filter((s) => s.group === 'profile').length === 5 && STRATEGIES.filter((s) => s.group === 'range').length === 3)

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
    return { open: p - dir, high: p + 1, low: p - 1, close: p, buy: dir > 0 ? withTrade : 500, sell: dir > 0 ? 500 : withTrade }
  })
  const price = bs.at(-1).close
  const setups = evaluateStrategies({ nowMs: now, price, bars: bs, minuteBars: bs, prints: tape(now, dir > 0 ? 70 : 30), book: dir > 0 ? { bids: [{ quantity: 600 }], asks: [{ quantity: 400 }] } : { bids: [{ quantity: 400 }], asks: [{ quantity: 600 }] }, liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi, estimated: false, lotSize: 75, bigLots: 10, profile: null })
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
  const L = ibCase(1)
  check('IB breakout LONG: two closes above the first-hour high, first break, 2x volume', L.ib?.side === 'LONG' && L.ib.target > L.ib.entry && L.ib.stop < L.ib.entry && /2 closes beyond/.test(L.ib.checks.Footprint), show(L))
  const S = ibCase(-1)
  check('IB breakout SHORT (the mirror): two closes below the first-hour low', S.ib?.side === 'SHORT' && S.ib.target < S.ib.entry && S.ib.stop > S.ib.entry, show(S))
  check('not on a one-bar poke (the second close back inside the IB)', !ibCase(1, { poke: true }).ib && !ibCase(-1, { poke: true }).ib)
  check('not on the first close beyond only (no acceptance yet)', !ibCase(1, { breakAt: 84 }).ib && !ibCase(-1, { breakAt: 84 }).ib)
  check('not once the break has already been running (third close beyond)', !ibCase(1, { breakAt: 82 }).ib)
  check('not when an earlier break of that side was accepted and failed', !ibCase(1, { earlier: [70, 71] }).ib && !ibCase(-1, { earlier: [70, 71] }).ib)
  check('...but an earlier one-bar poke does not block it', ibCase(1, { earlier: [70] }).ib?.side === 'LONG')
  check('not when the break bar trades under 1.5x the IB\'s average volume', !ibCase(1, { weak: true }).ib && !ibCase(-1, { weak: true }).ib)
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
  check('unmeasured: top 15 = OI top 5 + profile top 5 + the OI squeeze and institutional setups', inst.every((id) => t.ids.includes(id)) && !t.ids.includes('atmFlip'), t.ids.join())
  // A measured, profitable range strategy outranks an unmeasured institutional one for the last five.
  const t2 = topFifteen(strategyStats([...mk('vwapFade', [1.5, 1.5, -1, 1.5, 1.5, 1.5])]))
  check('a measured profitable range fade gets into the top 15', t2.ids.includes('vwapFade') && t2.ids.length === 15, t2.ids.join())
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
