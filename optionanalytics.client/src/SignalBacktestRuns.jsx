import { useState } from 'react'
import { Button, Card, Checkbox, DatePicker, Input, Modal, Popconfirm, Progress, Segmented, Space, Table, Tag, Tooltip, Typography, message } from 'antd'
import { DeleteOutlined, DownloadOutlined, ExperimentOutlined, FolderOpenOutlined, StopOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { DOWN_COLOR, UP_COLOR, useAuth, useMediaQuery } from './shared.jsx'
import { defaultRunName, featureTradeText, runRange } from './signalBacktestJob.js'
import { afterTheClose, cancelRun, deleteRun, downloadFeaturesCsv, queueRun } from './signalBacktestQueue.js'

// The Signal backtest's BACKGROUND runs, on the page: queue one (now, after the close or at a time - the server runs it,
// SignalBacktestJobService, one at a time, the browser can be closed), the list of runs with their state and progress, and
// a finished run's report opened on the page. A run is the rule's BACKTEST or the FEATURE FINDER over the days (its report
// opened on the page, its dataset CSV downloaded). Read-only like the page: a run places nothing.

const { Text } = Typography
const MAX_AHEAD_DAYS = 14
const rupees = (v) => (Number.isFinite(v) ? `${v < 0 ? '−' : ''}₹${Math.round(Math.abs(v)).toLocaleString('en-IN')}` : '—')
const pnlColor = (v) => (v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined)
const when = (iso) => (iso ? dayjs(iso).format('ddd D MMM HH:mm') : '')

const KINDS = [{ value: 'backtest', label: 'Backtest the rule' }, { value: 'features', label: 'Feature finder' }]

/** "Run in the background": the run as set on the page - the rule's backtest or the Feature finder (`kind`, the one to start
 *  on; `canBacktest` - the page has a rule) - a name, when to start and Telegram at the end. Mounted on open. */
export function RunInBackgroundModal({ settings, days, ruleSummary, telegram, setTelegram, onClose, onQueued, kind: firstKind = 'backtest', canBacktest = true }) {
  const [kind, setKind] = useState(firstKind)
  // The name follows the kind until it is typed in.
  const [typed, setTyped] = useState(null)
  const name = typed ?? defaultRunName(settings, kind)
  const setName = setTyped
  const features = kind === 'features'
  const [start, setStart] = useState('now')
  const [at, setAt] = useState(null)
  const [busy, setBusy] = useState(false)
  const close = afterTheClose()
  const submit = async () => {
    const startAt = start === 'close' ? (close ? new Date(close).toISOString() : null) : start === 'at' ? at?.toISOString() : null
    if (start === 'at' && !at) { message.warning('Pick the day and time to start.'); return }
    setBusy(true)
    try {
      const job = await queueRun({ settings, name: name.trim() || defaultRunName(settings, kind), startAtUtc: startAt, telegram, kind })
      message.success(job.startAtUtc ? `Queued - it starts ${when(job.startAtUtc)} on the server.` : 'Queued - it runs on the server now; you can close the browser.')
      onQueued(job)
    } catch (err) {
      message.error(`The run could not be queued: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open title="Run in the background" onCancel={onClose} onOk={submit} okText="Queue it" confirmLoading={busy}
      okButtonProps={{ disabled: !days || (!features && !canBacktest) }} destroyOnHidden
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {/* Scrolls sideways on a phone rather than running off the dialog. */}
        <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
          <Segmented value={kind} onChange={setKind} options={KINDS} />
        </div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {features
            ? <>The server builds the Feature finder over these days - every reading at every candle against what came next - and keeps its report and the dataset CSV under &quot;Background runs&quot; (Open / CSV). Up to 300 days: more days, a fairer earlier / later check.</>
            : <>The server runs it with the same rule and settings as this page - close the browser or lock the phone. Its report waits under &quot;Background runs&quot; here.</>}
          {' '}Runs go one at a time; days the server has kept are quick, a day it has not comes from Dhan once.
        </Text>
        <Text style={{ fontSize: 12 }}>
          {features
            ? <><Text strong style={{ fontSize: 12 }}>{settings.underlying}</Text> · {days} trading day{days === 1 ? '' : 's'} ({runRange(settings.from, settings.to)}) · {featureTradeText(settings)}{settings.tradeIn ? ` - ${settings.underlying}'s own options (Trade in is the backtest's)` : ''}</>
            : <><Text strong style={{ fontSize: 12 }}>{settings.underlying}{settings.tradeIn ? ` → traded in ${settings.tradeIn}` : ''}</Text> · {days} trading day{days === 1 ? '' : 's'} ({runRange(settings.from, settings.to)}) · {ruleSummary}</>}
        </Text>
        {!features && !canBacktest && <Text type="warning" style={{ fontSize: 12 }}>Build the rule first - or pick Feature finder (it needs no rule).</Text>}
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>Name</Text>
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Space>
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Text type="secondary" style={{ fontSize: 12 }}>Start</Text>
          <Segmented
            value={start} onChange={setStart}
            options={[{ value: 'now', label: 'Now' }, { value: 'close', label: 'After the close' }, { value: 'at', label: 'At a time' }]}
          />
          {start === 'close' && (
            <Text type="secondary" style={{ fontSize: 12 }}>{close ? `Today at 15:45 (${dayjs(close).format('HH:mm')} your time).` : 'The market is closed - it starts now.'}</Text>
          )}
          {start === 'at' && (
            <DatePicker
              showTime={{ format: 'HH:mm', minuteStep: 5 }} format="ddd D MMM HH:mm" value={at} onChange={setAt} style={{ width: 220 }}
              disabledDate={(d) => d.isBefore(dayjs(), 'day') || d.isAfter(dayjs().add(MAX_AHEAD_DAYS, 'day'), 'day')}
            />
          )}
        </Space>
        <Checkbox checked={telegram} onChange={(e) => setTelegram(e.target.checked)}>Telegram me when it ends</Checkbox>
      </Space>
    </Modal>
  )
}

function StatusCell({ job }) {
  const p = job.progress
  switch (job.state) {
    case 'queued':
      return (
        <Tooltip title={job.note}>
          <Tag color="blue" style={{ margin: 0 }}>{job.startAtUtc ? `Starts ${when(job.startAtUtc)}` : 'Waiting'}</Tag>
        </Tooltip>
      )
    case 'running': {
      const total = p?.total ?? job.days
      const done = p?.done ?? 0
      return (
        <Space direction="vertical" size={2}>
          <Tag color="processing" style={{ margin: 0 }}>
            {p?.stage === 'retry' ? `Trying ${dayjs(p.day).format('D MMM')} again` : p?.stage === 'done' ? 'Writing the report' : `Day ${Math.min(done + 1, total)} of ${total}`}
          </Tag>
          <Progress percent={total ? Math.round((done / total) * 100) : 0} size="small" showInfo={false} style={{ width: 130, margin: 0 }} />
        </Space>
      )
    }
    case 'done':
      return <Tag color="green" style={{ margin: 0 }}>Done {when(job.finishedUtc)}</Tag>
    case 'failed':
      return <Tooltip title={job.error}><Tag color="red" style={{ margin: 0 }}>Failed</Tag></Tooltip>
    default:
      return <Tag style={{ margin: 0 }}>Cancelled</Tag>
  }
}

// A Feature finder run's result: its candles and days, and how many readings held on the later days for the trades and
// spot 30 min later.
function FeaturesResult({ s }) {
  const notRun = s.failedDays > 0 ? <Text type="secondary" style={{ fontSize: 12 }}> · {s.failedDays} day{s.failedDays === 1 ? '' : 's'} not run</Text> : null
  return (
    <Text style={{ fontSize: 12 }}>
      {(s.rows ?? 0).toLocaleString('en-IN')} candles · {s.okDays ?? 0} days{notRun}
      <br />
      {s.split
        ? <>Held: <Text strong style={{ fontSize: 12 }}>CE buy {s.held?.ceBuy ?? 0}</Text> · <Text strong style={{ fontSize: 12 }}>PE buy {s.held?.peBuy ?? 0}</Text>
          {s.held?.ceSell != null && <> · CE sell {s.held.ceSell} · PE sell {s.held?.peSell ?? 0}</>} · spot 30m {s.held?.fwd30 ?? 0}</>
        : <Text type="secondary" style={{ fontSize: 12 }}>too few days for the earlier / later check</Text>}
    </Text>
  )
}

// A running run's days asked of Dhan so far (a day nothing had loaded before - the server keeps it after): why one goes slower.
const fromDhan = (p) => (p?.sources?.dhan > 0 ? ` · ${p.sources.dhan} day${p.sources.dhan === 1 ? '' : 's'} asked of Dhan (first time)` : '')

function ResultCell({ job }) {
  const s = job.summary
  const p = job.progress
  if (job.kind === 'features') {
    if (job.state === 'done' && s) return <FeaturesResult s={s} />
    if (job.state === 'running' && p) return <Text type="secondary" style={{ fontSize: 12 }}>so far {(p.rows ?? 0).toLocaleString('en-IN')} candles · {p.okDays ?? 0} days{fromDhan(p)}</Text>
    if (job.state === 'failed') return <Text type="danger" style={{ fontSize: 12 }}>{job.error}</Text>
    return null
  }
  if (job.state === 'done' && s) {
    return (
      <Text style={{ fontSize: 12 }}>
        <Text strong style={{ color: pnlColor(s.net) }}>{rupees(s.net)}</Text> · {s.trades ?? 0} trades{Number.isFinite(s.winRate) ? ` · ${Math.round(s.winRate)}% win` : ''}
        {s.failedDays > 0 ? <Text type="secondary" style={{ fontSize: 12 }}> · {s.failedDays} day{s.failedDays === 1 ? '' : 's'} not run</Text> : null}
      </Text>
    )
  }
  if (job.state === 'running' && p) return <Text type="secondary" style={{ fontSize: 12 }}>so far {p.trades ?? 0} trades · {rupees(p.net)}{fromDhan(p)}</Text>
  if (job.state === 'failed') return <Text type="danger" style={{ fontSize: 12 }}>{job.error}</Text>
  return null
}

function RunCell({ job: j, me }) {
  return (
    <Space direction="vertical" size={0}>
      <Text strong style={{ fontSize: 13 }}>
        {j.kind === 'features' && <Tag color="purple" icon={<ExperimentOutlined />} style={{ marginInlineEnd: 6 }}>Feature finder</Tag>}
        {j.name}
      </Text>
      {/* The strategy it ran, when its name is not already the run's name. */}
      {j.settings?.strategyName && !String(j.name ?? '').includes(j.settings.strategyName) && (
        <Text style={{ fontSize: 12 }}>Strategy: {j.settings.strategyName}</Text>
      )}
      <Text type="secondary" style={{ fontSize: 11 }}>
        {j.underlying} · {j.days} day{j.days === 1 ? '' : 's'} · {runRange(j.from, j.to)} · queued {when(j.createdUtc)}
        {j.owner && j.owner.toLowerCase() !== me ? ` · ${j.owner}` : ''}{j.telegram ? ' · Telegram' : ''}
      </Text>
    </Space>
  )
}

function Actions({ job: j, viewingIds, busy, onOpen, onUse, onCancel, onDelete }) {
  const shown = viewingIds.includes(j.id)
  const [saving, setSaving] = useState(false)
  const csv = async () => {
    setSaving(true)
    try { await downloadFeaturesCsv(j) } catch (err) { message.error(`The dataset could not be downloaded: ${err.message}`) } finally { setSaving(false) }
  }
  return (
    <Space size={4} wrap>
      {j.state === 'done' && (
        <Button size="small" type={shown ? 'default' : 'primary'} icon={<FolderOpenOutlined />} onClick={() => onOpen(j)} disabled={shown}>
          {shown ? 'Shown' : 'Open'}
        </Button>
      )}
      {j.state === 'done' && j.kind === 'features' && (
        <Tooltip title="The whole table - a row a candle, a column a reading and what came next - for a spreadsheet or your own model.">
          <Button size="small" icon={<DownloadOutlined />} loading={saving} onClick={csv}>CSV</Button>
        </Tooltip>
      )}
      <Tooltip title="Put this run's index, days, rule and settings on the page.">
        <Button size="small" onClick={() => onUse(j)}>Use settings</Button>
      </Tooltip>
      {(j.state === 'queued' || j.state === 'running')
        ? (
            <Popconfirm title={j.state === 'running' ? 'Stop this run?' : 'Cancel this run?'} okText="Yes" cancelText="No" onConfirm={() => onCancel(j.id)}>
              <Button size="small" danger icon={<StopOutlined />} loading={busy}>{j.state === 'running' ? 'Stop' : 'Cancel'}</Button>
            </Popconfirm>
          )
        : (
            <Popconfirm title="Remove this run and its report?" okText="Remove" cancelText="Keep" onConfirm={() => onDelete(j.id)}>
              <Button size="small" type="text" icon={<DeleteOutlined />} loading={busy} aria-label="Remove this run" title="Remove this run" />
            </Popconfirm>
          )}
    </Space>
  )
}

const PHONE_FIRST = 6

/** The list of runs: what each is, its state and result, and Open / Use settings / Cancel / Remove (a Feature finder run's
 *  dataset CSV too) - a table on a wide screen, one block a run on a phone (no sideways scrolling). `viewingIds` - the runs
 *  shown on the page. */
export function BackgroundRunsCard({ jobs, refresh, viewingIds = [], onOpen, onUse }) {
  const auth = useAuth()
  const narrow = useMediaQuery('(max-width: 768px)')
  const [busyId, setBusyId] = useState(null)
  const [showAll, setShowAll] = useState(false)
  if (!jobs.length) return null
  const act = async (id, fn) => {
    setBusyId(id)
    try { await fn(id) } catch (err) { message.error(err.message) } finally { setBusyId(null); refresh() }
  }
  const me = (auth?.user?.email ?? '').toLowerCase()
  const actions = (j) => (
    <Actions job={j} viewingIds={viewingIds} busy={busyId === j.id} onOpen={onOpen} onUse={onUse} onCancel={(id) => act(id, cancelRun)} onDelete={(id) => act(id, deleteRun)} />
  )
  const title = `Background runs (${jobs.length})`
  if (narrow) {
    const list = showAll ? jobs : jobs.slice(0, PHONE_FIRST)
    return (
      <Card size="small" title={title}>
        <Text type="secondary" style={{ fontSize: 12 }}>On the server, one at a time - the browser can be closed.</Text>
        {list.map((j) => (
          <div key={j.id} className="oa-bg-run">
            <RunCell job={j} me={me} />
            <Space size={8} wrap align="center"><StatusCell job={j} /><ResultCell job={j} /></Space>
            {actions(j)}
          </div>
        ))}
        {jobs.length > PHONE_FIRST && (
          <Button size="small" type="link" onClick={() => setShowAll((v) => !v)} style={{ paddingLeft: 0 }}>
            {showAll ? 'Show fewer' : `Show all ${jobs.length}`}
          </Button>
        )}
      </Card>
    )
  }
  const columns = [
    { title: 'Run', key: 'run', width: 280, render: (_, j) => <RunCell job={j} me={me} /> },
    { title: 'Status', key: 'status', width: 170, render: (_, j) => <StatusCell job={j} /> },
    { title: 'Result', key: 'result', width: 240, render: (_, j) => <ResultCell job={j} /> },
    { title: '', key: 'actions', width: 250, render: (_, j) => actions(j) },
  ]
  return (
    <Card size="small" title={title} extra={<Text type="secondary" style={{ fontSize: 12 }}>on the server, one at a time - the browser can be closed</Text>}>
      <Table size="small" rowKey="id" columns={columns} dataSource={jobs} pagination={{ pageSize: 8, hideOnSinglePage: true, showSizeChanger: false }} scroll={{ x: 940 }} />
    </Card>
  )
}
