import { Card, Space, Switch, Typography } from 'antd'
import { unlockAudio } from './alerts.js'
import { usePersistedState } from './shared.jsx'
import { ALERT_SWITCHES_KEY, alertSwitches } from './alertSwitches.js'

const { Text } = Typography

/** The page alerts' switches (alertSwitches.js): pop-up, chime, spoken words and Telegram. An admin's Telegram switch
 *  also goes to the server's alert runner (its OI break / profile alerts), as the strategy scanner's card did. */
export function AlertSwitches({ isAdmin }) {
  const [saved, setSaved] = usePersistedState(ALERT_SWITCHES_KEY, {})
  const on = alertSwitches(saved ?? {})
  const set = (key, value) => {
    if (key === 'alerts' || key === 'sound') unlockAudio()
    setSaved((s) => ({ ...(s ?? {}), [key]: value }))
    if (key === 'telegram' && isAdmin) {
      fetch('/api/scanner-runner/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: { telegram: value } }) }).catch(() => {})
    }
  }
  const item = (key, label) => (
    <Space size={4} key={key}>
      <Switch size="small" checked={on[key]} onChange={(v) => set(key, v)} aria-label={label} />
      <Text style={{ fontSize: 12 }}>{label}</Text>
    </Space>
  )
  return (
    <Card size="small" title="Alerts">
      <Space size={16} wrap>
        {item('alerts', 'Pop-ups')}
        {item('sound', 'Sound')}
        {item('voice', 'Speak')}
        {item('telegram', 'Telegram')}
        <Text type="secondary" style={{ fontSize: 11 }}>
          For the sudden OI walls, profile / price alerts here and OI Replay&apos;s OI break / zone alerts.
        </Text>
      </Space>
    </Card>
  )
}
