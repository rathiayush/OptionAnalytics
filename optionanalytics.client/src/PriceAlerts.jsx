import { useEffect, useRef, useState } from 'react'
import { Button, InputNumber, Space, Tag, Tooltip, Typography, notification } from 'antd'
import { BellOutlined } from '@ant-design/icons'
import { UP_COLOR, DOWN_COLOR } from './shared.jsx'
import { alertsHit, chime, speak, telegram, unlockAudio } from './alerts.js'

const { Text } = Typography
// Per underlying: [{ id, price, dir: 'above' | 'below', createdAt }] - the futures price.
const ALERTS_KEY = 'optionanalytics.orderFlow.priceAlerts.v1'
const SCANNER_SETTINGS_KEY = 'optionanalytics.strategyScanner.settings'
const MAX_ALERTS = 20

const readJson = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}
const writeJson = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage full / blocked */ }
}

/** Price alerts on the futures: kept per underlying across reloads, each fired ONCE - live only (a
 *  replay shows the lines but does not alert) - with a chime, the spoken words (when the scanner's
 *  voice is on), a notification and the server's Telegram chat (when the scanner's Telegram is on),
 *  then removed. */
export function usePriceAlerts(underlying, lastPrice, live) {
  const [all, setAll] = useState(() => readJson(ALERTS_KEY, {}))
  const alerts = all[underlying] ?? []
  const save = (list) => setAll((prev) => {
    const next = { ...prev, [underlying]: list(prev[underlying] ?? []) }
    writeJson(ALERTS_KEY, next)
    return next
  })
  const add = (price) => {
    if (!(price > 0)) return 'Enter a price'
    if (alerts.some((a) => a.price === price)) return 'Already set'
    if (alerts.length >= MAX_ALERTS) return `At most ${MAX_ALERTS} alerts`
    if (lastPrice > 0 && price === lastPrice) return 'That is the price now'
    unlockAudio()
    save((list) => [...list, { id: `${Date.now()}-${price}`, price, dir: lastPrice > 0 && price < lastPrice ? 'below' : 'above', createdAt: Date.now() }])
    return null
  }
  const remove = (id) => save((list) => list.filter((a) => a.id !== id))

  const firing = useRef(new Set())
  useEffect(() => {
    if (!live) return
    const hits = alertsHit(alerts, lastPrice).filter((a) => !firing.current.has(a.id))
    if (!hits.length) return
    const cfg = readJson(SCANNER_SETTINGS_KEY, {})
    for (const a of hits) {
      firing.current.add(a.id)
      const up = a.dir === 'above'
      chime(up)
      if (cfg.voice !== false) speak(`Price alert. ${underlying} ${up ? 'above' : 'below'} ${a.price}.`)
      if (cfg.telegram !== false) telegram(`🔔 Price alert: ${underlying} futures ${up ? 'rose to' : 'fell to'} ${a.price} (now ${lastPrice.toFixed(1)})`)
      notification.open({
        key: `price-${a.id}`, placement: 'topRight', duration: 20,
        message: <span style={{ color: up ? UP_COLOR : DOWN_COLOR, fontWeight: 700 }}>🔔 {underlying} {up ? '▲ above' : '▼ below'} {a.price}</span>,
        description: <span style={{ fontSize: 12 }}>Futures now {lastPrice.toFixed(1)} · set {new Date(a.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false })}</span>,
      })
    }
    save((list) => list.filter((a) => !hits.some((h) => h.id === a.id)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastPrice, live, underlying])

  return { alerts, add, remove }
}

/** The footprint card's alert bar: a price box (the last price to start from), Add, and the alerts set. */
export function PriceAlertsBar({ alerts, add, remove, lastPrice, live }) {
  const [price, setPrice] = useState(null)
  const [error, setError] = useState(null)
  const submit = () => {
    const value = price ?? (lastPrice > 0 ? Math.round(lastPrice) : null)
    const err = add(value)
    setError(err)
    if (!err) setPrice(null)
  }
  return (
    <Space wrap size={6} align="center" style={{ marginBottom: 6 }} aria-label="Price alerts">
      <Tooltip title={`Alert when the futures reach this price - a chime, the words, a notification and Telegram (the scanner's Voice / Telegram switches apply). Once, then it is removed.${live ? '' : ' Replay: the lines show, alerts fire only live.'}`}>
        <Space.Compact>
          <InputNumber size="small" value={price} onChange={setPrice} onPressEnter={submit} placeholder={lastPrice > 0 ? lastPrice.toFixed(0) : 'price'} min={0} step={5} style={{ width: 120 }} prefix={<BellOutlined />} aria-label="Alert price" />
          <Button size="small" onClick={submit}>Add alert</Button>
        </Space.Compact>
      </Tooltip>
      {error && <Text type="danger" style={{ fontSize: 11 }}>{error}</Text>}
      {[...alerts].sort((a, b) => b.price - a.price).map((a) => (
        <Tag key={a.id} closable onClose={(e) => { e.preventDefault(); remove(a.id) }} color="gold" style={{ margin: 0 }}>
          {a.dir === 'above' ? '▲' : '▼'} {a.price}
        </Tag>
      ))}
    </Space>
  )
}
