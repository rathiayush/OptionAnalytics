// The scanner's strike choice (optionTradeAt): ATM, or n strikes in / out of the money for the option
// being traded - paper and live. Execution only: which setups fire never depends on it.
// Run: npm test (node --test) - see CLAUDE.md.
import { buildOiContext, optionTradeAt } from '../src/strategyEngine.js'
const T = Date.parse('2026-10-05T05:00:00Z')
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }
const pts = (side) => [22600, 22650, 22700, 22750, 22800].map((k) => ({ time: new Date(T).toISOString(), strike: k, openInterest: 1e6, price: side === 'CE' ? (22900 - k) / 2 : (k - 22500) / 2 }))
const oi = buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: [{ time: new Date(T).toISOString(), close: 22700 }], futuresBars: [], cePoints: pts('CE'), pePoints: pts('PE') }, null, { live: true })
const setup = { t: T + 30_000, options: { buy: { action: 'BUY', side: 'CE', strike: 22700, premium: 100 }, sell: { action: 'SELL', side: 'PE', strike: 22700, premium: 100 } } }
check('ATM (0): the setup\'s own option, unchanged', optionTradeAt(oi, setup, 'buy', 0) === setup.options.buy)
check('1 ITM call = one strike BELOW', optionTradeAt(oi, setup, 'buy', 1)?.strike === 22650 && optionTradeAt(oi, setup, 'buy', 1).premium === 125)
check('2 OTM call = two strikes ABOVE', optionTradeAt(oi, setup, 'buy', -2)?.strike === 22800 && optionTradeAt(oi, setup, 'buy', -2).premium === 50)
check('1 ITM put = one strike ABOVE', optionTradeAt(oi, setup, 'sell', 1)?.strike === 22750 && optionTradeAt(oi, setup, 'sell', 1).premium === 125)
check('2 OTM put = two strikes BELOW', optionTradeAt(oi, setup, 'sell', -2)?.strike === 22600)
check('a strike with no premium -> no trade (never a made-up price)', optionTradeAt(oi, setup, 'buy', -3) === null)
// Up to 5 strikes either way (the scanner's choices): 5 ITM ... 5 OTM, on a full chain.
{
  const ks = []; for (let k = 22450; k <= 22950; k += 50) ks.push(k)
  const wide = (side) => ks.map((k) => ({ time: new Date(T).toISOString(), strike: k, openInterest: 1e6, price: side === 'CE' ? (23000 - k) / 2 : (k - 22400) / 2 }))
  const oi2 = buildOiContext({ success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: [{ time: new Date(T).toISOString(), close: 22700 }], futuresBars: [], cePoints: wide('CE'), pePoints: wide('PE') }, null, { live: true })
  for (const n of [3, 4, 5]) {
    check(`${n} ITM call = ${n} strikes BELOW, ${n} OTM call = ${n} ABOVE`, optionTradeAt(oi2, setup, 'buy', n)?.strike === 22700 - 50 * n && optionTradeAt(oi2, setup, 'buy', -n)?.strike === 22700 + 50 * n)
    check(`${n} ITM put = ${n} strikes ABOVE, ${n} OTM put = ${n} BELOW`, optionTradeAt(oi2, setup, 'sell', n)?.strike === 22700 + 50 * n && optionTradeAt(oi2, setup, 'sell', -n)?.strike === 22700 - 50 * n)
  }
  check('5 ITM call is priced from its own strike', optionTradeAt(oi2, setup, 'buy', 5).premium === (23000 - 22450) / 2)
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
