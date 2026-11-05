// The Signal backtest's IN ORDER (THEN) logic (signalBacktest.js - asked for: "PE crossover CE, then bullish divergence
// appears and EMA crossed down then came back up"): typed and built, its window, read over the day's candles (`logicAt`)
// - each part after the one before it, the first within the window, nothing after the candle read - and the EMA's "crossed
// down, then back up" in one condition.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_THEN_WINDOW, RULE_CONDITIONS, cleanLine, cleanTree, emaPriceHolds, lineText, logicAt, logicText, logicWithoutLine, mirrorLines, normalizeRule, parseLogic,
  ruleFromTree, ruleSignals, ruleText, setConnectorAt, timeframeView, treeFromLogic,
} from '../src/signalBacktest.js'

const T915 = Date.parse('2026-10-05T09:15:00+05:30')
const MIN = 60_000

test('THEN typed: in order, its window after WITHIN (30 min when none), AND / OR inside brackets; what does not read', () => {
  assert.deepEqual(parseLogic('1 THEN 2 THEN 3 WITHIN 45', 3).tree, { op: 'then', items: [{ line: 1 }, { line: 2 }, { line: 3 }], within: 45 })
  assert.equal(parseLogic('1 then 2', 2).tree.within, DEFAULT_THEN_WINDOW)
  assert.deepEqual(parseLogic('1 -> 2 within 10 min', 2).tree, { op: 'then', items: [{ line: 1 }, { line: 2 }], within: 10 })
  const p = parseLogic('(1 AND 2) THEN 3 WITHIN 60 min', 3)
  assert.equal(logicText(p.tree), '(1 AND 2) THEN 3 WITHIN 60 MIN')
  assert.equal(logicText(parseLogic('(1 THEN 2 WITHIN 15) OR 3', 3).tree), '(1 THEN 2 WITHIN 15 MIN) OR 3')
  assert.match(parseLogic('1 AND 2 WITHIN 30', 2).error, /WITHIN goes after a THEN/)
  assert.match(parseLogic('1 THEN 2 WITHIN', 2).error, /needs its minutes/)
  assert.match(parseLogic('1 THEN 2 WITHIN 999', 2).error, /WITHIN 1 - 375/)
  assert.match(parseLogic('1 THEN 7', 2).error, /no line 7/)
})

test('THEN in the builder: a group IN ORDER with its window, made from typed logic and written back the same', () => {
  const line = (id, value) => ({ line: cleanLine({ id, value }) })
  const tree = { op: 'and', not: false, items: [line('oiOpen', 'peCross'), line('cumNet', 'divBull'), line('emaPrice', 'reclaimed')] }
  // Beside AND / OR it needs brackets.
  assert.match(treeFromLogic(tree, '1 THEN 2 AND 3').error, /THEN beside AND \/ OR - add brackets/)
  const r = treeFromLogic(tree, '1 THEN 2 THEN 3 WITHIN 60')
  assert.equal(r.ok, true)
  assert.equal(r.tree.op, 'then')
  assert.equal(r.tree.within, 60)
  assert.deepEqual(r.tree.items.map((it) => it.line.id), ['oiOpen', 'cumNet', 'emaPrice'])
  assert.equal(ruleFromTree(r.tree).logic, '1 THEN 2 THEN 3 WITHIN 60 MIN')
  // Nested: (1 AND 2) THEN 3 - the AND a group inside the THEN group, written in brackets.
  const nested = treeFromLogic(tree, '(1 AND 2) THEN 3 WITHIN 45')
  assert.deepEqual([nested.tree.op, nested.tree.items[0].group.op, nested.tree.items[1].line.id], ['then', 'and', 'emaPrice'])
  assert.equal(ruleFromTree(nested.tree).logic, '(1 AND 2) THEN 3 WITHIN 45 MIN')
  // Inside another group: in brackets with its window.
  const inside = { op: 'or', not: false, items: [{ group: { op: 'then', within: 15, items: [line('oiOpen', 'peCross'), line('vwap', 'crossedAbove')] } }, line('hp', 'bullish')] }
  assert.equal(ruleFromTree(inside).logic, '(1 THEN 2 WITHIN 15 MIN) OR 3')
  // Made whole: the window held to 1 - 375 minutes (30 when none); an AND / OR group has none.
  assert.equal(cleanTree({ op: 'then', within: 999, items: [] }).within, 375)
  assert.equal(cleanTree({ op: 'then', items: [] }).within, DEFAULT_THEN_WINDOW)
  assert.equal('within' in cleanTree({ op: 'and', within: 60, items: [] }), false)
  // Its connectors are THEN - not switches.
  assert.equal(setConnectorAt(r.tree, [], 1, 'or'), r.tree)
  // The rule in words, the window kept; a removed line leaves the rest in order.
  const rule = normalizeRule({ tree: r.tree, action: 'buyCE', mirror: true })
  assert.match(ruleText(rule.lines, rule.action, rule.logic), /^Buy CE when OI since open .* THEN .*divergence.* THEN .*reclaimed it.* WITHIN 60 MIN$/)
  assert.equal(logicWithoutLine('1 THEN 2 THEN 3 WITHIN 45 MIN', 3, 2), '1 THEN 2 WITHIN 45 MIN')
  assert.equal(logicWithoutLine('1 THEN 2 WITHIN 45 MIN', 2, 2), '1')
  // The mirror keeps the order and the window - each line its other side.
  const mirrored = mirrorLines(rule.lines)
  assert.deepEqual(mirrored.map((l) => l.value), ['ceCross', 'divBear', 'lost'])
})

test('THEN read over the candles: each part after the one before, the first within the window, nothing after the candle', () => {
  const during = (...ranges) => (k) => ranges.some(([a, b]) => k >= a && k <= b)
  const run = (text, leaves, n = 200) => {
    const asked = []
    const f = logicAt(parseLogic(text, Object.keys(leaves).length).tree, n, (no, k) => { asked.push(k); return leaves[no](k) })
    return { f, asked }
  }
  // 1 from 50, 2 from 60, 3 from 75 (each holding a few minutes).
  const inOrder = { 1: during([50, 54]), 2: during([60, 70]), 3: during([75, 79]) }
  const { f } = run('1 THEN 2 THEN 3 WITHIN 30', inOrder)
  assert.deepEqual([f(74), f(75), f(79), f(80)], [false, true, true, false])
  // The first part must have happened within the window: 75 - 25 + 1 = 51 > 50.
  assert.equal(run('1 THEN 2 THEN 3 WITHIN 25', inOrder).f(75), false)
  assert.equal(run('1 THEN 2 THEN 3 WITHIN 26', inOrder).f(75), true)
  // Out of order: 3 before 1 - never.
  const wrong = { 1: during([50, 54]), 2: during([60, 70]), 3: during([40, 44]) }
  const w = run('1 THEN 2 THEN 3 WITHIN 60', wrong).f
  assert.ok([...Array(200).keys()].every((i) => !w(i)))
  // Starting together counts (one candle can hold two steps).
  assert.equal(run('1 THEN 2 WITHIN 10', { 1: during([60, 62]), 2: during([60, 65]) }).f(60), true)
  // A part true since the open did not HAPPEN in a 30-minute window - in a 90-minute one it did (from the day's first candle).
  const state = { 1: during([0, 199]), 2: during([75, 80]) }
  assert.equal(run('1 THEN 2 WITHIN 30', state).f(75), false)
  assert.equal(run('1 THEN 2 WITHIN 90', state).f(75), true)
  // The last part's current run must have started in the window, after the others.
  assert.equal(run('1 THEN 2 WITHIN 30', { 1: during([60, 61]), 2: during([10, 100]) }).f(70), false)
  // Inside other logic: (1 OR 2) THEN 3; NOT a chain.
  assert.equal(run('(1 OR 2) THEN 3 WITHIN 30', { 1: during([10, 11]), 2: during([60, 61]), 3: during([75, 76]) }).f(75), true)
  assert.equal(run('NOT (1 THEN 2 WITHIN 30)', { 1: during([60, 61]), 2: during([75, 76]) }).f(75), false)
  // Nothing after the candle read is asked.
  for (const i of [60, 75, 120]) {
    const { f: g, asked } = run('1 THEN 2 THEN 3 WITHIN 30', inOrder)
    g(i)
    assert.ok(asked.every((k) => k <= i), `read at ${i}`)
  }
})

// A prepared day by hand: `n` minutes from 09:15, every feature flat unless given (the parts this file's rules read).
function fakeDay({ n = 200, price = () => 25000, vwap = () => 25000, oi = () => ({ ce: 0, pe: 0 }), tot = () => ({ ce: 4e7, pe: 4e7 }) } = {}) {
  const t = Array.from({ length: n }, (_, i) => T915 + i * MIN)
  const col = (f) => Array.from({ length: n }, (_, i) => f(i))
  const flat = { o: col(price), h: col(price), l: col(price), c: col(price) }
  return {
    ok: true, date: '2026-10-05', underlying: 'NIFTY', step: 50, n, t, atm: col(() => 25000), spot: flat, price: flat, vwap: col(vwap), spotVwap: col(vwap), oi: col(oi), tot: col(tot),
    walls: col(() => ({})), gex: col(() => null), straddle: col(() => null), ceCum: col(() => NaN), peCum: col(() => NaN), netCum: col(() => NaN),
    breaks: [], hp: [], ib: null, prevVp: null, prevDay: null, pivots: null, ce: new Map(), pe: new Map(),
  }
}

test('a rule IN ORDER on a day: OI since open PE crosses CE, then total OI PE crosses CE, then price crosses VWAP - in that order only', () => {
  // OI since open: PE ahead from 50. Total OI: PE over CE from 60. Price over VWAP from 70.
  const day = (oiAt, totAt, vwapAt) => fakeDay({
    oi: (i) => (i < oiAt ? { ce: 100, pe: 90 } : { ce: 100, pe: 130 }),
    tot: (i) => (i < totAt ? { ce: 4e7, pe: 3.9e7 } : { ce: 4e7, pe: 4.2e7 }),
    price: (i) => (i < vwapAt ? 24990 : 25020),
  })
  const tree = (within, op = 'then') => ({
    op, not: false, within,
    items: [{ line: { id: 'oiOpen', value: 'peCross' } }, { line: { id: 'totalOi', value: 'peCross' } }, { line: { id: 'vwap', value: 'crossedAbove' } }],
  })
  const signals = (d, t) => ruleSignals(d, { tree: t, action: 'buyCE', mirror: false }).map((x) => x.i)
  assert.deepEqual(signals(day(50, 60, 70), tree(30)), [70])
  // Out of order (the price over VWAP first) or too slow for the window: no signal.
  assert.deepEqual(signals(day(50, 60, 40), tree(60)), [])
  assert.deepEqual(signals(day(50, 60, 70), tree(15)), [])
  // All of them at once (AND, each with its own 5-minute look-back) never meet - the crosses are 10 minutes apart.
  assert.deepEqual(signals(day(50, 60, 70), tree(undefined, 'and')), [])
  // On 5-minute candles the window is the same minutes (30 = 6 candles): the crosses in candles 10, 12 and 14.
  const v5 = timeframeView(day(50, 60, 70), 5)
  assert.deepEqual(signals(v5, tree(30)), [14])
  assert.deepEqual(signals(v5, tree(20)), [])
})

test('EMA: crossed down, then back up (reclaimed) - and up, then back down (lost) - in the look-back', () => {
  const make = (c) => ({ o: c, h: c, l: c, c })
  const e = Array(8).fill(100)
  // Closes: over, over, under (2 - crossed down), under, over (4 - back up), over, over, over.
  const bars = make([102, 103, 99, 98, 101, 102, 103, 104])
  const at = (i, v, w = 5, p = 0) => emaPriceHolds(bars, e, i, v, w, p)
  assert.ok(!at(3, 'reclaimed') && at(4, 'reclaimed') && at(6, 'reclaimed') && !at(4, 'lost'))
  // Both crosses in the look-back: at 5 a 4-candle window holds 2 - 5, a 3-candle one only 3 - 5 (the cross down at 2 out).
  assert.ok(at(5, 'reclaimed', 4) && !at(5, 'reclaimed', 3))
  // By ≥ %: the close over the EMA now (101 = 1%).
  assert.ok(at(4, 'reclaimed', 5, 1) && !at(4, 'reclaimed', 5, 1.1))
  // The mirror image: up, then back down.
  const lostBars = make([98, 97, 101, 102, 99, 98])
  assert.ok(emaPriceHolds(lostBars, e, 4, 'lost', 5, 0) && !emaPriceHolds(lostBars, e, 4, 'reclaimed', 5, 0))
  // On the conditions: spot's mirror is the other way; a premium's the other side's same reading; a 60-minute look-back offered.
  const cond = RULE_CONDITIONS.find((c) => c.id === 'emaPrice')
  assert.ok(cond.options.some((o) => o.value === 'reclaimed' && o.windowed && o.param))
  assert.deepEqual(mirrorLines([cleanLine({ id: 'emaPrice', value: 'reclaimed', windowMin: 60 })]).map((l) => [l.value, l.windowMin]), [['lost', 60]])
  assert.deepEqual(mirrorLines([cleanLine({ id: 'cePremEma', value: 'reclaimed' })]).map((l) => [l.id, l.value]), [['pePremEma', 'reclaimed']])
  assert.match(lineText(cleanLine({ id: 'emaPrice', value: 'reclaimed', param2: 20, windowMin: 30 })), /Crossed down through the EMA, then back up \(reclaimed it\), EMA 20 \(last 30 min\)$/)
})
