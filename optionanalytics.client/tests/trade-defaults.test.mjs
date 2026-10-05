// Default option stop-loss / target per underlying (tradeDefaults.js) - used by the OI Replay trade panel
// and the strategy scanner.
// Run: npm test (node --test) - see CLAUDE.md.
const store = new Map()
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
const { defaultTradeLevels, loadTradeLevels, saveTradeLevels, FALLBACK_TRADE_LEVELS } = await import('../src/tradeDefaults.js')
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }

const n = defaultTradeLevels('NIFTY')
const b = defaultTradeLevels('banknifty')
const x = defaultTradeLevels('SENSEX')
check('every index has BOTH a stop-loss and a target by default (a live super order needs both)', [n, b, x].every((l) => l.sl > 0 && l.target > 0), JSON.stringify({ n, b, x }))
check('BANKNIFTY and SENSEX get wider levels than NIFTY (their premiums move more)', b.sl > n.sl && x.sl > n.sl && b.target > n.target)
check('targets are further than stops (reward above risk)', [n, b, x].every((l) => l.target > l.sl))
check('an unknown underlying gets the fallback, never nothing', JSON.stringify(defaultTradeLevels('FINNIFTY')) === JSON.stringify(FALLBACK_TRADE_LEVELS))

check('nothing saved: the defaults, trailing off', JSON.stringify(loadTradeLevels('scanner', 'BANKNIFTY')) === JSON.stringify({ ...b, trailStart: 0, trailGap: 0 }))
saveTradeLevels('scanner', 'BANKNIFTY', { sl: 40, target: 0 })
check('what the trader sets is kept per underlying (a target of 0 = off stays 0)', JSON.stringify(loadTradeLevels('scanner', 'BANKNIFTY')) === JSON.stringify({ sl: 40, target: 0, trailStart: 0, trailGap: 0 }))
check('...without touching another underlying', JSON.stringify(loadTradeLevels('scanner', 'NIFTY')) === JSON.stringify({ ...n, trailStart: 0, trailGap: 0 }))
check('...or the other page', JSON.stringify(loadTradeLevels('oiReplay', 'BANKNIFTY')) === JSON.stringify({ ...b, trailStart: 0, trailGap: 0 }))
saveTradeLevels('oiReplay', 'NIFTY', { sl: null, target: 45 })
check('a cleared box falls back to the default for that level only', JSON.stringify(loadTradeLevels('oiReplay', 'NIFTY')) === JSON.stringify({ sl: n.sl, target: 45, trailStart: 0, trailGap: 0 }))
saveTradeLevels('oiReplay', 'NIFTY', { trailStart: 10, trailGap: 8 })
check('trailing is saved per underlying too, keeping the SL / target', JSON.stringify(loadTradeLevels('oiReplay', 'NIFTY')) === JSON.stringify({ sl: n.sl, target: 45, trailStart: 10, trailGap: 8 }))
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
