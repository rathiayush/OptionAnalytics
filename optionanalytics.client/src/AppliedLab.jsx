// THE LAB'S ONE-CLICK QUESTION: "how are the strategies I have applied doing on older days?"
// For every index, the strategies applied on it (the Strategies page / the live list's applied settings) are measured over
// past days - each as APPLIED (its fine-tuned setting, or as written where it was applied without one) beside AS WRITTEN -
// with the tuning's own functions (tune.mjs "lab", labBase 'applied', nothing changed on top). No setting to pick, no strategy
// to pick: what is applied is what is run. A run is one server job per index and kind (futures + OI / spot + options are
// different day scans): the first starts now, the others are queued right behind it. Past days come from the cache.
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, DatePicker, InputNumber, Progress, Segmented, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd'
import { UP_COLOR, DOWN_COLOR } from './shared.jsx'
import { STRATEGY_BY_ID } from './strategyEngine.js'
import { UNDERLYINGS, appliedPlan } from './appliedPlan.js'
import { sumPoints } from './strategyTuning.js'

const { Text } = Typography
const col = (v) => (v == null ? undefined : v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined)
const pts = (v) => (v == null ? '-' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(1)}`)
const fmtR = (v) => (v == null ? '-' : `${v >= 0 ? '+' : ''}${Number(v).toFixed(2)}R`)
const pct = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`)
const IST = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })
const hm = (ms) => (ms ? IST.format(new Date(ms)) : '-')
const dayMonth = (ms) => new Date(ms).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' })
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (res) => ({ res, body: await res.json().catch(() => null) }))

const entriesOf = (r) => (r?.ok && r?.lab ? (r.results ?? (r.strategy ? [{ strategy: r.strategy, base: 'written', asWritten: r.asWritten, applied: r.applied, yours: r.yours }] : [])) : [])

export default function AppliedLab({ cfg, isAdmin, onTry }) {
  const [days, setDays] = useState(30)
  const [range, setRange] = useState(null)
  const { pairs: allPairs, leftOut } = useMemo(() => appliedPlan(cfg), [cfg])
  // What to run: every applied strategy by default; or only futures / only spot + options, only some indices, only the
  // strategies picked (empty = all of them).
  const [kind, setKind] = useState('both')
  const [pickIdx, setPickIdx] = useState([])
  const [pickIds, setPickIds] = useState([])
  const pairs = useMemo(() => allPairs
    .filter((p) => (kind === 'both' || p.kind === kind) && (!pickIdx.length || pickIdx.includes(p.u)))
    .map((p) => ({ ...p, ids: pickIds.length ? p.ids.filter((id) => pickIds.includes(id)) : p.ids }))
    .filter((p) => p.ids.length), [allPairs, kind, pickIdx, pickIds])
  const idOptions = useMemo(() => {
    const seen = new Map()
    for (const p of allPairs) {
      if (kind !== 'both' && p.kind !== kind) continue
      for (const id of p.ids) if (!seen.has(id)) seen.set(id, { value: id, label: `#${STRATEGY_BY_ID[id].no} ${STRATEGY_BY_ID[id].name}`, no: STRATEGY_BY_ID[id].no })
    }
    return [...seen.values()].sort((a, b) => a.no - b.no)
  }, [allPairs, kind])
  const [results, setResults] = useState({})
  // The pairs this page has started (or queued): { [key]: the finishedUtc of the result it started from } - until the result
  // is a newer one, what is shown for it is the PREVIOUS run's: greyed, out of the totals.
  const [launched, setLaunched] = useState({})
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(null)

  const jobFor = (p) => ({
    underlying: p.u, data: p.kind, strategies: p.ids, what: 'lab', labBase: 'applied', params: {}, minTrades: 2,
    ...(range?.[0] || range?.[1] ? { from: range?.[0]?.format('YYYY-MM-DD') ?? null, to: range?.[1]?.format('YYYY-MM-DD') ?? null, days: 250 } : { days }),
  })
  /** Whether a stored result is of THIS question: what is applied now, over the days set now. */
  const sameRun = (file, p) => {
    const j = file?.job
    if (!j || j.labBase !== 'applied' || Object.keys(j.params ?? {}).length) return false
    const mine = jobFor(p)
    const days = j.from || j.to ? `${j.from ?? ''}~${j.to ?? ''}` : `last ${Number(j.days) || 30}`
    const want = mine.from || mine.to ? `${mine.from ?? ''}~${mine.to ?? ''}` : `last ${mine.days}`
    return days === want && p.ids.every((id) => (j.strategies ?? []).includes(id))
  }

  const pairKeys = allPairs.map((p) => p.key).join()
  const loadResults = () => Promise.all(allPairs.map((p) => fetch(`/api/strategy-tuning/lab/${p.u}?data=${p.kind}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)))
    .then((list) => setResults(Object.fromEntries(allPairs.map((p, i) => [p.key, list[i]]))))
  useEffect(() => { loadResults() }, [pairKeys]) // eslint-disable-line react-hooks/exhaustive-deps
  // Any change of the job as last seen - a lab run done, failed or stopped, the next one starting - reads the results again.
  const lastJob = useRef(null)
  useEffect(() => {
    let stop = false
    const poll = () => fetch('/api/strategy-tuning/status', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((s) => {
      if (stop || !s) return
      const key = `${s.state}|${s.job?.what}|${s.job?.underlying}|${s.job?.data}|${s.startedUtc ?? ''}|${s.finishedUtc ?? ''}`
      const was = lastJob.current
      lastJob.current = key
      if (was != null && was !== key && (s.job?.what === 'lab' || was.split('|')[1] === 'lab')) loadResults()
      setStatus(s)
    }).catch(() => {})
    poll()
    const t = setInterval(poll, 2500)
    return () => { stop = true; clearInterval(t) }
  }, [pairKeys]) // eslint-disable-line react-hooks/exhaustive-deps
  const waiting = Object.entries(launched).some(([k, before]) => (results[k]?.finishedUtc ?? null) === before)
  useEffect(() => {
    if (!waiting) return undefined
    const t = setInterval(loadResults, 20_000)
    return () => clearInterval(t)
  }, [waiting, pairKeys]) // eslint-disable-line react-hooks/exhaustive-deps

  const running = status?.state === 'running'
  const labRunning = running && status?.job?.what === 'lab'
  const launch = (list) => setLaunched((l) => ({ ...l, ...Object.fromEntries(list.map((p) => [p.key, results[p.key]?.finishedUtc ?? null])) }))
  const queueRest = async (rest) => {
    launch(rest)
    for (const p of rest) {
      const { res, body } = await post('/api/strategy-tuning/queue', { job: jobFor(p), underlyings: [p.u] })
      if (!res.ok) { message.error(`${p.u} (${p.kind === 'spot' ? 'spot + options' : 'futures'}) not queued: ${body?.error ?? `HTTP ${res.status}`}`); return false }
    }
    return true
  }
  const run = async () => {
    setBusy(null)
    const [first, ...rest] = pairs
    const { res, body } = await post('/api/strategy-tuning/run', jobFor(first))
    if (res.status === 409) { setBusy(body?.error ?? 'another job is running'); return }
    if (!res.ok) { message.error(body?.error ?? `HTTP ${res.status}`); return }
    setStatus(body)
    launch([first])
    if (rest.length && !(await queueRest(rest))) return
    message.info(`Started on ${first.u}${rest.length ? `; ${rest.length} more run(s) queued right after it` : ''} - past days come from the cache, so each takes a minute or two`)
  }
  const queueAll = async () => {
    if (!(await queueRest(pairs))) return
    setBusy(null)
    message.success(`Queued ${pairs.length} run(s) - they run one at a time after the current job (Strategy tuning → schedule)`)
  }

  const stateOf = (p) => (launched[p.key] !== undefined && (results[p.key]?.finishedUtc ?? null) === launched[p.key] ? 'updating'
    : results[p.key]?.lab && results[p.key]?.ok === false ? 'failed' : results[p.key]?.ok ? 'done' : null)
  const rows = pairs.flatMap((p) => {
    const file = results[p.key]
    const entries = entriesOf(file)
    const updating = stateOf(p) === 'updating'
    const stale = !!file?.ok && !sameRun(file, p)
    return p.ids.map((id) => {
      const entry = entries.find((e) => e.strategy?.id === id) ?? null
      return { key: `${p.key}|${id}`, pair: p, index: p.u, kind: p.kind, id, entry, updating, stale, current: !!entry && !updating && !stale, file }
    })
  })
  const shown = rows.filter((r) => r.entry)
  const counted = shown.filter((r) => r.current)
  const left = shown.length - counted.length
  const pending = rows.filter((r) => !r.entry)

  const cell = (m) => (m?.r?.n ? <span style={{ fontSize: 12 }}>{m.r.n} · win {pct(m.r.winRate)} · <b style={{ color: col(m.r.avg) }}>{fmtR(m.r.avg)}</b> avg · <span style={{ color: col(m.r.total) }}>{fmtR(m.r.total)}</span></span> : <Text type="secondary" style={{ fontSize: 12 }}>no trades</Text>)
  const legCell = (l) => (l?.n ? <span style={{ fontSize: 12 }}><b style={{ color: col(l.total) }}>{pts(l.total)}</b> <Text type="secondary" style={{ fontSize: 11 }}>({l.n} · {l.wins}/{l.losses})</Text></span> : <Text type="secondary" style={{ fontSize: 12 }}>-</Text>)
  // What the scanner trades on that index: the applied setting (as written when it carries none of its own).
  const appliedOf = (e) => e.applied ?? e.asWritten
  const ownSetting = (e) => Object.keys(e.applied?.filters ?? {}).some((k) => !k.startsWith('_'))
  const rTotal = (list, pick) => {
    const ms = list.map((r) => pick(r.entry)).filter((m) => m?.r?.n)
    return { n: ms.reduce((a, m) => a + m.r.n, 0), total: ms.reduce((a, m) => a + (m.r.total ?? 0), 0) }
  }
  // Overall, per index (and per kind where an index has both): trades, R, and what was captured in the index points, the
  // option bought and the option sold - as applied, beside as written.
  const capture = [
    ...UNDERLYINGS.flatMap((u) => {
      const mine = counted.filter((r) => r.index === u)
      if (!mine.length) return []
      const kinds = [...new Set(mine.map((r) => r.kind))]
      return [{ key: u, label: u, rows: mine, top: true }, ...(kinds.length > 1 ? kinds.map((k) => ({ key: `${u}|${k}`, label: k === 'spot' ? 'spot + options' : 'futures + OI', rows: mine.filter((r) => r.kind === k), sub: true })) : [])]
    }),
    ...(counted.length ? [{ key: 'all', label: 'Every index', rows: counted, top: true, all: true }] : []),
  ].map((g) => ({
    ...g,
    n: g.rows.length,
    ar: rTotal(g.rows, appliedOf), wr: rTotal(g.rows, (e) => e.asWritten),
    ap: sumPoints(g.rows.map((r) => appliedOf(r.entry)?.points)), wp: sumPoints(g.rows.map((r) => r.entry.asWritten?.points)),
  }))

  const runText = (p) => {
    const st = stateOf(p)
    const file = results[p.key]
    const when = file?.finishedUtc ? new Date(file.finishedUtc).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }) : null
    const here = labRunning && status?.job?.underlying === p.u && (status?.job?.data ?? 'futures') === p.kind
    const name = `${p.u} ${p.kind === 'spot' ? 'spot + options' : 'futures'} (${p.ids.length})`
    return (
      <span key={p.key} style={{ fontSize: 12 }}>
        <b>{name}</b>{' '}
        {st === 'updating' ? <Tag color="processing">{here ? 'running now' : 'queued'}{file?.ok ? ` - showing the previous run${when ? ` (${when})` : ''} until it is done` : ' - no result yet'}</Tag>
          : st === 'failed' ? <Tooltip title={file.error}><Tag color="error">last run failed{when ? ` ${when}` : ''}: {String(file.error).slice(0, 90)}</Tag></Tooltip>
            : st === 'done' ? <Tag color={sameRun(file, p) ? 'success' : 'warning'}>run {when}{sameRun(file, p) ? '' : ' - what was applied / the days were different then'}</Tag>
              : <Tag>no run yet</Tag>}
      </span>
    )
  }

  const tradeColumns = [
    { title: 'Date', dataIndex: 'date', width: 100 },
    { title: 'In → out', key: 't', width: 110, render: (_, t) => `${hm(t.t)} → ${t.exitT ? hm(t.exitT) : 'end'}` },
    { title: 'Side', dataIndex: 'side', width: 70, render: (v) => <Tag color={v === 'LONG' ? 'green' : 'red'}>{v}</Tag> },
    { title: 'Index in → out', key: 'p', width: 150, render: (_, t) => `${Number(t.entry).toFixed(1)} → ${Number(t.exit).toFixed(1)}` },
    { title: 'Points', dataIndex: 'points', width: 80, render: (v) => <b style={{ color: col(v) }}>{pts(v)}</b> },
    { title: 'R', dataIndex: 'r', width: 70, render: (v) => <span style={{ color: col(v) }}>{fmtR(v)}</span> },
    { title: 'Closed by', dataIndex: 'exitReason', width: 110 },
    { title: 'Option bought', key: 'b', width: 170, render: (_, t) => (t.buy ? <span style={{ fontSize: 12 }}>{t.buy.label} <span style={{ color: col(t.buy.points) }}>{pts(t.buy.points)}</span></span> : '-') },
    { title: 'Option sold', key: 's', width: 170, render: (_, t) => (t.sell ? <span style={{ fontSize: 12 }}>{t.sell.label} <span style={{ color: col(t.sell.points) }}>{pts(t.sell.points)}</span></span> : '-') },
  ]

  const progressText = !labRunning ? null
    : `${status?.job?.underlying}: ${status?.progress?.stage === 'scan' ? `scanning day ${(status.progress.done ?? 0) + 1} of ${status.progress.total}`
      : status?.progress?.stage === 'lab' && status.progress.strategy ? `measuring #${STRATEGY_BY_ID[status.progress.strategy]?.no} ${STRATEGY_BY_ID[status.progress.strategy]?.short ?? status.progress.strategy} (${(status.progress.done ?? 0) + 1} of ${status.progress.total})`
        : status?.progress?.stage ?? 'starting'}…`

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Card size="small" title="What is applied, on older days"
        extra={<Button size="small" type="link" onClick={onTry}>Try a different setting instead →</Button>}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Every strategy applied on an index is run over past days - as <b>applied</b> (its fine-tuned setting, or as written where it was applied without one) beside <b>as written</b> - with the
            tuning&apos;s own rules, the same day scan as the scanner. Nothing to pick: what is applied is what is measured. One run per index (futures and spot + options are separate scans); the
            first starts now and the others queue right behind it. Past days come from the cache, so it normally costs no Dhan calls. Days before a strategy was applied include the
            ones its setting was tuned on - the days it was never tuned on are the ones to trust.
          </Text>
          {!isAdmin && <Alert type="warning" showIcon message="Only an Admin can run the lab - sign in with the admin login." />}
          {cfg === null && <Alert type="warning" showIcon message="The applied settings could not be read (sign in with the admin login)." />}
          {cfg && allPairs.length === 0 && <Alert type="info" showIcon message="Nothing is applied on any index yet - choose strategies on the Strategies page (or apply a tuned setting) and they appear here." />}
          {allPairs.length > 0 && pairs.length === 0 && <Alert type="info" showIcon message="Nothing applied matches that choice - clear the kind / index / strategy picks." />}
          {leftOut.length > 0 && <Alert type="warning" showIcon message={`Applied but not run: ${leftOut.map((x) => `#${STRATEGY_BY_ID[x.id]?.no ?? '?'} ${STRATEGY_BY_ID[x.id]?.name ?? x.id} on ${x.u} (${x.reason})`).join(' · ')}`} />}
          <Space wrap size={10} align="center">
            <Segmented value={kind} onChange={(v) => { setKind(v); setPickIds([]) }} aria-label="Kind"
              options={[{ value: 'both', label: 'Both' }, { value: 'futures', label: 'Futures + OI' }, { value: 'spot', label: 'Spot + options' }]} />
            <Select mode="multiple" allowClear value={pickIdx} onChange={setPickIdx} placeholder="All indices" options={UNDERLYINGS.map((u) => ({ value: u, label: u }))} style={{ minWidth: 190 }} maxTagCount="responsive" aria-label="Index" />
            <Select mode="multiple" allowClear showSearch optionFilterProp="label" value={pickIds} onChange={setPickIds} placeholder="All applied strategies" options={idOptions} style={{ minWidth: 300, maxWidth: 520 }} maxTagCount="responsive" aria-label="Strategy" />
          </Space>
          <Space wrap size={12} align="center">
            <Space size={4}><Text style={{ fontSize: 12 }}>last</Text><InputNumber min={1} max={250} value={days} onChange={(v) => setDays(v ?? 30)} disabled={!!(range?.[0] || range?.[1])} style={{ width: 80 }} aria-label="Days" /><Text style={{ fontSize: 12 }}>days, or</Text></Space>
            <DatePicker.RangePicker value={range} onChange={setRange} format="DD MMM YYYY" allowEmpty={[true, true]} aria-label="Dates" />
            <Button type="primary" onClick={run} disabled={!isAdmin || running || pairs.length === 0}>
              Run what is applied{pairs.length ? ` on ${[...new Set(pairs.map((p) => p.u))].join(', ')}` : ''} ({pairs.reduce((a, p) => a + p.ids.length, 0)} strateg{pairs.reduce((a, p) => a + p.ids.length, 0) === 1 ? 'y' : 'ies'})
            </Button>
            {(busy || (running && !labRunning)) && isAdmin && <Button onClick={queueAll}>Queue it after the running job</Button>}
          </Space>
          {labRunning && (
            <Space size={6}>
              <Progress type="circle" size={22} percent={status?.progress?.total ? Math.round(((status.progress.done ?? 0) / status.progress.total) * 100) : 0} />
              <Text style={{ fontSize: 12 }}>{progressText}</Text>
            </Space>
          )}
          {running && !labRunning && <Text type="warning" style={{ fontSize: 12 }}>A tuning job for {status?.job?.underlying} is running - this can be queued after it.</Text>}
          {busy && <Text type="warning" style={{ fontSize: 12 }}>{busy}</Text>}
          {status?.state === 'failed' && status?.job?.what === 'lab' && <Text type="danger" style={{ fontSize: 12 }}>The last lab run failed: {status.error}</Text>}
          {pairs.length > 0 && <Space wrap size={[16, 4]} aria-label="Run per index">{pairs.map(runText)}</Space>}
        </Space>
      </Card>

      {pairs.some((p) => results[p.key]?.strategiesLeftOut?.length) && (
        <Alert type="warning" showIcon message={`Left out of a run: ${pairs.flatMap((p) => (results[p.key]?.strategiesLeftOut ?? []).map((x) => `${x.id} on ${p.u} (${x.reason})`)).join(' · ')}`} />
      )}
      {capture.length > 0 && (
        <Card size="small" title="What it captured - overall and per index" aria-label="Capture per index">
          <Table size="small" pagination={false} rowKey="key" dataSource={capture} scroll={{ x: 1100 }} aria-label="Capture"
            columns={[
              { title: 'Index', key: 'l', width: 190, render: (_, g) => <Text strong={!!g.top} type={g.sub ? 'secondary' : undefined} style={{ fontSize: 12, paddingLeft: g.sub ? 14 : 0 }}>{g.label}{g.top ? <Text type="secondary" style={{ fontSize: 11 }}> · {g.n} strateg{g.n === 1 ? 'y' : 'ies'}</Text> : null}</Text> },
              { title: 'Trades · total R (applied)', key: 'r', width: 180, render: (_, g) => <span style={{ fontSize: 12 }}>{g.ar.n} · <b style={{ color: col(g.ar.total) }}>{fmtR(g.ar.total)}</b></span> },
              { title: <Tooltip title="What the applied settings captured in the index (futures / spot) points: net (trades · wins/losses)">Index points</Tooltip>, key: 'i', width: 170, render: (_, g) => legCell(g.ap) },
              { title: <Tooltip title="What the applied settings captured in the option BOUGHT (premium points)">Option bought</Tooltip>, key: 'b', width: 170, render: (_, g) => legCell(g.ap.buy) },
              { title: <Tooltip title="What the applied settings captured in the option SOLD (premium points)">Option sold</Tooltip>, key: 's', width: 170, render: (_, g) => legCell(g.ap.sell) },
              { title: 'As written: trades · total R', key: 'wr', width: 190, render: (_, g) => <span style={{ fontSize: 12 }}>{g.wr.n} · <span style={{ color: col(g.wr.total) }}>{fmtR(g.wr.total)}</span></span> },
              { title: 'As written: index pts', key: 'wi', width: 160, render: (_, g) => legCell(g.wp) },
              { title: 'As written: bought', key: 'wb', width: 150, render: (_, g) => legCell(g.wp.buy) },
              { title: 'As written: sold', key: 'ws', width: 150, render: (_, g) => legCell(g.wp.sell) },
            ]} />
        </Card>
      )}
      {shown.length > 0 && (
        <Card size="small" title={`Applied vs as written - ${shown.length} strategy / index pair(s)`}>
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            {left > 0 && <Text type="warning" style={{ fontSize: 12 }}>{left} greyed row(s) are not counted: still running, or from a run of what was applied / the days before.</Text>}
            <Table size="small" pagination={false} rowKey="key" dataSource={shown} scroll={{ x: 1300 }} aria-label="Applied runs"
              expandable={{
                rowExpandable: (r) => (r.entry.yours?.trades?.length ?? 0) > 0,
                expandedRowRender: (r) => (
                  <Table size="small" rowKey={(t) => `${t.date}-${t.t}`} dataSource={r.entry.yours.trades} pagination={{ pageSize: 30, size: 'small' }} scroll={{ x: 1000 }} columns={tradeColumns} aria-label="Applied trades" />
                ),
              }}
              onRow={(r) => ({ style: { opacity: r.current ? 1 : 0.5 } })}
              columns={[
                { title: 'Index', key: 'i', width: 130, render: (_, r) => <span>{r.index}<br /><Text type="secondary" style={{ fontSize: 11 }}>{r.kind === 'spot' ? 'spot + options' : 'futures + OI'}</Text></span> },
                {
                  title: 'Strategy', key: 's', width: 250, render: (_, r) => {
                    const f = r.entry.applied?.filters
                    return (
                      <span>#{r.entry.strategy.no} {r.entry.strategy.name}{' '}
                        <Tag style={{ marginLeft: 4 }} color={ownSetting(r.entry) ? 'blue' : undefined}>{ownSetting(r.entry) ? 'fine-tuned' : 'as written'}</Tag>
                        {f?._appliedAt ? <Text type="secondary" style={{ fontSize: 11 }}>applied {dayMonth(f._appliedAt)}</Text> : null}
                        {r.updating ? <Tag color="processing" style={{ marginLeft: 6 }}>previous run - updating</Tag> : r.stale ? <Tag color="warning" style={{ marginLeft: 6 }}>older run</Tag> : null}
                      </span>
                    )
                  },
                },
                { title: 'As applied', key: 'a', width: 250, render: (_, r) => cell(appliedOf(r.entry)) },
                { title: 'As written', key: 'w', width: 250, render: (_, r) => cell(r.entry.asWritten) },
                { title: 'Applied − written', key: 'd', width: 120, render: (_, r) => { const d = (appliedOf(r.entry)?.r?.total ?? 0) - (r.entry.asWritten?.r?.total ?? 0); return <b style={{ color: col(d) }}>{ownSetting(r.entry) ? fmtR(d) : '-'}</b> } },
                { title: <Tooltip title="What the applied setting captured in the index (futures / spot) points: net (trades · wins/losses)">Index pts</Tooltip>, key: 'idx', width: 150, render: (_, r) => legCell(appliedOf(r.entry)?.points) },
                { title: <Tooltip title="What the applied setting captured in the option BOUGHT (premium points)">Option bought</Tooltip>, key: 'buy', width: 150, render: (_, r) => legCell(appliedOf(r.entry)?.points?.buy) },
                { title: <Tooltip title="What the applied setting captured in the option SOLD (premium points)">Option sold</Tooltip>, key: 'sell', width: 150, render: (_, r) => legCell(appliedOf(r.entry)?.points?.sell) },
              ]} />
            {pending.length > 0 && !labRunning && <Text type="secondary" style={{ fontSize: 12 }}>No result yet for {pending.slice(0, 12).map((m) => `#${STRATEGY_BY_ID[m.id]?.no} on ${m.index}`).join(', ')}{pending.length > 12 ? '…' : ''} - press Run.</Text>}
          </Space>
        </Card>
      )}
      {shown.length === 0 && pairs.length > 0 && (
        <Alert type="info" showIcon message="No run yet for what is applied now - press Run what is applied." />
      )}
    </Space>
  )
}
