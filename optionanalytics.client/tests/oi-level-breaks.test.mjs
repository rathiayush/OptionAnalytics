import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildOiTotalsRows } from '../src/oiTotalsHeatmap.js'
import { breakMeaning, breakText, completedLevelReads, newBreakWatch, watchBreaks } from '../src/oiLevelBreaks.js'

// One strike's CE cumulative OI, one point per minute: two swing lows at 60 (a support), then a fall through it.
const T0 = Date.UTC(2026, 9, 23, 9, 15) / 1000
const CUM = [120, 110, 100, 80, 60, 80, 100, 120, 100, 80, 60, 80, 100, 120, 100, 80, 40, 20, 0]
const BREAK_AT = 16 // 80 -> 40 crosses 60

function totalsUpTo(n) {
  const ce = new Map()
  for (let i = 0; i < n; i++) ce.set(T0 + i * 60, i === 0 ? CUM[0] : CUM[i] - CUM[i - 1])
  return buildOiTotalsRows(new Map([[100, ce]]), new Map([[100, new Map()]]))
}
// All n buckets complete (the clock is at the end of the last one).
const readsUpTo = (n) => completedLevelReads(totalsUpTo(n), 60, T0 + n * 60)

test('a support break on the CE cumulative is announced once, when it happens', () => {
  const watch = newBreakWatch()
  assert.deepEqual(watchBreaks(watch, readsUpTo(BREAK_AT), 60), [])   // seeds: nothing broken yet
  // PE is flat here, so the net (CE − PE) is the same line and breaks too.
  const all = watchBreaks(watch, readsUpTo(BREAK_AT + 1), 60)
  assert.deepEqual(all.map((b) => b.side.key).sort(), ['ce', 'net'])
  const breaks = all.filter((b) => b.side.key === 'ce')
  assert.equal(breaks[0].up, false)
  assert.equal(breaks[0].time, T0 + BREAK_AT * 60)
  assert.ok(Math.abs(breaks[0].levels[0].value - 60) < 1)
  assert.equal(breakMeaning('ce', false), 1)   // calls unwinding - bullish
  assert.deepEqual(watchBreaks(watch, readsUpTo(BREAK_AT + 2), 60), [])   // not again
})

test('a break already there when the page opens is not announced', () => {
  const watch = newBreakWatch()
  assert.deepEqual(watchBreaks(watch, readsUpTo(CUM.length), 60), [])
  assert.deepEqual(watchBreaks(watch, readsUpTo(CUM.length), 60), [])
})

test('a stale break (older than the fresh buckets) is not announced', () => {
  const watch = newBreakWatch()
  watchBreaks(watch, readsUpTo(BREAK_AT), 60)
  // The page only gets data again 3 minutes after the break.
  assert.deepEqual(watchBreaks(watch, readsUpTo(BREAK_AT + 4), 60), [])
})

test('the running bucket is not read: a break inside it waits until the bucket completes', () => {
  const totals = totalsUpTo(BREAK_AT + 1)
  const watch = newBreakWatch()
  watchBreaks(watch, readsUpTo(BREAK_AT), 60)
  // The clock is 30 s into the break bucket: it is still running.
  const running = completedLevelReads(totals, 60, T0 + BREAK_AT * 60 + 30)
  assert.equal(running.last, T0 + (BREAK_AT - 1) * 60)
  assert.deepEqual(watchBreaks(watch, running, 60), [])
  assert.equal(watchBreaks(watch, completedLevelReads(totals, 60, T0 + (BREAK_AT + 1) * 60), 60).filter((b) => b.side.key === 'ce').length, 1)
})

test('the message names the index, line, level, direction and meaning', () => {
  const watch = newBreakWatch()
  watchBreaks(watch, readsUpTo(BREAK_AT), 60)
  const b = watchBreaks(watch, readsUpTo(BREAK_AT + 1), 60).find((x) => x.side.key === 'ce')
  const text = breakText('NIFTY', b, (v) => String(Math.round(v)), () => '13:39', 1)
  assert.match(text, /^NIFTY OI CE cumulative Δ broke below support 60 \(×2\) at 13:39 \(calls unwinding - bullish\) · now 40$/)
})

// ---- High probability: break + large CE − PE shift + carried at ATM ± 1 ----
import { HIGH_PROBABILITY, TOTALS_SIDES, highProbability, highProbabilityText, newHighProbabilityWatch, watchHighProbability } from '../src/oiLevelBreaks.js'

// Two swing lows at 60, then a hard fall through it in one minute (16): the CE cumulative (and the net, PE flat).
const BIG = [120, 110, 100, 80, 60, 80, 100, 120, 100, 80, 60, 80, 100, 120, 100, 80, -200]
function day(cumAt, { strike = 100, atm = 100, strikes = [50, 100, 150], n = cumAt.length } = {}) {
  const ce = new Map(strikes.map((k) => [k, new Map()]))
  const pe = new Map(strikes.map((k) => [k, new Map()]))
  for (let i = 0; i < n; i++) {
    const t = T0 + i * 60
    for (const k of strikes) { ce.get(k).set(t, k === strike ? (i === 0 ? cumAt[0] : cumAt[i] - cumAt[i - 1]) : 0); pe.get(k).set(t, 0) }
  }
  const totals = buildOiTotalsRows(ce, pe)
  return { ce, pe, totals, atm, reads: completedLevelReads(totals, 60, T0 + n * 60) }
}
function breakOf(cumAt, opts) {
  const before = day(cumAt, { ...opts, n: cumAt.length - 1 })
  const now = day(cumAt, opts)
  const watch = newBreakWatch()
  watchBreaks(watch, before.reads, 60)
  const b = watchBreaks(watch, now.reads, 60).find((x) => x.side.key === 'net')
  return { b, ctx: { totals: now.totals, ce: now.ce, pe: now.pe, last: now.reads.last, atmStrike: now.atm, bucketSeconds: 60 } }
}

test('high probability: the break comes with a large CE − PE shift carried at ATM ± 1, same direction', () => {
  const { b, ctx } = breakOf(BIG)
  assert.ok(b, 'the net line broke its support')
  const hp = highProbability(b, ctx, { windowMinutes: 3 })
  assert.ok(hp)
  assert.equal(hp.bullish, true)                 // net falling: put writers ahead
  assert.equal(hp.shift, -200 - 120)
  assert.ok(hp.ratio >= 2.5)
  assert.deepEqual(hp.nearStrikes, [50, 100, 150])
  assert.equal(hp.nearShare, 1)
  const text = highProbabilityText('NIFTY', b, hp, (v) => String(Math.round(v)), () => '13:39', 1)
  assert.match(text, /^HIGH PROBABILITY BULLISH · NIFTY at 13:39\n/)
  assert.match(text, /CE − PE cumulative Δ shifted -320 in 3 min/)
  assert.match(text, /ATM ± 1 \(50 \/ 100 \/ 150\) carried -320 of it \(100%\)/)
})

test('not high probability when the shift is away from the money', () => {
  const { b, ctx } = breakOf(BIG, { strike: 300, atm: 100, strikes: [50, 100, 150, 200, 250, 300] })
  assert.ok(b)
  assert.equal(highProbability(b, ctx), null)
})

test('not high probability when the shift is not large (an ordinary break)', () => {
  // A slow slide through the support: the 3-minute shift is no bigger than the day's usual swings.
  const ordinary = [120, 110, 100, 80, 60, 80, 100, 120, 100, 80, 60, 80, 100, 120, 110, 100, 90, 80, 70, 55]
  const { b, ctx } = breakOf(ordinary)
  assert.ok(b)
  // At 150% above usual (2.5x) it is clearly not large; the default 20% is a looser bar.
  assert.equal(highProbability(b, ctx, { windowMinutes: 3, shiftAbovePct: 150 }), null)
})

test('the "large shift" bar is a percentage above the usual move, default 20%', () => {
  const { b, ctx } = breakOf(BIG)
  const hp = highProbability(b, ctx, { windowMinutes: 3 })
  assert.ok(hp)
  const abovePct = (hp.ratio - 1) * 100            // how far above usual this shift is
  assert.ok(highProbability(b, ctx, { windowMinutes: 3, shiftAbovePct: abovePct - 1 }), 'just under the bar passes')
  assert.equal(highProbability(b, ctx, { windowMinutes: 3, shiftAbovePct: abovePct + 1 }), null)
  assert.ok(highProbability(b, ctx, { windowMinutes: 3, shiftAbovePct: 0 }), '0% = any shift at least as big as usual')
  assert.equal(HIGH_PROBABILITY.shiftAbovePct, 20)
})

test('not high probability when the break disagrees with the shift', () => {
  const { b, ctx } = breakOf(BIG)
  // A bearish break (PE cumulative falling through support) against a bullish shift.
  const against = { ...b, side: TOTALS_SIDES.find((s) => s.key === 'pe'), up: false }
  assert.equal(highProbability(against, ctx), null)
})

test('not high probability without enough of the day to judge "large"', () => {
  const { b, ctx } = breakOf(BIG)
  assert.equal(highProbability(b, ctx, { minHistory: 40 }), null)
  assert.ok(highProbability(b, ctx), 'the default 5-minute window passes')
})

// The three need not land in the same minute: the line breaks at 16 with an ordinary move, and the big ATM shift comes
// over the next two minutes - within a 5-minute window it is one signal, within a 1-minute window it is not. These pin the
// bar at 150% above usual (2.5x) so the break minute alone is not "large" - they test the window, not the bar.
const LATE = [120, 110, 100, 80, 60, 80, 100, 120, 100, 80, 60, 80, 100, 120, 100, 80, 50, -100, -250]
function run(cumAt, windowMinutes, shiftAbovePct = 150) {
  const breaks = newBreakWatch()
  const hp = newHighProbabilityWatch()
  const out = []
  for (let n = 15; n <= cumAt.length; n++) {
    const d = day(cumAt, { n })
    const ctx = { totals: d.totals, ce: d.ce, pe: d.pe, last: d.reads.last, atmStrike: d.atm, bucketSeconds: 60 }
    out.push(...watchHighProbability(hp, watchBreaks(breaks, d.reads, 60), ctx, { windowMinutes, shiftAbovePct }).map((s) => ({ ...s, n })))
  }
  return out
}

test('high probability within the window: the shift may come a few minutes after the break', () => {
  const signals = run(LATE, 5)
  assert.equal(signals.length, 1, JSON.stringify(signals.map((x) => [x.n, x.key])))
  assert.equal(signals[0].hp.bullish, true)
  assert.ok(signals[0].hp.at > signals[0].b.time, 'signalled after the break minute, when the shift arrived')
})

test('not high probability when the shift comes after the window has passed', () => {
  assert.equal(run(LATE, 1).length, 0)
})

test('one signal per direction per window, however many lines broke', () => {
  const signals = run(BIG, 5)
  assert.equal(signals.length, 1)
})
