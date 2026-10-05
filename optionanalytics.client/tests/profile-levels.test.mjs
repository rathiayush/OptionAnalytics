// Volume / market profile levels against the standard (CBOT / Steidlmayer) definitions: POC = most volume
// (TPOs), ties to the row nearest the range's middle; value area = 70%, built from the POC by adding the
// larger of the TWO rows above vs the TWO rows below. Run: npm test (node --test) - see CLAUDE.md.
import { pocIndexOf, valueAreaOf, volumeProfile } from '../src/orderFlowMath.js'
import { tpoProfile } from '../src/profiles.js'
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }

// Worked example (rows low -> high, prices 100..108). Total 285, 70% = 199.5. POC = 105 (100).
//   two rows at a time: +106/107 (65 > 104/103's 60) = 165; +104/103 (60 > 108's 5) = 225 -> VA 103-107.
//   one row at a time (the old way) would stop at 104-106 - a different value area.
const counts = [5, 10, 40, 10, 50, 100, 60, 5, 5]
{
  const va = valueAreaOf(counts, 5, 0.7)
  check('value area by the two-row rule: rows 3..7 (103-107)', va.lo === 3 && va.hi === 7, JSON.stringify(va))
  const bars = [{ levels: counts.map((c, i) => ({ price: 100 + i, buy: c / 2, sell: c / 2 })) }]
  const vp = volumeProfile(bars)
  check('volume profile: POC 105, VAL 103, VAH 107, 70%+ inside', vp.poc === 105 && vp.val === 103 && vp.vah === 107
    && counts.slice(3, 8).reduce((s, c) => s + c, 0) >= 0.7 * 285, JSON.stringify({ poc: vp.poc, val: vp.val, vah: vp.vah }))
}
check('POC tie: the row nearest the middle (not the lowest price)', pocIndexOf([30, 5, 5, 30, 10, 10]) === 3)
check('value area never runs past the ends; a one-row profile is its own VA', JSON.stringify(valueAreaOf([7], 0)) === '{"lo":0,"hi":0}' && JSON.stringify(valueAreaOf([1, 1, 1], 1)) === '{"lo":0,"hi":2}')
{
  // TPO: 30-minute periods, letters per row, IB = first two periods, the same POC / value-area rules.
  const T = Date.parse('2026-10-05T03:45:00Z') // 09:15 IST
  const bars = []
  const range = (m) => (m < 30 ? [100, 110] : m < 60 ? [104, 112] : m < 90 ? [106, 114] : [105, 109])
  for (let m = 0; m < 120; m++) { const [lo, hi] = range(m); bars.push({ time: T + m * 60000, open: lo, high: hi, low: lo, close: hi }) }
  const tpo = tpoProfile(bars, 1)
  const letters = Object.fromEntries(tpo.rows.map((r) => [r.price, r.letters]))
  check('TPO letters: A 09:15-09:45, B 09:45-10:15, C, D', letters[100] === 'A' && letters[104] === 'AB' && letters[107] === 'ABCD' && letters[114] === 'C', JSON.stringify(letters))
  check('initial balance = first two periods (A, B): 100-112', tpo.ib.low === 100 && tpo.ib.high === 112)
  const c = tpo.rows.map((r) => r.count)
  const p = pocIndexOf(c)
  const va = valueAreaOf(c, p, 0.7)
  check('TPO POC / value area use the same standard rules', tpo.poc === tpo.rows[p].price && tpo.val === tpo.rows[va.lo].price && tpo.vah === tpo.rows[va.hi].price, JSON.stringify({ poc: tpo.poc, val: tpo.val, vah: tpo.vah }))
  check('TPO POC is in the 4-letter area (106-109), nearest the middle', [107, 108].includes(tpo.poc), tpo.poc)
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
