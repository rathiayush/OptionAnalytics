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

// ---- High probability: a break + the ATM ± 1 CE or PE OI shifting the set % the same way, within the window ----
import { TOTALS_SIDES, highProbability, highProbabilityText, newHighProbabilityWatch, watchHighProbability, perStrikeLevels, changesFromLevels } from '../src/oiLevelBreaks.js'

// The ATM strike's CE OI = BASE + 1000 x the pattern: two swing lows, then a hard fall through them at minute 16 -
// from 1.08 M to 0.8 M over the last few minutes (about -26%: calls unwinding, bullish). PE flat.
const BASE = 1_000_000
const BIG = [120, 110, 100, 80, 60, 80, 100, 120, 100, 80, 60, 80, 100, 120, 100, 80, -200]
function day(cumAt, { strike = 100, atm = 100, strikes = [50, 100, 150], n = cumAt.length, base = BASE, peAt = null } = {}) {
  const ceSeries = new Map(strikes.map((k) => [k, []]))
  const peSeries = new Map(strikes.map((k) => [k, []]))
  for (let i = 0; i < n; i++) {
    const t = (T0 - 19_800 + i * 60) * 1000   // chart seconds T0 + i min
    for (const k of strikes) {
      ceSeries.get(k).push({ t, oi: base + (k === strike ? 1000 * cumAt[i] : 0) })
      peSeries.get(k).push({ t, oi: base + (peAt && k === strike ? 1000 * peAt[i] : 0) })
    }
  }
  const ceLevels = perStrikeLevels(ceSeries, 60)
  const peLevels = perStrikeLevels(peSeries, 60)
  const ce = changesFromLevels(ceLevels)
  const pe = changesFromLevels(peLevels)
  const totals = buildOiTotalsRows(ce, pe)
  return { ce, pe, ceLevels, peLevels, totals, atm, reads: completedLevelReads(totals, 60, T0 + n * 60) }
}
const ctxOf = (d) => ({ totals: d.totals, ceLevels: d.ceLevels, peLevels: d.peLevels, last: d.reads.last, atmStrike: d.atm, bucketSeconds: 60 })
function breakOf(cumAt, opts) {
  const before = day(cumAt, { ...opts, n: cumAt.length - 1 })
  const now = day(cumAt, opts)
  const watch = newBreakWatch()
  watchBreaks(watch, before.reads, 60)
  const b = watchBreaks(watch, now.reads, 60).find((x) => x.side.key === 'ce')
  return { b, ctx: ctxOf(now) }
}

test('high probability: the break comes with the ATM ± 1 CE OI falling 20%+ - calls unwinding, bullish, the same way', () => {
  const { b, ctx } = breakOf(BIG, { base: 300_000 })
  assert.ok(b, 'the CE line broke its support')
  const hp = highProbability(b, ctx)
  assert.ok(hp)
  assert.equal(hp.bullish, true)
  assert.equal(hp.side, 'CE')
  assert.deepEqual(hp.nearStrikes, [50, 100, 150])
  // 5-min window: from minute 11 (ATM CE 300,000 + 80,000) to minute 16 (300,000 - 200,000), over the 3 strikes.
  assert.equal(hp.from, 980_000)
  assert.equal(hp.to, 700_000)
  assert.ok(Math.abs(hp.pct - -28.57) < 0.01, `pct ${hp.pct}`)
  const text = highProbabilityText('NIFTY', b, hp, (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(Math.round(v / 1000))}K`, () => '13:39', 1)
  assert.match(text, /^HIGH PROBABILITY BULLISH · NIFTY at 13:39\n/)
  assert.match(text, /• ATM ± 1 \(50 \/ 100 \/ 150\) in 5 min: CE OI shifted -28\.6%/)
  assert.match(text, /CE OI 980K → 700K \(-28\.6% - calls unwinding\) · PE OI 900K → 900K \(0\.0%\)/)
})

test('the % is the ATM ± 1 OI shift: under it, no 🎯; at or over it, a 🎯', () => {
  const { b, ctx } = breakOf(BIG)
  assert.equal(highProbability(b, ctx, { atmShiftPct: 20 }), null)    // -9%: not 20%
  assert.ok(highProbability(b, ctx, { atmShiftPct: 9 }))
  // The same fall on a thin ATM (OI 0.3 M a strike): -30% clears the default 20%.
  const thin = breakOf(BIG, { base: 300_000 })
  const hp = highProbability(thin.b, thin.ctx)
  assert.ok(hp && hp.pct <= -20, `pct ${hp?.pct}`)
})

test('not high probability when the shift is away from the money', () => {
  const { b, ctx } = breakOf(BIG, { strike: 300, atm: 100, strikes: [50, 100, 150, 200, 250, 300], base: 300_000 })
  assert.ok(b)
  assert.equal(highProbability(b, ctx), null)
})

test('not high probability when the ATM shift points the other way', () => {
  // The CE line breaks down (bullish) while the ATM PE OI falls 40% (puts unwinding - bearish).
  const pePattern = BIG.map((_, i) => (i < 11 ? 0 : -40 * (i - 10)))
  const { b, ctx } = breakOf(BIG, { base: 600_000, peAt: pePattern })
  assert.ok(b)
  const hp = highProbability(b, ctx, { atmShiftPct: 20 })
  assert.equal(hp?.side ?? null, hp ? 'CE' : null, 'only a side agreeing with the break can make it')
  // A bearish break against the bullish CE fall: nothing.
  const against = { ...b, side: TOTALS_SIDES.find((x) => x.key === 'pe'), up: false }
  assert.equal(highProbability(against, breakOf(BIG, { base: 300_000 }).ctx), null)
})

// The three need not land in the same minute: the line breaks at 16 with a small move, and the ATM OI keeps falling
// over the next two minutes - within a 5-minute window it is one signal, within a 1-minute window it is not.
const LATE = [120, 110, 100, 80, 60, 80, 100, 120, 100, 80, 60, 80, 100, 120, 100, 80, 50, -100, -250]
function run(cumAt, windowMinutes, atmShiftPct = 20, base = 300_000) {
  const breaks = newBreakWatch()
  const hp = newHighProbabilityWatch()
  const out = []
  for (let n = 15; n <= cumAt.length; n++) {
    const d = day(cumAt, { n, base })
    out.push(...watchHighProbability(hp, watchBreaks(breaks, d.reads, 60), ctxOf(d), { windowMinutes, atmShiftPct }).map((s) => ({ ...s, n })))
  }
  return out
}

test('high probability within the window: the ATM shift may come a few minutes after the break', () => {
  // At 30%: the break minute is only -3%, the next -19%, the one after -34% - inside the 5-minute window.
  const signals = run(LATE, 5, 30)
  assert.equal(signals.length, 1, JSON.stringify(signals.map((x) => [x.n, x.key, x.hp.pct])))
  assert.equal(signals[0].hp.bullish, true)
  assert.ok(signals[0].hp.at > signals[0].b.time, 'signalled after the break minute, when the shift arrived')
})

test('not high probability when the shift comes after the window has passed', () => {
  assert.equal(run(LATE, 1, 30).length, 0)
})

test('one signal per direction per window, however many lines broke', () => {
  assert.equal(run(BIG, 5).length, 1)
})
