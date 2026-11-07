// The Signal backtest's "Σ 3 expiries" (prepareDay's `expiryChains`, loadBacktestDay's `sumExpiries` - OI Replay's own):
// every OI read on the current + next + monthly expiry's OI, GEX adding each one's own, the premiums and trades the current
// expiry's; nothing after a minute read; the day's other expiries loaded as OI Replay loads them, the monthly never twice.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { day as syntheticDay } from './synthetic-day.mjs'
import { prepareDay, simulateDay } from '../src/signalBacktest.js'
import { gexDay } from '../src/gex.js'
import { cleanBacktestSettings, engineSettings, loadBacktestDay, reportHead } from '../src/signalBacktestJob.js'

const { run: base } = syntheticDay()   // NIFTY 2026-10-05, 09:15 - 14:15
const DATE = '2026-10-05'
const run = { ...base, optionExpiry: '2026-10-06' }
// Another expiry: the same strikes and minutes, OI `scale` x the current's (+ `at` extra at one strike), its own premiums.
const chain = (scale, { premium = 3, at = null, extra = 0, expiry = '2026-10-13' } = {}) => {
  const side = (list) => list.map((p) => ({ ...p, openInterest: Math.round(p.openInterest * scale) + (p.strike === at ? extra : 0), price: p.price * premium }))
  return { cePoints: side(run.cePoints), pePoints: side(run.pePoints), expiry }
}
const NEXT = chain(1, { expiry: '2026-10-13' })
const MONTHLY = chain(2, { premium: 5, expiry: '2026-10-27' })
const RULE = { conditions: { vwap: 'crossedAbove' }, action: 'buyCE', mirror: true, windowMin: 5 }

test('the OI reads take the three expiries\' OI; the premiums, the straddle and the trades stay the current expiry\'s', () => {
  const plain = prepareDay(run, { underlying: 'NIFTY' })
  const summed = prepareDay(run, { underlying: 'NIFTY', expiryChains: [NEXT, MONTHLY] })
  assert.equal(summed.ok, true)
  assert.equal(summed.expiries, 3)
  assert.equal(plain.expiries, undefined)
  // The next expiry's OI = the current's, the monthly's twice it: every OI total is four times the current's.
  for (let i = 0; i < plain.n; i += 17) {
    assert.deepEqual(summed.tot[i], { ce: 4 * plain.tot[i].ce, pe: 4 * plain.tot[i].pe }, `Total OI at ${i}`)
    assert.deepEqual(summed.oi[i], { ce: 4 * plain.oi[i].ce, pe: 4 * plain.oi[i].pe }, `OI since open at ${i}`)
    for (const k of ['ceCum', 'peCum', 'netCum']) assert.equal(summed[k][i], plain[k][i] == null ? null : 4 * plain[k][i], `${k} at ${i}`)
  }
  // The premiums - the option bars and volumes, the straddle - are the current expiry's alone (the others' are 3x / 5x).
  assert.deepEqual(summed.ce, plain.ce)
  assert.deepEqual(summed.pe, plain.pe)
  assert.deepEqual(summed.ceVol, plain.ceVol)
  assert.deepEqual(summed.straddle, plain.straddle)
  // GEX: each expiry's own, added (gex.js's `chains`).
  const spot = run.spotCandlesOneMinute.map((b) => ({ time: Date.parse(b.time), close: b.close }))
  const gex = new Map(gexDay(run.cePoints, run.pePoints, spot, { expiry: '2026-10-06', flips: false, chains: [NEXT, MONTHLY] }).map((m) => [m.time, m.net]))
  summed.t.forEach((t, i) => { if (summed.gex[i]) assert.equal(summed.gex[i].net, gex.get(t)) })
  assert.notDeepEqual(summed.gex, plain.gex)
  // Nothing else to add: exactly as before.
  assert.deepEqual(prepareDay(run, { underlying: 'NIFTY', expiryChains: [] }), plain)
  assert.deepEqual(prepareDay(run, { underlying: 'NIFTY', expiryChains: [{ cePoints: [], pePoints: [] }] }), plain)
})

test('a big monthly strike moves the OI wall - the walls read every expiry\'s OI', () => {
  const plain = prepareDay(run, { underlying: 'NIFTY' })
  const last = plain.n - 1
  const spotNow = plain.spot.c[last]
  const above = Math.ceil(spotNow / 50) * 50 + 150
  const summed = prepareDay(run, { underlying: 'NIFTY', expiryChains: [chain(0.1, { at: above, extra: 9e7 })] })
  assert.notEqual(plain.walls[last].resistance, above)
  assert.equal(summed.walls[last].resistance, above)
})

test('nothing after a minute read: the summed day cut part way is the whole day\'s up to the cut', () => {
  const whole = prepareDay(run, { underlying: 'NIFTY', expiryChains: [NEXT, MONTHLY] })
  const cut = Date.parse('2026-10-05T11:45:00+05:30')
  const keep = (list) => list.filter((p) => Date.parse(p.time) <= cut)
  const keepChain = (c) => ({ ...c, cePoints: keep(c.cePoints), pePoints: keep(c.pePoints) })
  const part = prepareDay({ ...run, spotCandlesOneMinute: keep(run.spotCandlesOneMinute), futuresBars: keep(run.futuresBars), cePoints: keep(run.cePoints), pePoints: keep(run.pePoints) },
    { underlying: 'NIFTY', expiryChains: [keepChain(NEXT), keepChain(MONTHLY)] })
  assert.equal(part.n, 151)
  for (let i = 0; i < part.n; i++) for (const k of ['oi', 'tot', 'walls', 'gex', 'ceCum', 'peCum', 'netCum']) assert.deepEqual(part[k][i], whole[k][i], `${k} at ${i}`)
  assert.deepEqual(part.breaks, whole.breaks.filter((b) => b.i < part.n))
  const signalsOf = (d) => simulateDay(d, { lotSize: 65, rule: RULE }).signals.map((s) => [s.strategy, s.time, s.dir])
  assert.deepEqual(signalsOf(part), signalsOf(whole).filter(([, time]) => time <= cut))
})

// The loader against a fake server: the run, the day's expiries, the bands.
function fakeFetch({ dates = { current: '2026-10-06', next: '2026-10-13', monthly: '2026-10-27' }, band = () => null, datesStatus = 200 } = {}) {
  const asked = []
  const respond = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
  const fn = async (url) => {
    const u = new URL(url, 'http://x')
    asked.push(`${u.pathname}${u.search}`)
    if (u.pathname.endsWith('/run')) return respond(200, run)
    if (u.pathname.endsWith('/previous-day-volume-profile')) return respond(200, { success: false })
    if (u.pathname.endsWith('/summed-expiries')) return respond(datesStatus, datesStatus === 200 ? dates : { error: 'busy' })
    if (u.pathname.endsWith('/expiry-band')) {
      const flag = u.searchParams.get('expiryFlag'), code = u.searchParams.get('expiryCode')
      const own = band(flag, code)
      if (own) return respond(own.status, own.body)
      const c = flag === 'MONTH' && code === '1' ? MONTHLY : NEXT
      return respond(200, { success: true, cePoints: c.cePoints, pePoints: c.pePoints })
    }
    return respond(404, { error: 'not mocked' })
  }
  return { fn, asked }
}

test('a day loaded with Σ 3 expiries: its current / next / monthly worked out, the next and the monthly asked, summed', async () => {
  const f = fakeFetch()
  const day = await loadBacktestDay('NIFTY', DATE, { fetch: f.fn, sumExpiries: true })
  assert.equal(day.ok, true)
  assert.deepEqual(day.sumExpiries, ['2026-10-06', '2026-10-13', '2026-10-27'])
  assert.equal(day.expiries, 3)
  const bands = f.asked.filter((a) => a.includes('/expiry-band'))
  assert.deepEqual(bands, [
    '/api/oi-replay/NIFTY/expiry-band?date=2026-10-05&expiryFlag=WEEK&expiryCode=2',
    '/api/oi-replay/NIFTY/expiry-band?date=2026-10-05&expiryFlag=MONTH&expiryCode=1',
  ])
  assert.ok(f.asked.includes('/api/oi-replay/NIFTY/summed-expiries?date=2026-10-05&expiryFlag=WEEK'))
  const plain = prepareDay(run, { underlying: 'NIFTY' })
  assert.deepEqual(day.tot[100], { ce: 4 * plain.tot[100].ce, pe: 4 * plain.tot[100].pe })
  // Off: nothing more asked than before.
  const off = fakeFetch()
  const plainDay = await loadBacktestDay('NIFTY', DATE, { fetch: off.fn })
  assert.ok(!off.asked.some((a) => a.includes('summed-expiries') || a.includes('expiry-band')))
  assert.deepEqual(plainDay.tot, plain.tot)
})

test('the monthly that IS the next (or the current) expiry is not asked again - BANKNIFTY reads its Monthly series', async () => {
  const f = fakeFetch({ dates: { current: '2026-10-20', next: '2026-10-27', monthly: '2026-10-27' } })
  const day = await loadBacktestDay('NIFTY', DATE, { fetch: f.fn, sumExpiries: true })
  assert.deepEqual(day.sumExpiries, ['2026-10-20', '2026-10-27'])
  assert.equal(day.expiries, 2)
  assert.equal(f.asked.filter((a) => a.includes('/expiry-band')).length, 1)
  const bank = fakeFetch({ dates: { current: '2026-10-27', next: '2026-11-24', monthly: '2026-10-27' } })
  await loadBacktestDay('BANKNIFTY', DATE, { fetch: bank.fn, sumExpiries: true })
  assert.ok(bank.asked.includes('/api/oi-replay/BANKNIFTY/summed-expiries?date=2026-10-05&expiryFlag=MONTH'))
  assert.deepEqual(bank.asked.filter((a) => a.includes('/expiry-band')), ['/api/oi-replay/BANKNIFTY/expiry-band?date=2026-10-05&expiryFlag=MONTH&expiryCode=2'])
})

test('a day whose other expiries cannot be loaded does not run: a server error once more later, a refusal kept', async () => {
  const busy = await loadBacktestDay('NIFTY', DATE, { fetch: fakeFetch({ band: (flag) => (flag === 'MONTH' ? { status: 503, body: { error: 'busy' } } : null) }).fn, sumExpiries: true })
  assert.equal(busy.ok, false)
  assert.equal(busy.retry, true)
  assert.match(busy.reason, /^Σ 3 expiries - the monthly expiry \(2026-10-27\): busy/)
  const refused = await loadBacktestDay('NIFTY', DATE, { fetch: fakeFetch({ band: () => ({ status: 200, body: { success: false, error: 'live data is off' } }) }).fn, sumExpiries: true })
  assert.equal(refused.ok, false)
  assert.equal(refused.final, true)
  const noDates = await loadBacktestDay('NIFTY', DATE, { fetch: fakeFetch({ dates: { current: null, next: null, monthly: null } }).fn, sumExpiries: true })
  assert.equal(noDates.retry, true)
  assert.match(noDates.reason, /the day's expiries: could not be worked out/)
})

test('the setting: off by default, kept by a run / saved strategy, named in the report heading, not read by the engine', () => {
  assert.equal(cleanBacktestSettings({}).sumExpiries, false)
  assert.equal(cleanBacktestSettings({ sumExpiries: true }).sumExpiries, true)
  assert.equal(cleanBacktestSettings({ sumExpiries: 'yes' }).sumExpiries, false)
  const s = cleanBacktestSettings({ underlying: 'NIFTY', from: '2026-10-01', to: '2026-10-05', sumExpiries: true })
  assert.match(reportHead(s, 3), /1m candles · OI Σ 3 expiries · SL/)
  assert.doesNotMatch(reportHead(cleanBacktestSettings({ underlying: 'NIFTY', from: '2026-10-01', to: '2026-10-05' }), 3), /Σ/)
  assert.equal('sumExpiries' in engineSettings(s), false)
})
