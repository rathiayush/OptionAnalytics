// The per-index trade settings kept on the server (trade-settings.csv) and copied into the browser
// (tradeDefaults.js). Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { lotSizeOf, runnerSettingsOf } from '../src/scannerCore.js'

const store = new Map()
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) }
const calls = []
let serverRows = [
  { underlying: 'NIFTY', lots: 4, slPoints: 15, targetPoints: 25, trailStart: 10, trailGap: 5, slippagePoints: 1.5, scannerEnabled: false, autoTrade: 'buy' },
  { underlying: 'BANKNIFTY', lots: 1, slPoints: 50, targetPoints: 75, trailStart: 0, trailGap: 0, slippagePoints: 2, scannerEnabled: true, autoTrade: 'sell' },
]
globalThis.fetch = async (url, opts = {}) => {
  calls.push({ url, ...opts })
  if (url === '/api/trade-settings' && !opts.method) return { ok: true, json: async () => ({ settings: serverRows }) }
  return { ok: true, json: async () => ({}) }
}
const { refreshTradeSettings, loadTradeDefaults, loadTradeLevels, saveTradeDefaults, defaultTradeLevels } = await import('../src/tradeDefaults.js')

test('the server\'s settings become every page\'s defaults', async () => {
  // Before: the built-in defaults - the trader's own Trade settings (4 lots, SL 30 / target 40, Max SL 50, no max target).
  const before = loadTradeDefaults('NIFTY')
  assert.deepEqual([before.lots, before.sl, before.target, before.maxSl, before.maxTarget, before.slippage, before.autoTrade], [4, 30, 40, 50, 0, 2, 'sell'])
  assert.deepEqual(['BANKNIFTY', 'SENSEX'].map((u) => { const x = loadTradeDefaults(u); return [x.lots, x.sl, x.target, x.maxSl, x.maxTarget] }), [[3, 50, 75, 80, 0], [3, 60, 90, 120, 0]])
  await refreshTradeSettings()
  const n = loadTradeDefaults('NIFTY')
  assert.deepEqual({ lots: n.lots, sl: n.sl, target: n.target, trailStart: n.trailStart, trailGap: n.trailGap, slippage: n.slippage, scannerEnabled: n.scannerEnabled, autoTrade: n.autoTrade },
    { lots: 4, sl: 15, target: 25, trailStart: 10, trailGap: 5, slippage: 1.5, scannerEnabled: false, autoTrade: 'buy' })
  assert.deepEqual(loadTradeLevels('scanner', 'NIFTY'), { sl: 15, target: 25, trailStart: 10, trailGap: 5 })
  assert.equal(loadTradeDefaults('SENSEX').sl, defaultTradeLevels('SENSEX').sl, 'an index the server did not send keeps its defaults')
})

test('a change is saved on the server as the whole row, once the typing stops', async () => {
  saveTradeDefaults('NIFTY', { lots: 6 })
  saveTradeDefaults('NIFTY', { lots: 7 })
  assert.equal(loadTradeDefaults('NIFTY').lots, 7, 'the browser has it at once')
  await new Promise((r) => setTimeout(r, 900))
  const puts = calls.filter((c) => c.method === 'PUT')
  assert.equal(puts.length, 1, 'one save for the burst')
  assert.equal(puts[0].url, '/api/trade-settings/NIFTY')
  // The strategies' max rules go with it: until they are set, the SL / target. So does the contract's lot size -
  // the exchange's default for the index until it is set.
  assert.deepEqual(JSON.parse(puts[0].body), { underlying: 'NIFTY', lots: 7, lotSizeValue: 65, slPoints: 15, targetPoints: 25, trailStart: 10, trailGap: 5, slippagePoints: 1.5, scannerEnabled: false, autoTrade: 'buy', maxSlPoints: 15, maxTargetPoints: 25 })
  saveTradeDefaults('NIFTY', { maxSl: 40, maxTarget: 0 })
  await new Promise((r) => setTimeout(r, 900))
  const last = JSON.parse(calls.filter((c) => c.method === 'PUT').at(-1).body)
  assert.deepEqual([last.maxSlPoints, last.maxTargetPoints, last.slPoints], [40, 0, 15], 'set apart from the manual SL / target; 0 = no max')
})

test('the lot size per index: the exchange default until it is set, and it sizes the paper trades', () => {
  // The default when nothing is saved, and what a saved one does.
  assert.equal(lotSizeOf(null, 'NIFTY'), 65)
  assert.equal(lotSizeOf({}, 'BANKNIFTY'), 30)
  assert.equal(lotSizeOf({ trade: {} }, 'SENSEX'), 20)
  assert.equal(lotSizeOf({ trade: { NIFTY: { lotSize: 75 } } }, 'NIFTY'), 75, 'the exchange changed it and it was set')
  assert.equal(lotSizeOf({ trade: { NIFTY: { lotSize: 0 } } }, 'NIFTY'), 65, 'a 0 is not a lot size')
  // The server scanner sizes its paper trades by it (runnerSettingsOf -> paperLotSize).
  assert.equal(runnerSettingsOf({ trade: { NIFTY: { lots: 2, lotSize: 75 } } }, 'NIFTY').paperLotSize, 75)
  assert.equal(runnerSettingsOf({}, 'BANKNIFTY').paperLotSize, 30, 'none set: the exchange default')
})
