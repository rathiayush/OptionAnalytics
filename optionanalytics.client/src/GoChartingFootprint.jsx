import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Input, Space, Spin, Typography, message } from 'antd'
import { createGoChartingDatafeed, goChartingSymbol, loadGoChartingSdk } from './goChartingSdk.js'

const { Text } = Typography

// The chart type GoCharting's chart reports (its API: activeChart().chartType()).
function chartTypeOf(c) {
  try { return c.activeChart?.()?.chartType?.() ?? c.chart?.()?.chartType?.() ?? null } catch { return null }
}

/**
 * GoCharting's own footprint (cluster) chart - their chart SDK, loaded from GoCharting with the license key
 * saved on the server - fed with our data: today's completed 1-minute bars as history and our live tape as the
 * trades it builds the footprint cells from (price, quantity, buy / sell). The SDK cannot take the per-price
 * volumes of past bars from a custom feed, so the cells show on bars formed while the chart is open.
 */
export function GoChartingFootprint({ underlying, meta, minuteBars, prints, nowMs, isReplay, isAdmin, height = 660, chartKey }) {
  const [sdk, setSdk] = useState(null) // { configured, licenseKey, scriptUrl, fromConfig }
  const [state, setState] = useState({ status: 'idle', error: null })
  const containerRef = useRef(null)
  const sourceRef = useRef({})
  sourceRef.current = { underlying, meta: meta ?? {}, minuteBars: minuteBars ?? [], nowMs: isReplay ? nowMs : null, prints: prints ?? [] }
  const feedRef = useRef(null)
  const lastSeqRef = useRef(0)

  const loadConfig = () => fetch('/api/gocharting/sdk').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then(setSdk).catch((err) => setState({ status: 'error', error: `GoCharting settings could not be read: ${err.message}` }))
  useEffect(() => { loadConfig() }, [])

  // The chart: created once per index / contract / day, destroyed on leaving.
  useEffect(() => {
    const container = containerRef.current
    if (!sdk?.configured || !container || !minuteBars?.length) return undefined
    let cancelled = false
    let chart = null
    let instance = null
    setState({ status: 'loading', error: null })
    loadGoChartingSdk(sdk.scriptUrl).then((GoChartingSDK) => {
      if (cancelled) return
      const feed = createGoChartingDatafeed(() => sourceRef.current)
      feedRef.current = feed
      lastSeqRef.current = Math.max(0, ...(sourceRef.current.prints.map((p) => p.seq ?? 0)))
      chart = GoChartingSDK.createChart(container, {
        symbol: goChartingSymbol(underlying), interval: '1m', datafeed: feed, licenseKey: sdk.licenseKey,
        theme: 'dark', timezone: 'Asia/Kolkata',
        onReady: (c) => {
          instance = c
          if (cancelled) return
          setState({ status: 'ready', error: null })
          // The footprint ("Cluster") chart type - set once the chart has its data (too early and it stays on candles).
          ;(async () => {
            for (let i = 0; i < 20 && !cancelled; i++) {
              try { await c.setChartType?.('FOOTPRINT') } catch { /* not ready yet */ }
              await new Promise((r) => setTimeout(r, 1000))
              if (String(chartTypeOf(c) ?? '').toUpperCase() === 'FOOTPRINT') return
            }
          })()
        },
        onError: (err) => { if (!cancelled) setState({ status: 'error', error: err?.message ?? String(err) }) },
      })
    }).catch((err) => { if (!cancelled) setState({ status: 'error', error: err.message }) })
    return () => {
      cancelled = true
      feedRef.current = null
      for (const c of [instance, chart]) { try { c?.destroy?.() } catch { /* already gone */ } }
      container.innerHTML = ''
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sdk?.configured, sdk?.scriptUrl, chartKey, minuteBars?.length > 0])

  // New live prints -> the chart's trades (a replay is history only).
  useEffect(() => {
    const feed = feedRef.current
    if (!feed || isReplay || !prints?.length) return
    const fresh = prints.filter((p) => (p.seq ?? 0) > lastSeqRef.current)
    if (!fresh.length) return
    lastSeqRef.current = Math.max(lastSeqRef.current, ...fresh.map((p) => p.seq ?? 0))
    feed.push(fresh)
  }, [prints, isReplay])

  if (sdk && !sdk.configured) return <SdkKeyForm isAdmin={isAdmin} onSaved={loadConfig} />
  return (
    <div style={{ position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height }} aria-label="GoCharting footprint" />
      {(state.status === 'loading' || !sdk) && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' }}>
          <Spin tip="Loading GoCharting…" />
        </div>
      )}
      {state.error && <Alert type="error" showIcon style={{ marginTop: 8 }} message="GoCharting's chart could not start" description={state.error} />}
      <Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 4 }}>
        GoCharting&apos;s footprint chart with our data (Dhan futures: today&apos;s 1-minute bars, and the live tape as its trades).
        {isReplay ? ' A replay shows the day\'s bars only - GoCharting builds footprint cells from live trades.' : ' Footprint cells fill in on the bars formed while this chart is open; earlier bars show as candles.'}
        {sdk?.configured && !sdk.fromConfig && isAdmin && <> <a onClick={() => fetch('/api/gocharting/sdk', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ licenseKey: '' }) }).then(loadConfig)}>Remove the license key</a></>}
      </Text>
    </div>
  )
}

function SdkKeyForm({ isAdmin, onSaved }) {
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/gocharting/sdk', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ licenseKey: key }) })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
      message.success('GoCharting license key saved')
      onSaved()
    } catch (err) {
      message.error(err.message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Alert type="info" showIcon message="GoCharting's footprint chart needs a GoCharting SDK license key"
      description={(
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Text style={{ fontSize: 12 }}>
            GoCharting licenses its chart SDK (contact GoCharting - support@gocharting.com). The key is tied to this site&apos;s domain. Once it is saved here, ticking
            GoCharting shows their footprint chart with our data.
          </Text>
          {isAdmin
            ? (
              <Space.Compact style={{ maxWidth: 520, width: '100%' }}>
                <Input placeholder="GoCharting SDK license key" value={key} onChange={(e) => setKey(e.target.value.trim())} aria-label="GoCharting SDK license key" />
                <Button type="primary" onClick={save} loading={saving} disabled={key.length < 8}>Save</Button>
              </Space.Compact>
            )
            : <Text type="secondary" style={{ fontSize: 12 }}>Ask an admin to add it.</Text>}
        </Space>
      )} />
  )
}
