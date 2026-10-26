import test from 'node:test'
import assert from 'node:assert/strict'
import { barProxyDelta, deltaWeight, optionFlowSeries, smoothEma } from '../src/optionFlow.js'

const T0 = Date.parse('2026-10-16T03:45:00Z') // 09:15 IST
const at = (m) => new Date(T0 + m * 60000).toISOString()
const spot = (closes) => closes.map((close, m) => ({ time: at(m), close }))
const bar = (m, strike, { open, high, low, close, volume }) => ({ time: at(m), strike, price: close, open, high, low, volume, openInterest: 1 })

test('the delta weight is the dashboard sigmoid: ATM counts half, in the money more, out of the money less', () => {
  assert.ok(Math.abs(deltaWeight(24000, 24000, true) - 0.5) < 1e-9)
  assert.ok(Math.abs(deltaWeight(24000, 24000, false) - 0.5) < 1e-9)
  // 1 / (1 + e^(8.5 x moneyness)) - the same numbers as CdvUnderlyingState.ComputeDeltaWeight.
  assert.ok(Math.abs(deltaWeight(25000, 24000, true) - 1 / (1 + Math.exp(8.5 * (1000 / 24000)))) < 1e-12)
  assert.ok(deltaWeight(23000, 24000, true) > 0.5 && deltaWeight(25000, 24000, true) < 0.5)
  assert.ok(deltaWeight(25000, 24000, false) > 0.5 && deltaWeight(23000, 24000, false) < 0.5)
})

test('a bar closing at its high is all buying, at its low all selling, a flat bar nothing', () => {
  assert.equal(barProxyDelta({ high: 110, low: 100, close: 110, volume: 1000 }), 1000)
  assert.equal(barProxyDelta({ high: 110, low: 100, close: 100, volume: 1000 }), -1000)
  assert.equal(barProxyDelta({ high: 110, low: 100, close: 105, volume: 1000 }), 0)
  assert.equal(barProxyDelta({ high: 100, low: 100, close: 100, volume: 1000 }), 0)
})

test('CE CDV rises on calls bought, PE CDV falls on puts sold, weighted by moneyness at that minute', () => {
  const ce = [0, 1, 2].map((m) => bar(m, 24000, { open: 100, high: 110, low: 100, close: 110, volume: 1000 }))
  const pe = [0, 1, 2].map((m) => bar(m, 24000, { open: 100, high: 100, low: 90, close: 90, volume: 1000 }))
  const flow = optionFlowSeries(ce, pe, spot([24000, 24000, 24000]))
  assert.deepEqual(flow.ceCdv.map((p) => p.value), [500, 1000, 1500])
  assert.deepEqual(flow.peCdv.map((p) => p.value), [-500, -1000, -1500])
  // A strike out of the money counts for less than one at the money.
  const otm = optionFlowSeries([bar(0, 25000, { open: 100, high: 110, low: 100, close: 110, volume: 1000 })], [], spot([24000]))
  assert.ok(otm.ceCdv[0].value < 500)
})

test('OBV sums each strike by close-to-close direction, carries a quiet strike, starts the day at zero', () => {
  const b = (m, strike, close) => bar(m, strike, { open: close, high: close, low: close, close, volume: 100 })
  const ce = [b(0, 24000, 100), b(1, 24000, 110), b(0, 24050, 80), b(2, 24000, 105), b(2, 24050, 90)]
  const flow = optionFlowSeries(ce, [], spot([24000, 24000, 24000]))
  const w0 = deltaWeight(24000, 24000, true), w1 = deltaWeight(24050, 24000, true)
  // Raw: m0 0, m1 +100*w0 (24050 carried at 0), m2 +100*w0 - 100*w0 + 100*w1. Before 9 minutes the EMA is the raw value.
  const expected = [0, 100 * w0, 100 * w1]
  flow.ceObv.forEach((p, i) => assert.ok(Math.abs(p.value - expected[i]) < 1e-9, `minute ${i}: ${p.value} vs ${expected[i]}`))
})

test('nothing after the replay clock is used: the day as of a minute equals the day cut there', () => {
  const ce = [], pe = []
  for (let m = 0; m < 40; m++) {
    for (const strike of [23950, 24000, 24050]) {
      const c = 100 + Math.sin(m / 3 + strike) * 10
      ce.push(bar(m, strike, { open: c - 1, high: c + 2, low: c - 3, close: c, volume: 100 + m }))
      pe.push(bar(m, strike, { open: c + 1, high: c + 3, low: c - 2, close: c - 1, volume: 90 + m }))
    }
  }
  const spots = spot(Array.from({ length: 40 }, (_, m) => 24000 + m))
  const full = optionFlowSeries(ce, pe, spots)
  for (const cut of [5, 12, 25]) {
    const upTo = (p) => Date.parse(p.time) <= T0 + cut * 60000
    const part = optionFlowSeries(ce.filter(upTo), pe.filter(upTo), spots.filter(upTo))
    const asOf = optionFlowSeries(ce, pe, spots, T0 + cut * 60000)
    for (const key of ['ceCdv', 'peCdv', 'ceObv', 'peObv']) assert.deepEqual(asOf[key], part[key], `${key} as of ${cut}`)
    // CDV weighs each minute at its own spot: the whole day's series up to the cut is the same.
    for (const key of ['ceCdv', 'peCdv']) assert.deepEqual(part[key], full[key].slice(0, part[key].length), `${key} cut at ${cut}`)
  }
})

test('the EMA is seeded like the server (raw before 9 values, then SMA, then EMA)', () => {
  const values = Array.from({ length: 12 }, (_, i) => i + 1)
  const out = smoothEma(values, 9)
  assert.deepEqual(out.slice(0, 8), values.slice(0, 8))
  assert.equal(out[8], 5)
  assert.ok(Math.abs(out[9] - (10 * 0.2 + 5 * 0.8)) < 1e-12)
})

test('live: the run\'s bars and the live minutes together - a later point of the same strike and minute replaces it, keeping the larger volume', () => {
  const b = (m, close, volume) => bar(m, 24000, { open: 100, high: 110, low: 100, close, volume })
  // The run has minutes 0-1 (minute 1 only partly seen), the live feed minute 1 again (newer price, its own part) and 2.
  const run = [b(0, 110, 1000), b(1, 105, 600)]
  const live = [b(1, 110, 400), b(2, 110, 1000)]
  const flow = optionFlowSeries([...run, ...live], [], spot([24000, 24000, 24000]))
  // Minute 1: the live point's close (110, all buying) with the run's larger 600 - not both bars counted.
  assert.deepEqual(flow.ceCdv.map((p) => p.value), [500, 800, 1300])
})

test('smoothLine: EMA(9) as the Pine plots CDV - a prefix smooths the same as the whole, so a replay cut sees nothing early', async () => {
  const { smoothLine, smoothEma } = await import('../src/optionFlow.js')
  const series = Array.from({ length: 30 }, (_, i) => ({ time: 1_000 + i * 60, value: (i % 2 ? 5 : -5) + i }))
  const whole = smoothLine(series)
  assert.deepEqual(smoothLine(series.slice(0, 17)), whole.slice(0, 17))
  assert.deepEqual(whole.map((p) => p.value), smoothEma(series.map((p) => p.value), 9))
  assert.deepEqual(whole.map((p) => p.time), series.map((p) => p.time))
  // The zig-zag of +-5 around the trend is mostly gone once the EMA has seeded: much smaller minute-to-minute steps.
  const meanStep = (vals) => {
    const tail = vals.slice(10)
    return tail.slice(1).reduce((sum, v, i) => sum + Math.abs(v - tail[i]), 0) / (tail.length - 1)
  }
  assert.ok(meanStep(whole.map((p) => p.value)) < meanStep(series.map((p) => p.value)) / 3)
})

test('bucketLine: one point per step, its last value, stamped at the step start (09:15 lines up)', async () => {
  const { bucketLine } = await import('../src/optionFlow.js')
  const open = Date.UTC(2026, 9, 21, 3, 45) // 09:15 IST
  const series = Array.from({ length: 7 }, (_, i) => ({ time: open + i * 60_000, value: i * 10 }))
  assert.deepEqual(bucketLine(series, 3), [
    { time: open, value: 20 }, { time: open + 3 * 60_000, value: 50 }, { time: open + 6 * 60_000, value: 60 },
  ])
  assert.equal(bucketLine(series, 1), series)
  // Cut at a replay clock first: the step in progress holds only the minutes up to it.
  assert.deepEqual(bucketLine(series.slice(0, 5), 3).at(-1), { time: open + 3 * 60_000, value: 40 })
})

// The dashboard's own numbers (CdvUnderlyingState, OptionAnalytics.Server.Tests/CdvParityTests.cs) for one fixed day - 12
// minutes, three strikes a side - and the page's (optionFlow.js) for the same bars: the same CDV and OBV.
test('the same day gives the dashboard\'s CDV and OBV - the server\'s numbers, to the decimal', () => {
  const OPEN = Date.parse('2026-10-21T09:15:00+05:30')
  const N = 12, STRIKES = [24950, 25000, 25050]
  const fixtureBar = (m, k, isCall) => {
    const kk = k + (isCall ? 0 : 5)
    const open = 100 + (m * 7 + kk * 3) % 11
    const close = open + (m + kk) % 5 - 2
    const high = Math.max(open, close) + 1 + m % 3
    const low = Math.min(open, close) - 1 - kk % 2
    return { time: new Date(OPEN + m * 60000).toISOString(), strike: STRIKES[k], price: close, open, high, low, volume: 1000 + 37 * m + 101 * kk }
  }
  const side = (isCall) => STRIKES.flatMap((_, k) => Array.from({ length: N }, (_, m) => fixtureBar(m, k, isCall)))
  const spots = Array.from({ length: N }, (_, m) => ({ time: new Date(OPEN + m * 60000).toISOString(), close: 25000 + 7 * m }))
  const flow = optionFlowSeries(side(true), side(false), spots, OPEN + (N - 1) * 60000)
  const server = {
    ceCdv: [-252.1249, -513.8863, -785.3058, -559.6423, -988.7175, -1950.8907, -1698.6543, -1628.8060, -2159.8439, -2221.5383, -3052.6319, -3798.2198],
    peCdv: [-129.9693, -380.5086, -576.2997, 67.8517, -370.1882, -1450.8951, -967.9904, -640.2681, -1069.0456, -1007.7816, -1802.0634, -2610.5553],
    ceObv: [0.0000, 483.7485, -19.0549, -725.0121, -1356.8044, -1916.7724, -2678.0134, -3366.0298, -1506.7890, -2165.3687, -2525.2418, -3271.2723],
    peObv: [0.0000, -2433.1978, -1718.0746, -2451.1429, -3431.2414, -4315.9133, -5102.8170, -6138.6317, -3629.8998, -4487.6836, -5392.2167, -5893.8227],
  }
  for (const key of Object.keys(server)) {
    assert.equal(flow[key].length, N, key)
    flow[key].forEach((p, i) => assert.ok(Math.abs(p.value - server[key][i]) < 1e-3, `${key} minute ${i}: page ${p.value} vs dashboard ${server[key][i]}`))
  }
})

test('OBV weighs every bar at the spot of the replay clock, as the dashboard weighs by its latest spot - never a later one', () => {
  const b = (m, strike, close) => bar(m, strike, { open: close, high: close, low: close, close, volume: 100 })
  const ce = [b(0, 24000, 100), b(1, 24000, 110), b(2, 24000, 120), b(3, 24000, 130)]
  const spots = spot([24000, 24000, 24500, 25000])
  // As of minute 1 the spot known is 24000: the 0 -> 1 rise counts at the ATM weight.
  const at1 = optionFlowSeries(ce, [], spots, T0 + 60000)
  assert.equal(at1.ceObv.length, 2, 'nothing after the clock')
  assert.ok(Math.abs(at1.ceObv[1].value - 100 * deltaWeight(24000, 24000, true)) < 1e-9)
  // As of minute 3 the spot is 25000: every earlier rise is weighted at it too (the line re-weighted, as the dashboard's).
  const at3 = optionFlowSeries(ce, [], spots, T0 + 3 * 60000)
  assert.ok(Math.abs(at3.ceObv[1].value - 100 * deltaWeight(24000, 25000, true)) < 1e-9)
  // CDV is weighed minute by minute (each minute's own spot) - what came before the clock does not change.
  assert.deepEqual(at3.ceCdv.slice(0, 2), at1.ceCdv)
})
