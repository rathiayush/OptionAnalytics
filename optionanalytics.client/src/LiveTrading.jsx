import { useState } from 'react'
import { Alert, Button, InputNumber, Popconfirm, Popover, Space, Table, Tag, Tooltip, Typography } from 'antd'
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
  if (!response.ok || !result?.success) {
    // The server's answer rides on the error: a failure can still carry orders that DID go through (a
    // sliced order Dhan rejected half-way) - the caller must keep track of those.
    const error = new Error(result?.message || `Request failed (HTTP ${response.status})`)
    error.result = result
    throw error
  }
  return result
}

export const liveTradingApi = {
  positions: (refresh = false) => fetch(`/api/live-trading/positions${refresh ? '?refresh=true' : ''}`).then((r) => (r.ok ? r.json() : null)),
  place: (order) => postJson('/api/live-trading/orders', order),
  close: (securityId, slippagePoints) => postJson(`/api/live-trading/positions/${encodeURIComponent(securityId)}/close`, { slippagePoints }),
  // Adds or moves the stop-loss / target (absolute option prices, 0 = leave) of ANY open position.
  protect: (securityId, stopLossPrice, targetPrice, slippagePoints) => postJson(`/api/live-trading/positions/${encodeURIComponent(securityId)}/protect`, { stopLossPrice, targetPrice, slippagePoints }),
  partialExit: (securityId, lots, slippagePoints) => postJson(`/api/live-trading/positions/${encodeURIComponent(securityId)}/partial-exit`, { lots, slippagePoints }),
  cancel: (orderId, isExit = false, leg = null) => postJson(
    `/api/live-trading/orders/${encodeURIComponent(orderId)}?${new URLSearchParams({ ...(isExit ? { exit: 'true' } : {}), ...(leg ? { leg } : {}) })}`, null, 'DELETE'),
  exitAll: (slippagePoints) => postJson('/api/live-trading/exit-all', { slippagePoints }),
  emergencyExitAll: () => postJson('/api/live-trading/emergency-exit-all', null),
  cancelAll: () => postJson('/api/live-trading/orders/cancel-all', null),
  // One strategy trade (its super orders) - not the whole position in that contract.
  exitTrade: (orderIds, slippagePoints) => postJson('/api/live-trading/orders/exit-trade', { orderIds, slippagePoints }),
  // trail: { start, gap } moves the trade's trailing stop too (gap 0 stops it); omitted leaves it as it is.
  tradeLevels: (orderIds, stopLossPoints, targetPoints, trail = null) => postJson('/api/live-trading/orders/trade-levels', {
    orderIds, slippagePoints: 0, stopLossPoints, targetPoints, ...(trail ? { trailStartPoints: trail.start ?? 0, trailGapPoints: trail.gap ?? 0 } : {}),
  }),
  // A live trade the strategy scanner placed: the server watches its INDEX stop-loss / target from then on and exits it
  // on Dhan (with Telegram) when one is hit - even with this page closed (ServerLiveService.WatchPageTrade).
  watchIndex: (watch) => plainPost('/api/live-trading/index-watch', watch),
  // Its trailing stop moved the index stop (the server keeps it only ever tighter).
  moveIndexStop: (underlying, key, stop) => plainPost('/api/live-trading/index-watch/stop', { underlying, key, stop }),
}

async function plainPost(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const result = await response.json().catch(() => null)
  if (!response.ok) throw new Error(result?.error || `Request failed (HTTP ${response.status})`)
  return result
}

const money = (v) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${Math.round(v).toLocaleString('en-IN')}`)
const pnlStyle = (v) => ({ color: v == null ? undefined : v >= 0 ? UP_COLOR : DOWN_COLOR, fontSize: 12 })
const price = (v) => (v == null ? '—' : Number(v).toFixed(2))

// Add a stop-loss to a position that has none, or move its stop-loss / target - whatever opened it.
// Prices are the option's own premium. Blank / 0 leaves that one as it is.
function ProtectButton({ row, slippage, busy, onProtect }) {
  const [open, setOpen] = useState(false)
  const [sl, setSl] = useState(null)
  const [target, setTarget] = useState(null)
  const sells = row.netQty > 0
  const save = () => { setOpen(false); onProtect(row.securityId, sl ?? 0, target ?? 0) }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => { setOpen(next); if (next) { setSl(row.stopLossPrice ?? null); setTarget(row.targetPrice ?? null) } }}
      trigger="click" title={`Stop-loss / target · ${row.tradingSymbol}`}
      content={(
        <Space direction="vertical" size={8} style={{ width: 230 }}>
          <InputNumber value={sl} onChange={setSl} min={0} step={0.5} style={{ width: '100%' }} addonBefore="Stop-loss" placeholder={row.avgPrice ? `below ${Number(row.ltp ?? row.avgPrice).toFixed(1)}` : 'price'} aria-label="Stop-loss price" />
          <InputNumber value={target} onChange={setTarget} min={0} step={0.5} style={{ width: '100%' }} addonBefore="Target" placeholder="price" aria-label="Target price" />
          <Text type="secondary" style={{ fontSize: 11 }}>
            Option prices. {sells ? 'Stop below, target above' : 'Stop above, target below'} the live price{row.ltp ? ` (${Number(row.ltp).toFixed(2)})` : ''}.
            A position with no stop-loss gets a STOP_LOSS order (limit {slippage} pts beyond the trigger); the target is watched by the server.
            An existing stop-loss / target is moved.
          </Text>
          <Button type="primary" size="small" onClick={save} disabled={busy || !((sl ?? 0) > 0 || (target ?? 0) > 0)}>Save</Button>
        </Space>
      )}
    >
      <Button size="small" disabled={busy}>SL/TGT</Button>
    </Popover>
  )
}

// Take part of a position off: how many lots, then confirm. The rest stays protected - see
// LiveTradingService.PartialExitAsync on the server.
function PartialExitButton({ row, slippage, busy, onPartialExit }) {
  const totalLots = row.lotSize > 0 ? Math.floor(Math.abs(row.netQty) / row.lotSize) : 0
  const [lots, setLots] = useState(1)
  if (totalLots < 2) return null
  const value = Math.min(Math.max(1, lots), totalLots - 1)
  return (
    <Popconfirm
      title="Exit part of this position?"
      description={(
        <Space direction="vertical" size={6} style={{ maxWidth: 280 }}>
          <Space size={6}>
            <InputNumber size="small" min={1} max={totalLots - 1} value={value} onChange={(v) => setLots(v ?? 1)} addonAfter={`of ${totalLots} lots`} style={{ width: 150 }} />
          </Space>
          <Text style={{ fontSize: 12 }}>
            {row.netQty > 0 ? 'Sells' : 'Buys back'} {value * row.lotSize} qty at the {row.netQty > 0 ? 'bid' : 'ask'} with {slippage} pts slippage -
            one exit order, nothing else. The super order stays as it is (SL {price(row.stopLossPrice)}, target {price(row.targetPrice)}), but Dhan
            cannot shrink it: if its SL or target fires it acts on its ORIGINAL quantity, more than the {(totalLots - value) * row.lotSize} qty
            left. Use Close to exit the rest - it cancels the legs first.
          </Text>
        </Space>
      )}
      okText={`Exit ${value} lot${value > 1 ? 's' : ''}`} okButtonProps={{ danger: true }} onConfirm={() => onPartialExit(row.securityId, value)}
    >
      <Button size="small" disabled={busy}>Part</Button>
    </Popconfirm>
  )
}

const protectionTag = (r) => (r.legExcessQty > 0
  ? (
    <Tooltip title={`After a partial exit the super order's SL/target still cover ${Math.abs(r.netQty) + r.legExcessQty} qty (Dhan cannot shrink them). If one fires it closes ${r.legExcessQty} more than you hold, leaving an opposite position. Close cancels the legs and exits the rest.`}>
      <Tag color="warning" style={{ fontSize: 10, margin: 0 }}>legs +{r.legExcessQty}</Tag>
    </Tooltip>
  )
  : r.protection === 'managed'
  ? <Tooltip title="After a partial exit: a stop-loss order held by Dhan, and the target watched by the server - when price reaches it, that same order becomes a limit exit."><Tag color="purple" style={{ fontSize: 10, margin: 0 }}>managed</Tag></Tooltip>
  : r.protection === 'none'
    ? <Tooltip title="No stop-loss or target is protecting this position."><Tag color="error" style={{ fontSize: 10, margin: 0 }}>unprotected</Tag></Tooltip>
    : null)

// The account's live positions (Dhan's own book, so they survive an app restart), pending entries
// and today's P&L. P&L moves with the live tick feed - snapshot is pushed by the server, not polled.
export function LivePositionsView({ snapshot, slippage, busy, onClose, onProtect, onPartialExit, onCancel, onCancelAll, onRefresh, onExitAll, onEmergencyExitAll }) {
  if (!snapshot) return <Text type="secondary">Loading live positions from Dhan…</Text>
  const open = snapshot.positions.filter((p) => p.isOpen)
  const closed = snapshot.positions.filter((p) => !p.isOpen)

  const columns = [
    {
      title: 'Contract', dataIndex: 'tradingSymbol', key: 'symbol', width: 150, fixed: 'left',
      render: (s, r) => (
        <Space size={4} direction="vertical" style={{ lineHeight: 1.2 }}>
          <Text style={{ fontSize: 12 }}>{s}</Text>
          {r.isOpen && (
            <Space size={4}>
              <Tag color={r.netQty > 0 ? 'success' : 'error'} style={{ fontSize: 10, margin: 0 }}>{r.netQty > 0 ? 'LONG' : 'SHORT'} {Math.abs(r.netQty)}</Tag>
              {protectionTag(r)}
            </Space>
          )}
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
      title: '', key: 'action', width: 170,
      render: (_, r) => (r.isOpen ? (
        <Space size={4}>
          {onProtect && <ProtectButton row={r} slippage={slippage} busy={busy} onProtect={onProtect} />}
          {onPartialExit && <PartialExitButton row={r} slippage={slippage} busy={busy} onPartialExit={onPartialExit} />}
          <Popconfirm
            title="Close this live position?"
            description={`Cancels its super orders (SL/target legs and any unfilled entry in this contract), then ${r.netQty > 0 ? 'sells at the bid' : 'buys at the ask'} with ${slippage} pts slippage, for ${Math.abs(r.netQty)} qty.`}
            okText="Close now" okButtonProps={{ danger: true }} onConfirm={() => onClose(r.securityId)}
          >
            <Button size="small" danger disabled={busy}>Close</Button>
          </Popconfirm>
        </Space>
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
            ? `Event-driven: every order change and fill from Dhan's order-update socket is applied to positions the moment it arrives, and P&L moves with the live tick feed - nothing is polled.${snapshot.lastOrderEventUtc ? ` Last order event ${fmtIstDateTime(snapshot.lastOrderEventUtc)}.` : ''}`
            : "Dhan's order-update socket is not connected - until it reconnects, positions are read from Dhan every 30 seconds (or press Refresh)."}
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

      <OpenOrdersTable orders={snapshot.pendingOrders} busy={busy} onCancel={onCancel} onCancelAll={onCancelAll} />

      {(open.length > 0 || snapshot.pendingOrders.length > 0) && (
        <Space wrap size={8}>
          <Popconfirm
            title="Exit ALL live positions?"
            description={`Cancels EVERY pending order (unfilled super orders with their legs, other pending orders), then closes all ${open.length} open position(s) one by one - each one's SL/target cancelled first, exit at the bid/ask with ${slippage} pts slippage, re-priced until filled.`}
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
        : <Table dataSource={[...open, ...closed]} columns={columns} rowKey="securityId" size="small" pagination={false} scroll={{ x: 600, y: 260 }} />}
    </Space>
  )
}

const ORDER_LABEL = { Protection: 'STOP-LOSS', Exit: 'EXIT', 'Target leg': 'TARGET LEG', 'Stop-loss leg': 'SL LEG', Entry: 'ENTRY' }

// Every open order on the Dhan account - unfilled super-order entries, the target / stop-loss legs of
// filled ones, the panel's exits and any other pending order - each cancellable here, or all at once.
function OpenOrdersTable({ orders, busy, onCancel, onCancelAll }) {
  const columns = [
    {
      title: 'Order', key: 'kind', width: 150,
      render: (_, o) => {
        const label = ORDER_LABEL[o.kind] ?? (o.orderType && o.orderType !== 'LIMIT' ? o.orderType.replace(/_/g, ' ') : 'ORDER')
        const color = o.kind === 'Protection' || o.kind === 'Stop-loss leg' ? 'purple' : o.kind === 'Target leg' ? 'cyan' : o.kind === 'Exit' ? 'warning' : o.transactionType === 'BUY' ? 'success' : 'error'
        return <Tag color={color} style={{ margin: 0 }}>{label} {o.transactionType}</Tag>
      },
    },
    { title: 'Contract', dataIndex: 'tradingSymbol', render: (v, o) => <span style={{ fontSize: 12 }}>{v ?? o.securityId}</span> },
    { title: 'Qty', dataIndex: 'quantity', width: 64, align: 'right' },
    {
      title: 'Price', key: 'price', width: 170,
      render: (_, o) => <span style={{ fontSize: 12 }}>{
        o.kind === 'Target leg' ? `target ${price(o.targetPrice)}`
          : o.kind === 'Stop-loss leg' ? `stop-loss ${price(o.stopLossPrice)}`
            : o.kind === 'Protection' ? `trigger ${price(o.stopLossPrice)}${o.targetPrice ? ` · T ${price(o.targetPrice)}` : ''}`
              : o.kind === 'Entry' ? `${price(o.price)} · T ${price(o.targetPrice)} · SL ${price(o.stopLossPrice)}`
                : `${price(o.price)}${o.stopLossPrice ? ` · trigger ${price(o.stopLossPrice)}` : ''}`
      }</span>,
    },
    { title: 'Status', dataIndex: 'status', width: 96, render: (v) => <span style={{ fontSize: 11 }}>{v}</span> },
    {
      title: '', key: 'cancel', width: 80,
      render: (_, o) => {
        const isLeg = o.kind === 'Target leg' || o.kind === 'Stop-loss leg'
        const cancel = () => onCancel(o.orderId, !o.leg, o.leg)
        return o.kind === 'Protection' || isLeg
          ? (
            <Popconfirm
              title={`Cancel this ${o.kind === 'Target leg' ? 'target' : 'stop-loss'}?`}
              description={o.kind === 'Target leg' ? 'The position keeps its stop-loss but no target.' : 'The position will have NO stop-loss.'}
              okText="Cancel it" okButtonProps={{ danger: true }} onConfirm={cancel}
            >
              <Button size="small" danger disabled={busy}>Cancel</Button>
            </Popconfirm>
          )
          : <Button size="small" danger disabled={busy} onClick={cancel}>Cancel</Button>
      },
    },
  ]
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Space wrap size={8} style={{ justifyContent: 'space-between', width: '100%' }}>
        <Text strong style={{ fontSize: 13 }}>Open orders on Dhan ({orders.length})</Text>
        {orders.length > 0 && onCancelAll && (
          <Popconfirm
            title="Cancel ALL open orders?"
            description="Every pending order and every stop-loss / target leg is cancelled. Open positions stay open - with no stop-loss or target."
            okText="Cancel all" okButtonProps={{ danger: true }} onConfirm={onCancelAll}
          >
            <Button size="small" danger disabled={busy}>Cancel all open orders</Button>
          </Popconfirm>
        )}
      </Space>
      {orders.length === 0
        ? <Text type="secondary" style={{ fontSize: 12 }}>No open orders on the account.</Text>
        : (
          <Table
            size="small" pagination={false} columns={columns} scroll={{ x: 640 }}
            dataSource={orders.map((o) => ({ ...o, key: `${o.orderId}-${o.leg ?? ''}` }))}
            aria-label="Open orders"
          />
        )}
    </Space>
  )
}
