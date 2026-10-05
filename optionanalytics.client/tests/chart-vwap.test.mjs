// Chart VWAP (chartVwap.js): the session VWAP on a candle chart's OWN candle times - the cause of the
// "VWAP distorts the chart" bug was a 1-minute / multi-day VWAP series adding time points the candles
// did not have. Run: npm test (node --test) - see CLAUDE.md.
import { alignToBars, chartVwap, sessionVwapFromBars } from '../src/chartVwap.js'
let fails = 0
const check = (n, c, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'} ${n} ${c ? '' : x}`); if (!c) fails++ }
const DAY = 86400
const D1 = 20000 * DAY + 9 * 3600 + 15 * 60 // 09:15 IST of some day, in chart time (IST-shifted seconds)
const bar = (t, h, l, c, v) => ({ time: t, open: c, high: h, low: l, close: c, volume: v })

{
  const bars = [bar(D1, 102, 98, 100, 10), bar(D1 + 60, 105, 101, 104, 30), bar(D1 + 120, 106, 100, 103, 0)]
  const v = sessionVwapFromBars(bars)
  const tp1 = (102 + 98 + 100) / 3, tp2 = (105 + 101 + 104) / 3
  check('VWAP = cumulative typical price x volume / volume', Math.abs(v[0].value - tp1) < 1e-9 && Math.abs(v[1].value - (tp1 * 10 + tp2 * 30) / 40) < 1e-9, JSON.stringify(v))
  check('a zero-volume candle carries the VWAP on (no change)', Math.abs(v[2].value - v[1].value) < 1e-9 && v.length === 3)
  const next = sessionVwapFromBars([...bars, bar(D1 + DAY, 200, 198, 199, 5)])
  check('restarts on the next IST day', Math.abs(next.at(-1).value - 199) < 1e-9)
  check('no volume anywhere: null (the caller aligns the server series instead)', sessionVwapFromBars([bar(D1, 1, 1, 1, 0)]) === null && sessionVwapFromBars([{ time: D1, high: 2, low: 1, close: 1 }]) === null)
  check('no point before the first volume', sessionVwapFromBars([bar(D1, 1, 1, 1, 0), bar(D1 + 60, 2, 2, 2, 5)]).length === 1)
  check('footprint bars (buy / sell instead of volume) count', sessionVwapFromBars([{ time: D1, high: 2, low: 2, close: 2, buy: 3, sell: 2 }])?.[0].value === 2)
}
{
  // The bug: 1-minute VWAP for 3 days on a 5-minute chart of the last day.
  const series = []
  for (let d = -2; d <= 0; d++) for (let m = 0; m < 375; m++) series.push({ time: D1 + d * DAY + m * 60, value: 100 + d + m / 1000 })
  const bars = Array.from({ length: 75 }, (_, i) => bar(D1 + i * 300, 1, 1, 1, 0))
  const out = alignToBars(series, bars)
  const barTimes = new Set(bars.map((b) => b.time))
  check('aligned: every VWAP point is on a candle time (no extra time points - the distortion)', out.length === 75 && out.every((p) => barTimes.has(p.time)))
  check('aligned: each candle takes the VWAP at its last minute', Math.abs(out[0].value - (100 + 4 / 1000)) < 1e-9 && Math.abs(out[74].value - (100 + 374 / 1000)) < 1e-9)
  check('aligned: earlier days are not drawn', out.every((p) => p.time >= D1))
  // The last candle of a day must not take the next day's first VWAP.
  const twoDays = [bar(D1 + 370 * 60, 1, 1, 1, 0), bar(D1 + DAY, 1, 1, 1, 0)]
  const pts = [{ time: D1 + DAY, value: 7 }]
  check('a day\'s last candle never takes tomorrow\'s VWAP', alignToBars(pts, twoDays).length === 1 && alignToBars(pts, twoDays)[0].time === D1 + DAY)
  check('zero / non-finite VWAP values are skipped', alignToBars([{ time: D1, value: 0 }, { time: D1 + 10, value: NaN }], [bar(D1, 1, 1, 1, 0)]).length === 0)
  check('chartVwap: own volume first, else the aligned server series', chartVwap([bar(D1, 3, 3, 3, 1)], series)[0].value === 3 && chartVwap(bars, series).length === 75)
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
