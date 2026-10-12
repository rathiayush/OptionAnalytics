// THE STRATEGY LAB: pick a strategy and an index, start from it as written, as applied, or any setting a tuning run found,
// change its tuned parameters (sides, entry window, stop / target size, time stop, trailing stop, the OI and order-flow
// confirmation, how it is taken in options) and see what that setting would have done on past days - beside the strategy
// as written and as applied now. A server job (the tuning's own day scan and measure - tune.mjs "lab": past days come
// from the cache, so a run normally costs no Dhan calls); nothing is written to the tuning history. Apply it from here.
import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Alert, Button, Card, Col, DatePicker, InputNumber, Progress, Row, Segmented, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd'
import { NavBar, useAuth, UP_COLOR, DOWN_COLOR } from './shared.jsx'
import { ACTIVE_STRATEGIES, SPOT_STRATEGIES, STRATEGY_BY_ID, TRADE_FILTERS } from './strategyEngine.js'
import { OPTION_DEFAULT, labEditableKeys, labParams, optionText, paramsFromFilters, paramsFromSettingsRow, settingSignature, variantText, DEFAULT_VARIANT } from './strategyTuning.js'
import { applyTunedFilters, putOnLiveList } from './scannerSettings.js'
import { ApplyTunedButton } from './ApplyTuned.jsx'

const { Title, Text } = Typography
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX']
const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const col = (v) => (v == null ? undefined : v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined)
const pts = (v) => (v == null ? '-' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}`)
const fmtR = (v) => (v == null ? '-' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}R`)
const pct = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`)
const IST = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })
const hm = (ms) => (ms ? IST.format(new Date(ms)) : '-')

export default function StrategyLabPage() {
  const auth = useAuth()
  const isAdmin = auth?.user?.role === 'Admin'
  const location = useLocation()
  const query = useMemo(() => Object.fromEntries(new URLSearchParams(location.search)), [location.search])
  const initialId = STRATEGY_BY_ID[query.strategy] && !STRATEGY_BY_ID[query.strategy].retired ? query.strategy : 'wallBreak'
  const [data, setData] = useState(STRATEGY_BY_ID[initialId]?.spot ? 'spot' : 'futures')
  const [index, setIndex] = useState(UNDERLYINGS.includes(query.index) ? query.index : 'NIFTY')
  const [id, setId] = useState(initialId)
  const [days, setDays] = useState(30)
  const [range, setRange] = useState(null)
  const [params, setParams] = useState({})
  const [startFrom, setStartFrom] = useState('written')
  const listOf = (d) => (d === 'spot' ? SPOT_STRATEGIES.filter((s) => !s.retired) : ACTIVE_STRATEGIES).map((s) => ({ value: s.id, label: `#${s.no} ${s.name}` }))
  const strategies = listOf(data)
  // Another data mode, index or strategy: the setting starts again from the strategy as written.
  const fresh = () => { setStartFrom('written'); setParams({}) }
  const changeData = (d) => { setData(d); if (!!STRATEGY_BY_ID[id]?.spot !== (d === 'spot')) setId(listOf(d)[0]?.value); fresh() }
  const changeIndex = (u) => { setIndex(u); fresh() }
  const changeId = (x) => { setId(x); fresh() }

  // What it can start from: as written, as applied on this index now, or a setting a tuning run found for this index.
  const [cfg, setCfg] = useState(null)
  const [tuned, setTuned] = useState([])
  useEffect(() => { fetch('/api/scanner-runner/config').then((r) => (r.ok ? r.json() : null)).then(setCfg).catch(() => setCfg(null)) }, [])
  useEffect(() => {
    fetch(`/api/strategy-tuning/performance?data=${data}`).then((r) => (r.ok ? r.json() : null))
      .then((b) => setTuned(b?.rows?.find((r) => r.strategyId === id && r.setting === 'fine-tuned')?.tunedSettings?.[index] ?? []))
      .catch(() => setTuned([]))
  }, [data, id, index])
  const applied = cfg?.filtersByIndex?.[index]?.[id] ?? null
  const starts = [
    { value: 'written', label: 'As written' },
    ...(applied ? [{ value: 'applied', label: `As applied on ${index} now` }] : []),
    ...tuned.map((t, i) => ({ value: `t${i}`, label: `${t.best ? 'Best · ' : ''}${t.row.setting_text || settingSignature(t.row)} (${t.testTrades} unseen trades${t.testAvg == null ? '' : `, ${pts(t.testAvg)}${t.unit === 'pts' ? ' pts' : 'R'}`})` })),
  ]
  const startWith = (v) => {
    setStartFrom(v)
    if (v === 'written') setParams({})
    else if (v === 'applied') setParams(paramsFromFilters(applied))
    else setParams(paramsFromSettingsRow(tuned[Number(v.slice(1))]?.row))
  }

  // The job: started here, watched until it is done, then its result read.
  const [status, setStatus] = useState(null)
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(null)
  const loadResult = () => fetch(`/api/strategy-tuning/lab/${index}?data=${data}`).then((r) => (r.ok ? r.json() : null)).then((r) => setResult(r)).catch(() => setResult(null))
  useEffect(() => { loadResult() }, [index, data]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let stop = false
    const poll = () => fetch('/api/strategy-tuning/status').then((r) => (r.ok ? r.json() : null)).then((s) => {
      if (stop || !s) return
      setStatus((prev) => {
        // A lab run for this index just finished: its result.
        if (prev?.state === 'running' && prev?.job?.what === 'lab' && s.state !== 'running') loadResult()
        return s
      })
    }).catch(() => {})
    poll()
    const t = setInterval(poll, 2500)
    return () => { stop = true; clearInterval(t) }
  }, [index, data]) // eslint-disable-line react-hooks/exhaustive-deps
  const running = status?.state === 'running'
  const labRunning = running && status?.job?.what === 'lab'
  const job = () => ({
    underlying: index, data, strategies: [id], what: 'lab', params: labParams(params, data), minTrades: 2,
    ...(range?.[0] || range?.[1] ? { from: range?.[0]?.format('YYYY-MM-DD') ?? null, to: range?.[1]?.format('YYYY-MM-DD') ?? null, days: 250 } : { days }),
  })
  const run = async () => {
    setBusy(null)
    const res = await fetch('/api/strategy-tuning/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job()) })
    const body = await res.json().catch(() => null)
    if (res.status === 409) { setBusy(body?.error ?? 'another job is running'); return }
    if (!res.ok) { message.error(body?.error ?? `HTTP ${res.status}`); return }
    setStatus(body)
    message.info('Lab run started - past days come from the cache, so it normally takes a minute or two')
  }
  const queue = async () => {
    const res = await fetch('/api/strategy-tuning/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ job: job() }) })
    const body = await res.json().catch(() => null)
    if (!res.ok) { message.error(body?.error ?? `HTTP ${res.status}`); return }
    setBusy(null)
    message.success('Queued - it runs when the current job is done (Strategy tuning → schedule)')
  }
  const set = (k, v) => setParams((p) => ({ ...p, [k]: v }))
  const keys = labEditableKeys(data)
  const opt = params.optLeg === 'buy' || params.optLeg === 'sell'
  const mine = result?.ok && result?.lab && result.strategy?.id === id ? result : null
  const stale = mine && JSON.stringify(labParams(params, data)) !== JSON.stringify(labParams(mine.job?.params ?? {}, data))

  const apply = async (addToLive, lots) => {
    try {
      const p = labParams(params, data)
      await applyTunedFilters(id, { ...DEFAULT_VARIANT, ...OPTION_DEFAULT, ...p }, { option: opt, index, tuned: settingSignature(p) || null, lots })
      if (addToLive) await putOnLiveList(index, id)
      message.success(`#${STRATEGY_BY_ID[id]?.no} ${STRATEGY_BY_ID[id]?.name}: this setting is applied on ${index} - the server scanner runs with it from its next look${addToLive ? `, and it is on ${index}'s live list` : ''}`)
      fetch('/api/scanner-runner/config').then((r) => (r.ok ? r.json() : null)).then(setCfg).catch(() => {})
    } catch (err) { message.error(err.message) }
  }

  return (
    <div className="tuning-page" style={{ maxWidth: 1600, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>
        <Card size="small" title="Strategy lab · change a strategy's tuned settings and see what they would have done">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              The days are scanned exactly as the tuning scans them and the setting is measured with the tuning&apos;s own rules (the same filters, stop / target / trail and
              option exits) - beside the strategy as written and as applied on that index now. Past days come from the cache, so a run normally costs no Dhan calls. Nothing
              is written to the tuning history; apply the setting from here when it is worth it.
            </Text>
            {!isAdmin && <Alert type="warning" showIcon message="Only an Admin can run the lab - sign in with the admin login." />}
            <Row gutter={[10, 8]} align="middle">
              <Col><Segmented value={data} onChange={changeData} options={[{ value: 'futures', label: 'Futures + OI' }, { value: 'spot', label: 'Spot + options' }]} aria-label="Data" /></Col>
              <Col><Select value={index} onChange={changeIndex} options={UNDERLYINGS.map((u) => ({ value: u, label: u }))} style={{ width: 130 }} aria-label="Index" /></Col>
              <Col flex="1 1 300px"><Select showSearch optionFilterProp="label" value={id} onChange={changeId} options={strategies} style={{ width: '100%' }} aria-label="Strategy" /></Col>
              <Col><Space size={4}><Text style={{ fontSize: 12 }}>last</Text><InputNumber min={1} max={250} value={days} onChange={(v) => setDays(v ?? 30)} disabled={!!(range?.[0] || range?.[1])} style={{ width: 80 }} aria-label="Days" /><Text style={{ fontSize: 12 }}>days, or</Text></Space></Col>
              <Col><DatePicker.RangePicker value={range} onChange={setRange} format="DD MMM YYYY" allowEmpty={[true, true]} aria-label="Dates" /></Col>
            </Row>
            <Row gutter={[10, 8]} align="middle">
              <Col><Text style={{ fontSize: 12 }}>Start from</Text></Col>
              <Col flex="1 1 400px"><Select value={startFrom} onChange={startWith} options={starts} style={{ width: '100%' }} aria-label="Start from" /></Col>
              <Col><Button onClick={() => startWith(startFrom)}>Reset to it</Button></Col>
            </Row>
            <Card size="small" type="inner" title="The setting" extra={<Text type="secondary" style={{ fontSize: 12 }}>{variantText({ ...DEFAULT_VARIANT, ...labParams(params, data) })}{opt ? ` · ${optionText({ ...OPTION_DEFAULT, ...labParams(params, data) })}` : ''}</Text>}>
              <Row gutter={[16, 8]}>
                {keys.map((k) => {
                  const f = TRADE_FILTERS.find((x) => x.key === k)
                  const v = params[k] ?? f.default
                  const changed = String(v) !== String(f.default)
                  return (
                    <Col xs={24} md={12} xl={8} key={k}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <Text style={{ fontSize: 12, fontWeight: changed ? 600 : 400 }}>{f.label.replace(/^Trade(?: \(any strategy\))?: /, '').replace(/^Order flow: /, 'Order flow: ')}</Text>
                        {f.type === 'select'
                          ? <Select size="small" value={v} onChange={(x) => set(k, x)} options={f.options} style={{ width: 200, flex: 'none' }} aria-label={k} />
                          : <InputNumber size="small" min={f.min} max={f.max} step={f.step} value={v} onChange={(x) => set(k, x ?? f.default)} style={{ width: 100, flex: 'none' }} aria-label={k} />}
                      </div>
                    </Col>
                  )
                })}
              </Row>
              <Row gutter={[16, 8]} style={{ marginTop: 12 }}>
                <Col xs={24} md={12} xl={8}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <Text style={{ fontSize: 12, fontWeight: opt ? 600 : 400 }}>Option: taken its own way</Text>
                    <Select size="small" value={opt ? params.optLeg : 'none'} onChange={(x) => set('optLeg', x === 'none' ? undefined : x)} style={{ width: 200 }} aria-label="optLeg"
                      options={[{ value: 'none', label: 'No - as the index trade says' }, { value: 'buy', label: 'BUY the option' }, { value: 'sell', label: 'SELL (write) the option' }]} />
                  </div>
                </Col>
                {opt && (
                  <>
                    <Col xs={24} md={12} xl={8}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <Text style={{ fontSize: 12 }}>Option: strike</Text>
                        <Select size="small" value={num(params.optMoneyness) ?? 0} onChange={(x) => set('optMoneyness', x)} style={{ width: 200 }} aria-label="optMoneyness"
                          options={[2, 1, 0, -1, -2].map((m) => ({ value: m, label: m === 0 ? 'ATM' : `${Math.abs(m)} ${m > 0 ? 'in' : 'out of'} the money` }))} />
                      </div>
                    </Col>
                    <Col xs={24} md={12} xl={8}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <Text style={{ fontSize: 12 }}>Option: exit</Text>
                        <Select size="small" value={params.optExit ?? 'index'} onChange={(x) => set('optExit', x)} style={{ width: 200 }} aria-label="optExit"
                          options={[{ value: 'index', label: 'With the index trade' }, { value: 'indexSl', label: 'With the index, Max SL %' }, { value: 'first', label: 'SL % / target %, or the index first' }, { value: 'option', label: 'Its own SL % / target % only' }]} />
                      </div>
                    </Col>
                    {(params.optExit ?? 'index') !== 'index' && (
                      <Col xs={24} md={12} xl={8}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <Text style={{ fontSize: 12 }}>Option: SL % of the premium</Text>
                          <InputNumber size="small" min={5} max={90} step={5} value={num(params.optSlPct) ?? OPTION_DEFAULT.optSlPct} onChange={(x) => set('optSlPct', x)} style={{ width: 100 }} aria-label="optSlPct" />
                        </div>
                      </Col>
                    )}
                    {['first', 'option'].includes(params.optExit) && (
                      <Col xs={24} md={12} xl={8}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                          <Text style={{ fontSize: 12 }}>Option: target % of the premium</Text>
                          <InputNumber size="small" min={5} max={300} step={5} value={num(params.optTargetPct) ?? OPTION_DEFAULT.optTargetPct} onChange={(x) => set('optTargetPct', x)} style={{ width: 100 }} aria-label="optTargetPct" />
                        </div>
                      </Col>
                    )}
                  </>
                )}
              </Row>
            </Card>
            <Space wrap size={10}>
              <Button type="primary" onClick={run} disabled={!isAdmin || running}>Run the lab on {index}</Button>
              {labRunning && (
                <Space size={6}>
                  <Progress type="circle" size={22} percent={status?.progress?.total ? Math.round(((status.progress.done ?? 0) / status.progress.total) * 100) : 0} />
                  <Text style={{ fontSize: 12 }}>{status?.job?.underlying}: {status?.progress?.stage === 'scan' ? `scanning day ${(status.progress.done ?? 0) + 1} of ${status.progress.total}` : status?.progress?.stage ?? 'starting'}…</Text>
                </Space>
              )}
              {running && !labRunning && <Text type="warning" style={{ fontSize: 12 }}>A tuning job for {status?.job?.underlying} is running - the lab can be queued after it.</Text>}
              {(busy || (running && !labRunning)) && isAdmin && <Button onClick={queue}>Queue it after the running job</Button>}
              {busy && <Text type="warning" style={{ fontSize: 12 }}>{busy}</Text>}
              {status?.state === 'failed' && status?.job?.what === 'lab' && <Text type="danger" style={{ fontSize: 12 }}>The last lab run failed: {status.error}</Text>}
            </Space>
          </Space>
        </Card>

        {mine
          ? <LabResult result={mine} stale={stale} index={index} isAdmin={isAdmin} applied={applied} onApply={apply} canApply={isAdmin && !stale}
              liveIndex={cfg?.live?.[index]} indexLots={cfg?.trade?.[index]?.lots ?? null} />
          : result?.ok && result?.lab
            ? <Alert type="info" showIcon message={`The last lab run on ${index} was for #${result.strategy?.no} ${result.strategy?.name} - run it for this strategy to see it here.`} />
            : <Alert type="info" showIcon message={`No lab run for ${index} yet - set the parameters and press Run.`} />}
      </Space>
    </div>
  )
}

function LabResult({ result, stale, index, applied, onApply, canApply, indexLots }) {
  const cols = [
    { key: 'asWritten', title: 'As written', m: result.asWritten },
    ...(result.applied ? [{ key: 'applied', title: `As applied on ${index}`, m: result.applied }] : []),
    { key: 'yours', title: 'Your setting', m: result.yours },
  ]
  const leg = (l) => (l?.n ? <span><b style={{ color: col(l.total) }}>{pts(l.total)}</b> <Text type="secondary" style={{ fontSize: 11 }}>({l.n} · {l.wins}/{l.losses} · captured {pts(l.captured)} / lost {pts(l.lost)})</Text></span> : '-')
  const metrics = [
    { key: 'text', label: 'Setting', render: (m) => <Text style={{ fontSize: 12 }}>{m.text}</Text> },
    { key: 'n', label: 'Trades', render: (m) => m.r.n },
    { key: 'win', label: 'Win rate', render: (m) => pct(m.r.winRate) },
    { key: 'avg', label: 'Avg R a trade', render: (m) => <b style={{ color: col(m.r.avg) }}>{fmtR(m.r.avg)}</b> },
    { key: 'total', label: 'Total R', render: (m) => <span style={{ color: col(m.r.total) }}>{fmtR(m.r.total)}</span> },
    { key: 'pf', label: 'Profit factor', render: (m) => (m.r.pf == null ? '-' : m.r.pf === Infinity || m.r.pf === null ? '∞' : Number(m.r.pf).toFixed(2)) },
    { key: 'dd', label: 'Worst run (R)', render: (m) => (m.r.maxDD ? `-${Number(m.r.maxDD).toFixed(2)}R` : '-') },
    { key: 'idx', label: `${result.data === 'spot' ? 'Spot' : 'Futures'} points`, render: (m) => leg(m.points) },
    { key: 'buy', label: 'Option bought (premium pts)', render: (m) => leg(m.points.buy) },
    { key: 'sell', label: 'Option sold (premium pts)', render: (m) => leg(m.points.sell) },
    { key: 'opt', label: 'The option its own way', render: (m) => (m.option ? <span><Text style={{ fontSize: 12 }}>{m.option.text}</Text><br /><b style={{ color: col(m.option.total) }}>{pts(m.option.total)} pts</b> <Text type="secondary" style={{ fontSize: 11 }}>({m.option.n} trades · win {pct(m.option.winRate)}{m.option.totalR != null ? ` · ${fmtR(m.option.totalR)}` : ''})</Text></span> : '-') },
  ]
  const days = result.days ?? []
  const yours = result.yours
  return (
    <Card size="small" title={<Space size={8} wrap><span>#{result.strategy.no} {result.strategy.name} on {result.underlying}</span><Tag>{days.length} day(s){days.length ? ` · ${days.at(-1).date} to ${days[0].date}` : ''}</Tag>{result.skipped?.length ? <Tooltip title={result.skipped.map((s) => `${s.date}: ${s.reason}`).join('\n')}><Tag color="warning">{result.skipped.length} left out</Tag></Tooltip> : null}<Text type="secondary" style={{ fontSize: 12 }}>run {new Date(result.finishedUtc).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}</Text></Space>}
      extra={(
        <ApplyTunedButton index={index} primary label={`Apply your setting to ${index}`} disabled={!canApply} lots={applied?._lots ?? null} indexLots={indexLots}
          title={`Apply this setting to #${result.strategy.no} ${result.strategy.name} on ${index}?`}
          description={`${yours.text}. The server scanner runs the strategy with it on ${index} from its next look - paper, and live when ${index} is Live today and the strategy is on its live list. What was applied to it on ${index} before is replaced; other indices keep theirs.`}
          onApply={(live, lots) => onApply(live, lots)} />
      )}>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        {stale && <Alert type="warning" showIcon message="The parameters were changed since this run - run the lab again to see the new setting (and to apply it)." />}
        <Table size="small" pagination={false} rowKey="key" dataSource={metrics} scroll={{ x: 900 }} aria-label="Lab comparison"
          columns={[{ title: '', dataIndex: 'label', width: 200, render: (v) => <Text strong style={{ fontSize: 12 }}>{v}</Text> },
            ...cols.map((c) => ({ title: c.title, key: c.key, render: (_, r) => r.render(c.m) }))]} />
        <Text strong style={{ fontSize: 13 }}>Your setting - every trade ({yours.trades.length})</Text>
        <Table size="small" rowKey={(t) => `${t.date}-${t.t}`} dataSource={yours.trades} pagination={{ pageSize: 50, size: 'small' }} scroll={{ x: 1100 }} aria-label="Lab trades"
          columns={[
            { title: 'Date', dataIndex: 'date', width: 100 },
            { title: 'In → out', key: 't', width: 110, render: (_, t) => `${hm(t.t)} → ${t.exitT ? hm(t.exitT) : 'end'}` },
            { title: 'Side', dataIndex: 'side', width: 70, render: (v) => <Tag color={v === 'LONG' ? 'green' : 'red'}>{v}</Tag> },
            { title: 'Index in → out', key: 'p', width: 150, render: (_, t) => `${Number(t.entry).toFixed(1)} → ${Number(t.exit).toFixed(1)}` },
            { title: 'SL / target', key: 'lv', width: 140, render: (_, t) => <span style={{ fontSize: 12 }}>{Number(t.stop).toFixed(1)} / {t.target != null ? Number(t.target).toFixed(1) : '-'}{t.trailed ? ' (trailed)' : ''}</span> },
            { title: 'Points', dataIndex: 'points', width: 80, render: (v) => <b style={{ color: col(v) }}>{pts(v)}</b> },
            { title: 'R', dataIndex: 'r', width: 70, render: (v) => <span style={{ color: col(v) }}>{fmtR(v)}</span> },
            { title: 'Closed by', dataIndex: 'exitReason', width: 110 },
            { title: 'Option bought', key: 'b', width: 170, render: (_, t) => (t.buy ? <span style={{ fontSize: 12 }}>{t.buy.label} <span style={{ color: col(t.buy.points) }}>{pts(t.buy.points)}</span></span> : '-') },
            { title: 'Option sold', key: 's', width: 170, render: (_, t) => (t.sell ? <span style={{ fontSize: 12 }}>{t.sell.label} <span style={{ color: col(t.sell.points) }}>{pts(t.sell.points)}</span></span> : '-') },
          ]} />
        {yours.option && (
          <>
            <Text strong style={{ fontSize: 13 }}>The option its own way - {yours.option.text} ({yours.option.trades.length})</Text>
            <Table size="small" rowKey={(t) => `${t.date}-${t.t}`} dataSource={yours.option.trades} pagination={{ pageSize: 50, size: 'small' }} scroll={{ x: 900 }} aria-label="Lab option trades"
              columns={[
                { title: 'Date', dataIndex: 'date', width: 100 },
                { title: 'In → out', key: 't', width: 110, render: (_, t) => `${hm(t.t)} → ${hm(t.exitT)}` },
                { title: 'Option', key: 'o', width: 170, render: (_, t) => t.opt.label },
                { title: 'Premium in → out', key: 'p', width: 150, render: (_, t) => `${Number(t.opt.entry).toFixed(1)} → ${Number(t.opt.exit).toFixed(1)}` },
                { title: 'Points', key: 'pt', width: 80, render: (_, t) => <b style={{ color: col(t.opt.points) }}>{pts(t.opt.points)}</b> },
                { title: 'R', key: 'r', width: 70, render: (_, t) => <span style={{ color: col(t.opt.r) }}>{fmtR(t.opt.r)}</span> },
                { title: 'Closed by', key: 'c', render: (_, t) => <span style={{ fontSize: 12 }}>{t.opt.reason}</span> },
              ]} />
          </>
        )}
      </Space>
    </Card>
  )
}
