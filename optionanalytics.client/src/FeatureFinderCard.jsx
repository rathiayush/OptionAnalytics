import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Progress, Segmented, Space, Table, Tag, Typography } from 'antd'
import { CloseOutlined, DownloadOutlined } from '@ant-design/icons'
import { DOWN_COLOR, UP_COLOR, useMediaQuery, usePersistedState } from './shared.jsx'
import { FoldText } from './FoldText.jsx'
import { HOLD_IC, LABELS, dayRows, featureReport, rowsCsv } from './featureFinder.js'

const { Text } = Typography

// The Signal backtest's FEATURE FINDER (featureFinder.js - the first step towards machine learning on the app's own data):
// every reading the rule builder reads, at every candle of the days the page has loaded, against what happened after it -
// ranked by how well it told that on the EARLIER days and whether it still did on the LATER days. The table for your own
// model is one click away (CSV). Nothing is loaded again: the days are the page's run's.

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

/** `days` - the page's loaded days ({ date, day }); `settings` - its engine settings (timeframe, levels); `onClose`. */
export function FeatureFinderCard({ days, settings, underlying, onClose }) {
  const phone = useMediaQuery('(max-width: 640px)')
  const [target, setTarget] = usePersistedState('optionanalytics.signalBacktest.featureTarget', 'fwd30')
  const shownTarget = TARGETS.some((t) => t.value === target) ? target : 'fwd30'
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
  const held = report?.features.filter((f) => f.holds).length ?? 0
  const download = () => {
    const blob = new Blob([rowsCsv(state.rows)], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `features-${underlying ?? ''}-${tf}m-${days[0]?.date ?? ''}-${days.at(-1)?.date ?? ''}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  const label = LABELS.find((l) => l.key === shownTarget)?.name

  return (
    <Card
      size="small" title={`Feature finder · ${days.length} day${days.length === 1 ? '' : 's'} loaded${underlying ? ` · ${underlying}` : ''} · ${tf}m candles`}
      extra={<Button size="small" type="text" icon={<CloseOutlined />} onClick={onClose} aria-label="Close the feature finder" />}
    >
      {state.status === 'running'
        ? <Progress percent={Math.round((state.done / Math.max(1, days.length)) * 100)} size="small" format={() => `${state.done} / ${days.length} days`} />
        : report && (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Space wrap size={[8, 6]} align="center">
              <Text type="secondary" style={{ fontSize: 12 }}>What happened after:</Text>
              {/* Scrolls sideways on a phone rather than running off the card. */}
              <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
                <Segmented size="small" value={shownTarget} onChange={setTarget} options={TARGETS} />
              </div>
              <Button size="small" icon={<DownloadOutlined />} onClick={download} disabled={!state.rows.length}>Dataset CSV ({state.rows.length} rows)</Button>
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
                    <Text type="secondary" style={{ fontSize: 11 }}>{reading(f, shownTarget) ?? f.group} · {fifthsText(f, shownTarget)}</Text>
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
                        <Text type="secondary" style={{ fontSize: 11 }}>{f.group}{reading(f, shownTarget) ? ` · ${reading(f, shownTarget)}` : ''}</Text>
                      </Space>
                    ),
                  },
                  { title: 'Holds', key: 'holds', width: 70, render: (_, f) => (f.holds ? <Tag color="green">yes</Tag> : <Tag>no</Tag>) },
                  { title: 'Earlier days', dataIndex: 'icEarly', key: 'e', width: 95, align: 'right', render: (v) => <span style={{ color: icColor(v) }}>{num(v)}</span> },
                  { title: 'Later days', dataIndex: 'icLater', key: 'l', width: 90, align: 'right', render: (v) => <Text strong style={{ color: icColor(v) }}>{num(v)}</Text> },
                  { title: 'Later days agreeing', dataIndex: 'dayAgree', key: 'a', width: 120, align: 'right', render: (v, f) => (Number.isFinite(v) ? `${num(v, 0)}% of ${f.days}` : '—') },
                  { title: TRADE.has(shownTarget) ? 'Win %: top fifth · bottom fifth (later)' : 'Avg move: top fifth · bottom fifth (later)', key: 'q', width: 260, render: (_, f) => fifthsText(f, shownTarget) },
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
                footprint&apos;s delta, the book heatmap) is not in it: the server keeps those days for 30 days only.
              </Text>
            </FoldText>
          </Space>
        )}
    </Card>
  )
}
