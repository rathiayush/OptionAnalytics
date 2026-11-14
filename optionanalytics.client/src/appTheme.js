// The app's antd theme (main.jsx's ConfigProvider - every page, and every popup / dropdown portalled from one; a page's own
// nested ConfigProvider, OI Replay's COMPACT_TEXT_THEME, merges into it per component).
//
// WHATEVER IS SELECTED IS BLUE (asked for - "whatever is selected show them blue, it looks confusing on the UI; check all
// pages"): the dark algorithm marks a Segmented's pick (NIFTY / BANKNIFTY / SENSEX, Paper / Live, Buy / Sell, CE / PE, ITM /
// ATM / OTM, the timeframes, the signs...) with a grey a shade lighter than the rest - which one was picked could not be
// told at a glance - and the dropdowns' picked option and the menu's page with a near-black navy. All three now take the
// primary blue the checkboxes, switches and primary buttons already use, with white text.

import { theme } from 'antd'

/** antd's dark primary - the checkboxes', switches' and primary buttons' blue. */
export const SELECTED_BG = '#1668dc'
/** The dropdowns' picked option: a deeper blue of the same hue, so an option's own coloured label (CE green / PE red) still reads. */
export const SELECTED_OPTION_BG = '#1554ad'
export const SELECTED_TEXT = '#ffffff'

export const APP_THEME = {
  algorithm: theme.darkAlgorithm,
  token: { colorBgContainer: '#15161c', colorBgLayout: '#0d0e12' },
  components: {
    Segmented: { itemSelectedBg: SELECTED_BG, itemSelectedColor: SELECTED_TEXT },
    Select: { optionSelectedBg: SELECTED_OPTION_BG, optionSelectedColor: SELECTED_TEXT },
    Menu: { itemSelectedBg: SELECTED_BG, itemSelectedColor: SELECTED_TEXT, subMenuItemSelectedColor: SELECTED_TEXT },
  },
}
