// THE STRATEGIES PAGE: every strategy in one place - the futures + OI ones and the spot + options ones (a new strategy in
// strategyEngine.js shows up here by itself) - and, for each index, what the server scanner does with it: LIVE (on the
// index's live list, the index switched to Live today), on the live list (paper until Live today), paper (alerted), or
// signals only; a fine-tuned setting applied, and how it has run since. Beside it: each index's Live today switch, today's
// signals and trades, the applied settings, the live list, and the scanner settings that used to sit on the Order Flow
// page (which strategies alert, the trailing stop, each strategy's filters, Telegram) - the server scanner runs with them.
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Alert, Button, Card, Checkbox, Col, Input, InputNumber, Row, Segmented, Space, Switch, Table, Tag, Tooltip, Typography, message } from 'antd'
import { SettingOutlined } from '@ant-design/icons'
import { NavBar, useAuth, UP_COLOR, DOWN_COLOR } from './shared.jsx'
import { ACTIVE_STRATEGIES, SPOT_STRATEGIES, STRATEGY_FILTERS, DEFAULT_TRAIL, RANGE_IDS, changedFilters, strategyStats, topFifteen } from './strategyEngine.js'
import { alertIdsFor, trailFor, trailUnit, trailPtsFor } from './scannerCore.js'
import { SCANNER_SETTINGS_KEY } from './scannerSettings.js'
import { ServerScannerCard } from './ServerScanner.jsx'
import { LiveListCard, ServerLiveSwitch, useServerLive } from './ServerLive.jsx'
import { AppliedSettings, appliedText, useServerRecord } from './ApplyTuned.jsx'
import { runLink, runOf, strategyState } from './appliedRun.js'
import { StrategyFiltersModal } from './StrategyFiltersModal.jsx'

const { Title, Text } = Typography
const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX']
// The server scanner's own defaults for anything its settings do not say (scanner-runner/indexScanner.mjs DEFAULT_SETTINGS).
const DEFAULTS = { alerts: true, telegram: true, pick: 'top15', custom: [], filters: {}, trail: { on: true, ...DEFAULT_TRAIL } }
const ALL = [...ACTIVE_STRATEGIES, ...SPOT_STRATEGIES.filter((s) => !s.retired)]
const rupee = (v) => `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v ?? 0)).toLocaleString('en-IN')}`
const readLocal = () => { try { return JSON.parse(localStorage.getItem(SCANNER_SETTINGS_KEY)) ?? {} } catch { return {} } }
const writeLocal = (patch) => { try { localStorage.setItem(SCANNER_SETTINGS_KEY, JSON.stringify({ ...readLocal(), ...patch })) } catch { /* convenience only */ } }

export default function StrategiesPage() {
  const auth = useAuth()
  const isAdmin = auth?.user?.role === 'Admin'
  const [cfg, setCfg] = useState(undefined) // undefined = loading, null = not readable (not an admin)
  const [tick, setTick] = useState(0)
  const reload = () => setTick((t) => t + 1)
  useEffect(() => {
    let stop = false
    const load = () => fetch('/api/scanner-runner/config').then((r) => (r.ok ? r.json() : null)).then((c) => { if (!stop) setCfg(c) }).catch(() => { if (!stop) setCfg(null) })
    load()
    const id = setInterval(load, 30_000)
    return () => { stop = true; clearInterval(id) }
  }, [tick])
  const serverLive = useServerLive()
  const rec = useServerRecord(tick)
  // The Top 15 as the server scanner works it out: from the scanner's record (its own signals and the pages').
  const [pageSignals, setPageSignals] = useState([])
  useEffect(() => { fetch('/api/scanner-log/rows/signals').then((r) => (r.ok ? r.json() : [])).then((x) => setPageSignals(Array.isArray(x) ? x : [])).catch(() => {}) }, [tick])
  const top = useMemo(() => {
    const seen = new Set()
    const trades = []
    for (const r of [...(rec?.signals ?? []), ...pageSignals]) {
      const r2 = Number(r.r)
      if (!r.strategy_id || !r.status || r.status === 'open' || !Number.isFinite(r2)) continue
      const key = `${r.underlying}|${r.strategy_id}|${String(r.time_ist).slice(0, 16)}`
      if (seen.has(key)) continue
      seen.add(key)
      trades.push({ id: r.strategy_id, outcome: { status: r.status, r: r2 } })
    }
    return topFifteen(strategyStats(trades))
  }, [rec, pageSignals])
  const settings = useMemo(() => ({ ...DEFAULTS, ...(cfg?.settings ?? {}) }), [cfg])
  const alertIds = Array.isArray(cfg?.alertIds) ? cfg.alertIds : alertIdsFor(settings, top)

  const [type, setType] = useState('all')
  const [show, setShow] = useState('all')
  const [search, setSearch] = useState('')
  const [filterFor, setFilterFor] = useState(null)
  const stateOf = (s, u) => strategyState({ id: s.id, spot: s.spot, u, cfg, settings, alertIds })
  const rows = ALL.filter((s) => (type === 'all' || (type === 'spot') === !!s.spot)
    && (!search || `${s.no} ${s.name} ${s.short}`.toLowerCase().includes(search.toLowerCase()))
    && (show === 'all' || UNDERLYINGS.some((u) => {
      const st = stateOf(s, u)
      return show === 'trading' ? ['live', 'list', 'paper'].includes(st.mode) : show === 'live' ? st.mode === 'live' || st.mode === 'list' : !!st.applied
    })))
    .map((s) => ({ ...s, key: s.id }))

  // Each strategy's own filters: saved into the scanner settings (every index where no fine-tuned setting is applied).
  const saveSettings = async (next, what) => {
    try {
      const res = await fetch('/api/scanner-runner/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: next, alertIds: null }) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      writeLocal({ trail: next.trail, filters: next.filters, alerts: next.alerts, telegram: next.telegram, pick: next.pick, custom: next.custom })
      message.success(`${what} - the server scanner runs with it from its next look`)
      reload()
      return true
    } catch (err) {
      message.error(`Not saved: ${err.message}`)
      return false
    }
  }

  const indexCell = (s, u) => {
    const st = stateOf(s, u)
    const run = rec && st.applied ? runOf(rec, u, s.id, Number.isFinite(st.applied._appliedAt) ? st.applied._appliedAt : null) : rec ? runOf(rec, u, s.id) : null
    const modeTag = {
      off: <Tooltip title={`The server scanner does not scan ${u} (Trade settings)`}><Tag>index off</Tag></Tooltip>,
      live: <Tooltip title={`On ${u}'s live list and ${u} is Live today: each alert places a real Dhan order`}><Tag color="red">LIVE</Tag></Tooltip>,
      list: <Tooltip title={`On ${u}'s live list: paper now, real orders once ${u} is switched to Live today`}><Tag color="orange">live list</Tag></Tooltip>,
      paper: <Tooltip title="Alerted: each signal is paper-traded (not on the live list)"><Tag color="blue">paper</Tag></Tooltip>,
      signals: <Tooltip title={s.spot ? 'Recorded only - a spot strategy trades where it is applied or on the live list' : 'Recorded only - not in the alert list (Scanner settings below), not applied or on the live list here'}><Tag>signals only</Tag></Tooltip>,
    }[st.mode]
    return (
      <Space direction="vertical" size={0}>
        <span>
          {modeTag}
          {st.applied && <Tooltip title={<>Fine-tuned setting applied on {u}: {appliedText(st.applied)}{st.applied._lots ? ` · ${st.applied._lots} lot(s)` : ''}</>}><Tag color="gold">tuned</Tag></Tooltip>}
        </span>
        {run && (run.trades > 0 || run.signals > 0) && (
          <Link to={runLink(u, s.id, st.applied?._appliedAt)} style={{ fontSize: 11 }}>
            {run.trades} trade(s){run.closed ? <> · <span style={{ color: run.net >= 0 ? UP_COLOR : DOWN_COLOR }}>{rupee(run.net)}</span></> : ''}{st.applied?._appliedAt ? ' since tuned' : ''}
          </Link>
        )}
      </Space>
    )
  }
  const columns = [
    { title: '#', dataIndex: 'no', width: 50, fixed: 'left', sorter: (a, b) => (Number(a.no) || 0) - (Number(b.no) || 0) },
    {
      title: 'Strategy', key: 'name', width: 300, fixed: 'left',
      render: (_, s) => (
        <span style={{ fontSize: 12 }}>
          {s.name}
          <Tag color={s.spot ? 'purple' : 'geekblue'} style={{ marginLeft: 6, fontSize: 10 }}>{s.spot ? 'spot + options' : 'futures + OI'}</Tag>
          {s.group === 'profile' && <Tag style={{ fontSize: 10 }}>profile</Tag>}
          {s.group === 'range' && <Tag color="cyan" style={{ fontSize: 10 }}>range</Tag>}
          {top.trial.includes(s.id) && <Tooltip title="On trial: alerted beside the Top 15 until it has enough scored trades"><Tag color="blue" style={{ fontSize: 10 }}>on trial</Tag></Tooltip>}
        </span>
      ),
    },
    ...UNDERLYINGS.map((u) => ({ title: <span>{u}{cfg?.live?.[u] && <Tag color="red" style={{ marginLeft: 6, fontSize: 10 }}>LIVE today</Tag>}</span>, key: u, width: 190, render: (_, s) => (cfg ? indexCell(s, u) : '-') })),
    {
      title: '', key: 'a', width: 190,
      render: (_, s) => {
        const edited = changedFilters(s.id, settings.filters?.[s.id]).length
        return (
          <Space size={4} wrap>
            {STRATEGY_FILTERS[s.id] && isAdmin && cfg && (
              <Tooltip title={edited ? `${edited} filter(s) changed from the strategy's tested rules` : "This strategy's own filters (its rules)"}>
                <Button size="small" icon={<SettingOutlined />} type={edited ? 'primary' : 'default'} ghost={!!edited} onClick={() => setFilterFor(s.id)} style={{ fontSize: 11 }}>
                  {edited ? `Filters · ${edited}` : 'Filters'}
                </Button>
              </Tooltip>
            )}
            <Tooltip title="Change its tuned settings and see what they would have done"><Link to={`/strategy-lab?${new URLSearchParams({ strategy: s.id })}`} style={{ fontSize: 12 }}>Lab</Link></Tooltip>
          </Space>
        )
      },
    },
  ]

  return (
    <div className="tuning-page" style={{ maxWidth: 1600, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>
        <Card size="small" title="Strategies" extra={<Space size={8} wrap><Link to="/strategy-lab">Strategy lab</Link><Link to="/trades">Trades</Link><Link to="/strategy-tuning">Strategy tuning</Link></Space>}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              Every strategy and what the <b>server scanner</b> does with it on each index - it runs them all day for NIFTY, BANKNIFTY and SENSEX, with no page open.
              <b> LIVE</b>: on the index&apos;s live list and the index switched to Live today (each alert places a real Dhan order). <b>live list</b>: paper until the index is Live today.
              <b> paper</b>: alerted, paper-traded. <b>signals only</b>: recorded, not traded. <b>tuned</b>: a fine-tuned setting applied there (hover it; the link under it is its run).
              A new strategy appears here by itself.
            </Text>
            {cfg === null && <Alert type="warning" showIcon message="Sign in with the admin login to see what is live and to change the scanner's settings." />}
            {cfg && (
              <Row gutter={[12, 12]}>
                {UNDERLYINGS.map((u) => {
                  const st = serverLive.list?.find((x) => x.underlying === u)
                  const count = (mode) => ALL.filter((s) => stateOf(s, u).mode === mode).length
                  const tuned = ALL.filter((s) => cfg.filtersByIndex?.[u]?.[s.id]).length
                  const t = cfg.trade?.[u] ?? {}
                  const lv = cfg.levels?.[u] ?? {}
                  return (
                    <Col xs={24} md={8} key={u}>
                      <Card size="small" type="inner" title={<Space size={6}><b>{u}</b>{cfg.enabled?.[u] === false ? <Tag>not scanned</Tag> : cfg.live?.[u] ? <Tag color="red">LIVE today</Tag> : <Tag>paper</Tag>}</Space>}>
                        <Space direction="vertical" size={6} style={{ width: '100%' }}>
                          {st && <ServerLiveSwitch underlying={u} st={st} isAdmin={isAdmin} set={(x, p) => serverLive.set(x, p).then((ok) => { reload(); return ok })} compact />}
                          <Text style={{ fontSize: 12 }}>
                            <Tag color="red" style={{ margin: 0 }}>{count('live')} live</Tag>{' '}
                            <Tag color="orange" style={{ margin: 0 }}>{count('list')} live list</Tag>{' '}
                            <Tag color="blue" style={{ margin: 0 }}>{count('paper')} paper</Tag>{' '}
                            <Tag color="gold" style={{ margin: 0 }}>{tuned} tuned</Tag>
                          </Text>
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            An alert trades: {t.autoTrade === 'strategy' ? 'per strategy (its tuned buy / sell)' : t.autoTrade === 'buy' ? 'buy the option' : t.autoTrade === 'off' ? 'nothing (off)' : 'sell the option'} · {t.lots ?? 1} lot(s) · option SL {lv.sl ?? '-'} / target {lv.target ?? '-'} pts · <Link to="/trade-settings">Trade settings</Link>
                          </Text>
                        </Space>
                      </Card>
                    </Col>
                  )
                })}
              </Row>
            )}
            <Row gutter={[10, 8]} align="middle">
              <Col><Segmented value={type} onChange={setType} options={[{ value: 'all', label: `All (${ALL.length})` }, { value: 'futures', label: `Futures + OI (${ACTIVE_STRATEGIES.length})` }, { value: 'spot', label: `Spot + options (${ALL.length - ACTIVE_STRATEGIES.length})` }]} aria-label="Strategy type" /></Col>
              <Col><Segmented value={show} onChange={setShow} options={[{ value: 'all', label: 'All' }, { value: 'trading', label: 'Trading (paper or live)' }, { value: 'live', label: 'Live / live list' }, { value: 'tuned', label: 'Tuned' }]} aria-label="Show" /></Col>
              <Col flex="1 1 220px"><Input allowClear placeholder="Search a strategy" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search strategies" /></Col>
            </Row>
            <Table size="small" rowKey="key" dataSource={rows} columns={columns} pagination={false} scroll={{ x: 1150 }} aria-label="Strategies by index" />
          </Space>
        </Card>

        {isAdmin && cfg && <ScannerSettings key={JSON.stringify(settings)} settings={settings} top={top} onSave={saveSettings} />}
        <ServerScannerCard isAdmin={isAdmin} focus={null} />
        {isAdmin && cfg && <AppliedSettings cfg={cfg} isAdmin={isAdmin} onChanged={reload} />}
        {isAdmin && <LiveListCard isAdmin={isAdmin} />}
      </Space>
      {filterFor && (
        <StrategyFiltersModal id={filterFor} values={settings.filters?.[filterFor]} onClose={() => setFilterFor(null)}
          onSave={async (v) => {
            const id = filterFor
            setFilterFor(null)
            await saveSettings({ ...settings, filters: { ...(settings.filters ?? {}), [id]: v } }, `${ALL.find((s) => s.id === id)?.name}: filters saved`)
          }} />
      )}
    </div>
  )
}

/** The scanner settings the server scanner runs with (they used to sit on the Order Flow page's scanner): the alerts and
 *  Telegram, which futures strategies alert (Top 15 by default), and the trailing stop on the index trade. */
function ScannerSettings({ settings, top, onSave }) {
  // (keyed by the saved settings: a save, or a change from elsewhere, starts the draft afresh)
  const [draft, setDraft] = useState(settings)
  const changed = JSON.stringify(draft) !== JSON.stringify(settings)
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }))
  const setTrail = (patch) => setDraft((d) => ({ ...d, trail: { ...DEFAULTS.trail, ...d.trail, ...patch } }))
  const setTrailPts = (u, patch) => setDraft((d) => ({ ...d, trail: { ...DEFAULTS.trail, ...d.trail, pts: { ...d.trail?.pts, [u]: { ...trailPtsFor(d, u), ...patch } } } }))
  const ids = alertIdsFor(draft, top)
  const trail = draft.trail ?? DEFAULTS.trail
  return (
    <Card size="small" title="Scanner settings" extra={(
      <Space size={8}>
        {changed && <Button size="small" onClick={() => setDraft(settings)}>Undo</Button>}
        <Button size="small" type="primary" disabled={!changed} onClick={() => onSave(draft, 'Scanner settings saved')}>Save</Button>
      </Space>
    )}>
      <Space direction="vertical" size={10} style={{ width: '100%' }}>
        <Space wrap size={16}>
          <Space size={4}><Switch size="small" checked={draft.alerts !== false} onChange={(v) => set({ alerts: v })} aria-label="Alerts" /><Text style={{ fontSize: 12 }}>Alerts (trade on each alert)</Text></Space>
          <Space size={4}><Switch size="small" checked={draft.telegram !== false} onChange={(v) => set({ telegram: v })} aria-label="Telegram" /><Text style={{ fontSize: 12 }}>Telegram</Text></Space>
        </Space>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontSize: 12 }}>Futures strategies alerted</Text>
          <div style={{ maxWidth: '100%', overflowX: 'auto' }}>
            <Segmented size="small" value={draft.pick} onChange={(v) => set({ pick: v })} aria-label="Alert on"
              options={[
                { value: 'top15', label: `Top 15${top.measured ? ' (measured)' : ''}${top.trial.length ? ` + ${top.trial.length} on trial` : ''}` },
                { value: 'oi5', label: 'Top 5 OI + flow' }, { value: 'profile5', label: 'Top 5 profile' },
                { value: 'range', label: `Range-bound (${RANGE_IDS.length})` }, { value: 'all', label: `All ${ACTIVE_STRATEGIES.length}` }, { value: 'custom', label: 'My choice' },
              ]} />
          </div>
          <Text type="secondary" style={{ fontSize: 12 }}>{ids.length} alerted on every index · any strategy applied on an index or on its live list is traded there too (spot + options ones only that way)</Text>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 10px' }}>
          {ACTIVE_STRATEGIES.map((s) => (
            <Checkbox key={s.id} checked={ids.includes(s.id)} disabled={draft.pick !== 'custom'} style={{ fontSize: 12 }}
              onChange={(e) => set({ custom: e.target.checked ? [...new Set([...(draft.custom ?? []), s.id])] : (draft.custom ?? []).filter((x) => x !== s.id), pick: 'custom' })}>
              {s.no}. {s.short}
            </Checkbox>
          ))}
        </div>
        <Space wrap size={8} aria-label="Trailing SL">
          <Space size={4}><Switch size="small" checked={trail.on !== false} onChange={(v) => setTrail({ on: v })} aria-label="Trailing SL on" /><Text style={{ fontSize: 12 }}>Trailing SL on the index trade</Text></Space>
          {trail.on !== false && (
            <>
              <Segmented size="small" value={trailUnit(draft)} onChange={(v) => setTrail({ unit: v === 'R' ? 'R' : 'pts' })} options={[{ value: 'pts', label: 'pts' }, { value: 'R', label: 'R' }]} aria-label="Trailing SL unit" />
              {trailUnit(draft) === 'pts'
                ? UNDERLYINGS.map((u) => (
                  <Space key={u} size={4}>
                    <Text style={{ fontSize: 12 }}>{u}: after +</Text>
                    <InputNumber size="small" min={1} max={5000} step={5} style={{ width: 72 }} value={trailPtsFor(draft, u).start} onChange={(v) => v != null && setTrailPts(u, { start: v })} aria-label={`${u} trail starts after`} />
                    <Text style={{ fontSize: 12 }}>follow</Text>
                    <InputNumber size="small" min={1} max={5000} step={5} style={{ width: 72 }} value={trailPtsFor(draft, u).gap} onChange={(v) => v != null && setTrailPts(u, { gap: v })} aria-label={`${u} trail distance`} />
                  </Space>
                ))
                : (
                  <Space size={4}>
                    <Text style={{ fontSize: 12 }}>after +</Text>
                    <InputNumber size="small" min={0.25} max={20} step={0.25} style={{ width: 70 }} value={trail.startR ?? DEFAULT_TRAIL.startR} onChange={(v) => v != null && setTrail({ startR: v })} aria-label="Trail starts at R" />
                    <Text style={{ fontSize: 12 }}>R, follow</Text>
                    <InputNumber size="small" min={0.25} max={20} step={0.25} style={{ width: 70 }} value={trail.gapR ?? DEFAULT_TRAIL.gapR} onChange={(v) => v != null && setTrail({ gapR: v })} aria-label="Trail distance in R" />
                    <Text style={{ fontSize: 12 }}>R behind</Text>
                  </Space>
                )}
              <Tooltip title="No fixed target and no time stop - only the trailing stop (or 15:10) ends the trade. Applies to new signals.">
                <Space size={4}><Switch size="small" checked={!!trail.runner} onChange={(v) => setTrail({ runner: v })} aria-label="Let winners run" /><Text style={{ fontSize: 12 }}>Let winners run</Text></Space>
              </Tooltip>
            </>
          )}
        </Space>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {trailFor(draft, 'NIFTY') ? 'A strategy with its own tuned trailing stop keeps its own. ' : ''}A change applies to new signals; a trailing-stop change also to the open ones, from the minute it is saved (only ever tighter).
          Lots, the option SL / target / trail and what an alert trades are each index&apos;s <Link to="/trade-settings">Trade settings</Link>.
        </Text>
      </Space>
    </Card>
  )
}
