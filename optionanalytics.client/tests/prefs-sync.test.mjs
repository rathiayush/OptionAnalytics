// The page preferences kept for the account on the server too (prefsSync.js, GET / PUT /api/preferences): what a fresh
// browser gets, what is sent and when, and what never leaves this browser.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LOCAL_ONLY, MAX_VALUE_BYTES, createPreferenceSync, isPreferenceKey } from '../src/prefsSync.js'

function fakeStorage(entries = {}) {
  const map = new Map(Object.entries(entries))
  return {
    get length() { return map.size },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)) },
    removeItem: (k) => { map.delete(k) },
    dump: () => Object.fromEntries(map),
  }
}

// A server: GET answers what it holds, PUT merges (null removes); `fail` makes the next PUTs throw, `refuse` answer 400.
function fakeServer(values = {}, version = values && Object.keys(values).length ? 3 : 0) {
  const server = { values: { ...values }, version, puts: [], fail: 0, refuse: false, down: false }
  server.request = async (method, sent) => {
    if (method === 'GET') {
      if (server.down) throw new Error('HTTP 502')
      return { version: server.version, values: { ...server.values } }
    }
    server.puts.push(sent)
    if (server.fail > 0) { server.fail -= 1; throw new Error('HTTP 503') }
    if (server.refuse) return { ok: false, permanent: true }
    for (const [k, v] of Object.entries(sent)) { if (v == null) delete server.values[k]; else server.values[k] = v }
    server.version += 1
    return { ok: true }
  }
  return server
}

const make = (storage, server) => createPreferenceSync({ storage, request: server.request, delayMs: 60_000, retryMs: 60_000 })

test('a fresh browser opens the pages as the account left them', async () => {
  const storage = fakeStorage()
  const server = fakeServer({ 'optionanalytics.oiReplay.gridLayout': '[{"i":"gex"}]', 'optionanalytics.sideNavCollapsed': 'true' })
  const sync = make(storage, server)
  assert.equal(await sync.load(), true)
  assert.deepEqual(storage.dump(), { 'optionanalytics.oiReplay.gridLayout': '[{"i":"gex"}]', 'optionanalytics.sideNavCollapsed': 'true' })
  assert.equal(server.puts.length, 0)            // loading sends nothing back
})

test('the first time, this browser\'s own preferences become the account\'s - never its caches or positions', async () => {
  const storage = fakeStorage({
    'optionanalytics.oiReplay.gridLayout': '[1]',
    'optionanalytics.oiReplay.liveDayCache': '{"huge":true}',
    'optionanalytics.oiReplay.livePaperPositions': '{}',
    'optionanalytics.strategyScanner.tradeMode': 'live',
    'optionanalytics.oiReplay.tooBig': 'x'.repeat(MAX_VALUE_BYTES + 1),
    'someone.else': '1',
  })
  const server = fakeServer()
  await make(storage, server).load()
  assert.deepEqual(server.values, { 'optionanalytics.oiReplay.gridLayout': '[1]' })
})

test('a change is sent once loaded; the same value again is not; a removal is', async () => {
  const storage = fakeStorage()
  const server = fakeServer({ 'optionanalytics.a': '1' })
  const sync = make(storage, server)
  await sync.load()
  sync.noteWrite('optionanalytics.a', '1')         // what the server has already (a page writing its state back on mount)
  assert.deepEqual(sync.pendingKeys(), [])
  sync.noteWrite('optionanalytics.a', '2')
  sync.noteWrite('optionanalytics.b', '"x"')
  sync.noteWrite('optionanalytics.b', '"y"')       // gathered: only the last value goes
  await sync.flush()
  assert.deepEqual(server.puts, [{ 'optionanalytics.a': '2', 'optionanalytics.b': '"y"' }])
  sync.noteWrite('optionanalytics.b', null)
  await sync.flush()
  assert.deepEqual(server.values, { 'optionanalytics.a': '2' })
})

test('nothing is sent before a load worked - a fresh browser\'s defaults never overwrite what was saved', async () => {
  const storage = fakeStorage()
  const server = fakeServer({ 'optionanalytics.a': 'saved' })
  server.down = true
  const sync = make(storage, server)
  assert.equal(await sync.load(), false)
  sync.noteWrite('optionanalytics.a', 'default')
  await sync.flush()
  assert.equal(server.puts.length, 0)
  assert.equal(server.values['optionanalytics.a'], 'saved')
})

test('a failed send is tried again; one the server refuses for good is not', async () => {
  const server = fakeServer({ 'optionanalytics.a': '1' })
  const sync = make(fakeStorage(), server)
  await sync.load()
  server.fail = 1
  sync.noteWrite('optionanalytics.a', '2')
  assert.equal(await sync.flush(), false)
  assert.deepEqual(sync.pendingKeys(), ['optionanalytics.a'])   // kept for the retry
  assert.equal(await sync.flush(), true)
  assert.equal(server.values['optionanalytics.a'], '2')
  server.refuse = true
  sync.noteWrite('optionanalytics.a', '3')
  assert.equal(await sync.flush(), false)
  assert.deepEqual(sync.pendingKeys(), [])                     // dropped, not retried for ever
})

test('the Paper / Live choice, positions, trade levels and caches never come from or go to the server', async () => {
  for (const key of ['optionanalytics.strategyScanner.tradeMode', 'optionanalytics.oiReplay.livePaperPositions',
    'optionanalytics.tradeLevels.global.v1', 'optionanalytics.oiReplay.liveDayCache', 'optionanalytics.visitorId']) {
    assert.equal(LOCAL_ONLY.has(key), true, key)
    assert.equal(isPreferenceKey(key), false, key)
  }
  assert.equal(isPreferenceKey('optionanalytics.oiReplay.chartB.timeframe'), true)
  assert.equal(isPreferenceKey('other.app.key'), false)
  // A server that somehow holds one: it is not put into this browser.
  const storage = fakeStorage()
  await make(storage, fakeServer({ 'optionanalytics.strategyScanner.tradeMode': 'live', 'optionanalytics.a': '1' })).load()
  assert.deepEqual(storage.dump(), { 'optionanalytics.a': '1' })
})

test('signing out sends what is waiting, then nothing more', async () => {
  const server = fakeServer({ 'optionanalytics.a': '1' })
  const sync = make(fakeStorage(), server)
  await sync.load()
  sync.noteWrite('optionanalytics.a', '2')
  await sync.pause()
  assert.equal(server.values['optionanalytics.a'], '2')
  sync.noteWrite('optionanalytics.a', '3')
  await sync.flush()
  assert.equal(server.values['optionanalytics.a'], '2')
  assert.equal(sync.isReady(), false)
})
