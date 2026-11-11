// Absorption and exhaustion by OI on spot (oiAbsorption.js): each fires on its case - bullish and bearish - and not when a
// key part is missing; only completed candles, nothing after the clock; the markers land on the chart's own candles.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ABSORPTION_DEFAULTS, absorptionMarkers, completeCandles, oiAbsorptionEvents } from '../src/oiAbsorption.js'

const T915 = Date.parse('2026-10-05T09:15:00+05:30')
const MIN = 60_000
const IST = 5.5 * 3600
const chart = (m) => (T915 + m * MIN) / 1000 + IST
const STRIKES = [24850, 24900, 24950, 25000, 25050, 25100, 25150]
// A day of `n` minutes: spot bar `bar(m)` (default: a 10-point range around 25000, no body), each strike's OI changing
// `ceStep(m, k)` / `peStep(m, k)` a minute (default +1000 each).
function day({ n = 60, bar = () => null, ceStep = () => 1000, peStep = () => 1000 } = {}) {
  const bars = Array.from({ length: n }, (_, m) => {
    const b = bar(m)
    return { time: chart(m), ...(b ?? { open: 25000, high: 25005, low: 24995, close: 25000 }) }
  })
  const series = (stepOf) => {
    const map = new Map()
    for (const k of STRIKES) {
      let oi = 1e6
      const pts = []
      for (let m = 0; m < n; m++) { oi += m === 0 ? 0 : stepOf(m, k); pts.push({ ms: T915 + m * MIN, time: new Date(T915 + m * MIN).toISOString(), strike: k, openInterest: oi }) }
      map.set(k, pts)
    }
    return map
  }
  return { spotBars: bars, ceByStrike: series(ceStep), peByStrike: series(peStep), step: 50 }
}
const inCandle = (m, from, tf = 5) => m >= from * tf && m < (from + 1) * tf
const kinds = (events) => events.map((e) => [Math.round((e.time - chart(0)) / 300), e.kind, e.side])

test('candles: only completed ones, the forming minute left out live; each knows its last minute', () => {
  const { spotBars } = day({ n: 23 })
  const five = completeCandles(spotBars, 5)
  assert.equal(five.length, 4)   // 09:15 - 09:34; 09:35 has 3 of its 5 minutes
  assert.equal(five[3].lastBar, chart(19))
  assert.equal(completeCandles(spotBars.slice(0, 20), 5, { live: true }).length, 3)   // minute 19 still forming
  assert.equal(completeCandles(spotBars.slice(0, 20), 5).length, 4)
  assert.equal(completeCandles(spotBars, 1, { live: true }).length, 22)
})

test('bullish absorption: heavy put writing near ATM in a candle that goes nowhere; bearish the mirror with calls', () => {
  // Candle 8 (minutes 40 - 44): puts at every strike near ATM +20 000 a minute - the band +5 lakh, 20x the typical.
  const bull = day({ peStep: (m) => (inCandle(m, 8) ? 20000 : 1000) })
  assert.deepEqual(kinds(oiAbsorptionEvents({ ...bull, timeframe: 5 })), [[8, 'absorption', 'bull']])
  const e = oiAbsorptionEvents({ ...bull, timeframe: 5 })[0]
  assert.equal(e.price, 24995)
  assert.ok(e.dPe > 4.9e5 && e.dCe < 3e4, `${e.dPe} ${e.dCe}`)
  assert.match(e.text, /^Bullish absorption - puts written \(CE \+0\.3L, PE \+5\.0L at ATM ±2\) while spot held/)
  // Calls instead: bearish.
  const bear = day({ ceStep: (m) => (inCandle(m, 8) ? 20000 : 1000) })
  assert.deepEqual(kinds(oiAbsorptionEvents({ ...bear, timeframe: 5 })), [[8, 'absorption', 'bear']])
  assert.equal(oiAbsorptionEvents({ ...bear, timeframe: 5 })[0].price, 25005)
  // Not without each part: ordinary OI; price moving (a 30-point body against a 10-point typical range); the calls written
  // as heavily (neither side ahead); before 5 candles have passed (candle 3).
  assert.deepEqual(oiAbsorptionEvents({ ...day(), timeframe: 5 }), [])
  const moving = day({ peStep: (m) => (inCandle(m, 8) ? 20000 : 1000), bar: (m) => (inCandle(m, 8) ? { open: 25000, high: 25032, low: 24998, close: 25030 } : null) })
  assert.deepEqual(oiAbsorptionEvents({ ...moving, timeframe: 5 }).filter((x) => x.kind === 'absorption'), [])
  const both = day({ peStep: (m) => (inCandle(m, 8) ? 20000 : 1000), ceStep: (m) => (inCandle(m, 8) ? 20000 : 1000) })
  assert.deepEqual(oiAbsorptionEvents({ ...both, timeframe: 5 }), [])
  assert.deepEqual(oiAbsorptionEvents({ ...day({ peStep: (m) => (inCandle(m, 3) ? 20000 : 1000) }), timeframe: 5 }), [])
  // OI written far from the money (25150 only, outside ATM ± 2 of 25000) is not near ATM.
  assert.deepEqual(oiAbsorptionEvents({ ...day({ peStep: (m, k) => (inCandle(m, 8) && k === 25150 ? 200000 : 1000) }), timeframe: 5 }), [])
})

test('exhaustion: a new high on OI closing with no puts written (bearish); a new low with no calls written (bullish)', () => {
  // Candle 8 makes a new high (25025) while calls unwind and puts are not written - short covering.
  const top = { bar: (m) => (inCandle(m, 8) ? { open: 25000, high: 25025, low: 24998, close: 25020 } : null), ceStep: (m) => (inCandle(m, 8) ? -5000 : 1000), peStep: (m) => (inCandle(m, 8) ? -1000 : 1000) }
  assert.deepEqual(kinds(oiAbsorptionEvents({ ...day(top), timeframe: 5 })), [[8, 'exhaustion', 'bear']])
  assert.equal(oiAbsorptionEvents({ ...day(top), timeframe: 5 })[0].price, 25025)
  const bottom = { bar: (m) => (inCandle(m, 8) ? { open: 25000, high: 25002, low: 24975, close: 24980 } : null), peStep: (m) => (inCandle(m, 8) ? -5000 : 1000), ceStep: (m) => (inCandle(m, 8) ? -1000 : 1000) }
  assert.deepEqual(kinds(oiAbsorptionEvents({ ...day(bottom), timeframe: 5 })), [[8, 'exhaustion', 'bull']])
  // Not without each part: no new high (the same OI); puts written on the way up (fresh support - a real rally); the OI
  // not falling (the calls adding back what they shed).
  assert.deepEqual(oiAbsorptionEvents({ ...day({ ...top, bar: () => null }), timeframe: 5 }), [])
  assert.deepEqual(oiAbsorptionEvents({ ...day({ ...top, peStep: (m) => (inCandle(m, 8) ? 3000 : 1000) }), timeframe: 5 }).filter((x) => x.kind === 'exhaustion'), [])
  assert.deepEqual(oiAbsorptionEvents({ ...day({ ...top, ceStep: () => 1000 }), timeframe: 5 }), [])
  // A new low with calls written on the way down is a real fall - not exhaustion.
  assert.deepEqual(oiAbsorptionEvents({ ...day({ ...bottom, ceStep: (m) => (inCandle(m, 8) ? 3000 : 1000) }), timeframe: 5 }).filter((x) => x.kind === 'exhaustion'), [])
})

test('the timeframe picked: the same burst read on 1, 3, 5 and 15-minute candles, each on its own candles', () => {
  const d = day({ n: 120, peStep: (m) => (m >= 90 && m < 93 ? 30000 : 1000) })
  for (const tf of [1, 3, 5, 15]) {
    const ev = oiAbsorptionEvents({ ...d, timeframe: tf })
    assert.ok(ev.length >= 1 && ev.every((e) => e.kind === 'absorption' && e.side === 'bull'), `${tf}m: ${JSON.stringify(kinds(ev))}`)
    assert.ok(ev.every((e) => (e.time - chart(0)) % (tf * 60) === 0), `${tf}m candle starts`)
    assert.ok(ev.some((e) => e.lastBar >= chart(90) && e.lastBar <= chart(92 + tf)), `${tf}m at the burst`)
  }
})

test('no look-ahead: a day cut at any minute reads exactly the whole day\'s events up to it; no reading after the clock counts', () => {
  const d = day({ n: 90, peStep: (m) => (inCandle(m, 8) || inCandle(m, 14) ? 20000 : 1000), ceStep: (m) => (inCandle(m, 11) ? 25000 : 1000) })
  const whole = oiAbsorptionEvents({ ...d, timeframe: 5 })
  assert.deepEqual(kinds(whole), [[8, 'absorption', 'bull'], [11, 'absorption', 'bear'], [14, 'absorption', 'bull']])
  for (const cut of [30, 44, 45, 57, 72, 89]) {
    const asOfMs = T915 + cut * MIN
    const part = oiAbsorptionEvents({ ...d, spotBars: d.spotBars.slice(0, cut + 1), timeframe: 5, asOfMs })
    assert.deepEqual(part, whole.filter((e) => e.lastBar <= chart(cut)), `cut at ${cut}`)
  }
  // Live, minute 44 still forming: candle 8 is not complete - nothing yet; then complete.
  assert.deepEqual(oiAbsorptionEvents({ ...d, spotBars: d.spotBars.slice(0, 45), timeframe: 5, live: true, asOfMs: T915 + 44 * MIN + 30_000 }), [])
  assert.equal(oiAbsorptionEvents({ ...d, spotBars: d.spotBars.slice(0, 46), timeframe: 5, live: true, asOfMs: T915 + 45 * MIN + 10_000 }).length, 1)
})

test('the markers sit on the chart\'s own candles: green ▲ under for bullish, red ▼ over for bearish; ABS / EXH', () => {
  const events = [
    { time: chart(40), lastBar: chart(44), kind: 'absorption', side: 'bull' },
    { time: chart(55), lastBar: chart(59), kind: 'exhaustion', side: 'bear' },
  ]
  assert.deepEqual(absorptionMarkers(events, 1).map((m) => [m.time, m.position, m.shape, m.text]), [
    [chart(44), 'belowBar', 'arrowUp', 'ABS'], [chart(59), 'aboveBar', 'arrowDown', 'EXH'],
  ])
  // On a 15-minute chart: the 15-minute candle holding each one's last minute.
  assert.deepEqual(absorptionMarkers(events, 15).map((m) => m.time), [chart(30), chart(45)])
  assert.ok(ABSORPTION_DEFAULTS.band === 2 && ABSORPTION_DEFAULTS.minPrior === 5)
})
