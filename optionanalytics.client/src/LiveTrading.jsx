import { Alert, Button, Popconfirm, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { UP_COLOR, DOWN_COLOR, fmtIstDateTime } from './shared.jsx'

const { Text } = Typography

// Real-money trading for the OI Replay trade panel's Live mode - every call is a real Dhan order or
// a read of the real account (see LiveTradingService / LiveTradingController on the server).

async function postJson(url, body, method = 'POST') {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body),
  })
  const result = await response.json().catch(() => null)
  if (!response.ok || !result?.success) throw new Error(result?.message || `Request failed (HTTP ${response.status})`)
  return result
}

export const liveTradingApi = {
  positions: (refresh = false) => fetch(`/api/live-trading/positions${refresh ? '?refresh=true' : ''}`).then((r) => (r.ok ? r.json() : null)),
  place: (order) => postJson('/api/live-trading/orders', order),
  close: (securityId, slippagePoints) => postJson(`/api/live-trading/positions/${encodeURIComponent(securityId)}/close`, { slippagePoints }),
  cancel: (orderId, isExit = false) => postJson(`/api/live-trading/orders/${encodeURIComponent(orderId)}${isExit ? '?exit=true' : ''}`, null, 'DELETE'),
  exitAll: (slippagePoints) => postJson('/api/live-trading/exit-all', { slippagePoints }),
  emergencyExitAll: () => postJson('/api/live-trading/emergency-exit-all', null),
}

const money = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Math.round(v).toLocaleString('en-IN')}`)
const pnlStyle = (v) => ({ color: v == null ? undefined : v >= 0 ? UP_COLOR : DOWN_COLOR, fontSize: 12 })
const price = (v) => (v == null ? '—' : Number(v).toFixed(2))

// The account's live positions (Dhan's own book, so they survive an app restart), pending entries
// and today's P&L. P&L moves with the live tick feed - snapshot is pushed by the server, not polled.
export function LivePositionsView({ snapshot, slippage, busy, onClose, onCancel, onRefresh, onExitAll, onEmergencyExitAll }) {
  if (!snapshot) return <Text type="secondary">Loading live positions from Dhan…</Text>
  const open = snapshot.positions.filter((p) => p.isOpen)
  const closed = snapshot.positions.filter((p) => !p.isOpen)

  const columns = [
    {
      title: 'Contract', dataIndex: 'tradingSymbol', key: 'symbol', width: 150, fixed: 'left',
      render: (s, r) => (
        <Space size={4} direction="vertical" style={{ lineHeight: 1.2 }}>
          <Text style={{ fontSize: 12 }}>{s}</Text>
          {r.isOpen && <Tag color={r.netQty > 0 ? 'success' : 'error'} style={{ fontSize: 10 }}>{r.netQty > 0 ? 'LONG' : 'SHORT'} {Math.abs(r.netQty)}</Tag>}
        </Space>
      ),
    },
    { title: 'Avg', dataIndex: 'avgPrice', key: 'avg', width: 62, render: price },
    { title: 'LTP', dataIndex: 'ltp', key: 'ltp', width: 62, render: price },
    { title: 'SL', dataIndex: 'stopLossPrice', key: 'sl', width: 58, render: price },
    { title: 'Target', dataIndex: 'targetPrice', key: 'target', width: 62, render: price },
    {
      title: 'P&L', key: 'pnl', width: 80,
      render: (_, r) => {
        const v = !r.isOpen ? r.realizedPnl : r.unrealizedPnl == null ? null : r.unrealizedPnl + (r.realizedPnl ?? 0)
        return <Text strong style={pnlStyle(v)}>{money(v)}</Text>
      },
    },
    {
      title: '', key: 'action', width: 70,
      render: (_, r) => (r.isOpen ? (
        <Popconfirm
          title="Close this live position?"
          description={`Cancels its SL/target, then ${r.netQty > 0 ? 'sells at the bid' : 'buys at the ask'} with ${slippage} pts slippage, for ${Math.abs(r.netQty)} qty.`}
          okText="Close now" okButtonProps={{ danger: true }} onConfirm={() => onClose(r.securityId)}
        >
          <Button size="small" danger disabled={busy}>Close</Button>
        </Popconfirm>
      ) : <Tag>Closed</Tag>),
    },
  ]

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <Space wrap size={8} style={{ width: '100%', justifyContent: 'space-between' }}>
        <Text strong style={{ ...pnlStyle(snapshot.dayPnl), fontSize: 14 }}>Day P&amp;L: {money(snapshot.dayPnl)}</Text>
        <Space size={6} wrap>
          {!snapshot.dhanLoggedIn && <Tag color="error">Dhan not logged in</Tag>}
          <Tooltip title={snapshot.orderUpdatesConnected
            ? "Fills and SL/target exits arrive from Dhan's order-update socket the moment they happen; P&L moves with the live tick feed."
            : "Dhan's order-update socket is not connected - fills and exits still show on the next safety refresh (within a minute) or on Refresh."}
          >
            <Tag color={snapshot.orderUpdatesConnected ? 'success' : 'warning'}>{snapshot.orderUpdatesConnected ? '● Order updates live' : '● Order updates offline'}</Tag>
          </Tooltip>
          <Tooltip title={snapshot.refreshedUtc ? `Positions last read from Dhan ${fmtIstDateTime(snapshot.refreshedUtc)}` : 'Not read from Dhan yet'}>
            <Button size="small" icon={<ReloadOutlined />} onClick={onRefresh} disabled={busy}>Refresh</Button>
          </Tooltip>
        </Space>
      </Space>

      {snapshot.recentRejections?.length > 0 && (
        <Alert type="error" showIcon message="Recently rejected by Dhan" description={snapshot.recentRejections.join(' · ')} />
      )}

      {snapshot.pendingOrders.length > 0 && (
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>Waiting to fill</Text>
          {snapshot.pendingOrders.map((o) => (
            <Space key={o.orderId} size={8} wrap>
              <Tag color={o.kind === 'Exit' ? 'warning' : o.transactionType === 'BUY' ? 'success' : 'error'}>{o.kind === 'Exit' ? 'EXIT ' : ''}{o.transactionType}</Tag>
              <Text style={{ fontSize: 12 }}>
                {o.tradingSymbol ?? o.securityId} x{o.quantity} @ {price(o.price)}
                {o.kind === 'Exit' ? ' · re-pricing to the live bid/ask until filled' : ` · T ${price(o.targetPrice)} · SL ${price(o.stopLossPrice)}`} · {o.status}
              </Text>
              <Button size="small" onClick={() => onCancel(o.orderId, o.kind === 'Exit')} disabled={busy}>Cancel</Button>
            </Space>
          ))}
        </Space>
      )}

      {(open.length > 0 || snapshot.pendingOrders.some((o) => o.kind !== 'Exit')) && (
        <Space wrap size={8}>
          <Popconfirm
            title="Exit ALL live positions?"
            description={`Cancels the panel's unfilled entries, then closes all ${open.length} open position(s) one by one - each one's SL/target cancelled first, exit at the bid/ask with ${slippage} pts slippage, re-priced until filled.`}
            okText="Exit all now" okButtonProps={{ danger: true }} onConfirm={onExitAll}
          >
            <Button danger type="primary" size="small" disabled={busy}>Exit all</Button>
          </Popconfirm>
          <Popconfirm
            title="EMERGENCY: Dhan exit-all for the whole account?"
            description="Dhan's own exit-everything: closes EVERY position and cancels EVERY open order on your account, including strategy triggers' orders. Use only if Exit all is not enough."
            okText="Exit everything on Dhan" okButtonProps={{ danger: true }} onConfirm={onEmergencyExitAll}
          >
            <Button danger size="small" disabled={busy}>Emergency exit (Dhan)</Button>
          </Popconfirm>
        </Space>
      )}

      {open.length === 0 && closed.length === 0
        ? <Text type="secondary">No positions on the Dhan account today.</Text>
        : <Table dataSource={[...open, ...closed]} columns={columns} rowKey="securityId" size="small" pagination={false} scroll={{ x: 560, y: 260 }} />}
    </Space>
  )
}
