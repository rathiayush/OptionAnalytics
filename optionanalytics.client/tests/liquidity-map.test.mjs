// The liquidity map (orderFlowMath.liquidityMap): support / resistance walls, high / low liquidity
// zones, confluence, and what is happening at the wall now - absorption, exhaustion, break, pulled.
// Run: npm test (node --test) - see CLAUDE.md.
import { liquidityMap } from '../src/orderFlowMath.js'

let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }
const T0 = Date.parse('2026-10-05T05:00:00Z')
const NOW = T0 + 10 * 60_000
// A book every 30 s for 10 minutes: 100 a row, a 2-row bid wall at 22745-22746 (1000 each), another at
// 22740, an offer wall at 22758 (800), thin offers 22752-22756 (10). `wall(t)` scales the bid wall.
function book({ wall = () => 1, thinFrom = 22752, thinTo = 22756 } = {}) {
  const cols = []
  for (let t = T0; t <= NOW; t += 30_000) {
    const bids = []
    const asks = []
    for (let p = 22735; p <= 22749; p++) bids.push([p, p === 22745 || p === 22746 ? 1000 * wall(t) : p === 22740 ? 900 : 100])
    for (let p = 22751; p <= 22765; p++) asks.push([p, p === 22758 ? 800 : p >= thinFrom && p <= thinTo ? 10 : 100])
    cols.push({ t, bids, asks })
  }
  return cols
}
// Three completed minutes before NOW with footprint rows at the wall.
const bars = (rows) => rows.map((r, i) => {
  const levels = r.levels ?? []
  const buy = r.buy ?? levels.reduce((s, l) => s + l.buy, 0)
  const sell = r.sell ?? levels.reduce((s, l) => s + l.sell, 0)
  return { time: NOW - (3 - i) * 60_000, open: 0, high: 0, low: 0, close: 0, buy, sell, levels }
})
const run = (o = {}) => liquidityMap({ columns: o.columns ?? book(), minuteBars: o.bars ?? [], rowSize: 1, lotSize: 75, price: o.price ?? 22750, nowMs: NOW, extraLevels: o.extra ?? [] })

{
  const m = run()
  check('support walls nearest first: 22745-22746, then 22740', m.support[0]?.low === 22745 && m.support[0]?.high === 22746 && m.support[1]?.price === 22740, JSON.stringify(m.support.map((w) => [w.low, w.high])))
  check('resistance: the offer wall at 22758', m.resistance[0]?.price === 22758 && m.resistance[0].trend === 'holding', JSON.stringify(m.resistance))
  check('high-liquidity zone at the 2-row bid wall', m.zones.some((z) => z.kind === 'high' && z.low === 22745 && z.high === 22746))
  check('low-liquidity zone at the thin offers 22752-22756', m.zones.some((z) => z.kind === 'low' && z.low === 22752 && z.high === 22756), JSON.stringify(m.zones))
  check('between the walls (4 rows from support): "between", range read', m.now.state === 'between', JSON.stringify(m.now))
}
{
  const m = run({ extra: [{ price: 22745, kind: 'oi', label: 'PUT OI wall 22700' }, { price: 22746, kind: 'val', label: 'VAL' }, { price: 22900, kind: 'vwap', label: 'VWAP' }] })
  const c = m.confluence.find((g) => g.low <= 22746 && g.high >= 22745)
  check('confluence: bid wall + PUT OI wall + VAL line up at 22745 - Strong support', c && c.strength === 'Strong' && c.side === 'support' && c.kinds.includes('oi') && c.kinds.includes('heatmap'), JSON.stringify(m.confluence))
  check('a lone weak line (VWAP far away) is not a confluence level', !m.confluence.some((g) => g.price === 22900))
}
{
  // Absorption: price 2 rows over the wall, 2,400 sold into it in 3 min, the wall holds.
  const m = run({ price: 22748, bars: bars([{ levels: [{ price: 22746, buy: 100, sell: 900 }] }, { levels: [{ price: 22745, buy: 100, sell: 800 }] }, { levels: [{ price: 22746, buy: 100, sell: 700 }] }]) })
  check('absorption at the bid wall -> bullish, possible bounce toward the 22758 offer wall', m.now.state === 'absorption' && m.now.bullish === true && m.now.move.dir === 1 && m.now.move.target === 22758, JSON.stringify(m.now))
  console.log('   ', m.now.text, '|', m.now.move.text)
}
{
  // Exhaustion: sellers pushing in on fading volume and a shrinking delta, little traded at the wall.
  const m = run({ price: 22748, bars: bars([{ buy: 200, sell: 800 }, { buy: 300, sell: 600 }, { buy: 150, sell: 250 }]) })
  check('exhaustion into the bid wall -> bullish, possible bounce', m.now.state === 'exhaustion' && m.now.bullish === true && m.now.move.dir === 1, JSON.stringify(m.now))
}
{
  // Break: the wall's size falls to 20% in the last 2 minutes while it trades heavily.
  const columns = book({ wall: (t) => (t >= NOW - 120_000 ? 0.2 : 1) })
  const m = run({ columns, price: 22748, bars: bars([{ levels: [{ price: 22746, buy: 100, sell: 900 }] }, { levels: [{ price: 22745, buy: 50, sell: 900 }] }, { levels: [{ price: 22745, buy: 50, sell: 600 }] }]) })
  check('wall being eaten -> break down toward the next support (22740)', m.now.state === 'break' && m.now.bullish === false && m.now.move.dir === -1 && m.now.move.target === 22740, JSON.stringify(m.now))
}
{
  // Pulled: the same drop with almost nothing traded there.
  const columns = book({ wall: (t) => (t >= NOW - 120_000 ? 0.2 : 1) })
  const m = run({ columns, price: 22748, bars: bars([{ buy: 100, sell: 120 }, { buy: 100, sell: 110 }, { buy: 90, sell: 100 }]) })
  check('wall vanishing with little traded -> pulled (spoof), bearish', m.now.state === 'pulled' && m.now.bullish === false, JSON.stringify(m.now))
}
{
  // Vacuum: price inside the thin zone with buying flow -> a fast move up to the offer wall.
  const m = run({ price: 22754, bars: bars([{ buy: 500, sell: 300 }, { buy: 500, sell: 300 }, { buy: 500, sell: 300 }]) })
  check('in a low-liquidity zone with buying -> fast move up to 22758', m.now.state === 'vacuum' && m.now.move.dir === 1 && m.now.move.target === 22758, JSON.stringify(m.now))
}
{
  // No look-ahead: a snapshot after the clock changes nothing.
  const columns = book()
  const later = [...columns, { t: NOW + 30_000, bids: [[22747, 99999]], asks: [[22751, 99999]] }]
  check('snapshots after the clock are not read', JSON.stringify(run({ columns })) === JSON.stringify(run({ columns: later })))
  check('too few snapshots: no read', liquidityMap({ columns: columns.slice(-3), rowSize: 1, price: 22750, nowMs: NOW }) === null)
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
