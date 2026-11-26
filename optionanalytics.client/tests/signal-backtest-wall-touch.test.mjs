// The 2nd / 3rd touch of a liquidity heatmap wall, the option CDV / OBV lines, and the template built from them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RULE_CONDITIONS, cleanLine, mirrorLines } from '../src/signalBacktest.js'
import { RULE_TEMPLATES, templateById } from '../src/signalTemplates.js'

const MIN = 60_000
const T0 = Date.parse('2026-10-05T09:15:00+05:30')
const cond = (id) => RULE_CONDITIONS.find((c) => c.id === id)

// A bid wall at 25000 all day. Candle lows / closes: touches at candles 3 (1st), 8 (2nd), 9 (same touch), 14 (3rd), 20 (4th).
function wallDay(touchAt = [3, 8, 9, 14, 20]) {
  const n = 30
  const fc = Array(n).fill(25040), fl = Array(n).fill(25030), fh = Array(n).fill(25050)
  for (const k of touchAt) { fl[k] = 25000; fc[k] = 25010 }
  return { ok: true, flow: { fc, fl, fh, liq: Array.from({ length: n }, () => ({ sup: { price: 25000, lots: 500, trend: 'steady' }, res: null })) } }
}
const touch = (d, v, i, w, p2 = 0) => cond('liqWalls').test(d, i, v, w, 0.05, p2)

test('the 2nd and 3rd touch of the same bid wall fire; the 1st and the 4th do not', () => {
  const d = wallDay()
  assert.equal(touch(d, 'touchBid', 3, 1), false)    // 1st
  assert.equal(touch(d, 'touchBid', 8, 1), true)     // 2nd
  assert.equal(touch(d, 'touchBid', 9, 1), false)    // the same touch, a candle later
  assert.equal(touch(d, 'touchBid', 14, 1), true)    // 3rd
  assert.equal(touch(d, 'touchBid', 20, 1), false)   // 4th
  assert.equal(touch(d, 'touchBid', 10, 3), true)    // the 2nd one within the look-back
})

test('the touch choice: only the 2nd, only the 3rd', () => {
  const d = wallDay()
  assert.equal(touch(d, 'touchBid', 8, 1, 2), true)
  assert.equal(touch(d, 'touchBid', 14, 1, 2), false)
  assert.equal(touch(d, 'touchBid', 14, 1, 3), true)
  assert.equal(touch(d, 'touchBid', 8, 1, 3), false)
})

test('a candle that reaches the wall but closes under it is a break, not a touch; the offer wall mirrors it', () => {
  const d = wallDay([3, 8])
  d.flow.fc[8] = 24990
  assert.equal(touch(d, 'touchBid', 8, 1), false)
  const up = { ok: true, flow: { fc: Array(20).fill(24960), fl: Array(20).fill(24950), fh: Array(20).fill(24970), liq: Array.from({ length: 20 }, () => ({ res: { price: 25000, lots: 400, trend: 'steady' }, sup: null })) } }
  for (const k of [2, 6, 10]) { up.flow.fh[k] = 25000; up.flow.fc[k] = 24990 }
  assert.equal(touch(up, 'touchAsk', 6, 1), true)
  assert.equal(touch(up, 'touchAsk', 10, 1), true)
  assert.equal(touch(up, 'touchAsk', 2, 1), false)
  assert.equal(cond('liqWalls').options.find((o) => o.value === 'touchBid').opposite, 'touchAsk')
})

// Option minutes: net CDV / OBV rising for 40 minutes, then falling.
function flowDay(dir) {
  const n = 80
  const t = Array.from({ length: n }, (_, i) => T0 + i * MIN)
  const odm = t.map((ms, i) => { const s = i < 40 ? dir : -dir; return { t: ms, ce: 100 * s, pe: 0, ceObv: 80 * s, peObv: 0 } })
  return { ok: true, t, tf: 1, odm }
}
test('option CDV / OBV lines: both rising while the totals climb, both falling once they turn', () => {
  const d = flowDay(1), c = cond('optFlow')
  assert.equal(c.test(d, 30, 'bothRising', 10, 10, 0), true)
  assert.equal(c.test(d, 30, 'bothFalling', 10, 10, 0), false)
  assert.equal(c.test(d, 70, 'bothFalling', 10, 10, 0), true)
  assert.equal(c.test(d, 70, 'cdvRising', 10, 10, 0), false)
  assert.equal(c.test(d, 30, 'bothRising', 10, 10, 2), false)   // PE side: no PE flow at all
  assert.equal(c.test({ ok: true, t: [T0], tf: 1 }, 0, 'bothRising', 5, 10, 0), false)   // no option minutes
})

test('a cut at any candle reads the same as the whole day (nothing after it is read)', () => {
  const full = flowDay(1)
  const cut = { ...full, t: full.t.slice(0, 31), odm: full.odm.slice(0, 31) }
  assert.equal(cond('optFlow').test(cut, 30, 'bothRising', 10, 10, 0), cond('optFlow').test(full, 30, 'bothRising', 10, 10, 0))
  const w = wallDay(), wc = { ok: true, flow: { ...w.flow, fc: w.flow.fc.slice(0, 15), fl: w.flow.fl.slice(0, 15), fh: w.flow.fh.slice(0, 15), liq: w.flow.liq.slice(0, 15) } }
  assert.equal(touch(wc, 'touchBid', 14, 1), touch(w, 'touchBid', 14, 1))
})

test('the template: both lines, mirrored, every part a real condition', () => {
  const t = templateById('wallTouchCdvObv')
  assert.ok(t && RULE_TEMPLATES.includes(t) && t.family === 'book')
  const lines = []
  const walk = (g) => g.items.forEach((x) => (x.line ? lines.push(cleanLine(x.line)) : walk(x.group)))
  walk(t.rule.tree)
  assert.deepEqual(lines.map((l) => `${l.id}:${l.value}`), ['optFlow:bothRising', 'liqWalls:touchBid'])
  assert.deepEqual(mirrorLines(lines).map((l) => `${l.id}:${l.value}`), ['optFlow:bothFalling', 'liqWalls:touchAsk'])
})
