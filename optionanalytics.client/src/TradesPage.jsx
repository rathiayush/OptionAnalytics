import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Col, DatePicker, InputNumber, Popconfirm, Row, Segmented, Select, Space, Table, Tag, Tooltip, Typography, message } from 'antd'
import { NavBar, useAuth, UP_COLOR, DOWN_COLOR } from './shared.jsx'
import { STRATEGY_BY_ID } from './strategyEngine.js'
import { useNarrow } from './DomDrawer.jsx'
import { paramsFromSettingsRow } from './strategyTuning.js'
import { applyTunedFilters } from './scannerSettings.js'
import ClearData from './ClearData.jsx'
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

/** One trade sequence for every strategy: by entry date, then time (then index, strategy number). */
const byTime = (order, timeOf) => (a, b) => (order === 'desc' ? -1 : 1) * (String(a.date ?? '').localeCompare(String(b.date ?? '')) || (timeOf(a) ?? 0) - (timeOf(b) ?? 0)
  || String(a.index ?? a.underlying ?? '').localeCompare(String(b.index ?? b.underlying ?? '')) || (Number(a.no ?? a.strategy_no) || 0) - (Number(b.no ?? b.strategy_no) || 0))
const OrderToggle = ({ value, onChange }) => <Segmented value={value} onChange={onChange} options={[{ value: 'asc', label: 'Oldest first' }, { value: 'desc', label: 'Newest first' }]} />
const istMs = (s) => (s ? Date.parse(`${String(s).replace(' ', 'T')}+05:30`) : null) // "yyyy-MM-dd HH:mm:ss" (IST) -> ms

const inDates = (date, range) => (!range?.[0] || date >= range[0].format('YYYY-MM-DD')) && (!range?.[1] || date <= range[1].format('YYYY-MM-DD'))
const strategyOptions = (rows, idOf, label) => [...new Map(rows.map((r) => [idOf(r), label(r)])).entries()].filter(([id]) => id).sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'en', { numeric: true })).map(([value, l]) => ({ value, label: l }))

// ---- Strategy performance: every tuning run added up per strategy, all indices -----------------------------------
const pctOf = (v) => (v == null ? '-' : `${Math.round(v * 100)}%`)
/** Points are only comparable within one index (BANKNIFTY moves ~2.5x NIFTY): shown per index; R compares across. */
function StrategyPerformance({ reloadKey }) {
  const auth = useAuth()
  const isAdmin = auth?.user?.role === 'Admin'
  const [data, setData] = useState('futures')
  const [setting, setSetting] = useState('fine-tuned')
  const [index, setIndex] = useState('all')
  const [minTrades, setMinTrades] = useState(5)
  const [view, setView] = useState('ranking')
  const narrow = useNarrow()
  const [openRows, setOpenRows] = useState({}) // phone: which strategy cards show their tuned settings
  const [body, setBody] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    // Kept with the data mode it is for, so a switch shows loading rather than the other mode's numbers.
    fetch(`/api/strategy-tuning/performance?data=${data}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((b) => { setBody({ ...b, data }); setError(null) }).catch((e) => setError(e.message))
  }, [data, reloadKey])
  const current = body?.data === data ? body : null
  const statsOf = (r) => (index === 'all' ? r.all : r.byIndex?.[index])
  const rows = useMemo(() => (current?.rows ?? [])
    .filter((r) => (setting === 'both' || r.setting === setting))
    .map((r) => ({ ...r, s: statsOf(r), key: `${r.strategyId}-${r.setting}` }))
    .filter((r) => r.s && r.s.trades >= minTrades)
    .sort((a, b) => (b.s.avgR ?? -1e9) - (a.s.avgR ?? -1e9) || b.s.points - a.s.points), [current, setting, index, minTrades]) // eslint-disable-line react-hooks/exhaustive-deps
  const indices = useMemo(() => [...new Set((current?.rows ?? []).flatMap((r) => Object.keys(r.byIndex ?? {})))].sort(), [current])
  const apply = async (r, tuned) => {
    try {
      const params = paramsFromSettingsRow(tuned)
      await applyTunedFilters(r.strategyId, params, { option: tuned.unit === 'pts' })
      message.success({ content: `#${r.strategyNo} ${r.strategy}: ${tuned.index}'s tuned setting is in force now for the live scanner (this browser and the server scanner)${tuned.setting_text ? ` - ${tuned.setting_text}` : ''}`, duration: 8 })
    } catch (err) {
      message.error(err.message)
    }
  }
  const one = index !== 'all'
  // The best strategy of each index, fine-tuned and as written (at least `minTrades` trades, best average R).
  const bestOf = (u, which) => (current?.rows ?? []).filter((r) => r.setting === which && (r.byIndex?.[u]?.trades ?? 0) >= minTrades)
    .sort((a, b) => (b.byIndex[u].avgR ?? -1e9) - (a.byIndex[u].avgR ?? -1e9))[0]
  // The grid: one row per strategy (the setting picked), one column per index, the best cell of each index marked.
  const gridRows = useMemo(() => {
    const which = setting === 'both' ? 'fine-tuned' : setting
    return (current?.rows ?? []).filter((r) => r.setting === which).map((r) => ({ ...r, key: r.strategyId }))
  }, [current, setting])
  const bestInColumn = Object.fromEntries(indices.map((u) => [u, gridRows.filter((r) => (r.byIndex?.[u]?.trades ?? 0) >= minTrades).sort((a, b) => (b.byIndex[u].avgR ?? -1e9) - (a.byIndex[u].avgR ?? -1e9))[0]?.strategyId]))
  const applyButton = (r, t) => (isAdmin && data === 'futures' ? (
    <Popconfirm title={`Apply this ${t.row.index} setting to #${r.strategyNo} ${r.strategy}?`} description={`${t.recommended ? '' : 'No run recommended it. '}The live scanner (this browser and the server scanner) takes it from now; whatever was applied to this strategy before is replaced.`} okText="Apply" onConfirm={() => apply(r, t.row)}>
      <Button size="small" type={t.best ? 'primary' : 'default'}>Apply to live scanner</Button>
    </Popconfirm>
  ) : null)
  const tunedTable = (r) => {
    const entries = Object.entries(r.tunedSettings ?? {})
    if (!entries.length) return <Text type="secondary" style={{ fontSize: 12 }}>No fine-tuned setting for this strategy in the runs kept.</Text>
    if (narrow) return (
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {entries.flatMap(([, list]) => list).map((t) => (
          <div key={`${t.row.index}-${t.row.run_id}-${t.row.setting_text}`} style={{ borderTop: '1px solid #ffffff14', paddingTop: 6, fontSize: 12 }}>
            <div><b>{t.row.index}</b>{t.best && <Tag color="gold" style={{ marginLeft: 6 }}>best</Tag>} {t.row.setting_text || '-'}</div>
            <Text type="secondary" style={{ fontSize: 12 }}>{t.runs} run(s) · {t.recommended} recommended · unseen {t.testTrades} trades <b style={{ color: col(t.testAvg) }}>{t.testAvg == null ? '-' : `${pts(t.testAvg)}${t.unit === 'pts' ? ' pts' : 'R'}`}</b>/trade</Text>
            <div style={{ marginTop: 4 }}>{applyButton(r, t)}</div>
          </div>
        ))}
      </Space>
    )
    return (
      <Table size="small" pagination={false} rowKey={(t) => `${t.row.index}-${t.row.run_id}-${t.row.setting_text}`}
        dataSource={entries.flatMap(([, list]) => list)}
        columns={[
          { title: 'Index', key: 'i', width: 100, render: (_, t) => <span style={{ fontSize: 12 }}>{t.row.index}{t.best && <Tag color="gold" style={{ marginLeft: 4 }}>best</Tag>}</span> },
          { title: 'Fine-tuned setting', key: 's', render: (_, t) => <span style={{ fontSize: 12 }}>{t.row.setting_text || '-'}</span> },
          { title: <Tooltip title="How many tuning runs chose this setting, and how many of them recommended it (it also won on the days that run held back)">Chosen / recommended</Tooltip>, key: 'r', width: 150, render: (_, t) => <span style={{ fontSize: 12 }}>{t.runs} run(s) · {t.recommended} recommended</span> },
          { title: <Tooltip title="The days each run held back and never chose on - the honest number">Unseen days</Tooltip>, key: 'te', width: 170, render: (_, t) => <span style={{ fontSize: 12 }}>{t.testTrades} trades · <b style={{ color: col(t.testAvg) }}>{t.testAvg == null ? '-' : `${pts(t.testAvg)}${t.unit === 'pts' ? ' pts' : 'R'}`}</b>/trade</span> },
          { title: 'Chosen on', key: 'tr', width: 150, render: (_, t) => <Text type="secondary" style={{ fontSize: 12 }}>{t.trainTrades} trades · {t.trainAvg == null ? '-' : `${pts(t.trainAvg)}${t.unit === 'pts' ? ' pts' : 'R'}`}</Text> },
          { title: <Tooltip title="Unseen-days average shrunk for few trades (avg x n / (n + 10)) - a setting proven over many unseen trades ranks above a lucky one">Score</Tooltip>, key: 'sc', width: 80, render: (_, t) => <span style={{ color: col(t.score) }}>{t.score == null ? '-' : `${pts(t.score)}${t.unit === 'pts' ? '' : 'R'}`}</span> },
          { title: '', key: 'a', width: 170, render: (_, t) => applyButton(r, t) },
        ]} />
    )
  }
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Row gutter={[12, 8]} align="middle">
        <Col><Segmented value={data} onChange={setData} options={[{ value: 'futures', label: 'Futures + OI' }, { value: 'spot', label: 'Spot + options' }]} /></Col>
        <Col><Segmented value={setting} onChange={setSetting} options={[{ value: 'fine-tuned', label: 'Fine-tuned' }, { value: 'as written', label: 'As written' }, { value: 'both', label: 'Both' }]} /></Col>
        <Col><Select value={index} onChange={setIndex} style={{ width: 140 }} options={[{ value: 'all', label: 'All indices' }, ...indices.map((u) => ({ value: u, label: u }))]} /></Col>
        <Col><Space size={6}><Tooltip title="A strategy needs at least this many trades to be ranked or called best - fewer is luck"><Text>Min trades</Text></Tooltip><InputNumber min={1} max={1000} value={minTrades} onChange={(v) => v && setMinTrades(v)} style={{ width: 80 }} /></Space></Col>
        <Col><Segmented value={view} onChange={setView} options={[{ value: 'ranking', label: 'Ranking' }, { value: 'grid', label: <Tooltip title="Every strategy against every index - which strategy works on which index">By index</Tooltip> }]} /></Col>
        {current && <Col><Text type="secondary" style={{ fontSize: 12 }}>{current.runs} tuning run(s), {current.trades.toLocaleString('en-IN')} trades - a trade two runs both scanned is counted once</Text></Col>}
      </Row>
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
                    <span>Fine-tuned: {tuned ? <><b>#{tuned.strategyNo} {tuned.strategy}</b> · <b style={{ color: col(tuned.byIndex[u].avgR) }}>{fmtR(tuned.byIndex[u].avgR)}</b>/trade over {tuned.byIndex[u].trades} · win {pctOf(tuned.byIndex[u].winRate)}</> : <Text type="secondary">not enough trades yet</Text>}</span>
                    {bestSetting && <Text type="secondary" style={{ fontSize: 11 }}>its best setting: {bestSetting.row.setting_text} ({bestSetting.runs} run(s), {bestSetting.testTrades} unseen trades {fmtR(bestSetting.testAvg)})</Text>}
                    <span>As written: {written ? <><b>#{written.strategyNo} {written.strategy}</b> · <b style={{ color: col(written.byIndex[u].avgR) }}>{fmtR(written.byIndex[u].avgR)}</b>/trade over {written.byIndex[u].trades}</> : <Text type="secondary">not enough trades yet</Text>}</span>
                  </Space>
                </Card>
              </Col>
            )
          })}
        </Row>
      )}
      <details>
        <summary style={{ cursor: 'pointer', fontSize: 12 }}>How the fine-tuning works, and how to read this page</summary>
        <div style={{ fontSize: 12, marginTop: 6, lineHeight: 1.6 }}>
          <div><b>1. Scan.</b> A tuning job replays each past day in its date range through the scanner&apos;s own strategies (the same code as live) and records every signal and how it ended - stop, target, trailing stop, time stop or 15:10.</div>
          <div><b>2. Tune.</b> For each strategy it then tries the ways the trade can be taken - long / short only, the entry time window, stop and target size, time stop, trailing stop, the OI confirmation (and the option&apos;s buy / sell, strike and SL / target when asked) - on those same signals. The strategy&apos;s entry rules are never changed.</div>
          <div><b>3. No fitting the past.</b> A setting is chosen on the older 70% of the job&apos;s days and then checked on the newest 30% it never saw. It is <i>recommended</i> only when it also wins there and beats the strategy as written.</div>
          <div><b>4. Many jobs, one answer.</b> Schedule a long range as short pieces (Strategy tuning → Schedule → Split into) for every index. This page adds every run together: a trade two runs both scanned counts once; <i>As written</i> is each strategy untouched, <i>Fine-tuned</i> is with the setting each run chose. R compares across indices; points only within one index.</div>
          <div><b>5. The best setting.</b> Open a strategy: every setting the runs chose for it, per index, scored on the days each run held back (fewer unseen trades count for less). The one marked <Tag color="gold">best</Tag> is the strongest that a run recommended - Apply puts it on the live scanner for that strategy.</div>
        </div>
      </details>
      {error && <Alert type="error" showIcon message={`Could not load the strategy performance: ${error}`} />}
      {current && !current.runs && <Alert type="info" showIcon message="No tuning run yet - schedule or run one on the Strategy tuning page." />}
      {narrow ? (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {!current && !error && <Text type="secondary">loading…</Text>}
          {(view === 'grid' ? gridRows : rows).map((r, i) => {
            const x = view === 'grid' ? r.all : r.s
            const open = !!openRows[r.key]
            return (
              <Card key={r.key} size="small" styles={{ body: { padding: 10 } }}>
                <Space direction="vertical" size={4} style={{ width: '100%', fontSize: 12 }}>
                  <div>{view === 'ranking' && (i < 3 ? <Tag color="gold">{i + 1}</Tag> : <Tag>{i + 1}</Tag>)}<b>#{r.strategyNo} {r.strategy}</b> {r.setting === 'fine-tuned' ? <Tag color="blue">fine-tuned</Tag> : <Tag>as written</Tag>}</div>
                  <div><b style={{ color: col(x?.avgR) }}>{fmtR(x?.avgR)}</b>/trade · {x?.trades ?? 0} trades · win {pctOf(x?.winRate)} · total <span style={{ color: col(x?.totalR) }}>{fmtR(x?.totalR)}</span>{one && x ? <> · <span style={{ color: col(x.points) }}>{pts(x.points)} pts</span></> : null}</div>
                  <div>{Object.entries(r.byIndex ?? {}).map(([u, y]) => (
                    <span key={u} style={{ marginRight: 10, opacity: y.trades < minTrades ? 0.5 : 1 }}>{view === 'grid' && bestInColumn[u] === r.strategyId && <Tag color="gold">best</Tag>}{u} <b style={{ color: col(y.avgR) }}>{fmtR(y.avgR)}</b> ({y.trades})</span>
                  ))}</div>
                  <Button size="small" type="link" style={{ padding: 0, height: 'auto', alignSelf: 'flex-start' }} onClick={() => setOpenRows((m) => ({ ...m, [r.key]: !open }))}>{open ? 'Hide' : 'Show'} tuned settings</Button>
                  {open && tunedTable(r)}
                </Space>
              </Card>
            )
          })}
        </Space>
      ) : view === 'grid' ? (
        <Table size="small" loading={!current && !error} rowKey="key" dataSource={gridRows} pagination={false} scroll={{ x: 900 }}
          expandable={{ expandedRowRender: (r) => tunedTable(r) }}
          columns={[
            { title: `Strategy (${setting === 'as written' ? 'as written' : 'fine-tuned'})`, key: 's', fixed: 'left', width: 260, render: (_, r) => <span style={{ fontSize: 12 }}>#{r.strategyNo} {r.strategy}</span> },
            ...indices.map((u) => ({
              title: u, key: u, sorter: (a, b) => (a.byIndex?.[u]?.avgR ?? -1e9) - (b.byIndex?.[u]?.avgR ?? -1e9),
              render: (_, r) => {
                const x = r.byIndex?.[u]
                if (!x) return <Text type="secondary">-</Text>
                const best = bestInColumn[u] === r.strategyId
                const few = x.trades < minTrades
                return <span style={{ fontSize: 12, opacity: few ? 0.5 : 1 }}>{best && <Tag color="gold" style={{ marginRight: 4 }}>best</Tag>}<b style={{ color: col(x.avgR) }}>{fmtR(x.avgR)}</b>/trade · {x.trades} trades · win {pctOf(x.winRate)}<br /><Text type="secondary" style={{ fontSize: 11 }}>{pts(x.points)} pts net{few ? ' · too few trades' : ''}</Text></span>
              },
            })),
          ]} />
      ) : (
      <Table size="small" loading={!current && !error} rowKey="key" dataSource={rows} pagination={{ pageSize: 50, size: 'small', hideOnSinglePage: true }} scroll={{ x: 1200 }}
        expandable={{ expandedRowRender: (r) => (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Table size="small" pagination={false} rowKey="index" dataSource={Object.entries(r.byIndex ?? {}).map(([u, x]) => ({ index: u, ...x }))} columns={[
              { title: 'Index', dataIndex: 'index', width: 110 },
              { title: 'Trades', dataIndex: 'trades', width: 70 },
              { title: 'Win %', dataIndex: 'winRate', width: 70, render: pctOf },
              { title: 'Avg R', dataIndex: 'avgR', width: 80, render: (v) => <span style={{ color: col(v) }}>{fmtR(v)}</span> },
              { title: 'Total R', dataIndex: 'totalR', width: 85, render: (v) => <span style={{ color: col(v) }}>{fmtR(v)}</span> },
              { title: 'Net points', dataIndex: 'points', width: 95, render: (v) => <b style={{ color: col(v) }}>{pts(v)}</b> },
              { title: 'SL hits', dataIndex: 'slHits', width: 70 },
              { title: 'Option sold / bought (premium pts)', key: 'o', render: (_, x) => <span style={{ fontSize: 12 }}>sold <span style={{ color: col(x.soldPoints) }}>{pts(x.soldPoints)}</span> · bought <span style={{ color: col(x.boughtPoints) }}>{pts(x.boughtPoints)}</span>{x.optionTrades ? <> · tuned option <span style={{ color: col(x.optionPoints) }}>{pts(x.optionPoints)}</span></> : null}</span> },
              { title: 'Days', key: 'd', width: 170, render: (_, x) => <Text type="secondary" style={{ fontSize: 12 }}>{x.dayCount} day(s) · {x.firstDay} to {x.lastDay}</Text> },
            ]} />
            {tunedTable(r)}
          </Space>
        ) }}
        columns={[
          { title: 'Rank', key: 'rank', width: 55, render: (_, __, i) => (i < 3 ? <Tag color="gold">{i + 1}</Tag> : i + 1) },
          { title: 'Strategy', key: 's', render: (_, r) => <span style={{ fontSize: 12 }}>#{r.strategyNo} {r.strategy} {r.setting === 'fine-tuned' ? <Tag color="blue" style={{ marginLeft: 4 }}>fine-tuned</Tag> : <Tag style={{ marginLeft: 4 }}>as written</Tag>}</span> },
          { title: 'Trades', key: 'n', width: 70, sorter: (a, b) => a.s.trades - b.s.trades, render: (_, r) => r.s.trades },
          { title: 'Win %', key: 'w', width: 70, sorter: (a, b) => (a.s.winRate ?? 0) - (b.s.winRate ?? 0), render: (_, r) => pctOf(r.s.winRate) },
          { title: 'Avg R', key: 'ar', width: 80, sorter: (a, b) => (a.s.avgR ?? -1e9) - (b.s.avgR ?? -1e9), render: (_, r) => <b style={{ color: col(r.s.avgR) }}>{fmtR(r.s.avgR)}</b> },
          { title: 'Total R', key: 'tr', width: 85, sorter: (a, b) => a.s.totalR - b.s.totalR, render: (_, r) => <span style={{ color: col(r.s.totalR) }}>{fmtR(r.s.totalR)}</span> },
          ...(one ? [{ title: 'Net points', key: 'p', width: 95, sorter: (a, b) => a.s.points - b.s.points, render: (_, r) => <b style={{ color: col(r.s.points) }}>{pts(r.s.points)}</b> },
            { title: 'Captured / lost', key: 'cl', width: 130, render: (_, r) => <span style={{ fontSize: 12 }}><span style={{ color: UP_COLOR }}>{pts(r.s.captured)}</span> / <span style={{ color: DOWN_COLOR }}>{pts(r.s.lost)}</span></span> }] : []),
          { title: 'W / L · SL', key: 'wl', width: 110, render: (_, r) => <span style={{ fontSize: 12 }}>{r.s.wins}W {r.s.losses}L · {r.s.slHits} SL</span> },
          { title: 'Indices', key: 'i', width: 170, render: (_, r) => <span style={{ fontSize: 12 }}>{Object.entries(r.byIndex ?? {}).map(([u, x]) => `${u} ${fmtR(x.avgR)}`).join(' · ')}</span> },
          { title: 'Days · runs', key: 'd', width: 110, render: (_, r) => <Text type="secondary" style={{ fontSize: 12 }}>{r.s.dayCount} · {r.s.runCount}</Text> },
        ]} />
      )}
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
function ScannerRecord() {
  const [source, setSource] = useState('server')
  const [kind, setKind] = useState('signals')
  const [rows, setRows] = useState(null)
  const [error, setError] = useState(null)
  const [underlying, setUnderlying] = useState('all')
  const [ids, setIds] = useState([])
  const [mode, setMode] = useState('all')
  const [range, setRange] = useState(null)
  const [order, setOrder] = useState('asc')
  const file = `${source === 'server' ? 'server-' : ''}${kind}`
  const reset = (fn) => (v) => { setRows(null); setError(null); setIds([]); fn(v) }
  useEffect(() => {
    fetch(`/api/scanner-log/rows/${file}`).then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))).then(setRows).catch((e) => setError(e.message))
  }, [file])
  const signals = kind === 'signals'
  const shown = useMemo(() => (rows ?? []).filter((r) => (underlying === 'all' || r.underlying === underlying) && (!ids.length || ids.includes(r.strategy_id))
    && (signals || mode === 'all' || (mode === 'live') === (r.live === 'true')) && inDates(r.date, range))
    .sort(byTime(order, (r) => istMs(signals ? r.time_ist : r.entry_time_ist))), [rows, underlying, ids, mode, range, signals, order])
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
    { title: 'Closed by', dataIndex: 'exit_reason', width: 130 },
  ]
  const columns = signals ? signalColumns : tradeColumns
  const csvColumns = columns.map((c) => ({ title: typeof c.title === 'string' ? c.title : c.key, value: (r) => (c.dataIndex ? r[c.dataIndex] : c.key === 't' ? `${(signals ? r.time_ist : r.entry_time_ist) ?? ''} -> ${r.exit_time_ist ?? ''}` : c.key === 's' ? nameOf(r) : c.key === 'o' ? `${r.action} ${r.strike} ${r.option}` : c.key === 'l' ? `${r.lots}x${r.lot_size}` : c.key === 'p' ? `${r.entry_premium}->${r.exit_premium}` : '') }))
  const rupees = shown.map((r) => num(r.net_rupees)).filter(Number.isFinite).reduce((a, b) => a + b, 0)
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Row gutter={[12, 8]} align="middle">
        <Col><Segmented value={source} onChange={reset(setSource)} options={[{ value: 'server', label: <Tooltip title="The server's scanner (runs without the page open)">Server scanner</Tooltip> }, { value: 'page', label: <Tooltip title="The Order Flow page's scanner (what the browser saved)">Order Flow page</Tooltip> }]} /></Col>
        <Col><Segmented value={kind} onChange={reset(setKind)} options={[{ value: 'signals', label: 'Signals (futures)' }, { value: 'trades', label: 'Option trades' }]} /></Col>
        <Col><Select value={underlying} onChange={setUnderlying} options={[{ value: 'all', label: 'All indices' }, ...UNDERLYINGS.map((u) => ({ value: u, label: u }))]} style={{ width: 130 }} /></Col>
        <Col flex="1 1 260px"><Select mode="multiple" allowClear value={ids} onChange={setIds} placeholder="All strategies" style={{ width: '100%' }} maxTagCount="responsive" options={strategyOptions(rows ?? [], (r) => r.strategy_id, (r) => `#${r.strategy_no} ${nameOf(r)}`)} /></Col>
        <Col><OrderToggle value={order} onChange={setOrder} /></Col>
        {!signals && <Col><Segmented value={mode} onChange={setMode} options={[{ value: 'all', label: 'Live + paper' }, { value: 'live', label: 'Live' }, { value: 'paper', label: 'Paper' }]} /></Col>}
        <Col><DatePicker.RangePicker value={range} onChange={setRange} format="DD MMM YYYY" allowEmpty={[true, true]} /></Col>
        <Col><Button onClick={() => downloadCsv(`${file}-filtered.csv`, csvColumns, shown)} disabled={!shown.length}>Download CSV</Button></Col>
      </Row>
      {error && <Alert type="error" showIcon message={`The record could not be loaded: ${error}`} />}
      {rows && (
        <>
          <Totals rows={shown} points={(r) => num(r.points)} r={signals ? (r) => num(r.r) : null} extra={!signals && <span>net <b style={{ color: col(rupees) }}>₹{Math.round(rupees).toLocaleString('en-IN')}</b> after charges</span>} />
          <Table size="small" rowKey="key" dataSource={shown} columns={columns} pagination={{ pageSize: 50, size: 'small', showSizeChanger: true, pageSizeOptions: [50, 100, 500] }} scroll={{ x: 1400 }} />
          <Text type="secondary" style={{ fontSize: 12 }}>The whole file: <a href={`/api/scanner-log/${file}`} download>{file}.csv</a>.</Text>
        </>
      )}
    </Space>
  )
}

/** Trades: every trade with its date and time in one place - the backtest (each strategy on every day of the latest
 *  tuning run) and the scanner's own record (its signals and the live / paper option trades it took). */
export default function TradesPage() {
  const auth = useAuth()
  const [tab, setTab] = useState('performance')
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
              { value: 'backtest', label: 'Backtest (tuning run)' }, { value: 'record', label: 'Scanner record (live & paper)' }]} />
            {auth?.user?.role === 'Admin' && <ClearData onCleared={() => setReloadKey((k) => k + 1)} />}
          </Space>
        )}>
          {tab === 'performance' ? <StrategyPerformance key={reloadKey} reloadKey={reloadKey} /> : tab === 'backtest' ? <BacktestTrades key={reloadKey} /> : <ScannerRecord key={reloadKey} />}
        </Card>
      </Space>
    </div>
  )
}
