// No strategy carries a confidence or waits for a cool-off (the trader's call, 08 Oct): every setup fires
// the moment its rules pass, at the price then, and a LONG and a SHORT at the same time are both traded.
// Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as engine from '../src/strategyEngine.js'
import * as core from '../src/scannerCore.js'
import { day } from './synthetic-day.mjs'

test('the cool-off and confidence helpers are gone', () => {
  for (const name of ['coolOffGate', 'paceOf', 'COOL_OFF_IDS', 'COOL_OFF_MAX_MS', 'confluenceParts', 'gradeOf', 'confidenceText', 'CONFLICT_GAP']) {
    assert.equal(engine[name], undefined, name)
  }
})

test('a setup on a fast run fires at once, at the price then, with no confidence on it', () => {
  const { minuteBars, prints, oi, path, T915, at } = day()
  const MIN = 60_000
  const viewAt = (t) => ({
    meta: { lastPrice: path[Math.floor((t - T915) / MIN)] }, minuteBars: minuteBars.filter((b) => Date.parse(b.time) <= t),
    book: { bids: [{ price: 1, quantity: 500 }], asks: [{ price: 2, quantity: 500 }] }, sweeps: [], icebergs: [], heatmap: [],
  })
  const memory = { fired: [] }
  let fired = 0
  for (let t = at(15); t <= at(300); t += 30_000) {
    const tick = core.scanTick({ nowMs: t, view: viewAt(t), tapePrints: prints.filter((x) => x.time <= t), liquidity: [], pullStack: [], oi, estimated: false, lotSize: 75, largeLots: 10, rowSize: 1, filters: {}, trail: null }, memory)
    if (!tick) continue
    assert.equal(tick.held, undefined)
    for (const s of tick.fresh) {
      fired++
      assert.equal(s.t, t, 'fires the moment it is found')
      assert.ok(!('confidence' in s) && !('grade' in s) && !('coolOff' in s) && !('signal' in s))
      assert.ok(!('Confidence' in s.checks) && !('Pace' in s.checks) && !('Market read' in s.checks))
    }
    if (tick.fresh.length) memory.fired = tick.fired
  }
  assert.ok(fired >= 3, `only ${fired} setups fired`)
})

test('a LONG and a SHORT at the same moment: both traded', () => {
  const out = engine.resolveConflicts([{ id: 'wallBreak', side: 'LONG', checks: {} }, { id: 'trap', side: 'SHORT', checks: {} }])
  assert.equal(out.length, 2)
  assert.ok(out.every((s) => /both sides are traded/.test(s.checks.Conflict)))
})
