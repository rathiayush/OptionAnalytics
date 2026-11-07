// The technical indicators (taIndicators.js) as TradingView works them out, held to values worked out by hand on series
// whose answers are exact (a straight line, a steady trend, a flat market, a zig-zag), and to no look-ahead: every value
// at candle k is the same when the series stops at k.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { atr, bollinger, cci, dmi, macd, rma, sma, stochastic, supertrend } from '../src/taIndicators.js'

const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps
const at = (series, k) => series[k]
const range = (n, f) => Array.from({ length: n }, (_, k) => f(k))

test('SMA and Wilder\'s average: the window, the start, a gap starts the window again', () => {
  const x = range(10, (k) => k + 1)
  const s = sma(x, 3)
  assert.ok(Number.isNaN(s[1]))
  assert.deepEqual([...s.slice(2)], [2, 3, 4, 5, 6, 7, 8, 9])
  const gap = sma([1, 2, NaN, 4, 5, 6], 2)
  assert.deepEqual([...gap].map((v) => (Number.isNaN(v) ? null : v)), [null, 1.5, null, null, 4.5, 5.5])
  // rma: the simple average of the first 3, then (prev x 2 + value) / 3.
  const r = rma([NaN, 3, 6, 9, 12], 3)
  assert.ok(Number.isNaN(r[2]))
  assert.equal(r[3], 6)
  assert.equal(r[4], (6 * 2 + 12) / 3)
})

test('MACD of a straight line: EMA 12 lags 5.5, EMA 26 lags 12.5 - the line is 7 from the 26th candle, the signal 7, no histogram', () => {
  const x = range(80, (k) => 100 + k)
  const m = macd(x)
  assert.ok(Number.isNaN(m.macd[24]))
  for (let k = 25; k < 80; k++) assert.ok(close(m.macd[k], 7), `${k}: ${m.macd[k]}`)
  assert.ok(Number.isNaN(m.signal[32]))                     // the signal needs 9 MACD values: from candle 33
  for (let k = 33; k < 80; k++) { assert.ok(close(m.signal[k], 7)); assert.ok(close(m.hist[k], 0)) }
  // A turn down: the line falls under its signal - the histogram goes negative.
  const turn = macd([...x, ...range(20, (k) => 179 - 2 * k)])
  assert.ok(turn.hist.at(-1) < 0 && turn.macd.at(-1) < turn.signal.at(-1))
})

test('Stochastic: at the top of the range 100, the bottom 0, a flat window none; %D the average of %K', () => {
  const high = range(30, (k) => 102 + k), low = range(30, (k) => 98 + k)
  const top = stochastic(high, low, high)                  // every close at the high: the top of its window
  for (let k = 15; k < 30; k++) assert.ok(close(top.k[k], 100))
  assert.ok(Number.isNaN(top.k[14]))                       // raw from candle 13, %K (3) from 15
  assert.ok(Number.isNaN(top.d[16]) && close(top.d[17], 100))
  // Every close at the window's lowest low (the low 13 candles back): 0.
  const bottom = stochastic(high, low, range(30, (k) => 98 + k - 13))
  for (let k = 15; k < 30; k++) assert.ok(close(bottom.k[k], 0), `${k}: ${bottom.k[k]}`)
  const flat = stochastic(range(30, () => 100), range(30, () => 100), range(30, () => 100))
  assert.ok([...flat.k].every(Number.isNaN))
})

test('CCI of a straight line: (tp - its 20 average) / (0.015 x mean deviation 5) = 9.5 / 0.075', () => {
  const x = range(40, (k) => 1000 + k)
  const c = cci(x, x, x)
  assert.ok(Number.isNaN(c[18]))
  for (let k = 19; k < 40; k++) assert.ok(close(c[k], 9.5 / 0.075, 1e-6), `${k}: ${c[k]}`)
  assert.ok([...cci(range(30, () => 5), range(30, () => 5), range(30, () => 5))].slice(19).every((v) => v === 0))
})

test('Bollinger of a zig-zag around 100: mid 100, the population deviation 1 - bands 98 / 102, %B 0.75 at the top, width 4%', () => {
  const x = range(40, (k) => (k % 2 ? 101 : 99))
  const b = bollinger(x)
  for (let k = 19; k < 40; k++) {
    assert.ok(close(b.mid[k], 100) && close(b.upper[k], 102) && close(b.lower[k], 98))
    assert.ok(close(b.pctB[k], x[k] === 101 ? 0.75 : 0.25))
    assert.ok(close(b.width[k], 4))
  }
  assert.ok(Number.isNaN(b.pctB[18]))
})

test('ATR: a steady range of 2 with no gaps is 2; a gap counts (the true range), Wilder-averaged', () => {
  const high = range(30, (k) => 102 + k), low = range(30, (k) => 100 + k), c = range(30, (k) => 101 + k)
  const a = atr(high, low, c)
  assert.ok(Number.isNaN(a[12]))
  for (let k = 13; k < 30; k++) assert.ok(close(a[k], 2))
  // A gap up of 10 at the last candle: its true range is 12 (high - the close before) - ATR (2 x 13 + 12) / 14.
  const gh = [...high.slice(0, 29), 102 + 28 + 10], gl = [...low.slice(0, 29), 100 + 28 + 10], gc = [...c.slice(0, 29), 101 + 28 + 10]
  assert.ok(close(atr(gh, gl, gc).at(-1), (2 * 13 + (gh[29] - gc[28])) / 14))
})

test('DMI of a steady uptrend: +DI 50, -DI 0, ADX 100; a downtrend the other way', () => {
  const n = 60
  const up = dmi(range(n, (k) => k + 2), range(n, (k) => k), range(n, (k) => k + 1))
  for (let k = 14; k < n; k++) { assert.ok(close(up.plus[k], 50)); assert.ok(close(up.minus[k], 0)) }
  assert.ok(Number.isNaN(up.adx[26]) && close(up.adx[27], 100) && close(up.adx.at(-1), 100))
  const down = dmi(range(n, (k) => 200 - k), range(n, (k) => 198 - k), range(n, (k) => 199 - k))
  assert.ok(close(down.minus.at(-1), 50) && close(down.plus.at(-1), 0) && close(down.adx.at(-1), 100))
})

test('SuperTrend: starts down at the first ATR, turns up when a steady rise closes over the upper band, the line under price', () => {
  const n = 60
  const high = range(n, (k) => 101 + k * 2), low = range(n, (k) => 99 + k * 2), c = range(n, (k) => 100 + k * 2)
  const s = supertrend(high, low, c)
  assert.ok(Number.isNaN(s.dir[8]))
  // The first ATR candle: down, the line the upper band - hl2 118 + 3 x ATR, the true range 3 a candle (the high 3 over
  // the close before) after the first's 2: (2 + 9 x 3) / 10.
  assert.equal(s.dir[9], -1)
  assert.ok(close(s.line[9], 118 + 3 * ((2 + 9 * 3) / 10)))
  assert.ok(s.dir.indexOf(1) > 9)
  assert.equal(s.dir.at(-1), 1)
  assert.ok(s.line.at(-1) < c.at(-1))
  // The lower band only rises while up: never lower than the candle before.
  for (let k = 20; k < n; k++) if (s.dir[k] === 1 && s.dir[k - 1] === 1) assert.ok(s.line[k] >= s.line[k - 1])
  // A fall through it turns it down.
  const fall = supertrend([...high, ...range(10, (k) => 215 - k * 8)], [...low, ...range(10, (k) => 213 - k * 8)], [...c, ...range(10, (k) => 214 - k * 8)])
  assert.equal(fall.dir.at(-1), -1)
  assert.ok(fall.line.at(-1) > 214 - 9 * 8)                 // the line over price
})

test('NO LOOK-AHEAD: every indicator at candle k is the same when the series stops at k', () => {
  let seed = 7
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  const c = [], h = [], l = []
  let p = 1000
  for (let k = 0; k < 120; k++) { p += (rnd() - 0.5) * 6; const hi = p + rnd() * 3, lo = p - rnd() * 3; c.push(p); h.push(hi); l.push(lo) }
  const all = (H, L, C) => {
    const m = macd(C), st = stochastic(H, L, C), b = bollinger(C), d = dmi(H, L, C), s = supertrend(H, L, C)
    return [m.macd, m.signal, m.hist, st.k, st.d, cci(H, L, C), b.pctB, b.width, atr(H, L, C), d.plus, d.minus, d.adx, s.line, s.dir]
  }
  const full = all(h, l, c)
  for (const cut of [10, 30, 47, 80, 119]) {
    const part = all(h.slice(0, cut + 1), l.slice(0, cut + 1), c.slice(0, cut + 1))
    part.forEach((series, which) => {
      for (let k = 0; k <= cut; k++) {
        const a = series[k], b = at(full[which], k)
        assert.ok((Number.isNaN(a) && Number.isNaN(b)) || close(a, b), `indicator ${which} at ${k} cut ${cut}: ${a} vs ${b}`)
      }
    })
  }
  // Each one has values on a 120-candle series.
  for (const series of full) assert.ok([...series].some(Number.isFinite))
})

test('the same values as an independent Pine-style reference (tests/ta-reference.mjs) on random markets, flat stretches and gaps included', async () => {
  const ref = await import('./ta-reference.mjs')
  let seed = 11
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  for (let run = 0; run < 25; run++) {
    const n = 40 + Math.floor(rnd() * 200)
    const c = [], h = [], l = []
    let p = 20000 + rnd() * 5000
    for (let k = 0; k < n; k++) {
      const flat = rnd() < 0.08
      if (!flat) p += (rnd() - 0.5) * 40 + (rnd() < 0.03 ? (rnd() - 0.5) * 300 : 0)      // now and then a gap
      const hi = flat ? p : p + rnd() * 15, lo = flat ? p : p - rnd() * 15
      c.push(p); h.push(hi); l.push(lo)
    }
    const same = (a, b, what) => {
      for (let k = 0; k < n; k++) {
        const x = a[k], y = b[k]
        assert.ok((!Number.isFinite(x) && !Number.isFinite(y)) || Math.abs(x - y) <= 1e-7 * Math.max(1, Math.abs(y)), `run ${run} ${what} at ${k}/${n}: ${x} vs ${y}`)
      }
    }
    const m = macd(c), rm = ref.macd(c)
    same(m.macd, rm.macd, 'macd'); same(m.signal, rm.signal, 'signal'); same(m.hist, rm.hist, 'hist')
    const st = stochastic(h, l, c), rs = ref.stochastic(h, l, c)
    same(st.k, rs.k, '%K'); same(st.d, rs.d, '%D')
    same(cci(h, l, c), ref.cci(h, l, c), 'cci')
    const b = bollinger(c), rb = ref.bollinger(c)
    same(b.pctB, rb.pctB, '%B'); same(b.width, rb.width, 'width')
    same(atr(h, l, c), ref.atr(h, l, c), 'atr')
    const d = dmi(h, l, c), rd = ref.dmi(h, l, c)
    same(d.plus, rd.plus, '+DI'); same(d.minus, rd.minus, '-DI'); same(d.adx, rd.adx, 'adx')
    const s = supertrend(h, l, c), rsu = ref.supertrend(h, l, c)
    same(s.dir, rsu.dir, 'supertrend dir'); same(s.line, rsu.line, 'supertrend line')
  }
})
