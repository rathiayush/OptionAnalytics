import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import dayjs from 'dayjs'
import { Alert, Button, Card, Checkbox, Col, DatePicker, Drawer, InputNumber, Popconfirm, Row, Segmented, Select, Space, Switch, Table, Tag, Tooltip, Typography, message } from 'antd'
import { NavBar, useAuth, UP_COLOR, DOWN_COLOR } from './shared.jsx'
import { OPTION_TRADE_FILTERS, STRATEGY_BY_ID, TRADE_FILTERS, filtersForIndex } from './strategyEngine.js'
import { useNarrow } from './DomDrawer.jsx'
import { filtersFromTuning, paramsFromSettingsRow, settingSignature } from './strategyTuning.js'
import { applyFilterValue, applyTunedFilters, putOnLiveList, saveIndexFilters } from './scannerSettings.js'
import { AppliedSettings, ApplyTunedButton, LiveSetup, ParamsPopover } from './ApplyTuned.jsx'
import { confirmServerLive, useServerLive } from './ServerLive.jsx'
import ClearData from './ClearData.jsx'
import { fillRecordLegs, needsLegs, oldRuleLegs, recordRunUrl } from './recordLegs.js'
import { runnerSettingsOf } from './scannerCore.js'
import './tuningMobile.css'

const { Title, Text } = Typography
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX']
const num = (v) => (v == null || v === '' ? null : Number(v))
const f1 = (v) => (v == null || !Number.isFinite(v) ? '-' : v.toFixed(1))
const pts = (v) => (v == null || !Number.isFinite(v) ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}`)
const fmtR = (v) => (v == null || !Number.isFinite(v) ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`)
const col = (v) => (v == null || !Number.isFinite(v) ? undefined : v > 0 ? UP_COLOR : v < 0 ? DOWN_COLOR : undefined)
const hhmm = (s) => (s ? String(s).slice(11, 16) : '-') // "yyyy-MM-dd HH:mm:ss" (IST) -> HH:mm
const sideTag = (s) => <span style={{ color: s === 'LONG' ? UP_COLOR : DOWN_COLOR }}>{s}</span>
/** Where the trade exits on the INDEX (futures / spot): its stop-loss (and where a trailing stop had moved it), its
 *  target, and what closed it - the option trade goes out with it (unless the option's own SL / target came first). */
const indexExit = (t) => (
  <span style={{ fontSize: 12 }}>
    SL <b>{f1(num(t.stop))}</b> <Text type="secondary" style={{ fontSize: 11 }}>({f1(num(t.sl_points))} pts)</Text>
    {t.trailed_stop ? <Text type="secondary" style={{ fontSize: 11 }}> · trailed to {f1(num(t.trailed_stop))}</Text> : null}
    <br />Target <b>{f1(num(t.target))}</b> <Text type="secondary" style={{ fontSize: 11 }}>({f1(num(t.target_points))} pts)</Text>
    {t.closed_by ? <><br /><Text type="secondary" style={{ fontSize: 11 }}>closed by {t.closed_by}</Text></> : null}
  </span>
)
const INDEX_EXIT_TIP = 'The index (futures) stop-loss and target the trade exits on: the option is closed when the index trade is - its stop, target, trailing stop, time stop or 15:10 - unless the option\'s own SL / target is hit first'

/** Rows -> a CSV file the browser saves. */
function downloadCsv(name, columns, rows) {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  const text = [columns.map((c) => c.title).join(','), ...rows.map((r) => columns.map((c) => esc(c.value(r))).join(','))].join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

/** Totals over the rows shown: trades, wins / losses, win %, net points (and R when there is one). */
function Totals({ rows, points, r, extra }) {
  const p = rows.map(points).filter(Number.isFinite)
  const rs = r ? rows.map(r).filter(Number.isFinite) : []
  const wins = p.filter((x) => x > 0).length
  const losses = p.filter((x) => x < 0).length
  const net = p.reduce((a, b) => a + b, 0)
  const captured = p.filter((x) => x > 0).reduce((a, b) => a + b, 0)
  const lost = p.filter((x) => x < 0).reduce((a, b) => a + b, 0)
  return (
    <Space size={16} wrap style={{ fontSize: 13 }}>
      <span><b>{rows.length}</b> trades</span>
      <span>{wins}W / {losses}L{p.length ? ` · win ${Math.round((wins / p.length) * 100)}%` : ''}</span>
      <span>captured <b style={{ color: UP_COLOR }}>{pts(captured)}</b></span>
      <span>lost <b style={{ color: DOWN_COLOR }}>{pts(lost)}</b></span>
      <span>net <b style={{ color: col(net) }}>{pts(net)}</b> pts</span>
      {rs.length > 0 && <span>total <b style={{ color: col(rs.reduce((a, b) => a + b, 0)) }}>{fmtR(rs.reduce((a, b) => a + b, 0))}</b></span>}
      {extra}
    </Space>
  )
}

/** The points the trades captured, per index (points only add up within one): the index trade, the option bought and the
 *  option sold - captured (the winners), lost (the losers), net, and the options' net after costs (slippage both ways +
 *  charges a trade, in premium points). */
function PointsTotals({ byIndex, spot }) {
  const leg = (name, l, cost, tip) => ({ key: name, name, tip, ...l, cost })
  const rows = byIndex.flatMap((x) => [
    { ...leg(spot ? 'Spot (index)' : 'Futures (index)', x.points, null, 'The index trade in index points, in the direction of the signal'), index: x.index, first: true },
    { ...leg('Option bought', x.bought, x.costPoints, 'The option the setup buys (CE for a long, PE for a short) - premium points'), index: x.index },
    { ...leg('Option sold', x.sold, x.costPoints, 'The option the setup writes (PE for a long, CE for a short) - premium points'), index: x.index },
  ]).map((r) => ({ ...r, key: `${r.index}-${r.key}` }))
  const cell = (v, bold = false) => (v == null ? '-' : bold ? <b style={{ color: col(v) }}>{pts(v)}</b> : <span style={{ color: col(v) }}>{pts(v)}</span>)
  return (
    <Table size="small" pagination={false} rowKey="key" dataSource={rows} scroll={{ x: 760 }} aria-label="Points totals"
      columns={[
        { title: 'Index', dataIndex: 'index', width: 100, render: (v, r) => (r.first ? <b>{v}</b> : '') },
        { title: 'Points', dataIndex: 'name', width: 150, render: (v, r) => <Tooltip title={r.tip}><span>{v}</span></Tooltip> },
        { title: 'Trades', dataIndex: 'trades', width: 70 },
        { title: 'Won / lost', key: 'wl', width: 110, render: (_, r) => (r.trades ? `${r.wins} / ${r.losses}${r.trades ? ` · ${Math.round((r.wins / r.trades) * 100)}%` : ''}` : '-') },
        { title: <Tooltip title="Points of the winning trades">Captured</Tooltip>, dataIndex: 'captured', width: 110, render: (v, r) => (r.trades ? cell(v) : '-') },
        { title: <Tooltip title="Points of the losing trades">Lost</Tooltip>, dataIndex: 'lost', width: 100, render: (v, r) => (r.trades ? cell(v) : '-') },
        { title: 'Net points', dataIndex: 'net', width: 110, render: (v, r) => (r.trades ? cell(v, true) : '-') },
        { title: <Tooltip title="The option's net after costs: slippage both ways (the index's Trade settings) + charges (the live list's rules), a trade - in premium points">Net after costs</Tooltip>, key: 'nac', width: 160,
          render: (_, r) => (r.netAfterCosts == null || !r.trades ? <Text type="secondary" style={{ fontSize: 12 }}>-</Text> : <span>{cell(r.netAfterCosts, true)} <Text type="secondary" style={{ fontSize: 11 }}>({r.cost} pts a trade)</Text></span>) },
      ]} />
  )
}

/** One trade sequence for every strategy: by entry date, then time (then index, strategy number). */
const byTime = (order, timeOf) => (a, b) => (order === 'desc' ? -1 : 1) * (String(a.date ?? '').localeCompare(String(b.date ?? '')) || (timeOf(a) ?? 0) - (timeOf(b) ?? 0)
  || String(a.index ?? a.underlying ?? '').localeCompare(String(b.index ?? b.underlying ?? '')) || (Number(a.no ?? a.strategy_no) || 0) - (Number(b.no ?? b.strategy_no) || 0))
const OrderToggle = ({ value, onChange }) => <Segmented value={value} onChange={onChange} options={[{ value: 'asc', label: 'Oldest first' }, { value: 'desc', label: 'Newest first' }]} />
const istMs = (s) => (s ? Date.parse(`${String(s).replace(' ', 'T')}+05:30`) : null) // "yyyy-MM-dd HH:mm:ss" (IST) -> ms

const inDates = (date, range) => (!range?.[0] || date >= range[0].format('YYYY-MM-DD')) && (!range?.[1] || date <= range[1].format('YYYY-MM-DD'))
const strategyOptions = (rows, idOf, label) => [...new Map(rows.map((r) => [idOf(r), label(r)])).entries()].filter(([id]) => id).sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'en', { numeric: true })).map(([value, l]) => ({ value, label: l }))

// ---- One strategy's trades across every run ----------------------------------------------------------------------
const TUNED_KEYS = [...TRADE_FILTERS.map((f) => f.key), ...OPTION_TRADE_FILTERS]
/** The part of a strategy's scanner filters a tuned setting sets - to tell which tuned setting is live now. */
const tunedPart = (filters) => Object.fromEntries(TUNED_KEYS.filter((k) => filters?.[k] !== undefined).sort().map((k) => [k, filters[k]]))
/** Is this tuned setting the one the scanner runs with now? By the identity stored when it was applied (`_tuned`); a
 *  setting applied before that existed by its parameters - and never a strategy with nothing applied at all (a tuned
 *  setting that changed nothing from the defaults is not "live now", it is simply not applied). */
const isLive = (liveFilters, row) => {
  if (liveFilters == null) return false
  if (liveFilters._tuned) return liveFilters._tuned === settingSignature(row)
  const applied = tunedPart(liveFilters)
  return Object.keys(applied).length > 0 && JSON.stringify(applied) === JSON.stringify(tunedPart(filtersFromTuning({}, paramsFromSettingsRow(row), { option: row.unit === 'pts' })))
}

/** A trade row's R on one option leg ('bought' / 'sold'): its column, else its premium points over its SL (older rows). */
const legR = (t, k) => num(t[`${k}_r`]) ?? (num(t[`${k}_points`]) != null && num(t[`${k}_sl`]) > 0 ? num(t[`${k}_points`]) / num(t[`${k}_sl`]) : null)
const legRR = (t, k) => num(t[`${k}_rr`]) ?? (num(t[`${k}_sl`]) > 0 && num(t[`${k}_target`]) > 0 ? num(t[`${k}_target`]) / num(t[`${k}_sl`]) : null)
const sumOf = (xs) => { const v = xs.filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) : null }

/** The Strategy performance date range as query params (yyyy-MM-dd; either end optional). */
const rangeParams = (range) => ({ ...(range?.[0] ? { from: range[0].format('YYYY-MM-DD') } : {}), ...(range?.[1] ? { to: range[1].format('YYYY-MM-DD') } : {}) })
const rangeKey = (range) => `${range?.[0]?.format('YYYY-MM-DD') ?? ''}..${range?.[1]?.format('YYYY-MM-DD') ?? ''}`

function StrategyTrades({ target, data, onClose, narrow, range = null }) {
  const [setting, setSetting] = useState(target?.setting ?? 'both')
  const [index, setIndex] = useState(target?.index ?? 'all')
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const id = target?.strategyId
  useEffect(() => {
    if (!id) return
    const q = new URLSearchParams({ strategy: id, data, ...(setting === 'both' ? {} : { setting }), ...(index === 'all' ? {} : { index }), ...rangeParams(range) })
    fetch(`/api/strategy-tuning/performance/trades?${q}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((list) => { setRows({ key: `${id}|${setting}|${index}|${rangeKey(range)}`, list }); setError(null) }).catch((e) => setError(e.message))
  }, [id, data, setting, index, range]) // eslint-disable-line react-hooks/exhaustive-deps
  const list = rows?.key === `${id}|${setting}|${index}|${rangeKey(range)}` ? rows.list : null
  const shown = (list ?? []).map((t) => ({
    ...t, _p: num(t.points), _r: num(t.r), _rr: num(t.rr) ?? (num(t.sl_points) > 0 && num(t.target_points) > 0 ? num(t.target_points) / num(t.sl_points) : null),
    _br: legR(t, 'bought'), _brr: legRR(t, 'bought'), _sr: legR(t, 'sold'), _srr: legRR(t, 'sold'),
  }))
  return (
    <Drawer open={!!target} onClose={onClose} width={narrow ? '100%' : 1100} title={target ? `#${target.strategyNo} ${target.strategy} - every trade` : ''} destroyOnHidden>
      {target && (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Space wrap size={8}>
            <Segmented value={setting} onChange={setSetting} options={[{ value: 'both', label: 'All' }, { value: 'fine-tuned', label: 'Fine-tuned' }, { value: 'as written', label: 'As written' }]} />
            <Select value={index} onChange={setIndex} style={{ width: 130 }} options={[{ value: 'all', label: 'All indices' }, ...Object.keys(target.byIndex ?? {}).map((u) => ({ value: u, label: u }))]} />
            <Button size="small" disabled={!shown.length} onClick={() => downloadCsv(`${id}-trades.csv`, Object.keys(shown[0] ?? {}).filter((k) => !k.startsWith('_')).map((k) => ({ title: k, value: (r) => r[k] })), shown)}>Download CSV</Button>
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>Every trade of this strategy in every tuning run kept (a trade two runs both scanned is listed once). Fine-tuned trades are taken with the setting that run chose.</Text>
          {error && <Alert type="error" showIcon message={error} />}
          {list && <Totals rows={shown} points={(t) => t._p} r={(t) => t._r} extra={<>
            <span>option bought <b style={{ color: col(sumOf(shown.map((t) => t._br))) }}>{fmtR(sumOf(shown.map((t) => t._br)))}</b> ({pts(sumOf(shown.map((t) => num(t.bought_points))))} pts)</span>
            <span>option sold <b style={{ color: col(sumOf(shown.map((t) => t._sr))) }}>{fmtR(sumOf(shown.map((t) => t._sr)))}</b> ({pts(sumOf(shown.map((t) => num(t.sold_points))))} pts)</span>
          </>} />}
          {narrow ? (
            <Space direction="vertical" size={6} style={{ width: '100%' }}>
              {!list && !error && <Text type="secondary">loading…</Text>}
              {shown.map((t, i) => (
                <div key={i} style={{ borderTop: '1px solid #ffffff14', paddingTop: 6, fontSize: 12 }}>
                  <div><b>{t.date}</b> {t.entry_time_ist?.slice(11, 16)} → {t.exit_time_ist ? t.exit_time_ist.slice(11, 16) : 'end'} · {t.index} · {sideTag(t.side)} {t.setting === 'fine-tuned' ? <Tag color="blue">fine-tuned</Tag> : <Tag>as written</Tag>}</div>
                  <div>{f1(num(t.entry))} → {f1(num(t.exit))} · {t.closed_by || '-'} · <b style={{ color: col(t._p) }}>{pts(t._p)}</b> pts · <span style={{ color: col(t._r) }}>{fmtR(t._r)}</span></div>
                  <Text type="secondary" style={{ fontSize: 11 }}>index SL {f1(num(t.stop))} ({f1(num(t.sl_points))} pts){t.trailed_stop ? `, trailed to ${f1(num(t.trailed_stop))}` : ''} · target {f1(num(t.target))} ({f1(num(t.target_points))} pts)</Text><br />
                  <Text type="secondary" style={{ fontSize: 11 }}>risk : reward {rrText(t._rr)}</Text>
                  {(t.option_sold || t.option_bought) && <div style={{ fontSize: 11 }}>{t.option_bought ? <>bought {t.option_bought} <span style={{ color: col(num(t.bought_points)) }}>{pts(num(t.bought_points))}</span> = <b style={{ color: col(t._br) }}>{fmtR(t._br)}</b> ({rrText(t._brr)})</> : null}{t.option_sold ? <>{t.option_bought ? ' · ' : ''}sold {t.option_sold} <span style={{ color: col(num(t.sold_points)) }}>{pts(num(t.sold_points))}</span> = <b style={{ color: col(t._sr) }}>{fmtR(t._sr)}</b> ({rrText(t._srr)})</> : null}</div>}
                </div>
              ))}
            </Space>
          ) : (
            <Table size="small" loading={!list && !error} rowKey={(t, i) => `${t.run_id}-${t.date}-${t.entry_time_ist}-${t.setting}-${i}`} dataSource={shown} scroll={{ x: 1500 }}
              pagination={{ pageSize: 50, size: 'small', showSizeChanger: true, pageSizeOptions: [50, 100, 500] }}
              columns={[
                { title: 'Date', dataIndex: 'date', width: 100 },
                { title: 'In → out', key: 't', width: 110, render: (_, t) => `${t.entry_time_ist?.slice(11, 16)} → ${t.exit_time_ist ? t.exit_time_ist.slice(11, 16) : 'end'}` },
                { title: 'Index', dataIndex: 'index', width: 100 },
                { title: 'Setting', key: 's', width: 110, render: (_, t) => (t.setting === 'fine-tuned' ? <Tooltip title={t.setting_text}><Tag color="blue">fine-tuned</Tag></Tooltip> : <Tag>as written</Tag>) },
                { title: 'Side', dataIndex: 'side', width: 70, render: sideTag },
                { title: 'In → out', key: 'p', width: 140, render: (_, t) => `${f1(num(t.entry))} → ${f1(num(t.exit))}` },
                { title: <Tooltip title={INDEX_EXIT_TIP}>Index SL / target</Tooltip>, key: 'ix', width: 190, render: (_, t) => indexExit(t) },
                { title: 'Closed by', dataIndex: 'closed_by', width: 110 },
                { title: 'Points', key: 'pt', width: 80, sorter: (a, b) => a._p - b._p, render: (_, t) => <b style={{ color: col(t._p) }}>{pts(t._p)}</b> },
                { title: 'R', key: 'r', width: 70, sorter: (a, b) => a._r - b._r, render: (_, t) => <span style={{ color: col(t._r) }}>{fmtR(t._r)}</span> },
                { title: <Tooltip title="Planned risk : reward on the index trade (1 : target / SL)">R : R</Tooltip>, key: 'rr', width: 80, render: (_, t) => <span style={{ fontSize: 12 }}>{rrText(t._rr)}</span> },
                { title: <Tooltip title="The option bought: premium points, R (points over its SL) and its risk : reward">Option bought</Tooltip>, key: 'b', width: 190, sorter: (a, b) => (a._br ?? -1e9) - (b._br ?? -1e9), render: (_, t) => (t.option_bought ? <span style={{ fontSize: 12 }}>{t.option_bought} <span style={{ color: col(num(t.bought_points)) }}>{pts(num(t.bought_points))}</span><br /><b style={{ color: col(t._br) }}>{fmtR(t._br)}</b> · {rrText(t._brr)}{t.bought_closed_by ? ` · ${t.bought_closed_by}` : ''}</span> : '-') },
                { title: <Tooltip title="The option sold: premium points, R (points over its SL) and its risk : reward">Option sold</Tooltip>, key: 'so', width: 190, sorter: (a, b) => (a._sr ?? -1e9) - (b._sr ?? -1e9), render: (_, t) => (t.option_sold ? <span style={{ fontSize: 12 }}>{t.option_sold} <span style={{ color: col(num(t.sold_points)) }}>{pts(num(t.sold_points))}</span><br /><b style={{ color: col(t._sr) }}>{fmtR(t._sr)}</b> · {rrText(t._srr)}{t.sold_closed_by ? ` · ${t.sold_closed_by}` : ''}</span> : '-') },
              ]} />
          )}
        </Space>
      )}
    </Drawer>
  )
}

// ---- The days the tuning looked at: used (train / test) or left out, and why ---------------------------------------
const roleText = (d) => (d.status !== 'used' ? 'left out' : d.testRuns && d.trainRuns ? `test in ${d.testRuns}, train in ${d.trainRuns} run(s)` : d.testRuns ? 'test (held back)' : 'train (chosen on)')

function TuningDays({ open, data, onClose, narrow, coverage, range = null }) {
  const [body, setBody] = useState(null)
  const [error, setError] = useState(null)
  const [index, setIndex] = useState('all')
  const [show, setShow] = useState('left out')
  useEffect(() => {
    if (!open) return
    fetch(`/api/strategy-tuning/performance/days?${new URLSearchParams({ data, ...rangeParams(range) })}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b) => { setBody({ ...b, data, range: rangeKey(range) }); setError(null) }).catch((e) => setError(e.message))
  }, [open, data, range]) // eslint-disable-line react-hooks/exhaustive-deps
  const current = body?.data === data && body?.range === rangeKey(range) ? body : null
  const cov = current?.coverage ?? coverage ?? []
  const shown = (current?.days ?? []).filter((d) => (index === 'all' || d.index === index)
    && (show === 'all' || (show === 'left out' ? d.status === 'left out' : show === 'test' ? d.status === 'used' && d.testRuns > 0 : d.status === 'used')))
  return (
    <Drawer open={open} onClose={onClose} width={narrow ? '100%' : 900} title="Days the tuning looked at" destroyOnHidden>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          Each job replays every trading day in its range. A day is <b>used</b> when its data could be read, else <b>left out</b> (with why - a holiday, no data for it, a part day, or the data service busy; a rerun picks up the busy ones).
          Of the used days, each run chose its setting on the older 70% (<i>train</i>) and checked it on the newest 30% it never saw (<i>test</i>, held back) - so a held-back day is still scanned, it is just not used to choose.
          A strategy&apos;s <i>days traded</i> are the days it fired at least once - most strategies do not fire every day.
        </Text>
        {cov.map((c) => (
          <div key={c.index} style={{ fontSize: 12 }}>
            <b>{c.index}</b>: {c.atLeast ? 'at least ' : ''}{c.scanned} day(s) scanned{c.firstDay ? ` (${c.firstDay} to ${c.lastDay})` : ''} · {c.leftOut} left out · {c.testDays} held back as test in some run · {c.runs} run(s)
            {c.olderRuns > 0 && <Text type="secondary" style={{ fontSize: 11 }}> - {c.olderRuns} older run(s) were made before the day list was kept: their days are counted but not listed (run them again to list them)</Text>}
          </div>
        ))}
        <Space wrap size={8}>
          <Segmented value={show} onChange={setShow} options={[{ value: 'left out', label: 'Left out' }, { value: 'test', label: 'Held back (test)' }, { value: 'used', label: 'Used' }, { value: 'all', label: 'All' }]} />
          <Select value={index} onChange={setIndex} style={{ width: 130 }} options={[{ value: 'all', label: 'All indices' }, ...cov.map((c) => ({ value: c.index, label: c.index }))]} aria-label="Index of the days" />
          <Button size="small" disabled={!shown.length} onClick={() => downloadCsv('tuning-days.csv', [
            { title: 'index', value: (d) => d.index }, { title: 'date', value: (d) => d.date }, { title: 'status', value: (d) => d.status },
            { title: 'train_runs', value: (d) => d.trainRuns }, { title: 'test_runs', value: (d) => d.testRuns }, { title: 'runs', value: (d) => d.runs },
            { title: 'estimated', value: (d) => (d.estimated ? 'yes' : '') }, { title: 'reason', value: (d) => d.reason ?? '' }], shown)}>Download CSV</Button>
        </Space>
        {error && <Alert type="error" showIcon message={error} />}
        {current && !shown.length && <Text type="secondary">{show === 'left out' ? 'No day was left out in the runs that kept a day list.' : 'No day to show.'}</Text>}
        {narrow ? (
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {!current && !error && <Text type="secondary">loading…</Text>}
            {shown.map((d) => (
              <div key={`${d.index}-${d.date}`} style={{ borderTop: '1px solid #ffffff14', paddingTop: 6, fontSize: 12 }}>
                <div><b>{d.date}</b> · {d.index} · {d.status === 'used' ? <Tag color={d.testRuns ? 'purple' : 'green'}>{roleText(d)}</Tag> : <Tag color="red">left out</Tag>}{d.estimated && <Tag>estimated</Tag>}</div>
                {d.reason && <Text type="secondary" style={{ fontSize: 11 }}>{d.reason}</Text>}
              </div>
            ))}
          </Space>
        ) : (
          <Table size="small" loading={!current && !error} rowKey={(d) => `${d.index}-${d.date}`} dataSource={shown} pagination={{ pageSize: 100, size: 'small', hideOnSinglePage: true }}
            columns={[
              { title: 'Date', dataIndex: 'date', width: 110 },
              { title: 'Index', dataIndex: 'index', width: 110 },
              { title: 'Day', key: 's', width: 220, render: (_, d) => (d.status === 'used' ? <Tag color={d.testRuns ? 'purple' : 'green'}>{roleText(d)}</Tag> : <Tag color="red">left out</Tag>) },
              { title: 'Runs', dataIndex: 'runs', width: 70 },
              { title: 'Why left out / note', key: 'r', render: (_, d) => <span style={{ fontSize: 12 }}>{d.reason ?? (d.estimated ? 'used - order flow estimated from 1-minute candles' : '')}</span> },
            ]} />
        )}
      </Space>
    </Drawer>
  )
}

// ---- Strategy performance: every tuning run added up per strategy, all indices -----------------------------------
const pctOf = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`)
// The market at a signal, as the scanner record keeps it (ScannerLogStore.SignalColumns).
const MARKET_CSV = ['mkt_tape30', 'mkt_tape60', 'mkt_tape300', 'mkt_big_net', 'mkt_big_count', 'mkt_cvd15', 'mkt_vol_x', 'mkt_fut_px15', 'mkt_fut_oi15', 'mkt_fut_oi5', 'mkt_writers15', 'mkt_writers_open', 'mkt_pcr', 'mkt_book_imb', 'mkt_vwap_dist']
const rrText = (v) => (v == null || !Number.isFinite(v) ? '-' : `1 : ${v.toFixed(2)}`)
const LEGS = [['futures', 'Index'], ['bought', 'Option bought'], ['sold', 'Option sold']]
/** One instrument's numbers: total R (avg per trade), net points over the points risked, risk : reward. */
const legCell = (l) => (!l?.trades ? <Text type="secondary">-</Text> : (
  <span style={{ fontSize: 12 }}>
    <b style={{ color: col(l.totalR) }}>{fmtR(l.totalR)}</b> ({fmtR(l.avgR)}/trade) · win {pctOf(l.winRate)}
    <br /><Text type="secondary" style={{ fontSize: 11 }}><span style={{ color: col(l.points) }}>{pts(l.points)}</span> pts on {f1(l.risked)} risked · {rrText(l.avgRiskReward)}</Text>
  </span>
))
/** A tuned setting across months (TuningPerformance cross-check): months won on unseen days, as written on the same
 *  days, and how many other runs checked it. */
const crossText = (t) => {
  const u = t.unit === 'pts' ? ' pts' : 'R'
  const parts = [t.periods ? `won ${t.periodsWon} of ${t.periods} month(s)` : 'no unseen month yet']
  if (t.baseAvg != null) parts.push(`as written ${pts(t.baseAvg)}${u}`)
  parts.push(t.checkedRuns ? `checked by ${t.checkedRuns} other run(s)` : 'not checked by another run yet')
  return parts.join(' · ')
}

/** Why a tuned setting is not best yet (TuningPerformance.WhyNotBest) - each rule it misses, and what to do. */
const notBestText = (t) => (t.best || !t.notBestBecause?.length ? null : (
  <div style={{ marginTop: 4 }}><b>Not proven yet:</b><ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>{t.notBestBecause.map((w) => <li key={w}>{w}</li>)}</ul></div>
))

/** Points are only comparable within one index (BANKNIFTY moves ~2.5x NIFTY): shown per index; R compares across. */
function StrategyPerformance({ reloadKey }) {
  const auth = useAuth()
  const isAdmin = auth?.user?.role === 'Admin'
  const [data, setData] = useState('futures')
  const [setting, setSetting] = useState('fine-tuned')
  const [index, setIndex] = useState('all')
  const [minTrades, setMinTrades] = useState(5)
  // Optional dates: only the tuning trades (and cross-checked days) on those days - empty = every day.
  const [range, setRange] = useState(null)
  const [view, setView] = useState('ranking')
  // Which way the trades are taken - R, points, win % and risk : reward are those of that instrument.
  const [measure, setMeasure] = useState('futures')
  const legOf = (x) => (x ? x[measure] ?? null : null)
  const narrow = useNarrow()
  const [openRows, setOpenRows] = useState({}) // phone: which strategy cards show their tuned settings
  const [tradesOf, setTradesOf] = useState(null) // the strategy whose every trade is open in the drawer
  const [daysOpen, setDaysOpen] = useState(false)
  // The scanner's filters now - to mark which tuned setting is live on each index (and so whether a better one has
  // been found since): the setting applied for that index, else the all-index filters (filtersForIndex).
  const [liveCfg, setLiveCfg] = useState(null)
  const loadLive = () => fetch('/api/scanner-runner/config').then((r) => (r.ok ? r.json() : null)).then((c) => setLiveCfg(c ?? {})).catch(() => {})
  const liveOf = (id, u) => (liveCfg == null ? null : filtersForIndex({ filters: liveCfg.settings?.filters, filtersByIndex: liveCfg.filtersByIndex }, u)[id] ?? {})
  const appliedFor = (id) => Object.keys(liveCfg?.filtersByIndex ?? {}).filter((u) => liveCfg.filtersByIndex[u]?.[id]).sort()
  const [bestSel, setBestSel] = useState(null) // Apply best: the strategies picked ({ index, ids }); null = the proven ones
  const [bestLive, setBestLive] = useState(false) // ... and put them on the index's live list
  const [bestLots, setBestLots] = useState(null) // ... with this lot size each (empty = each keeps its own, else the index's)
  useEffect(() => { loadLive() }, [])
  const [bestFor, setBestFor] = useState('NIFTY')
  // Every index's Paper / Live today (ServerLiveService) - switchable here too, always with its confirm.
  const serverLive = useServerLive()
  const liveToday = (u) => !!serverLive.list?.find((x) => x.underlying === u)?.live
  /** After an apply that asked for it: the index to Live today - with the same confirm as everywhere else. */
  const goLiveToday = (u) => {
    if (liveToday(u)) { message.warning(`${u} is already LIVE today`); return }
    const st = serverLive.list?.find((x) => x.underlying === u)
    confirmServerLive(u, st, () => serverLive.set(u, { live: true }).then((ok) => { if (ok) { message.warning(`${u}: the server scanner trades LIVE today`); loadLive() } }))
  }
  const [applying, setApplying] = useState(false)
  const [body, setBody] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    // Kept with the data mode it is for, so a switch shows loading rather than the other mode's numbers.
    fetch(`/api/strategy-tuning/performance?${new URLSearchParams({ data, ...rangeParams(range) })}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b) => { setBody({ ...b, data, range: rangeKey(range) }); setError(null) }).catch((e) => setError(e.message))
  }, [data, reloadKey, range]) // eslint-disable-line react-hooks/exhaustive-deps
  const current = body?.data === data && body?.range === rangeKey(range) ? body : null
  // Who runs it: the spot + options strategies run on the server scanner only (each finished minute, on the spot candles);
  // the futures ones on the Order Flow page's scanner too.
  const scannerWho = data === 'spot' ? 'the server scanner' : 'this browser and the server scanner'
  const statsOf = (r) => (index === 'all' ? r.all : r.byIndex?.[index])
  const rows = useMemo(() => (current?.rows ?? [])
    .filter((r) => (setting === 'both' || r.setting === setting))
    .map((r) => ({ ...r, s: statsOf(r), key: `${r.strategyId}-${r.setting}` }))
    .map((r) => ({ ...r, l: legOf(r.s) }))
    .filter((r) => r.l && r.l.trades >= minTrades)
    .sort((a, b) => (b.l.avgR ?? -1e9) - (a.l.avgR ?? -1e9) || b.l.points - a.l.points), [current, setting, index, minTrades, measure]) // eslint-disable-line react-hooks/exhaustive-deps
  const indices = useMemo(() => [...new Set((current?.rows ?? []).flatMap((r) => Object.keys(r.byIndex ?? {})))].sort(), [current])
  // The days scanned per index (every run added up) - what a strategy's "days traded" is out of.
  const coverage = current?.coverage ?? []
  const scannedOf = (u) => (u === 'all' ? coverage.reduce((a, c) => a + c.scanned, 0) : coverage.find((c) => c.index === u)?.scanned) || null
  const daysTraded = (x, u) => {
    const n = scannedOf(u)
    return <Tooltip title={`The days this strategy fired at least once${n ? `, out of the ${n} day(s) the tuning scanned${u === 'all' ? ' (all indices added up)' : ` for ${u}`}` : ''}. First trade ${x.firstDay ?? '-'}, last ${x.lastDay ?? '-'} - not the scan range.`}>
      <span>{x.dayCount}{n ? ` of ${n}` : ''} days</span>
    </Tooltip>
  }
  // Applied for the index it was tuned on (that index only - another index's setting for the same strategy stays).
  const apply = async (r, tuned, addToLive = false, lots = null, goLive = false) => {
    try {
      const params = paramsFromSettingsRow(tuned)
      await applyTunedFilters(r.strategyId, params, { option: tuned.unit === 'pts', index: tuned.index, tuned: settingSignature(tuned), lots })
      if (addToLive) await putOnLiveList(tuned.index, r.strategyId)
      if (goLive) goLiveToday(tuned.index)
      message.success({ content: `#${r.strategyNo} ${r.strategy}: ${tuned.index}'s tuned setting is in force now on ${tuned.index}, ${lots ? `${lots} lot(s)` : `the index's lots`}, for the live scanner (${scannerWho})${tuned.setting_text ? ` - ${tuned.setting_text}` : ''}${addToLive ? `; on ${tuned.index}'s live list - it trades live when ${tuned.index} is Live today` : ''}`, duration: 10 })
    } catch (err) {
      message.error(err.message)
    } finally {
      loadLive()
    }
  }
  const removeApplied = async (r, u) => {
    try {
      await saveIndexFilters(u, r.strategyId, null)
      message.success(`#${r.strategyNo} ${r.strategy}: back to its all-index filters on ${u}`)
    } catch (err) {
      message.error(err.message)
    } finally {
      loadLive()
    }
  }
  const one = index !== 'all'
  // The best strategy of each index, fine-tuned and as written (at least `minTrades` trades, best average R).
  const bestOf = (u, which) => (current?.rows ?? []).filter((r) => r.setting === which && (legOf(r.byIndex?.[u])?.trades ?? 0) >= minTrades)
    .sort((a, b) => (legOf(b.byIndex[u]).avgR ?? -1e9) - (legOf(a.byIndex[u]).avgR ?? -1e9))[0]
  // The grid: one row per strategy (the setting picked), one column per index, the best cell of each index marked.
  const gridRows = useMemo(() => {
    const which = setting === 'both' ? 'fine-tuned' : setting
    return (current?.rows ?? []).filter((r) => r.setting === which).map((r) => ({ ...r, key: r.strategyId }))
  }, [current, setting])
  const bestInColumn = Object.fromEntries(indices.map((u) => [u, gridRows.filter((r) => (legOf(r.byIndex?.[u])?.trades ?? 0) >= minTrades).sort((a, b) => (legOf(b.byIndex[u]).avgR ?? -1e9) - (legOf(a.byIndex[u]).avgR ?? -1e9))[0]?.strategyId]))
  // Always shown - greyed out, with the reason, when it cannot be used (never just missing).
  const applyBlock = !isAdmin ? `Only an Admin can apply - you are signed in as ${auth?.user?.email ?? '?'} (${auth?.user?.role ?? 'no role'})` : null
  const applyButton = (r, t, label = 'Apply to live scanner') => (applyBlock ? (
    <Tooltip title={applyBlock}><Button size="small" disabled>{label}</Button></Tooltip>
  ) : (
    <ApplyTunedButton index={t.row.index} primary={t.best} label={label} onApply={(live, lots, goLive) => apply(r, t.row, live, lots, goLive)} canGoLive isLiveToday={liveToday(t.row.index)}
      lots={liveCfg?.filtersByIndex?.[t.row.index]?.[r.strategyId]?._lots ?? null} indexLots={liveCfg?.trade?.[t.row.index]?.lots ?? null}
      title={`Apply this ${t.row.index} setting to #${r.strategyNo} ${r.strategy}?`}
      description={`${t.recommended ? '' : 'No run recommended it - applied anyway, your call. '}The live scanner (${scannerWho}) runs this strategy with it on ${t.row.index} from now - paper, and live when ${t.row.index} is Live today and the strategy is on its live list. What was applied to it on ${t.row.index} before is replaced; other indices keep theirs.`} />
  ))
  // A fine-tuned strategy's best setting per index, right in its row: the one marked best (else the top-scored, said so),
  // whether it is live now, and Apply.
  const quickApply = (r) => {
    if (r.setting !== 'fine-tuned') return <Text type="secondary" style={{ fontSize: 12 }}>-</Text>
    const entries = Object.entries(r.tunedSettings ?? {}).filter(([u, list]) => list?.length && (index === 'all' || u === index))
    if (!entries.length) return <Text type="secondary" style={{ fontSize: 12 }}>no tuned setting yet</Text>
    return (
      <Space direction="vertical" size={2}>
        {entries.map(([u, list]) => {
          const t = list.find((x) => x.best) ?? list[0]
          const live = isLive(liveOf(r.strategyId, u), t.row)
          return (
            <span key={u} style={{ fontSize: 12 }}>
              <b>{u}</b>{' '}
              <Tooltip title={<>{t.row.setting_text || '-'} · unseen {t.testTrades} trades {t.testAvg == null ? '' : `${pts(t.testAvg)}${t.unit === 'pts' ? ' pts' : 'R'}/trade`} · {crossText(t)}{notBestText(t)}</>}>
                {t.best ? <Tag color="gold">best</Tag> : <Tag>top - not proven yet</Tag>}
              </Tooltip>
              {live ? <Tag color="green">live now</Tag> : applyButton(r, t)}
              <ParamsPopover source={t.row} from="row" label="params" action={applyButton(r, t, live ? 'Apply again' : 'Apply these parameters')} />
            </span>
          )
        })}
      </Space>
    )
  }
  // The strategies' best fine-tuned settings for one index, applied in one go - the ones PICKED: every strategy with a
  // tuned setting for the index is listed with its best (else its top-scored one, "not proven yet"); by default only the
  // proven ones are picked, never all - add or take off any.
  const bestCandidates = (u) => (current?.rows ?? []).filter((r) => r.setting === 'fine-tuned' && r.tunedSettings?.[u]?.length)
    .map((r) => ({ r, t: r.tunedSettings[u].find((x) => x.best) ?? r.tunedSettings[u][0] }))
    .sort((a, b) => (b.t.best - a.t.best) || ((b.t.score ?? -1e9) - (a.t.score ?? -1e9)))
  const pickedIds = (u) => bestSel?.index === u ? bestSel.ids : bestCandidates(u).filter((x) => x.t.best).map((x) => x.r.strategyId)
  const bestPicks = (u) => bestCandidates(u).filter((x) => pickedIds(u).includes(x.r.strategyId))
  const applyAllBest = async () => {
    setApplying(true)
    let done = 0
    try {
      for (const { r, t } of bestPicks(bestFor)) {
        await applyTunedFilters(r.strategyId, paramsFromSettingsRow(t.row), { option: t.unit === 'pts', index: bestFor, tuned: settingSignature(t.row), ...(bestLots ? { lots: bestLots } : {}) })
        if (bestLive) await putOnLiveList(bestFor, r.strategyId)
        done++
      }
      message.success({ content: `${done} strateg${done === 1 ? 'y' : 'ies'} now run with ${bestFor}'s best fine-tuned setting on ${bestFor} (live scanner)${bestLive ? `, and are on ${bestFor}'s live list` : ''}`, duration: 8 })
    } catch (err) {
      message.error(`${done} applied, then: ${err.message}`)
    } finally {
      setApplying(false)
      loadLive()
    }
  }
  const tunedTable = (r) => {
    const entries = Object.entries(r.tunedSettings ?? {})
    if (!entries.length) return <Text type="secondary" style={{ fontSize: 12 }}>No fine-tuned setting for this strategy in the runs kept.</Text>
    const applied = appliedFor(r.strategyId)
    const appliedLine = applied.length > 0 && (
      <Space wrap size={6} style={{ fontSize: 12, marginBottom: 6 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>Applied per index:</Text>
        {applied.map((u) => (
          <Tag key={u} color="green" closable={isAdmin} onClose={(e) => { e.preventDefault(); removeApplied(r, u) }}>
            <Tooltip title={isAdmin ? `Runs with its ${u} setting on ${u}. ✕ = back to its all-index filters there` : `Runs with its ${u} setting on ${u}`}>{u}</Tooltip>
          </Tag>
        ))}
      </Space>
    )
    if (narrow) return (
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {appliedLine}
        {entries.flatMap(([, list]) => list).map((t) => (
          <div key={`${t.row.index}-${t.row.run_id}-${t.row.setting_text}`} style={{ borderTop: '1px solid #ffffff14', paddingTop: 6, fontSize: 12 }}>
            <div><b>{t.row.index}</b>{t.best && <Tag color="gold" style={{ marginLeft: 6 }}>best</Tag>}{isLive(liveOf(r.strategyId, t.row.index), t.row) && <Tag color="green" style={{ marginLeft: 4 }}>live now</Tag>} {t.row.setting_text || '-'} <ParamsPopover source={t.row} from="row" action={applyButton(r, t, 'Apply these parameters')} /></div>
            <Text type="secondary" style={{ fontSize: 12 }}>{t.runs} run(s) · {t.recommended} recommended · unseen {t.testTrades} trades <b style={{ color: col(t.testAvg) }}>{t.testAvg == null ? '-' : `${pts(t.testAvg)}${t.unit === 'pts' ? ' pts' : 'R'}`}</b>/trade · {crossText(t)}</Text>
            {!t.best && t.notBestBecause?.length > 0 && <Text type="warning" style={{ fontSize: 11, display: 'block' }}>not best: {t.notBestBecause.join('; ')}</Text>}
            <div style={{ marginTop: 4 }}>{applyButton(r, t)}</div>
          </div>
        ))}
      </Space>
    )
    return (
      <>
      {appliedLine}
      <Table size="small" pagination={false} rowKey={(t) => `${t.row.index}-${t.row.run_id}-${t.row.setting_text}`}
        dataSource={entries.flatMap(([, list]) => list)}
        columns={[
          { title: 'Index', key: 'i', width: 130, render: (_, t) => <span style={{ fontSize: 12 }}>{t.row.index}{t.best && <Tag color="gold" style={{ marginLeft: 4 }}>best</Tag>}{isLive(liveOf(r.strategyId, t.row.index), t.row) && <Tag color="green" style={{ marginLeft: 4 }}>live now</Tag>}</span> },
          { title: 'Fine-tuned setting', key: 's', render: (_, t) => <span style={{ fontSize: 12 }}>{t.row.setting_text || '-'} <ParamsPopover source={t.row} from="row" action={applyButton(r, t, 'Apply these parameters')} /></span> },
          { title: <Tooltip title="How many tuning runs chose this setting, and how many of them recommended it (it also won on the days that run held back)">Chosen / recommended</Tooltip>, key: 'r', width: 150, render: (_, t) => <span style={{ fontSize: 12 }}>{t.runs} run(s) · {t.recommended} recommended</span> },
          { title: <Tooltip title="Days this setting was never chosen on - its own run's held-back days AND every day of every other run for this index (each run re-checks every setting found so far). The honest number: a setting tuned on one month is judged on the other months too.">Unseen days</Tooltip>, key: 'te', width: 170, render: (_, t) => <span style={{ fontSize: 12 }}>{t.testTrades} trades · <b style={{ color: col(t.testAvg) }}>{t.testAvg == null ? '-' : `${pts(t.testAvg)}${t.unit === 'pts' ? ' pts' : 'R'}`}</b>/trade</span> },
          { title: <Tooltip title="On its unseen days: in how many months it traded it made money, the strategy as written on the same days, and how many runs other than the ones that chose it checked it. Best needs: above 0 on unseen days, better than as written there, and - over 2+ months - winning in at least half of them.">Across months</Tooltip>, key: 'pm', width: 230, render: (_, t) => <span style={{ fontSize: 12 }}>{crossText(t)}{!t.best && t.notBestBecause?.length > 0 && <Text type="warning" style={{ fontSize: 11, display: 'block' }}>not best: {t.notBestBecause.join('; ')}</Text>}</span> },
          { title: 'Chosen on', key: 'tr', width: 150, render: (_, t) => <Text type="secondary" style={{ fontSize: 12 }}>{t.trainTrades} trades · {t.trainAvg == null ? '-' : `${pts(t.trainAvg)}${t.unit === 'pts' ? ' pts' : 'R'}`}</Text> },
          { title: <Tooltip title="Unseen-days average shrunk for few trades (avg x n / (n + 10)) - a setting proven over many unseen trades ranks above a lucky one">Score</Tooltip>, key: 'sc', width: 80, render: (_, t) => <span style={{ color: col(t.score) }}>{t.score == null ? '-' : `${pts(t.score)}${t.unit === 'pts' ? '' : 'R'}`}</span> },
          { title: '', key: 'a', width: 170, render: (_, t) => applyButton(r, t) },
        ]} />
      </>
    )
  }
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Row gutter={[12, 8]} align="middle">
        <Col><Segmented value={data} onChange={setData} options={[{ value: 'futures', label: 'Futures + OI' }, { value: 'spot', label: 'Spot + options' }]} /></Col>
        <Col><Segmented value={setting} onChange={setSetting} options={[{ value: 'fine-tuned', label: 'Fine-tuned' }, { value: 'as written', label: 'As written' }, { value: 'both', label: 'Both' }]} /></Col>
        <Col><Tooltip title="How the trades are taken: R = the points made over the points risked (that instrument's own SL), risk : reward = 1 : target / SL"><Segmented value={measure} onChange={setMeasure} options={[{ value: 'futures', label: data === 'spot' ? 'Spot' : 'Futures' }, { value: 'bought', label: 'Option bought' }, { value: 'sold', label: 'Option sold' }]} aria-label="Measure by" /></Tooltip></Col>
        <Col><Select value={index} onChange={setIndex} style={{ width: 140 }} options={[{ value: 'all', label: 'All indices' }, ...indices.map((u) => ({ value: u, label: u }))]} /></Col>
        <Col><Space size={6}><Tooltip title="A strategy needs at least this many trades to be ranked or called best - fewer is luck"><Text>Min trades</Text></Tooltip><InputNumber min={1} max={1000} value={minTrades} onChange={(v) => v && setMinTrades(v)} style={{ width: 80 }} /></Space></Col>
        <Col>
          <Tooltip title="Optional: only the tuning trades on these days (and the tuned settings' cross-checked days in them) - e.g. how a strategy did in one month. Either end can be left open; empty = every day.">
            <DatePicker.RangePicker value={range} onChange={setRange} format="DD MMM YYYY" allowEmpty={[true, true]} placeholder={['From (any)', 'To (any)']} aria-label="Performance dates" />
          </Tooltip>
        </Col>
        <Col><Segmented value={view} onChange={setView} options={[{ value: 'ranking', label: 'Ranking' }, { value: 'grid', label: <Tooltip title="Every strategy against every index - which strategy works on which index">By index</Tooltip> }]} /></Col>
        {current && <Col><Text type="secondary" style={{ fontSize: 12 }}>{current.runs} tuning run(s), {current.trades.toLocaleString('en-IN')} trades{current.from || current.to ? ` from ${current.from ?? 'the start'} to ${current.to ?? 'the latest'}` : ''} - a trade two runs both scanned is counted once</Text></Col>}
      </Row>
      {coverage.length > 0 && (
        <Space wrap size={[12, 4]} style={{ fontSize: 12 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>Days scanned:</Text>
          {coverage.map((c) => <span key={c.index}><b>{c.index}</b> {c.atLeast ? '≥' : ''}{c.scanned}{c.firstDay ? ` (${c.firstDay} to ${c.lastDay})` : ''}{c.leftOut ? `, ${c.leftOut} left out` : ''}</span>)}
          <Button size="small" onClick={() => setDaysOpen(true)}>Which days - left out / held back</Button>
        </Space>
      )}
      <TuningDays open={daysOpen} data={data} range={range} narrow={narrow} coverage={coverage} onClose={() => setDaysOpen(false)} />
      {indices.length > 0 && (
        <Row gutter={[12, 12]}>
          {indices.map((u) => {
            const tuned = bestOf(u, 'fine-tuned')
            const written = bestOf(u, 'as written')
            const bestSetting = tuned?.tunedSettings?.[u]?.find((t) => t.best)
            return (
              <Col key={u} xs={24} md={8}>
                <Card size="small" title={`Best on ${u}`} styles={{ body: { padding: 10 } }}>
                  <Space direction="vertical" size={4} style={{ width: '100%', fontSize: 12 }}>
                    <span>Fine-tuned: {tuned ? <><b>#{tuned.strategyNo} {tuned.strategy}</b> · <b style={{ color: col(legOf(tuned.byIndex[u]).avgR) }}>{fmtR(legOf(tuned.byIndex[u]).avgR)}</b>/trade over {legOf(tuned.byIndex[u]).trades} · total {fmtR(legOf(tuned.byIndex[u]).totalR)} · win {pctOf(legOf(tuned.byIndex[u]).winRate)}</> : <Text type="secondary">not enough trades yet</Text>}</span>
                    {bestSetting && <Text type="secondary" style={{ fontSize: 11 }}>its best setting: {bestSetting.row.setting_text} ({bestSetting.runs} run(s), {bestSetting.testTrades} unseen trades {fmtR(bestSetting.testAvg)})</Text>}
                    <span>As written: {written ? <><b>#{written.strategyNo} {written.strategy}</b> · <b style={{ color: col(legOf(written.byIndex[u]).avgR) }}>{fmtR(legOf(written.byIndex[u]).avgR)}</b>/trade over {legOf(written.byIndex[u]).trades} · total {fmtR(legOf(written.byIndex[u]).totalR)}</> : <Text type="secondary">not enough trades yet</Text>}</span>
                  </Space>
                </Card>
              </Col>
            )
          })}
        </Row>
      )}
      {isAdmin && <LiveSetup cfg={liveCfg} serverLive={serverLive} isAdmin={isAdmin} onChanged={loadLive} />}
      {isAdmin && <AppliedSettings cfg={liveCfg} isAdmin={isAdmin} onChanged={loadLive} />}
      {isAdmin && indices.length > 0 && (
        (() => {
          const u = indices.includes(bestFor) ? bestFor : indices[0]
          const candidates = bestCandidates(u)
          const picks = bestPicks(u)
          const unproven = picks.filter((x) => !x.t.best).length
          const proven = candidates.filter((x) => x.t.best).length
          return (
            <Space direction="vertical" size={4} style={{ width: '100%' }}>
              <Space wrap size={8}>
                <Tooltip title="The best fine-tuned setting of each strategy picked (the strongest on the days it was never chosen on, across every run and month - see 'How the fine-tuning works') goes on the live scanner for this index. By default only the proven ones are picked; add a 'not proven yet' one to apply its top-scored setting anyway. Any single setting can still be applied on its own below.">
                  <Text>Apply the best fine-tuned settings on</Text>
                </Tooltip>
                <Select value={u} onChange={(v) => { setBestFor(v); setBestSel(null) }} style={{ width: 130 }} options={indices.map((x) => ({ value: x, label: x }))} aria-label="Best settings of index" />
                <Text>for</Text>
                <Select mode="multiple" allowClear value={pickedIds(u)} onChange={(ids) => setBestSel({ index: u, ids })} style={{ minWidth: 280, maxWidth: 640 }} maxTagCount="responsive"
                  placeholder={candidates.length ? 'pick strategies' : 'no tuned setting for this index yet'} aria-label="Strategies to apply"
                  options={candidates.map(({ r, t }) => ({ value: r.strategyId, label: `#${r.strategyNo} ${r.strategy} · ${t.best ? 'best' : 'not proven yet'}` }))} />
                <Space size={4}><Text>lots</Text><Tooltip title={`Each strategy picked takes this many lots on ${u}. Empty: each keeps its own lot size, else the index's (Trade settings: ${liveCfg?.trade?.[u]?.lots ?? '-'}).`}><InputNumber size="small" min={1} max={500} precision={0} value={bestLots} onChange={(v) => setBestLots(v ?? null)} style={{ width: 80 }} placeholder={`${liveCfg?.trade?.[u]?.lots ?? ''} (index)`} aria-label="Lots for the picked strategies" /></Tooltip></Space>
                <Checkbox checked={bestLive} onChange={(e) => setBestLive(e.target.checked)}>and put them on the live list</Checkbox>
                <Popconfirm title={`Apply ${picks.length} setting(s) on ${u}?`} okText="Apply" onConfirm={applyAllBest} disabled={!picks.length}
                  description={<div style={{ maxWidth: 380 }}>Each strategy picked runs with its best fine-tuned setting on {u} ({scannerWho}) from now - paper, and live when {u} is Live today and the strategy is on its live list; what was applied to them on {u} before is replaced, other indices keep theirs.{unproven ? ` ${unproven} of them are not proven yet - their top-scored setting is applied.` : ''}{bestLive ? ` All ${picks.length} go on ${u}'s live list.` : ''}</div>}>
                  <Button type="primary" loading={applying} disabled={!picks.length}>Apply to {picks.length} strateg{picks.length === 1 ? 'y' : 'ies'}</Button>
                </Popconfirm>
              </Space>
              {candidates.length > 0 && !proven && (
                <Text type="warning" style={{ fontSize: 12 }}>
                  None of {u}&apos;s tuned settings is proven yet, so nothing is picked - pick the strategies to apply their top-scored setting anyway, or run a Re-check (Strategy tuning → Tune: Re-check settings) over the months you have tuned so they are measured on their unseen days.
                </Text>
              )}
            </Space>
          )
        })()
      )}
      <StrategyTrades key={tradesOf ? `${tradesOf.strategyId}-${tradesOf.index}-${tradesOf.setting}` : 'none'} target={tradesOf} data={data} range={range} narrow={narrow} onClose={() => setTradesOf(null)} />
      <details>
        <summary style={{ cursor: 'pointer', fontSize: 12 }}>How the fine-tuning works, and how to read this page</summary>
        <div style={{ fontSize: 12, marginTop: 6, lineHeight: 1.6 }}>
          <div><b>1. Scan.</b> A tuning job replays each past day in its date range through the scanner&apos;s own strategies (the same code as live) and records every signal and how it ended - stop, target, trailing stop, time stop or 15:10.</div>
          <div><b>2. Tune.</b> For each strategy it then tries the ways the trade can be taken - long / short only, the entry time window, stop and target size, time stop, trailing stop, the OI confirmation (and the option&apos;s buy / sell, strike and SL / target when asked) - on those same signals. The strategy&apos;s entry rules are never changed.</div>
          <div><b>3. No fitting the past.</b> A setting is chosen on the older 70% of the job&apos;s days and then checked on the newest 30% it never saw. It is <i>recommended</i> only when it also wins there and beats the strategy as written.</div>
          <div><b>4. Many jobs, one answer.</b> Schedule a long range as short pieces (Strategy tuning → Schedule → Split into) for every index. This page adds every run together: a trade two runs both scanned counts once; <i>As written</i> is each strategy untouched, <i>Fine-tuned</i> is with the setting each run chose. R compares across indices; points only within one index.</div>
          <div><b>5. The best setting.</b> Open a strategy: every setting the runs chose for it, per index. Tune September and then October and you get two different settings - so every run also re-checks EVERY setting found so far for its index on its own days that setting was not chosen on: September&apos;s setting is measured on all of October, October&apos;s on its own held-back days (and on September too after a <i>Re-check</i> job over September). Each setting is scored on all its unseen days together (fewer unseen trades count for less), and the one marked <Tag color="gold">best</Tag> is the strongest that made money there, beat the strategy as written on the same days and - once checked over two or more months - won in at least half of them. A setting that only fitted its own month drops out as the next months come in. <Tag color="green">live now</Tag> is the one the scanner uses. Apply any setting (recommended or not), or Apply best to every strategy at once. A setting is applied for the index it was tuned on - that index runs the strategy with it, the other indices keep their own - and can also put the strategy on that index's live list, so it trades live once the index is switched to Live today.</div>
          <div><b>R and risk : reward.</b> Every trade is measured three ways - the index (futures / spot) and the option bought and option sold the setup carries. R = the points it made over the points it risked: the index trade over its SL in index points, an option over its own SL in premium points (Trade settings: its SL, target and trailing stop are applied to it). Its SL is -1R; total R adds every trade up. Risk : reward is as planned, 1 : target / SL. Measure by picks which one ranks the strategies - pick Option bought if that is how you trade.</div>
          <div><b>Days.</b> &quot;Days scanned&quot; are the days a job could read (Which days lists those left out, and why, and the newest 30% each run held back as its test). A strategy&apos;s &quot;16 of 120 days&quot; means it fired on 16 of the 120 days scanned - its first and last trade dates are not the scan range.</div>
          <div><b>6. Improve round by round.</b> Schedule more days → the runs add up → apply what is best now → the next runs check it on new days. A setting only stays best while it keeps winning on days it was not chosen on.</div>
        </div>
      </details>
      {error && <Alert type="error" showIcon message={`Could not load the strategy performance: ${error}`} />}
      {current && !current.runs && <Alert type="info" showIcon message="No tuning run yet - schedule or run one on the Strategy tuning page." />}
      {applyBlock && current?.runs > 0 && <Alert type="warning" showIcon message={`The Apply buttons are greyed out: ${applyBlock}.`} />}
      {narrow ? (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {!current && !error && <Text type="secondary">loading…</Text>}
          {(view === 'grid' ? gridRows : rows).map((r, i) => {
            const x = legOf(view === 'grid' ? r.all : r.s)
            const days = view === 'grid' ? r.all : r.s
            const open = !!openRows[r.key]
            return (
              <Card key={r.key} size="small" styles={{ body: { padding: 10 } }}>
                <Space direction="vertical" size={4} style={{ width: '100%', fontSize: 12 }}>
                  <div>{view === 'ranking' && (i < 3 ? <Tag color="gold">{i + 1}</Tag> : <Tag>{i + 1}</Tag>)}<b>#{r.strategyNo} {r.strategy}</b> {r.setting === 'fine-tuned' ? <Tag color="blue">fine-tuned</Tag> : <Tag>as written</Tag>}</div>
                  <div><b style={{ color: col(x?.avgR) }}>{fmtR(x?.avgR)}</b>/trade · {x?.trades ?? 0} trades · win {pctOf(x?.winRate)} · total <span style={{ color: col(x?.totalR) }}>{fmtR(x?.totalR)}</span>{one && x ? <> · <span style={{ color: col(x.points) }}>{pts(x.points)} pts</span> on {f1(x.risked)} risked</> : null} · {rrText(x?.avgRiskReward)}{days ? <> · traded {daysTraded(days, view === 'grid' ? 'all' : index)}</> : null}</div>
                  <div>{Object.entries(r.byIndex ?? {}).map(([u, z]) => { const y = legOf(z); return y ? (
                    <span key={u} style={{ marginRight: 10, opacity: y.trades < minTrades ? 0.5 : 1 }}>{view === 'grid' && bestInColumn[u] === r.strategyId && <Tag color="gold">best</Tag>}{u} <b style={{ color: col(y.avgR) }}>{fmtR(y.avgR)}</b> ({y.trades})</span>
                  ) : null })}</div>
                  {r.setting === 'fine-tuned' && <div>{quickApply(r)}</div>}
                  <Space size={12}>
                    <Button size="small" type="link" style={{ padding: 0, height: 'auto' }} onClick={() => setOpenRows((m) => ({ ...m, [r.key]: !open }))}>{open ? 'Hide' : 'Show'} tuned settings</Button>
                    <Button size="small" type="link" style={{ padding: 0, height: 'auto' }} onClick={() => setTradesOf({ ...r, index, setting: view === 'grid' ? 'both' : r.setting })}>All trades</Button>
                  </Space>
                  {open && tunedTable(r)}
                </Space>
              </Card>
            )
          })}
        </Space>
      ) : view === 'grid' ? (
        <Table size="small" loading={!current && !error} rowKey="key" dataSource={gridRows} pagination={false} scroll={{ x: 900 }}
          expandable={{ expandedRowRender: (r) => <Space direction="vertical" size={6} style={{ width: '100%' }}><Button size="small" onClick={() => setTradesOf({ ...r, index, setting: 'both' })}>All trades of this strategy</Button>{tunedTable(r)}</Space> }}
          columns={[
            { title: `Strategy (${setting === 'as written' ? 'as written' : 'fine-tuned'})`, key: 's', fixed: 'left', width: 260, render: (_, r) => <span style={{ fontSize: 12 }}>#{r.strategyNo} {r.strategy}</span> },
            ...indices.map((u) => ({
              title: u, key: u, sorter: (a, b) => (legOf(a.byIndex?.[u])?.avgR ?? -1e9) - (legOf(b.byIndex?.[u])?.avgR ?? -1e9),
              render: (_, r) => {
                const x = legOf(r.byIndex?.[u])
                if (!x?.trades) return <Text type="secondary">-</Text>
                const best = bestInColumn[u] === r.strategyId
                const few = x.trades < minTrades
                return <span style={{ fontSize: 12, opacity: few ? 0.5 : 1 }}>{best && <Tag color="gold" style={{ marginRight: 4 }}>best</Tag>}<b style={{ color: col(x.avgR) }}>{fmtR(x.avgR)}</b>/trade · {x.trades} trades · win {pctOf(x.winRate)}<br /><Text type="secondary" style={{ fontSize: 11 }}>total {fmtR(x.totalR)} · {pts(x.points)} pts on {f1(x.risked)} risked · {rrText(x.avgRiskReward)}{few ? ' · too few trades' : ''}</Text></span>
              },
            })),
          ]} />
      ) : (
      <Table size="small" loading={!current && !error} rowKey="key" dataSource={rows} pagination={{ pageSize: 50, size: 'small', hideOnSinglePage: true }} scroll={{ x: 1200 }}
        expandable={{ expandedRowRender: (r) => (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Table size="small" pagination={false} rowKey="index" dataSource={Object.entries(r.byIndex ?? {}).map(([u, x]) => ({ index: u, ...x }))} columns={[
              { title: 'Index', dataIndex: 'index', width: 100 },
              { title: 'Trades', dataIndex: 'trades', width: 65 },
              { title: 'SL hits', dataIndex: 'slHits', width: 65 },
              ...LEGS.map(([k, label]) => ({ title: <Tooltip title={`${k === 'futures' ? 'The index trade, in index points' : `The ${label.toLowerCase()} the setup carries, in premium points - out at its own SL / target (Trade settings) or with the index trade`}: total R (average per trade), net points over the points risked (each trade's SL), and the planned risk : reward`}>{k === 'futures' ? (data === 'spot' ? 'Spot' : 'Futures') : label}</Tooltip>, key: k, width: 210, render: (_, x) => legCell(x[k]) })),
              { title: 'Tuned option', key: 'opt', width: 190, render: (_, x) => legCell(x.option) },
              { title: 'Days traded', key: 'd', width: 210, render: (_, x) => <Text type="secondary" style={{ fontSize: 12 }}>{daysTraded(x, x.index)}<br />first {x.firstDay} · last {x.lastDay}</Text> },
            ]} />
            <Button size="small" style={{ alignSelf: 'flex-start' }} onClick={() => setTradesOf({ ...r, index, setting: r.setting })}>All {r.all.trades} trades of this strategy</Button>
            {tunedTable(r)}
          </Space>
        ) }}
        columns={[
          { title: 'Rank', key: 'rank', width: 55, render: (_, __, i) => (i < 3 ? <Tag color="gold">{i + 1}</Tag> : i + 1) },
          { title: 'Strategy', key: 's', render: (_, r) => <span style={{ fontSize: 12 }}>#{r.strategyNo} {r.strategy} {r.setting === 'fine-tuned' ? <Tag color="blue" style={{ marginLeft: 4 }}>fine-tuned</Tag> : <Tag style={{ marginLeft: 4 }}>as written</Tag>}</span> },
          { title: <Tooltip title="Each index's best setting for this strategy (hover it for the setting and how it did on unseen days) - Apply puts it on the live scanner for that index. Open the row for every setting the runs found.">Best setting · apply</Tooltip>, key: 'best', width: 260, render: (_, r) => quickApply(r) },
          { title: 'Trades', key: 'n', width: 70, sorter: (a, b) => a.l.trades - b.l.trades, render: (_, r) => r.l.trades },
          { title: 'Win %', key: 'w', width: 70, sorter: (a, b) => (a.l.winRate ?? 0) - (b.l.winRate ?? 0), render: (_, r) => pctOf(r.l.winRate) },
          { title: 'Avg R', key: 'ar', width: 80, sorter: (a, b) => (a.l.avgR ?? -1e9) - (b.l.avgR ?? -1e9), render: (_, r) => <b style={{ color: col(r.l.avgR) }}>{fmtR(r.l.avgR)}</b> },
          { title: <Tooltip title="Every trade's R added up: the points it made over the points it risked (its SL)">Total R</Tooltip>, key: 'tr', width: 85, sorter: (a, b) => a.l.totalR - b.l.totalR, render: (_, r) => <span style={{ color: col(r.l.totalR) }}>{fmtR(r.l.totalR)}</span> },
          ...(one ? [{ title: <Tooltip title={measure === 'futures' ? 'Index points' : 'Premium points'}>Net points / risked</Tooltip>, key: 'p', width: 140, sorter: (a, b) => a.l.points - b.l.points, render: (_, r) => <span style={{ fontSize: 12 }}><b style={{ color: col(r.l.points) }}>{pts(r.l.points)}</b> / {f1(r.l.risked)}</span> }] : []),
          { title: <Tooltip title="Planned risk : reward, averaged over the trades: 1 : target / SL">Risk : reward</Tooltip>, key: 'rr', width: 100, render: (_, r) => <span style={{ fontSize: 12 }}>{rrText(r.l.avgRiskReward)}</span> },
          { title: 'R by instrument', key: 'legs', width: 220, render: (_, r) => <span style={{ fontSize: 12 }}>{LEGS.map(([k, label]) => `${k === 'futures' ? (data === 'spot' ? 'Spot' : 'Fut') : label.replace('Option ', '')} ${fmtR(r.s[k]?.totalR)}`).join(' · ')}</span> },
          { title: 'Indices', key: 'i', width: 170, render: (_, r) => <span style={{ fontSize: 12 }}>{Object.entries(r.byIndex ?? {}).map(([u, x]) => `${u} ${fmtR(legOf(x)?.avgR)}`).join(' · ')}</span> },
          { title: <Tooltip title="The days the strategy fired at least once, out of the days scanned; and how many tuning runs it traded in">Days traded · runs</Tooltip>, key: 'd', width: 150, render: (_, r) => <Text type="secondary" style={{ fontSize: 12 }}>{daysTraded(r.s, index)} · {r.s.runCount}</Text> },
        ]} />
      )}
    </Space>
  )
}

// ---- What the live signals teach: which order-flow conditions at the signal win, per strategy and index -------------
function Learning() {
  const auth = useAuth()
  const isAdmin = auth?.user?.role === 'Admin'
  const narrow = useNarrow()
  const [body, setBody] = useState(null)
  const [error, setError] = useState(null)
  const [index, setIndex] = useState('all')
  const [onlySuggested, setOnlySuggested] = useState(true)
  useEffect(() => {
    fetch('/api/scanner-runner/learning').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setBody).catch((e) => setError(e.message))
  }, [])
  const list = (body?.strategies ?? []).filter((x) => index === 'all' || x.underlying === index)
  const indices = [...new Set((body?.strategies ?? []).map((x) => x.underlying))].sort()
  const shown = list.map((x) => ({ ...x, findings: onlySuggested ? x.findings.filter((f) => f.suggested) : x.findings })).filter((x) => x.findings.length || !onlySuggested)
  const g = (x) => `${x.signals} · win ${x.winPct == null ? '-' : `${x.winPct}%`} · ${fmtR(x.avgR)}`
  const apply = async (s, f) => {
    try {
      await applyFilterValue(s.strategyId, f.filter, f.mode)
      message.success({ content: `#${s.strategyNo} ${s.strategy}: only when "${f.label}" from now on - the live scanner (this browser and the server scanner); every other filter kept. It applies to all indices.`, duration: 8 })
    } catch (err) { message.error(err.message) }
  }
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        Every signal the scanners fire keeps what the market looked like at that moment - the tape, big orders, the order book (heatmap), delta,
        volume, futures OI and the option writers. As those signals close, this compares, for each strategy on each index, the ones taken with a
        condition met against the rest. A condition is suggested only with at least {body?.minSignals ?? 8} signals on each side, +{body?.minLiftR ?? 0.15}R
        or more a trade, on the older AND the newer signals - so it keeps learning as live days come in. Apply sets it as that strategy&apos;s filter.
      </Text>
      <Space wrap size={8}>
        <Select value={index} onChange={setIndex} style={{ width: 140 }} options={[{ value: 'all', label: 'All indices' }, ...indices.map((u) => ({ value: u, label: u }))]} aria-label="Learning index" />
        <Segmented value={onlySuggested ? 'suggested' : 'all'} onChange={(v) => setOnlySuggested(v === 'suggested')} options={[{ value: 'suggested', label: 'Suggestions' }, { value: 'all', label: 'Every condition' }]} />
      </Space>
      {error && <Alert type="error" showIcon message={error} />}
      {body && !shown.length && <Alert type="info" showIcon message={onlySuggested ? 'No steady pattern yet - each condition needs enough closed signals on both sides, on older and newer days. It fills in as the scanners run.' : 'No closed signals with the market kept yet.'} />}
      {shown.map((s) => (
        <Card key={`${s.underlying}-${s.strategyId}`} size="small" title={<span style={{ fontSize: 13 }}>{s.underlying} · #{s.strategyNo} {s.strategy}</span>}
          extra={<Text type="secondary" style={{ fontSize: 12 }}>{g({ signals: s.signals, winPct: s.winPct, avgR: s.avgR })} ({s.withMarket} with the market kept)</Text>} styles={{ body: { padding: 10 } }}>
          {s.findings.map((f) => (
            <div key={f.condition} style={{ borderTop: '1px solid #ffffff14', padding: '6px 0', fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
              {f.suggested ? <Tag color="green" style={{ margin: 0 }}>suggested</Tag> : <Tag style={{ margin: 0 }}>not yet</Tag>}
              <b>{f.label}</b>
              <span>met: {g(f.met)}</span>
              <Text type="secondary" style={{ fontSize: 12 }}>not met: {g(f.notMet)}</Text>
              {f.liftR != null && <b style={{ color: col(f.liftR) }}>{f.liftR >= 0 ? '+' : ''}{f.liftR.toFixed(2)}R</b>}
              <Text type="secondary" style={{ fontSize: 11, flexBasis: narrow ? '100%' : 'auto' }}>{f.why}</Text>
              {isAdmin && f.suggested && (
                <Popconfirm title={`Only take #${s.strategyNo} ${s.strategy} when "${f.label}"?`} description="Set as this strategy's filter on the live scanner (all indices); its other filters stay." okText="Apply" onConfirm={() => apply(s, f)}>
                  <Button size="small" type="primary">Apply as filter</Button>
                </Popconfirm>
              )}
            </div>
          ))}
        </Card>
      ))}
    </Space>
  )
}

// ---- Backtest: the tuning HISTORY - every run kept as CSV, the picked runs' trades clubbed by date and time -------
const runLabel = (r) => `${r.index}${r.data === 'spot' ? ' spot' : ''} · ${r.finished_ist?.slice(8, 10)}/${r.finished_ist?.slice(5, 7)} ${r.finished_ist?.slice(11, 16)} · ${r.days_used}d · ${r.tuned}`
/** The newest run of each index (for the data mode) - what the page shows until runs are picked. */
const latestPerIndex = (runs, data) => {
  const seen = new Map()
  for (const r of runs.filter((x) => x.data === data)) if (!seen.has(r.index)) seen.set(r.index, r.run_id) // runs come newest first
  return [...seen.values()]
}

function BacktestTrades() {
  const [data, setData] = useState('futures')
  const [runs, setRuns] = useState(null)
  const [picked, setPicked] = useState([])
  const [touched, setTouched] = useState(false) // the trader chose the runs themselves
  const [loaded, setLoaded] = useState({}) // run_id -> rows
  const [error, setError] = useState(null)
  const [view, setView] = useState('trades')
  const [setting, setSetting] = useState('all')
  const [order, setOrder] = useState('asc')
  const [ids, setIds] = useState([])
  const [side, setSide] = useState('all')
  const [outcome, setOutcome] = useState('all')
  const [range, setRange] = useState(null)
  const [optionsOnly, setOptionsOnly] = useState(null) // null: follow the data mode

  useEffect(() => {
    fetch('/api/strategy-tuning/history').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setRuns).catch((e) => setError(e.message))
  }, [])
  // Until runs are picked by hand, show the newest run of each index.
  useEffect(() => { if (runs && !touched) setPicked(latestPerIndex(runs, data)) }, [runs, data, touched])
  // Each picked run's file is read once and kept (a run never changes).
  useEffect(() => {
    for (const id of picked) {
      for (const kind of ['trades', 'settings']) {
        const key = `${id}:${kind}`
        if (loaded[key]) continue
        setLoaded((m) => ({ ...m, [key]: 'loading' }))
        fetch(`/api/strategy-tuning/history/${id}/${kind}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
          .then((rows) => setLoaded((m) => ({ ...m, [key]: rows })))
          .catch(() => setLoaded((m) => ({ ...m, [key]: [] })))
      }
    }
  }, [picked]) // eslint-disable-line react-hooks/exhaustive-deps

  const pickedRuns = useMemo(() => (runs ?? []).filter((r) => picked.includes(r.run_id)), [runs, picked])
  const rowsOf = (kind) => picked.flatMap((id) => (Array.isArray(loaded[`${id}:${kind}`]) ? loaded[`${id}:${kind}`] : []))
  const waiting = picked.some((id) => loaded[`${id}:trades`] === 'loading')
  const all = useMemo(() => rowsOf('trades'), [picked, loaded]) // eslint-disable-line react-hooks/exhaustive-deps
  const settings = useMemo(() => rowsOf('settings'), [picked, loaded]) // eslint-disable-line react-hooks/exhaustive-deps
  const shown = useMemo(() => all
    .filter((t) => (setting === 'all' || t.setting === setting) && (!ids.length || ids.includes(t.strategy_id))
      && (side === 'all' || t.side === side)
      && (outcome === 'all' || (outcome === 'win' ? num(t.points) > 0 : outcome === 'loss' ? num(t.points) < 0 : /stop|SL/i.test(t.closed_by)))
      && inDates(t.date, range))
    .map((t) => ({ ...t, _t: istMs(t.entry_time_ist), _p: num(t.points) }))
    .sort(byTime(order, (t) => t._t)), [all, setting, ids, side, outcome, range, order])

  const csvColumns = Object.keys(all[0] ?? {}).map((k) => ({ title: k, value: (r) => r[k] }))
  // Trading options only: the index entry / stop / target are what the signal was, not what was traded - they can be
  // put away. On by default for Spot + options, off for Futures + OI (where the futures trade is the trade).
  const justOptions = optionsOnly ?? (data === 'spot')
  // An option leg: what it was, the premium in and out, the net on it, and what closed it - its own SL, its own
  // target, or the index trade's exit.
  const leg = (label, inp, out, p, sl, target, closedBy) => {
    if (!label) return <Text type="secondary">-</Text>
    const net = num(p)
    const by = closedBy === 'its SL' ? <Tag color="red" style={{ marginInlineEnd: 0 }}>SL hit</Tag>
      : closedBy === 'its target' ? <Tag color="green" style={{ marginInlineEnd: 0 }}>target hit</Tag>
      : closedBy ? <Tag style={{ marginInlineEnd: 0 }}>index exit</Tag> : null
    return (
      <span style={{ fontSize: 12 }}>
        {label} {f1(num(inp))} → {num(out) == null ? <Tooltip title="that strike had no traded price near the exit minute"><Text type="secondary">?</Text></Tooltip> : f1(num(out))}
        {' '}<b style={{ color: col(net) }}>{pts(net)}</b> {by}
        {(num(sl) || num(target)) ? <><br /><Text type="secondary" style={{ fontSize: 11 }}>SL {f1(num(sl))} · target {f1(num(target))}</Text></> : null}
      </span>
    )
  }
  const spot = data === 'spot'

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Row gutter={[12, 8]} align="middle">
        <Col><Segmented value={data} onChange={(v) => { setData(v); setTouched(false); setIds([]) }} options={[{ value: 'futures', label: 'Futures + OI' }, { value: 'spot', label: 'Spot + options' }]} /></Col>
        <Col flex="1 1 420px">
          <Tooltip title="Every tuning run is kept. Pick any - of any index - and their trades are listed together by date and time.">
            <Select mode="multiple" allowClear value={picked} onChange={(v) => { setPicked(v); setTouched(true) }} style={{ width: '100%' }} maxTagCount="responsive"
              placeholder="Tuning runs" options={(runs ?? []).filter((r) => r.data === data).map((r) => ({ value: r.run_id, label: runLabel(r) }))} />
          </Tooltip>
        </Col>
        <Col><Segmented value={view} onChange={setView} options={[{ value: 'trades', label: 'Trades' }, { value: 'settings', label: <Tooltip title="What each strategy was tuned to in these runs - every parameter, and what it scored">Tuned settings</Tooltip> }]} /></Col>
        {!touched && runs?.length > 0 && <Col><Text type="secondary" style={{ fontSize: 12 }}>showing the newest run of each index</Text></Col>}
      </Row>
      {error && <Alert type="error" showIcon message={`The tuning history could not be read: ${error}`} />}
      {runs?.length === 0 && <Alert type="info" showIcon message="No tuning run yet - run one on the Strategy tuning page. Every run is kept here afterwards: its trades and the settings it found." />}
      {pickedRuns.length > 0 && (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {pickedRuns.map((r) => `${r.index}: ${r.finished_ist?.slice(0, 16)}, ${r.days_used} day(s) ${r.first_day} to ${r.last_day}${Number(r.days_skipped) ? `, ${r.days_skipped} left out` : ''}${Number(r.days_estimated) ? `, ${r.days_estimated} estimated` : ''}`).join(' · ')}
        </Text>
      )}
      {view === 'trades' ? (
        <>
          <Row gutter={[12, 8]} align="middle">
            <Col><Segmented value={setting} onChange={setSetting} options={[{ value: 'all', label: 'All trades' }, { value: 'as written', label: 'As written' }, { value: 'fine-tuned', label: 'Fine-tuned' }]} /></Col>
            <Col><OrderToggle value={order} onChange={setOrder} /></Col>
            <Col flex="1 1 240px"><Select mode="multiple" allowClear value={ids} onChange={setIds} placeholder="All strategies" style={{ width: '100%' }} maxTagCount="responsive"
              options={strategyOptions(all, (t) => t.strategy_id, (t) => `#${t.strategy_no} ${t.strategy}`)} /></Col>
            <Col><Segmented value={side} onChange={setSide} options={[{ value: 'all', label: 'Both sides' }, { value: 'LONG', label: 'Long' }, { value: 'SHORT', label: 'Short' }]} /></Col>
            <Col><Segmented value={outcome} onChange={setOutcome} options={[{ value: 'all', label: 'All' }, { value: 'win', label: 'Winners' }, { value: 'loss', label: 'Losers' }, { value: 'sl', label: 'SL hit' }]} /></Col>
            <Col><DatePicker.RangePicker value={range} onChange={setRange} format="DD MMM YYYY" allowEmpty={[true, true]} /></Col>
            <Col><Tooltip title="Show only what an option trade did - the index entry, stop, target and exit are the signal behind it, not the trade"><Segmented value={justOptions ? 'options' : 'both'} onChange={(v) => setOptionsOnly(v === 'options')} options={[{ value: 'options', label: 'Options only' }, { value: 'both', label: `With the ${spot ? 'index' : 'futures'}` }]} /></Tooltip></Col>
            <Col><Button onClick={() => downloadCsv(`tuning-trades.csv`, csvColumns, shown)} disabled={!shown.length}>Download CSV</Button></Col>
          </Row>
          <Totals rows={shown} points={(t) => t._p} r={(t) => num(t.r)} />
          <Table size="small" loading={waiting} rowKey={(t) => `${t.run_id}-${t.strategy_id}-${t.setting}-${t.date}-${t.entry_time_ist}`} dataSource={shown}
            pagination={{ pageSize: 50, size: 'small', showSizeChanger: true, pageSizeOptions: [50, 100, 500] }} scroll={{ x: 1500 }}
            expandable={{ rowExpandable: (t) => !!t.why, expandedRowRender: (t) => (
              <Space direction="vertical" size={2} style={{ fontSize: 12 }}>
                {t.setting_text && <Text style={{ fontSize: 12 }}><b>Setting:</b> {t.setting_text}</Text>}
                {t.why.split(' · ').map((w, i) => <Text key={i} style={{ fontSize: 12 }}>{w}</Text>)}
              </Space>
            ) }}
            columns={[
              { title: 'Date', dataIndex: 'date', width: 105, fixed: 'left' },
              { title: 'In → out (IST)', key: 'time', width: 120, render: (_, t) => `${t.entry_time_ist?.slice(11, 16)} → ${t.exit_time_ist ? t.exit_time_ist.slice(11, 16) : 'end'}` },
              { title: 'Index', dataIndex: 'index', width: 110 },
              { title: 'Strategy', key: 's', width: 220, render: (_, t) => <span style={{ fontSize: 12 }}>#{t.strategy_no} {t.strategy}
                {t.setting === 'fine-tuned' && <Tooltip title={t.setting_text}><Tag color="blue" style={{ marginLeft: 4 }}>fine-tuned</Tag></Tooltip>}
                {t.estimated_day === 'yes' && <Tooltip title="A day rebuilt from 1-minute candles (no tape / depth)"><Tag style={{ marginLeft: 4 }}>est.</Tag></Tooltip>}</span> },
              { title: 'Side', dataIndex: 'side', width: 70, render: sideTag },
              ...(justOptions ? [] : [
              { title: `${spot ? 'Index' : 'Futures'} in`, dataIndex: 'entry', width: 90, render: (v) => f1(num(v)) },
              { title: 'SL', key: 'sl', width: 95, render: (_, t) => <span style={{ fontSize: 12 }}>{f1(num(t.stop))}<br /><Text type="secondary" style={{ fontSize: 11 }}>{f1(num(t.sl_points))} pts{t.trailed_stop ? ` · trailed ${f1(num(t.trailed_stop))}` : ''}</Text></span> },
              { title: 'Target', key: 'tg', width: 95, render: (_, t) => <span style={{ fontSize: 12 }}>{f1(num(t.target))}<br /><Text type="secondary" style={{ fontSize: 11 }}>{f1(num(t.target_points))} pts</Text></span> },
              { title: `${spot ? 'Index' : 'Futures'} out`, dataIndex: 'exit', width: 90, render: (v) => f1(num(v)) },
              { title: 'Closed by', dataIndex: 'closed_by', width: 105 },
              { title: 'Points', key: 'points', width: 80, sorter: (a, b) => a._p - b._p, render: (_, t) => <b style={{ color: col(t._p) }}>{pts(t._p)}</b> },
              { title: 'R', dataIndex: 'r', width: 75, sorter: (a, b) => num(a.r) - num(b.r), render: (v) => <span style={{ color: col(num(v)) }}>{fmtR(num(v))}</span> },
              ]),
              ...(justOptions ? [{ title: <Tooltip title={INDEX_EXIT_TIP}>Exits on the {spot ? 'index' : 'futures'}</Tooltip>, key: 'ix', width: 190, render: (_, t) => indexExit(t) }] : []),
              { title: 'Option traded', key: 'ot', width: 250, render: (_, t) => (t.option_traded ? leg(t.option_traded, t.option_in, t.option_out, t.option_points, t.option_sl, t.option_target, t.option_closed_by) : <Text type="secondary">-</Text>) },
              { title: 'If I BOUGHT the option', key: 'b', width: 260, render: (_, t) => leg(t.option_bought, t.bought_in, t.bought_out, t.bought_points, t.bought_sl, t.bought_target, t.bought_closed_by) },
              { title: 'If I SOLD the option', key: 'so', width: 260, render: (_, t) => leg(t.option_sold, t.sold_in, t.sold_out, t.sold_points, t.sold_sl, t.sold_target, t.sold_closed_by) },
            ]} />
        </>
      ) : (
        <>
          <Row gutter={[12, 8]} align="middle">
            <Col flex="1 1 240px"><Select mode="multiple" allowClear value={ids} onChange={setIds} placeholder="All strategies" style={{ width: '100%' }} maxTagCount="responsive"
              options={strategyOptions(settings, (r) => r.strategy_id, (r) => `#${r.strategy_no} ${r.strategy}`)} /></Col>
            <Col><Button onClick={() => downloadCsv('tuning-settings.csv', Object.keys(settings[0] ?? {}).map((k) => ({ title: k, value: (r) => r[k] })), settings.filter((r) => !ids.length || ids.includes(r.strategy_id)))} disabled={!settings.length}>Download CSV</Button></Col>
          </Row>
          <Text type="secondary" style={{ fontSize: 12 }}>What each strategy was tuned to in the runs above, and what it scored - the strategy as written beside the setting the tuning chose. Every run is kept, so the same strategy can be compared run by run.</Text>
          <Table size="small" rowKey={(r) => `${r.run_id}-${r.strategy_id}-${r.which}`} dataSource={settings.filter((r) => !ids.length || ids.includes(r.strategy_id))}
            pagination={{ pageSize: 25, size: 'small', hideOnSinglePage: true }} scroll={{ x: 1200 }}
            expandable={{ expandedRowRender: (r) => (
              <Space size={[6, 4]} wrap>
                {Object.entries(r).filter(([k]) => k.startsWith('trade') || k.startsWith('opt')).filter(([, v]) => v !== '').map(([k, v]) => <Tag key={k} style={{ fontSize: 11 }}>{k}: <b>{v}</b></Tag>)}
              </Space>
            ) }}
            columns={[
              { title: 'Run', key: 'run', width: 150, render: (_, r) => <span style={{ fontSize: 12 }}>{r.index}<br /><Text type="secondary" style={{ fontSize: 11 }}>{r.finished_ist?.slice(0, 16)}</Text></span> },
              { title: 'Strategy', key: 's', width: 210, render: (_, r) => <span style={{ fontSize: 12 }}>#{r.strategy_no} {r.strategy}</span> },
              { title: 'Which', dataIndex: 'which', width: 110, render: (v, r) => (v === 'fine-tuned' ? <Tag color={r.recommended === 'yes' ? 'success' : 'blue'}>{r.recommended === 'yes' ? 'recommended' : 'fine-tuned'}</Tag> : <Tag>as written</Tag>) },
              { title: 'Setting', key: 'p', render: (_, r) => <span style={{ fontSize: 12 }}>{r.setting_text || <Text type="secondary">the strategy as written</Text>}</span> },
              { title: 'Train (older days)', key: 'tr', width: 190, render: (_, r) => <Text style={{ fontSize: 12 }}>{r.train_trades || 0} trades · <b style={{ color: col(num(r.train_avg)) }}>{num(r.train_avg) == null ? '-' : `${pts(num(r.train_avg))}${r.unit === 'pts' ? ' pts' : 'R'}`}</b>/trade · win {r.train_win_pct || '-'}%</Text> },
              { title: 'Test (newest days)', key: 'te', width: 190, render: (_, r) => <Text style={{ fontSize: 12 }}>{r.test_trades || 0} trades · <b style={{ color: col(num(r.test_avg)) }}>{num(r.test_avg) == null ? '-' : `${pts(num(r.test_avg))}${r.unit === 'pts' ? ' pts' : 'R'}`}</b>/trade · win {r.test_win_pct || '-'}%</Text> },
              { title: 'Points (all days)', key: 'pt', width: 200, render: (_, r) => <Text style={{ fontSize: 12 }}>net <b style={{ color: col(num(r.points_net)) }}>{pts(num(r.points_net))}</b> · {r.wins}W {r.losses}L{Number(r.sl_hits) ? ` · ${r.sl_hits} SL ${pts(num(r.sl_points))}` : ''}</Text> },
            ]} />
        </>
      )}
    </Space>
  )
}


// ---- The scanner's record: its signals (futures trades) and option trades, live and paper -----------------------
/** The scanner's own record. `initial` (from the address - an applied strategy's "See the run"): index, strategy, kind,
 *  since (ms - when its setting was applied), applied=1 (the applied strategies only). */
function ScannerRecord({ initial = {} }) {
  const [source, setSource] = useState('server')
  const [kind, setKind] = useState(initial.kind === 'trades' ? 'trades' : 'signals')
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [underlying, setUnderlying] = useState(UNDERLYINGS.includes(initial.index) ? initial.index : 'all')
  const [ids, setIds] = useState(initial.strategy ? [initial.strategy] : [])
  const [mode, setMode] = useState('all')
  const sinceMs = Number(initial.since) || null
  const [range, setRange] = useState(sinceMs ? [dayjs(sinceMs), null] : null)
  const [order, setOrder] = useState(initial.strategy || initial.applied ? 'desc' : 'asc')
  // The strategies applied per index (a fine-tuned setting, Trades / Strategy tuning page) and when: "Applied only" shows
  // just their run - each on its own index, from the moment it was applied (when that was kept).
  const [appliedOnly, setAppliedOnly] = useState(initial.applied === '1')
  const [applied, setApplied] = useState(null)
  // The server scanner's config: what is applied where, and each index's settings (redoing If bought / If sold).
  const [runnerConfig, setRunnerConfig] = useState(null)
  useEffect(() => {
    fetch('/api/scanner-runner/config').then((r) => (r.ok ? r.json() : null)).then((c) => { setRunnerConfig(c ?? {}); setApplied(c?.filtersByIndex ?? {}) }).catch(() => { setRunnerConfig({}); setApplied({}) })
  }, [])
  const appliedAt = (u, id) => {
    const f = applied?.[u]?.[id]
    return f == null ? undefined : Number.isFinite(f._appliedAt) ? f._appliedAt : 0
  }
  const file = `${source === 'server' ? 'server-' : ''}${kind}`
  const reset = (fn) => (v) => { setRows(null); setError(null); setIds([]); fn(v) }
  const [reloadTick, setReloadTick] = useState(0)
  useEffect(() => {
    fetch(`/api/scanner-log/rows/${file}`).then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then(setRows).catch((e) => setError(e.message))
  }, [file, reloadTick])
  // The option trades also read their signals: each trade's index points, and what the option bought / sold would have
  // made - each out at the strategy's own option exit, as the trade is (a trade from before those were kept with it takes
  // them from its signal).
  const [sigRows, setSigRows] = useState(null)
  useEffect(() => {
    if (kind !== 'trades') return
    fetch(`/api/scanner-log/rows/${source === 'server' ? 'server-' : ''}signals`).then((r) => (r.ok ? r.json() : [])).then(setSigRows).catch(() => setSigRows([]))
  }, [kind, source, reloadTick])
  const signalOf = useMemo(() => {
    const m = new Map()
    for (const x of sigRows ?? []) m.set(`${x.underlying}|${x.strategy_id}|${x.side}|${x.time_ist}`, x)
    return (r) => m.get(`${r.underlying}|${r.strategy_id}|${r.signal_side}|${r.signal_time_ist}`) ?? null
  }, [sigRows])
  const legOf = (r, key, sigKey) => num(r[key]) ?? (kind === 'trades' ? num(signalOf(r)?.[sigKey]) : null)
  const indexPts = (r) => (kind === 'trades' ? legOf(r, 'index_points', 'points') : num(r.points))
  // If bought / If sold: the signal's (worked out again there when an older rule's were redone), else the trade's own copy.
  const legSig = (r) => (kind === 'trades' ? signalOf(r) : r)
  const legPts = (r, which) => { const sig = legSig(r); return sig && (sig[`${which}_exit_reason`] || kind !== 'trades') ? num(sig[`${which}_points`]) : legOf(r, `${which}_points`, `${which}_points`) }
  const boughtPts = (r) => legPts(r, 'buy')
  const soldPts = (r) => legPts(r, 'sell')
  // A leg's cell: its points, and on hover the option, its premium in -> out, when and why it left.
  const LEG_TIP = { buy: 'The option BOUGHT at the signal (the strategy\'s strike), out at the strategy\'s own option exit as its trade is - its SL / target held to the index\'s Max SL / Max target, else with the index trade - premium points (to compare)', sell: 'The option SOLD at the signal (the strategy\'s strike), out at the strategy\'s own option exit as its trade is - its SL / target held to the index\'s Max SL / Max target, else with the index trade - premium points (to compare)' }
  const legCell = (which) => (_, r) => {
    const v = which === 'buy' ? boughtPts(r) : soldPts(r)
    const sig = legSig(r)
    const why = sig?.[`${which}_exit_reason`]
    const tip = sig?.[`${which}_option`]
      ? `${sig[`${which}_option`]}: ${f1(num(sig[`${which}_entry`]))} → ${f1(num(sig[`${which}_exit`]))}${why ? ` · out ${hhmm(sig[`${which}_exit_time_ist`])} - ${why}` : ' · held to the index exit (older rule - redo it above)'}`
      : 'not kept for this one'
    return <Tooltip title={tip}><span style={{ color: col(v) }}>{pts(v)}</span>{why && /SL|Target|square-off/i.test(why) && !/^with the index/.test(why) ? <Text type="secondary" style={{ fontSize: 10, marginLeft: 3 }}>{/SL/.test(why) ? 'SL' : /Target/.test(why) ? 'T' : '15:10'}</Text> : null}</Tooltip>
  }
  const signals = kind === 'signals'
  const shown = useMemo(() => (rows ?? []).filter((r) => (underlying === 'all' || r.underlying === underlying) && (!ids.length || ids.includes(r.strategy_id))
    && (signals || mode === 'all' || (mode === 'live') === (r.live === 'true')) && inDates(r.date, range)
    && (!appliedOnly || source !== 'server' || ((at) => at !== undefined && (istMs(signals ? r.time_ist : r.entry_time_ist) ?? 0) >= at)(appliedAt(r.underlying, r.strategy_id)))
    && (!sinceMs || (istMs(signals ? r.time_ist : r.entry_time_ist) ?? 0) >= sinceMs))
    .sort(byTime(order, (r) => istMs(signals ? r.time_ist : r.entry_time_ist))), [rows, underlying, ids, mode, range, signals, order, appliedOnly, applied, source, sinceMs]) // eslint-disable-line react-hooks/exhaustive-deps
  const nameOf = (r) => r.strategy || STRATEGY_BY_ID[r.strategy_id]?.name || r.strategy_id
  const signalColumns = [
    { title: 'Date', dataIndex: 'date', width: 105, fixed: 'left' },
    { title: 'In → out (IST)', key: 't', width: 120, render: (_, r) => `${hhmm(r.time_ist)} → ${r.exit_time_ist ? hhmm(r.exit_time_ist) : (r.status === 'open' || !r.status ? 'open' : '-')}` },
    { title: 'Index', dataIndex: 'underlying', width: 110 },
    { title: 'Strategy', key: 's', width: 230, render: (_, r) => <span style={{ fontSize: 12 }}>#{r.strategy_no} {nameOf(r)}{r.estimated === 'true' && <Tag style={{ marginLeft: 4 }}>est.</Tag>}</span> },
    { title: 'Side', dataIndex: 'side', width: 70, render: sideTag },
    { title: 'Entry', dataIndex: 'entry', width: 85, render: (v) => f1(num(v)) },
    { title: 'SL', dataIndex: 'stop', width: 85, render: (v) => f1(num(v)) },
    { title: 'Target', dataIndex: 'target', width: 85, render: (v) => f1(num(v)) },
    { title: 'Exit', dataIndex: 'exit_price', width: 85, render: (v) => f1(num(v)) },
    { title: 'Closed by', dataIndex: 'exit_reason', width: 120, render: (v, r) => v || r.status || '-' },
    { title: 'Points', dataIndex: 'points', width: 80, render: (v) => <b style={{ color: col(num(v)) }}>{pts(num(v))}</b> },
    { title: 'R', dataIndex: 'r', width: 75, render: (v) => <span style={{ color: col(num(v)) }}>{fmtR(num(v))}</span> },
    { title: <Tooltip title={LEG_TIP.buy}>If bought</Tooltip>, key: 'bp', width: 100, render: legCell('buy') },
    { title: <Tooltip title={LEG_TIP.sell}>If sold</Tooltip>, key: 'sp', width: 95, render: legCell('sell') },
    { title: 'Day type', dataIndex: 'day_type', width: 110 },
    { title: 'Adaptive', dataIndex: 'adaptive_take', width: 90, render: (v, r) => (v ? <Tooltip title={r.adaptive_reason}>{v === 'true' ? 'take' : v === 'false' ? 'skip' : v}</Tooltip> : '-') },
  ]
  const tradeColumns = [
    { title: 'Date', dataIndex: 'date', width: 105, fixed: 'left' },
    { title: 'In → out (IST)', key: 't', width: 120, render: (_, r) => `${hhmm(r.entry_time_ist)} → ${r.exit_time_ist ? hhmm(r.exit_time_ist) : 'open'}` },
    { title: 'Index', dataIndex: 'underlying', width: 110 },
    { title: 'Mode', dataIndex: 'live', width: 75, render: (v) => (v === 'true' ? <Tag color="red">LIVE</Tag> : <Tag>paper</Tag>) },
    { title: 'Strategy', key: 's', width: 210, render: (_, r) => <span style={{ fontSize: 12 }}>#{r.strategy_no} {nameOf(r)}{r.signal_side ? ` · ${r.signal_side}` : ''}</span> },
    { title: 'Option', key: 'o', width: 170, render: (_, r) => `${r.action} ${r.strike} ${r.option}` },
    { title: 'Lots', key: 'l', width: 80, render: (_, r) => `${r.lots} × ${r.lot_size}` },
    { title: 'Premium in → out', key: 'p', width: 140, render: (_, r) => `${f1(num(r.entry_premium))} → ${r.exit_premium ? f1(num(r.exit_premium)) : '-'}` },
    { title: 'Points', dataIndex: 'points', width: 80, render: (v) => <b style={{ color: col(num(v)) }}>{pts(num(v))}</b> },
    { title: 'Net ₹', dataIndex: 'net_rupees', width: 100, render: (v) => <b style={{ color: col(num(v)) }}>{num(v) == null ? '-' : Math.round(num(v)).toLocaleString('en-IN')}</b> },
    { title: <Tooltip title="Its signal's points on the index (futures, or spot for a spot strategy)">Index pts</Tooltip>, key: 'ip', width: 90, render: (_, r) => { const v = indexPts(r); return <b style={{ color: col(v) }}>{pts(v)}</b> } },
    { title: <Tooltip title={LEG_TIP.buy}>If bought</Tooltip>, key: 'bp', width: 100, render: legCell('buy') },
    { title: <Tooltip title={LEG_TIP.sell}>If sold</Tooltip>, key: 'sp', width: 95, render: legCell('sell') },
    { title: 'Closed by', dataIndex: 'exit_reason', width: 130 },
  ]
  const columns = signals ? signalColumns : tradeColumns
  const csvTitle = { ip: 'index_points', bp: 'if_bought_points', sp: 'if_sold_points' }
  const csvColumns = columns.map((c) => ({ title: typeof c.title === 'string' ? c.title : csvTitle[c.key] ?? c.key, value: (r) => (c.dataIndex ? r[c.dataIndex] : c.key === 't' ? `${(signals ? r.time_ist : r.entry_time_ist) ?? ''} -> ${r.exit_time_ist ?? ''}` : c.key === 's' ? nameOf(r) : c.key === 'o' ? `${r.action} ${r.strike} ${r.option}` : c.key === 'l' ? `${r.lots}x${r.lot_size}` : c.key === 'p' ? `${r.entry_premium}->${r.exit_premium}` : c.key === 'ip' ? indexPts(r) ?? '' : c.key === 'bp' ? boughtPts(r) ?? '' : c.key === 'sp' ? soldPts(r) ?? '' : '') }))
  // Signals: the market at each one too (tape, big orders, futures OI, book... - the mkt_* columns).
  if (signals) for (const k of MARKET_CSV) csvColumns.push({ title: k, value: (r) => r[k] ?? '' })
  const rupees = shown.map((r) => num(r.net_rupees)).filter(Number.isFinite).reduce((a, b) => a + b, 0)
  // To compare: the index points, and what buying / selling the option every time would have made (each out at the
  // strategy's own option exit, as its trade is).
  const sum = (f) => { const v = shown.map(f).filter(Number.isFinite); return { n: v.length, total: v.reduce((a, b) => a + b, 0) } }
  const compare = { index: sum(indexPts), bought: sum(boughtPts), sold: sum(soldPts) }
  // Signals kept before "If bought / If sold" were recorded with them (closed, none yet), or under the older rule (held to
  // the index exit): worked out from that day's OI with each index's settings now and saved into the log (recordLegs.js) -
  // each index and day once. Admins.
  const isAdmin = useAuth()?.user?.role === 'Admin'
  const toFill = (() => {
    const seen = new Set()
    return (signals ? shown : shown.map(signalOf).filter(Boolean)).filter((r) => needsLegs(r) && !seen.has(r.key) && seen.add(r.key))
  })()
  const toRedo = toFill.filter(oldRuleLegs).length
  const [filling, setFilling] = useState(null)
  const fillLegs = async () => {
    setFilling({ done: 0, total: 1 })
    try {
      const { legs, failed } = await fillRecordLegs(toFill, { fetchRun: (u, d) => fetch(recordRunUrl(u, d)).then((r) => r.json()), settingsOf: (u) => runnerSettingsOf(runnerConfig, u), onProgress: setFilling })
      if (legs.length) {
        const res = await fetch(`/api/scanner-log/legs/${source === 'server' ? 'server-' : ''}signals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(legs) })
        const body = await res.json().catch(() => null)
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const days = failed.map((f) => `${f.underlying} ${f.date} (${f.reason})`).slice(0, 4).join(', ')
      if (failed.length) message.warning(`${legs.length} filled in · ${failed.length} day(s) could not be: ${days}${failed.length > 4 ? '…' : ''}`, 8)
      else message.success(`${legs.length} filled in`)
      setReloadTick((x) => x + 1)
    } catch (err) {
      message.error(`Not filled in: ${err.message}`)
    } finally {
      setFilling(null)
    }
  }
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Row gutter={[12, 8]} align="middle">
        <Col><Segmented value={source} onChange={reset(setSource)} options={[{ value: 'server', label: <Tooltip title="The server's scanner (runs without the page open)">Server scanner</Tooltip> }, { value: 'page', label: <Tooltip title="The Order Flow page's scanner (what the browser saved)">Order Flow page</Tooltip> }]} /></Col>
        <Col><Segmented value={kind} onChange={reset(setKind)} options={[{ value: 'signals', label: 'Signals' }, { value: 'trades', label: 'Option trades' }]} /></Col>
        {source === 'server' && (
          <Col>
            <Tooltip title="Only the strategies applied with a fine-tuned setting (Trades / Strategy tuning page), each on the index it was applied to, from when it was applied - their run on the server scanner">
              <Space size={4}><Switch size="small" checked={appliedOnly} onChange={setAppliedOnly} disabled={applied == null} aria-label="Applied strategies only" /><Text style={{ fontSize: 12 }}>Applied only</Text></Space>
            </Tooltip>
          </Col>
        )}
        <Col><Select value={underlying} onChange={setUnderlying} options={[{ value: 'all', label: 'All indices' }, ...UNDERLYINGS.map((u) => ({ value: u, label: u }))]} style={{ width: 130 }} /></Col>
        <Col flex="1 1 260px"><Select mode="multiple" allowClear value={ids} onChange={setIds} placeholder="All strategies" style={{ width: '100%' }} maxTagCount="responsive" options={strategyOptions(rows ?? [], (r) => r.strategy_id, (r) => `#${r.strategy_no} ${nameOf(r)}`)} /></Col>
        <Col><OrderToggle value={order} onChange={setOrder} /></Col>
        {!signals && <Col><Segmented value={mode} onChange={setMode} options={[{ value: 'all', label: 'Live + paper' }, { value: 'live', label: 'Live' }, { value: 'paper', label: 'Paper' }]} /></Col>}
        <Col><DatePicker.RangePicker value={range} onChange={setRange} format="DD MMM YYYY" allowEmpty={[true, true]} /></Col>
        <Col><Button onClick={() => downloadCsv(`${file}-filtered.csv`, csvColumns, shown)} disabled={!shown.length}>Download CSV</Button></Col>
      </Row>
      {error && <Alert type="error" showIcon message={`The record could not be loaded: ${error}`} />}
      {sinceMs && <Text type="secondary" style={{ fontSize: 12 }}>From {new Date(sinceMs).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })} IST - when its setting was applied.</Text>}
      {appliedOnly && source === 'server' && applied && !Object.keys(applied).length && <Alert type="info" showIcon message="Nothing is applied yet - apply a fine-tuned setting on Strategy performance (Best setting · apply) and its run shows here." />}
      {rows && (
        <>
          <Totals rows={shown} points={(r) => num(r.points)} r={signals ? (r) => num(r.r) : null} extra={!signals && <span>net <b style={{ color: col(rupees) }}>₹{Math.round(rupees).toLocaleString('en-IN')}</b> after charges</span>} />
          <Space size={16} wrap style={{ fontSize: 13 }} aria-label="Compare">
            <Text type="secondary" style={{ fontSize: 12 }}>To compare{signals ? '' : ' (the same signals)'}:</Text>
            {!signals && <span>index <b style={{ color: col(compare.index.total) }}>{pts(compare.index.total)}</b> pts{compare.index.n < shown.length ? ` (${compare.index.n})` : ''}</span>}
            <span>if bought every time <b style={{ color: col(compare.bought.total) }}>{pts(compare.bought.total)}</b> pts{compare.bought.n < shown.length ? ` (${compare.bought.n} kept)` : ''}</span>
            <span>if sold every time <b style={{ color: col(compare.sold.total) }}>{pts(compare.sold.total)}</b> pts{compare.sold.n < shown.length ? ` (${compare.sold.n} kept)` : ''}</span>
            {isAdmin && toFill.length > 0 && (
              <Tooltip title="Older signals were kept without what the option bought / sold would have made, or with it held until the index trade exited (the older rule - not how the trade leaves): worked out now from that day's option data the way the trade is taken - the strategy's strike, out at its own option exit (its SL / target held to the index's Max SL / Max target, else with the index trade), with each index's settings now - and saved, so it is done once.">
                <Button size="small" loading={!!filling} onClick={fillLegs} disabled={runnerConfig == null}>
                  {filling ? `Working out… ${filling.done} / ${filling.total} day(s)${filling.underlying ? ` · ${filling.underlying} ${filling.date}` : ''}` : toRedo ? `Redo with each option's own exit (${toFill.length})` : `Fill in the older ones (${toFill.length})`}
                </Button>
              </Tooltip>
            )}
          </Space>
          <Table size="small" rowKey="key" dataSource={shown} columns={columns} pagination={{ pageSize: 50, size: 'small', showSizeChanger: true, pageSizeOptions: [50, 100, 500] }} scroll={{ x: 1400 }} />
          <Text type="secondary" style={{ fontSize: 12 }}>The whole file: <a href={`/api/scanner-log/${file}`} download>{file}.csv</a>{signals ? ' - every signal with the market at its time (tape, big orders, futures OI, option writers, the order book: the mkt_ columns)' : ''}.</Text>
        </>
      )}
    </Space>
  )
}

// ---- All trades: every strategy's trades from every tuning run, one stream by date and time ------------------------
const ALL_TRADE_CSV = ['date', 'entry_time_ist', 'exit_time_ist', 'index', 'strategy_no', 'strategy', 'setting', 'setting_text', 'side', 'entry', 'stop', 'target', 'exit',
  'trailed_stop', 'closed_by', 'points', 'r', 'option_bought', 'bought_points', 'bought_r', 'option_sold', 'sold_points', 'sold_r', 'option_traded', 'option_points', 'run_id']

/** Every strategy's trades across all tuning runs (a trade two runs both scanned is listed once), newest or oldest
 *  first by date and time - filtered by index, strategy, setting, side and dates; paged and totalled on the server. */
function AllTrades() {
  const narrow = useNarrow()
  const [data, setData] = useState('futures')
  const [index, setIndex] = useState('all')
  const [setting, setSetting] = useState('both')
  // The strategies shown: by default the LIVE ones - on the index's live list or with a fine-tuned setting applied there
  // (all indices: on any) - not every strategy; null = that default, [] = every strategy, else the ones picked.
  const [picked, setPicked] = useState(null)
  const [cfg, setCfg] = useState(undefined) // the scanner config (admins): undefined while loading, null when not readable
  useEffect(() => { fetch('/api/scanner-runner/config').then((r) => (r.ok ? r.json() : null)).then((c) => setCfg(c ?? null)).catch(() => setCfg(null)) }, [])
  const liveIds = (u) => [...new Set((u === 'all' ? UNDERLYINGS : [u]).flatMap((x) => [...(cfg?.liveList?.[x] ?? []), ...Object.keys(cfg?.filtersByIndex?.[x] ?? {})]))]
    .filter((id) => STRATEGY_BY_ID[id] && !!STRATEGY_BY_ID[id].spot === (data === 'spot'))
  const ids = picked ?? liveIds(index)
  const byDefault = picked == null && ids.length > 0
  const setIds = setPicked
  const [side, setSide] = useState('both')
  const [range, setRange] = useState(null)
  const [order, setOrder] = useState('desc')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(100)
  const [body, setBody] = useState(null)
  const [error, setError] = useState(null)
  const day = (d) => (d ? d.format('YYYY-MM-DD') : null)
  const params = (skip, take) => {
    const q = new URLSearchParams({ data, order, skip: String(skip), take: String(take) })
    if (index !== 'all') q.set('index', index)
    if (setting !== 'both') q.set('setting', setting)
    if (ids.length) q.set('strategies', ids.join(','))
    if (side !== 'both') q.set('side', side)
    if (day(range?.[0])) q.set('from', day(range[0]))
    if (day(range?.[1])) q.set('to', day(range[1]))
    return q
  }
  const key = JSON.stringify([data, index, setting, ids, side, day(range?.[0]), day(range?.[1]), order, page, pageSize])
  useEffect(() => {
    if (cfg === undefined) return // the default strategies come from the scanner config: wait for it
    fetch(`/api/strategy-tuning/performance/all-trades?${params((page - 1) * pageSize, pageSize)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b) => { setBody({ ...b, key }); setError(null) }).catch((e) => setError(e.message))
  }, [key, cfg === undefined]) // eslint-disable-line react-hooks/exhaustive-deps
  const current = body?.key === key ? body : null
  // Any filter change goes back to the first page.
  const change = (set) => (v) => { set(v); setPage(1) }
  const strategyChoices = Object.values(STRATEGY_BY_ID).filter((s) => !s.retired && !!s.spot === (data === 'spot'))
    .sort((a, b) => (Number(a.no) || 0) - (Number(b.no) || 0)).map((s) => ({ value: s.id, label: `#${s.no} ${s.name}` }))
  const rows = (current?.trades ?? []).map((t) => ({ ...t, _p: num(t.points), _r: num(t.r), _br: legR(t, 'bought'), _sr: legR(t, 'sold') }))
  const tot = current?.totals
  const one = index !== 'all'
  const download = async () => {
    try {
      const b = await fetch(`/api/strategy-tuning/performance/all-trades?${params(0, 5000)}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      downloadCsv(`all-trades${one ? `-${index}` : ''}.csv`, ALL_TRADE_CSV.map((k) => ({ title: k, value: (r) => r[k] })), b.trades ?? [])
      if (b.total > 5000) message.info(`The first 5,000 of ${b.total.toLocaleString('en-IN')} trades - narrow the filters (dates, index) for the rest.`)
    } catch (err) { message.error(err.message) }
  }
  const strategyCell = (t) => <span style={{ fontSize: 12 }}>#{t.strategy_no} {t.strategy}</span>
  const settingTag = (t) => (t.setting === 'fine-tuned' ? <Tooltip title={t.setting_text}><Tag color="blue">fine-tuned</Tag></Tooltip> : <Tag>as written</Tag>)
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Row gutter={[10, 8]} align="middle">
        <Col><Segmented value={data} onChange={change((v) => { setData(v); setIds(null) })} options={[{ value: 'futures', label: 'Futures + OI' }, { value: 'spot', label: 'Spot + options' }]} /></Col>
        <Col><Select value={index} onChange={change(setIndex)} style={{ width: 140 }} options={[{ value: 'all', label: 'All indices' }, ...UNDERLYINGS.map((u) => ({ value: u, label: u }))]} aria-label="Index" /></Col>
        <Col><Segmented value={setting} onChange={change(setSetting)} options={[{ value: 'both', label: 'All settings' }, { value: 'fine-tuned', label: 'Fine-tuned' }, { value: 'as written', label: 'As written' }]} /></Col>
        <Col><Segmented value={side} onChange={change(setSide)} options={[{ value: 'both', label: 'Long & short' }, { value: 'LONG', label: 'Long' }, { value: 'SHORT', label: 'Short' }]} /></Col>
        <Col flex="1 1 260px"><Select mode="multiple" allowClear value={ids} onChange={change(setIds)} placeholder="All strategies" style={{ width: '100%' }} maxTagCount="responsive" options={strategyChoices} aria-label="Strategies" /></Col>
        <Col>
          {byDefault
            ? <Tooltip title="Shown by default: the strategies on the live list or with a fine-tuned setting applied (for the index picked)"><Button size="small" onClick={() => change(setIds)([])}>Show all strategies</Button></Tooltip>
            : liveIds(index).length > 0 && <Button size="small" onClick={() => change(setIds)(null)}>Live strategies only</Button>}
        </Col>
        <Col><DatePicker.RangePicker value={range} onChange={change(setRange)} format="DD MMM YYYY" allowEmpty={[true, true]} aria-label="Dates" /></Col>
        <Col><OrderToggle value={order} onChange={change(setOrder)} /></Col>
        <Col><Button onClick={download} disabled={!current?.total}>Download CSV</Button></Col>
      </Row>
      <Text type="secondary" style={{ fontSize: 12 }}>
        Every strategy&apos;s trades from every tuning run kept, one list by date and time (a trade two runs both scanned is listed once). As written = the strategy&apos;s own rules;
        fine-tuned = with the setting that run chose (hover the tag). The live and paper trades the scanner took are on Scanner record.
      </Text>
      {error && <Alert type="error" showIcon message={`The trades could not be read: ${error}`} />}
      {tot && (
        <Space size={16} wrap style={{ fontSize: 13 }}>
          <span><b>{tot.trades.toLocaleString('en-IN')}</b> trades</span>
          <span>{tot.wins}W / {tot.losses}L{tot.wins + tot.losses ? ` · win ${Math.round((tot.wins / (tot.wins + tot.losses)) * 100)}%` : ''}</span>
          <span>total <b style={{ color: col(tot.totalR) }}>{fmtR(tot.totalR)}</b></span>
          <span>{tot.days} day(s){tot.firstDay ? ` · ${tot.firstDay} to ${tot.lastDay}` : ''}</span>
        </Space>
      )}
      {tot?.byIndex?.length > 0 && <PointsTotals byIndex={tot.byIndex} spot={data === 'spot'} />}
      {narrow ? (
        <Space direction="vertical" size={6} style={{ width: '100%' }}>
          {!current && !error && <Text type="secondary">loading…</Text>}
          {rows.map((t, i) => (
            <div key={`${t.run_id}-${t.date}-${t.entry_time_ist}-${t.strategy_id}-${t.setting}-${i}`} style={{ borderTop: '1px solid #ffffff14', paddingTop: 6, fontSize: 12 }}>
              <div><b>{t.date}</b> {hhmm(t.entry_time_ist)} → {t.exit_time_ist ? hhmm(t.exit_time_ist) : 'end'} · {t.index} · {sideTag(t.side)} {settingTag(t)}</div>
              <div>{strategyCell(t)}</div>
              <div>{f1(num(t.entry))} → {f1(num(t.exit))} · {t.closed_by || '-'} · <b style={{ color: col(t._p) }}>{pts(t._p)}</b> pts · <span style={{ color: col(t._r) }}>{fmtR(t._r)}</span></div>
            </div>
          ))}
          {current?.total > pageSize && (
            <Space>
              <Button size="small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Newer</Button>
              <Text type="secondary" style={{ fontSize: 12 }}>page {page} of {Math.ceil(current.total / pageSize)}</Text>
              <Button size="small" disabled={page * pageSize >= current.total} onClick={() => setPage((p) => p + 1)}>Older</Button>
            </Space>
          )}
        </Space>
      ) : (
        <Table size="small" loading={!current && !error} dataSource={rows} scroll={{ x: 1600 }}
          rowKey={(t, i) => `${t.run_id}-${t.date}-${t.entry_time_ist}-${t.strategy_id}-${t.setting}-${i}`}
          pagination={{ current: page, pageSize, total: current?.total ?? 0, size: 'small', showSizeChanger: true, pageSizeOptions: [50, 100, 500, 1000],
            showTotal: (n) => `${n.toLocaleString('en-IN')} trades`, onChange: (p, s) => { setPage(s !== pageSize ? 1 : p); setPageSize(s) } }}
          columns={[
            { title: 'Date', dataIndex: 'date', width: 100, fixed: 'left' },
            { title: 'In → out', key: 't', width: 110, render: (_, t) => `${hhmm(t.entry_time_ist)} → ${t.exit_time_ist ? hhmm(t.exit_time_ist) : 'end'}` },
            { title: 'Index', dataIndex: 'index', width: 100 },
            { title: 'Strategy', key: 'st', width: 230, render: (_, t) => strategyCell(t) },
            { title: 'Setting', key: 's', width: 110, render: (_, t) => settingTag(t) },
            { title: 'Side', dataIndex: 'side', width: 70, render: sideTag },
            { title: 'In → out', key: 'p', width: 140, render: (_, t) => `${f1(num(t.entry))} → ${f1(num(t.exit))}` },
            { title: <Tooltip title={INDEX_EXIT_TIP}>Index SL / target</Tooltip>, key: 'ix', width: 190, render: (_, t) => indexExit(t) },
            { title: 'Points', key: 'pt', width: 80, render: (_, t) => <b style={{ color: col(t._p) }}>{pts(t._p)}</b> },
            { title: 'R', key: 'r', width: 70, render: (_, t) => <span style={{ color: col(t._r) }}>{fmtR(t._r)}</span> },
            { title: 'Option bought', key: 'b', width: 170, render: (_, t) => (t.option_bought ? <span style={{ fontSize: 12 }}>{t.option_bought} <span style={{ color: col(num(t.bought_points)) }}>{pts(num(t.bought_points))}</span> · <b style={{ color: col(t._br) }}>{fmtR(t._br)}</b></span> : '-') },
            { title: 'Option sold', key: 'so', width: 170, render: (_, t) => (t.option_sold ? <span style={{ fontSize: 12 }}>{t.option_sold} <span style={{ color: col(num(t.sold_points)) }}>{pts(num(t.sold_points))}</span> · <b style={{ color: col(t._sr) }}>{fmtR(t._sr)}</b></span> : '-') },
            { title: 'Tuned option', key: 'o', width: 170, render: (_, t) => (t.option_traded ? <span style={{ fontSize: 12 }}>{t.option_traded} <b style={{ color: col(num(t.option_points)) }}>{pts(num(t.option_points))}</b>{t.option_closed_by ? ` · ${t.option_closed_by}` : ''}</span> : '-') },
          ]} />
      )}
    </Space>
  )
}

/** Trades: every trade with its date and time in one place - the backtest (each strategy on every day of the latest
 *  tuning run) and the scanner's own record (its signals and the live / paper option trades it took). */
const TAB_VALUES = ['performance', 'all', 'backtest', 'record', 'learning']
export default function TradesPage() {
  const auth = useAuth()
  // ?tab=record&index=..&strategy=.. (an applied strategy's "See the run") opens that tab, filtered.
  const location = useLocation()
  const query = useMemo(() => Object.fromEntries(new URLSearchParams(location.search)), [location.search])
  const [tab, setTab] = useState(() => (TAB_VALUES.includes(query.tab) ? query.tab : 'performance'))
  useEffect(() => { if (TAB_VALUES.includes(query.tab)) setTab(query.tab) }, [query.tab, location.key])
  const [reloadKey, setReloadKey] = useState(0)
  return (
    <div className="tuning-page" style={{ maxWidth: 1600, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>
        <Card size="small" title="Trades" extra={(
          <Space size={8} wrap>
            <Segmented value={tab} onChange={setTab} options={[
              { value: 'performance', label: <Tooltip title="Every tuning run of every index added up per strategy - which strategies do best">Strategy performance</Tooltip> },
              { value: 'all', label: <Tooltip title="Every strategy's trades from every tuning run, in one list by date and time - filter by index, strategy, setting, side and dates">All trades</Tooltip> },
              { value: 'backtest', label: 'Backtest (tuning run)' }, { value: 'record', label: 'Scanner record (live & paper)' },
              { value: 'learning', label: <Tooltip title="Which order-flow conditions at the signal (tape, big orders, order book, delta, volume) went with winning trades, from the live signals">What wins (live)</Tooltip> }]} />
            {auth?.user?.role === 'Admin' && <ClearData onCleared={() => setReloadKey((k) => k + 1)} />}
          </Space>
        )}>
          {tab === 'performance' ? <StrategyPerformance key={reloadKey} reloadKey={reloadKey} /> : tab === 'all' ? <AllTrades key={reloadKey} /> : tab === 'backtest' ? <BacktestTrades key={reloadKey} /> : tab === 'learning' ? <Learning key={reloadKey} /> : <ScannerRecord key={`${reloadKey}-${location.key}`} initial={query.tab === 'record' ? query : {}} />}
        </Card>
      </Space>
    </div>
  )
}
