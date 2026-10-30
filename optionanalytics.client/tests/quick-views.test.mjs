// The OI Replay quick views (quickViews.js): Z X C V B N M alone open the seven popups (the old Ctrl + Shift + 1 - 7, top
// row or numpad, too); anything else - a letter with Ctrl / Alt / Cmd / Shift (copy, paste, the browser's keys), a letter
// typed in a box, a key held down (repeat), another letter - opens nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FAB_GAP, FAB_ITEM_SIZE, FAB_SIZE, QUICK_VIEWS, fabDefault, fabOpensUp, isFabDrag, isTypingField, placeFab, quickViewForKey } from '../src/quickViews.js'

const key = (code, mods = {}) => ({ code, ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, ...mods })

const plain = (code, mods = {}) => ({ code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods })

test('Z X C V B N M alone open the seven quick views: Day OI, OI charts, GEX, straddle, futures, OI heatmap, premium', () => {
  assert.deepEqual(QUICK_VIEWS.map((v) => [v.letter, v.key]), [
    ['Z', 'dayOi'], ['X', 'oiCharts'], ['C', 'gex'], ['V', 'straddle'], ['B', 'futures'], ['N', 'oiHeatmap'], ['M', 'premium'],
  ])
  for (const v of QUICK_VIEWS) assert.equal(quickViewForKey(plain(`Key${v.letter}`)).key, v.key)
  // Not from a box being typed in; a checkbox or a switch holding the focus is fine.
  assert.equal(quickViewForKey(plain('KeyZ', { target: { tagName: 'INPUT', type: 'text' } })), null)
  assert.equal(quickViewForKey(plain('KeyZ', { target: { tagName: 'TEXTAREA' } })), null)
  assert.equal(quickViewForKey(plain('KeyZ', { target: { tagName: 'INPUT', type: 'checkbox' } })).key, 'dayOi')
})

test('the old Ctrl + Shift + 1 - 7 still open the same views', () => {
  assert.deepEqual(QUICK_VIEWS.map((v) => v.digit).sort(), [1, 2, 3, 4, 5, 6, 7])
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
  // A letter with Ctrl (copy / paste / undo, the browser's new window), Alt, Shift or Cmd; held down; another letter; S
  // (the order ticket's sell).
  assert.equal(quickViewForKey(plain('KeyC', { ctrlKey: true })), null)
  assert.equal(quickViewForKey(plain('KeyV', { ctrlKey: true })), null)
  assert.equal(quickViewForKey(plain('KeyN', { ctrlKey: true })), null)
  assert.equal(quickViewForKey(plain('KeyZ', { altKey: true })), null)
  assert.equal(quickViewForKey(plain('KeyZ', { shiftKey: true })), null)
  assert.equal(quickViewForKey(plain('KeyZ', { metaKey: true })), null)
  assert.equal(quickViewForKey(plain('KeyZ', { repeat: true })), null)
  assert.equal(quickViewForKey(plain('KeyQ')), null)
  assert.equal(quickViewForKey(plain('KeyS')), null)
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
