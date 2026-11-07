import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Progress, Segmented, Space, Table, Tag, Typography } from 'antd'
import { CloseOutlined, CloudServerOutlined, DownloadOutlined } from '@ant-design/icons'
import { DOWN_COLOR, UP_COLOR, useMediaQuery, usePersistedState } from './shared.jsx'
import { FoldText } from './FoldText.jsx'
import { HOLD_IC, LABELS, dayRows, featureReport, rowsCsv } from './featureFinder.js'
import { cleanBacktestSettings, featureRunHead } from './signalBacktestJob.js'

const { Text } = Typography

// The Signal backtest's FEATURE FINDER (featureFinder.js - the first step towards machine learning on the app's own data):
// every reading the rule builder reads, at every candle of the days the page has loaded, against what happened after it -
// ranked by how well it told that on the EARLIER days and whether it still did on the LATER days. The table for your own
// model is one click away (CSV). Nothing is loaded again: the days are the page's run's. A BACKGROUND run of it (the server,
// up to 300 days - scanner-runner/signal-backtest.mjs) is opened by StoredFeatureFinderCard: the same report, kept for every
// label, and its dataset CSV from the server.

const TARGETS = [
  { value: 'fwd15', label: 'Spot 15m' },
  { value: 'fwd30', label: 'Spot 30m' },
  { value: 'fwd60', label: 'Spot 60m' },
  { value: 'ceBuy', label: 'CE buy' },
  { value: 'peBuy', label: 'PE buy' },
]
const TRADE = new Set(['ceBuy', 'peBuy'])
// Fewer later days than this: the check is a hint (a correlation on 2 - 3 days says little).
const MIN_LATER_DAYS = 10
const num = (v, digits = 2) => (Number.isFinite(v) ? v.toFixed(digits) : '—')
const icColor = (v) => (!Number.isFinite(v) || Math.abs(v) < HOLD_IC ? undefined : v > 0 ? UP_COLOR : DOWN_COLOR)

// What a correlation's sign means for the target picked, in words.
function reading(f, target) {
  if (!f.holds) return null
  const up = f.icLater > 0
  if (target === 'ceBuy') return up ? 'higher → CE buys did better' : 'lower → CE buys did better'
  if (target === 'peBuy') return up ? 'higher → PE buys did better' : 'lower → PE buys did better'
  return up ? 'higher → spot went up after' : 'higher → spot went down after'
}
// The top / bottom fifth on the later days: the trades' win rate, or the move's average.
function fifthsText(f, target) {
  if (!f.fifths) return '—'
  const { high, low } = f.fifths
  return TRADE.has(target)
    ? `top ${num(high.win, 0)}% win · bottom ${num(low.win, 0)}%`
    : `top ${num(high.avg, 3)}% · bottom ${num(low.avg, 3)}%`
}

const STORED_TARGET = 'optionanalytics.signalBacktest.featureTarget'
const useTarget = () => {
  const [target, setTarget] = usePersistedState(STORED_TARGET, 'fwd30')
  return [TARGETS.some((t) => t.value === target) ? target : 'fwd30', setTarget]
}

/** `days` - the page's loaded days ({ date, day }); `settings` - its engine settings (timeframe, levels); `onClose`;
 *  `onBackground` - run it on the server over the days picked instead (`backgroundDays` of them). */
export function FeatureFinderCard({ days, settings, underlying, onClose, onBackground, backgroundDays = 0 }) {
  const [shownTarget, setTarget] = useTarget()
  const tf = settings.timeframe ?? 5
  const levelsKey = JSON.stringify([tf, settings.slPct, settings.targetPct, settings.levelUnit, settings.trailGap, settings.trailStart, settings.timeStopMin, settings.moneyness, settings.entryFrom, settings.lastEntry])
  const key = `${days.map((r) => r.date).join(',')}|${levelsKey}`
  // The table, built a day at a time (the page drawn between them) - again when the days, the timeframe or the levels
  // change. `built.key` = what it was built for: until it is this key, the card shows the progress.
  const [built, setBuilt] = useState({ key: null, rows: [], progressKey: null, done: 0 })
  const latest = useRef({ days, settings, tf })
  useEffect(() => { latest.current = { days, settings, tf } })
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { days: list, settings: s, tf: m } = latest.current
      const rows = []
      for (let k = 0; k < list.length; k++) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        if (cancelled) return
        rows.push(...dayRows(list[k].day, { ...s, timeframe: m }))
        setBuilt((b) => ({ ...b, progressKey: key, done: k + 1 }))
      }
      if (!cancelled) setBuilt({ key, rows, progressKey: key, done: list.length })
    })()
    return () => { cancelled = true }
  }, [key])
  const state = built.key === key
    ? { status: 'done', rows: built.rows, done: days.length }
    : { status: 'running', rows: [], done: built.progressKey === key ? built.done : 0 }

  const ready = built.key === key
  const report = useMemo(() => (ready ? featureReport(built.rows, shownTarget) : null), [ready, built.rows, shownTarget])
  const download = () => {
    const blob = new Blob([rowsCsv(state.rows)], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `features-${underlying ?? ''}-${tf}m-${days[0]?.date ?? ''}-${days.at(-1)?.date ?? ''}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  return (
    <Card
      size="small" title={`Feature finder · ${days.length} day${days.length === 1 ? '' : 's'} loaded${underlying ? ` · ${underlying}` : ''} · ${tf}m candles`}
      extra={<Button size="small" type="text" icon={<CloseOutlined />} onClick={onClose} aria-label="Close the feature finder" />}
    >
      {state.status === 'running'
        ? <Progress percent={Math.round((state.done / Math.max(1, days.length)) * 100)} size="small" format={() => `${state.done} / ${days.length} days`} />
        : report && (
          <FeatureReportBody
            report={report} target={shownTarget} setTarget={setTarget} rows={state.rows.length} onDownload={download}
            extra={onBackground && backgroundDays > 0 && (
              <Button size="small" icon={<CloudServerOutlined />} onClick={onBackground}>
                In the background · {backgroundDays} day{backgroundDays === 1 ? '' : 's'}
              </Button>
            )}
          />
        )}
    </Card>
  )
}

/** A BACKGROUND Feature finder run opened on the page: `run` = { job, result } (the server's report - every label's - and
 *  its dataset CSV, `onDownload`); `onClose`. */
export function StoredFeatureFinderCard({ run, onDownload, onClose }) {
  const [shownTarget, setTarget] = useTarget()
  const [saving, setSaving] = useState(false)
  const f = run.result.features ?? {}
  const settings = useMemo(() => cleanBacktestSettings(run.result.settings), [run.result.settings])
  const report = f.reports?.[shownTarget] ?? null
  const download = async () => {
    setSaving(true)
    try { await onDownload() } finally { setSaving(false) }
  }
  const failed = f.failed ?? []
  return (
    <Card
      size="small" title={`Feature finder · background run · ${run.job.name}`}
      extra={<Button size="small" type="text" icon={<CloseOutlined />} onClick={onClose} aria-label="Close this feature finder run" />}
    >
      <Space direction="vertical" size={6} style={{ width: '100%' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>{featureRunHead(settings, f.okDays ?? 0)}</Text>
        {failed.length > 0 && (
          <FoldText id="signalBacktest.featureRunFailed" summary={`${failed.length} day${failed.length === 1 ? '' : 's'} not run`}>
            <Text type="secondary" style={{ fontSize: 12 }}>{failed.map((x) => `${x.date}: ${x.reason}`).join(' · ')}</Text>
          </FoldText>
        )}
        {report
          ? <FeatureReportBody report={report} target={shownTarget} setTarget={setTarget} rows={f.rows ?? 0} onDownload={download} downloading={saving} />
          : <Alert type="warning" showIcon message="This run kept no report for that label." />}
      </Space>
    </Card>
  )
}

/** The report of one label, the label picker, the dataset button and how to read it - the page's card and a background
 *  run's alike. `rows` - the dataset's rows; `extra` - more buttons beside the dataset's. */
function FeatureReportBody({ report, target, setTarget, rows, onDownload, downloading = false, extra = null }) {
  const phone = useMediaQuery('(max-width: 640px)')
  const held = report.features.filter((f) => f.holds).length
  const label = LABELS.find((l) => l.key === target)?.name
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space wrap size={[8, 6]} align="center">
        <Text type="secondary" style={{ fontSize: 12 }}>What happened after:</Text>
        {/* Scrolls sideways on a phone rather than running off the card. */}
        <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
          <Segmented size="small" value={target} onChange={setTarget} options={TARGETS} />
        </div>
        <Button size="small" icon={<DownloadOutlined />} onClick={onDownload} loading={downloading} disabled={!rows}>
          Dataset CSV ({rows.toLocaleString('en-IN')} rows)
        </Button>
        {extra}
      </Space>
      {report.split
        ? (
          <Text style={{ fontSize: 12 }}>
            {label}: <Text strong style={{ fontSize: 12 }}>{held}</Text> of {report.features.length} readings told it on the{' '}
            {report.earlyDays} earlier days AND still did on the {report.laterDays} later days (from {report.firstLater}) - {report.laterRows} candles there.
            {report.laterDays < MIN_LATER_DAYS && (
              <Text type="warning" style={{ fontSize: 12 }}> Only {report.laterDays} later day{report.laterDays === 1 ? '' : 's'}: a hint, not proof - run 30+ days (every 3rd day goes to the later check).</Text>
            )}
          </Text>
        )
        : <Alert type="warning" showIcon message="Load 6 days or more for the earlier / later check - with fewer, a correlation cannot be told from luck." />}
      {phone ? (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          {report.features.map((f) => (
            <div key={f.key} className="oa-feature-row">
              <Space style={{ width: '100%', justifyContent: 'space-between' }} align="start">
                <Text style={{ fontSize: 13 }}>{f.name}</Text>
                {f.holds ? <Tag color="green" style={{ margin: 0 }}>holds</Tag> : <Tag style={{ margin: 0 }}>no</Tag>}
              </Space>
              <Text style={{ fontSize: 12 }}>
                earlier <span style={{ color: icColor(f.icEarly) }}>{num(f.icEarly)}</span> → later <span style={{ color: icColor(f.icLater) }}>{num(f.icLater)}</span>
                {Number.isFinite(f.dayAgree) ? ` · ${num(f.dayAgree, 0)}% of later days agree` : ''}
              </Text>
              <Text type="secondary" style={{ fontSize: 11 }}>{reading(f, target) ?? f.group} · {fifthsText(f, target)}</Text>
            </div>
          ))}
        </Space>
      ) : (
        <Table
          size="small" pagination={false} scroll={{ x: 1100, y: 520 }} dataSource={report.features} rowKey="key"
          columns={[
            {
              title: 'Reading', dataIndex: 'name', key: 'name', width: 330, fixed: 'left', render: (v, f) => (
                <Space direction="vertical" size={0}>
                  <Text style={{ fontSize: 13 }}>{v}</Text>
                  <Text type="secondary" style={{ fontSize: 11 }}>{f.group}{reading(f, target) ? ` · ${reading(f, target)}` : ''}</Text>
                </Space>
              ),
            },
            { title: 'Holds', key: 'holds', width: 70, render: (_, f) => (f.holds ? <Tag color="green">yes</Tag> : <Tag>no</Tag>) },
            { title: 'Earlier days', dataIndex: 'icEarly', key: 'e', width: 95, align: 'right', render: (v) => <span style={{ color: icColor(v) }}>{num(v)}</span> },
            { title: 'Later days', dataIndex: 'icLater', key: 'l', width: 90, align: 'right', render: (v) => <Text strong style={{ color: icColor(v) }}>{num(v)}</Text> },
            { title: 'Later days agreeing', dataIndex: 'dayAgree', key: 'a', width: 120, align: 'right', render: (v, f) => (Number.isFinite(v) ? `${num(v, 0)}% of ${f.days}` : '—') },
            { title: TRADE.has(target) ? 'Win %: top fifth · bottom fifth (later)' : 'Avg move: top fifth · bottom fifth (later)', key: 'q', width: 260, render: (_, f) => fifthsText(f, target) },
            { title: 'Has a reading', dataIndex: 'coverage', key: 'c', width: 100, align: 'right', render: (v) => `${num(v, 0)}%` },
          ]}
        />
      )}
      <FoldText id="signalBacktest.featureFinder" label="how to read this" className="oa-note">
        <Text type="secondary" style={{ fontSize: 12 }}>
          Every reading the rule builder has, at the close of every candle from the entry window of the days loaded, against
          what happened AFTER it - spot&apos;s move, or an option bought there with the page&apos;s SL / target / trail
          (the backtest&apos;s own trade). The number is the rank correlation: +1 = the higher the reading, the better what
          came next, every time; −1 the opposite; near 0 nothing. It is worked out on the EARLIER days, then checked on the
          LATER ones the first never saw; &quot;holds&quot; = the same sign and at least {HOLD_IC} on the later days. A
          correlation of 0.05 - 0.15 is normal for a real edge in markets; one far higher on few days is usually luck - so
          look at how many later days agree, and at the top / bottom fifth. A reading that holds is a candidate for a rule:
          build it in the rule builder and run it through the backtest with charges. The CSV is the whole table (a row a
          candle, a column a reading and what came next) for a spreadsheet or your own model. The order flow (the
          footprint&apos;s delta, the book heatmap) is not in it: the server keeps those days for 30 days only. Run in the
          background, it takes up to 300 days - more days, a fairer check.
        </Text>
      </FoldText>
    </Space>
  )
}
