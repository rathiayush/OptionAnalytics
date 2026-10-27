// The OI Replay quick views (quickViews.js): Ctrl + Shift + 1 - 6 (top row or numpad) open the six popups; anything
// else - Ctrl alone (the browser's tab keys), Alt, Cmd, other keys - opens nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { QUICK_VIEWS, quickViewForKey } from '../src/quickViews.js'

const key = (code, mods = {}) => ({ code, ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, ...mods })

test('Ctrl + Shift + 1 - 6 open the six quick views in order', () => {
  assert.deepEqual(QUICK_VIEWS.map((v) => v.key), ['dayOi', 'oiCharts', 'oiHeatmap', 'premium', 'straddle', 'gex'])
  for (const v of QUICK_VIEWS) {
    assert.equal(quickViewForKey(key(`Digit${v.digit}`)).key, v.key)
    assert.equal(quickViewForKey(key(`Numpad${v.digit}`)).key, v.key)
  }
})

test('nothing else opens one', () => {
  assert.equal(quickViewForKey(key('Digit1', { shiftKey: false })), null)   // Ctrl + 1: the browser's first tab
  assert.equal(quickViewForKey(key('Digit1', { ctrlKey: false })), null)
  assert.equal(quickViewForKey(key('Digit1', { altKey: true })), null)
  assert.equal(quickViewForKey(key('Digit1', { metaKey: true })), null)
  assert.equal(quickViewForKey(key('Digit7')), null)
  assert.equal(quickViewForKey(key('KeyB')), null)
})
