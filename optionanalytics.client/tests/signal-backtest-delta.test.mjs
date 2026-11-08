// The Signal backtest's OPTION DELTA PROFILE conditions (OI Replay's card - deltaProfile.js): its levels (POC / VAH / VAL /
// HVN / LVN, the most bought / sold rows) and the flow at the price, of the day so far (read at each candle from the
// minutes up to its close - no look-ahead) or of the sessions before the day (put on by the loader - attachDeltaPast).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { day as syntheticDay } from './synthetic-day.mjs'
import { deltaProfileLevels, optionDeltaAt, optionDeltaProfileOf, optionDeltaSteps } from '../src/deltaProfile.js'
import { DELTA_DAYS_MAX, RULE_CONDITIONS, cleanLine, deltaDaysNeeded, lineText, mirrorLines, prepareDay, timeframeView } from '../src/signalBacktest.js'
import { backtestReport, cleanBacktestSettings, dayOutcome, engineSettings, loadBacktestDay } from '../src/signalBacktestJob.js'
import { prepareLiveDay } from '../src/signalLive.js'

const MIN = 60_000
const DAY = 86_400_000
const cond = (id) => RULE_CONDITIONS.find((c) => c.id === id)
const option = (id, value) => cond(id).options.find((o) => o.value === value)
const holds = (d, id, value, i, { w = 5, p, p3, p4 } = {}) => {
  const o = option(id, value)
  return cond(id).test(d, i, value, w, p ?? o.param?.default ?? 0, undefined, p3 ?? o.param3?.default, p4 ?? o.param4?.default)
}
const LEVELS = ['poc', 'vah', 'val', 'hvn', 'lvn', 'buy', 'sell']
const idOf = (key) => `odp${key[0].toUpperCase()}${key.slice(1)}`

// The synthetic day with option bars that have a range and volume (more traded near ATM), and the same day moved to
// another date `days` back and `points` lower - a session before it.
let seed = 7
const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
const { run: base } = syntheticDay()
const withBars = (list) => list.map((p) => ({ ...p, open: p.price * (1 + (rnd() - 0.5) * 0.02), high: p.price * (1 + 0.005 + rnd() * 0.03), low: p.price * (1 - 0.005 - rnd() * 0.03), volume: Math.round(200 + rnd() * 3000) }))
const RUN = { ...base, cePoints: withBars(base.cePoints), pePoints: withBars(base.pePoints) }
const shift = (t, days) => new Date(Date.parse(t) - days * DAY).toISOString()
function runBefore(days, points) {
  const mv = (b) => ({ ...b, time: shift(b.time, days), open: b.open - points, high: b.high - points, low: b.low - points, close: b.close - points })
  const opt = (p) => ({ ...p, time: shift(p.time, days) })
  return {
    ...RUN, spotCandlesOneMinute: RUN.spotCandlesOneMinute.map(mv), futuresBars: (RUN.futuresBars ?? []).map(mv),
    cePoints: RUN.cePoints.map(opt), pePoints: RUN.pePoints.map(opt), spotVwap: (RUN.spotVwap ?? []).map((p) => ({ ...p, time: shift(p.time, days) })),
  }
}

test('minute by minute: the profile at a clock is the one of the minutes up to it - its levels, a row\'s delta, the net', () => {
  const d = prepareDay(RUN, { underlying: 'NIFTY' })
  assert.ok(d.ok && d.odm.length > 200)
  const past = [d.odm.map((m) => ({ ...m, t: m.t - DAY, low: m.low - 80, high: m.high - 80 }))]
  const read = optionDeltaSteps(past, d.odm, { rowSize: 5 })
  for (const k of [0, 40, 150, d.odm.length - 1]) {
    const t = d.odm[k].t
    const profile = optionDeltaProfileOf([...past, d.odm.filter((m) => m.t <= t)], { rowSize: 5 })
    const at = optionDeltaAt(read, t + 30_000)
    assert.deepEqual(at.levels, deltaProfileLevels(profile), `levels at minute ${k}`)
    assert.ok(Math.abs(at.delta - profile.delta) < 1e-6 && Math.abs(at.volume - profile.volume) < 1e-6 && Math.abs(at.maxAbsDelta - profile.maxAbsDelta) < 1e-6)
    for (const r of profile.rows.slice(0, 8)) assert.ok(Math.abs(at.rowDelta(r.price + 2) - r.delta) < 1e-6, `row ${r.price} at minute ${k}`)
  }
  // Before the day's first minute: the sessions before alone.
  assert.deepEqual(optionDeltaAt(read, d.odm[0].t - 1).levels, deltaProfileLevels(optionDeltaProfileOf(past, { rowSize: 5 })))
  assert.equal(optionDeltaAt(read, d.odm[0].t - 1).rowDelta(1), 0)
})

test('the conditions read the profile of the day so far at each candle: price vs its levels, the flow at the price', () => {
  const d = prepareDay(RUN, { underlying: 'NIFTY' })
  const levelsAt = (i) => deltaProfileLevels(optionDeltaProfileOf([d.odm.filter((m) => m.t <= d.t[i])], { rowSize: 5 }))
  let seen = 0
  for (const i of [20, 60, 120, 200, 300]) {
    const L = levelsAt(i)
    const c = d.spot.c[i]
    for (const key of LEVELS) {
      if (L[key] == null) continue
      assert.equal(holds(d, idOf(key), 'above', i), c > L[key], `${key} above at ${i}`)
      assert.equal(holds(d, idOf(key), 'below', i), c < L[key], `${key} below at ${i}`)
      seen++
    }
    const profile = optionDeltaProfileOf([d.odm.filter((m) => m.t <= d.t[i])], { rowSize: 5 })
    const row = profile.rows.find((r) => r.price === Math.floor(c / 5) * 5)
    assert.equal(holds(d, 'odpDelta', 'buying', i), (row?.delta ?? 0) > 0, `buying at ${i}`)
    assert.equal(holds(d, 'odpDelta', 'selling', i), (row?.delta ?? 0) < 0, `selling at ${i}`)
    assert.equal(holds(d, 'odpDelta', 'netPositive', i), profile.delta > 0)
    assert.equal(holds(d, 'odpDelta', 'netNegative', i), profile.delta < 0)
    // "by ≥ %": of the largest row / of the volume.
    if (row && row.delta > 0) {
      const pct = (row.delta / profile.maxAbsDelta) * 100
      assert.ok(holds(d, 'odpDelta', 'buying', i, { p: pct - 0.5 }) && !holds(d, 'odpDelta', 'buying', i, { p: pct + 0.5 }))
    }
  }
  assert.ok(seen > 20)
  // On 5-minute candles: a candle's levels are those at its last minute.
  const v = timeframeView(d, 5)
  for (const k of [5, 30, 60]) {
    const L = levelsAt(v.at[k])
    assert.equal(holds(v, 'odpPoc', 'above', k), v.spot.c[k] > L.poc)
    assert.equal(cond('odpPoc').show(v, k, cleanLine({ id: 'odpPoc', value: 'above' })), `option Δ POC ${L.poc.toFixed(1)}`)
  }
})

test('the days before: fixed all day; with none loaded those lines never hold; the day so far + days before = a composite', () => {
  const d = prepareDay(RUN, { underlying: 'NIFTY' })
  const before = prepareDay(runBefore(1, 120), { underlying: 'NIFTY' }).odm
  const older = prepareDay(runBefore(2, 60), { underlying: 'NIFTY' }).odm
  // Not loaded: nothing reads (a line never holds), the day so far still does.
  for (const v of ['above', 'below', 'near']) assert.equal(holds(d, 'odpPoc', v, 100, { p4: 1 }), false)
  assert.equal(holds(d, 'odpDelta', 'netPositive', 100, { p4: 1 }) || holds(d, 'odpDelta', 'netNegative', 100, { p4: 1 }), false)
  d.odmPast = [older, before]
  const prev = deltaProfileLevels(optionDeltaProfileOf([before], { rowSize: 5 }))
  const two = deltaProfileLevels(optionDeltaProfileOf([older, before], { rowSize: 5 }))
  for (const i of [0, 100, 300]) {
    assert.equal(holds(d, 'odpPoc', 'above', i, { p4: 1 }), d.spot.c[i] > prev.poc)          // the previous day's, all day
    assert.equal(holds(d, 'odpVal', 'below', i, { p3: 2, p4: 1 }), d.spot.c[i] < two.val)    // the 2 days before
  }
  // The day so far + 1 day before, at minute 150.
  const comp = deltaProfileLevels(optionDeltaProfileOf([before, d.odm.filter((m) => m.t <= d.t[150])], { rowSize: 5 }))
  assert.equal(holds(d, 'odpPoc', 'above', 150, { p3: 2, p4: 0 }), d.spot.c[150] > comp.poc)
  assert.equal(cond('odpPoc').show(d, 150, cleanLine({ id: 'odpPoc', value: 'above', param3: 2, param4: 0 })), `option Δ POC ${comp.poc.toFixed(1)}`)
})

test('the lines: numbers held to their range, the mirror, the words, the days a rule needs', () => {
  assert.deepEqual(RULE_CONDITIONS.filter((c) => c.group === 'DeltaProfile').map((c) => c.id), ['odpPoc', 'odpVah', 'odpVal', 'odpHvn', 'odpLvn', 'odpBuy', 'odpSell', 'odpDelta'])
  for (const c of RULE_CONDITIONS.filter((x) => x.group === 'DeltaProfile')) {
    for (const o of c.options) assert.ok(o.param && o.param3 && o.param4?.choices, `${c.id}.${o.value}`)
  }
  const line = cleanLine({ id: 'odpVah', value: 'crossedAbove', param3: 9, param4: 7, windowMin: 15 })
  assert.deepEqual([line.param3, line.param4, line.windowMin], [DELTA_DAYS_MAX, 1, 15])
  assert.deepEqual([cleanLine({ id: 'odpPoc', value: 'above' }).param3, cleanLine({ id: 'odpPoc', value: 'above' }).param4], [1, 0])   // the day so far
  assert.match(lineText(line), /Option Δ profile: VAH: Crossed above it, profile of the 5 days before/)
  assert.match(lineText(cleanLine({ id: 'odpPoc', value: 'above', param3: 3 })), /profile of the day so far \+ 2 days before/)
  assert.match(lineText(cleanLine({ id: 'odpPoc', value: 'above', param4: 1 })), /profile of the previous day/)
  // The mirror: the other side's option; the most bought row <-> the most sold; the numbers kept.
  const [m1, m2, m3] = mirrorLines([cleanLine({ id: 'odpBuy', value: 'heldAbove', param: 0.1, param3: 2, param4: 1 }), cleanLine({ id: 'odpPoc', value: 'crossedAbove' }), cleanLine({ id: 'odpDelta', value: 'buying', param: 20 })])
  assert.deepEqual([m1.id, m1.value, m1.param, m1.param3, m1.param4], ['odpSell', 'heldBelow', 0.1, 2, 1])
  assert.deepEqual([m2.id, m2.value], ['odpPoc', 'crossedBelow'])
  assert.deepEqual([m3.id, m3.value, m3.param], ['odpDelta', 'selling', 20])
  // The sessions before each day the loader puts on: the most any line reads.
  const rule = (...lines) => ({ tree: { op: 'and', items: lines.map((l) => ({ line: l })) }, action: 'buyCE', mirror: true })
  assert.equal(deltaDaysNeeded(rule({ id: 'odpPoc', value: 'above' })), 0)
  assert.equal(deltaDaysNeeded(rule({ id: 'odpPoc', value: 'above', param4: 1 })), 1)
  assert.equal(deltaDaysNeeded(rule({ id: 'odpPoc', value: 'above', param3: 3 })), 2)
  assert.equal(deltaDaysNeeded(rule({ id: 'odpPoc', value: 'above', param3: 3 }, { id: 'odpDelta', value: 'buying', param3: 4, param4: 1 }, { id: 'vwap', value: 'above' })), 4)
  assert.equal(deltaDaysNeeded(rule({ id: 'vwap', value: 'above' })), 0)
})

test('NO LOOK-AHEAD: live, cut at a minute, the delta lines read what the whole day reads up to it', () => {
  const whole = prepareDay(RUN, { underlying: 'NIFTY' })
  const cutAt = whole.t[180] + MIN          // minute 180 completed
  const live = prepareLiveDay(RUN, { underlying: 'NIFTY', nowMs: cutAt })
  assert.equal(live.n, 181)
  for (const i of [30, 100, 180]) {
    for (const key of LEVELS) {
      for (const v of ['above', 'below', 'crossedAbove', 'heldBelow', 'near']) assert.equal(holds(live, idOf(key), v, i), holds(whole, idOf(key), v, i), `${key} ${v} ${i}`)
    }
    for (const v of ['buying', 'selling', 'netPositive', 'netNegative']) assert.equal(holds(live, 'odpDelta', v, i), holds(whole, 'odpDelta', v, i))
  }
})

test('the loader: the sessions before each day walked back (a holiday stepped over), the run\'s own days not asked again', async () => {
  // BANKNIFTY (its own cache keys): the synthetic day as 5 Oct 2026; 2 Oct (Fri) a holiday; 1 Oct, 30 Sep sessions.
  const runs = { '2026-10-05': runBefore(0, 0), '2026-10-01': runBefore(4, 100), '2026-09-30': runBefore(5, 200), '2026-09-29': runBefore(6, 250) }
  const asked = []
  let failDay = null
  const fakeFetch = async (url) => {
    const u = new URL(url, 'http://x')
    const date = u.searchParams.get('date')
    if (u.pathname.endsWith('/run')) asked.push(date)
    const body = u.pathname.endsWith('/run') ? (runs[date] ? { ...runs[date], success: true } : { success: false, error: 'No stored spot data' }) : { success: false }
    const status = date === failDay ? 503 : 200
    return { ok: status === 200, status, headers: { get: () => '0' }, json: async () => (status === 200 ? body : { error: 'busy' }) }
  }
  // 1 Oct loaded first (a day of the run) - kept; then 5 Oct with 2 days before: 2 Oct (holiday) and 30 Sep asked, 1 Oct not.
  const first = await loadBacktestDay('BANKNIFTY', '2026-10-01', { fetch: fakeFetch })
  assert.ok(first.ok && !first.odmPast)
  asked.length = 0
  const day = await loadBacktestDay('BANKNIFTY', '2026-10-05', { fetch: fakeFetch, deltaDays: 2 })
  assert.ok(day.ok, day.reason)
  assert.deepEqual(asked, ['2026-10-05', '2026-10-02', '2026-09-30'])
  assert.equal(day.odmPast.length, 2)
  assert.deepEqual(day.odmPast[1], first.odm)                                       // the day before = 1 Oct, the latest last
  assert.equal(day.odmPast[0][0].t, prepareDay(runs['2026-09-30'], { underlying: 'BANKNIFTY' }).odm[0].t)
  // The outcome counts them; the report lists a day with fewer than the rule reads.
  const settings = cleanBacktestSettings({ underlying: 'BANKNIFTY', rule: { tree: { op: 'and', items: [{ line: { id: 'odpPoc', value: 'above', param3: 3, param4: 1 } }] }, action: 'buyCE', mirror: false } })
  const outcome = dayOutcome('2026-10-05', day, engineSettings(settings))
  assert.equal(outcome.deltaPast, 2)
  assert.deepEqual(backtestReport([outcome], settings).noDeltaPast, ['2026-10-05'])
  // A day before that cannot be loaded (a server error): the day is not run - tried again (`retry`).
  failDay = '2026-09-29'
  const failed = await loadBacktestDay('BANKNIFTY', '2026-10-05', { fetch: fakeFetch, deltaDays: 3 })
  assert.equal(failed.ok, false)
  assert.ok(failed.retry)
  assert.match(failed.reason, /option Δ profile of the days before - 2026-09-29: busy/)
})
