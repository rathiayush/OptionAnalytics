// Options OI read (whole chain, since open), the option to trade a setup with, and the order flow read parts.
// Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, optionTradesFor, optionPnlPoints, oiBiasParts, optionTradeText, optionOiRead, optionOiStance } from '../src/strategyEngine.js'
import { orderFlowBias } from '../src/orderFlowMath.js'
let fails = 0
const ok = (c, m) => { if (!c) { fails++; console.log('FAIL', m) } else console.log('ok  ', m) }
const t0 = Date.parse('2026-10-05T10:00:00+05:30')
const ce = [], pe = [], spot = [], fut = []
for (let m = 0; m <= 30; m++) {
  const time = new Date(t0 + m * 60000).toISOString()
  const s = 22600 + m * 2
  spot.push({ time, close: s, open: s, high: s, low: s })
  fut.push({ time, open: s + 60, high: s + 60, low: s + 60, close: s + 60, volume: 1, openInterest: 1e7 + m * 20000 }) // price up, OI up = long build-up
  for (let k = 22450; k <= 22800; k += 50) {
    // puts written near ATM (bullish), calls flat
    pe.push({ time, strike: k, openInterest: 1e6 + (Math.abs(k - 22600) <= 150 ? m * 30000 : 0), price: Math.max(5, 100 - (s - k) * 0.5) })
    ce.push({ time, strike: k, openInterest: 1e6, price: Math.max(5, 100 + (s - k) * 0.5) })
  }
}
const oi = buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: spot, cePoints: ce, pePoints: pe, futuresBars: fut })
const at = t0 + 20 * 60000
const trades = optionTradesFor(oi, 1, 22640, at)
ok(trades.buy.side === 'CE' && trades.sell.side === 'PE' && trades.buy.strike === 22650 && trades.sell.action === 'SELL', `LONG: buy CE / sell PE at ATM: ${optionTradeText(trades.buy)} | ${optionTradeText(trades.sell)}`)
const short = optionTradesFor(oi, -1, 22640, at)
ok(short.buy.side === 'PE' && short.sell.side === 'CE', 'SHORT: buy PE / sell CE')
const later = t0 + 30 * 60000
const pb = optionPnlPoints(trades.buy, oi, later), ps = optionPnlPoints(trades.sell, oi, later)
ok(pb.points > 0 && ps.points > 0, `market rose: bought CE gains ${pb.points.toFixed(1)}, sold PE gains ${ps.points.toFixed(1)}`)
const parts = oiBiasParts(oi, at)
console.log(parts)
ok(parts.find((p) => p.name === 'Options OI · since open')?.score > 0.3 && parts.find((p) => p.name === 'Options OI · 15 min')?.score > 0.3, 'put writing -> options OI bullish on both clocks')
ok(parts.find((p) => p.name === 'Futures OI · 15 min')?.score > 0.3 && /long build-up/.test(parts.find((p) => p.name === 'Futures OI · since open').detail), 'long build-up -> futures OI bullish')
const flowOnly = orderFlowBias({ bars: [], nowMs: at })
const withOi = orderFlowBias({ bars: [], nowMs: at, extra: parts })
ok(flowOnly.parts.length === 0 && withOi.bias === 'Bullish' && withOi.confidence > 0, `bias with OI: ${withOi.bias} ${withOi.confidence}% score ${withOi.score}`)
// Whole chain vs near strikes: call writing far above the money (bearish) with puts written only near ATM.
{
  const ce2 = [], pe2 = []
  for (let m = 0; m <= 30; m++) {
    const time = new Date(t0 + m * 60000).toISOString()
    for (let k = 22300; k <= 23000; k += 50) {
      const far = k >= 22800
      ce2.push({ time, strike: k, openInterest: 1e6 + (far ? m * 60000 : 0), price: 10 })
      pe2.push({ time, strike: k, openInterest: 1e6 + (Math.abs(k - 22600) <= 100 ? m * 20000 : 0), price: 10 })
    }
  }
  const oi2 = buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: spot, cePoints: ce2, pePoints: pe2, futuresBars: fut })
  const at2 = t0 + 20 * 60000
  const chain = optionOiRead(oi2, 22600, at2, 15)
  const near = optionOiRead(oi2, 22600, at2, 15, 2)
  ok(chain.strikes === 15 && chain.combined < 0 && optionOiStance(chain, 1) !== 'agrees', `chain sees the far call writing: combined ${chain.combined.toFixed(2)} (${optionOiStance(chain, 1)} for a long)`)
  ok(near.strikes === 5 && near.combined > 0 && optionOiStance(near, 1) === 'agrees', `ATM ±2 only sees the put writing: combined ${near.combined.toFixed(2)}`)
  // At 20 minutes past the open the latest FINISHED minute is the 19th (a replayed minute is read once it is over).
  ok(chain.ceOpen === 19 * 60000 * 5 && chain.peOpen === 19 * 20000 * 5, `since open: calls +${chain.ceOpen}, puts +${chain.peOpen}`)
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
