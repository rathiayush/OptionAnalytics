import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, InputNumber, Segmented, Select, Space, Spin, Tabs, Tag, Tooltip, Typography } from 'antd'
import { DepthHeatmap } from './OrderFlowCharts.jsx'
import { TotalsChart } from './OiTotalsCharts.jsx'
import { useOrderFlowHub } from './OrderFlowPage.jsx'
import {
  OiChangeHeatmapSection, StrikeOiDrilldownChart, aggregateLinePoints, buildOiChangeMatrix, chainOiTotalsHistory, groupByStrike, mergeLiveOptionTicks,
  toSinceOpenSeries, useOiReplayLiveFeed,
} from './OiReplayPage.jsx'
import { applyOrderFlowPush, orderFlowFromSnapshot } from './liveFeeds.js'
import { autoBigLots } from './orderFlowMath.js'
import { buildOiTotalsRows, oiTotalsSeries } from './oiTotalsHeatmap.js'
import { DOWN_COLOR, UP_COLOR, toChartTime, useAuth, usePersistedState } from './shared.jsx'

const { Title, Text } = Typography

// The External account's whole app - the existing charts of the Order Flow page (the liquidity heatmap with its big-order
// dots) and OI Replay (its OI change heatmap card's CE / PE / net totals as numbers or a heatmap with their charts, the
// chain-wide CE / PE OI with its Total / Since open switch, and the net CE − PE cumulative), in tabs (totals, liquidity
// heatmap, chain-wide, net), fed and kept live exactly as those pages do. It reads /api/external/... and the hub's "of:", "c:...:N1" and "u:" feeds only - the server
// refuses this account everything else. Everything is keyed by the index picked, so switching NIFTY / BANKNIFTY never
// shows (or mixes in) the other index's data.
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY']
const ROW_SIZES = [1, 2, 5, 10, 20, 50]
const LIVE_EXPIRY_FLAG = 'N1'
// Live option ticks are applied to the charts at most this often (each recompute covers the whole day).
const OI_PUBLISH_MS = 2_000
const BULLISH = '#3fcf6d'
const BEARISH = '#ff5c5c'

function fmtOi(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v === 0) return '0'
  const a = Math.abs(v)
  const text = a >= 1e5 ? `${(a / 1e5).toFixed(2)}L` : `${(a / 1e3).toFixed(1)}K`
  return `${v > 0 ? '+' : '−'}${text}`
}

// A total (a level, not a change): no sign.
const fmtOiLevel = (v) => (v == null || !Number.isFinite(v) ? '—' : `${(v / 1e5).toFixed(2)}L`)

async function getJson(url) {
  const r = await fetch(url)
  const body = await r.json().catch(() => null)
  if (!r.ok) throw new Error(body?.error || (r.status === 429 ? 'Too many requests - wait a minute.' : `Request failed (HTTP ${r.status}).`))
  return body
}

// One REST load per selection (and "Load again"); a failed load is shown and NOT asked again on its own.
function useLoad(url) {
  const [state, setState] = useState({ url: null, data: null, error: null })
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let cancelled = false
    getJson(url)
      .then((data) => { if (!cancelled) setState({ url, data, error: null }) })
      .catch((err) => { if (!cancelled) setState({ url, data: null, error: err.message }) })
    return () => { cancelled = true }
  }, [url, nonce])
  const current = state.url === url ? state : { data: null, error: null }
  return { ...current, loading: state.url !== url, reload: () => setNonce((n) => n + 1) }
}

function LoadError({ error, onRetry }) {
  return <Alert type="warning" showIcon message={error} action={<Button size="small" onClick={onRetry}>Load again</Button>} style={{ marginBottom: 8 }} />
}


const loadingBox = <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>

export default function ExternalPage() {
  const auth = useAuth()
  const [underlying, setUnderlying] = usePersistedState('optionanalytics.external.underlying', 'NIFTY')
  const [rowSize, setRowSize] = usePersistedState('optionanalytics.external.rowSize', 5)
  // Big order: 'auto' - the top 2.5% of the day's prints (autoBigLots), as the Order Flow page - or the fixed lots.
  const [bigMode, setBigMode] = usePersistedState('optionanalytics.external.bigMode', 'auto')
  const [largeLots, setLargeLots] = usePersistedState('optionanalytics.external.largeLots', 10)
  const [tab, setTab] = usePersistedState('optionanalytics.external.tab', 'totals')
  const u = UNDERLYINGS.includes(underlying) ? underlying : 'NIFTY'
  const row = ROW_SIZES.includes(rowSize) ? rowSize : 5
  const fetchLots = bigMode === 'auto' ? 5 : Math.max(1, largeLots)

  // ---- Liquidity heatmap: the Order Flow page's snapshot, then its live "orderFlowLive" pushes ----
  const flow = useLoad(`/api/external/${u}/order-flow?rowSize=${row}&minTradeLots=${fetchLots}`)
  const [view, setView] = useState({ key: null, data: null })
  const flowKey = `${u}|${row}|${fetchLots}`
  if (flow.data && view.source !== flow.data) setView({ key: flowKey, source: flow.data, data: orderFlowFromSnapshot(flow.data) })
  const data = view.key === flowKey ? view.data : null
  const contextRef = useRef({ securityId: null, row })
  useEffect(() => { contextRef.current = { securityId: data?.meta?.securityId ?? null, row } })
  const onLive = (payload) => {
    if (payload?.meta?.securityId == null || payload.meta.securityId !== contextRef.current.securityId) return
    setView((prev) => (prev.data ? { ...prev, data: applyOrderFlowPush(prev.data, payload, contextRef.current.row) } : prev))
  }
  const liveGroup = data?.meta?.expiry ? `of:${u}:${data.meta.expiry}` : data ? `of:${u}` : null
  const flowConnection = useOrderFlowHub(liveGroup, onLive)
  const lotSize = data?.meta?.lotSize ?? 1
  const autoLots = useMemo(() => autoBigLots(data?.trades ?? [], lotSize), [data?.trades, lotSize])
  const bigLots = bigMode === 'auto' ? autoLots ?? 10 : Math.max(1, largeLots)
  const largeTrades = useMemo(() => (data?.trades ?? []).filter((t) => t.quantity >= bigLots * lotSize), [data?.trades, bigLots, lotSize])

  // ---- OI: OI Replay's today run, then its live "oiReplayTicks" ----
  const oi = useLoad(`/api/external/${u}/oi`)
  const [live, setLive] = useState({ u: null, ce: [], pe: [] })
  const pendingRef = useRef({ ce: [], pe: [] })
  const uRef = useRef(u)
  useEffect(() => { uRef.current = u; pendingRef.current = { ce: [], pe: [] } }, [u])
  const handleOiTicks = (batch) => {
    for (const tick of batch) {
      if (tick?.underlying !== uRef.current || tick?.expiryFlag !== LIVE_EXPIRY_FLAG) continue
      ;(tick.side === 'CE' ? pendingRef.current.ce : pendingRef.current.pe).push(tick)
    }
  }
  useEffect(() => {
    const id = setInterval(() => {
      const { ce, pe } = pendingRef.current
      if (!ce.length && !pe.length) return
      pendingRef.current = { ce: [], pe: [] }
      const owner = uRef.current
      setLive((prev) => {
        const base = prev.u === owner ? prev : { u: owner, ce: [], pe: [] }
        return { u: owner, ce: mergeLiveOptionTicks(base.ce, ce, null), pe: mergeLiveOptionTicks(base.pe, pe, null) }
      })
    }, OI_PUBLISH_MS)
    return () => clearInterval(id)
  }, [])
  // A reconnect may have missed ticks: load the day again once - only after a load that worked.
  const oiReloadRef = useRef(null)
  useEffect(() => { oiReloadRef.current = oi.error ? null : oi.reload })
  const oiConnection = useOiReplayLiveFeed(() => {}, handleOiTicks, null, null, () => oiReloadRef.current?.(), null, u, LIVE_EXPIRY_FLAG)

  // OI Replay's own settings for these cards (the same stored choices).
  const [dayOiChartMode, setDayOiChartMode] = useState('total')

  const liveCe = live.u === u ? live.ce : null
  const livePe = live.u === u ? live.pe : null
  // Each side's strikes, as OI Replay groups them: today's load plus this index's live points since.
  const byStrike = useMemo(() => {
    if (!oi.data) return null
    const ceByStrike = groupByStrike([...(oi.data.cePoints ?? []), ...(liveCe ?? [])])
    const peByStrike = groupByStrike([...(oi.data.pePoints ?? []), ...(livePe ?? [])])
    // Highest strike first, as OI Replay's heatmap.
    const strikes = [...new Set([...ceByStrike.keys(), ...peByStrike.keys()])].sort((a, b) => b - a)
    return { ceByStrike, peByStrike, strikes }
  }, [oi.data, liveCe, livePe])
  const chain = useMemo(() => {
    if (!byStrike) return null
    const { ceByStrike, peByStrike, strikes } = byStrike
    // OI Replay's chain-wide history: one point per minute (its completed minutes), then the latest totals now.
    const minutes = [...new Set([...ceByStrike.values(), ...peByStrike.values()].flatMap((list) => list.map((p) => Math.floor(toChartTime(p.time) / 60) * 60)))].sort((a, b) => a - b)
    const history = chainOiTotalsHistory(ceByStrike, peByStrike, minutes.map((time) => ({ time })), minutes.length)
    const latest = (byS) => [...byS.values()].reduce((sum, list) => sum + (list.at(-1)?.openInterest ?? 0), 0)
    if (minutes.length) history.push({ time: minutes.at(-1), ceTotal: latest(ceByStrike), peTotal: latest(peByStrike) })
    const ceTotal = aggregateLinePoints(history.map((p) => ({ time: p.time, value: p.ceTotal })), 1)
    const peTotal = aggregateLinePoints(history.map((p) => ({ time: p.time, value: p.peTotal })), 1)
    // OI Replay's OI totals (CE / PE / net, each minute's change and its running sum) - the net CE − PE as a chart.
    const totals = oiTotalsSeries(buildOiTotalsRows(
      buildOiChangeMatrix(ceByStrike, strikes, null, 1).perStrikeChange,
      buildOiChangeMatrix(peByStrike, strikes, null, 1).perStrikeChange,
    ))
    return { ceTotal, peTotal, ceSince: toSinceOpenSeries(ceTotal), peSince: toSinceOpenSeries(peTotal), net: totals.net }
  }, [byStrike])
  const dayKey = `${u}-${oi.data?.date ?? ''}`
  const last = (series) => series?.at(-1)?.value
  // `render` runs only once the day's OI is here.
  const oiBody = (render) => (oi.loading && !oi.data ? loadingBox : !byStrike?.strikes.length || !chain ? <Text type="secondary">No OI data yet today.</Text> : render())

  const connectionTag = (state) => (
    <Tag color={state === 'connected' ? 'green' : state === 'reconnecting' || state === 'connecting' ? 'gold' : 'red'} style={{ margin: 0 }}>
      {state === 'connected' ? 'Live' : state}
    </Tag>
  )

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap style={{ justifyContent: 'space-between', width: '100%' }}>
          <Space align="center" size={16} wrap>
            <Title level={3} style={{ margin: 0 }}>Market view</Title>
            <Select value={u} onChange={setUnderlying} style={{ width: 140 }} aria-label="Index"
              options={UNDERLYINGS.map((x) => ({ value: x, label: x }))} />
            <Space size={6}>
              <Text type="secondary">Points</Text>
              <Select value={row} onChange={setRowSize} style={{ width: 90 }} aria-label="Points per row"
                options={ROW_SIZES.map((x) => ({ value: x, label: `${x}` }))} />
            </Space>
            <Tooltip title={bigMode === 'auto'
              ? `Auto: a big order is a print only the top 2.5% of today's prints reach${autoLots ? ` - ${autoLots} lots now` : ' (10 lots until there are enough prints)'}.`
              : 'Fixed: every print of at least this many lots is a big order (a dot on the heatmap).'}>
              <Space.Compact>
                <Select value={bigMode} onChange={setBigMode} style={{ width: 150 }} aria-label="Big order mode"
                  options={[{ value: 'auto', label: 'Big order: Auto' }, { value: 'fixed', label: 'Big order: Fixed' }]} />
                <InputNumber value={bigMode === 'auto' ? bigLots : largeLots} onChange={(v) => setLargeLots(v ?? 10)} min={1}
                  disabled={bigMode === 'auto'} style={{ width: 110 }} addonAfter="lots" aria-label="Big order lots" />
              </Space.Compact>
            </Tooltip>
          </Space>
          <Space>
            <Text type="secondary">{auth?.user?.email}</Text>
            <Button onClick={auth?.logout}>Log out</Button>
          </Space>
        </Space>

        <Tabs activeKey={['totals', 'liquidity', 'chain', 'net'].includes(tab) ? tab : 'totals'} onChange={setTab} destroyOnHidden items={[
          { key: 'totals', label: 'OI totals', children: (
            <Card size="small" title={<Space size={8}>OI totals: CE, PE and Net (CE − PE){connectionTag(oiConnection)}</Space>}>
              {oi.error && <LoadError error={oi.error} onRetry={oi.reload} />}
              {oiBody(() => (
                <OiChangeHeatmapSection ceByStrike={byStrike.ceByStrike} peByStrike={byStrike.peByStrike} strikes={byStrike.strikes}
                  asOfMs={null} live dayKey={dayKey} show="totals" />
              ))}
            </Card>
          ) },
          { key: 'liquidity', label: 'Liquidity heatmap', children: (
            <Card size="small" title={<Space size={8}>{`Liquidity heatmap · ${data?.meta?.contractSymbol ?? `${u} futures`}`}{connectionTag(flowConnection)}</Space>}
              extra={data ? <Text type="secondary" style={{ fontSize: 12 }}>Last {data.meta?.lastPrice?.toLocaleString('en-IN')} · {row} pt rows · dots: {bigLots}+ lots</Text> : null}>
              {flow.error && <LoadError error={flow.error} onRetry={flow.reload} />}
              {flow.loading && !data
                ? loadingBox
                : !data?.heatmap?.length
                  ? <Text type="secondary">No market depth recorded yet today.</Text>
                  : <DepthHeatmap columns={data.heatmap} rowSize={row} trades={largeTrades} icebergs={data.icebergs} lotSize={lotSize} showLots height={460} />}
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
                Time runs left to right, price bottom to top; the colour is the size of resting limit orders at that price. Dots are big orders (green bought, red sold).
              </Text>
            </Card>
          ) },
          { key: 'chain', label: 'Chain-wide OI', children: (
            <Card size="small" title={<Space size={8}>Chain-wide OI{connectionTag(oiConnection)}</Space>}
              extra={chain ? <Space size={12}><Text style={{ color: DOWN_COLOR, fontSize: 12 }}>CE {fmtOiLevel(last(chain.ceTotal))} ({fmtOi(last(chain.ceSince))})</Text><Text style={{ color: UP_COLOR, fontSize: 12 }}>PE {fmtOiLevel(last(chain.peTotal))} ({fmtOi(last(chain.peSince))})</Text></Space> : null}>
              {oi.error && <LoadError error={oi.error} onRetry={oi.reload} />}
              {oiBody(() => (
                <div>
                  <Space align="center" size={12} wrap style={{ marginBottom: 8 }}>
                    <Segmented size="small" value={dayOiChartMode} onChange={setDayOiChartMode}
                      options={[{ label: 'Total OI', value: 'total' }, { label: 'Since open Δ', value: 'sinceOpen' }]} />
                    <Text style={{ color: DOWN_COLOR }}>● CE</Text>
                    <Text style={{ color: UP_COLOR }}>● PE</Text>
                  </Space>
                  <StrikeOiDrilldownChart key={`day-oi-${dayOiChartMode}-${dayKey}`}
                    ceSeries={dayOiChartMode === 'total' ? chain.ceTotal : chain.ceSince}
                    peSeries={dayOiChartMode === 'total' ? chain.peTotal : chain.peSince}
                    mode={dayOiChartMode} dayKey={`day-oi-${dayOiChartMode}-${dayKey}`} height={260} />
                </div>
              ))}
            </Card>
          ) },
          { key: 'net', label: 'Net CE − PE', children: (
            <Card size="small" title="Net CE − PE OI · cumulative"
              extra={chain?.net.cum.length ? <Text style={{ fontSize: 12, color: last(chain.net.cum) < 0 ? BULLISH : last(chain.net.cum) > 0 ? BEARISH : undefined }}>Net {fmtOi(last(chain.net.cum))}</Text> : null}>
              {oiBody(() => chain.net.cum.length > 0 && (
                <TotalsChart cum={chain.net.cum} delta={chain.net.delta} levels={[]} dayKey={`ext-net-${dayKey}`} height={300} format={fmtOi} bullish={BULLISH} bearish={BEARISH} />
              ))}
              <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
                <span style={{ color: BULLISH }}>Green</span> = put writers ahead (bullish), <span style={{ color: BEARISH }}>red</span> = call writers ahead (bearish); bars: each minute&apos;s net change.
              </Text>
            </Card>
          ) },
        ]} />
      </Space>
    </div>
  )
}
