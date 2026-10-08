import { useEffect, useMemo, useRef, useState } from 'react'
import { Space, Switch, Tooltip, Typography, notification } from 'antd'
import { UP_COLOR, DOWN_COLOR } from './shared.jsx'
import { chime, speak, telegram } from './alerts.js'
import { profileAlertText, profileHits, profileLevels, shiftLevels } from './profileAlerts.js'

const { Text } = Typography
const SETTINGS_KEY = 'optionanalytics.orderFlow.profileAlerts.v1'
const SCANNER_SETTINGS_KEY = 'optionanalytics.strategyScanner.settings'

const readJson = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}

/** Alerts when price reaches a level of the previous session's volume profile (POC / VAH / VAL / HVN /
 *  LVN) or market profile (POC / VAH / VAL) - the two profiles' levels at the same price are flagged as a
 *  confluence. Futures and spot are separate switches: futures against the futures' own profiles, spot
 *  against the same levels less the futures' premium over spot (an index has no volume of its own to
 *  profile). Live only - a replay shows nothing. Chime, spoken words, notification and Telegram follow
 *  the scanner's Voice / Telegram switches, like the price alerts. */
export function useProfileAlerts({ underlying, vp, tpo, tpoRow, futuresPrice, spotPrice, basis, live }) {
  const [on, setOn] = useState(() => ({ futures: true, spot: true, ...readJson(SETTINGS_KEY, {}) }))
  const change = (market, value) => setOn((prev) => {
    const next = { ...prev, [market]: value }
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)) } catch { /* convenience only */ }
    return next
  })

  const futuresLevels = useMemo(() => profileLevels(vp, tpo, tpoRow), [vp, tpo, tpoRow])
  const spotLevels = useMemo(() => (basis == null ? [] : shiftLevels(futuresLevels, -basis)), [futuresLevels, basis])
  const opts = useMemo(() => ({ tolerance: tpoRow / 2, rearmDistance: tpoRow * 3 }), [tpoRow])

  const run = (market, levels, price, enabled) => ({ market, levels, price, enabled })
  const watchers = [run('futures', futuresLevels, futuresPrice, on.futures), run('spot', spotLevels, spotPrice, on.spot)]
  const state = useRef({})
  // A new underlying or a new set of levels starts from scratch: nothing is armed until price is away from a level.
  const resetKey = `${underlying}|${futuresLevels.map((l) => l.key).join(',')}`
  useEffect(() => { state.current = {} }, [resetKey])

  useEffect(() => {
    if (!live) return
    for (const { market, levels, price, enabled } of watchers) {
      const s = (state.current[market] ??= { armed: new Set(), previous: 0 })
      if (!(price > 0)) continue
      // Tracked even while switched off, so switching on does not alert on a level price is already sitting at.
      const hits = profileHits(levels, s.previous, price, s.armed, opts)
      s.previous = price
      if (!enabled) continue
      const cfg = readJson(SCANNER_SETTINGS_KEY, {})
      for (const level of hits) {
        const label = market === 'futures' ? `${underlying} futures` : `${underlying} spot`
        const text = profileAlertText(level, price, label)
        const up = price >= level.price
        chime(up)
        if (cfg.voice !== false) speak(`${level.confluence ? 'Profile confluence' : 'Profile level'}. ${label} at ${level.labels.join(' and ')} ${Math.round(level.price)}.`)
        if (cfg.telegram !== false) telegram(`📊 ${text}`)
        notification.open({
          key: `profile-${market}-${underlying}-${level.key}`, placement: 'topRight', duration: 20,
          message: <span style={{ color: up ? UP_COLOR : DOWN_COLOR, fontWeight: 700 }}>📊 {label} · {level.labels.join(' + ')} {level.price.toFixed(1)}{level.confluence ? ' · confluence' : ''}</span>,
          description: <span style={{ fontSize: 12 }}>{market === 'futures' ? 'Futures' : 'Spot'} now {price.toFixed(1)}</span>,
        })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [futuresPrice, spotPrice, live, underlying, futuresLevels, spotLevels, on.futures, on.spot])

  return { on, change, levelCount: futuresLevels.length, confluences: futuresLevels.filter((l) => l.confluence).length, hasSpot: basis != null }
}

/** Two switches under the price alerts: profile-level alerts on the futures, and on spot. */
export function ProfileAlertsBar({ on, change, levelCount, confluences, hasSpot, live }) {
  if (!levelCount) return null
  return (
    <Space wrap size={10} align="center" style={{ marginBottom: 6 }} aria-label="Profile level alerts">
      <Tooltip title={`Alert when price reaches the previous session's volume-profile or market-profile POC / VAH / VAL (and the volume profile's HVN / LVN). ${confluences} level${confluences === 1 ? '' : 's'} where both profiles agree are marked as a confluence.${live ? '' : ' Replay: alerts fire only live.'}`}>
        <Text style={{ fontSize: 12 }}>📊 Profile level alerts</Text>
      </Tooltip>
      <Space size={4}><Switch size="small" checked={on.futures} onChange={(v) => change('futures', v)} /><Text style={{ fontSize: 12 }}>Futures</Text></Space>
      <Tooltip title={hasSpot ? 'Spot: the same levels less the futures premium over spot.' : 'Needs the spot price from the OI data to place the levels on spot.'}>
        <Space size={4}><Switch size="small" checked={on.spot} onChange={(v) => change('spot', v)} disabled={!hasSpot} /><Text style={{ fontSize: 12 }}>Spot</Text></Space>
      </Tooltip>
    </Space>
  )
}
