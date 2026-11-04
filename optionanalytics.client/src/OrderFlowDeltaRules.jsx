import { useEffect, useState } from 'react'
import { Alert, Button, Card, Table, Typography } from 'antd'
import { DOWN_COLOR, UP_COLOR, usePersistedState } from './shared.jsx'

// The Order Flow page's "Delta rules" card: a day's delta, candle by candle, by each way of inferring a trade's side
// (OrderFlowEngine.DeltaRules). Dhan's packets carry no side and Dhan does not publish how its own chart gets one, so this
// is how a rule is chosen: set each column against Dhan's Delta for the same candles. Folded, it asks the server nothing.

const { Text } = Typography
const REFRESH_MS = 30_000

// Dhan's own format: -12.80 K.
const thousands = (v) => (v == null ? '—' : `${v < 0 ? '−' : v > 0 ? '+' : ''}${(Math.abs(v) / 1000).toFixed(2)} K`)

const signed = (v) => <Text style={{ fontSize: 12, color: v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined }}>{thousands(v)}</Text>

const COLUMNS = [
  { title: 'Candle', dataIndex: 'time', key: 'time', width: 70, render: (v) => v.slice(11, 16) },
  { title: 'Volume', dataIndex: 'volume', key: 'volume', width: 90, align: 'right', render: (v) => `${(v / 1000).toFixed(2)} K` },
  { title: 'In use', dataIndex: 'delta', key: 'delta', width: 90, align: 'right', render: signed },
  { title: 'Old rule', dataIndex: 'depthBook', key: 'depthBook', width: 90, align: 'right', render: signed },
  { title: 'Own packet', dataIndex: 'ownPacket', key: 'ownPacket', width: 90, align: 'right', render: signed },
  { title: 'Tick rule', dataIndex: 'tickRule', key: 'tickRule', width: 90, align: 'right', render: signed },
]

export function DeltaRulesCard({ underlying, date, expiryQuery, timeframe }) {
  const [open, setOpen] = usePersistedState('optionanalytics.orderFlow.deltaRulesOpen', false)
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const url = `/api/order-flow/${underlying}/delta-rules?timeframe=${timeframe}${date ? `&date=${date}` : ''}${expiryQuery}`

  useEffect(() => {
    if (!open) return undefined
    let stale = false
    const load = async () => {
      try {
        const r = await fetch(url)
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.error || `Request failed (HTTP ${r.status})`)
        if (!stale) { setRows([...body].reverse()); setError(null) }
      } catch (err) {
        if (!stale) setError(err.message)
      }
    }
    load()
    const timer = date ? null : setInterval(load, REFRESH_MS)
    return () => { stale = true; if (timer) clearInterval(timer) }
  }, [open, url, date])

  return (
    <Card
      size="small" title={`Delta rules · compare with Dhan · ${timeframe} min`}
      extra={<Button size="small" type="link" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</Button>}
      styles={open ? undefined : { body: { display: 'none' } }}
    >
      {open && (
        <>
          <Text type="secondary" style={{ display: 'block', fontSize: 12, marginBottom: 8 }}>
            Dhan&apos;s feed does not say who the aggressor was, so each column infers it differently. Set them against Dhan&apos;s Delta for the same candles:
            the column closest over many candles is the rule to use. In use = the previous packet&apos;s quote · Old rule = the depth sockets&apos; quotes ·
            Own packet = the book the trade left behind · Tick rule = up from the last price is a buy. — = recorded before this was kept.
          </Text>
          {error && <Alert type="warning" showIcon message={error} style={{ marginBottom: 8 }} />}
          <Table
            size="small" rowKey="time" columns={COLUMNS} dataSource={rows ?? []} loading={rows === null && !error} scroll={{ x: 520 }}
            pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
          />
        </>
      )}
    </Card>
  )
}
