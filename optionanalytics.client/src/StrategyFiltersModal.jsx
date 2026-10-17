// One strategy's own filters (STRATEGY_FILTERS[id]) - its rules' numbers, switches and choices - edited in a dialog,
// defaults marked. Used on the Strategies page; the scanner reads them through strategyFilters (a default is the rule as
// written and tested, so an untouched strategy behaves exactly as before).
import { useState } from 'react'
import { Button, InputNumber, Modal, Segmented, Select, Space, Switch, Typography } from 'antd'
import { STRATEGY_BY_ID, STRATEGY_FILTERS, filterGroup, strategyFilters } from './strategyEngine.js'

const { Text } = Typography

/** The filters of one strategy (STRATEGY_FILTERS[id]): a number box, a switch or a choice each, defaults marked;
 *  saved on OK. They apply to the setups found from then on - live, the replay clock and Scan day. */
const INDICES = ['NIFTY', 'BANKNIFTY', 'SENSEX']

/** `values` - the all-index filters; `byIndex` - { NIFTY: {...}, ... } the filters set for one index only (they win there).
 *  The dialog edits either: "All indices", or one index - saved for that index alone (onSave(scope, filters, clear)). */
export function StrategyFiltersModal({ id, values, byIndex = {}, onClose, onSave }) {
  const meta = STRATEGY_BY_ID[id]
  const defs = STRATEGY_FILTERS[id] ?? []
  const [scope, setScope] = useState('all')
  const own = (u) => byIndex?.[u]?.[id] ?? null
  const valuesOf = (sc) => strategyFilters(id, sc === 'all' ? values : { ...values, ...(own(sc) ?? {}) })
  const [draft, setDraft] = useState(() => valuesOf('all'))
  const set = (key, v) => setDraft((d) => ({ ...d, [key]: v }))
  const pick = (sc) => { setScope(sc); setDraft(valuesOf(sc)) }
  const defaults = strategyFilters(id, {})
  return (
    <Modal open title={`Filters · #${meta.no} ${meta.name}`} onCancel={onClose} onOk={() => onSave(scope, strategyFilters(id, draft), false)} okText={scope === 'all' ? 'Save for all indices' : `Save for ${scope}`}
      footer={(_, { OkBtn, CancelBtn }) => (
        <Space>
          {scope !== 'all' && own(scope) && <Button size="small" danger onClick={() => onSave(scope, null, true)}>{`Back to the all-index filters`}</Button>}
          <Button size="small" onClick={() => setDraft(defaults)} disabled={JSON.stringify(draft) === JSON.stringify(defaults)}>Reset to defaults</Button>
          <CancelBtn /><OkBtn />
        </Space>
      )}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <Segmented value={scope} onChange={pick} aria-label="Filters for"
          options={[{ value: 'all', label: 'All indices' }, ...INDICES.map((u) => ({ value: u, label: own(u) ? `${u} ●` : u }))]} />
        <Text type="secondary" style={{ fontSize: 11 }}>
          {scope === 'all' ? 'Used on every index that has none of its own.' : own(scope) ? `${scope} has its own filters (●) - they win over the all-index ones.` : `Save to give ${scope} its own: the all-index filters are the start.`}
        </Text>
        {defs.map((f, i) => (
          <div key={f.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, ...(i === 0 || filterGroup(defs[i - 1]) !== filterGroup(f) ? { borderTop: i ? '1px solid rgba(128,128,128,.25)' : 'none', paddingTop: i ? 8 : 0, flexWrap: 'wrap' } : {}) }}>
            {(i === 0 || filterGroup(defs[i - 1]) !== filterGroup(f)) && <Text strong style={{ fontSize: 12, flexBasis: '100%' }}>{filterGroup(f)}</Text>}
            <Text style={{ fontSize: 12 }}>
              {f.label}
              {draft[f.key] !== f.default && <Text type="secondary" style={{ fontSize: 11 }}>{` (default ${f.type === 'switch' ? (f.default ? 'on' : 'off') : f.type === 'select' ? f.options.find((o) => o.value === f.default)?.label : f.default})`}</Text>}
            </Text>
            {f.type === 'switch'
              ? <Switch size="small" checked={draft[f.key]} onChange={(v) => set(f.key, v)} aria-label={f.label} />
              : f.type === 'select'
                ? <Select size="small" value={draft[f.key]} onChange={(v) => set(f.key, v)} options={f.options} style={{ width: 190, flex: 'none' }} aria-label={f.label} />
                : <InputNumber size="small" min={f.min} max={f.max} step={f.step} value={draft[f.key]} onChange={(v) => v != null && set(f.key, v)} style={{ width: 86, flex: 'none' }} aria-label={f.label} />}
          </div>
        ))}
        <Text type="secondary" style={{ fontSize: 11 }}>
          The defaults are the strategy&apos;s tested rules. A change applies to the signals the scanner finds from now on (the server
          scanner, every index where no fine-tuned setting is applied); measure it first in the Strategy lab or with a tuning run.
          The option&apos;s buy / sell and strike here are used where the index&apos;s &quot;On an alert&quot; (Trade settings) is Per strategy -
          its Sell option / Buy option wins for every strategy; an option SL / target % here always applies. An Option: exit of its
          own is taken exactly - none of the index&apos;s option SL / target points or its option trailing stop are added to it.
        </Text>
      </Space>
    </Modal>
  )
}
