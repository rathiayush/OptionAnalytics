import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Select, Space, Spin, Typography } from 'antd'
import { DepthHeatmap } from './OrderFlowCharts.jsx'
import { TotalsChart } from './OiTotalsCharts.jsx'
import { toColumn } from './liveFeeds.js'
import { oiMeaning } from './oiTotalsHeatmap.js'
import { toChartTime, useAuth, usePersistedState } from './shared.jsx'

const { Title, Text } = Typography

// The External account's whole app: the near futures' liquidity heatmap and today's net CE − PE OI (OI Replay's
// totals), NIFTY or BANKNIFTY. It reads /api/external/... only - the server refuses this account everything else.
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY']
const ROW_SIZES = [1, 2, 5, 10, 20, 50]
const HEATMAP_REFRESH_MS = 10_000
const OI_REFRESH_MS = 60_000
const BULLISH = '#3fcf6d'
const BEARISH = '#ff5c5c'

function fmtOi(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v === 0) return '0'
  const a = Math.abs(v)
  const text = a >= 1e5 ? `${(a / 1e5).toFixed(2)}L` : `${(a / 1e3).toFixed(1)}K`
  return `${v > 0 ? '+' : '−'}${text}`
}

async function getJson(url) {
  const r = await fetch(url)
  const body = await r.json().catch(() => null)
  if (!r.ok) throw new Error(body?.error || (r.status === 429 ? 'Too many requests - wait a minute.' : `Request failed (HTTP ${r.status}).`))
  return body
}

// Asks `url` now and every `everyMs` while it answers; a failed answer is shown and NOT asked again on its own -
// "Load again" (or another index / row size) asks once more.
function useExternalData(url, everyMs) {
  const [state, setState] = useState({ url: null, data: null, error: null })
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let cancelled = false
    let timer = null
    const load = () => getJson(url)
      .then((data) => {
        if (cancelled) return
        setState({ url, data, error: null })
        timer = setTimeout(load, everyMs)
      })
      .catch((err) => { if (!cancelled) setState((prev) => ({ url, data: prev.url === url ? prev.data : null, error: err.message })) })
    load()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [url, everyMs, nonce])
  const current = state.url === url ? state : { data: null, error: null }
  return { ...current, loading: state.url !== url, reload: () => setNonce((n) => n + 1) }
}

export default function ExternalPage() {
  const auth = useAuth()
  const [underlying, setUnderlying] = usePersistedState('optionanalytics.external.underlying', 'NIFTY')
  const [rowSize, setRowSize] = usePersistedState('optionanalytics.external.rowSize', 5)
  const u = UNDERLYINGS.includes(underlying) ? underlying : 'NIFTY'
  const row = ROW_SIZES.includes(rowSize) ? rowSize : 5

  const heat = useExternalData(`/api/external/${u}/heatmap?rowSize=${row}`, HEATMAP_REFRESH_MS)
  const oi = useExternalData(`/api/external/${u}/oi-net`, OI_REFRESH_MS)

  const columns = useMemo(() => (heat.data?.heatmap ?? []).map(toColumn), [heat.data])
  const net = useMemo(() => {
    const minutes = oi.data?.minutes ?? []
    const point = (m, key, value) => ({ time: toChartTime(m.time), value, meaning: oiMeaning(key, value) })
    return {
      cum: minutes.map((m) => point(m, 'netCum', m.netCum)),
      delta: minutes.map((m) => point(m, 'netDelta', m.netDelta)),
      last: minutes.at(-1) ?? null,
    }
  }, [oi.data])

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
          </Space>
          <Space>
            <Text type="secondary">{auth?.user?.email}</Text>
            <Button onClick={auth?.logout}>Log out</Button>
          </Space>
        </Space>

        <Card size="small" title={`Liquidity heatmap · ${heat.data?.contract ?? `${u} futures`}`}
          extra={heat.data ? <Text type="secondary" style={{ fontSize: 12 }}>Last {heat.data.lastPrice?.toLocaleString('en-IN')} · {row} pt rows</Text> : null}>
          {heat.error && <Alert type="warning" showIcon message={heat.error} action={<Button size="small" onClick={heat.reload}>Load again</Button>} style={{ marginBottom: 8 }} />}
          {heat.loading && !heat.data
            ? <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>
            : columns.length === 0
              ? <Text type="secondary">No market depth recorded yet today.</Text>
              : <DepthHeatmap columns={columns} rowSize={row} trades={[]} icebergs={[]} lotSize={heat.data?.lotSize ?? 1} showLots height={460} />}
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
            Time runs left to right, price bottom to top; the colour is the size of resting limit orders at that price.
          </Text>
        </Card>

        <Card size="small" title="Net CE − PE OI · cumulative (today)"
          extra={net.last ? <Text style={{ fontSize: 12, color: net.last.netCum < 0 ? BULLISH : net.last.netCum > 0 ? BEARISH : undefined }}>Net {fmtOi(net.last.netCum)} · CE {fmtOi(net.last.ceCum)} · PE {fmtOi(net.last.peCum)}</Text> : null}>
          {oi.error && <Alert type="warning" showIcon message={oi.error} action={<Button size="small" onClick={oi.reload}>Load again</Button>} style={{ marginBottom: 8 }} />}
          {oi.loading && !oi.data
            ? <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>
            : net.cum.length === 0
              ? <Text type="secondary">No OI data yet today.</Text>
              : <TotalsChart cum={net.cum} delta={net.delta} levels={[]} dayKey={`${u}-${oi.data?.date}`} height={320} format={fmtOi} bullish={BULLISH} bearish={BEARISH} />}
          <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
            Line: CE OI change minus PE OI change since the open, over the ATM ± 10 strike band; bars: each minute&apos;s net change.
            <span style={{ color: BULLISH }}> Green</span> = put writers ahead (bullish), <span style={{ color: BEARISH }}>red</span> = call writers ahead (bearish).
          </Text>
        </Card>
      </Space>
    </div>
  )
}
