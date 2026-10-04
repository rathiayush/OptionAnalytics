import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button, Drawer, Segmented, Select, Space, Switch, Tag, Tooltip, Typography } from 'antd'
import { AimOutlined } from '@ant-design/icons'
import * as signalR from '@microsoft/signalr'
import { usePersistedState, RECONNECT_RETRY_POLICY, onLiveBatch, joinAllSignalRGroups, syncSignalRGroups, UP_COLOR, DOWN_COLOR, AXIS_COLOR, BORDER_COLOR } from './shared.jsx'
import { formatVolume } from './OrderFlowCharts.jsx'

const { Text } = Typography

// DOM (depth of market): a price ladder for each underlying's nearest futures, in a drawer that slides
// in from the side - Dhan's full market depth (200 bid and 200 ask levels per contract on NSE, see
// DhanTwoHundredDepthClient) with the day's traded volume at every price (a volume profile down the
// ladder) and the latest prints. Fed by the server's "domLive" push on SignalR group "dom:{underlying}",
// which only runs while a DOM is open. Rows can be grouped (the contract's tick, or 0.5/1/2/5 points)
// and the ladder keeps the spread centred until you scroll it yourself.

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX']
const ROW_OPTIONS = [{ value: 0, label: 'Tick' }, ...[0.5, 1, 2, 5].map((v) => ({ value: v, label: `${v} pt` }))]
const MAX_ROWS = 900
const WALL_FACTOR = 4
const IST_HHMMSS = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })
const round2 = (v) => Math.round(v * 100) / 100

export function useNarrow(maxWidth = 640) {
  const query = `(max-width: ${maxWidth}px)`
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches)
  useEffect(() => {
    const media = window.matchMedia?.(query)
    if (!media) return undefined
    const onChange = () => setNarrow(media.matches)
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [query])
  return narrow
}

// Its own SignalR connection, only while the drawer is open.
function useDomFeed(underlying, open) {
  const [dom, setDom] = useState(null)
  const [state, setState] = useState('idle')
  const connectionRef = useRef(null)
  const groupsRef = useRef([])
  const underlyingRef = useRef(underlying)
  underlyingRef.current = underlying

  useEffect(() => {
    if (!open) return undefined
    setState('connecting')
    const connection = new signalR.HubConnectionBuilder().withUrl('/hubs/spot').withAutomaticReconnect(RECONNECT_RETRY_POLICY).build()
    connectionRef.current = connection
    onLiveBatch(connection, { domLive: (payload) => { if (payload?.meta?.underlying === underlyingRef.current) setDom(payload) } })
    connection.onreconnecting(() => setState('reconnecting'))
    connection.onreconnected(() => { setState('connected'); joinAllSignalRGroups(connection, groupsRef.current) })
    connection.onclose(() => setState('disconnected'))
    groupsRef.current = [`dom:${underlyingRef.current}`]
    connection.start()
      .then(() => { setState('connected'); joinAllSignalRGroups(connection, groupsRef.current) })
      .catch((err) => { if (err?.name !== 'AbortError') setState('disconnected') })
    return () => { connectionRef.current = null; connection.stop(); setDom(null); setState('idle') }
  }, [open])

  useEffect(() => {
    if (!open) return
    const groups = [`dom:${underlying}`]
    syncSignalRGroups(connectionRef.current, groupsRef.current, groups)
    groupsRef.current = groups
    setDom(null)
  }, [underlying, open])

  return { dom, state }
}

// The ladder's rows, top (highest price) to bottom: book and traded volume grouped into `step` rows.
export function buildDomRows(dom, step) {
  if (!dom || !(step > 0)) return { rows: [], bestBidKey: null, bestAskKey: null }
  const keyOf = (price) => Math.floor(price / step + 1e-9)
  const bids = new Map()
  const asks = new Map()
  const volume = new Map()
  const add = (map, key, quantity, orders) => {
    const row = map.get(key)
    if (row) { row.quantity += quantity; row.orders += orders } else map.set(key, { quantity, orders })
  }
  for (const l of dom.book?.bids ?? []) add(bids, keyOf(l.price), l.quantity, l.orders)
  for (const l of dom.book?.asks ?? []) add(asks, keyOf(l.price), l.quantity, l.orders)
  for (const v of dom.volume ?? []) {
    const key = keyOf(v.price)
    const row = volume.get(key)
    if (row) { row.buy += v.buy; row.sell += v.sell } else volume.set(key, { buy: v.buy, sell: v.sell })
  }
  const keys = [...bids.keys(), ...asks.keys()]
  if (!keys.length) return { rows: [], bestBidKey: null, bestAskKey: null }
  const bestBidKey = bids.size ? Math.max(...bids.keys()) : null
  const bestAskKey = asks.size ? Math.min(...asks.keys()) : null
  let hi = Math.max(...keys)
  let lo = Math.min(...keys)
  if (hi - lo + 1 > MAX_ROWS) {
    // Keep the rows nearest the spread.
    const mid = Math.round(((bestBidKey ?? bestAskKey) + (bestAskKey ?? bestBidKey)) / 2)
    hi = Math.min(hi, mid + MAX_ROWS / 2)
    lo = Math.max(lo, mid - MAX_ROWS / 2)
  }
  const rows = []
  for (let key = hi; key >= lo; key--) {
    rows.push({ key, price: round2(key * step), bid: bids.get(key) ?? null, ask: asks.get(key) ?? null, volume: volume.get(key) ?? null })
  }
  return { rows, bestBidKey, bestAskKey }
}

export function DomDrawer({ open, onClose, underlying: initialUnderlying = 'NIFTY' }) {
  const [underlying, setUnderlying] = useState(initialUnderlying)
  useEffect(() => { if (open && UNDERLYINGS.includes(initialUnderlying)) setUnderlying(initialUnderlying) }, [open, initialUnderlying])
  const [rowSizes, setRowSizes] = usePersistedState('optionanalytics.dom.rowSizes', { NIFTY: 0, BANKNIFTY: 0, SENSEX: 0 })
  const [showLots, setShowLots] = usePersistedState('optionanalytics.dom.showLots', true)
  const [placement, setPlacement] = usePersistedState('optionanalytics.dom.placement', 'right')
  const [drawerWidth, setDrawerWidth] = usePersistedState('optionanalytics.dom.width', 560)
  const [autoCenter, setAutoCenter] = useState(true)
  const narrow = useNarrow()
  const { dom, state } = useDomFeed(underlying, open)

  const meta = dom?.meta
  const lotSize = meta?.lotSize ?? 1
  const rowSize = rowSizes?.[underlying] ?? 0
  const step = rowSize > 0 ? rowSize : meta?.tickSize ?? 0.05
  const { rows, bestBidKey, bestAskKey } = useMemo(() => buildDomRows(dom, step), [dom, step])
  const ltpKey = meta?.lastPrice > 0 ? Math.floor(meta.lastPrice / step + 1e-9) : null

  const stats = useMemo(() => {
    const quantities = rows.flatMap((r) => [r.bid?.quantity, r.ask?.quantity]).filter((q) => q > 0).sort((a, b) => a - b)
    const median = quantities.length ? quantities[Math.floor(quantities.length / 2)] : 0
    const maxBook = Math.max(1, ...quantities)
    const maxVolume = Math.max(1, ...rows.map((r) => (r.volume ? r.volume.buy + r.volume.sell : 0)))
    const pocKey = rows.reduce((best, r) => (r.volume && (!best || r.volume.buy + r.volume.sell > best.v) ? { key: r.key, v: r.volume.buy + r.volume.sell } : best), null)?.key
    const totalBid = (dom?.book?.bids ?? []).reduce((s, l) => s + l.quantity, 0)
    const totalAsk = (dom?.book?.asks ?? []).reduce((s, l) => s + l.quantity, 0)
    const bestBid = dom?.book?.bids?.[0]
    const bestAsk = dom?.book?.asks?.[0]
    return { median, maxBook, maxVolume, pocKey, totalBid, totalAsk, bestBid, bestAsk }
  }, [rows, dom])

  // Keep the spread in the middle of the ladder until the user scrolls it.
  const scrollRef = useRef(null)
  const centerRow = bestAskKey != null && bestBidKey != null ? Math.round((bestAskKey + bestBidKey) / 2) : bestAskKey ?? bestBidKey
  const recenter = () => {
    const box = scrollRef.current
    if (!box || centerRow == null || !rows.length) return
    const index = rows.findIndex((r) => r.key <= centerRow)
    if (index < 0) return
    box.scrollTop = index * ROW_HEIGHT - box.clientHeight / 2 + ROW_HEIGHT / 2
  }
  useLayoutEffect(() => { if (autoCenter) recenter() })
  const stopAutoCenter = () => { if (autoCenter) setAutoCenter(false) }

  const imbalance = stats.totalBid + stats.totalAsk > 0 ? stats.totalBid / (stats.totalBid + stats.totalAsk) : 0.5
  const spread = stats.bestBid && stats.bestAsk ? round2(stats.bestAsk.price - stats.bestBid.price) : null
  const vol = (q) => formatVolume(q, lotSize, showLots)

  return (
    <Drawer
      open={open} onClose={onClose} placement={narrow ? 'right' : placement} mask={false} destroyOnHidden
      size={narrow ? '100%' : drawerWidth} resizable={!narrow && { onResize: (w) => setDrawerWidth(Math.round(Math.max(360, Math.min(w, 1000)))) }}
      styles={{ body: { padding: 10, display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden' } }}
      title={(
        <Space size={8} wrap>
          <span>DOM</span>
          <Select size="small" value={underlying} onChange={setUnderlying} style={{ width: 128 }} options={UNDERLYINGS.map((u) => ({ value: u, label: `${u} FUT` }))} />
          {meta && <Tooltip title={meta.depthLevels >= 200 ? "Dhan's full market depth: 200 levels each side." : meta.depthLevels >= 20 ? "Dhan's 20-level depth (the 200-level feed is not streaming for this contract)." : 'Only the 5 levels in each tick (BSE contracts have no deeper feed from Dhan).'}>
            <Tag color={meta.depthLevels >= 200 ? 'green' : meta.depthLevels >= 20 ? 'blue' : 'orange'} style={{ margin: 0 }}>{meta.depthLevels} levels</Tag>
          </Tooltip>}
        </Space>
      )}
      extra={!narrow && (
        <Segmented size="small" value={placement} onChange={setPlacement} options={[{ label: 'Left', value: 'left' }, { label: 'Right', value: 'right' }]} />
      )}
    >
      <Space size={8} wrap align="center">
        <Select size="small" value={rowSize} onChange={(v) => setRowSizes({ ...(rowSizes ?? {}), [underlying]: v })} style={{ width: 84 }} options={ROW_OPTIONS} />
        <Space size={4}><Switch size="small" checked={showLots} onChange={setShowLots} /><Text style={{ fontSize: 12 }}>Lots</Text></Space>
        <Button size="small" icon={<AimOutlined />} type={autoCenter ? 'primary' : 'default'} onClick={() => { setAutoCenter(true); recenter() }}>
          {autoCenter ? 'Centred' : 'Recentre'}
        </Button>
        <Tag color={state === 'connected' ? (dom ? 'success' : 'processing') : state === 'reconnecting' ? 'warning' : 'error'} style={{ margin: 0 }}>
          {state === 'connected' ? (dom ? '● Live' : '● Waiting for depth…') : state === 'reconnecting' ? '● Reconnecting…' : state === 'connecting' ? '● Connecting…' : '● Disconnected'}
        </Tag>
      </Space>

      {meta && (
        <div style={{ fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: '4px 14px', alignItems: 'baseline' }}>
          <Text strong style={{ fontSize: 15 }}>{meta.lastPrice > 0 ? meta.lastPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'}</Text>
          <span>{meta.contractSymbol}</span>
          {spread != null && <span style={{ color: AXIS_COLOR }}>spread {spread}</span>}
          {stats.bestBid && stats.bestAsk && (
            <span>
              <span style={{ color: UP_COLOR }}>{vol(stats.bestBid.quantity)}</span>
              <span style={{ color: AXIS_COLOR }}> @ {stats.bestBid.price} / {stats.bestAsk.price} @ </span>
              <span style={{ color: DOWN_COLOR }}>{vol(stats.bestAsk.quantity)}</span>
            </span>
          )}
        </div>
      )}
      {meta && (
        <Tooltip title="All resting bids vs offers in the book">
          <div>
            <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${imbalance * 100}%`, background: UP_COLOR }} />
              <div style={{ flex: 1, background: DOWN_COLOR }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: AXIS_COLOR }}>
              <span>Bids {vol(stats.totalBid)} ({Math.round(imbalance * 100)}%)</span>
              <span>Offers {vol(stats.totalAsk)} ({Math.round((1 - imbalance) * 100)}%)</span>
            </div>
          </div>
        </Tooltip>
      )}

      <LadderHeader narrow={narrow} />
      <div
        ref={scrollRef} data-dom-ladder onWheel={stopAutoCenter} onTouchMove={stopAutoCenter} onMouseDown={stopAutoCenter}
        style={{ flex: 1, minHeight: 200, overflowY: 'auto', overflowX: 'hidden', border: `1px solid ${BORDER_COLOR}`, borderRadius: 4 }}
      >
        {!rows.length
          ? <div style={{ padding: 16 }}><Text type="secondary">{state === 'connected' ? 'Waiting for the first depth update…' : 'Connecting…'}</Text></div>
          : rows.map((r) => (
            <LadderRow
              key={r.key} row={r} narrow={narrow} vol={vol} stats={stats}
              isBestBid={r.key === bestBidKey} isBestAsk={r.key === bestAskKey} isLtp={r.key === ltpKey} isPoc={r.key === stats.pocKey}
            />
          ))}
      </div>

      <div style={{ maxHeight: narrow ? 110 : 150, overflowY: 'auto', fontSize: 11, borderTop: `1px solid ${BORDER_COLOR}`, paddingTop: 4 }}>
        {[...(dom?.trades ?? [])].reverse().map((t) => (
          <div key={t.seq} style={{ display: 'grid', gridTemplateColumns: '62px 70px 1fr', gap: 6 }}>
            <span style={{ color: AXIS_COLOR }}>{IST_HHMMSS.format(new Date(t.time))}</span>
            <span style={{ color: t.buy ? UP_COLOR : DOWN_COLOR }}>{t.price}</span>
            <span style={{ color: t.buy ? UP_COLOR : DOWN_COLOR }}>{t.buy ? 'BUY' : 'SELL'} {formatVolume(t.quantity, lotSize, true)} lots</span>
          </div>
        ))}
      </div>
      <Text type="secondary" style={{ fontSize: 10 }}>
        Volume = traded today at that price (sell at bid | buy at ask) · POC = most traded · bold = wall (≥{WALL_FACTOR}× median) · scroll to stop centring
      </Text>
    </Drawer>
  )
}

const ROW_HEIGHT = 20
const columns = (narrow) => (narrow ? '1fr 66px 1fr 0.9fr' : '30px 1fr 74px 1fr 30px 1.1fr')

function LadderHeader({ narrow }) {
  const cells = narrow ? ['Bid', 'Price', 'Ask', 'Volume'] : ['#', 'Bid', 'Price', 'Ask', '#', 'Volume']
  return (
    <div style={{ display: 'grid', gridTemplateColumns: columns(narrow), gap: 4, fontSize: 11, color: AXIS_COLOR, padding: '0 4px' }}>
      {cells.map((c, i) => <span key={i} style={{ textAlign: c === 'Price' ? 'center' : c === 'Bid' || (c === '#' && i === 0) ? 'right' : 'left' }}>{c}</span>)}
    </div>
  )
}

function LadderRow({ row, narrow, vol, stats, isBestBid, isBestAsk, isLtp, isPoc }) {
  const bidWall = row.bid && stats.median > 0 && row.bid.quantity >= WALL_FACTOR * stats.median
  const askWall = row.ask && stats.median > 0 && row.ask.quantity >= WALL_FACTOR * stats.median
  const traded = row.volume ? row.volume.buy + row.volume.sell : 0
  const bar = (quantity, color, alignRight, wall) => (
    <span style={{ position: 'relative', height: ROW_HEIGHT - 4, display: 'block' }}>
      {quantity > 0 && (
        <span style={{
          position: 'absolute', top: 0, bottom: 0, [alignRight ? 'right' : 'left']: 0, width: `${Math.min(100, (quantity / stats.maxBook) * 100)}%`,
          background: wall ? `${color}aa` : `${color}40`, borderRadius: 2,
        }} />
      )}
      {quantity > 0 && (
        <span style={{ position: 'relative', display: 'block', textAlign: alignRight ? 'right' : 'left', padding: '0 3px', fontWeight: wall ? 700 : 400 }}>{vol(quantity)}</span>
      )}
    </span>
  )
  const volumeCell = (
    <span style={{ position: 'relative', height: ROW_HEIGHT - 4, display: 'flex' }}>
      {traded > 0 && (
        <>
          <span style={{ width: `${(row.volume.sell / stats.maxVolume) * 100}%`, background: `${DOWN_COLOR}66` }} />
          <span style={{ width: `${(row.volume.buy / stats.maxVolume) * 100}%`, background: `${UP_COLOR}66` }} />
          <span style={{ position: 'absolute', left: 3, top: 0, fontWeight: isPoc ? 700 : 400 }}>{vol(traded)}{isPoc ? ' POC' : ''}</span>
        </>
      )}
    </span>
  )
  const background = isBestBid ? `${UP_COLOR}22` : isBestAsk ? `${DOWN_COLOR}22` : row.ask ? '#ef53500a' : row.bid ? '#26a69a0a' : 'transparent'
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: columns(narrow), gap: 4, alignItems: 'center', height: ROW_HEIGHT, fontSize: 12, padding: '0 4px',
      background, outline: isLtp ? '1px solid #fadb14' : 'none', outlineOffset: -1, fontVariantNumeric: 'tabular-nums',
    }}>
      {!narrow && <span style={{ color: AXIS_COLOR, textAlign: 'right', fontSize: 10 }}>{row.bid?.orders || ''}</span>}
      {bar(row.bid?.quantity ?? 0, UP_COLOR, true, bidWall)}
      <span style={{ textAlign: 'center', fontWeight: isLtp || isBestBid || isBestAsk ? 700 : 400, color: isLtp ? '#fadb14' : row.ask ? DOWN_COLOR : row.bid ? UP_COLOR : AXIS_COLOR }}>
        {row.price.toFixed(2)}
      </span>
      {bar(row.ask?.quantity ?? 0, DOWN_COLOR, false, askWall)}
      {!narrow && <span style={{ color: AXIS_COLOR, fontSize: 10 }}>{row.ask?.orders || ''}</span>}
      {volumeCell}
    </div>
  )
}
