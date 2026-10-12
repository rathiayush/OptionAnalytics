// One strategy's own filters (STRATEGY_FILTERS[id]) - its rules' numbers, switches and choices - edited in a dialog,
// defaults marked. Used on the Strategies page; the scanner reads them through strategyFilters (a default is the rule as
// written and tested, so an untouched strategy behaves exactly as before).
import { useState } from 'react'
import { Button, InputNumber, Modal, Select, Space, Switch, Typography } from 'antd'
import { STRATEGY_BY_ID, STRATEGY_FILTERS, strategyFilters } from './strategyEngine.js'

const { Text } = Typography

/** The filters of one strategy (STRATEGY_FILTERS[id]): a number box, a switch or a choice each, defaults marked;
 *  saved on OK. They apply to the setups found from then on - live, the replay clock and Scan day. */
export function StrategyFiltersModal({ id, values, onClose, onSave }) {
  const meta = STRATEGY_BY_ID[id]
  const defs = STRATEGY_FILTERS[id] ?? []
  const [draft, setDraft] = useState(() => strategyFilters(id, values))
  const set = (key, v) => setDraft((d) => ({ ...d, [key]: v }))
  const defaults = strategyFilters(id, {})
  return (
    <Modal open title={`Filters · #${meta.no} ${meta.name}`} onCancel={onClose} onOk={() => onSave(strategyFilters(id, draft))} okText="Save"
      footer={(_, { OkBtn, CancelBtn }) => (
        <Space>
          <Button size="small" onClick={() => setDraft(defaults)} disabled={JSON.stringify(draft) === JSON.stringify(defaults)}>Reset to defaults</Button>
          <CancelBtn /><OkBtn />
        </Space>
      )}>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        {defs.map((f) => (
          <div key={f.key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
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
        </Text>
      </Space>
    </Modal>
  )
}
