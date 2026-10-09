import { useEffect, useMemo, useRef, useState } from 'react'
import { Space, Switch, Tag, Tooltip, Typography, notification } from 'antd'
import { UP_COLOR, DOWN_COLOR } from './shared.jsx'
import { chime, speak, telegram } from './alerts.js'
import { levelWhere, newProfileWatch, profileAlertText, profileLevels, spotLevelsOf, spotProfileLevels, watchProfiles } from './profileAlerts.js'

const { Text } = Typography
const SETTINGS_KEY = 'optionanalytics.orderFlow.profileAlerts.v1'
const SCANNER_SETTINGS_KEY = 'optionanalytics.strategyScanner.settings'
const STATUS_POLL_MS = 60_000

const readJson = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}

/** The previous day's spot volume profile (the server's - what the OI Replay charts draw) for `date`. */
export function usePreviousSpotProfile(underlying, date) {
  const [vp, setVp] = useState(null)
  useEffect(() => {
    if (!underlying || !date) return undefined
    let cancelled = false
    fetch(`/api/oi-replay/${underlying}/previous-day-volume-profile?date=${date}`)
      .then((r) => (r.ok ? r.json() : null)).then((body) => { if (!cancelled) setVp(body?.success ? body : null) })
      .catch(() => { if (!cancelled) setVp(null) })
    return () => { cancelled = true }
  }, [underlying, date])
  return vp
}

/** Whether the server scanner is sending this index's profile alerts to Telegram right now (then the page
 *  does not send them again - it only chimes, speaks and shows them). */
export function useServerProfileAlerts(underlying) {
  const [covers, setCovers] = useState({ futures: false, spot: false })
  useEffect(() => {
    let cancelled = false
    const load = () => fetch('/api/scanner-runner/status').then((r) => (r.ok ? r.json() : null)).then((s) => {
      if (cancelled || !s) return
      const running = s.process?.state === 'running' && !s.stale
      const ix = (s.status?.indices ?? []).find((i) => i.underlying === underlying)
      setCovers({ futures: !!(running && ix?.enabled && ix?.profileAlerts?.futures), spot: !!(running && ix?.enabled && ix?.profileAlerts?.spot) })
    }).catch(() => {})
    load()
    const id = setInterval(load, STATUS_POLL_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [underlying])
  return covers
}

/** Alerts when price reaches a level of the previous session's profiles, or enters one of their gaps -
 *  futures: its volume profile (POC / VAH / VAL / HVN, LVN gaps) and market profile (POC / VAH / VAL, LVN gaps,
 *  single prints), confluences flagged; spot: the previous day's spot volume and market profiles (`spotVp` -
 *  the lines on the OI Replay charts), else the futures levels less the premium. Futures and spot are separate
 *  switches (synced to the server scanner, which sends the same alerts to Telegram with no page open). Live
 *  only. Chime, spoken words and notification follow the scanner's Voice switch; Telegram is sent from here
 *  only when the server is not already sending it. */
export function useProfileAlerts({ underlying, vp, tpo, tpoRow, futuresPrice, spotPrice, basis, spotVp = null, live }) {
  const [on, setOn] = useState(() => ({ futures: true, spot: true, ...readJson(SETTINGS_KEY, {}) }))
  const change = (market, value) => setOn((prev) => {
    const next = { ...prev, [market]: value }
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)) } catch { /* convenience only */ }
    // The server scanner follows the same switches (an admin's change; others get 403 and keep their own).
    fetch('/api/scanner-runner/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ profileAlerts: next }) }).catch(() => {})
    return next
  })
  const serverCovers = useServerProfileAlerts(underlying)

  const futuresLevels = useMemo(() => profileLevels(vp, tpo, tpoRow), [vp, tpo, tpoRow])
  const spotOwn = useMemo(() => spotProfileLevels(spotVp, tpoRow), [spotVp, tpoRow])
  const spotLevels = useMemo(() => spotLevelsOf(futuresLevels, basis, spotOwn), [futuresLevels, basis, spotOwn])
  const watch = useRef(newProfileWatch())
  // A new underlying or a new set of levels starts from scratch: nothing is armed until price is away from a level.
  const resetKey = `${underlying}|${futuresLevels.map((l) => l.id).join(',')}|${spotOwn.map((l) => l.id).join(',')}`
  useEffect(() => { watch.current = newProfileWatch() }, [resetKey])

  useEffect(() => {
    if (!live) return
    const hits = watchProfiles(watch.current, { levels: { futures: futuresLevels, spot: spotLevels }, prices: { futures: futuresPrice, spot: spotPrice }, enabled: on, tpoRow })
    if (!hits.length) return
    const cfg = readJson(SCANNER_SETTINGS_KEY, {})
    for (const { market, level, price } of hits) {
      const label = market === 'futures' ? `${underlying} futures` : `${underlying} spot`
      const text = profileAlertText(level, price, label)
      const up = price >= level.price
      chime(up)
      const spoken = level.gap ? `${Math.round(level.low)} to ${Math.round(level.high)}` : Math.round(level.price)
      if (cfg.voice !== false) speak(`${level.confluence ? 'Profile confluence' : level.gap ? 'Profile gap' : 'Profile level'}. ${label} ${level.gap ? 'entered' : 'at'} ${level.labels.join(' and ')} ${spoken}.`)
      if (cfg.telegram !== false && !serverCovers[market]) telegram(`📊 ${text}`)
      notification.open({
        key: `profile-${market}-${underlying}-${level.id}`, placement: 'topRight', duration: 20,
        message: <span style={{ color: up ? UP_COLOR : DOWN_COLOR, fontWeight: 700 }}>📊 {label} · {level.gap ? 'entered ' : ''}{level.labels.join(' + ')} {levelWhere(level)}{level.confluence ? ' · confluence' : ''}</span>,
        description: <span style={{ fontSize: 12 }}>{market === 'futures' ? 'Futures' : 'Spot'} now {price.toFixed(1)}{level.gap ? ' · a thin stretch - price tends to move through it fast' : ''}{level.date ? ` · profile of ${level.date}` : ''}</span>,
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [futuresPrice, spotPrice, live, underlying, futuresLevels, spotLevels, on.futures, on.spot])

  return {
    on, change, levelCount: futuresLevels.length + spotOwn.length, confluences: [...futuresLevels, ...spotOwn].filter((l) => l.confluence).length,
    hasSpot: basis != null || spotOwn.length > 0, spotProfileLevels: spotOwn.length, serverCovers,
  }
}

/** Two switches: profile-level alerts on the futures, and on spot. */
export function ProfileAlertsBar({ on, change, levelCount, confluences, hasSpot, spotProfileLevels = 0, serverCovers, live, spotOnly = false }) {
  if (!levelCount) return null
  return (
    <Space wrap size={10} align="center" style={{ marginBottom: 6 }} aria-label="Profile level alerts">
      <Tooltip title={`Alert when price reaches the previous session's volume-profile or market-profile POC / VAH / VAL (and the volume profile's HVN), or enters a gap: the volume profile's LVN gaps, the market profile's LVN gaps and single prints${spotProfileLevels ? '; on spot, the previous day\'s spot volume and market profiles (the volume profile is the lines on the OI Replay charts)' : ''}. ${confluences} level${confluences === 1 ? '' : 's'} where both profiles agree are marked as a confluence.${live ? '' : ' Replay: alerts fire only live.'}`}>
        <Text style={{ fontSize: 12 }}>📊 Profile level alerts</Text>
      </Tooltip>
      {!spotOnly && <Space size={4}><Switch size="small" checked={on.futures} onChange={(v) => change('futures', v)} aria-label="Profile alerts futures" /><Text style={{ fontSize: 12 }}>Futures</Text></Space>}
      <Tooltip title={hasSpot ? (spotProfileLevels ? 'Spot: the previous day\'s spot volume and market profiles - their levels and gaps.' : 'Spot: the futures levels less the futures premium over spot.') : 'Needs the spot price from the OI data to place the levels on spot.'}>
        <Space size={4}><Switch size="small" checked={on.spot} onChange={(v) => change('spot', v)} disabled={!hasSpot} aria-label="Profile alerts spot" /><Text style={{ fontSize: 12 }}>Spot</Text></Space>
      </Tooltip>
      {(serverCovers?.futures || serverCovers?.spot) && (
        <Tooltip title="The server scanner sends these alerts to Telegram even with no page open - this page only chimes and shows them.">
          <Tag color="success" style={{ fontSize: 11 }}>Telegram from the server</Tag>
        </Tooltip>
      )}
    </Space>
  )
}
