// A synthetic trading day (futures bars with footprint rows, prints, option / futures / index OI) for the
// scanner-core tests - deterministic, enough for several setups to fire through the whole pipeline.
import { buildOiContext } from '../src/strategyEngine.js'
const MIN = 60000
const T915 = Date.parse('2026-10-05T03:45:00Z')
const at = (m) => T915 + m * MIN
const iso = (ms) => new Date(ms).toISOString()
let seed = 7
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
// futures path: trend up then down then up
const path = []
let p = 22700
for (let m = 0; m <= 300; m++) { p += (m < 100 ? 1.2 : m < 200 ? -1.5 : 1.0) + (rnd() - 0.5) * 6; path.push(Math.round(p * 10) / 10) }
const minuteBars = path.map((c, m) => {
  const o = m ? path[m - 1] : c
  const hi = Math.max(o, c) + 2, lo = Math.min(o, c) - 2
  const levels = []
  for (let x = Math.floor(lo); x <= Math.ceil(hi); x++) levels.push({ price: x, buy: Math.round(75 * (1 + rnd() * 10)) * (c > o ? 2 : 1), sell: Math.round(75 * (1 + rnd() * 10)) * (c < o ? 2 : 1) })
  const buy = levels.reduce((s, l) => s + l.buy, 0), sell = levels.reduce((s, l) => s + l.sell, 0)
  return { time: iso(at(m)), open: o, high: hi, low: lo, close: c, buy, sell, trades: 30, levels }
})
const spot = path.map((c, m) => ({ time: iso(at(m)), open: c - 60, high: c - 58, low: c - 62, close: c - 60 }))
const fut = path.map((c, m) => ({ time: iso(at(m)), open: c, high: c + 1, low: c - 1, close: c, volume: 5000, openInterest: 1e7 + (m < 100 ? m * 3000 : m < 200 ? 3e5 + (m - 100) * 4000 : 7e5 - (m - 200) * 2000) }))
const cePoints = [], pePoints = []
for (let m = 0; m <= 300; m++) for (let k = 22400; k <= 23000; k += 50) {
  const dist = (k - (path[m] - 60)) / 50
  cePoints.push({ time: iso(at(m)), strike: k, openInterest: Math.round(2e6 + (k % 100 === 0 ? 2e6 : 0) + m * (dist > 0 ? 8000 : 2000)), price: Math.max(1, 80 - dist * 20) })
  pePoints.push({ time: iso(at(m)), strike: k, openInterest: Math.round(2e6 + (k % 100 === 0 ? 2e6 : 0) + m * (dist < 0 ? 8000 : 2000)), price: Math.max(1, 80 + dist * 20) })
}
const run = { success: true, date: '2026-10-05', step: 50, spotCandlesOneMinute: spot, futuresBars: fut, cePoints, pePoints }
const oi = buildOiContext(run, '2026-10-08')
const prints = []
let seq = 0
for (let m = 0; m <= 300; m++) for (let i = 0; i < 20; i++) prints.push({ seq: ++seq, time: at(m) + i * 3000, price: path[m], quantity: 75 * (1 + Math.floor(rnd() * 20)), buy: rnd() < (path[m] > (path[m - 1] ?? 0) ? 0.65 : 0.35) })
export function day() { return { minuteBars, prints, oi, path, T915, at, run } }

