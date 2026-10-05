// A paper option trade's own premium stop-loss / target.
// Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, optionStopTargetHit } from '../src/strategyEngine.js'
let fails = 0
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m) } else console.log('ok  ', m) }
const t0 = Date.parse('2026-09-25T12:55:00+05:30')
// 23050 CE premium path: 124.5 at entry, drifts up to 166.5 (the screenshot's -42 loss).
const path = [124.5, 128, 133, 139, 146, 152, 160, 166.5]
const ce = path.map((p, i) => ({ time: new Date(t0 + i * 60000).toISOString(), strike: 23050, openInterest: 1e6, price: p, high: p + 1, low: p - 1 }))
const oi = buildOiContext({ success: true, date: '2026-09-25', step: 50, spotCandlesOneMinute: [], cePoints: ce, pePoints: [], futuresBars: [] })
const sell = { action: 'SELL', side: 'CE', strike: 23050, premium: 124.5 }
const until = t0 + 20 * 60000
let hit = optionStopTargetHit(oi, sell, t0 + 10000, until, 20, 30)
ok(hit && hit.premium === 144.5 && /Max SL 20/.test(hit.reason) && hit.at === t0 + 5 * 60000, `short call stopped at 144.5 (-20), not 166.5: ${JSON.stringify(hit && { ...hit, at: new Date(hit.at).toISOString() })}`)
hit = optionStopTargetHit(oi, { ...sell, action: 'BUY' }, t0 + 10000, until, 20, 30)
ok(hit && hit.premium === 154.5 && /Target 30/.test(hit.reason), `bought call: target +30 at 154.5: ${hit?.reason}`)
ok(optionStopTargetHit(oi, sell, t0 + 10000, until, 0, 0) === null, 'both off -> no own exit')
ok(optionStopTargetHit(oi, sell, t0 + 10000, t0 + 3 * 60000, 20, 30) === null, 'nothing before the setup exit / clock -> null')

// Trailing on the premium: after +10 pts of profit the stop follows the best premium 8 pts behind.
{
  const up = [124.5, 130, 140, 150, 145, 138, 130]
  const pts = up.map((p, i) => ({ time: new Date(t0 + i * 60000).toISOString(), strike: 23050, openInterest: 1e6, price: p, high: p + 1, low: p - 1 }))
  const oi2 = buildOiContext({ success: true, date: '2026-09-25', step: 50, spotCandlesOneMinute: [], cePoints: pts, pePoints: [], futuresBars: [] })
  const buy = { action: 'BUY', side: 'CE', strike: 23050, premium: 124.5 }
  const h = optionStopTargetHit(oi2, buy, t0 + 10000, until, 20, 0, { start: 10, gap: 8 })
  ok(h && h.premium === 143 && /Trailing SL hit/.test(h.reason) && h.at === t0 + 6 * 60000, `bought call: trailed to 143 (best 151 - 8), out on the pullback, +18.5 instead of riding back down: ${JSON.stringify(h && { ...h, at: new Date(h.at).toISOString() })}`)
  ok(optionStopTargetHit(oi2, buy, t0 + 10000, until, 20, 0, { start: 40, gap: 8 }) === null, 'not 40 pts in profit yet: the trail never starts, the fixed stop stays')
  ok(optionStopTargetHit(oi2, buy, t0 + 10000, until, 0, 0, { start: 10, gap: 8 })?.premium === 143, 'trailing works with no fixed SL / target set')
  // SELL mirror: premium falls then bounces.
  const down = [124.5, 118, 108, 98, 103, 110, 118]
  const ptsS = down.map((p, i) => ({ time: new Date(t0 + i * 60000).toISOString(), strike: 23050, openInterest: 1e6, price: p, high: p + 1, low: p - 1 }))
  const oi3 = buildOiContext({ success: true, date: '2026-09-25', step: 50, spotCandlesOneMinute: [], cePoints: ptsS, pePoints: [], futuresBars: [] })
  const hs = optionStopTargetHit(oi3, { ...buy, action: 'SELL' }, t0 + 10000, until, 20, 0, { start: 10, gap: 8 })
  ok(hs && hs.premium === 105 && /Trailing SL hit/.test(hs.reason), `sold call: trailed down to 105 (best 97 + 8), out on the bounce: ${hs?.reason} @ ${hs?.premium}`)
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
