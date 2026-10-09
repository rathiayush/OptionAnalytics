import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, Col, InputNumber, Popconfirm, Progress, Row, Segmented, Select, Space, Switch, Table, Tag, Tooltip, Typography, message } from 'antd'
import { NavBar, useAuth, UP_COLOR, DOWN_COLOR } from './shared.jsx'
import { ACTIVE_STRATEGIES, STRATEGY_BY_ID } from './strategyEngine.js'
import { OI_FACTORS, variantText } from './strategyTuning.js'
import { applyTunedFilters } from './scannerSettings.js'

const { Title, Text } = Typography
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX']
const POLL_MS = 3_000
const fmtR = (v) => (v == null || !Number.isFinite(v) ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`)
const colR = (v) => (v == null ? undefined : v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined)
const pct = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`)
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-')

/** n · avg · total · win% of one side of a result. */
function Score({ s }) {
  if (!s?.n) return <Text type="secondary">no trades</Text>
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {s.n} trades · <b style={{ color: colR(s.avg) }}>{fmtR(s.avg)}</b>/trade · <span style={{ color: colR(s.total) }}>{fmtR(s.total)}</span> · win {pct(s.winRate)}
    </span>
  )
}

/**
 * Strategy tuning: for each strategy (the top 3 by default), every combination of its trade filters - long /
 * short only, the entry window, stop / target size, time stop, trailing stop - tried on the past days the
 * server holds (scanner-runner/tune.mjs). Chosen on the older 70% of the days, checked on the newest 30%;
 * applied to the scanner's filters with one click.
 */
export default function StrategyTuningPage() {
  const auth = useAuth()
  const isAdmin = auth?.user?.role === 'Admin'
  const [underlying, setUnderlying] = useState('NIFTY')
  const [pick, setPick] = useState('top3')
  const [custom, setCustom] = useState([])
  const [days, setDays] = useState(30)
  const [includeEstimated, setIncludeEstimated] = useState(false)
  const [minTrades, setMinTrades] = useState(8)
  const [what, setWhat] = useState('both')
  const [oiFactors, setOiFactors] = useState(OI_FACTORS.map((f) => f.key))
  const [status, setStatus] = useState(null)
  const [result, setResult] = useState(null)
  const [resultError, setResultError] = useState(null)

  const loadResult = (u = underlying) => fetch(`/api/strategy-tuning/result/${u}`)
    .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`))))
    .then((x) => { setResult(x); setResultError(null) })
    .catch((err) => { setResult(null); setResultError(err.message) })
  const loadStatus = () => fetch('/api/strategy-tuning/status').then((r) => (r.ok ? r.json() : null)).then((s) => { if (s) setStatus(s) }).catch(() => {})
  useEffect(() => { loadResult(underlying) }, [underlying]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    loadStatus()
    const id = setInterval(loadStatus, POLL_MS)
    return () => clearInterval(id)
  }, [])
  // A job that just finished: show its result.
  const lastStateRef = useRef(null)
  useEffect(() => {
    if (!status) return
    if (lastStateRef.current === 'running' && status.state !== 'running' && status.job?.underlying) loadResult(status.job.underlying)
    lastStateRef.current = status.state
  }, [status?.state]) // eslint-disable-line react-hooks/exhaustive-deps

  const running = status?.state === 'running'
  const start = async () => {
    const body = { underlying, strategies: pick === 'custom' ? custom : pick, days, includeEstimated, minTrades, what, oiFactors }
    const res = await fetch('/api/strategy-tuning/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const json = await res.json().catch(() => null)
    if (!res.ok) { message.error(json?.error ?? `HTTP ${res.status}`); return }
    setStatus(json)
    message.success(`Tuning ${underlying} started`)
  }
  const cancel = () => fetch('/api/strategy-tuning/cancel', { method: 'POST' }).then(loadStatus)
  const apply = async (r) => {
    try {
      const filters = await applyTunedFilters(r.id, r.best.params)
      message.success(`#${r.no} ${r.name}: ${Object.keys(filters).length ? variantText(r.best.params) : 'back to its defaults'} - saved to the scanner (this browser and the server scanner)`)
    } catch (err) {
      message.error(err.message)
    }
  }

  const p = status?.progress
  const progressText = !p ? 'starting…' : p.stage === 'scan' ? `scanning ${p.day} (${p.done + 1} of ${p.total} days)` : p.stage === 'rank' ? 'ranking the strategies' : p.stage === 'tune' ? `tuning #${STRATEGY_BY_ID[p.strategy]?.no} ${STRATEGY_BY_ID[p.strategy]?.name ?? p.strategy} (${p.done + 1} of ${p.total})` : p.stage
  const percent = !p ? 0 : p.stage === 'scan' ? Math.round((p.done / Math.max(1, p.total)) * 80) : p.stage === 'rank' ? 80 : p.stage === 'tune' ? 80 + Math.round((p.done / Math.max(1, p.total)) * 20) : 100

  const tuned = new Set((result?.results ?? []).map((r) => r.id))
  const rankedColumns = [
    { title: '#', dataIndex: 'no', width: 40 },
    { title: 'Strategy (as written)', dataIndex: 'name', render: (v, r) => <span>{v}{tuned.has(r.id) && <Tag color="blue" style={{ marginLeft: 6 }}>tuned below</Tag>}</span> },
    { title: 'Trades', dataIndex: 'n', width: 70 },
    { title: 'Avg R', dataIndex: 'avg', width: 80, render: (v) => <span style={{ color: colR(v) }}>{fmtR(v)}</span> },
    { title: 'Total R', dataIndex: 'total', width: 84, render: (v, r) => (r.n ? <span style={{ color: colR(v) }}>{fmtR(v)}</span> : '-') },
    { title: 'Win %', dataIndex: 'winRate', width: 66, render: pct },
    { title: <Tooltip title="Average R minus one standard error - rewards strategies that win consistently, not on one lucky day">Score</Tooltip>, dataIndex: 'score', width: 80, render: (v) => fmtR(v) },
  ]
  const topColumns = [
    { title: 'Setting', key: 'p', render: (_, row) => <span style={{ fontSize: 12 }}>{variantText(row.params)}</span> },
    { title: 'Train (older days)', key: 'tr', render: (_, row) => <Score s={row.train} /> },
    { title: 'Test (newest days)', key: 'te', render: (_, row) => <Score s={row.test} /> },
  ]

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>
        <Card size="small" title="Strategy tuning">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Finds the settings each strategy does best with: every past day is scanned once with the strategies&apos; rules, then the ways its
              trades can be taken are tried on those signals exactly as the scanner would take them, scored in R on the futures - the OI confirmation
              (options OI change and futures OI on 1, 3, 5 or 15 minutes, options OI since the open, room to the next OI wall) and the trade settings
              (7,200: long / short only, the entry time window, stop-loss and target size, a time stop, the trailing stop). To avoid fitting the past, a setting is chosen on the older 70% of
              the days and checked on the newest 30% it never saw; it is recommended only when it also wins there and beats the strategy as written.
              The strategy&apos;s entry rules are not changed. Runs on the server - you can leave the page.
            </Text>
            <Row gutter={[16, 8]} align="middle">
              <Col><Space size={6}><Text>Index</Text><Select value={underlying} onChange={setUnderlying} options={UNDERLYINGS.map((u) => ({ value: u, label: u }))} style={{ width: 130 }} disabled={running} /></Space></Col>
              <Col><Space size={6}><Text>Strategies</Text><Segmented value={pick} onChange={setPick} disabled={running} options={[{ value: 'top3', label: 'Top 3' }, { value: 'top5', label: 'Top 5' }, { value: 'all', label: 'All' }, { value: 'custom', label: 'Pick' }]} /></Space></Col>
              {pick === 'custom' && (
                <Col flex="1 1 320px">
                  <Select mode="multiple" value={custom} onChange={setCustom} placeholder="Strategies to tune" style={{ width: '100%' }} disabled={running} maxTagCount="responsive"
                    options={ACTIVE_STRATEGIES.map((s) => ({ value: s.id, label: `#${s.no} ${s.name}` }))} />
                </Col>
              )}
              <Col><Space size={6}><Text>Tune</Text><Segmented value={what} onChange={setWhat} disabled={running} options={[
                { value: 'both', label: <Tooltip title="The OI confirmation first, then the trade settings on top of the best one">OI, then trade</Tooltip> },
                { value: 'oi', label: <Tooltip title="Options OI change (15 min) and since the open, futures OI, room to the next OI wall - the trade settings as they are">OI confirmation</Tooltip> },
                { value: 'trade', label: <Tooltip title="Sides, entry window, stop / target size, time stop, trailing stop">Trade settings</Tooltip> },
              ]} /></Space></Col>
              {what !== 'trade' && (
                <Col flex="1 1 100%">
                  <Space size={6} wrap align="start">
                    <Text>OI to tune</Text>
                    <Checkbox.Group value={oiFactors} onChange={setOiFactors} disabled={running} options={OI_FACTORS.map((f) => ({ value: f.key, label: f.label }))} />
                  </Space>
                </Col>
              )}
              <Col><Space size={6}><Tooltip title="The most recent past days the server can replay"><Text>Days</Text></Tooltip><InputNumber min={1} max={250} value={days} onChange={(v) => v && setDays(v)} style={{ width: 80 }} disabled={running} /></Space></Col>
              <Col><Space size={6}><Tooltip title="A setting needs at least this many trades on the train days to be considered"><Text>Min trades</Text></Tooltip><InputNumber min={2} max={100} value={minTrades} onChange={(v) => v && setMinTrades(v)} style={{ width: 70 }} disabled={running} /></Space></Col>
              <Col><Tooltip title="Also use days the server did not record live, rebuilt from 1-minute candles (no tape or market depth - the order-flow checks are estimated). More days, less exact."><Space size={6}><Switch size="small" checked={includeEstimated} onChange={setIncludeEstimated} disabled={running} /><Text>Include estimated days</Text></Space></Tooltip></Col>
              <Col>
                {running
                  ? <Popconfirm title="Stop the tuning job?" onConfirm={cancel} disabled={!isAdmin}><Button danger disabled={!isAdmin}>Stop</Button></Popconfirm>
                  : <Button type="primary" onClick={start} disabled={!isAdmin || (pick === 'custom' && !custom.length) || (what !== 'trade' && !oiFactors.length)}>Run tuning</Button>}
              </Col>
            </Row>
            {!isAdmin && <Alert type="info" showIcon message="Only an admin can run a tuning job or apply a result." />}
            {running && (
              <div>
                <Text style={{ fontSize: 12 }}>{status.job?.underlying}: {progressText} · started {when(status.startedUtc)}</Text>
                <Progress percent={percent} size="small" status="active" />
              </div>
            )}
            {status?.state === 'failed' && <Alert type="error" showIcon message={`The last tuning job failed: ${status.error}`} />}
            {status?.state === 'cancelled' && <Alert type="warning" showIcon message="The last tuning job was stopped." />}
          </Space>
        </Card>

        {result && (
          <>
            <Card size="small" title={`${result.underlying} · ${result.days?.length ?? 0} day(s) · finished ${when(result.finishedUtc)}`}
              extra={<Text type="secondary" style={{ fontSize: 11 }}>{result.what ? `tuned: ${{ both: 'OI, then trade', oi: 'OI confirmation', trade: 'trade settings' }[result.what] ?? result.what} · ` : ''}{result.days?.filter((d) => d.estimated).length ? `${result.days.filter((d) => d.estimated).length} estimated day(s) · ` : ''}min {result.minTrades} trades · {result.days?.[result.days.length - 1]?.date} to {result.days?.[0]?.date}</Text>}>
              {result.skipped?.length > 0 && <Alert type="warning" showIcon style={{ marginBottom: 8 }} message={`${result.skipped.length} day(s) could not be scanned`} description={result.skipped.slice(0, 5).map((s) => `${s.date}: ${s.reason}`).join(' · ')} />}
              <Table size="small" rowKey="id" columns={rankedColumns} dataSource={result.ranked ?? []} pagination={false} scroll={{ y: 320 }} />
            </Card>
            {(result.results ?? []).map((r) => (
              <Card key={r.id} size="small"
                title={<Space size={8} wrap><span>#{r.no} {r.name}</span>{r.recommend ? <Tag color="success">recommended</Tag> : <Tag color="warning">keep as written</Tag>}</Space>}
                extra={isAdmin && r.best && (
                  <Popconfirm title={`Apply to #${r.no} ${r.name}?`} description={r.recommend ? variantText(r.best.params) : `Not recommended: ${r.reason}. Apply anyway?`} okText="Apply" onConfirm={() => apply(r)}>
                    <Button size="small" type={r.recommend ? 'primary' : 'default'}>Apply to the scanner</Button>
                  </Popconfirm>
                )}>
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Text style={{ fontSize: 12 }}>{r.reason}. Chosen on {r.trainDays?.length} day(s) ({r.trainDays?.[0]} to {r.trainDays?.at(-1)}), checked on {r.testDays?.length} ({r.testDays?.[0] ?? '-'} to {r.testDays?.at(-1) ?? '-'}). {r.qualified} of {r.tried} settings had {result.minTrades}+ trades.</Text>
                  <Table size="small" pagination={false} rowKey="k" columns={[
                    { title: '', dataIndex: 'k', width: 120, render: (k) => <b>{k}</b> },
                    { title: 'Setting', key: 'p', render: (_, row) => <span style={{ fontSize: 12 }}>{row.params ? variantText(row.params) : '-'}</span> },
                    { title: 'Train (older days)', key: 'tr', render: (_, row) => <Score s={row.train} /> },
                    { title: 'Test (newest days)', key: 'te', render: (_, row) => <Score s={row.test} /> },
                  ]} dataSource={[{ k: 'As written', ...r.baseline }, ...(r.best ? [{ k: 'Best setting', ...r.best }] : [])]} />
                  {r.top?.length > 1 && (
                    <details>
                      <summary style={{ cursor: 'pointer', fontSize: 12 }}>The {r.top.length} best settings on the train days</summary>
                      <Table size="small" pagination={false} rowKey={(row) => variantText(row.params)} columns={topColumns} dataSource={r.top} style={{ marginTop: 6 }} />
                    </details>
                  )}
                </Space>
              </Card>
            ))}
          </>
        )}
        {!result && resultError && !running && <Alert type="info" showIcon message={resultError} description="Run a tuning job to see which settings each strategy does best with." />}
      </Space>
    </div>
  )
}
