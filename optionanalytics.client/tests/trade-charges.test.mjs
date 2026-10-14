// Option trade charges (tradeCharges.js): STT on the sell leg's premium, Rs 20 + Rs 20 brokerage, Rs 7
// other - net P&L, net per lot and the points captured.
// Run: npm test (node --test) - see CLAUDE.md.
import { tradeCharges, chargesSummary, chargeRates, DEFAULT_CHARGES } from '../src/tradeCharges.js'
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }
const near = (a, b) => Math.abs(a - b) < 1e-9

check('defaults: 0.15% STT, Rs 20 per order, Rs 7 other', DEFAULT_CHARGES.sttPct === 0.15 && DEFAULT_CHARGES.brokeragePerOrder === 20 && DEFAULT_CHARGES.otherPerTrade === 7)
// SELL PE 1 lot (75) at 100, bought back at 80: +20 pts = Rs 1,500; STT 0.15% of 100 x 75 = 11.25.
const sell = tradeCharges({ action: 'SELL', premium: 100, current: 80, lots: 1, lotSize: 75 })
check('SELL: STT on the entry (sell) premium, 40 brokerage, 7 other -> net 1,441.75', near(sell.points, 20) && near(sell.gross, 1500) && near(sell.stt, 11.25)
  && sell.brokerage === 40 && sell.other === 7 && near(sell.charges, 58.25) && near(sell.net, 1441.75) && near(sell.netPerLot, 1441.75), JSON.stringify(sell))
// The same with 2 lots: gross and STT double, the flat charges do not; per lot = the 1-lot trade.
const two = tradeCharges({ action: 'SELL', premium: 100, current: 80, lots: 2, lotSize: 75 })
check('2 lots: gross 3,000, STT 22.50, net 2,930.50; net per lot still 1,441.75', near(two.gross, 3000) && near(two.stt, 22.5) && near(two.net, 2930.5) && near(two.netPerLot, 1441.75), JSON.stringify(two))
// BUY CE at 50, sold at 62: STT on the exit (sell) premium 62 x 75 = 6.975.
const buy = tradeCharges({ action: 'BUY', premium: 50, current: 62, lots: 1, lotSize: 75 })
check('BUY: STT on the exit (sell) premium -> net 846.025', near(buy.points, 12) && near(buy.stt, 6.975) && near(buy.net, 900 - 6.975 - 47), JSON.stringify(buy))
// A loser: SELL at 90, bought back at 110 - charges make it worse.
const loss = tradeCharges({ action: 'SELL', premium: 90, current: 110, lots: 1, lotSize: 75 })
check('a loss gets the charges on top', near(loss.gross, -1500) && near(loss.net, -1500 - 10.125 - 47), JSON.stringify(loss))
check('no price yet: nothing', tradeCharges({ action: 'BUY', premium: 50, current: null, lots: 1, lotSize: 75 }) === null)
const custom = tradeCharges({ action: 'SELL', premium: 100, current: 80, lots: 1, lotSize: 75 }, { sttPct: 0.1, brokeragePerOrder: 0, otherPerTrade: 0 })
check('custom rates (0.1% STT, zero brokerage / other)', near(custom.charges, 7.5) && near(custom.net, 1492.5), JSON.stringify(custom))
check('bad rates fall back to the defaults; 0 stays 0', JSON.stringify(chargeRates({ sttPct: -1, brokeragePerOrder: 'x', otherPerTrade: 0 })) === JSON.stringify({ sttPct: 0.15, brokeragePerOrder: 20, otherPerTrade: 0 }))
const sum = chargesSummary([
  { action: 'SELL', premium: 100, current: 80, lots: 2, lotSize: 75 },
  { action: 'BUY', premium: 50, current: 62, lots: 1, lotSize: 75 },
  { action: 'BUY', premium: 50, current: null, lots: 1, lotSize: 75 },
])
check('totals: trades with a price, points captured, gross, charges, net, net per lot', sum.trades === 2 && near(sum.points, 32) && near(sum.gross, 3900)
  && near(sum.charges, 69.5 + 53.975) && near(sum.net, 2930.5 + 846.025) && near(sum.netPerLot, 1441.75 + 846.025), JSON.stringify(sum))
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
