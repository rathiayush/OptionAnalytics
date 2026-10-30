// The OI Replay quick views (quickViews.js): Ctrl + Shift + 1 - 7 (top row or numpad) open the seven popups; anything
// else - Ctrl alone (the browser's tab keys), Alt, Cmd, other keys - opens nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FAB_GAP, FAB_ITEM_SIZE, FAB_SIZE, QUICK_VIEWS, fabDefault, fabOpensUp, isFabDrag, isTypingField, placeFab, quickViewForKey } from '../src/quickViews.js'

const key = (code, mods = {}) => ({ code, ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, ...mods })

test('Ctrl + Shift + 1 - 7 open the seven quick views in order', () => {
  assert.deepEqual(QUICK_VIEWS.map((v) => v.key), ['dayOi', 'oiCharts', 'oiHeatmap', 'premium', 'straddle', 'gex', 'futures'])
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
  assert.equal(quickViewForKey(key('Digit8')), null)
  assert.equal(quickViewForKey(key('KeyB')), null)
})

// The phone's floating quick-view button: dragged anywhere but always kept on the screen; a small move is still a tap.
test('the floating button stays on the screen, starts bottom right, and opens its icons where they fit', () => {
  const phone = { width: 390, height: 800 }
  assert.deepEqual(placeFab(fabDefault(phone), phone), { x: 390 - FAB_SIZE - 16, y: 800 - FAB_SIZE - 96 })
  assert.deepEqual(placeFab({ x: -50, y: 5000 }, phone), { x: 8, y: 800 - FAB_SIZE - 8 })
  assert.deepEqual(placeFab({ x: 900, y: -3 }, phone), { x: 390 - FAB_SIZE - 8, y: 8 })
  // Saved on a wide screen, opened on a phone: pulled back in.
  assert.deepEqual(placeFab({ x: 1300, y: 700 }, phone), { x: 390 - FAB_SIZE - 8, y: 700 })
  assert.deepEqual(placeFab(null, phone), { x: 390 - FAB_SIZE - 8, y: 800 - FAB_SIZE - 8 })
  // A press that moved under 6 px is a tap; 6 px or more a drag.
  assert.equal(isFabDrag(3, 4), false)
  assert.equal(isFabDrag(0, 6), true)
  // Seven icons need 7 x (34 + 8) px: up from low on the screen, down from near the top.
  const need = QUICK_VIEWS.length * (FAB_ITEM_SIZE + FAB_GAP)
  assert.equal(fabOpensUp({ x: 300, y: 664 }, QUICK_VIEWS.length, phone), true)
  assert.equal(fabOpensUp({ x: 300, y: 40 }, QUICK_VIEWS.length, phone), false)
  assert.equal(fabOpensUp({ x: 300, y: need }, QUICK_VIEWS.length, phone), true)
})

test('the B / S ticket keys are kept from a box you type in - not from a checkbox, toggle or dropdown holding the focus', () => {
  const input = (type, readOnly = false) => ({ tagName: 'INPUT', type, readOnly })
  // Typing: a text / number box, the date picker, a search or tags dropdown, a text area, an editable element.
  for (const el of [input('text'), input('number'), input('search'), { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }]) {
    assert.equal(isTypingField(el), true, JSON.stringify(el))
  }
  // Not typing: a ticked checkbox (VWAP), antd's Segmented (a radio), a plain dropdown (read-only input), a switch / button.
  for (const el of [input('checkbox'), input('radio'), input('text', true), { tagName: 'BUTTON' }, { tagName: 'DIV' }, null]) {
    assert.equal(isTypingField(el), false, JSON.stringify(el))
  }
})
