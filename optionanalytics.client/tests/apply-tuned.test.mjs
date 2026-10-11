// Applying a fine-tuned setting (Trades page / Strategy tuning page - src/scannerSettings.js): it is stored for the
// index it was tuned on, on the server apart from the page's synced settings (so a page saving its settings never wipes
// it), the scanner on that index runs the strategy with it (filtersForIndex) and the other indices keep theirs; it can
// also put the strategy on that index's live list. Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'

const store = new Map()
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }

const { applyFilterValue, applyTunedFilters, putOnLiveList, readFiltersByIndex, saveIndexFilters, SCANNER_SETTINGS_KEY } = await import('../src/scannerSettings.js')
const { filtersFromTuning, DEFAULT_VARIANT, OPTION_DEFAULT } = await import('../src/strategyTuning.js')
const { filtersForIndex } = await import('../src/strategyEngine.js')

/** The server's /api/scanner-runner endpoints, as ScannerRunnerController / ScannerRunnerStore answer them. */
function fakeServer({ tamper = false } = {}) {
  const config = { settings: { pick: 'top15', filters: { absorption: { tradeSide: 'both', minRatio: 3 } } } }
  const liveList = []
  globalThis.fetch = async (url, opts = {}) => {
    const method = opts.method ?? 'GET'
    const body = opts.body ? JSON.parse(opts.body) : null
    const ok = (json) => ({ ok: true, status: 200, json: async () => structuredClone(json) })
    if (url === '/api/scanner-runner/config' && method === 'GET') return ok(config)
    if (url === '/api/scanner-runner/config' && method === 'PUT') { Object.assign(config, structuredClone(body)); return ok(config) }
    const m = url.match(/^\/api\/scanner-runner\/applied\/([^/]+)\/([^/]+)$/)
    if (m && method === 'PUT') {
      const [, u, id] = m
      config.filtersByIndex ??= {}
      const index = config.filtersByIndex[u] ?? {}
      if (body.filters == null) delete index[id]
      else index[id] = tamper ? { ...body.filters, tradeSide: 'short' } : structuredClone(body.filters)
      if (Object.keys(index).length) config.filtersByIndex[u] = index
      else delete config.filtersByIndex[u]
      return ok(config)
    }
    if (url === '/api/scanner-runner/live-list' && method === 'PUT') { liveList.push(body); return ok({}) }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) }
  }
  return { config, liveList }
}

const niftyBest = { ...DEFAULT_VARIANT, ...OPTION_DEFAULT, tradeSide: 'long', tradeStopX: 1.5, optLeg: 'buy', optMoneyness: -1, optExit: 'indexSl', optSlPct: 30 }
const bankBest = { ...DEFAULT_VARIANT, ...OPTION_DEFAULT, tradeSide: 'short', optLeg: 'sell' }

test('applied for its index: that index runs the strategy with it, the others keep theirs, nothing else changes', async () => {
  store.clear()
  const srv = fakeServer()
  const got = await applyTunedFilters('absorption', niftyBest, { option: true, index: 'NIFTY' })
  const want = filtersFromTuning({ tradeSide: 'both', minRatio: 3 }, niftyBest, { option: true })
  assert.deepEqual(got, want)
  assert.equal(want.minRatio, 3, 'the strategy\'s own entry filters are kept')
  assert.equal(want.tradeOptLeg, 'buy')
  assert.equal(want.tradeOptSlPct, 30, 'the option\'s Max SL goes across')
  assert.deepEqual(srv.config.filtersByIndex.NIFTY.absorption, want)
  assert.deepEqual(srv.config.settings.filters.absorption, { tradeSide: 'both', minRatio: 3 }, 'the all-index filters are untouched')
  assert.deepEqual(readFiltersByIndex(), srv.config.filtersByIndex, 'this browser has the copy')
  // BANKNIFTY's own best for the same strategy: both stand.
  await applyTunedFilters('absorption', bankBest, { option: true, index: 'BANKNIFTY' })
  assert.equal(srv.config.filtersByIndex.NIFTY.absorption.tradeSide, 'long')
  assert.equal(srv.config.filtersByIndex.BANKNIFTY.absorption.tradeSide, 'short')
  // What each index's scanner runs with.
  const eff = (u) => filtersForIndex({ filters: srv.config.settings.filters, filtersByIndex: srv.config.filtersByIndex }, u).absorption
  assert.equal(eff('NIFTY').tradeOptLeg, 'buy')
  assert.equal(eff('BANKNIFTY').tradeSide, 'short')
  assert.deepEqual(eff('SENSEX'), { tradeSide: 'both', minRatio: 3 })
  // A page saving its settings (even an older copy without them) does not wipe what was applied.
  await fetch('/api/scanner-runner/config', { method: 'PUT', body: JSON.stringify({ settings: { pick: 'all', filters: {} } }) })
  assert.equal(srv.config.filtersByIndex.NIFTY.absorption.tradeOptLeg, 'buy')
  // Removed: back to the all-index filters there only.
  await saveIndexFilters('NIFTY', 'absorption', null)
  assert.equal(srv.config.filtersByIndex.NIFTY, undefined)
  assert.equal(srv.config.filtersByIndex.BANKNIFTY.absorption.tradeSide, 'short')
})

test('a not-recommended setting applies just the same, and the live list is changed only when asked', async () => {
  store.clear()
  const srv = fakeServer()
  await applyTunedFilters('vwapPullback', niftyBest, { option: true, index: 'NIFTY' })
  assert.equal(srv.liveList.length, 0, 'applying alone never touches the live list')
  await putOnLiveList('NIFTY', 'vwapPullback')
  assert.deepEqual(srv.liveList, [{ underlying: 'NIFTY', strategyId: 'vwapPullback', mode: 'include' }])
})

test('a server that keeps something else fails loudly; a learning filter reaches every index it applies to', async () => {
  store.clear()
  fakeServer({ tamper: true })
  await assert.rejects(applyTunedFilters('absorption', niftyBest, { option: true, index: 'NIFTY' }), /saved something different/)

  store.clear()
  const srv = fakeServer()
  await applyTunedFilters('absorption', niftyBest, { option: true, index: 'NIFTY' })
  await applyFilterValue('absorption', 'tradeTape', 'with')
  assert.equal(srv.config.settings.filters.absorption.tradeTape, 'with')
  assert.equal(srv.config.filtersByIndex.NIFTY.absorption.tradeTape, 'with', 'the NIFTY setting replaces the all-index one there, so it gets it too')
  assert.equal(srv.config.filtersByIndex.NIFTY.absorption.tradeOptLeg, 'buy', 'and keeps the rest')
  assert.equal(JSON.parse(store.get(SCANNER_SETTINGS_KEY)).filters.absorption.tradeTape, 'with')
})

test('an applied setting carries its identity - the same the server makes from the history row - and the scanner ignores it', async () => {
  const { settingSignature, settingParams } = await import('../src/strategyTuning.js')
  const { strategyFilters } = await import('../src/strategyEngine.js')
  // The settings CSV row of a tuned setting (strings, every column; empty = not set) and the same setting as tuned.
  const row = { run_id: 'R1', which: 'fine-tuned', strategy_id: 'absorption', tradeSide: 'long', tradeFrom: '930', tradeTo: '1445', tradeStopX: '1.5', tradeOiWindow: '', optLeg: 'buy', optMoneyness: '-1', optExit: 'indexSl', optSlPct: '30', optTargetPct: '30', setting_text: 'x', test_trades: '6' }
  const params = { ...DEFAULT_VARIANT, ...OPTION_DEFAULT, tradeSide: 'long', tradeFrom: 930, tradeTo: 1445, tradeStopX: 1.5, optLeg: 'buy', optMoneyness: -1, optExit: 'indexSl', optSlPct: 30, optTargetPct: 30 }
  // Server: TuningPerformance.SignatureOf - every non-empty trade* / opt* column, sorted, "k=v" joined by "|".
  const server = Object.keys(row).filter((k) => /^(trade|opt)/.test(k) && row[k] !== '').sort().map((k) => `${k}=${row[k]}`).join('|')
  assert.equal(settingSignature(row), server)
  assert.ok(settingSignature(params).includes('tradeSide=long') && settingSignature(params).includes('optExit=indexSl'))
  store.clear()
  const srv = fakeServer()
  await applyTunedFilters('absorption', params, { option: true, index: 'NIFTY', tuned: settingSignature(row) })
  assert.equal(srv.config.filtersByIndex.NIFTY.absorption._tuned, server)
  assert.equal(strategyFilters('absorption', srv.config.filtersByIndex.NIFTY.absorption)._tuned, undefined, 'never a filter the scanner reads')
  // Applying another setting replaces the identity; one applied without (an older caller) carries none.
  await applyTunedFilters('absorption', { ...params, tradeSide: 'short' }, { option: true, index: 'NIFTY', tuned: 'tradeSide=short' })
  assert.equal(srv.config.filtersByIndex.NIFTY.absorption._tuned, 'tradeSide=short')
  await applyTunedFilters('absorption', params, { option: true, index: 'NIFTY' })
  assert.equal(srv.config.filtersByIndex.NIFTY.absorption._tuned, undefined)
  // Every parameter, the changed ones marked - from the row, as tuned, or as applied.
  const fromRow = settingParams(row, 'row')
  assert.equal(fromRow.find((p) => p.key === 'tradeSide').changed, true)
  assert.equal(fromRow.find((p) => p.key === 'tradeTo').changed, false)
  assert.deepEqual(fromRow.filter((p) => p.key.startsWith('opt')).map((p) => [p.key, p.value]), [['optLeg', 'BUY'], ['optMoneyness', '1 OTM'], ['optExit', 'with the index trade, capped at a Max SL'], ['optSl', '30%']])
  const fromFilters = settingParams(srv.config.filtersByIndex.NIFTY.absorption, 'filters')
  assert.deepEqual(fromFilters.filter((p) => p.key.startsWith('opt')).map((p) => [p.key, p.value]), [['optLeg', 'BUY'], ['optMoneyness', '1 OTM'], ['optSl', '30%']])
})

test('a strategy applied to an index with its own lot size: set, kept by a later apply, changed in place, back to the index\'s', async () => {
  const { saveIndexLots } = await import('../src/scannerSettings.js')
  const { lotsFor, strategyFilters } = await import('../src/strategyEngine.js')
  store.clear()
  const srv = fakeServer()
  await applyTunedFilters('absorption', niftyBest, { option: true, index: 'NIFTY', lots: 4 })
  assert.equal(srv.config.filtersByIndex.NIFTY.absorption._lots, 4)
  assert.equal(lotsFor('absorption', srv.config.filtersByIndex.NIFTY, 2), 4, 'its own lots')
  assert.equal(lotsFor('other', srv.config.filtersByIndex.NIFTY, 2), 2, 'any other strategy: the index\'s')
  assert.equal(strategyFilters('absorption', srv.config.filtersByIndex.NIFTY.absorption)._lots, undefined, 'never a filter the scanner reads')
  // Another setting applied without saying: the lot size stays.
  await applyTunedFilters('absorption', bankBest, { option: true, index: 'NIFTY' })
  assert.equal(srv.config.filtersByIndex.NIFTY.absorption._lots, 4)
  assert.equal(srv.config.filtersByIndex.NIFTY.absorption.tradeSide, 'short')
  // Changed in place (Applied now), keeping the setting; then back to the index's lots.
  await saveIndexLots('NIFTY', 'absorption', 7)
  assert.equal(srv.config.filtersByIndex.NIFTY.absorption._lots, 7)
  assert.equal(srv.config.filtersByIndex.NIFTY.absorption.tradeSide, 'short')
  await saveIndexLots('NIFTY', 'absorption', null)
  assert.equal(srv.config.filtersByIndex.NIFTY.absorption._lots, undefined)
  // Out of range is not stored (Trade settings' own 1 - 500).
  await applyTunedFilters('absorption', niftyBest, { option: true, index: 'NIFTY', lots: 900 })
  assert.equal(srv.config.filtersByIndex.NIFTY.absorption._lots, undefined)
  assert.equal(lotsFor('x', { x: { _lots: 2.5 } }, 3), 3, 'whole lots only')
})

test('without an index (older callers): the all-index filters, as before', async () => {
  store.clear()
  const srv = fakeServer()
  await applyTunedFilters('absorption', bankBest, { option: true })
  assert.equal(srv.config.settings.filters.absorption.tradeSide, 'short')
  assert.equal(srv.config.filtersByIndex, undefined)
})
