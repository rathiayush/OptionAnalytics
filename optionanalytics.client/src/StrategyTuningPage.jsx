import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import dayjs from 'dayjs'
import { Alert, Button, Card, Checkbox, Col, DatePicker, InputNumber, Popconfirm, Progress, Row, Segmented, Select, Space, Switch, Table, Tag, Tooltip, Typography, message } from 'antd'
import { NavBar, useAuth, UP_COLOR, DOWN_COLOR } from './shared.jsx'
import { ACTIVE_STRATEGIES, SPOT_STRATEGIES, STRATEGY_BY_ID, TRADE_FILTERS } from './strategyEngine.js'
import { OI_COMBO_CAP, OI_FACTORS, OPTION_DEFAULT, countOiCombinations, oiFactorsFor, optionText, variantText } from './strategyTuning.js'
import { applyTunedFilters, putOnLiveList } from './scannerSettings.js'
import { ApplyTunedButton } from './ApplyTuned.jsx'
import ClearData from './ClearData.jsx'
import './tuningMobile.css'

const { Title, Text } = Typography
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX']
const POLL_MS = 3_000
const fmtR = (v) => (v == null || !Number.isFinite(v) ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`)
const colR = (v) => (v == null ? undefined : v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined)
const pct = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`)
const pts = (v) => (v == null || !Number.isFinite(v) ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}`)
const ist = (ms, opts) => (ms ? new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, ...opts }) : '-')
const timeOf = (ms) => ist(ms, { hour: '2-digit', minute: '2-digit' })

/** One option leg of a trade: what it was, the premium it was entered at, the premium at the exit, and the points. */
function Leg({ leg }) {
  if (!leg) return <Text type="secondary">-</Text>
  return (
    <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
      {leg.label} · {leg.entry?.toFixed(1)} → {leg.exit == null ? '?' : leg.exit.toFixed(1)} · <b style={{ color: colR(leg.points) }}>{pts(leg.points)}</b>
    </span>
  )
}

/** The points a setting captured on its winning trades, lost on its losing ones (stop-loss) and the net - for the
 *  index futures and for the option bought and the option sold. */
function PointsSummary({ rows, index, option = false }) {
  const group = (title, pick) => ({
    title,
    children: [
      { title: 'Captured', key: `${title}-c`, width: 88, render: (_, r) => { const s = pick(r.points); return s?.n ? <span style={{ color: UP_COLOR }}>{pts(s.captured)}</span> : '-' } },
      { title: 'Lost', key: `${title}-l`, width: 88, render: (_, r) => { const s = pick(r.points); return s?.n ? <span style={{ color: s.lost < 0 ? DOWN_COLOR : undefined }}>{pts(s.lost)}</span> : '-' } },
      { title: 'Net', key: `${title}-n`, width: 96, render: (_, r) => { const s = pick(r.points); return s?.n ? <b style={{ color: colR(s.total) }}>{pts(s.total)}</b> : '-' } },
      { title: 'Trades', key: `${title}-t`, width: 90, render: (_, r) => { const s = pick(r.points); return s?.n ? <Text type="secondary" style={{ fontSize: 11 }}>{s.wins}W {s.losses}L</Text> : '-' } },
    ],
  })
  return (
    <Table size="small" pagination={false} rowKey="k" dataSource={rows} scroll={{ x: 900 }} columns={[
      { title: 'Points', dataIndex: 'k', width: 110, fixed: 'left', render: (k) => <b>{k}</b> },
      ...(option
        ? [group('Option traded (premium points)', (p) => p)]
        : [group(`${index ?? 'Index'} futures`, (p) => p), group('Option bought', (p) => p?.buy), group('Option sold', (p) => p?.sell)]),
      { title: 'Stop-loss', key: 'sl', width: 150, render: (_, r) => (r.points?.slN ? <span>{r.points.slN} hit · <b style={{ color: DOWN_COLOR }}>{pts(r.points.slPoints)}</b> {option ? 'premium' : 'futures'}</span> : <Text type="secondary">none</Text>) },
    ]} />
  )
}

/** A trade's stop-loss and target as traded, with their distance in points, and where the trailing stop had moved it. */
function Levels({ t }) {
  if (!Number.isFinite(t.stop)) return <Text type="secondary">-</Text>
  return (
    <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>
      SL <span style={{ color: DOWN_COLOR }}>{t.stop.toFixed(1)}</span> ({t.slPts?.toFixed(1)}) · Tgt <span style={{ color: UP_COLOR }}>{Number.isFinite(t.target) ? t.target.toFixed(1) : '-'}</span>{t.targetPts != null && ` (${t.targetPts.toFixed(1)})`}
      {t.trailed && <><br /><Text type="secondary" style={{ fontSize: 11 }}>trailed to {t.finalStop.toFixed(1)} ({pts(t.lockedPts)})</Text></>}
    </span>
  )
}
/** The option's own SL / target premiums (none when it goes out with the index trade). */
function OptLevels({ o }) {
  if (o?.sl == null) return <Text type="secondary" style={{ fontSize: 12 }}>with the index trade</Text>
  return <span style={{ whiteSpace: 'nowrap', fontSize: 12 }}>SL <span style={{ color: DOWN_COLOR }}>{o.sl.toFixed(1)}</span> ({o.slPts.toFixed(1)}) · Tgt <span style={{ color: UP_COLOR }}>{o.target.toFixed(1)}</span> ({o.targetPts.toFixed(1)})</span>
}

/** Every trade of the best setting: the index, the futures entry and exit, the points, and both options' prices. */
function TradesTable({ trades }) {
  return (
    <Table size="small" rowKey={(t) => `${t.date}-${t.t}`} dataSource={trades} pagination={{ pageSize: 10, size: 'small', hideOnSinglePage: true }} scroll={{ x: 1000 }} columns={[
      { title: 'Day', dataIndex: 'date', width: 110 },
      { title: 'Time', key: 't', width: 130, render: (_, t) => `${timeOf(t.t)} → ${t.exitT ? timeOf(t.exitT) : 'day end'}` },
      { title: 'Index', dataIndex: 'index', width: 90 },
      { title: 'Side', dataIndex: 'side', width: 70, render: (v) => <span style={{ color: v === 'LONG' ? UP_COLOR : DOWN_COLOR }}>{v}</span> },
      { title: 'Futures in → out', key: 'f', width: 150, render: (_, t) => `${t.entry.toFixed(1)} → ${t.exit.toFixed(1)}` },
      { title: 'SL / target (points)', key: 'lv', width: 200, render: (_, t) => <Levels t={t} /> },
      { title: 'Closed by', dataIndex: 'exitReason', width: 100, render: (v) => <Text style={{ fontSize: 12 }}>{v ?? '-'}</Text> },
      { title: 'Points', dataIndex: 'points', width: 80, render: (v) => <b style={{ color: colR(v) }}>{pts(v)}</b> },
      { title: 'R', dataIndex: 'r', width: 70, render: (v) => <span style={{ color: colR(v) }}>{fmtR(v)}</span> },
      { title: 'Option bought: price in → out', key: 'b', render: (_, t) => <Leg leg={t.buy} /> },
      { title: 'Option sold: price in → out', key: 's', render: (_, t) => <Leg leg={t.sell} /> },
    ]} />
  )
}

/** Every option trade of the best option setting: the index trade, and the option - its name, premium in / out, the
 *  points and why it closed (its own SL / target, the index trade's exit, or the 15:10 square-off). */
function OptionTradesTable({ trades }) {
  return (
    <Table size="small" rowKey={(t) => `${t.date}-${t.t}`} dataSource={trades} pagination={{ pageSize: 10, size: 'small', hideOnSinglePage: true }} scroll={{ x: 1000 }} columns={[
      { title: 'Day', dataIndex: 'date', width: 110 },
      { title: 'Time', key: 't', width: 130, render: (_, t) => `${timeOf(t.t)} → ${timeOf(t.exitT)}` },
      { title: 'Index', dataIndex: 'index', width: 90 },
      { title: 'Side', dataIndex: 'side', width: 70, render: (v) => <span style={{ color: v === 'LONG' ? UP_COLOR : DOWN_COLOR }}>{v}</span> },
      { title: 'Index in → out', key: 'f', width: 150, render: (_, t) => `${t.entry.toFixed(1)} → ${t.exit.toFixed(1)} (${pts(t.indexPoints)})` },
      { title: 'Index SL / target', key: 'lv', width: 200, render: (_, t) => <Levels t={t} /> },
      { title: 'Option: premium in → out', key: 'o', render: (_, t) => <Leg leg={t.opt} /> },
      { title: 'Option SL / target (premium)', key: 'olv', width: 210, render: (_, t) => <OptLevels o={t.opt} /> },
      { title: 'Closed by', key: 'why', width: 210, render: (_, t) => <Text style={{ fontSize: 12 }}>{t.opt.reason}</Text> },
    ]} />
  )
}

const OPTION_PARAMS = [
  { key: 'optLeg', label: 'Option: buy or sell', fmt: (v) => (v === 'buy' ? 'Buy (gains with the move)' : 'Sell (write the losing side)') },
  { key: 'optMoneyness', label: 'Option: strike', fmt: (v) => (v === 0 ? 'ATM' : `${Math.abs(v)} ${v > 0 ? 'ITM' : 'OTM'}`) },
  { key: 'optExit', label: 'Option: exit', fmt: (v) => ({ index: 'With the index trade', indexSl: 'With the index trade, capped at a Max SL', first: 'Own SL / target or the index exit, first', option: 'Own SL / target only' }[v] ?? v) },
  { key: 'optSlPct', label: 'Option: SL (% of premium)', fmt: (v) => `${v}%` },
  { key: 'optTargetPct', label: 'Option: target (% of premium)', fmt: (v) => `${v}%` },
]
const hm = (x) => `${String(Math.floor(x / 100)).padStart(2, '0')}:${String(x % 100).padStart(2, '0')}`
/** One parameter's value in words. */
function paramText(key, v) {
  if (v == null) return '-'
  if (key === 'window') { const [a, b] = String(v).split('-').map(Number); return `${hm(a)} - ${hm(b)}` }
  const op = OPTION_PARAMS.find((o) => o.key === key)
  if (op) return op.fmt(v)
  const f = TRADE_FILTERS.find((x) => x.key === key)
  if (f?.options) return f.options.find((o) => o.value === v)?.label ?? String(v)
  if (key === 'tradeStopX' || key === 'tradeTargetX') return `x${v}`
  if (key === 'tradeTimeStop') return v > 0 ? `${v} min` : 'strategy\'s own'
  return String(v)
}
const PARAM_ROWS = [
  { key: 'tradeSide' }, { key: 'window', label: 'entry window (IST)' },
  ...TRADE_FILTERS.filter((f) => !['tradeSide', 'tradeFrom', 'tradeTo'].includes(f.key)).map((f) => ({ key: f.key })),
]
const labelOf = (key, fallback) => fallback ?? OPTION_PARAMS.find((o) => o.key === key)?.label ?? TRADE_FILTERS.find((f) => f.key === key)?.label?.replace(/^Trade( \(any strategy\))?: /, '') ?? key
const valueOf = (params, key) => (key === 'window' ? (params ? `${params.tradeFrom}-${params.tradeTo}` : null) : params?.[key])

/** Every parameter of the best setting next to the strategy as written - and, for each input tuned in this run, what
 *  each of its values did on the train days (the best combination with it), so an input left at Any shows it was
 *  tried and did not help. Inputs not tuned in this run (not ticked / not in this kind of tuning) say so. */
function ParamsTable({ r, minTrades }) {
  const factors = new Map((r.factors ?? []).map((f) => [f.key, f]))
  const rows = [...PARAM_ROWS, ...(r.unit === 'pts' ? OPTION_PARAMS : [])].map((p) => ({ key: p.key, label: labelOf(p.key, p.label), factor: factors.get(p.key) }))
  const asWritten = r.unit === 'pts' ? { ...r.baseline?.params, ...OPTION_DEFAULT } : r.baseline?.params
  const unit = r.unit ?? 'R'
  const f = unit === 'pts' ? (v) => `${pts(v)} pts` : fmtR
  return (
    <Table size="small" pagination={false} rowKey="key" dataSource={rows} scroll={{ x: 900 }} columns={[
      { title: 'Parameter', dataIndex: 'label', width: 260, render: (v) => <span style={{ fontSize: 12 }}>{v}</span> },
      { title: 'As written', key: 'aw', width: 160, render: (_, row) => <span style={{ fontSize: 12 }}>{paramText(row.key, valueOf(asWritten, row.key))}</span> },
      { title: 'Best setting', key: 'b', width: 180, render: (_, row) => {
        const v = valueOf(r.best?.params, row.key)
        const changed = r.best && String(v) !== String(valueOf(asWritten, row.key))
        return <span style={{ fontSize: 12, fontWeight: changed ? 600 : 400 }}>{r.best ? paramText(row.key, v) : '-'}{changed && <Tag color="blue" style={{ marginLeft: 6 }}>changed</Tag>}</span>
      } },
      { title: 'Each value tried (train days: best combination with it)', key: 'tr', render: (_, row) => {
        if (!row.factor) return <Text type="secondary" style={{ fontSize: 11 }}>not tuned in this run</Text>
        return (
          <Space size={[4, 2]} wrap>
            {row.factor.values.map((x) => (
              <Tooltip key={String(x.value)} title={x.best ? `${x.best.n} trades · win ${pct(x.best.winRate)} · total ${f(x.best.total)}` : x.tried ? `tried ${x.tried}x, at most ${x.maxN} trade(s) - below the minimum` : 'not reached by the step-by-step search'}>
                <Tag color={String(x.value) === String(row.factor.chosen) ? 'blue' : undefined} style={{ fontSize: 11, marginInlineEnd: 0 }}>
                  {paramText(row.key, x.value)}: {x.best ? <span style={{ color: colR(x.best.avg) }}>{f(x.best.avg)}</span> : <Text type="secondary" style={{ fontSize: 11 }}>{x.tried ? `under ${r.minTradesWanted ?? minTrades} trades` : 'skipped'}</Text>}
                </Tag>
              </Tooltip>
            ))}
          </Space>
        )
      } },
    ]} />
  )
}

/** A running job's detail: days scanned / skipped, how many came from the disk cache, a wait for a busy Dhan, time left. */
function JobDetail({ p, startedUtc }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])
  if (!p) return null
  const f = p.fetched
  const pre = p.prefetch
  const elapsed = startedUtc ? now - Date.parse(startedUtc) : null
  const left = p.stage === 'scan' && p.done > 2 && elapsed && Number.isFinite(p.total) ? (elapsed / p.done) * (p.total - p.done) : null
  const secs = (ms) => (ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)} h ${Math.round((ms % 3_600_000) / 60_000)} min` : ms >= 90_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(0, Math.round(ms / 1000))} s`)
  const wait = p.wait && Date.parse(p.wait.until) > now ? p.wait : null
  return (
    <Space direction="vertical" size={2} style={{ width: '100%' }}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {p.scanned != null && `${p.scanned} day(s) scanned`}{p.skipped ? `, ${p.skipped} skipped` : ''}
        {f && ` · ${f.cacheHits} read from the disk cache (no Dhan call), ${f.requests} fetched${f.retries ? `, ${f.retries} retried` : ''}`}
        {left != null && ` · about ${secs(left)} of scanning left`}
      </Text>
      {pre && <Text type="secondary" style={{ fontSize: 12 }}>fetching the option chain a cycle at a time: {pre.from} to {pre.to} ({pre.seeded} of {pre.of} day(s) so far)</Text>}
      {p.fastOi && !p.fastOi.used && p.fastOi.reason && <Text type="secondary" style={{ fontSize: 12 }}>Fetching a day at a time: {p.fastOi.reason}{p.fastOi.detail ? <Tooltip title={p.fastOi.detail}> <u>why</u></Tooltip> : null}</Text>}
      {wait && <Text type="secondary" style={{ fontSize: 12 }}>the data service is busy - trying again in {secs(Date.parse(wait.until) - now)} (this is handled; the job carries on by itself)</Text>}
    </Space>
  )
}

/** The days left out, by cause - the market having no data for a day is ordinary and not a fault; the data service
 *  staying busy is the only one worth acting on, and then only by running the job again. The day-by-day reasons are
 *  in the days table below rather than shouted here. */
function SkippedDays({ skipped }) {
  const busy = skipped.filter((s) => s.busy)
  const noData = skipped.filter((s) => !s.busy)
  const part = noData.filter((s) => /partial day/.test(s.reason ?? ''))
  const missing = noData.filter((s) => !/partial day/.test(s.reason ?? ''))
  const bits = [
    missing.length && `${missing.length} the market or the archive has no data for (a holiday, or a contract that has expired)`,
    part.length && `${part.length} that only part of the session was there for`,
    busy.length && `${busy.length} the data service stayed busy for - run the job again and the days already fetched come straight from the cache`,
  ].filter(Boolean)
  return <Alert type={busy.length ? 'warning' : 'info'} showIcon style={{ marginBottom: 8 }}
    message={`${skipped.length} day(s) left out of this run`} description={<span style={{ fontSize: 12 }}>{bits.join(' · ')}. Each one is listed with its own reason under the days below.</span>} />
}

/** The days a result was measured on - where each came from and how complete it was - and the days left out, with why. */
function DaysTable({ days, skipped }) {
  const rows = [...(days ?? []).map((d) => ({ ...d, used: true })), ...(skipped ?? []).map((d) => ({ ...d, used: false }))].sort((a, b) => (a.date < b.date ? 1 : -1))
  return (
    <Table size="small" rowKey="date" dataSource={rows} pagination={{ pageSize: 20, size: 'small', hideOnSinglePage: true }} scroll={{ x: 900 }} columns={[
      { title: 'Day', dataIndex: 'date', width: 110 },
      { title: 'Used', dataIndex: 'used', width: 70, render: (v, d) => (v ? <Tag color="success">used</Tag> : <Tooltip title={d.busy ? 'The server / Dhan stayed busy after every retry - run the job again (the days already fetched come from the cache)' : null}><Tag color={d.busy ? 'warning' : 'default'}>skipped</Tag></Tooltip>) },
      { title: 'Source', key: 'src', width: 150, render: (_, d) => (!d.used ? '-' : d.source === 'spot' ? 'spot + option chain' : d.estimated ? <Tooltip title="Rebuilt from 1-minute futures candles: no tape, no market depth - the order-flow checks are estimated">estimated (1-min candles)</Tooltip> : 'recorded (exact)') },
      { title: 'Minutes', key: 'm', width: 150, render: (_, d) => (d.used ? `${d.minutes ?? '-'} bars · OI ${d.oiMinutes ?? '-'}` : '-') },
      { title: 'Tape prints', dataIndex: 'prints', width: 100, render: (v, d) => (!d.used || d.estimated || d.source === 'spot' ? '-' : v ? v.toLocaleString('en-IN') : <Text type="warning">none</Text>) },
      { title: 'Previous session', dataIndex: 'previousSession', width: 130, render: (v, d) => (!d.used || d.source === 'spot' ? '-' : v ?? <Tooltip title="No previous session: the profile strategies (#11 - #14) could not trade this day"><Text type="warning">none</Text></Tooltip>) },
      { title: 'Notes', key: 'n', render: (_, d) => <Text style={{ fontSize: 12 }} type={d.used ? 'secondary' : undefined}>{d.used ? [d.futuresOi === false && d.source !== 'spot' ? 'no futures OI' : null, d.optionErrors?.length ? `${d.optionErrors.length} strike series empty: ${d.optionErrors[0]}` : null].filter(Boolean).join(' · ') || '-' : d.reason}</Text> },
    ]} />
  )
}

/** A tuned setting in words: the trade / OI filters, and the option when it was tuned. */
const settingText = (params, unit) => (params ? `${variantText(params)}${unit === 'pts' ? ` · ${optionText(params)}` : ''}` : '-')

/** [from, to] covering the last n calendar days up to yesterday (weekends are never fetched anyway). */
const lastDays = (n) => [dayjs().subtract(n, 'day').startOf('day'), dayjs().subtract(1, 'day').startOf('day')]

const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-')

/** n · avg · total · win% of one side of a result. */
function Score({ s, unit = 'R' }) {
  if (!s?.n) return <Text type="secondary">no trades</Text>
  const f = unit === 'pts' ? (v) => `${pts(v)} pts` : fmtR
  return (
    <span style={{ whiteSpace: 'nowrap' }}>
      {s.n} trades · <b style={{ color: colR(s.avg) }}>{f(s.avg)}</b>/trade · <span style={{ color: colR(s.total) }}>{f(s.total)}</span> · win {pct(s.winRate)}
    </span>
  )
}

/**
 * Strategy tuning: for each strategy (the top 3 by default), every combination of its trade filters - long /
 * short only, the entry window, stop / target size, time stop, trailing stop - tried on the past days the
 * server holds (scanner-runner/tune.mjs). Chosen on the older 70% of the days, checked on the newest 30%;
 * applied to the scanner's filters with one click.
 */
/** A <details> whose content is only built once it is first opened - a result's trade lists are thousands of rows. */
function LazyDetails({ summary, open = false, style, children }) {
  const [shown, setShown] = useState(open)
  return (
    <details open={open} style={style} onToggle={(e) => { if (e.currentTarget.open) setShown(true) }}>
      <summary style={{ cursor: 'pointer', fontSize: 12 }}>{summary}</summary>
      {shown ? children : null}
    </details>
  )
}

/** The finished job's result. Its own component (memo): the page's controls - index, data, strategies, dates - change
 *  the page's state on every click, and redrawing every table of a big result each time froze the page. */
const TuningResult = memo(function TuningResult({ result, isAdmin, spot, applyRef }) {
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
  const topColumns = (unit) => [
    { title: 'Setting', key: 'p', render: (_, row) => <span style={{ fontSize: 12 }}>{settingText(row.params, unit)}</span> },
    { title: 'Train (older days)', key: 'tr', render: (_, row) => <Score s={row.train} unit={unit} /> },
    { title: 'Test (newest days)', key: 'te', render: (_, row) => <Score s={row.test} unit={unit} /> },
  ]

  return (
    <>
            <Card size="small" title={`${result.underlying} · ${result.days?.length ?? 0} day(s) · finished ${when(result.finishedUtc)}`}
              extra={<Text type="secondary" style={{ fontSize: 11 }}>{result.what ? `tuned: ${{ both: 'OI, then trade', oi: 'OI confirmation', trade: 'trade settings', option: 'option trade', all: 'everything', check: 'nothing - re-check of the settings found so far' }[result.what] ?? result.what}${['both', 'oi', 'all'].includes(result.what) && result.oiFactors ? ` (${result.oiFactors.length} OI input(s), ${result.search === 'full' ? 'every combination' : 'step by step'})` : ''} · ` : ''}{result.days?.filter((d) => d.estimated).length ? `${result.days.filter((d) => d.estimated).length} estimated day(s) · ` : ''}min {result.minTrades} trades · {result.days?.[result.days.length - 1]?.date} to {result.days?.[0]?.date}{result.from || result.to ? ` (range asked: ${result.from ?? 'start'} to ${result.to ?? 'yesterday'})` : ''}</Text>}>
              {result.data === 'spot' && <Alert type="info" showIcon style={{ marginBottom: 8 }} message="Spot + options only: the index candles and the option chain's OI, no futures and no order flow. Points are index points; the option bought and sold are priced beside them. The live scanner does not run these strategies yet, so there is nothing to apply - this measures what they would have done." />}
              {result.skipped?.length > 0 && <SkippedDays skipped={result.skipped} />}
              <Table size="small" rowKey="id" columns={rankedColumns} dataSource={result.ranked ?? []} pagination={false} scroll={{ y: 320 }} />
              <LazyDetails style={{ marginTop: 8 }} summary={<>The {result.days?.length ?? 0} day(s) used{result.skipped?.length ? ` and ${result.skipped.length} left out` : ''}: where each came from and how complete it was{result.fetched ? ` · ${result.fetched.cacheHits} read from the disk cache, ${result.fetched.requests} fetched${result.fetched.retries ? `, ${result.fetched.retries} retried` : ''}` : ''}{result.fastOi?.used ? ` · option chain fetched a cycle at a time (${result.fastOi.seeded} day(s), checked against a day fetched on its own)` : result.fastOi?.reason ? ` · option chain fetched a day at a time: ${result.fastOi.reason}` : ''}</>}>
                <div style={{ marginTop: 6 }}><DaysTable days={result.days} skipped={result.skipped} /></div>
              </LazyDetails>
              {result.checks && (
                <Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
                  Cross-check: {result.checks.settings} tuned setting(s) re-measured on this run&apos;s days each was not chosen on
                  {result.checks.fromEarlierRuns ? ` (${result.checks.fromEarlierRuns} found by earlier runs)` : ''} - the Trades page ranks every setting on all its unseen days across runs and months, and marks the best there.
                </Text>
              )}
              <Text type="secondary" style={{ fontSize: 12 }}>Every trade of this run, with its date and time: <a href="/trades">Trades page</a>.</Text>
            </Card>
            {(result.results ?? []).map((r) => (
              <Card key={r.id} size="small"
                title={<Space size={8} wrap><span>#{r.no} {r.name}</span>{r.belowMin ? <Tag color="default">below the minimum trades</Tag> : r.recommend ? <Tag color="success">recommended</Tag> : <Tag color="warning">keep as written</Tag>}</Space>}
                extra={isAdmin && r.best && !spot && (
                  <ApplyTunedButton index={result.underlying} primary={r.recommend} label="Apply to the scanner" onApply={(live) => applyRef.current(r, result.underlying, live)}
                    title={`Apply to #${r.no} ${r.name}${result.underlying ? ` on ${result.underlying}` : ''}?`}
                    description={`${r.recommend ? variantText(r.best.params) : `Not recommended: ${r.reason}. Apply anyway - your call.`}${r.unit === 'pts' ? ' The option part - buy or sell, the strike and its SL / target - is applied to this strategy as well.' : ''} ${result.underlying ? `It runs with it on ${result.underlying} (paper, and live when ${result.underlying} is Live today and the strategy is on its live list); other indices keep theirs.` : ''} Whatever was applied to this strategy${result.underlying ? ` on ${result.underlying}` : ''} before is replaced.`} />
                )}>
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Text style={{ fontSize: 12 }}>{r.reason}. Chosen on {r.trainDays?.length} day(s) ({r.trainDays?.[0]} to {r.trainDays?.at(-1)}), checked on {r.testDays?.length} ({r.testDays?.[0] ?? '-'} to {r.testDays?.at(-1) ?? '-'}). {r.belowMin ? `${r.qualified} of ${r.tried} settings had 2+ trades; none had ${r.minTradesWanted ?? result.minTrades}+.` : `${r.qualified} of ${r.tried} settings had ${result.minTrades}+ trades.`}</Text>
                  <Table size="small" pagination={false} rowKey="k" columns={[
                    { title: '', dataIndex: 'k', width: 120, render: (k) => <b>{k}</b> },
                    { title: 'Setting', key: 'p', render: (_, row) => <span style={{ fontSize: 12 }}>{settingText(row.params, r.unit)}</span> },
                    { title: 'Train (older days)', key: 'tr', render: (_, row) => <Score s={row.train} unit={r.unit} /> },
                    { title: 'Test (newest days)', key: 'te', render: (_, row) => <Score s={row.test} unit={r.unit} /> },
                  ]} dataSource={[{ k: 'As written', ...r.baseline }, ...(r.best ? [{ k: 'Best setting', ...r.best }] : [])]} />
                  <PointsSummary index={result.underlying} option={r.unit === 'pts'} rows={[{ k: r.unit === 'pts' ? 'As before' : 'As written', points: r.baseline?.points }, ...(r.best ? [{ k: 'Best setting', points: r.best.points }] : [])]} />
                  {r.best && (
                    <LazyDetails summary="Every parameter: as written, the best setting, and what each value of the tuned inputs did (blue = chosen; avg per trade on the train days)">
                      <div style={{ marginTop: 6 }}><ParamsTable r={r} minTrades={result.minTrades} /></div>
                    </LazyDetails>
                  )}
                  {r.best?.suggest && (
                    <Alert type="info" showIcon message={`To trade it like this: ${r.best.suggest.leg.toUpperCase()} ${r.best.suggest.moneyness === 0 ? 'ATM' : `${Math.abs(r.best.suggest.moneyness)} strike(s) ${r.best.suggest.moneyness > 0 ? 'ITM' : 'OTM'}`}, option SL about ${r.best.suggest.slPoints.toFixed(1)}${r.best.suggest.targetPoints != null ? ` and target about ${r.best.suggest.targetPoints.toFixed(1)}` : ' (a Max SL only - out with the index trade, no option target)'} premium points (on a typical entry premium of ${r.best.suggest.premium.toFixed(1)}). Apply to the scanner sets all of this for this strategy - no need to change Trade settings by hand.`} />
                  )}
                  {r.best?.trades?.length > 0 && (
                    <LazyDetails summary={`The ${r.best.trades.length} trades of the best setting: index, SL and target, futures and option prices in and out, points`}>
                      <div style={{ marginTop: 6 }}>{r.unit === 'pts' ? <OptionTradesTable trades={r.best.trades} /> : <TradesTable trades={r.best.trades} />}</div>
                    </LazyDetails>
                  )}
                  {r.top?.length > 1 && (
                    <LazyDetails summary={`The ${r.top.length} best settings on the train days`}>
                      <Table size="small" pagination={false} rowKey={(row) => settingText(row.params, r.unit)} columns={topColumns(r.unit)} dataSource={r.top} style={{ marginTop: 6 }} />
                    </LazyDetails>
                  )}
                </Space>
              </Card>
            ))}
          </>
  )
})

export default function StrategyTuningPage() {
  const auth = useAuth()
  const isAdmin = auth?.user?.role === 'Admin'
  const [underlying, setUnderlying] = useState('NIFTY')
  const [pick, setPick] = useState('top3')
  const [custom, setCustom] = useState([])
  const [includeEstimated, setIncludeEstimated] = useState(false)
  const [minTrades, setMinTrades] = useState(8)
  const [what, setWhat] = useState('both')
  // Always a date range (from / to): the last 30 days to yesterday until another is picked.
  const [range, setRange] = useState(() => lastDays(30))
  const [data, setData] = useState('futures')
  const spot = data === 'spot'
  const [oiFactors, setOiFactors] = useState(OI_FACTORS.map((f) => f.key))
  // Spot + options has no futures at all, so the futures OI inputs are not offered there (they could only block a
  // trade, never confirm one) and any already ticked is dropped.
  const oiChoices = useMemo(() => oiFactorsFor(data), [data])
  useEffect(() => { setOiFactors((cur) => { const ok = oiChoices.map((f) => f.key); return cur.every((k) => ok.includes(k)) ? cur : cur.filter((k) => ok.includes(k)) }) }, [oiChoices])
  const [search, setSearch] = useState('step')
  const combos = useMemo(() => countOiCombinations(oiFactors), [oiFactors])
  const tunesOi = what !== 'trade' && what !== 'option' && what !== 'check' // the OI inputs are tuned (OI, OI then trade, everything)
  const tooMany = tunesOi && search === 'full' && combos.over
  const [status, setStatus] = useState(null)
  const [result, setResult] = useState(null)
  const [resultError, setResultError] = useState(null)
  // Drawn in the background: a big result takes a moment to lay out, and the page's buttons stay usable meanwhile.
  const shownResult = useDeferredValue(result)

  const loadResult = (u = underlying) => fetch(`/api/strategy-tuning/result/${u}${spot ? '?data=spot' : ''}`)
    .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`))))
    .then((x) => { setResult(x); setResultError(null) })
    .catch((err) => { setResult(null); setResultError(err.message) })
  const [dhanUsage, setDhanUsage] = useState(null)
  const loadStatus = () => {
    fetch('/api/strategy-tuning/status').then((r) => (r.ok ? r.json() : null)).then((s) => { if (s) setStatus(s) }).catch(() => {})
    fetch('/api/strategy-tuning/dhan-usage').then((r) => (r.ok ? r.json() : null)).then((u) => { if (u) setDhanUsage(u) }).catch(() => {})
  }
  useEffect(() => { loadResult(underlying) }, [underlying, data]) // eslint-disable-line react-hooks/exhaustive-deps
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
  const rangeOk = !!(range?.[0] && range?.[1])
  const jobBody = () => ({ underlying, strategies: pick === 'custom' ? custom : pick, days: 250, includeEstimated, minTrades, what, oiFactors, search, data,
    from: range?.[0]?.format('YYYY-MM-DD') ?? null, to: range?.[1]?.format('YYYY-MM-DD') ?? null })
  // The schedule: jobs run one after another on the server - for one index or several, now or at a set time, once or daily.
  const [queue, setQueue] = useState([])
  const [schedIndices, setSchedIndices] = useState(null) // null: the index picked above
  const [schedAt, setSchedAt] = useState(null)
  const [schedRepeat, setSchedRepeat] = useState(false)
  // Split the range into pieces of N days - one job per piece (and index), run one after another, instead of one long job.
  const [schedChunk, setSchedChunk] = useState(0)
  const pieceCount = schedChunk > 0 && rangeOk ? Math.ceil((range[1].diff(range[0], 'day') + 1) / schedChunk) : 1
  const loadQueue = () => fetch('/api/strategy-tuning/queue').then((r) => (r.ok ? r.json() : null)).then((q) => { if (q) setQueue(q) }).catch(() => {})
  useEffect(() => { loadQueue(); const id = setInterval(loadQueue, 10_000); return () => clearInterval(id) }, [])
  const schedule = async () => {
    const body = { job: jobBody(), underlyings: schedIndices?.length ? schedIndices : [underlying], runAtUtc: schedAt ? schedAt.toISOString() : null,
      repeatDaily: schedChunk > 0 ? false : schedRepeat, chunkDays: schedChunk > 0 ? schedChunk : null }
    const res = await fetch('/api/strategy-tuning/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const json = await res.json().catch(() => null)
    if (!res.ok) { message.error(json?.error ?? `HTTP ${res.status}`); return }
    message.success(`${json.length} job(s) scheduled - they run one after another`)
    loadQueue()
  }
  const unschedule = (id) => fetch(`/api/strategy-tuning/queue/${id}`, { method: 'DELETE' }).then(loadQueue)
  // A finished job and everything it produced: its run (trades, settings, days), its result and its cached days.
  const deleteJob = async (q) => {
    const res = await fetch(`/api/strategy-tuning/queue/${q.id}/delete-all`, { method: 'POST' })
    const json = await res.json().catch(() => null)
    if (!res.ok) { message.error(json?.error ?? `HTTP ${res.status}`); return }
    const d = json?.deleted
    message.success(d?.runId
      ? `Deleted ${q.job?.underlying}'s job: its run (${d.historyFiles} file(s)${d.runRow ? ', its row in the history' : ''}), ${d.resultFiles} result file(s), ${d.cacheFiles} cached day file(s)`
      : 'Deleted - it had no run of its own (nothing else to remove)')
    if (json?.queue) setQueue(json.queue); else loadQueue()
    loadResult(underlying)
  }
  const clearFinished = () => fetch('/api/strategy-tuning/queue/clear-finished', { method: 'POST' }).then(loadQueue)
  const start = async () => {
    const body = jobBody()
    const res = await fetch('/api/strategy-tuning/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const json = await res.json().catch(() => null)
    if (!res.ok) { message.error(json?.error ?? `HTTP ${res.status}`); return }
    setStatus(json)
    loadQueue() // a run by hand is on the schedule too
    message.success(`Tuning ${underlying} started`)
  }
  const cancel = () => fetch('/api/strategy-tuning/cancel', { method: 'POST' }).then(loadStatus)
  // Apply, for the result's buttons - through a ref so the (memoised) result is not redrawn on every page change.
  const applyRef = useRef(null)
  const apply = async (r, index = null, addToLive = false) => {
    try {
      // `pts` means the option itself was tuned, so the buy / sell, the strike and its SL / target go across too.
      const option = r.unit === 'pts'
      // For the index it was tuned on (that index only).
      const filters = await applyTunedFilters(r.id, r.best.params, { option, index })
      if (addToLive && index) await putOnLiveList(index, r.id)
      message.success({
        content: `#${r.no} ${r.name}: ${Object.keys(filters ?? {}).length ? `${variantText(r.best.params)}${option ? ` · ${optionText(r.best.params)}` : ''}` : 'back to its defaults'} - in force now${index ? ` on ${index}` : ''} for this browser's scanner and the server scanner, replacing whatever was applied before${addToLive && index ? `; on ${index}'s live list` : ''}`,
        duration: 8,
      })
    } catch (err) {
      message.error(err.message)
    }
  }
  useEffect(() => { applyRef.current = apply })

  const p = status?.progress
  // Each stage says where it is; a missing number never prints as "undefined" or "NaN".
  const nOf = (v) => (Number.isFinite(v) ? v : null)
  const ofDays = (done, total) => (nOf(total) ? ` (${Math.min((nOf(done) ?? 0) + 1, total)} of ${total} days)` : '')
  const progressText = !p ? 'starting…'
    : p.stage === 'prefetch' ? (p.checking
      ? `checking the option chain can be fetched a cycle at a time (${p.day ?? ''})`
      : `fetching the option chain a cycle at a time: ${p.prefetch?.from ?? p.day ?? ''} to ${p.prefetch?.to ?? ''}${nOf(p.total) ? ` (${nOf(p.done) ?? 0} of ${p.total} days so far)` : ''}`)
    : p.stage === 'retry' ? `coming back to ${nOf(p.total) ?? ''} day(s) the data service was busy for (round ${p.round} of ${p.rounds})`
    : p.stage === 'scan' ? (p.retrying ? `trying again ${p.day ?? ''} (${p.retrying} day(s) the server was busy for)` : `scanning ${p.day ?? ''}${ofDays(p.done, p.total)}`)
    : p.stage === 'rank' ? 'ranking the strategies'
    : p.stage === 'check' ? 'cross-checking every setting found so far on the days it was not chosen on'
    : p.stage === 'tune' ? `tuning #${STRATEGY_BY_ID[p.strategy]?.no} ${STRATEGY_BY_ID[p.strategy]?.name ?? p.strategy}${nOf(p.total) ? ` (${(nOf(p.done) ?? 0) + 1} of ${p.total})` : ''}${p.of ? `, ${p.tried.toLocaleString('en-IN')} of ${p.of.toLocaleString('en-IN')} OI combinations` : ''}`
    : p.stage
  const percent = !p ? 0
    : p.stage === 'prefetch' ? Math.round((nOf(p.done) ?? 0) / Math.max(1, nOf(p.total) ?? 1) * 10)
    : p.stage === 'retry' ? 80
    : p.stage === 'scan' ? 10 + Math.round(((nOf(p.done) ?? 0) / Math.max(1, nOf(p.total) ?? 1)) * 70)
    : p.stage === 'rank' ? 80
    : p.stage === 'check' ? 98
    : p.stage === 'tune' ? 80 + Math.round((((nOf(p.done) ?? 0) + (p.of ? Math.min(1, p.tried / p.of) : 0)) / Math.max(1, nOf(p.total) ?? 1)) * 20)
    : 100

  return (
    <div className="tuning-page" style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>
        <Card size="small" title="Strategy tuning">
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Finds the settings each strategy does best with: every past day is scanned once with the strategies&apos; rules, then the ways its
              trades can be taken are tried on those signals exactly as the scanner would take them, scored in R on the futures - the OI confirmation,
              step by step (options OI change, CE and PE each rising or falling, since the open, futures OI and short squeeze, move size, day type, the support / resistance OI and room to it, on 1, 3, 5 or 15 minutes) and the trade settings
              (7,200: long / short only, the entry time window, stop-loss and target size, a time stop, the trailing stop). To avoid fitting the past, a setting is chosen on the older 70% of
              the days and checked on the newest 30% it never saw; it is recommended only when it also wins there and beats the strategy as written.
              The strategy&apos;s entry rules are not changed. Runs on the server - you can leave the page.
            </Text>
            <Row gutter={[16, 8]} align="middle">
              <Col><Space size={6}><Text>Index</Text><Select value={underlying} onChange={setUnderlying} options={UNDERLYINGS.map((u) => ({ value: u, label: u }))} style={{ width: 130 }} /></Space></Col>
              <Col><Space size={6}><Text>Data</Text><Segmented value={data} onChange={(v) => { setData(v); setCustom([]); setResult(null) }} options={[
                { value: 'futures', label: <Tooltip title="The futures order flow (footprint, tape, depth) and the OI - the scanner's strategies">Futures + OI</Tooltip> },
                { value: 'spot', label: <Tooltip title="Only the index candles and the option chain's OI - no futures, no order flow. The spot + options strategies; any past day with OI data">Spot + options only</Tooltip> },
              ]} /></Space></Col>
              <Col><Space size={6}><Text>Strategies</Text><Segmented value={pick} onChange={setPick} options={[{ value: 'top3', label: 'Top 3' }, { value: 'top5', label: 'Top 5' }, { value: 'all', label: 'All' }, { value: 'custom', label: 'Pick' }]} /></Space></Col>
              {pick === 'custom' && (
                <Col flex="1 1 320px">
                  <Select mode="multiple" value={custom} onChange={setCustom} placeholder="Strategies to tune" style={{ width: '100%' }} maxTagCount="responsive"
                    options={(spot ? SPOT_STRATEGIES : ACTIVE_STRATEGIES).map((s) => ({ value: s.id, label: `#${s.no} ${s.name}` }))} />
                </Col>
              )}
              <Col><Space size={6}><Text>Tune</Text><Segmented value={what} onChange={setWhat} options={[
                { value: 'both', label: <Tooltip title="The OI confirmation first, then the trade settings on top of the best one">OI, then trade</Tooltip> },
                { value: 'oi', label: <Tooltip title="Options OI change (15 min) and since the open, futures OI, room to the next OI wall - the trade settings as they are">OI confirmation</Tooltip> },
                { value: 'trade', label: <Tooltip title="Sides, entry window, stop / target size, time stop, trailing stop">Trade settings</Tooltip> },
                { value: 'option', label: <Tooltip title="How it is taken in options: buy or sell, moneyness (ATM, 1-2 ITM, 1-2 OTM), and the option's own SL / target as a % of its premium - checked minute by minute on the premium, scored in premium points">Option trade</Tooltip> },
                { value: 'all', label: <Tooltip title="The OI confirmation, then the trade settings on top, then the option trade on top of those">Everything</Tooltip> },
                { value: 'check', label: <Tooltip title="No new tuning: every setting found so far for this index is measured on these days (each only on the days it was not chosen on) - e.g. pick September after tuning October, so October's setting is judged on September too. Every tuning run does this on its own days anyway.">Re-check settings</Tooltip> },
              ]} /></Space></Col>
              {tunesOi && (
                <Col flex="1 1 100%">
                  <Space size={6} wrap align="start">
                    <Text>OI to tune</Text>
                    <Checkbox.Group value={oiFactors} onChange={setOiFactors} options={oiChoices.map((f) => ({ value: f.key, label: f.label }))} />
                  </Space>
                  <div style={{ marginTop: 6 }}>
                    <Space size={8} wrap>
                      <Text>Search</Text>
                      <Segmented value={search} onChange={setSearch} options={[
                        { value: 'step', label: <Tooltip title="Each OI filter takes its best value given the others, then a second pass - a few hundred combinations, little chance of a lucky one">Step by step</Tooltip> },
                        { value: 'full', label: <Tooltip title="Every combination of the ticked OI inputs, nothing skipped - slower, and with this many tries one can win by luck: trust it only where it also wins on the unseen days">Every combination</Tooltip> },
                      ]} />
                      {search === 'full' && (tooMany
                        ? <Text type="danger">more than {OI_COMBO_CAP.toLocaleString('en-IN')} combinations - untick some OI inputs</Text>
                        : <Text type="secondary">{combos.count.toLocaleString('en-IN')} OI combinations per strategy</Text>)}
                    </Space>
                  </div>
                </Col>
              )}
              <Col>
                <Space size={6} wrap>
                  <Text>Days</Text>
                  <Tooltip title="Every past trading day in this range is used (up to 250; Saturdays and Sundays are never fetched); the older 70% choose, the newest 30% check"><DatePicker.RangePicker value={range} onChange={setRange} onCalendarChange={(v) => { if (v?.[0] && v?.[1]) setRange(v) }} format="DD MMM YYYY" allowClear={false}
                    presets={[30, 60, 90, 120, 250].map((n) => ({ label: `Last ${n} days`, value: lastDays(n) }))}
                    disabledDate={(d) => d && (!d.isBefore(dayjs().startOf('day')) || d.day() === 0 || d.day() === 6)} aria-label="Tuning date range" /></Tooltip>
                </Space>
              </Col>
              <Col><Space size={6}><Tooltip title="A setting needs at least this many trades on the train days to be recommended. When none reach it, the best found with fewer is still shown, marked 'below the minimum trades' and never recommended."><Text>Min trades</Text></Tooltip><InputNumber min={2} max={100} value={minTrades} onChange={(v) => v && setMinTrades(v)} style={{ width: 70 }} /></Space></Col>
              {!spot && <Col><Tooltip title="Also use days the server did not record live, rebuilt from 1-minute candles (no tape or market depth - the order-flow checks are estimated). More days, less exact."><Space size={6}><Switch size="small" checked={includeEstimated} onChange={setIncludeEstimated} /><Text>Include estimated days</Text></Space></Tooltip></Col>}
              <Col>
                {running
                  ? <Popconfirm title="Stop the tuning job?" onConfirm={cancel} disabled={!isAdmin}><Button danger disabled={!isAdmin}>Stop</Button></Popconfirm>
                  : <Button type="primary" onClick={start} disabled={!isAdmin || (pick === 'custom' && !custom.length) || (tunesOi && !oiFactors.length) || tooMany || !rangeOk}>Run tuning</Button>}
              </Col>
            </Row>
            {isAdmin && (
              <Row gutter={[12, 8]} align="middle" style={{ borderTop: '1px solid #ffffff14', paddingTop: 10 }}>
                <Col flex="1 1 100%"><Tooltip title="Add these settings to the schedule instead of running now: the server runs scheduled jobs one after another, so you can line up every index (or several kinds of tuning) and leave them."><Text strong>Schedule</Text></Tooltip>
                  {running && <Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>a job is running - change the settings above and add more; they wait their turn</Text>}</Col>
                <Col><Space size={6}><Text>Indices</Text><Checkbox.Group value={schedIndices ?? [underlying]} onChange={(v) => setSchedIndices(v)} options={UNDERLYINGS.map((u) => ({ value: u, label: u }))} /></Space></Col>
                <Col><Space size={6}><Text>Start</Text><DatePicker showTime={{ format: 'HH:mm' }} format="DD MMM YYYY HH:mm" value={schedAt} onChange={setSchedAt} placeholder="As soon as free" aria-label="Scheduled start" /></Space></Col>
                <Col><Tooltip title="Split the date range above into pieces of this many days: each piece (for each index ticked) is its own job, run one after another - several short jobs instead of one long one. The Trades page's Strategy performance adds them all up.">
                  <Space size={6}><Text>Split into</Text><Select value={schedChunk} onChange={setSchedChunk} style={{ width: 130 }} aria-label="Split the range"
                    options={[{ value: 0, label: 'one job' }, { value: 7, label: '7-day pieces' }, { value: 10, label: '10-day pieces' }, { value: 15, label: '15-day pieces' }, { value: 30, label: '30-day pieces' }]} />
                    {schedChunk > 0 && <Text type="secondary" style={{ fontSize: 12 }}>= {pieceCount * (schedIndices?.length || 1)} job(s)</Text>}</Space>
                </Tooltip></Col>
                <Col><Tooltip title={schedChunk > 0 ? 'Not with a split range' : 'Run it again every day at the same time; the date range moves forward a day each time'}><Space size={6}><Switch size="small" checked={schedChunk > 0 ? false : schedRepeat} disabled={schedChunk > 0} onChange={setSchedRepeat} aria-label="Repeat daily" /><Text>Every day</Text></Space></Tooltip></Col>
                <Col><Button onClick={schedule} disabled={(pick === 'custom' && !custom.length) || (tunesOi && !oiFactors.length) || tooMany || !rangeOk || (schedIndices != null && !schedIndices.length)}>Add to schedule</Button></Col>
                <Col><ClearData onCleared={() => { setResult(null); loadResult(underlying) }} /></Col>
              </Row>
            )}
            {queue.length > 0 && (
              <div>
                <Space size={8} style={{ marginBottom: 4 }}>
                  <Text strong style={{ fontSize: 13 }}>Jobs - scheduled and run by hand</Text>
                  <Text type="secondary" style={{ fontSize: 12 }}>run one after another - runs started by hand are listed too; each one's result is added to the Trades page's Strategy performance</Text>
                  {isAdmin && queue.some((q) => !['queued', 'running'].includes(q.state)) && <Button size="small" type="link" onClick={clearFinished}>Clear finished</Button>}
                </Space>
                <Table size="small" rowKey="id" dataSource={queue} pagination={{ pageSize: 10, size: 'small', hideOnSinglePage: true }} scroll={{ x: 900 }} columns={[
                  { title: 'Index', key: 'u', width: 100, render: (_, q) => q.job?.underlying },
                  { title: 'Job', key: 'j', render: (_, q) => <span style={{ fontSize: 12 }}>{q.job?.data === 'spot' ? 'spot + options · ' : ''}{Array.isArray(q.job?.strategies) ? `${q.job.strategies.length} strategies` : q.job?.strategies} · {{ both: 'OI, then trade', oi: 'OI', trade: 'trade settings', option: 'option trade', all: 'everything' }[q.job?.what] ?? q.job?.what} · {q.job?.from || q.job?.to ? `${q.job.from ?? 'start'} to ${q.job.to ?? 'yesterday'}` : `${q.job?.days} day(s)`}</span> },
                  { title: 'Start', key: 'at', width: 150, render: (_, q) => <span style={{ fontSize: 12 }}>{q.source === 'manual' ? <><Tag color="purple" style={{ marginRight: 4 }}>run by hand</Tag>{when(q.startedUtc)}</> : q.runAtUtc ? when(q.runAtUtc) : 'as soon as free'}{q.repeatDaily ? <Tag style={{ marginLeft: 4 }}>daily</Tag> : null}</span> },
                  { title: 'State', key: 's', width: 220, render: (_, q) => <span style={{ fontSize: 12 }}><Tag color={{ queued: 'default', running: 'processing', done: 'success', failed: 'error', cancelled: 'warning' }[q.state]}>{q.state}</Tag>{q.finishedUtc ? when(q.finishedUtc) : q.startedUtc ? `since ${when(q.startedUtc)}` : ''}{q.error ? <><br /><Text type="danger" style={{ fontSize: 11 }}>{q.error}</Text></> : null}</span> },
                  { title: '', key: 'x', width: 90, render: (_, q) => (!isAdmin ? null : q.state === 'queued' ? <Button size="small" type="link" danger onClick={() => unschedule(q.id)}>Remove</Button>
                    : q.state === 'running' ? null : (
                      <Popconfirm title={`Delete this ${q.job?.underlying} job and all its data?`}
                        description="Its tuning run (trades, settings, the days list), its result and the days it fetched into the cache are removed - Strategy performance, the live list and What wins stop counting it. Those days cost Dhan calls to fetch again."
                        okText="Delete" okButtonProps={{ danger: true }} onConfirm={() => deleteJob(q)}>
                        <Button size="small" type="link" danger>Delete</Button>
                      </Popconfirm>
                    )) },
                ]} />
              </div>
            )}
            {!isAdmin && <Alert type="info" showIcon message="Only an admin can run a tuning job or apply a result." />}
            {!spot && !includeEstimated && (
              <Alert type="warning" showIcon message="Only the recorded days will be used - the server keeps just the last few (in memory)."
                description="For a long run (30, 120, 250 days) switch on Include estimated days: the other days are rebuilt from 1-minute futures candles (no tape or market depth - the order-flow checks are estimated, and each is marked 'est.'). Or use Spot + options only, which needs no futures order flow." />
            )}
            {!running && <Text type="secondary" style={{ fontSize: 12 }}>Long runs: each past day is fetched once and kept on the server&apos;s disk, so a rerun, a longer range or a job resumed after a restart asks Dhan only for days it has not seen. Dhan allows 5 data calls a second and 1,00,000 a day: the server keeps to that and uses all five while you are not using the app, a rate limit is waited out in seconds, and the live pages and the scanner always go first (a page load never waits behind a job); the job stops before the last 10% of the day&apos;s allowance; a day that is incomplete - partial session, missing strikes - is left out and listed with the reason, never scored as a whole day.</Text>}
            {running && (
              <div>
                <Text style={{ fontSize: 12 }}>{status.job?.underlying}: {progressText} · started {when(status.startedUtc)}{status.job?.resumed ? ' · resumed after a server restart' : ''}</Text>
                <JobDetail p={p} startedUtc={status.startedUtc} />
                <Progress percent={percent} size="small" status="active" />
              </div>
            )}
            {dhanUsage && <Text type="secondary" style={{ fontSize: 12 }}>Dhan data calls today (this server): <b style={{ color: dhanUsage.calls >= 0.9 * dhanUsage.dailyLimit ? DOWN_COLOR : undefined }}>{dhanUsage.calls.toLocaleString('en-IN')}</b> of {dhanUsage.dailyLimit.toLocaleString('en-IN')} · 5 a second at most</Text>}
            {status?.state === 'failed' && <Alert type="error" showIcon message={`The last tuning job failed: ${status.error}`} />}
            {status?.state === 'cancelled' && <Alert type="warning" showIcon message="The last tuning job was stopped." />}
          </Space>
        </Card>

        {shownResult && <TuningResult result={shownResult} isAdmin={isAdmin} spot={shownResult.data === 'spot'} applyRef={applyRef} />}
        {!result && resultError && !running && <Alert type="info" showIcon message={resultError} description="Run a tuning job to see which settings each strategy does best with." />}
      </Space>
    </div>
  )
}
