// THE STRATEGY LAB: pick a strategy and an index - or several of each - start from it as written, as applied, or any setting a tuning run found,
// change its tuned parameters (sides, entry window, stop / target size, time stop, trailing stop, the OI and order-flow
// confirmation, how it is taken in options) and see what that setting would have done on past days - beside the strategy
// as written and as applied now. A server job (the tuning's own day scan and measure - tune.mjs "lab": past days come
// from the cache, so a run normally costs no Dhan calls); nothing is written to the tuning history. Apply it from here.
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Alert, Button, Card, Col, DatePicker, InputNumber, Progress, Row, Segmented, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd'
import { NavBar, useAuth, UP_COLOR, DOWN_COLOR } from './shared.jsx'
import { ACTIVE_STRATEGIES, SPOT_STRATEGIES, STRATEGY_BY_ID, TRADE_FILTERS } from './strategyEngine.js'
import { OPTION_DEFAULT, labEditableKeys, labOverrides, labParams, optionText, paramsFromFilters, paramsFromSettingsRow, settingSignature, sumPoints, variantText, DEFAULT_VARIANT } from './strategyTuning.js'
import { applyTunedFilters, putOnLiveList } from './scannerSettings.js'
import { ApplyTunedButton } from './ApplyTuned.jsx'
import AppliedLab from './AppliedLab.jsx'

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
  const initialId = STRATEGY_BY_ID[query.strategy] && !STRATEGY_BY_ID[query.strategy].retired ? query.strategy : null
  const [data, setData] = useState(STRATEGY_BY_ID[initialId]?.spot ? 'spot' : 'futures')
  // One index and one strategy, or several of each: one job per index, every strategy measured in it.
  const [indices, setIndices] = useState([UNDERLYINGS.includes(query.index) ? query.index : 'NIFTY'])
  const [ids, setIds] = useState([initialId])
  const [days, setDays] = useState(30)
  const [range, setRange] = useState(null)
  const [params, setParams] = useState({})
  const [startFrom, setStartFrom] = useState('written')
  // What opens: the one-click "what is applied, on older days". The setting editor is for trying a different setting - and for a
  // link that names a strategy (Strategies / Trades pages).
  const [mode, setMode] = useState(query.strategy || query.mode === 'try' ? 'try' : 'applied')
  const single = indices.length === 1 && ids.length === 1
  const index = indices[0]
  const id = ids[0]
  const listOf = (d) => (d === 'spot' ? SPOT_STRATEGIES.filter((s) => !s.retired) : ACTIVE_STRATEGIES).map((s) => ({ value: s.id, label: `#${s.no} ${s.name}` }))
  const strategies = listOf(data)
  // One strategy on one index: the setting is the WHOLE setting, started from as written / as applied / a tuning run's.
  // Several: the setting is the CHANGES put on top of each one's own start (as written, or as applied on each index).
  // Going from one to the other starts the setting again; within several the changes are kept.
  const fresh = (toSingle) => { setStartFrom(!toSingle && startFrom === 'applied' ? 'applied' : 'written'); setParams({}) }
  const changeData = (d) => {
    setData(d)
    setLaunched({}) // the other mode's results are its own
    const kept = ids.filter((x) => !!STRATEGY_BY_ID[x]?.spot === (d === 'spot'))
    setIds(kept.length ? kept : [listOf(d)[0]?.value])
    setStartFrom('written'); setParams({})
  }
  const changeSelection = (nextIndices, nextIds) => {
    const nowSingle = nextIndices.length === 1 && nextIds.length === 1
    if (nowSingle || nowSingle !== single) fresh(nowSingle)
    setIndices(nextIndices); setIds(nextIds)
  }
  const changeIndices = (v) => { if (v.length) changeSelection(UNDERLYINGS.filter((u) => v.includes(u)), ids) }
  const changeIds = (v) => { if (v.length) changeSelection(indices, v.slice(0, 40)) }

  // What it can start from: as written, as applied on this index now, or a setting a tuning run found for this index.
  const [cfg, setCfg] = useState(null)
  const [tunedRuns, setTuned] = useState([])
  useEffect(() => { fetch('/api/scanner-runner/config').then((r) => (r.ok ? r.json() : null)).then(setCfg).catch(() => setCfg(null)) }, [])
  useEffect(() => {
    if (!single) return
    fetch(`/api/strategy-tuning/performance?data=${data}`).then((r) => (r.ok ? r.json() : null))
      .then((b) => setTuned(b?.rows?.find((r) => r.strategyId === id && r.setting === 'fine-tuned')?.tunedSettings?.[index] ?? []))
      .catch(() => setTuned([]))
  }, [data, id, index, single])
  // A tuning run's settings to start from - one strategy on one index only.
  const tuned = single ? tunedRuns : []
  const appliedOf = (u, x) => cfg?.filtersByIndex?.[u]?.[x] ?? null
  const applied = appliedOf(index, id)
  const starts = single
    ? [
        { value: 'written', label: 'As written' },
        ...(applied ? [{ value: 'applied', label: `As applied on ${index} now` }] : []),
        ...tuned.map((t, i) => ({ value: `t${i}`, label: `${t.best ? 'Best · ' : ''}${t.row.setting_text || settingSignature(t.row)} (${t.testTrades} unseen trades${t.testAvg == null ? '' : `, ${pts(t.testAvg)}${t.unit === 'pts' ? ' pts' : 'R'}`})` })),
      ]
    : [
        { value: 'written', label: 'As written - each strategy' },
        { value: 'applied', label: 'As applied - each strategy its own setting on each index (as written where none)' },
      ]
  const startWith = (v) => {
    setStartFrom(v)
    if (!single || v === 'written') setParams({})
    else if (v === 'applied') setParams(paramsFromFilters(applied))
    else setParams(paramsFromSettingsRow(tuned[Number(v.slice(1))]?.row))
  }

  // The jobs: started here (the first index now, the others queued behind it), watched until done, then their results read.
  const [status, setStatus] = useState(null)
  const [results, setResults] = useState({})
  const [busy, setBusy] = useState(null)
  const [picked, setPicked] = useState(null)
  // The indices this page has started (or queued) a run for: { [index]: the finishedUtc of its result when it was started }
  // - until its result is a newer one, what is shown for it is the PREVIOUS run's: marked "updating", out of the totals.
  const [launched, setLaunched] = useState({})
  const launch = (list) => setLaunched((l) => ({ ...l, ...Object.fromEntries(list.map((u) => [u, results[u]?.finishedUtc ?? null])) }))
  const loadResults = () => Promise.all(UNDERLYINGS.map((u) => fetch(`/api/strategy-tuning/lab/${u}?data=${data}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)))
    .then((list) => setResults(Object.fromEntries(UNDERLYINGS.map((u, i) => [u, list[i]]))))
  useEffect(() => { loadResults() }, [data]) // eslint-disable-line react-hooks/exhaustive-deps
  // The job as last seen: any change of it - a lab run done, failed or stopped, the next index's starting - reads the
  // results again (a run that ended between two looks, or one index's following another, is never missed).
  const lastJob = useRef(null)
  useEffect(() => {
    let stop = false
    const poll = () => fetch('/api/strategy-tuning/status', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((s) => {
      if (stop || !s) return
      const key = `${s.state}|${s.job?.what}|${s.job?.underlying}|${s.startedUtc ?? ''}|${s.finishedUtc ?? ''}`
      const was = lastJob.current
      lastJob.current = key
      if (was != null && was !== key && (s.job?.what === 'lab' || was.split('|')[1] === 'lab')) loadResults()
      setStatus(s)
    }).catch(() => {})
    poll()
    const t = setInterval(poll, 2500)
    return () => { stop = true; clearInterval(t) }
  }, [data]) // eslint-disable-line react-hooks/exhaustive-deps
  // While an index started from here has no new result yet, the results are read again now and then too.
  const waiting = Object.entries(launched).some(([u, before]) => (results[u]?.finishedUtc ?? null) === before)
  useEffect(() => {
    if (!waiting) return undefined
    const t = setInterval(loadResults, 20_000)
    return () => clearInterval(t)
  }, [waiting, data]) // eslint-disable-line react-hooks/exhaustive-deps
  const running = status?.state === 'running'
  const labRunning = running && status?.job?.what === 'lab'
  const sent = () => (single ? { params: labParams(params, data) } : { params: labOverrides(params, data), labBase: startFrom === 'applied' ? 'applied' : 'written' })
  const job = (u) => ({
    underlying: u, data, strategies: ids, what: 'lab', ...sent(), minTrades: 2,
    ...(range?.[0] || range?.[1] ? { from: range?.[0]?.format('YYYY-MM-DD') ?? null, to: range?.[1]?.format('YYYY-MM-DD') ?? null, days: 250 } : { days }),
  })
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (res) => ({ res, body: await res.json().catch(() => null) }))
  const queueOf = async (list) => {
    const { res, body } = await post('/api/strategy-tuning/queue', { job: job(list[0]), underlyings: list })
    if (!res.ok) { message.error(body?.error ?? `HTTP ${res.status}`); return false }
    return true
  }
  const what = `${ids.length > 1 ? `${ids.length} strategies` : `#${STRATEGY_BY_ID[id]?.no} ${STRATEGY_BY_ID[id]?.short ?? STRATEGY_BY_ID[id]?.name}`}`
  const run = async () => {
    setBusy(null)
    const { res, body } = await post('/api/strategy-tuning/run', job(indices[0]))
    if (res.status === 409) { setBusy(body?.error ?? 'another job is running'); return }
    if (!res.ok) { message.error(body?.error ?? `HTTP ${res.status}`); return }
    setStatus(body)
    launch(indices.slice(0, 1))
    const rest = indices.slice(1)
    if (rest.length && !(await queueOf(rest))) return
    launch(rest)
    message.info(rest.length
      ? `Lab run started on ${indices[0]} (${what}); ${rest.join(', ')} queued right after it - past days come from the cache`
      : `Lab run started (${what}) - past days come from the cache, so it normally takes a minute or two`)
  }
  const queue = async () => {
    if (!(await queueOf(indices))) return
    launch(indices)
    setBusy(null)
    message.success(`Queued for ${indices.join(', ')} - it runs when the current job is done (Strategy tuning → schedule)`)
  }
  const set = (k, v) => setParams((p) => ({ ...p, [k]: v }))
  const keys = labEditableKeys(data)
  const opt = params.optLeg === 'buy' || params.optLeg === 'sell'
  const shown = labParams(params, data)

  // Every index × strategy picked, with its last lab result (or none yet).
  const entriesOf = (r) => (r?.ok && r?.lab ? (r.results ?? (r.strategy ? [{ strategy: r.strategy, base: 'written', asWritten: r.asWritten, applied: r.applied, yours: r.yours }] : [])) : [])
  // What a run measured: the setting (and its start, with several), and its days - the last N, or the dates. A result of
  // another setting or other days is an OLDER run's, never this one's.
  const runKey = (j) => JSON.stringify({ ...(single ? { params: j?.params ?? {} } : { params: j?.params ?? {}, labBase: j?.labBase ?? 'written' }),
    ...(j?.from || j?.to ? { from: j?.from || null, to: j?.to || null } : { days: Number(j?.days) || 30 }) })
  const nowSent = runKey({ ...sent(), ...job(index) })
  const sentOf = (r) => runKey(r?.job)
  /** Where an index's result stands: 'updating' (a run started from here has not written its result yet - this is the
   *  previous one), 'failed' (its last run did not finish), 'done', or null (none yet). */
  const stateOf = (u) => (launched[u] !== undefined && (results[u]?.finishedUtc ?? null) === launched[u] ? 'updating'
    : results[u]?.lab && results[u]?.ok === false ? 'failed' : results[u]?.ok ? 'done' : null)
  const rows = indices.flatMap((u) => ids.map((x) => {
    const file = results[u]
    const entry = entriesOf(file).find((e) => e.strategy?.id === x) ?? null
    const updating = stateOf(u) === 'updating'
    const stale = !!entry && sentOf(file) !== nowSent
    return { key: `${u}-${x}`, index: u, id: x, file, entry, stale, updating, current: !!entry && !stale && !updating }
  }))
  const done = rows.filter((r) => r.entry)
  const missing = rows.filter((r) => !r.entry)
  const current = done.find((r) => r.key === picked) ?? done[0] ?? null

  const apply = async (row, addToLive, lots) => {
    try {
      const p = labParams(row.entry.yours.params ?? {}, data)
      const leg = p.optLeg === 'buy' || p.optLeg === 'sell'
      await applyTunedFilters(row.id, { ...DEFAULT_VARIANT, ...OPTION_DEFAULT, ...p }, { option: leg, index: row.index, tuned: settingSignature(p) || null, lots })
      if (addToLive) await putOnLiveList(row.index, row.id)
      message.success(`#${STRATEGY_BY_ID[row.id]?.no} ${STRATEGY_BY_ID[row.id]?.name}: this setting is applied on ${row.index} - the server scanner runs with it from its next look${addToLive ? `, and it is on ${row.index}'s live list` : ''}`)
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
        <Segmented value={mode} onChange={setMode} aria-label="Lab mode"
          options={[{ value: 'applied', label: 'Test on older days' }, { value: 'try', label: 'Try a different setting' }]} />
        {mode === 'applied' && <AppliedLab cfg={cfg} isAdmin={isAdmin} onTry={() => setMode('try')} />}
        {mode === 'try' && (<>
        <Card size="small" title="Strategy lab · change strategies' tuned settings and see what they would have done">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              The days are scanned exactly as the tuning scans them and the setting is measured with the tuning&apos;s own rules (the same filters, stop / target / trail and
              option exits) - beside the strategy as written and as applied on that index now. Pick one strategy on one index, or several of each: every strategy is
              measured in one run per index (the first index starts now, the others are queued right after it). Past days come from the cache, so a run normally costs no
              Dhan calls. Nothing is written to the tuning history; apply a setting from here when it is worth it.
            </Text>
            {!isAdmin && <Alert type="warning" showIcon message="Only an Admin can run the lab - sign in with the admin login." />}
            <Row gutter={[10, 8]} align="middle">
              <Col><Segmented value={data} onChange={changeData} options={[{ value: 'futures', label: 'Futures + OI' }, { value: 'spot', label: 'Spot + options' }]} aria-label="Data" /></Col>
              <Col><Select mode="multiple" value={indices} onChange={changeIndices} options={UNDERLYINGS.map((u) => ({ value: u, label: u }))} style={{ minWidth: 200 }} aria-label="Index" /></Col>
              <Col flex="1 1 320px">
                <Select mode="multiple" showSearch optionFilterProp="label" value={ids} onChange={changeIds} options={strategies} style={{ width: '100%' }} maxTagCount="responsive" aria-label="Strategy"
                  placeholder="Strategies" />
              </Col>
              <Col><Button size="small" onClick={() => changeIds(strategies.map((x) => x.value))} disabled={ids.length === strategies.length}>All {strategies.length} strategies</Button></Col>
              <Col><Space size={4}><Text style={{ fontSize: 12 }}>last</Text><InputNumber min={1} max={250} value={days} onChange={(v) => setDays(v ?? 30)} disabled={!!(range?.[0] || range?.[1])} style={{ width: 80 }} aria-label="Days" /><Text style={{ fontSize: 12 }}>days, or</Text></Space></Col>
              <Col><DatePicker.RangePicker value={range} onChange={setRange} format="DD MMM YYYY" allowEmpty={[true, true]} aria-label="Dates" /></Col>
            </Row>
            <Row gutter={[10, 8]} align="middle">
              <Col><Text style={{ fontSize: 12 }}>Start from</Text></Col>
              <Col flex="1 1 400px"><Select value={startFrom} onChange={startWith} options={starts} style={{ width: '100%' }} aria-label="Start from" /></Col>
              <Col><Button onClick={() => startWith(startFrom)}>{single ? 'Reset to it' : 'Clear the changes'}</Button></Col>
            </Row>
            <Card size="small" type="inner" title={single ? 'The setting' : 'The changes - put on top of each strategy\'s start; only what you change here is changed'}
              extra={<Text type="secondary" style={{ fontSize: 12 }}>{single
                ? `${variantText({ ...DEFAULT_VARIANT, ...shown })}${opt ? ` · ${optionText({ ...OPTION_DEFAULT, ...shown })}` : ''}`
                : Object.keys(labOverrides(params, data)).length ? `${Object.keys(labOverrides(params, data)).length} change(s)` : 'no changes - each as it starts'}</Text>}>
              <Row gutter={[16, 8]}>
                {keys.map((k) => {
                  const f = TRADE_FILTERS.find((x) => x.key === k)
                  const v = params[k] ?? f.default
                  const changed = single ? String(v) !== String(f.default) : params[k] !== undefined
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
                    <Text style={{ fontSize: 12, fontWeight: opt || (!single && params.optLeg === 'none') ? 600 : 400 }}>Option: taken its own way</Text>
                    {/* Several strategies: "No" is a change too - it takes off an option leg a strategy starts with. */}
                    <Select size="small" value={opt ? params.optLeg : !single && params.optLeg === undefined ? 'keep' : 'none'} onChange={(x) => set('optLeg', x === 'keep' ? undefined : x === 'none' ? (single ? undefined : 'none') : x)} style={{ width: 200 }} aria-label="optLeg"
                      options={[...(single ? [] : [{ value: 'keep', label: 'As each starts' }]), { value: 'none', label: 'No - as the index trade says' }, { value: 'buy', label: 'BUY the option' }, { value: 'sell', label: 'SELL (write) the option' }]} />
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
              <Button type="primary" onClick={run} disabled={!isAdmin || running}>Run the lab on {indices.join(', ')}{ids.length > 1 ? ` (${ids.length} strategies)` : ''}</Button>
              {labRunning && (
                <Space size={6}>
                  <Progress type="circle" size={22} percent={status?.progress?.total ? Math.round(((status.progress.done ?? 0) / status.progress.total) * 100) : 0} />
                  <Text style={{ fontSize: 12 }}>{status?.job?.underlying}: {status?.progress?.stage === 'scan' ? `scanning day ${(status.progress.done ?? 0) + 1} of ${status.progress.total}`
                    : status?.progress?.stage === 'lab' && status.progress.strategy ? `measuring #${STRATEGY_BY_ID[status.progress.strategy]?.no} ${STRATEGY_BY_ID[status.progress.strategy]?.short ?? status.progress.strategy} (${(status.progress.done ?? 0) + 1} of ${status.progress.total})`
                      : status?.progress?.stage ?? 'starting'}…</Text>
                </Space>
              )}
              {running && !labRunning && <Text type="warning" style={{ fontSize: 12 }}>A tuning job for {status?.job?.underlying} is running - the lab can be queued after it.</Text>}
              {(busy || (running && !labRunning)) && isAdmin && <Button onClick={queue}>Queue it after the running job</Button>}
              {busy && <Text type="warning" style={{ fontSize: 12 }}>{busy}</Text>}
              {status?.state === 'failed' && status?.job?.what === 'lab' && <Text type="danger" style={{ fontSize: 12 }}>The last lab run failed: {status.error}</Text>}
            </Space>
          </Space>
        </Card>

        {/* Each index: when its numbers were run, or that they are being updated, or why its last run did not finish. */}
        <Space wrap size={[16, 4]} aria-label="Lab result per index">
          {indices.map((u) => {
            const st = stateOf(u)
            const file = results[u]
            const when = file?.finishedUtc ? new Date(file.finishedUtc).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : null
            const runningHere = labRunning && status?.job?.underlying === u
            return (
              <span key={u} style={{ fontSize: 12 }}>
                <b>{u}</b>{' '}
                {st === 'updating' ? <Tag color="processing">{runningHere ? 'running now' : 'queued'}{file?.ok ? ` - showing its previous run${when ? ` (${when})` : ''} until it is done` : ' - no result yet'}</Tag>
                  : st === 'failed' ? <Tooltip title={file.error}><Tag color="error">last run failed{when ? ` ${when}` : ''}: {String(file.error).slice(0, 80)}</Tag></Tooltip>
                    : st === 'done' ? <Tag color={sentOf(file) === nowSent ? 'success' : 'warning'}>run {when}{sentOf(file) === nowSent ? '' : ' - an older setting / other days'}</Tag>
                      : <Tag>no run yet</Tag>}
              </span>
            )
          })}
        </Space>
        {done.length > 0 && (rows.length > 1 || done.length < rows.length) && (
          <LabSummary rows={done} picked={current?.key} onPick={setPicked} missing={missing} data={data} failedOf={(u) => (stateOf(u) === 'failed' ? results[u]?.error : null)} />
        )}
        {done.length === 0 && missing.some((m) => stateOf(m.index) === 'failed') && (
          <Alert type="error" showIcon message={`The last lab run failed on ${[...new Set(missing.filter((m) => stateOf(m.index) === 'failed').map((m) => m.index))].join(', ')} - its numbers are not shown; press Run again`} />
        )}
        {current
          ? <LabResult result={{ ...current.file, ...current.entry }} stale={current.stale} updating={current.updating} index={current.index} applied={appliedOf(current.index, current.id)}
              onApply={(live, lots) => apply(current, live, lots)} canApply={isAdmin && current.current} indexLots={cfg?.trade?.[current.index]?.lots ?? null} />
          : <Alert type="info" showIcon message={`No lab run yet for ${rows.length > 1 ? 'these strategies / indices' : `#${STRATEGY_BY_ID[id]?.no} ${STRATEGY_BY_ID[id]?.name} on ${index}`} - set the parameters and press Run.`} />}
        </>)}
      </Space>
    </div>
  )
}

/** Every index × strategy picked that has a lab result: as written, as applied, the setting tried, and what it captured
 *  in index points and in the option bought / sold - one row each, a row opening its full result below - with every
 *  strategy added up (and each index when there are several). */
function LabSummary({ rows: allRows, picked, onPick, missing, data, failedOf = () => null }) {
  // The totals add up this run only - a row still showing an index's previous run (updating), or an older setting / other
  // days, is listed (greyed) but never counted.
  const rows = allRows.filter((r) => r.current)
  const left = allRows.length - rows.length
  const [of, setOf] = useState('yours')
  const cell = (m) => (m?.r?.n ? <span style={{ fontSize: 12 }}>{m.r.n} · win {pct(m.r.winRate)} · <b style={{ color: col(m.r.avg) }}>{fmtR(m.r.avg)}</b> avg · <span style={{ color: col(m.r.total) }}>{fmtR(m.r.total)}</span></span> : <Text type="secondary" style={{ fontSize: 12 }}>no trades</Text>)
  const legCell = (l) => (l?.n ? <span style={{ fontSize: 12 }}><b style={{ color: col(l.total) }}>{pts(l.total)}</b> <Text type="secondary" style={{ fontSize: 11 }}>({l.n} · {l.wins}/{l.losses} · +{Number(l.captured).toFixed(1)} / {Number(l.lost).toFixed(1)})</Text></span> : <Text type="secondary" style={{ fontSize: 12 }}>-</Text>)
  const idx = data === 'spot' ? 'Spot' : 'Futures'
  // As applied: what the scanner trades on that index now - its applied setting, as written where none is applied.
  const measureOf = (entry, k) => (k === 'applied' ? entry.applied ?? entry.asWritten : entry[k])
  const pointsOf = (r) => measureOf(r.entry, of)?.points ?? null
  const rTotal = (list, k) => {
    const ms = list.map((r) => measureOf(r.entry, k)).filter((m) => m?.r?.n)
    return { n: ms.reduce((a, m) => a + m.r.n, 0), total: ms.reduce((a, m) => a + (m.r.total ?? 0), 0) }
  }
  const indices = [...new Set(rows.map((r) => r.index))]
  const groups = [...(indices.length > 1 ? indices.map((u) => ({ label: `${u} - all its strategies`, rows: rows.filter((r) => r.index === u) })) : []),
    { label: indices.length > 1 ? 'Every index - all strategies' : `All strategies on ${indices[0]}`, rows, all: true }]
  const all = sumPoints(rows.map(pointsOf))
  const ofText = of === 'yours' ? 'your setting' : of === 'applied' ? 'as applied - as written where nothing is applied' : 'as written'
  return (
    <Card size="small" title={`The lab runs - ${allRows.length} strategy / index pair(s)`}
      extra={<Space size={8} wrap><Text type="secondary" style={{ fontSize: 12 }}>points of</Text><Segmented size="small" value={of} onChange={setOf} options={[{ value: 'yours', label: 'Your setting' }, { value: 'applied', label: 'As applied' }, { value: 'asWritten', label: 'As written' }]} aria-label="Points of" /></Space>}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {/* The answer in one line: what every strategy picked captured together. */}
        <Text style={{ fontSize: 13 }} aria-label="All strategies points">
          All {rows.length} together ({ofText}{indices.length > 1 ? ', the indices\' points added' : ''}){left ? <Text type="warning" style={{ fontSize: 12 }}> - {left} not counted: still updating or from an older run</Text> : null}: option bought <b style={{ color: col(all.buy.total) }}>{pts(all.buy.total)}</b> pts ({all.buy.n} trades)
          {' · '}option sold <b style={{ color: col(all.sell.total) }}>{pts(all.sell.total)}</b> pts ({all.sell.n})
          {' · '}{idx.toLowerCase()} <b style={{ color: col(all.total) }}>{pts(all.total)}</b> pts ({all.n})
        </Text>
        <Table size="small" pagination={false} rowKey="key" dataSource={allRows} scroll={{ x: 1500 }} aria-label="Lab runs"
          onRow={(r) => ({ onClick: () => onPick(r.key), style: { cursor: 'pointer', background: r.key === picked ? 'rgba(22,119,255,0.12)' : undefined, opacity: r.current ? 1 : 0.5 } })}
          columns={[
            { title: 'Index', dataIndex: 'index', width: 100 },
            { title: 'Strategy', key: 's', width: 220, render: (_, r) => <span>#{r.entry.strategy.no} {r.entry.strategy.name}{r.updating ? <Tag color="processing" style={{ marginLeft: 6 }}>previous run - updating</Tag> : r.stale ? <Tag color="warning" style={{ marginLeft: 6 }}>older run - other setting / days</Tag> : null}</span> },
            { title: 'As written', key: 'w', width: 230, render: (_, r) => cell(r.entry.asWritten) },
            { title: 'As applied', key: 'a', width: 230, render: (_, r) => (r.entry.applied ? cell(r.entry.applied) : <Text type="secondary" style={{ fontSize: 12 }}>not applied</Text>) },
            { title: 'Your setting', key: 'y', width: 250, render: (_, r) => <span>{cell(r.entry.yours)}{r.entry.base === 'applied' && <Tag style={{ marginLeft: 6 }}>from applied</Tag>}</span> },
            { title: 'vs as written', key: 'd', width: 100, render: (_, r) => { const d = (r.entry.yours?.r?.total ?? 0) - (r.entry.asWritten?.r?.total ?? 0); return <b style={{ color: col(d) }}>{fmtR(d)}</b> } },
            { title: <Tooltip title={`What ${ofText} captured in the option BOUGHT (premium points): net (trades · wins/losses · captured / lost)`}>Option bought (pts)</Tooltip>, key: 'buy', width: 190, render: (_, r) => legCell(pointsOf(r)?.buy) },
            { title: <Tooltip title={`What ${ofText} captured in the option SOLD (premium points)`}>Option sold (pts)</Tooltip>, key: 'sell', width: 190, render: (_, r) => legCell(pointsOf(r)?.sell) },
            { title: `${idx} pts`, key: 'idx', width: 190, render: (_, r) => legCell(pointsOf(r)) },
          ]}
          summary={() => (
            <>
              {groups.map((g) => {
                const p = sumPoints(g.rows.map(pointsOf))
                const w = rTotal(g.rows, 'asWritten')
                const a = rTotal(g.rows, 'applied')
                const y = rTotal(g.rows, 'yours')
                return (
                  <Table.Summary.Row key={g.label} style={{ fontWeight: g.all ? 600 : 400 }}>
                    <Table.Summary.Cell index={0} colSpan={2}><Text strong={g.all} style={{ fontSize: 12 }}>{g.label}</Text></Table.Summary.Cell>
                    <Table.Summary.Cell index={2}><span style={{ fontSize: 12 }}>{w.n} trades · <span style={{ color: col(w.total) }}>{fmtR(w.total)}</span></span></Table.Summary.Cell>
                    <Table.Summary.Cell index={3}><Tooltip title="As applied on each index - as written where nothing is applied"><span style={{ fontSize: 12 }}>{a.n} trades · <span style={{ color: col(a.total) }}>{fmtR(a.total)}</span></span></Tooltip></Table.Summary.Cell>
                    <Table.Summary.Cell index={4}><span style={{ fontSize: 12 }}>{y.n} trades · <span style={{ color: col(y.total) }}>{fmtR(y.total)}</span></span></Table.Summary.Cell>
                    <Table.Summary.Cell index={5}><b style={{ color: col(y.total - w.total) }}>{fmtR(y.total - w.total)}</b></Table.Summary.Cell>
                    <Table.Summary.Cell index={6}>{legCell(p.buy)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={7}>{legCell(p.sell)}</Table.Summary.Cell>
                    <Table.Summary.Cell index={8}>{legCell(p)}</Table.Summary.Cell>
                  </Table.Summary.Row>
                )
              })}
            </>
          )} />
        {[...new Set(missing.map((m) => m.index))].filter((u) => failedOf(u)).map((u) => (
          <Text key={u} type="danger" style={{ fontSize: 12 }}>The last lab run on {u} failed - {failedOf(u)}. Its numbers are not shown; press Run again.</Text>
        ))}
        {missing.filter((m) => !failedOf(m.index)).length > 0 && <Text type="secondary" style={{ fontSize: 12 }}>No lab run yet for {missing.filter((m) => !failedOf(m.index)).map((m) => `#${STRATEGY_BY_ID[m.id]?.no} on ${m.index}`).join(', ')} - press Run to measure them.</Text>}
      </Space>
    </Card>
  )
}

function LabResult({ result, stale, updating = false, index, applied, onApply, canApply, indexLots }) {
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
        {result.strategiesLeftOut?.length > 0 && (
          <Alert type="warning" showIcon message={`Left out of this run: ${result.strategiesLeftOut.map((x) => `#${STRATEGY_BY_ID[x.id]?.no ?? '?'} ${STRATEGY_BY_ID[x.id]?.name ?? x.id} (${x.reason})`).join(' · ')}`} />
        )}
        {updating && <Alert type="info" showIcon message={`This is ${index}'s previous lab run - the new one is running or queued; it shows here when it is done (and can be applied then).`} />}
        {!updating && stale && <Alert type="warning" showIcon message="This run measured another setting or other days than the ones set now - run the lab again to see them (and to apply it)." />}
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
