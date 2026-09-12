import { createContext, useContext, useEffect, useState } from 'react'
import { Button, Menu, Select, Space, Tag, Typography } from 'antd'
import { useLocation, useNavigate } from 'react-router-dom'
import { TickMarkType } from 'lightweight-charts'

// Provided once, at the app root (App.jsx), after GET /api/auth/me resolves - {email, role} or
// null. NavBar (rendered independently from four different pages) reads this via useAuth() rather
// than each page threading it through as a prop.
export const AuthContext = createContext(null)
export function useAuth() {
  return useContext(AuthContext)
}

// Path keys from NAV_ITEMS below that only an Admin account may see or use - Triggers arms real
// money, Contracts exposes the raw scrip-master/subscription diagnostic. Kept as one list so
// NavBar's own filtering and App.jsx's route guards can never drift apart on which paths these are.
export const ADMIN_ONLY_PATHS = ['/triggers', '/contracts']

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

// Which expiry a PAGE is looking at. The app now tracks several expiries at once per underlying
// (NIFTY's nearest 3, BANKNIFTY's nearest 2 - see CdvHostedService), each with its own live state,
// so this is a per-page read: the page appends ?expiry= to its own requests and nothing about that
// choice reaches any other page, or any armed trigger. It used to POST a server-side switch that
// unsubscribed and rebuilt everything, which is why changing expiry used to blank all three pages
// for a minute or two.
//
// `expiries` is the TRACKED set, not every listed one - those are the expiries with live data
// behind them. `selectedExpiry` is what to display; `expiryParam` is what to put in a URL, and is
// null while the page is following the server's own selection (so the request stays identical to
// what it was before this existed).
export function useExpirySelector(underlying) {
  const [expiries, setExpiries] = useState([])
  const [defaultExpiry, setDefaultExpiry] = useState(null)
  const [pinned, setPinned] = useState(null)

  useEffect(() => {
    if (!underlying) return
    const cancelledRef = { cancelled: false }
    fetch(`/api/cdv/${underlying}/expiries`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelledRef.cancelled) return
        setExpiries(data?.expiries ?? [])
        setDefaultExpiry(data?.selected ?? null)
        // A pin from a previous underlying cannot survive the switch - the new underlying tracks a
        // different set of expiries entirely.
        setPinned((current) => ((data?.expiries ?? []).includes(current) ? current : null))
      })
      .catch((err) => console.error('Failed to load expiries:', err))
    return () => { cancelledRef.cancelled = true }
  }, [underlying])

  // Local only, and resolved so callers that refetch in a .then() keep working unchanged.
  const selectExpiry = (expiry) => {
    if (expiry !== undefined) setPinned(expiry ?? null)
    return Promise.resolve()
  }

  return {
    expiries,
    selectedExpiry: pinned ?? defaultExpiry,
    expiryParam: pinned,
    isManual: pinned !== null,
    loading: false,
    selectExpiry,
  }
}

// Appends ?expiry= to a request when the page has pinned one. Null/undefined leaves the URL
// untouched, so a page following the server's own selection sends exactly the request it always
// did.
export function withExpiry(url, expiry) {
  if (!expiry) return url
  return `${url}${url.includes('?') ? '&' : '?'}expiry=${encodeURIComponent(expiry)}`
}

// Sentinel antd Select value for "Auto (nearest)" - real expiries are ISO date strings, so this
// can never collide with one.
const AUTO_EXPIRY = '__auto__'

export function ExpirySelect({ expiries, value, isManual, loading, onChange, style }) {
  const options = [
    { value: AUTO_EXPIRY, label: 'Auto (nearest)' },
    ...(expiries ?? []).map((e) => ({ value: e, label: e })),
  ]
  return (
    <Select
      value={isManual ? value : AUTO_EXPIRY}
      loading={loading}
      onChange={(picked) => onChange(picked === AUTO_EXPIRY ? null : picked)}
      style={style ?? { width: 170 }}
      options={options}
    />
  )
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

// The IST calendar day a UTC timestamp falls on, as 'YYYY-MM-DD'. Sortable and directly
// comparable to what antd's date pickers format to, which is what makes a date filter possible
// without pulling timezone maths into every page: 'en-CA' is the locale that renders a date in
// exactly that order. A signal at 20:00 UTC belongs to the NEXT IST day, so filtering on the raw
// UTC date would put it under the wrong session.
export function istDateKey(isoOrDate) {
  return new Date(isoOrDate).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

export function fmtIstTime(isoOrDate) {
  return new Date(isoOrDate).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true })
}

// lightweight-charts styling/time-axis helpers, duplicated (not imported) from App.jsx's own
// private copies rather than having App.jsx import them from here - App.jsx's charting code is
// heavily tuned (cross-chart pan/zoom sync, EMA overlays, live-tick preservation of the visible
// range) and any of it is deliberately left untouched by pages that don't need that complexity.
// These are the small, stable, PURE pieces any simple read-only chart (StrikeDataPage's own) needs
// without the rest: lightweight-charts has no timezone support, so every timestamp fed to a chart
// is shifted forward by IST_OFFSET_SECONDS up front and then formatted AS IF it were UTC - which,
// because of the shift, is exactly its real IST wall-clock value. See App.jsx's own identical
// comment for the full reasoning; it is not repeated there to avoid the two drifting apart on
// wording while staying identical in behavior (the offset is fixed and will never change).
export const AXIS_COLOR = '#9aa4b2'
export const GRID_COLOR = '#ffffff14'
export const BORDER_COLOR = '#ffffff22'
export const RESET_MARKER_COLOR = '#ffd54f'

const IST_OFFSET_SECONDS = 5.5 * 3600

export function toChartTime(isoOrDate) {
  return Math.floor(new Date(isoOrDate).getTime() / 1000) + IST_OFFSET_SECONDS
}

const IST_TIME_FORMAT = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'UTC' })
const IST_TICK_DATE_FORMAT = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })

export function istTimeFormatter(time) {
  return IST_TIME_FORMAT.format(new Date(time * 1000))
}

export function istTickMarkFormatter(time, tickMarkType) {
  const date = new Date(time * 1000)
  return tickMarkType >= TickMarkType.Time ? IST_TIME_FORMAT.format(date) : IST_TICK_DATE_FORMAT.format(date)
}

export function toBar(c) {
  return { time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close }
}

// Chart times are already IST-shifted (see IST_OFFSET_SECONDS), so reading the shifted value AS
// UTC gives the IST calendar day directly - the chart-time counterpart to istDateKey above, which
// takes a plain ISO string instead.
function istDayKeyFromChartTime(chartTime) {
  return new Date(chartTime * 1000).toISOString().slice(0, 10)
}

// A "RESET" marker on the first bar of each new IST trading day, so a chart spanning several days
// reads as distinct sessions rather than one continuous, misleadingly smooth line/candle run
// straight through each overnight gap. The very first day in view gets no marker - there is no
// transition to see there, just the left edge of the loaded history.
export function dayResetMarkers(bars) {
  const markers = []
  let previousDay = null

  for (const bar of bars) {
    const day = istDayKeyFromChartTime(bar.time)
    if (previousDay !== null && day !== previousDay) {
      markers.push({ time: bar.time, position: 'aboveBar', color: RESET_MARKER_COLOR, shape: 'square', text: 'RESET' })
    }
    previousDay = day
  }
  return markers
}

export function DirectionTag({ direction }) {
  if (!direction) return <Tag>—</Tag>
  return <Tag color={direction === 'Bullish' ? UP_COLOR : DOWN_COLOR}>{direction === 'Bullish' ? '▲ Bullish' : '▼ Bearish'}</Tag>
}

const NAV_ITEMS = [
  { key: '/', label: 'Dashboard' },
  { key: '/backtest', label: 'Backtrack' },
  { key: '/strike-data', label: 'Strike Data' },
  { key: '/expired-options', label: 'Expired Options' },
  { key: '/triggers', label: 'Triggers' },
  { key: '/contracts', label: 'Contracts' },
]

// Shared between DashboardPage/BacktestPage/TriggersPage/ContractsPage - a proper horizontal menu
// (not just plain text links) so it reads as real site navigation, sitting inline in each page's
// own header row with a transparent background so it blends into the page rather than looking
// like a separate bar. Also carries the signed-in email and a log-out button - the one place
// that's shown regardless of which page rendered this.
//
// Triggers/Contracts are hidden here for a non-Admin account, but that is a convenience, not the
// actual security boundary - App.jsx's own route guard covers someone typing the URL directly, and
// the real enforcement is server-side (TriggersController/CdvController's [Authorize(Roles =
// "Admin")]), since hiding a link never stops a direct API call.
export function NavBar() {
  const location = useLocation()
  const navigate = useNavigate()
  const auth = useAuth()
  const isAdmin = auth?.user?.role === 'Admin'
  const items = isAdmin ? NAV_ITEMS : NAV_ITEMS.filter((item) => !ADMIN_ONLY_PATHS.includes(item.key))

  return (
    <Space align="center" size={16} wrap>
      <Menu
        mode="horizontal"
        theme="dark"
        selectedKeys={[location.pathname]}
        items={items}
        onClick={({ key }) => navigate(key)}
        style={{ minWidth: 340, background: 'transparent', borderBottom: 'none', lineHeight: '32px' }}
      />
      {auth?.user && (
        <Space size={8}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{auth.user.email}</Typography.Text>
          <Button size="small" onClick={auth.logout}>Log out</Button>
        </Space>
      )}
    </Space>
  )
}
