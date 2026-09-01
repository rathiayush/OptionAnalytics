import { useEffect, useState } from 'react'
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

// One list for every page, so a timeframe stored by one is always a valid choice on the others.
// Everything server-side stays at 1-minute resolution; coarser ones are aggregated from it.
export const TIMEFRAME_OPTIONS = [
  { value: 1, label: '1 min' },
  { value: 3, label: '3 min' },
  { value: 5, label: '5 min' },
  { value: 15, label: '15 min' },
]

// The underlying and the timeframe describe WHAT you are looking at rather than being a per-page
// setting, so picking either one should hold wherever you navigate next - and across a reload.
// Both live under these keys, and every page reads and writes the same two.
export const STORED_UNDERLYING = 'optionanalytics.underlying'
export const STORED_TIMEFRAME = 'optionanalytics.timeframe'

function readStored(key, fallback) {
  try {
    const raw = window.localStorage.getItem(key)
    return raw === null ? fallback : JSON.parse(raw)
  } catch {
    // Storage can throw outright (private browsing, blocked site data) - the app still works,
    // it just doesn't remember.
    return fallback
  }
}

export function usePersistedState(key, fallback) {
  const [value, setValue] = useState(() => readStored(key, fallback))

  useEffect(() => {
    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Same as above - remembering is a convenience, never a requirement.
    }
  }, [key, value])

  return [value, setValue]
}

// Keeps a stored underlying only if the backend still offers it, otherwise falls back to the
// first one - so a stale or renamed symbol can't leave a page stuck on nothing.
export function pickUnderlying(list, current) {
  if (list?.some((u) => u.underlying === current)) return current
  return list?.[0]?.underlying ?? null
}

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
