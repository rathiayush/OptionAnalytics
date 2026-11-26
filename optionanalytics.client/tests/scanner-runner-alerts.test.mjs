// The Order Flow page's SUDDEN OI WALL and PRICE alerts on the SERVER alert runner (indexScanner.mjs checkSuddenWalls /
// checkPriceAlerts): Telegram tagged [Server] with no page open, keyed like the page's so a message goes once.
import test from 'node:test'
import assert from 'node:assert/strict'
import { IndexScanner, TAG } from '../scanner-runner/indexScanner.mjs'
import { suddenWallKey } from '../src/suddenOi.js'

const MIN = 60_000
const DATE = '2026-10-26'
const T0 = Date.UTC(2026, 9, 26, 3, 45)   // 09:15 IST
const STRIKES = [24900, 24950, 25000, 25050, 25100]

// OI by strike: flat 400 000, the 25000 PUT adds `jump` in the last 5 minutes (a sudden wall once it is big).
function oiAt(minutes, jump) {
  const ce = new Map(STRIKES.map((k) => [k, []])), pe = new Map(STRIKES.map((k) => [k, []]))
  for (let m = 0; m < minutes; m++) {
    for (const k of STRIKES) {
      ce.get(k).push({ t: T0 + m * MIN, oi: 400_000 })
      pe.get(k).push({ t: T0 + m * MIN, oi: 400_000 + (k === 25000 && m >= minutes - 5 ? jump * (m - (minutes - 6)) / 5 : 0) })
    }
  }
  return { step: 50, live: true, ce, pe, futures: [], spot: [{ t: T0 + (minutes - 1) * MIN, close: 25000 }] }
}
const data = (minutes, jump, price = 25040) => ({ oi: oiAt(minutes, jump), prints: [{ price }], view: { meta: { lastPrice: price } } })

function scanner(config = {}) {
  const io = { clock: T0, sent: [], logs: [], now: () => io.clock, log: (m) => io.logs.push(m), telegram: async (text, key) => { io.sent.push({ text, key }) } }
  const s = new IndexScanner('NIFTY', io)
  s.reset(DATE)
  s.setConfig({ settings: { telegram: true }, ...config })
  return { s, io }
}

test('a sudden put wall goes to Telegram, tagged [Server] and keyed, once - and not again within 30 minutes', async () => {
  const { s, io } = scanner()
  const now = T0 + 40 * MIN
  await s.checkSuddenWalls(data(40, 400_000), now)
  assert.equal(io.sent.length, 1)
  assert.ok(io.sent[0].text.startsWith(`${TAG} 🧱 Sudden OI wall - NIFTY PUT 25000`))
  assert.match(io.sent[0].text, /support/)
  assert.equal(io.sent[0].key, suddenWallKey('NIFTY', DATE, { side: 'PE', strike: 25000 }, now))
  await s.checkSuddenWalls(data(41, 400_000), now + MIN)
  assert.equal(io.sent.length, 1)
})

test('a small add is not an alert, Telegram off sends nothing, and nothing before 09:25', async () => {
  const small = scanner()
  await small.s.checkSuddenWalls(data(40, 20_000), T0 + 40 * MIN)
  assert.equal(small.io.sent.length, 0)
  const quiet = scanner({ settings: { telegram: false } })
  await quiet.s.checkSuddenWalls(data(40, 400_000), T0 + 40 * MIN)
  assert.equal(quiet.io.sent.length, 0)
  const early = scanner()
  await early.s.checkSuddenWalls(data(8, 400_000), T0 + 8 * MIN)
  assert.equal(early.io.sent.length, 0)
})

test('a price alert the page saved fires once on the server, keyed price-{id}, and is reported fired', async () => {
  const { s, io } = scanner({ priceAlerts: { NIFTY: [{ id: 'a1', price: 25030, dir: 'above' }, { id: 'b2', price: 24000, dir: 'below' }], BANKNIFTY: [{ id: 'c3', price: 1, dir: 'above' }] } })
  await s.checkPriceAlerts(data(10, 0, 25040))
  assert.equal(io.sent.length, 1)
  assert.equal(io.sent[0].key, 'price-a1')
  assert.ok(io.sent[0].text.startsWith(`${TAG} 🔔 Price alert: NIFTY futures rose to 25030`))
  await s.checkPriceAlerts(data(11, 0, 25045))
  assert.equal(io.sent.length, 1)
  assert.deepEqual(s.status().priceFired, ['a1'])
})

test('a price alert falling below its level fires; no alerts or a bad list send nothing', async () => {
  const down = scanner({ priceAlerts: { NIFTY: [{ id: 'd4', price: 25100, dir: 'below' }] } })
  await down.s.checkPriceAlerts(data(10, 0, 25090))
  assert.match(down.io.sent[0].text, /fell to 25100/)
  const none = scanner({ priceAlerts: { NIFTY: 'oops' } })
  await none.s.checkPriceAlerts(data(10, 0))
  assert.equal(none.io.sent.length, 0)
  const unset = scanner()
  await unset.s.checkPriceAlerts(data(10, 0))
  assert.equal(unset.io.sent.length, 0)
})
