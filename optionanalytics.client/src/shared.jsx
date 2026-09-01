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

export function DirectionTag({ direction }) {
  if (!direction) return <Tag>—</Tag>
  return <Tag color={direction === 'Bullish' ? UP_COLOR : DOWN_COLOR}>{direction === 'Bullish' ? '▲ Bullish' : '▼ Bearish'}</Tag>
}

const NAV_ITEMS = [
  { key: '/', label: 'Dashboard' },
  { key: '/backtest', label: 'Backtrack' },
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
      style={{ minWidth: 260, background: 'transparent', borderBottom: 'none', lineHeight: '32px' }}
    />
  )
}
