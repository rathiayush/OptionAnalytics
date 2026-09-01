import { Menu, Tag } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'

// Constants/components shared between App.jsx's DashboardPage and BacktestPage.jsx - kept in
// their own module (not exported from App.jsx) specifically to avoid a circular import: App.jsx
// imports BacktestPage for its route, so BacktestPage importing back from App.jsx creates a cycle
// that breaks under Vite's dev-time ESM evaluation order ("Cannot access 'X' before
// initialization"), even though a production build happens to paper over it.

export const UP_COLOR = '#26a69a'
export const DOWN_COLOR = '#ef5350'
export const CE_COLOR = '#3ddc84'
export const PE_COLOR = '#ff5c5c'

export const ALERT_KIND_LABEL = { Spot: 'Spot', AtmCe: 'ATM CE', AtmPe: 'ATM PE', Confluence: 'CONFLUENCE' }

export function fmtPrice(v) {
  return v == null ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })
}

// Every plain-text timestamp on the page (alert feed entries, Backtrack's tables) renders in IST
// (India, fixed UTC+5:30 - the market this app is about) regardless of the viewer's own browser
// timezone, same reasoning as App.jsx's chart-axis IST formatters - just via Intl's timeZone
// option directly here, since there's no lightweight-charts day-bucketing to work around for
// plain text.
export function fmtIstDateTime(isoOrDate) {
  return new Date(isoOrDate).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true })
}

export function fmtIstTime(isoOrDate) {
  return new Date(isoOrDate).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true })
}

export function DirectionTag({ direction }) {
  if (!direction) return <Tag>—</Tag>
  return <Tag color={direction === 'Bullish' ? UP_COLOR : DOWN_COLOR}>{direction === 'Bullish' ? '▲ Bullish' : '▼ Bearish'}</Tag>
}

const NAV_ITEMS = [
  { key: '/', label: 'Dashboard' },
  { key: '/backtest', label: 'Backtrack' },
  { key: '/triggers', label: 'Triggers' },
]

// Shared between DashboardPage and BacktestPage - a proper horizontal menu (not just plain text
// links) so it reads as real site navigation, sitting inline in each page's own header row with a
// transparent background so it blends into the page rather than looking like a separate bar.
export function NavBar() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <Menu
      mode="horizontal"
      theme="dark"
      selectedKeys={[location.pathname]}
      items={NAV_ITEMS}
      onClick={({ key }) => navigate(key)}
      style={{ minWidth: 340, background: 'transparent', borderBottom: 'none', lineHeight: '32px' }}
    />
  )
}
