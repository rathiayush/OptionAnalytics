// The Apply button of a fine-tuned setting (Trades page, Strategy tuning page): a confirm that can also put the
// strategy on that index's live list, so the server scanner places real orders for it once the index is switched to
// Live today (the server still checks every other limit - ServerLiveService).
import { useEffect, useState } from 'react'
import { Button, Card, Checkbox, Col, Popconfirm, Popover, Row, Space, Table, Tag, Tooltip, Typography, message } from 'antd'
import { STRATEGY_BY_ID } from './strategyEngine.js'
import { DEFAULT_VARIANT, settingParams, variantText } from './strategyTuning.js'
import { saveIndexFilters } from './scannerSettings.js'

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
export function LiveSetup({ cfg }) {
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
          const live = !!cfg.live?.[u]
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
                {ok(perStrategy || !tunedLegs.length, `an alert trades: ${trade.autoTrade === 'strategy' ? 'per strategy' : trade.autoTrade ?? '-'}${!perStrategy && tunedLegs.length ? ` - ${tunedLegs.length} tuned buy / sell + strike overruled: set it to "per strategy"` : ''}`)}
                {ok(live, live ? 'switched to Live today' : 'on paper - switch to Live today to trade for real')}
                <div style={{ fontSize: 12, marginTop: 6 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>Trades live{live ? '' : ' once Live'}:</Text>{' '}
                  {tradesLive.length ? tradesLive.map((x) => <Tag key={x.id} color={x.tuned ? 'blue' : 'default'} style={{ marginBottom: 2 }}>{name(x.id)}{x.tuned ? ' · fine-tuned' : ' · as written'}</Tag>) : <Text type="secondary" style={{ fontSize: 12 }}>none</Text>}
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
                <ParamsPopover source={r.f} from="filters" />
                {isAdmin && (
                  <Popconfirm title={`Take this setting off ${r.u}?`} description="The strategy goes back to its all-index filters on this index." okText="Take off" onConfirm={() => remove(r)}>
                    <Tooltip title="Take it off (back to the all-index filters on this index)"><Button size="small" type="link" danger style={{ padding: '0 4px', height: 'auto' }}>✕</Button></Tooltip>
                  </Popconfirm>
                )}
              </div>
            ))}
            <Text type="secondary" style={{ fontSize: 11 }}>Paper at once; live only when that index is switched to Live today and the strategy is on its live list.</Text>
          </Space>
        )}
    </Card>
  )
}

/** The same, loading the scanner config itself (the Strategy tuning page); `reloadKey` changes after an apply. */
export function AppliedSettingsCard({ isAdmin, reloadKey = 0, withSetup = false }) {
  const [cfg, setCfg] = useState(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!isAdmin) return
    fetch('/api/scanner-runner/config').then((r) => (r.ok ? r.json() : null)).then((c) => setCfg(c ?? {})).catch(() => setCfg({}))
  }, [isAdmin, reloadKey, tick])
  if (!isAdmin) return null
  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      {withSetup && <LiveSetup cfg={cfg} />}
      <AppliedSettings cfg={cfg} isAdmin={isAdmin} onChanged={() => setTick((t) => t + 1)} />
    </Space>
  )
}

export function ApplyTunedButton({ index, title, description, label, primary = false, disabled = false, size = 'small', onApply }) {
  const [live, setLive] = useState(false)
  return (
    <Popconfirm title={title} okText="Apply" disabled={disabled} onConfirm={() => onApply(live)}
      description={(
        <div style={{ maxWidth: 380 }}>
          {description}
          {index && (
            <div style={{ marginTop: 8 }}>
              <Checkbox checked={live} onChange={(e) => setLive(e.target.checked)}>
                Also put it on {index}&apos;s live list - real orders only once {index} is switched to Live today
              </Checkbox>
            </div>
          )}
        </div>
      )}>
      <Button size={size} type={primary ? 'primary' : 'default'} disabled={disabled}>{label}</Button>
    </Popconfirm>
  )
}
