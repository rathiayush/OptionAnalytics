import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, Modal, Progress, Segmented, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd'
import { CloudServerOutlined, DownloadOutlined, PlayCircleOutlined, StopOutlined } from '@ant-design/icons'
import { CandlestickSeries, createSeriesMarkers } from 'lightweight-charts'
import dayjs from 'dayjs'
import { AXIS_COLOR, BORDER_COLOR, DOWN_COLOR, GRID_COLOR, NavBar, UP_COLOR, istTickMarkFormatter, istTimeFormatter, useMediaQuery, usePersistedState } from './shared.jsx'
import { createZoomableChart } from './chartZoom.js'
import { DaysPicker } from './DaysPicker.jsx'
import { FoldText } from './FoldText.jsx'
import { MAX_BACKGROUND_DAYS, MAX_BACKTEST_DAYS, backtestDays } from './signalBacktest.js'
import { BACKTEST_UNDERLYINGS, loadSourceText } from './signalBacktestJob.js'
import { BackgroundRunsCard } from './SignalBacktestRuns.jsx'
import { queueRun, runResult, useBackgroundRuns } from './signalBacktestQueue.js'
import { CARDS, CARD_TITLE, HOLD, componentReport, eventsCsv, loadComponentDay } from './componentCheck.js'

const { Text, Title } = Typography
const HORIZONS = [5, 15, 30, 60]
const IST_MS = 330 * 60_000
const STORE = {
  index: 'optionanalytics.componentCheck.index',
  range: 'optionanalytics.componentCheck.range',
  horizon: 'optionanalytics.componentCheck.horizon',
  telegram: 'optionanalytics.componentCheck.bgTelegram',
}
// The day chart's marker label of each card.
const MARK = { oiBreak: 'OI', oiHp: '🎯', straddleTrend: 'STR', straddleIdea: 'IDEA', skew: 'SKEW', gexTrend: 'GEX', gexLevel: 'WALL', dexCharm: 'CHARM', absorption: 'ABS' }
const VERDICT_COLOR = { works: 'green', opposite: 'red', none: 'default', few: 'default' }
const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
const pct = (v, d = 0) => (Number.isFinite(v) ? `${v.toFixed(d)}%` : '—')
const signedPct = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(3)}%` : '—')
const ratio = (v) => (Number.isFinite(v) ? `${v.toFixed(2)}×` : '—')
const corr = (v) => (Number.isFinite(v) ? `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}` : '—')
const corrColor = (v) => (!Number.isFinite(v) ? undefined : v >= 0.1 ? UP_COLOR : v <= -0.1 ? DOWN_COLOR : undefined)
const hhmm = (ms) => new Date(ms + IST_MS).toISOString().slice(11, 16)

// The numbers of a row at horizon h: what was measured for its kind.
function measures(r, h) {
  if (r.kind === 'vol') {
    return {
      main: ratio(r[`ratio${h}`]), mainTip: 'the move after it against the usual move from any minute of those days (1× = usual)',
      second: pct(r[`bigger${h}`]), secondTip: 'how often the move was bigger than usual',
    }
  }
  return {
    main: signedPct(r[`avgPct${h}`]), mainTip: 'the average move in the read\'s direction (% of the price)',
    second: pct(r[`hit${h}`]), secondTip: 'how often price went the read\'s way',
  }
}
const expectText = (r) => (r.kind === 'vol' ? (r.expect === 'bigger' ? 'expects bigger moves' : r.expect === 'smaller' ? 'expects smaller moves' : 'volatility') : 'directional')

function VerdictTag({ v }) {
  return v ? <Tag color={VERDICT_COLOR[v.key]} style={{ margin: 0 }}>{v.label}</Tag> : null
}

/** Correlation at every horizon - small text. */
function CorrStrip({ r }) {
  return (
    <Text style={{ fontSize: 11 }}>
      {HORIZONS.map((h, i) => <span key={h}>{i ? ' · ' : ''}{h}m <span style={{ color: corrColor(r[`corr${h}`]) }}>{corr(r[`corr${h}`])}</span></span>)}
    </Text>
  )
}

/** The report: a row a card, its reads under it; a block a card on a phone. */
function ReportTable({ report, horizon }) {
  const narrow = useMediaQuery('(max-width: 768px)')
  const h = horizon
  const rows = report.cards.map((c) => ({ ...c, key: c.card, children: c.reads.length > 1 ? c.reads.map((r) => ({ ...r, key: `${c.card}|${r.read}` })) : undefined }))
  if (narrow) {
    return (
      <div>
        {rows.map((c) => (
          <div key={c.key} className="oa-bg-run" style={{ marginBottom: 8 }}>
            <Space wrap size={[6, 2]}><Text strong>{c.label}</Text><VerdictTag v={c.verdict} /></Space>
            <div><Text type="secondary" style={{ fontSize: 11 }}>{c.meant}</Text></div>
            {!c.events ? <Text type="secondary" style={{ fontSize: 12 }}>No events.</Text> : (
              <>
                <div style={{ fontSize: 12 }}>{c.events} events · {c.days} days · {expectText(c)} · at {h}m: {measures(c, h).main}, {c.kind === 'vol' ? 'bigger' : 'hit'} {measures(c, h).second}</div>
                <CorrStrip r={c} />
                {c.reads.map((r) => (
                  <div key={r.read} style={{ fontSize: 11, paddingLeft: 8, borderLeft: '2px solid #303030', marginTop: 4 }}>
                    {r.label} - {r.events} · {measures(r, h).main} · {r.kind === 'vol' ? 'bigger' : 'hit'} {measures(r, h).second} · corr {corr(r[`corr${h}`])} <VerdictTag v={r.verdict} />
                  </div>
                ))}
              </>
            )}
          </div>
        ))}
      </div>
    )
  }
  const columns = [
    {
      title: 'Card / read', key: 'label', width: 280,
      render: (_, r) => (r.meant
        ? <Tooltip title={r.meant}><Text strong>{r.label}</Text><br /><Text type="secondary" style={{ fontSize: 11 }}>{r.events ? expectText(r) : 'no events'}</Text></Tooltip>
        : <><Text style={{ fontSize: 12 }}>{r.label}</Text><br /><Text type="secondary" style={{ fontSize: 11 }}>{expectText(r)}</Text></>),
    },
    { title: 'Events', key: 'events', width: 80, render: (_, r) => (r.events ? <>{r.events}<br /><Text type="secondary" style={{ fontSize: 11 }}>{r.days} days</Text></> : '—') },
    { title: `Verdict (${h}m)`, key: 'verdict', width: 150, render: (_, r) => <VerdictTag v={r.verdict} /> },
    {
      title: <Tooltip title="Directional reads: the average move their way. Volatility reads: the move's size against usual (1× = usual).">Move at {h}m</Tooltip>, key: 'main', width: 120,
      render: (_, r) => (r.events ? <Tooltip title={measures(r, h).mainTip}>{measures(r, h).main}</Tooltip> : null),
    },
    {
      title: <Tooltip title="Directional reads: how often price went their way. Volatility reads: how often the move was bigger than usual.">Hit / bigger</Tooltip>, key: 'second', width: 110,
      render: (_, r) => (r.events ? <Tooltip title={measures(r, h).secondTip}>{measures(r, h).second}</Tooltip> : null),
    },
    {
      title: <Tooltip title="Directional: the read's side (+1 / −1) against the move that followed. Volatility: the expectation (+1 bigger / −1 smaller) against the move's size over usual. + = it tells, 0 = nothing, − = the opposite.">Correlation</Tooltip>, key: 'corr', width: 120,
      render: (_, r) => (r.events ? <Text strong style={{ color: corrColor(r[`corr${h}`]) }}>{corr(r[`corr${h}`])}</Text> : null),
    },
    { title: 'By horizon (correlation)', key: 'strip', width: 260, render: (_, r) => (r.events ? <CorrStrip r={r} /> : null) },
    {
      title: <Tooltip title="Directional reads: the average most the price went its way / against it in the hour (points).">Best / worst 60m</Tooltip>, key: 'bw', width: 120,
      render: (_, r) => (r.kind === 'dir' && Number.isFinite(r.avgBest) ? `${r.avgBest.toFixed(0)} / ${r.avgWorst.toFixed(0)}` : r.kind === 'vol' && Number.isFinite(r.rangeRatio) ? <Tooltip title="the hour's range after it against usual">range {ratio(r.rangeRatio)}</Tooltip> : null),
    },
  ]
  return <Table size="small" columns={columns} dataSource={rows} pagination={false} scroll={{ x: 1240 }} expandable={{ indentSize: 12 }} />
}

/** A day's spot candles with the events marked (green ▲ bullish under, red ▼ bearish over, a grey dot a volatility read). */
function DayChart({ bars, events }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!ref.current || !bars?.length) return undefined
    const chart = createZoomableChart(ref.current, {
      width: ref.current.clientWidth, height: 380,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 12 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter },
      localization: { timeFormatter: istTimeFormatter },
    })
    const series = chart.addSeries(CandlestickSeries, { upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR })
    series.setData(bars.map((b) => ({ time: (b.t + IST_MS) / 1000, open: b.o, high: b.h, low: b.l, close: b.c })))
    const first = bars[0].t, last = bars.at(-1).t
    createSeriesMarkers(series, events.filter((e) => e.time >= first && e.time <= last).map((e) => ({
      time: (Math.floor(e.time / 60_000) * 60_000 + IST_MS) / 1000,
      position: e.kind === 'vol' ? 'aboveBar' : e.dir > 0 ? 'belowBar' : 'aboveBar',
      shape: e.kind === 'vol' ? 'circle' : e.dir > 0 ? 'arrowUp' : 'arrowDown',
      color: e.kind === 'vol' ? '#8c8c8c' : e.dir > 0 ? UP_COLOR : DOWN_COLOR,
      text: e.kind === 'vol' ? '' : MARK[e.card] ?? '',
    })).sort((a, b) => a.time - b.time))
    chart.timeScale().fitContent()
    const ro = new ResizeObserver(() => chart.applyOptions({ width: ref.current?.clientWidth ?? 600 }))
    ro.observe(ref.current)
    return () => { ro.disconnect(); chart.remove() }
  }, [bars, events])
  return <div ref={ref} style={{ width: '100%' }} />
}

/**
 * The COMPONENT CHECK page (componentCheck.js): every OI Replay card's reads over past days and what price did after each -
 * per card and read: hit % / move its way (directional reads), the move's size against usual (volatility reads), the
 * correlation, a verdict against what it is meant for; every event (CSV), a day chart with them marked. Up to 60 days on
 * the page, up to 1 500 as a background run (the Signal backtest's queue, kind "components"). Places nothing.
 */
export default function ComponentCheckPage() {
  const today = istToday()
  const [underlying, setUnderlying] = usePersistedState(STORE.index, 'NIFTY')
  const [range, setRange] = usePersistedState(STORE.range, [dayjs(today).subtract(1, 'month').format('YYYY-MM-DD'), dayjs(today).subtract(1, 'day').format('YYYY-MM-DD')])
  const [horizonSaved, setHorizon] = usePersistedState(STORE.horizon, 30)
  const horizon = HORIZONS.includes(horizonSaved) ? horizonSaved : 30
  const [bgTelegram, setBgTelegram] = usePersistedState(STORE.telegram, true)
  const [outcomes, setOutcomes] = useState(null)        // the page's run
  const [ran, setRan] = useState(null)                  // { underlying, dates, sources, seconds }
  const [stored, setStored] = useState(null)            // an opened background run: { job, body }
  const [progress, setProgress] = useState(null)
  const [cardFilter, setCardFilter] = useState('all')
  const [chartDay, setChartDay] = useState(null)
  const [bgOpen, setBgOpen] = useState(false)
  const abortRef = useRef(null)
  const { jobs: allJobs, refresh } = useBackgroundRuns()
  const jobs = useMemo(() => allJobs.filter((j) => j.kind === 'components'), [allJobs])
  const dates = useMemo(() => (range?.[0] && range?.[1] ? backtestDays(range[0], range[1], today) : []), [range, today])
  const allDates = useMemo(() => (range?.[0] && range?.[1] ? backtestDays(range[0], range[1], today, MAX_BACKGROUND_DAYS) : []), [range, today])
  const running = progress != null

  const run = async () => {
    if (!dates.length) return
    const controller = new AbortController()
    abortRef.current = controller
    setStored(null)
    setOutcomes(null)
    setChartDay(null)
    const started = Date.now()
    const list = []
    const sources = { disk: 0, dhan: 0 }
    try {
      for (let k = 0; k < dates.length; k++) {
        setProgress({ done: k, total: dates.length, day: dates[k] })
        let day = await loadComponentDay(underlying, dates[k], { signal: controller.signal, keepBars: true })
        if (day.retry) day = await loadComponentDay(underlying, dates[k], { signal: controller.signal, keepBars: true })
        if (day.dhanCalls != null) sources[day.dhanCalls > 0 ? 'dhan' : 'disk']++
        list.push(day)
        setOutcomes([...list])
      }
    } catch (err) {
      if (!controller.signal.aborted) message.error(String(err?.message ?? err))
    } finally {
      setProgress(null)
      abortRef.current = null
      setRan({ underlying, dates: list.map((d) => d.date), sources, seconds: Math.round((Date.now() - started) / 1000) })
    }
  }
  const stop = () => abortRef.current?.abort()

  const report = useMemo(() => {
    if (stored) return stored.body?.components ?? null
    return outcomes?.length ? componentReport(outcomes, { horizon }) : null
  }, [stored, outcomes, horizon])
  // A stored report was worked out at its own horizon - its verdicts stay; the numbers at every horizon are there.
  const shownHorizon = stored ? (report?.horizon ?? horizon) : horizon
  const events = useMemo(() => (stored || !outcomes ? [] : outcomes.filter((o) => o.ok).flatMap((o) => o.events.map((e) => ({ ...e, date: o.date })))), [stored, outcomes])
  const shownEvents = useMemo(() => (cardFilter === 'all' ? events : events.filter((e) => e.card === cardFilter)), [events, cardFilter])
  const runDays = useMemo(() => (stored ? (stored.body?.dates ?? []) : (outcomes ?? []).filter((o) => o.ok).map((o) => o.date)), [stored, outcomes])
  const chartUnderlying = stored ? stored.job.underlying : (ran?.underlying ?? underlying)

  // The day chart: the page's run has the day; an opened background run's day is loaded when picked (a click).
  const [loadedDay, setLoadedDay] = useState(null)
  const haveDay = useMemo(() => (!stored && chartDay ? outcomes?.find((o) => o.ok && o.date === chartDay) ?? null : null), [stored, chartDay, outcomes])
  const needLoad = Boolean(chartDay) && !haveDay && !(!stored && outcomes?.some((o) => o.date === chartDay && !o.ok))
  useEffect(() => {
    if (!needLoad) return undefined
    const controller = new AbortController()
    loadComponentDay(chartUnderlying, chartDay, { signal: controller.signal, keepBars: true })
      .then((d) => setLoadedDay(d.ok ? { key: `${chartUnderlying}|${chartDay}`, date: chartDay, bars: d.bars, events: d.events } : { key: `${chartUnderlying}|${chartDay}`, date: chartDay, error: d.reason }))
      .catch(() => {})
    return () => controller.abort()
  }, [needLoad, chartDay, chartUnderlying])
  const chartData = useMemo(() => (!chartDay ? null
    : haveDay ? { date: chartDay, bars: haveDay.bars, events: haveDay.events }
      : loadedDay?.key === `${chartUnderlying}|${chartDay}` ? loadedDay : { date: chartDay, loading: true }), [chartDay, haveDay, loadedDay, chartUnderlying])
  const chartEvents = useMemo(() => (chartData?.events ?? []).filter((e) => cardFilter === 'all' || e.card === cardFilter), [chartData, cardFilter])

  const downloadCsv = () => {
    const blob = new Blob([eventsCsv(outcomes ?? [])], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `component-check-${ran?.underlying ?? underlying}-${range?.[0]}-${range?.[1]}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const queue = async () => {
    try {
      await queueRun({
        kind: 'components', telegram: bgTelegram,
        name: `Component check · ${underlying} · ${allDates.length} days`,
        settings: { underlying, from: range[0], to: range[1], horizon },
      })
      message.success('Queued - it runs on the server; the browser can be closed.')
      setBgOpen(false)
      refresh()
    } catch (err) {
      message.error(err.message)
    }
  }
  const openStored = async (job) => {
    try {
      const body = await runResult(job.id)
      setStored({ job, body })
      setChartDay(null)
      window.scrollTo({ top: 0, behavior: 'smooth' })
    } catch (err) {
      message.error(`The report could not be read: ${err.message}`)
    }
  }

  const eventColumns = [
    { title: 'Day', dataIndex: 'date', width: 100 },
    { title: 'Time', key: 'time', width: 64, render: (_, e) => hhmm(e.at) },
    { title: 'Card', key: 'card', width: 170, render: (_, e) => CARD_TITLE[e.card] },
    { title: 'Read', dataIndex: 'read', width: 220, render: (v, e) => <Tooltip title={e.text}>{v}</Tooltip> },
    { title: 'Side', key: 'side', width: 90, render: (_, e) => (e.kind === 'dir' ? <Text style={{ color: e.dir > 0 ? UP_COLOR : DOWN_COLOR }}>{e.dir > 0 ? 'bullish' : 'bearish'}</Text> : <Text type="secondary">{e.expect}</Text>) },
    { title: 'Price', key: 'price', width: 90, render: (_, e) => e.reaction?.base?.toFixed(1) ?? '—' },
    ...HORIZONS.map((h) => ({
      title: `${h}m`, key: `m${h}`, width: 70,
      render: (_, e) => {
        const m = e.reaction?.moves?.[h]
        if (m == null) return '—'
        const good = e.kind === 'dir' ? e.dir * m > 0 : null
        return <span style={{ color: good == null ? undefined : good ? UP_COLOR : DOWN_COLOR }}>{m >= 0 ? '+' : '−'}{Math.abs(m).toFixed(1)}</span>
      },
    })),
  ]

  const failed = report?.failed ?? []
  return (
    <div style={{ padding: 16, maxWidth: 1600, margin: '0 auto' }}>
      <Space align="center" style={{ marginBottom: 12 }} wrap>
        <NavBar />
        <Title level={4} style={{ margin: 0 }}>Component check</Title>
      </Space>
      <Card size="small" style={{ marginBottom: 12 }}>
        <FoldText id="componentCheck.intro" label="what it does" className="oa-note" style={{ marginBottom: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Every OI Replay card&apos;s own read, replayed over past days with that card&apos;s code (the current expiry, Standard GEX sign), each read an event at the minute it became known - and what spot did after it.
            Directional reads (OI breaks, 🎯, straddle trend and ideas, skew, GEX detection and walls, absorption, charm) are tested for direction: hit % and the move their way.
            Volatility reads (straddle sideways / trending, GEX regime, max gamma, dealer lean) are tested for size: was the move bigger or smaller than usual?
            A state read counts when it changes and holds {HOLD} minutes. It places nothing and feeds no strategy or alert.
          </Text>
        </FoldText>
        <Space wrap size={[12, 8]} align="center">
          <Segmented size="small" value={underlying} onChange={setUnderlying} options={BACKTEST_UNDERLYINGS} disabled={running} />
          <DaysPicker range={range} setRange={setRange} disabled={running} />
          <Text type="secondary" style={{ fontSize: 12 }}>
            {dates.length} day{dates.length === 1 ? '' : 's'}{allDates.length > dates.length ? ` (the latest ${MAX_BACKTEST_DAYS} on the page - ${allDates.length} in the background)` : ''}
          </Text>
          <Space size={4} align="center">
            <Text type="secondary" style={{ fontSize: 12 }}>Verdict at</Text>
            <Segmented size="small" value={horizon} onChange={setHorizon} options={HORIZONS.map((h) => ({ value: h, label: `${h}m` }))} />
          </Space>
          {running
            ? <Button danger icon={<StopOutlined />} onClick={stop}>Stop</Button>
            : <Button type="primary" icon={<PlayCircleOutlined />} onClick={run} disabled={!dates.length}>Run</Button>}
          <Button icon={<CloudServerOutlined />} onClick={() => setBgOpen(true)} disabled={!allDates.length}>Run in background</Button>
        </Space>
        {running && (
          <div style={{ marginTop: 8 }}>
            <Progress percent={Math.round((progress.done / progress.total) * 100)} size="small" />
            <Text type="secondary" style={{ fontSize: 12 }}>Day {progress.done + 1} of {progress.total} - {progress.day}</Text>
          </div>
        )}
        {!running && ran && !stored && (
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
            {ran.dates.length} days loaded in {ran.seconds} s: {loadSourceText(ran.sources)}
          </Text>
        )}
      </Card>

      {stored && (
        <Alert
          type="info" showIcon style={{ marginBottom: 12 }}
          message={<>Showing the background run <b>{stored.job.name}</b> ({stored.job.underlying}, {stored.body?.dates?.length ?? 0} days, verdicts at {report?.horizon ?? 30} min).</>}
          action={<Button size="small" onClick={() => setStored(null)}>Close</Button>}
        />
      )}

      {report && (
        <Card
          size="small" style={{ marginBottom: 12 }}
          title={`What each card's reads did - ${report.days} days, ${report.events.toLocaleString('en-IN')} events`}
          extra={!stored && outcomes?.length ? <Button size="small" icon={<DownloadOutlined />} onClick={downloadCsv}>Events CSV</Button> : null}
        >
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
            Usual move from any minute of these days: {HORIZONS.map((h) => `${h}m ${pct(report.baseline?.abs?.[h], 3)}`).join(' · ')} · hour&apos;s range {pct(report.baseline?.range, 3)}.
            Verdict: directional - hit ≥ 55% with the move its way = works, ≤ 45% against = opposite; volatility - ≥ 1.15× usual (or ≤ 0.87× for smaller) = works; under 10 events = too few.
          </Text>
          <ReportTable report={report} horizon={shownHorizon} />
          {failed.length > 0 && (
            <FoldText id="componentCheck.failed" label={`${failed.length} day(s) not run`} style={{ marginTop: 8 }}>
              <Text type="secondary" style={{ fontSize: 12 }}>{failed.slice(0, 60).map((f) => `${f.date}: ${f.reason}`).join(' · ')}</Text>
            </FoldText>
          )}
        </Card>
      )}

      {report && runDays.length > 0 && (
        <Card size="small" style={{ marginBottom: 12 }} title="Day chart and events">
          <Space wrap size={[12, 8]} style={{ marginBottom: 8 }}>
            <Select
              size="small" style={{ width: 220 }} value={cardFilter} onChange={setCardFilter}
              options={[{ value: 'all', label: 'Every card' }, ...CARDS.map((c) => ({ value: c.id, label: c.title }))]}
            />
            <Select
              size="small" style={{ width: 150 }} value={chartDay} onChange={setChartDay} placeholder="Pick a day"
              options={runDays.map((d) => ({ value: d, label: d }))} allowClear
            />
          </Space>
          {chartData?.loading && <Text type="secondary">Loading {chartData.date}…</Text>}
          {chartData?.error && <Alert type="warning" showIcon message={`${chartData.date}: ${chartData.error}`} />}
          {chartData?.bars && <DayChart bars={chartData.bars} events={chartEvents} />}
          {!stored && (
            <Table
              size="small" rowKey={(e) => `${e.date}|${e.card}|${e.read}|${e.at}`} columns={eventColumns} dataSource={shownEvents}
              pagination={{ pageSize: 25, showSizeChanger: false }} scroll={{ x: 1100 }} style={{ marginTop: 8 }}
              onRow={(e) => ({ onClick: () => setChartDay(e.date), style: { cursor: 'pointer' } })}
            />
          )}
        </Card>
      )}

      <BackgroundRunsCard jobs={jobs} refresh={refresh} viewingIds={stored ? [stored.job.id] : []} onOpen={openStored} />

      <Modal
        open={bgOpen} title="Run the Component check in the background" onCancel={() => setBgOpen(false)} onOk={queue} okText="Queue it"
      >
        <p>{underlying} · {allDates.length} weekdays ({range?.[0]} – {range?.[1]}){allDates.length >= MAX_BACKGROUND_DAYS ? ` - the latest ${MAX_BACKGROUND_DAYS}` : ''}, verdicts at {horizon} min.</p>
        <p style={{ fontSize: 12, opacity: 0.8 }}>It runs on the server, one run at a time - the browser can be closed. A day the server has not kept comes from Dhan once (then from disk).</p>
        <Checkbox checked={bgTelegram} onChange={(e) => setBgTelegram(e.target.checked)}>Telegram when it ends</Checkbox>
      </Modal>
    </div>
  )
}
