// The Apply button of a fine-tuned setting (Trades page, Strategy tuning page): a confirm that can also put the
// strategy on that index's live list, so the server scanner places real orders for it once the index is switched to
// Live today (the server still checks every other limit - ServerLiveService).
import { useEffect, useState } from 'react'
import { Button, Card, Checkbox, Popconfirm, Space, Tag, Tooltip, Typography, message } from 'antd'
import { STRATEGY_BY_ID } from './strategyEngine.js'
import { DEFAULT_VARIANT, variantText } from './strategyTuning.js'
import { saveIndexFilters } from './scannerSettings.js'

const { Text } = Typography

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
export function AppliedSettingsCard({ isAdmin, reloadKey = 0 }) {
  const [cfg, setCfg] = useState(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!isAdmin) return
    fetch('/api/scanner-runner/config').then((r) => (r.ok ? r.json() : null)).then((c) => setCfg(c ?? {})).catch(() => setCfg({}))
  }, [isAdmin, reloadKey, tick])
  if (!isAdmin) return null
  return <AppliedSettings cfg={cfg} isAdmin={isAdmin} onChanged={() => setTick((t) => t + 1)} />
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
