// The Apply button of a fine-tuned setting (Trades page, Strategy tuning page): a confirm that can also put the
// strategy on that index's live list, so the server scanner places real orders for it once the index is switched to
// Live today (the server still checks every other limit - ServerLiveService).
import { useState } from 'react'
import { Button, Checkbox, Popconfirm } from 'antd'

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
