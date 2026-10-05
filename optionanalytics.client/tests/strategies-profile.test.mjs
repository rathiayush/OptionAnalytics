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

// IB breakout long at 10:40: put writing near ATM over the last hour, close above the IB high.
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
{
  const now = at(85) + 10000
  const oi = run((m) => 22650 + (m < 84 ? (m % 5) : 12), { 22650: (m) => 3e6 + m * 20000, 22600: (m) => 3e6 + m * 20000 })
  const bs = bars(0, 84, (m) => { const p = m < 84 ? 22710 + (m % 5) : 22722; return { open: p - 1, high: p + 1, low: p - 1, close: p, buy: m === 84 ? 1500 : 500, sell: 500 } })
  const setups = evaluateStrategies({ nowMs: now, price: 22722, bars: bs, minuteBars: bs, prints: tape(now, 70), book: { bids: [{ quantity: 600 }], asks: [{ quantity: 400 }] }, liquidity: [], pullStack: [], sweeps: [], icebergs: [], oi, estimated: false, lotSize: 75, bigLots: 10, profile: null })
  const ib = setups.find((s) => s.id === 'ibBreakout')
  check('IB breakout long fires above the first-hour high', ib?.side === 'LONG' && ib.target > ib.entry && ib.stop < ib.entry, JSON.stringify(ib?.checks ?? setups.map((s) => s.id)))
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
  const inst = ['suddenWall', 'heatmapOi', 'vwapPullback', 'oiStructure', 'oiSqueeze', 'trap']
  check('unmeasured: top 15 = OI top 5 + the 4 profile strategies (#12 retired) + the sudden wall, the heatmap + OI wall, the VWAP pullback, the OI structure, the OI squeeze and the breakout trap (#19-#21 wait until measured)', inst.every((id) => t.ids.includes(id)) && !t.ids.includes('tpo80') && !t.ids.includes('wallDefence'), t.ids.join())
  // A measured, profitable range strategy outranks an unmeasured institutional one for the last five.
  const t2 = topFifteen(strategyStats([...mk('vwapFade', [1.5, 1.5, -1, 1.5, 1.5, 1.5])]))
  check('a measured profitable range fade gets into the top 15', t2.ids.includes('vwapFade') && t2.ids.length === 15, t2.ids.join())
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
