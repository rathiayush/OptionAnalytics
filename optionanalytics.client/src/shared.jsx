import { Space, Tag } from 'antd'
import { NavLink } from 'react-router-dom'

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

// Shared between DashboardPage and BacktestPage - just two links, styled to blend into each
// page's own header Space rather than looking like a separate site-wide bar.
export function NavBar() {
  const linkStyle = ({ isActive }) => ({ color: isActive ? '#fff' : '#9aa4b2', fontWeight: isActive ? 600 : 400 })
  return (
    <Space size={16}>
      <NavLink to="/" style={linkStyle}>Dashboard</NavLink>
      <NavLink to="/backtest" style={linkStyle}>Backtrack</NavLink>
    </Space>
  )
}
