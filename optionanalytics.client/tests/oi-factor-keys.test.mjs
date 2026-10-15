// The OI inputs the Strategy tuning page offers (strategyTuning.js OI_FACTORS) and the ones the server will accept
// (StrategyTuningController.OiFactorKeys) are two lists of the same thing, in two languages. When they drift the page
// looks fine and every Futures + OI run is refused before it starts - which is what happened when the five order-flow
// inputs (tape, big orders, order book, delta, volume) were added to the page and not to the server: Spot + options
// still ran (it leaves those out) and Futures + OI could not.
// Run: npm test (node --test) - see CLAUDE.md.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OI_FACTORS, oiFactorsFor } from '../src/strategyTuning.js'

const CONTROLLER = join(import.meta.dirname, '..', '..', 'OptionAnalytics.Server', 'Controllers', 'StrategyTuningController.cs')

/** The keys inside the server's `OiFactorKeys` set. */
function serverKeys() {
  const src = readFileSync(CONTROLLER, 'utf8')
  const at = src.indexOf('OiFactorKeys = new()')
  assert.ok(at > 0, 'OiFactorKeys is still declared that way in StrategyTuningController.cs')
  const body = src.slice(at, src.indexOf('};', at))
  return [...body.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1])
}

test('every OI input the page offers is one the server accepts', () => {
  const page = OI_FACTORS.map((f) => f.key)
  const server = serverKeys()
  assert.deepEqual([...page].sort(), [...server].sort(),
    `the page offers ${page.length} OI inputs and the server accepts ${server.length} - a Futures + OI run is refused for any the server does not know`)
})

test('a Futures + OI run sends every input, so none of them may be missing server-side', () => {
  // Spot + options leaves the futures and order-flow ones out, which is why it kept working while futures did not.
  const futures = oiFactorsFor('futures').map((f) => f.key)
  const spot = oiFactorsFor('spot').map((f) => f.key)
  const server = new Set(serverKeys())
  assert.equal(futures.length, OI_FACTORS.length, 'Futures + OI offers them all')
  assert.ok(futures.every((k) => server.has(k)), `the server refuses: ${futures.filter((k) => !server.has(k)).join(', ')}`)
  assert.ok(spot.every((k) => server.has(k)))
  assert.ok(spot.length < futures.length, 'and Spot + options is the smaller set')
})
