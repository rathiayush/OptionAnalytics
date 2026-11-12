import { useEffect, useState } from 'react'
import { InputNumber, Space, Tooltip, Typography } from 'antd'

const { Text } = Typography

// The SERVER's iceberg / big order Telegram for an index (OrderFlowTelegramAlerts - sent whether or not a page is open):
// its thresholds, GET /api/order-flow-alerts; an admin changes them (PUT, saved a moment after the last change), everyone
// else sees them. 0 lots = not sent for that index.
export function OrderFlowTelegramSettings({ underlying, isAdmin }) {
  const [all, setAll] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let alive = true
    fetch('/api/order-flow-alerts').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((rows) => { if (alive) setAll(rows) })
      .catch((e) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [])
  const mine = all?.find((x) => x.underlying === underlying) ?? null
  // An unsaved change belongs to the index it was typed for - another index shows its own.
  const [typed, setDraft] = useState(null)
  const draft = typed?.underlying === underlying ? typed : null
  const shown = draft ?? mine
  useEffect(() => {
    if (!isAdmin || !draft || !mine || (draft.icebergLots === mine.icebergLots && draft.bigOrderLots === mine.bigOrderLots)) return undefined
    const t = setTimeout(() => {
      fetch(`/api/order-flow-alerts/${underlying}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ icebergLots: draft.icebergLots, bigOrderLots: draft.bigOrderLots }) })
        .then(async (r) => { const body = await r.json().catch(() => null); if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`); return body })
        .then((saved) => { setAll((rows) => (rows ?? []).map((x) => (x.underlying === saved.underlying ? saved : x))); setDraft(null); setError(null) })
        .catch((e) => setError(e.message))
    }, 800)
    return () => clearTimeout(t)
  }, [draft, mine, isAdmin, underlying])
  const set = (key) => (v) => setDraft({ ...(shown ?? {}), underlying, [key]: Math.max(0, Math.round(Number(v) || 0)) })
  return (
    <Tooltip title={`Telegram BY THE SERVER for ${underlying} futures, with or without this page open: an iceberg (a hidden buyer / seller that keeps refilling at one price) once it has traded this many lots, and every big print of at least this many lots (gathered, at most a message every 20 s). 0 = off. ${isAdmin ? 'Saved for everyone.' : 'An admin sets them.'}`}>
      <Space size={4} wrap>
        <Text style={{ fontSize: 12 }}>Telegram (server):</Text>
        <InputNumber value={shown?.icebergLots} onChange={set('icebergLots')} min={0} max={100000} disabled={!isAdmin || !shown} style={{ width: 150 }} addonBefore="Iceberg ≥" addonAfter="lots" aria-label="Iceberg Telegram lots" />
        <InputNumber value={shown?.bigOrderLots} onChange={set('bigOrderLots')} min={0} max={100000} disabled={!isAdmin || !shown} style={{ width: 165 }} addonBefore="Big order ≥" addonAfter="lots" aria-label="Big order Telegram lots" />
        {error && <Text type="danger" style={{ fontSize: 12 }}>{error}</Text>}
      </Space>
    </Tooltip>
  )
}
