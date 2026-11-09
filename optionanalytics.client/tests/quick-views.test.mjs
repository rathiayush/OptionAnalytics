// The OI Replay quick views (quickViews.js): Z X C V B N M , . alone open the nine popups (the old Ctrl + Shift + 1 - 9, top
// row or numpad, too); anything else - a letter with Ctrl / Alt / Cmd / Shift (copy, paste, the browser's keys), a letter
// typed in a box, a key held down (repeat), another letter - opens nothing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FAB_EDGE, FAB_GAP, FAB_ITEM_SIZE, FAB_SIZE, QUICK_VIEWS, fabAnchor, fabDefault, fabFromAnchor, fabInBarRow, fabOpensUp, isFabDrag, isTypingField, placeFab, quickViewForKey } from '../src/quickViews.js'

const key = (code, mods = {}) => ({ code, ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, ...mods })

const plain = (code, mods = {}) => ({ code, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods })

test('Z X C V B N M , . alone open the nine quick views: Day OI, OI charts, GEX, straddle, futures, OI heatmap, premium, the two delta profiles', () => {
  assert.deepEqual(QUICK_VIEWS.map((v) => [v.letter, v.key]), [
    ['Z', 'dayOi'], ['X', 'oiCharts'], ['C', 'gex'], ['V', 'straddle'], ['B', 'futures'], ['N', 'oiHeatmap'], ['M', 'premium'],
    [',', 'optionDelta'], ['.', 'futuresDelta'],
  ])
  for (const v of QUICK_VIEWS) assert.equal(quickViewForKey(plain(v.code ?? `Key${v.letter}`)).key, v.key)
  // The delta profiles: the comma and the full stop - not with Ctrl / Shift (Shift + . is ">"), not typed in a box.
  assert.equal(quickViewForKey(plain('Comma')).key, 'optionDelta')
  assert.equal(quickViewForKey(plain('Period')).key, 'futuresDelta')
  assert.equal(quickViewForKey(plain('Period', { shiftKey: true })), null)
  assert.equal(quickViewForKey(plain('Comma', { ctrlKey: true })), null)
  assert.equal(quickViewForKey(plain('Period', { target: { tagName: 'INPUT', type: 'number' } })), null)
  assert.equal(quickViewForKey(plain('Slash')), null)
  // Not from a box being typed in; a checkbox or a switch holding the focus is fine.
  assert.equal(quickViewForKey(plain('KeyZ', { target: { tagName: 'INPUT', type: 'text' } })), null)
  assert.equal(quickViewForKey(plain('KeyZ', { target: { tagName: 'TEXTAREA' } })), null)
  assert.equal(quickViewForKey(plain('KeyZ', { target: { tagName: 'INPUT', type: 'checkbox' } })).key, 'dayOi')
})

test('the old Ctrl + Shift + 1 - 9 still open the same views', () => {
  assert.deepEqual(QUICK_VIEWS.map((v) => v.digit).sort(), [1, 2, 3, 4, 5, 6, 7, 8, 9])
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
  assert.equal(quickViewForKey(key('Digit0')), null)
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
test('the floating button stays on the screen, starts bottom left, and opens its icons where they fit', () => {
  const phone = { width: 390, height: 800 }
  assert.deepEqual(placeFab(fabDefault(phone), phone), { x: 16, y: 800 - FAB_SIZE - 16 })
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

// Asked for: the button sat in the middle of a monitor's spot chart - its place was kept in pixels from the top left and
// is an account preference, so a spot picked on a phone (390 wide) landed mid-chart on a 1920 monitor. It starts at the
// bottom left of the PAGE (right of the sidebar) and is kept as its distance from the nearest corner.
test('the button starts at the bottom left of the page, right of the sidebar, and keeps its corner across screens', () => {
  const monitor = { width: 1920, height: 1080 }
  const phone = { width: 390, height: 800 }
  // Bottom left, right of a folded (64 px) or open (216 px) sidebar; never under it.
  assert.deepEqual(placeFab(fabDefault(monitor, 64), monitor, 64), { x: 64 + FAB_EDGE, y: 1080 - FAB_SIZE - FAB_EDGE })
  assert.deepEqual(placeFab(fabDefault(monitor, 216), monitor, 216), { x: 216 + FAB_EDGE, y: 1080 - FAB_SIZE - FAB_EDGE })
  assert.equal(placeFab({ x: 10, y: 500 }, monitor, 216).x, 216 + 8)
  // Dropped near the bottom left of a phone: the same corner, the same distance, on the monitor.
  const phoneSpot = { x: 30, y: 800 - FAB_SIZE - 120 }
  const anchor = fabAnchor(phoneSpot, phone, 0)
  assert.deepEqual(anchor, { h: 'left', dx: 30, v: 'bottom', dy: 120 })
  assert.deepEqual(fabFromAnchor(anchor, monitor, 64), { x: 64 + 30, y: 1080 - FAB_SIZE - 120 })
  // Near the top right of a monitor: the top right of a phone.
  const topRight = fabAnchor({ x: 1920 - FAB_SIZE - 50, y: 90 }, monitor, 64)
  assert.deepEqual(topRight, { h: 'right', dx: 50, v: 'top', dy: 90 })
  assert.deepEqual(fabFromAnchor(topRight, phone, 0), { x: 390 - FAB_SIZE - 50, y: 90 })
  // Far from every corner on a big screen: kept on a small one.
  const far = fabFromAnchor({ h: 'left', dx: 900, v: 'top', dy: 900 }, phone, 0)
  assert.deepEqual(far, { x: 390 - FAB_SIZE - 8, y: 800 - FAB_SIZE - 8 })
  // The old pixel place (no corner) and anything else is not read: the button starts at the bottom left again.
  for (const old of [null, { x: 330, y: 700 }, { h: 'middle', dx: 1, v: 'top', dy: 1 }, { h: 'left', dx: 'a', v: 'top', dy: 1 }]) {
    assert.equal(fabFromAnchor(old, monitor, 64), null, JSON.stringify(old))
  }
  // The replay bar starts right of the button only while the button is in its row at the bottom left.
  assert.equal(fabInBarRow(fabDefault(monitor, 64), monitor, 64), true)
  assert.equal(fabInBarRow(fabDefault(phone), phone, 0), true)
  assert.equal(fabInBarRow({ x: 64 + FAB_EDGE, y: 400 }, monitor, 64), false)
  assert.equal(fabInBarRow({ x: 1700, y: 1080 - FAB_SIZE - FAB_EDGE }, monitor, 64), false)
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
