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

// Levels changed while the trade is OPEN (levelLog): each minute is judged with the levels in force when it
// started - a change applies from its minute on and never rewrites what already passed.
{
  const lv = (t, sl, target, trailStart = 0, trailGap = 0) => ({ t, sl, target, trailStart, trailGap })
  const first = [lv(t0 + 10000, 20, 30)]
  // The SELL's premium path 124.5 -> 166.5 is stopped at 144.5 at minute 5 with a 20-pt SL.
  let h = optionStopTargetHit(oi, sell, t0 + 10000, until, 20, 30, null, first)
  ok(h?.premium === 144.5 && h.at === t0 + 5 * 60000, 'a one-entry log is the same as no log')
  // Widened to 60 from minute 3: the 144.5 level is not the stop any more - it holds to the end (166.5 < 184.5).
  h = optionStopTargetHit(oi, sell, t0 + 10000, until, 60, 30, null, [...first, lv(t0 + 3 * 60000, 60, 30)])
  ok(h === null, 'SL widened to 60 at minute 3: the trade is still open')
  // Tightened to 10 from minute 3: stopped at 134.5 as soon as the next minute starts (premium by then 139).
  h = optionStopTargetHit(oi, sell, t0 + 10000, until, 10, 30, null, [...first, lv(t0 + 3 * 60000, 10, 30)])
  ok(h?.premium === 134.5 && h.at === t0 + 4 * 60000 && /Max SL 10/.test(h.reason), `SL tightened to 10 at minute 3: out at 134.5 in the next minute, not back at minute 1-2: ${JSON.stringify(h)}`)
  // A tighter SL set at minute 5 cannot reach back: minutes 0-4 were judged with 20 (and 20 hits at minute 5 first).
  h = optionStopTargetHit(oi, sell, t0 + 10000, until, 5, 30, null, [...first, lv(t0 + 5 * 60000, 5, 30)])
  ok(h?.premium === 129.5 || h?.premium === 144.5, `a change at minute 5 applies from minute 5 on: ${JSON.stringify(h)}`)
  // Target moved closer from minute 2 on a BUY: +10 instead of +30.
  const buy = { ...sell, action: 'BUY' }
  h = optionStopTargetHit(oi, buy, t0 + 10000, until, 20, 30, null, [...first, lv(t0 + 2 * 60000, 20, 10)])
  ok(h?.premium === 134.5 && /Target 10/.test(h.reason), `target moved to +10 at minute 2: ${JSON.stringify(h)}`)
  // Trail switched on from minute 2: starts after +10, follows 5 behind.
  h = optionStopTargetHit(oi, buy, t0 + 10000, until, 0, 0, null, [lv(t0 + 10000, 0, 0), lv(t0 + 2 * 60000, 0, 0, 10, 5)])
  ok(h === null, 'a trail on a premium that only rises never stops a BUY')
}

// A change of the trail never loosens the stop it had earned (CLAUDE.md): BUY 100, up to 130.5 with a 5-pt trail (stop
// 125.5 by minute 4), then down to 120.5 - widened to 20 pts or switched off at minute 4, it is still out at 125.5.
{
  const lv = (t, sl, target, trailStart = 0, trailGap = 0) => ({ t, sl, target, trailStart, trailGap })
  const pts = [100, 110, 120, 130, 128, 122, 121].map((p, i) => ({ time: new Date(t0 + i * 60000).toISOString(), strike: 23050, openInterest: 1e6, price: p, high: p + 0.5, low: p - 0.5 }))
  const oiT = buildOiContext({ success: true, date: '2026-09-25', step: 50, spotCandlesOneMinute: [], cePoints: pts, pePoints: [], futuresBars: [] })
  const buy = { action: 'BUY', side: 'CE', strike: 23050, premium: 100 }
  const first = lv(t0 + 10000, 20, 0, 0, 5)
  const base = optionStopTargetHit(oiT, buy, t0 + 10000, until, 20, 0, { start: 0, gap: 5 })
  ok(base?.premium === 125.5 && base.at === t0 + 6 * 60000, `5-pt trail: out at 125.5 in minute 5: ${JSON.stringify(base)}`)
  for (const [what, change] of [['widened to 20', lv(t0 + 4 * 60000, 20, 0, 0, 20)], ['switched off', lv(t0 + 4 * 60000, 20, 0, 0, 0)]]) {
    const h = optionStopTargetHit(oiT, buy, t0 + 10000, until, 20, 0, { start: 0, gap: 5 }, [first, change])
    ok(h?.premium === 125.5 && h.at === base.at && /Trailing SL hit/.test(h.reason), `trail ${what} at minute 4: still out at the earned 125.5: ${JSON.stringify(h)}`)
  }
  // A tighter trail from minute 4 still applies at once.
  const tight = optionStopTargetHit(oiT, buy, t0 + 10000, until, 20, 0, { start: 0, gap: 5 }, [first, lv(t0 + 4 * 60000, 20, 0, 0, 1)])
  ok(tight?.premium === 129.5 && tight.at === t0 + 5 * 60000, `trail tightened to 1 pt at minute 4: out at 129.5 in minute 4: ${JSON.stringify(tight)}`)
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
