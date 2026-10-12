// The Apply button of a fine-tuned setting (Trades page, Strategy tuning page): a confirm that can also put the
// strategy on that index's live list, so the server scanner places real orders for it once the index is switched to
// Live today (the server still checks every other limit - ServerLiveService).
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { runLink, runOf } from './appliedRun.js'
import { Button, Card, Checkbox, Col, InputNumber, Popconfirm, Popover, Row, Space, Table, Tag, Tooltip, Typography, message } from 'antd'
import { STRATEGY_BY_ID } from './strategyEngine.js'
import { DEFAULT_VARIANT, settingParams, variantText } from './strategyTuning.js'
import { saveIndexFilters, saveIndexLots } from './scannerSettings.js'
import { ServerLiveSwitch, ServerLiveTrades, useServerLive } from './ServerLive.jsx'

const { Text } = Typography

/** Every parameter of a tuned setting in a small table - the ones the tuning changed from the default in blue.
 *  `from`: 'row' (a tuning-history settings row), 'params' (as tuned) or 'filters' (applied to a strategy). */
export function SettingParamsTable({ source, from = 'params' }) {
  const rows = settingParams(source, from)
  return (
    <Table size="small" pagination={false} rowKey="key" dataSource={rows} style={{ maxWidth: 520 }}
      columns={[
        { title: 'Parameter', dataIndex: 'label', render: (v) => <span style={{ fontSize: 12 }}>{v}</span> },
        { title: 'Value', dataIndex: 'value', width: 170, render: (v, r) => <span style={{ fontSize: 12, color: r.changed ? '#4096ff' : undefined, fontWeight: r.changed ? 600 : 400 }}>{v}</span> },
      ]} />
  )
}

/** A "Parameters" link that opens every parameter of the setting. */
export function ParamsPopover({ source, from = 'params', label = 'Parameters', action = null }) {
  return (
    <Popover trigger="click" placement="left" title="Every parameter (blue = changed by the tuning; the rest are the defaults)"
      content={<div style={{ maxHeight: 460, overflow: 'auto' }}><SettingParamsTable source={source} from={from} />{action && <div style={{ marginTop: 8 }}>{action}</div>}</div>}>
      <Button size="small" type="link" style={{ padding: '0 4px', height: 'auto' }}>{label}</Button>
    </Popover>
  )
}

/**
 * Trading strategies LIVE - what has to be in place, per index, and what is: (1) a fine-tuned setting applied to the
 * strategy (else it trades as written), (2) the strategy on the index's live list (proven, or added by hand), (3) the
 * index's Trade settings - lots, the option SL / target, and an alert trading "per strategy" so each strategy's tuned
 * buy / sell and strike are used, (4) the index switched to Live today (back to paper every morning). `cfg` = GET
 * /api/scanner-runner/config.
 */
/** An index's "what an alert trades" to per strategy (Trade settings), keeping every other setting of it. */
async function setPerStrategy(u, onChanged) {
  try {
    const all = await fetch('/api/trade-settings').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    const cur = (all?.settings ?? []).find((x) => x.underlying === u)
    if (!cur) throw new Error(`no Trade settings for ${u}`)
    const res = await fetch(`/api/trade-settings/${u}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cur, autoTrade: 'strategy' }) })
    const json = await res.json().catch(() => null)
    if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`)
    message.success(`${u}: an alert now trades per strategy - each strategy's tuned buy / sell and strike are used`)
    onChanged?.()
  } catch (err) { message.error(err.message) }
}

export function LiveSetup({ cfg, serverLive = null, isAdmin = false, onChanged = null }) {
  if (!cfg) return null
  const indices = ['NIFTY', 'BANKNIFTY', 'SENSEX']
  const name = (id) => `#${STRATEGY_BY_ID[id]?.no ?? '?'} ${STRATEGY_BY_ID[id]?.name ?? id}`
  const ok = (good, text) => <div style={{ fontSize: 12 }}>{good ? <Tag color="success">✓</Tag> : <Tag color="warning">!</Tag>}{text}</div>
  return (
    <Card size="small" title={<Space size={8} wrap><span>Live setup</span><Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal' }}>how strategies trade live, per index - and what is in place now</Text></Space>}
      styles={{ body: { padding: 10 } }}>
      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 8 }}>
        A strategy trades live on an index when: <b>1.</b> its best fine-tuned setting is applied there (Apply - else it trades as written) · <b>2.</b> it is on the index&apos;s live list (proven after costs - by its applied
        fine-tuned setting&apos;s unseen record too - or added by hand: tick &quot;Also put it on the live list&quot; when applying, or Trade settings → Live list) · <b>3.</b> the index&apos;s <a href="/trade-settings">Trade settings</a> are
        set: lots, option SL / target, and &quot;what an alert trades&quot; = <i>per strategy</i>, so each strategy&apos;s tuned buy / sell and strike are used · <b>4.</b> the index is switched to <b>Live today</b> (Trade settings or the Order Flow page; back to paper every morning).
        The server then places each alert as a Dhan super order, and exits it at the option&apos;s SL / target, the trailing SL, the time stop and the index SL / target - with Telegram.
      </Text>
      <Row gutter={[12, 12]}>
        {indices.map((u) => {
          const applied = Object.keys(cfg.filtersByIndex?.[u] ?? {})
          const list = cfg.liveList?.[u] ?? []
          const trade = cfg.trade?.[u] ?? {}
          const levels = cfg.levels?.[u] ?? {}
          const st = serverLive?.list?.find((x) => x.underlying === u)
          const live = st ? !!st.live : !!cfg.live?.[u]
          const tunedLegs = applied.filter((id) => cfg.filtersByIndex[u][id]?.tradeOptLeg)
          const perStrategy = trade.autoTrade === 'strategy'
          const tradesLive = list.map((id) => ({ id, tuned: applied.includes(id) }))
          const paperOnly = applied.filter((id) => !list.includes(id))
          return (
            <Col key={u} xs={24} md={8}>
              <Card size="small" type="inner" title={<Space size={6}><b>{u}</b>{live ? <Tag color="red">LIVE today</Tag> : <Tag>paper</Tag>}</Space>} styles={{ body: { padding: 8 } }}>
                {ok(applied.length > 0, `${applied.length} strateg${applied.length === 1 ? 'y' : 'ies'} with a fine-tuned setting applied`)}
                {ok(list.length > 0, `${list.length} on the live list`)}
                {ok(trade.lots > 0 && levels.sl > 0 && levels.target > 0, `${trade.lots ?? '-'} lot(s) · option SL ${levels.sl ?? '-'} / target ${levels.target ?? '-'} pts${levels.trailGap > 0 ? ` · trail ${levels.trailGap} pts` : ''}`)}
                {ok(perStrategy || !tunedLegs.length, `an alert trades: ${trade.autoTrade === 'strategy' ? 'per strategy' : trade.autoTrade ?? '-'}${!perStrategy && tunedLegs.length ? ` - ${tunedLegs.length} tuned buy / sell + strike overruled` : ''}`)}
                {!perStrategy && isAdmin && (
                  <Popconfirm title={`${u}: an alert trades per strategy?`} okText="Set per strategy" onConfirm={() => setPerStrategy(u, onChanged)}
                    description={<div style={{ maxWidth: 340 }}>Each strategy then buys or sells - and picks the strike and option SL / target - as its applied fine-tuned setting says (sell ATM when it has none), paper and live. Trade settings &rarr; &quot;What an alert trades&quot;.</div>}>
                    <Button size="small" type="link" style={{ padding: 0, height: 'auto', marginLeft: 26 }}>Set to per strategy</Button>
                  </Popconfirm>
                )}
                {ok(live, live ? 'switched to Live today' : 'on paper - switch to Live today to trade for real')}
                {st && serverLive?.set && (
                  <div style={{ margin: '4px 0' }}>
                    <ServerLiveSwitch underlying={u} st={st} isAdmin={isAdmin} set={serverLive.set} compact />
                    <ServerLiveTrades st={st} />
                  </div>
                )}
                <div style={{ fontSize: 12, marginTop: 6 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>Trades live{live ? '' : ' once Live'}:</Text>{' '}
                  {tradesLive.length ? tradesLive.map((x) => <Tag key={x.id} color={x.tuned ? 'blue' : 'default'} style={{ marginBottom: 2 }}>{name(x.id)}{x.tuned ? ' · fine-tuned' : ' · as written'} · {cfg.filtersByIndex?.[u]?.[x.id]?._lots ?? trade.lots ?? '-'} lot(s)</Tag>) : <Text type="secondary" style={{ fontSize: 12 }}>none</Text>}
                </div>
                {paperOnly.length > 0 && (
                  <div style={{ fontSize: 12, marginTop: 4 }}>
                    <Text type="secondary" style={{ fontSize: 12 }}>Fine-tuned but paper only (not on the live list):</Text>{' '}
                    {paperOnly.map((id) => <Tag key={id} style={{ marginBottom: 2 }}>{name(id)}</Tag>)}
                  </div>
                )}
              </Card>
            </Col>
          )
        })}
      </Row>
    </Card>
  )
}

/** A strategy's applied filters in one line: the trade settings and, when tuned, how it is taken in options. */
export function appliedText(f) {
  const parts = [variantText({ ...DEFAULT_VARIANT, ...(f ?? {}) })]
  if (f?.tradeOptLeg === 'buy' || f?.tradeOptLeg === 'sell') {
    const m = Number(f.tradeOptMoneyness) || 0
    parts.push(`${f.tradeOptLeg.toUpperCase()} ${m === 0 ? 'ATM' : `${Math.abs(m)} ${m > 0 ? 'ITM' : 'OTM'}`}`)
  }
  if (f?.tradeOptSlPct > 0) parts.push(`option SL ${f.tradeOptSlPct}% of the premium`)
  if (f?.tradeOptTargetPct > 0) parts.push(`option target ${f.tradeOptTargetPct}%`)
  return parts.join(' · ')
}

/**
 * What the live scanner runs with NOW, per index: every strategy with a fine-tuned setting applied for that index
 * (config.filtersByIndex - the page and the server scanner both read it). ✕ takes it off (back to the strategy's
 * all-index filters on that index). `cfg` = GET /api/scanner-runner/config.
 */
export function AppliedSettings({ cfg, isAdmin, onChanged, extra = null }) {
  const rec = useServerRecord(cfg)
  const by = cfg?.filtersByIndex ?? {}
  const rows = Object.entries(by).flatMap(([u, m]) => Object.entries(m ?? {}).map(([id, f]) => ({ u, id, f })))
    .sort((a, b) => a.u.localeCompare(b.u) || (Number(STRATEGY_BY_ID[a.id]?.no) || 0) - (Number(STRATEGY_BY_ID[b.id]?.no) || 0))
  const remove = async (r) => {
    try {
      await saveIndexFilters(r.u, r.id, null)
      message.success(`#${STRATEGY_BY_ID[r.id]?.no ?? ''} ${STRATEGY_BY_ID[r.id]?.name ?? r.id}: back to its all-index filters on ${r.u}`)
      onChanged?.()
    } catch (err) { message.error(err.message) }
  }
  return (
    <Card size="small" title={<Space size={8} wrap><span>Applied now</span><Text type="secondary" style={{ fontSize: 12, fontWeight: 'normal' }}>the tuned settings the live scanner runs per index (this page and the server scanner)</Text></Space>} extra={extra}
      styles={{ body: { padding: 10 } }}>
      {!cfg ? <Text type="secondary" style={{ fontSize: 12 }}>loading…</Text>
        : !rows.length ? (
          <Text type="secondary" style={{ fontSize: 12 }}>
            Nothing applied yet. To apply: Trades → Strategy performance → the <b>Apply</b> button in a strategy&apos;s &quot;Best setting&quot; column (or open it for every setting),
            &quot;Apply best to every strategy&quot; for a whole index at once, or <b>Apply to the scanner</b> on a strategy in a tuning result.
          </Text>
        ) : (
          <Space direction="vertical" size={4} style={{ width: '100%' }}>
            {rows.map((r) => (
              <div key={`${r.u}-${r.id}`} style={{ fontSize: 12 }}>
                <Tag color="green">{r.u}</Tag><b>#{STRATEGY_BY_ID[r.id]?.no} {STRATEGY_BY_ID[r.id]?.name ?? r.id}</b>: {appliedText(r.f)}
                {' · '}<LotsCell u={r.u} id={r.id} lots={r.f?._lots ?? null} indexLots={cfg?.trade?.[r.u]?.lots ?? null} isAdmin={isAdmin} onChanged={onChanged} />
                <ParamsPopover source={r.f} from="filters" />
                {isAdmin && (
                  <Popconfirm title={`Take this setting off ${r.u}?`} description="The strategy goes back to its all-index filters on this index." okText="Take off" onConfirm={() => remove(r)}>
                    <Tooltip title="Take it off (back to the all-index filters on this index)"><Button size="small" type="link" danger style={{ padding: '0 4px', height: 'auto' }}>✕</Button></Tooltip>
                  </Popconfirm>
                )}
                <div style={{ marginLeft: 8 }}><RunLine rec={rec} u={r.u} id={r.id} appliedAt={r.f?._appliedAt} /></div>
              </div>
            ))}
            <Text type="secondary" style={{ fontSize: 11 }}>Paper at once; live only when that index is switched to Live today and the strategy is on its live list. Each one&apos;s run is the server scanner&apos;s record (it runs them all day, page open or not) - every signal and trade: <Link to="/trades?tab=record&applied=1&kind=trades">Trades → Scanner record → applied only</Link>.</Text>
          </Space>
        )}
    </Card>
  )
}

// ---- How an applied strategy has run: the server scanner's own record ------------------------------------------------
// The server scanner runs every applied strategy on its index all day (paper, and live when the index is Live today) and
// keeps each signal and option trade (server-signals.csv / server-trades.csv) - read here once a minute at most, shared
// by every card on the page.
let recordCache = null
let recordLoading = null
const loadServerRecord = () => {
  if (recordCache && Date.now() - recordCache.at < 60_000) return Promise.resolve(recordCache.data)
  recordLoading ??= Promise.all(['server-signals', 'server-trades'].map((f) => fetch(`/api/scanner-log/rows/${f}`).then((r) => (r.ok ? r.json() : []))))
    .then(([signals, trades]) => {
      recordCache = { at: Date.now(), data: { signals: Array.isArray(signals) ? signals : [], trades: Array.isArray(trades) ? trades : [] } }
      return recordCache.data
    })
    .finally(() => { recordLoading = null })
  return recordLoading
}
function useServerRecord(reloadKey = 0) {
  const [rec, setRec] = useState(recordCache?.data ?? null)
  useEffect(() => {
    let stop = false
    loadServerRecord().then((d) => { if (!stop) setRec(d) }).catch(() => {})
    return () => { stop = true }
  }, [reloadKey])
  return rec
}
const fmtWhen = (ms) => new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false })

function RunLine({ rec, u, id, appliedAt }) {
  const since = Number.isFinite(appliedAt) ? appliedAt : null
  if (!rec) return <Text type="secondary" style={{ fontSize: 11 }}>run: loading…</Text>
  const r = runOf(rec, u, id, since)
  const rupee = (v) => `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`
  return (
    <span style={{ fontSize: 11 }}>
      <Tooltip title={since ? `What the server scanner did with it on ${u} since it was applied (${fmtWhen(since)}): every signal, and every paper / live option trade it took` : `Applied before the time of applying was kept: every day of the server scanner's record for it on ${u}`}>
        <Text type="secondary" style={{ fontSize: 11 }}>Run {since ? `since ${fmtWhen(since)}` : '(all days)'}:</Text>
      </Tooltip>{' '}
      {r.signals || r.trades
        ? <>{r.signals} signal(s) · {r.trades} trade(s){r.live ? <> (<b style={{ color: '#ff7875' }}>{r.live} live</b>)</> : ''}{r.open ? ` · ${r.open} open` : ''}
          {r.closed ? <> · {r.wins}/{r.closed} won · net <b style={{ color: r.net >= 0 ? '#52c41a' : '#ff4d4f' }}>{rupee(r.net)}</b></> : ''}
          {r.lastMs ? <Text type="secondary" style={{ fontSize: 11 }}> · last {fmtWhen(r.lastMs)}</Text> : null}</>
        : <Text type="secondary" style={{ fontSize: 11 }}>nothing yet - it trades when its rules fire on {u}</Text>}
      {' · '}<Link to={runLink(u, id, since)}>See the run →</Link>
    </span>
  )
}

/** A strategy's lot size on one index - its own (bold) or the index's (Trade settings) - changeable in place (admins):
 *  every paper and live trade of it there takes that many lots. Empty = back to the index's lots. */
function LotsCell({ u, id, lots, indexLots, isAdmin, onChanged }) {
  const [value, setValue] = useState(lots)
  const [saving, setSaving] = useState(false)
  useEffect(() => { setValue(lots) }, [lots])
  const text = lots ? <b>{lots} lot(s)</b> : <span>{indexLots ?? '-'} lot(s) <Text type="secondary" style={{ fontSize: 11 }}>(index)</Text></span>
  if (!isAdmin) return text
  const changed = (value ?? null) !== (lots ?? null)
  const save = async () => {
    setSaving(true)
    try {
      await saveIndexLots(u, id, value ?? null)
      message.success(`#${STRATEGY_BY_ID[id]?.no ?? ''} ${STRATEGY_BY_ID[id]?.name ?? id} on ${u}: ${value ? `${value} lot(s)` : `the index's lots (${indexLots ?? '-'})`}`)
      onChanged?.()
    } catch (err) { message.error(err.message) } finally { setSaving(false) }
  }
  return (
    <Space size={4} style={{ display: 'inline-flex' }}>
      <InputNumber size="small" min={1} max={500} precision={0} value={value} onChange={(v) => setValue(v ?? null)} style={{ width: 80 }}
        placeholder={`${indexLots ?? ''} (index)`} aria-label={`Lots of ${id} on ${u}`} />
      <Text style={{ fontSize: 12 }}>lot(s)</Text>
      {changed && <Button size="small" type="link" loading={saving} onClick={save} style={{ padding: 0, height: 'auto' }}>Save</Button>}
    </Space>
  )
}

/** The same, loading the scanner config itself (the Strategy tuning page); `reloadKey` changes after an apply. */
export function AppliedSettingsCard({ isAdmin, reloadKey = 0, withSetup = false }) {
  const [cfg, setCfg] = useState(null)
  const [tick, setTick] = useState(0)
  const serverLive = useServerLive()
  useEffect(() => {
    if (!isAdmin) return
    fetch('/api/scanner-runner/config').then((r) => (r.ok ? r.json() : null)).then((c) => setCfg(c ?? {})).catch(() => setCfg({}))
  }, [isAdmin, reloadKey, tick])
  if (!isAdmin) return null
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      {withSetup && <LiveSetup cfg={cfg} serverLive={serverLive} isAdmin={isAdmin} onChanged={() => setTick((t) => t + 1)} />}
      <AppliedSettings cfg={cfg} isAdmin={isAdmin} onChanged={() => setTick((t) => t + 1)} />
    </Space>
  )
}

/**
 * Apply with a LOT SIZE: this strategy's own lots on this index (`lots` = the current one, if any; empty = the index's
 * lots from Trade settings, `indexLots`) - its paper and live trades there take that many lots. onApply(live, lots|null).
 */
export function ApplyTunedButton({ index, title, description, label, primary = false, disabled = false, size = 'small', onApply, lots = null, indexLots = null, canGoLive = false, isLiveToday = false }) {
  const [live, setLive] = useState(false)
  const [ownLots, setOwnLots] = useState(lots)
  const [goLive, setGoLive] = useState(false)
  return (
    <Popconfirm title={title} okText="Apply" disabled={disabled} onConfirm={() => onApply(live || goLive, ownLots, goLive)} onOpenChange={(open) => { if (open) { setOwnLots(lots); setGoLive(false) } }}
      description={(
        <div style={{ maxWidth: 380 }}>
          {description}
          {index && (
            <div style={{ marginTop: 8 }}>
              <Space size={6} wrap>
                <Text style={{ fontSize: 12 }}>Lots on {index}</Text>
                <InputNumber size="small" min={1} max={500} precision={0} value={ownLots} onChange={(v) => setOwnLots(v ?? null)} style={{ width: 90 }}
                  placeholder={indexLots ? `${indexLots} (index)` : 'index lots'} aria-label={`Lots on ${index}`} />
                <Text type="secondary" style={{ fontSize: 11 }}>empty = the index&apos;s lots (Trade settings)</Text>
              </Space>
            </div>
          )}
          {index && (
            <div style={{ marginTop: 8 }}>
              <Checkbox checked={live || goLive} disabled={goLive} onChange={(e) => setLive(e.target.checked)}>
                Also put it on {index}&apos;s live list - real orders only once {index} is switched to Live today
              </Checkbox>
            </div>
          )}
          {index && canGoLive && (
            <div style={{ marginTop: 4 }}>
              {isLiveToday
                ? <Text type="danger" style={{ fontSize: 12 }}>{index} is LIVE today - it trades for real from its next alert (once on the live list).</Text>
                : <Checkbox checked={goLive} onChange={(e) => setGoLive(e.target.checked)}><Text type="danger">and trade it LIVE today</Text> - switches {index} to Live today (you confirm it next; back to paper tomorrow)</Checkbox>}
            </div>
          )}
        </div>
      )}>
      <Button size={size} type={primary ? 'primary' : 'default'} disabled={disabled}>{label}</Button>
    </Popconfirm>
  )
}
