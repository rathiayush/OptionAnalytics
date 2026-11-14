import test from 'node:test'
import assert from 'node:assert/strict'
import { theme } from 'antd'
import { APP_THEME, SELECTED_BG, SELECTED_OPTION_BG, SELECTED_TEXT } from '../src/appTheme.js'

// Asked for - "whatever is selected show them blue, it looks confusing on the UI; check all pages": the app's ONE antd theme
// (main.jsx) gives every picker's selected item the primary blue with white text - antd's dark theme marked it with a grey a
// shade lighter than the rest.

const BLUE = /^#1[56][0-9a-f]{4}$/i

test('the selected item of every Segmented picker, dropdown and the menu is blue with white text', () => {
  const c = APP_THEME.components
  assert.equal(c.Segmented.itemSelectedBg, SELECTED_BG)
  assert.equal(c.Segmented.itemSelectedColor, SELECTED_TEXT)
  assert.equal(c.Select.optionSelectedBg, SELECTED_OPTION_BG)
  assert.equal(c.Select.optionSelectedColor, SELECTED_TEXT)
  assert.equal(c.Menu.itemSelectedBg, SELECTED_BG)
  assert.equal(c.Menu.itemSelectedColor, SELECTED_TEXT)
  for (const colour of [SELECTED_BG, SELECTED_OPTION_BG]) assert.match(colour, BLUE)
  assert.equal(SELECTED_TEXT.toLowerCase(), '#ffffff')
})

test('the blue is the dark theme\'s own primary - the checkboxes\', switches\' and primary buttons\' - and the page stays dark', () => {
  assert.equal(APP_THEME.algorithm, theme.darkAlgorithm)
  const dark = theme.getDesignToken({ algorithm: theme.darkAlgorithm })
  assert.equal(SELECTED_BG.toLowerCase(), dark.colorPrimary.toLowerCase())
  assert.equal(APP_THEME.token.colorBgContainer, '#15161c')
  assert.equal(APP_THEME.token.colorBgLayout, '#0d0e12')
})
