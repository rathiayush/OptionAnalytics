import { useMemo } from 'react'
import { DatePicker, Select, Space, Typography } from 'antd'
import dayjs from 'dayjs'
import { useMediaQuery } from './shared.jsx'
import { DATE_INPUT_FORMATS, isPastDay, rangePresets, withRangeEnd } from './backtestDates.js'

const { Text } = Typography

/** The days to run (the Signal backtest's and the Component check's): wider, a range picker with quick ranges; on a phone
 *  a From and a To picker of one month each and a quick-range dropdown; dates typed in several formats, past days only
 *  (backtestDates.js). */
export function DaysPicker({ range, setRange, disabled }) {
  const narrow = useMediaQuery('(max-width: 768px)')
  const today = dayjs().format('YYYY-MM-DD')
  const presets = useMemo(() => rangePresets(today), [today])
  const at = (k) => (range?.[k] && dayjs(range[k]).isValid() ? dayjs(range[k]) : null)
  const common = {
    size: 'small', allowClear: false, disabled, format: DATE_INPUT_FORMATS, className: 'oa-date-input', showNow: false,
    disabledDate: (d) => !isPastDay(d, today),
  }
  if (!narrow) {
    return (
      <DatePicker.RangePicker
        {...common} value={[at(0), at(1)]} aria-label="Days to run"
        presets={presets.map((p) => ({ label: p.label, value: [dayjs(p.from), dayjs(p.to)] }))}
        onChange={(v) => v?.[0] && v?.[1] && setRange([v[0].format('YYYY-MM-DD'), v[1].format('YYYY-MM-DD')])}
      />
    )
  }
  const pick = (side) => (d) => d && setRange(withRangeEnd(range, side, d.format('YYYY-MM-DD')))
  return (
    <Space wrap size={[8, 8]} align="center">
      <Space size={4} align="center">
        <Text type="secondary" style={{ fontSize: 12 }}>From</Text>
        <DatePicker {...common} value={at(0)} onChange={pick('from')} aria-label="From date" style={{ width: 132 }} />
      </Space>
      <Space size={4} align="center">
        <Text type="secondary" style={{ fontSize: 12 }}>To</Text>
        <DatePicker {...common} value={at(1)} onChange={pick('to')} aria-label="To date" style={{ width: 132 }} />
      </Space>
      <Select
        size="small" value={null} placeholder="Quick range" disabled={disabled} aria-label="Quick range" style={{ width: 150 }}
        options={presets.map((p) => ({ value: p.key, label: p.label }))}
        onChange={(key) => { const p = presets.find((x) => x.key === key); if (p) setRange([p.from, p.to]) }}
      />
    </Space>
  )
}
