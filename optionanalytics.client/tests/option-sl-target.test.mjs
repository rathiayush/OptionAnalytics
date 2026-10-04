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
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
