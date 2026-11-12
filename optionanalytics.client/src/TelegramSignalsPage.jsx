import { useEffect, useMemo, useRef, useState } from 'react'
import dayjs from 'dayjs'
import { Alert, Button, Card, Checkbox, DatePicker, Empty, Progress, Segmented, Select, Space, Table, Tag, Tooltip, Typography, Upload } from 'antd'
import { DownloadOutlined, ReloadOutlined, UploadOutlined } from '@ant-design/icons'
import { CandlestickSeries, CrosshairMode, createSeriesMarkers } from 'lightweight-charts'
import { AXIS_COLOR, BORDER_COLOR, DOWN_COLOR, GRID_COLOR, NavBar, UP_COLOR, istTickMarkFormatter, istTimeFormatter, toChartTime, usePersistedState } from './shared.jsx'
import { createZoomableChart } from './chartZoom.js'
import { FoldText } from './FoldText.jsx'
import {
  DEFAULT_KINDS, HORIZONS, KIND_LABEL, REACTION_WINDOW, SIGNAL_KINDS, barsOf, dayKeysOf, istDate, messagesToSignals, parseTelegramExport, reaction, reactionSummary,
  reactionsCsv,
} from './telegramSignals.js'

const { Title, Text } = Typography

// TELEGRAM SIGNALS (asked for - "a page which will read the messages and show me how the price reacts after those signals"):
// every Telegram message the app sent - the server keeps each one as it went (GET /api/telegram-log; a bot cannot read its
// own channel back) - or a Telegram Desktop export of the channel imported here, read as signals (telegramSignals.js), and
// the index's spot 1-minute bars after each one (GET /api/oi-replay/{u}/spot-day - the server's memory / disk): the move 5 /
// 15 / 30 / 60 minutes later in the signal's direction, the best and worst in the hour, a summary per kind and the day's
// chart around a picked signal. A click loads; nothing polls.
const INDICES = ['ALL', 'NIFTY', 'BANKNIFTY', 'SENSEX']
const TIME = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const pts = (v) => (v == null || !Number.isFinite(v) ? '…' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`)
const pctText = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`)
const color = (v) => (v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined)
const DIR = { 1: { text: '▲ bullish', color: 'green' }, '-1': { text: '▼ bearish', color: 'red' }, 0: { text: '–', color: 'default' } }
// Each index's spot day, kept for the tab (a past day never changes; today's is asked again with Load).
const SPOT_DAYS = new Map()

async function loadSpotDay(key, { fresh = false } = {}) {
  if (!fresh && SPOT_DAYS.has(key)) return SPOT_DAYS.get(key)
  const [u, date] = key.split('|')
  const r = await fetch(`/api/oi-replay/${u}/spot-day?date=${date}`)
  const body = await r.json().catch(() => null)
  if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`)
  const bars = barsOf(body)
  const day = { bars, error: bars.length ? null : body?.error ?? 'no spot minutes for the day' }
  if (date < dayjs().format('YYYY-MM-DD') && bars.length) SPOT_DAYS.set(key, day)
  return day
}

/** The day's spot candles around the signal picked, every signal of that index and day marked (the picked one larger). */
function SignalChart({ bars, signals, picked }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !bars?.length) return undefined
    const chart = createZoomableChart(el, {
      width: el.clientWidth, height: 380,
      layout: { background: { color: 'transparent' }, textColor: AXIS_COLOR, fontSize: 11 },
      grid: { vertLines: { color: GRID_COLOR }, horzLines: { color: GRID_COLOR } },
      rightPriceScale: { borderColor: BORDER_COLOR },
      timeScale: { borderColor: BORDER_COLOR, timeVisible: true, secondsVisible: false, tickMarkFormatter: istTickMarkFormatter },
      localization: { timeFormatter: istTimeFormatter },
      crosshair: { mode: CrosshairMode.Normal },
      handleScroll: { vertTouchDrag: false },
    })
    const candles = chart.addSeries(CandlestickSeries, { upColor: UP_COLOR, downColor: DOWN_COLOR, borderVisible: false, wickUpColor: UP_COLOR, wickDownColor: DOWN_COLOR, priceLineVisible: false })
    candles.setData(bars.map((b) => ({ time: toChartTime(b.t), open: b.o, high: b.h, low: b.l, close: b.c })))
    const minute = (ms) => toChartTime(Math.floor(ms / 60_000) * 60_000)
    const markers = signals.map((s) => {
      const me = s === picked
      return {
        time: minute(s.time), position: s.dir < 0 ? 'aboveBar' : 'belowBar', shape: s.dir > 0 ? 'arrowUp' : s.dir < 0 ? 'arrowDown' : 'circle',
        color: me ? '#ffd54f' : s.dir > 0 ? UP_COLOR : s.dir < 0 ? DOWN_COLOR : '#8c8c8c', size: me ? 2 : 1,
        text: me ? (KIND_LABEL[s.kind] ?? s.kind) : '',
      }
    }).sort((a, b) => a.time - b.time)
    createSeriesMarkers(candles, markers)
    if (picked?.reaction?.base) candles.createPriceLine({ price: picked.reaction.base, color: '#ffd54f', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'at signal' })
    if (picked) chart.timeScale().setVisibleRange({ from: minute(picked.time - 30 * 60_000), to: minute(picked.time + (REACTION_WINDOW + 30) * 60_000) })
    else chart.timeScale().fitContent()
    const resize = new ResizeObserver(() => { if (ref.current) chart.applyOptions({ width: ref.current.clientWidth }) })
    resize.observe(el)
    return () => { resize.disconnect(); chart.remove() }
  }, [bars, signals, picked])
  return <div ref={ref} style={{ width: '100%' }} />
}

export default function TelegramSignalsPage() {
  const today = dayjs().format('YYYY-MM-DD')
  const [range, setRange] = usePersistedState('optionanalytics.telegramSignals.range', null)
  const [index, setIndex] = usePersistedState('optionanalytics.telegramSignals.index', 'ALL')
  const [kinds, setKinds] = usePersistedState('optionanalytics.telegramSignals.kinds', DEFAULT_KINDS)
  const [sentOnly, setSentOnly] = usePersistedState('optionanalytics.telegramSignals.sentOnly', false)
  const [horizon, setHorizon] = usePersistedState('optionanalytics.telegramSignals.horizon', 30)
  const from = range?.[0] ?? dayjs().subtract(6, 'day').format('YYYY-MM-DD')
  const to = range?.[1] ?? today
  // The messages: { source: 'server' | 'file', name, messages } - and the spot days loaded for them.
  const [source, setSource] = useState(null)
  const [days, setDays] = useState({})
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)
  const [pickedKey, setPickedKey] = useState(null)
  const run = useRef(0)

  const loadPrices = async (messages, token) => {
    const keys = dayKeysOf(messagesToSignals(messages))
    const got = {}
    for (let k = 0; k < keys.length; k++) {
      if (run.current !== token) return
      setProgress({ done: k, total: keys.length, key: keys[k] })
      try { got[keys[k]] = await loadSpotDay(keys[k], { fresh: keys[k].endsWith(today) }) } catch (e) { got[keys[k]] = { bars: [], error: e.message } }
      setDays((d) => ({ ...d, [keys[k]]: got[keys[k]] }))
    }
    if (run.current === token) setProgress(null)
  }

  const loadServer = async () => {
    const token = ++run.current
    setError(null); setDays({}); setPickedKey(null); setProgress({ done: 0, total: 0, key: 'messages' })
    try {
      const r = await fetch(`/api/telegram-log?from=${from}&to=${to}`)
      const body = await r.json().catch(() => null)
      if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`)
      if (run.current !== token) return
      setSource({ source: 'server', name: `${body.from} – ${body.to}`, messages: body.messages ?? [] })
      await loadPrices(body.messages ?? [], token)
    } catch (e) {
      if (run.current === token) { setError(e.message); setProgress(null) }
    }
  }

  const importFile = async (file) => {
    const token = ++run.current
    setError(null); setDays({}); setPickedKey(null)
    try {
      const messages = parseTelegramExport(JSON.parse(await file.text()))
      if (!messages.length) throw new Error('No messages in that file - export the channel from Telegram Desktop as JSON (result.json).')
      setSource({ source: 'file', name: file.name, messages })
      await loadPrices(messages, token)
    } catch (e) {
      if (run.current === token) { setError(e.message); setProgress(null) }
    }
    return false
  }

  const signals = useMemo(() => messagesToSignals(source?.messages ?? []), [source])
  const rows = useMemo(() => signals
    .filter((s) => (index === 'ALL' || s.index === index) && kinds.includes(s.kind) && (!sentOnly || s.status === 'sent'))
    .map((s, k) => {
      const day = s.index ? days[`${s.index}|${istDate(s.time)}`] : null
      return { ...s, key: `${s.time}-${k}-${s.kind}`, reaction: day?.bars?.length ? reaction(s, day.bars) : null, dayError: day?.error ?? null }
    }), [signals, days, index, kinds, sentOnly])
  // Best first at the horizon picked: the average move in the signals' direction there.
  const summary = useMemo(() => reactionSummary(rows).sort((a, b) => (b[`avgPct${horizon}`] ?? -Infinity) - (a[`avgPct${horizon}`] ?? -Infinity)), [rows, horizon])
  const picked = rows.find((r) => r.key === pickedKey) ?? null
  const pickedDay = picked?.index ? days[`${picked.index}|${istDate(picked.time)}`] : null
  const sameDay = useMemo(() => (picked ? rows.filter((r) => r.index === picked.index && istDate(r.time) === istDate(picked.time)) : []), [rows, picked])
  const counts = useMemo(() => ({ all: signals.length, kinds: Object.fromEntries(SIGNAL_KINDS.map((k) => [k.id, signals.filter((s) => s.kind === k.id).length])) }), [signals])

  const downloadCsv = () => {
    const blob = new Blob([reactionsCsv(rows)], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `telegram-signals-${source?.source === 'file' ? 'import' : `${from}_${to}`}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const summaryColumns = [
    { title: 'Kind', dataIndex: 'label', key: 'label', fixed: 'left', width: 150 },
    { title: 'Signals', key: 'n', width: 90, render: (_, r) => <Tooltip title={`${r.bullish} bullish · ${r.bearish} bearish`}>{r.signals}</Tooltip> },
    ...HORIZONS.map((h) => ({
      title: h === horizon ? <Text strong>+{h} min ●</Text> : `+${h} min`, key: `h${h}`, width: 120,
      onCell: () => ({ style: h === horizon ? { background: 'rgba(255,213,79,0.06)' } : undefined }),
      render: (_, r) => <Space direction="vertical" size={0}><Text style={{ color: color(r[`avgPct${h}`]) }}>{pctText(r[`avgPct${h}`])}</Text><Text type="secondary" style={{ fontSize: 11 }}>{r[`hit${h}`] != null ? `${Math.round(r[`hit${h}`])}% its way · ${pts(r[`avgPts${h}`])} pts` : '—'}</Text></Space>,
    })),
    { title: `Best / worst (${REACTION_WINDOW} min)`, key: 'bw', width: 150, render: (_, r) => <Text><span style={{ color: UP_COLOR }}>{pts(r.avgBest)}</span> / <span style={{ color: DOWN_COLOR }}>{pts(r.avgWorst == null ? null : -r.avgWorst)}</span> pts</Text> },
  ]
  const columns = [
    { title: 'Time (IST)', key: 'time', fixed: 'left', width: 140, render: (_, r) => <Space direction="vertical" size={0}><Text>{TIME.format(new Date(r.time))}</Text>{r.status !== 'sent' && <Tag color={r.status === 'failed' ? 'red' : 'default'} style={{ margin: 0 }}>{r.status === 'off' ? 'not sent (Telegram off)' : 'send failed'}</Tag>}</Space> },
    { title: 'Index', key: 'index', width: 100, render: (_, r) => (r.index ? <Text>{r.index}{r.guessed ? <Text type="secondary"> ?</Text> : null}</Text> : <Text type="secondary">—</Text>) },
    { title: 'Kind', key: 'kind', width: 150, render: (_, r) => <Text>{KIND_LABEL[r.kind] ?? r.kind}{r.server ? <Tag style={{ marginLeft: 4 }}>server</Tag> : null}</Text> },
    { title: 'Side', key: 'dir', width: 100, render: (_, r) => <Tag color={DIR[r.dir]?.color} style={{ margin: 0 }}>{DIR[r.dir]?.text}</Tag> },
    { title: 'At signal', key: 'base', width: 100, render: (_, r) => (r.reaction ? r.reaction.base.toFixed(1) : <Tooltip title={r.dayError ?? (r.index ? 'loading the day…' : 'no index in the message')}><Text type="secondary">—</Text></Tooltip>) },
    ...HORIZONS.map((h) => ({
      title: `+${h}m`, key: `m${h}`, width: 80,
      render: (_, r) => {
        const v = r.dir ? r.reaction?.signed?.[h] : r.reaction?.moves?.[h]
        return r.reaction ? <Text style={{ color: r.dir ? color(v) : undefined }}>{pts(v)}</Text> : null
      },
    })),
    { title: 'Best / worst', key: 'bw', width: 120, render: (_, r) => (r.reaction ? <Text><span style={{ color: UP_COLOR }}>{pts(r.reaction.best)}</span> / <span style={{ color: DOWN_COLOR }}>{pts(r.reaction.worst == null ? null : -r.reaction.worst)}</span></Text> : null) },
    { title: 'Message', key: 'text', render: (_, r) => <Text style={{ fontSize: 12, whiteSpace: 'pre-wrap' }} ellipsis={{ tooltip: r.text }}>{r.text}</Text> },
  ]

  return (
    <div style={{ maxWidth: 1600, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>

        <Card size="small" title="Telegram signals - how the price moved after each one">
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <FoldText id="telegramSignals.intro" className="oa-note" style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }} summary="Every Telegram message the app sent, and how the index moved after it.">
              Every message the app sends to Telegram is kept by the server exactly as it went (a bot cannot read its own channel back, so the copy is kept
              at the source). Each one is read as a signal - its index, kind and side - and the index&apos;s spot after it: the move 5 / 15 / 30 / 60 minutes
              later in the signal&apos;s direction (a bearish signal that fell counts as a gain), and the best and worst it got in the hour. Older messages: import a
              Telegram Desktop export of the channel (JSON).
            </FoldText>
            <Space wrap size={8}>
              <DatePicker.RangePicker
                value={[dayjs(from), dayjs(to)]} allowClear={false} disabledDate={(d) => d.isAfter(dayjs(), 'day')}
                onChange={(v) => setRange(v ? [v[0].format('YYYY-MM-DD'), v[1].format('YYYY-MM-DD')] : null)}
                presets={[{ label: 'Today', value: [dayjs(), dayjs()] }, { label: 'Last 7 days', value: [dayjs().subtract(6, 'day'), dayjs()] }, { label: 'Last 30 days', value: [dayjs().subtract(29, 'day'), dayjs()] }, { label: 'Last 90 days', value: [dayjs().subtract(89, 'day'), dayjs()] }]}
              />
              <Button type="primary" icon={<ReloadOutlined />} onClick={loadServer} loading={progress != null && source?.source !== 'file'}>Load messages</Button>
              <Upload accept=".json,application/json" showUploadList={false} beforeUpload={importFile}>
                <Button icon={<UploadOutlined />}>Import Telegram export (JSON)</Button>
              </Upload>
              {rows.length > 0 && <Button icon={<DownloadOutlined />} onClick={downloadCsv}>CSV</Button>}
            </Space>
            <Space wrap size={8}>
              <Segmented value={index} onChange={setIndex} options={INDICES.map((u) => ({ value: u, label: u === 'ALL' ? 'All' : u }))} />
              <Select
                mode="multiple" value={kinds} onChange={setKinds} style={{ minWidth: 280, maxWidth: '100%' }} maxTagCount="responsive" placeholder="Kinds"
                options={SIGNAL_KINDS.map((k) => ({ value: k.id, label: `${k.label}${source ? ` (${counts.kinds[k.id] ?? 0})` : ''}` }))}
              />
              <Checkbox checked={sentOnly} onChange={(e) => setSentOnly(e.target.checked)}>Sent only</Checkbox>
              <Space size={4}><Text style={{ fontSize: 12 }}>&quot;Its way&quot; at</Text><Segmented size="small" value={horizon} onChange={setHorizon} options={HORIZONS.map((h) => ({ value: h, label: `${h}m` }))} /></Space>
            </Space>
            {source && <Text type="secondary" style={{ fontSize: 12 }}>{source.source === 'file' ? `Imported ${source.name}` : `The server's log ${source.name}`}: {source.messages.length} messages · {counts.all} signals · {rows.length} shown</Text>}
            {progress && (progress.total > 0
              ? <Progress percent={Math.round((progress.done / progress.total) * 100)} size="small" format={() => `prices ${progress.done} / ${progress.total} days`} />
              : <Text type="secondary" style={{ fontSize: 12 }}>Loading the messages…</Text>)}
            {error && <Alert type="error" showIcon message={error} />}
          </Space>
        </Card>

        {source && (
          <Card size="small" title={`Summary by kind - the average move in the signal's direction (% of the price), how often it went its way`}
            extra={<Text type="secondary" style={{ fontSize: 12 }}>signals with a side and a price only</Text>}>
            {summary.length
              ? <Table size="small" rowKey="kind" dataSource={summary} columns={summaryColumns} pagination={false} scroll={{ x: 900 }}
                  footer={() => <Text type="secondary" style={{ fontSize: 11 }}>&quot;Its way&quot; = the share whose move at that horizon was in the signal&apos;s direction. Sorted by the {horizon}-minute column (●) - pick another above.</Text>} />
              : <Empty description="No signal with a side and a price yet" />}
          </Card>
        )}

        {picked && (
          <Card size="small" title={`${picked.index} · ${TIME.format(new Date(picked.time))} · ${KIND_LABEL[picked.kind] ?? picked.kind}`} extra={<Button size="small" onClick={() => setPickedKey(null)}>Close</Button>}>
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              <Text style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{picked.text}</Text>
              {pickedDay?.bars?.length ? <SignalChart bars={pickedDay.bars} signals={sameDay} picked={picked} /> : <Alert type="info" showIcon message={pickedDay?.error ?? 'No spot minutes for this day yet.'} />}
            </Space>
          </Card>
        )}

        {source && (
          <Card size="small" title="Signals" extra={<Text type="secondary" style={{ fontSize: 12 }}>points after the signal, in its direction · click a row for its chart</Text>}>
            <Table
              size="small" rowKey="key" dataSource={rows} columns={columns} scroll={{ x: 1300 }} pagination={{ pageSize: 50, showSizeChanger: false }}
              onRow={(r) => ({ onClick: () => setPickedKey(r.key), style: { cursor: 'pointer', background: r.key === pickedKey ? 'rgba(255,213,79,0.08)' : undefined } })}
              locale={{ emptyText: <Empty description="No messages of these kinds" /> }}
            />
          </Card>
        )}
      </Space>
    </div>
  )
}
