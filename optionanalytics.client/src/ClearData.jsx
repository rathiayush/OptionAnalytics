import { useState } from 'react'
import { Alert, Button, Checkbox, Modal, Space, Typography, message } from 'antd'

const { Text } = Typography

/** Admin: clear the tuning results and history, the days the tuning jobs fetched, and / or the scanner's record of
 *  signals and option trades (POST /api/strategy-tuning/clear). Nothing is removed until it is ticked and confirmed. */
export default function ClearData({ onCleared, size = 'small' }) {
  const [open, setOpen] = useState(false)
  const [what, setWhat] = useState({ tuning: true, cache: false, scannerRecord: false })
  const [busy, setBusy] = useState(false)
  const any = what.tuning || what.cache || what.scannerRecord
  const clear = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/strategy-tuning/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(what) })
      const body = await res.json().catch(() => null)
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`)
      message.success('Cleared')
      setOpen(false)
      onCleared?.(what)
    } catch (err) {
      message.error(err.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button size={size} danger onClick={() => setOpen(true)}>Clear data…</Button>
      <Modal title="Clear data" open={open} onCancel={() => setOpen(false)} okText="Clear" okButtonProps={{ danger: true, disabled: !any, loading: busy }} onOk={clear}>
        <Space direction="vertical" size={8}>
          <Checkbox checked={what.tuning} onChange={(e) => setWhat((w) => ({ ...w, tuning: e.target.checked }))}>
            Tuning results and history <Text type="secondary" style={{ fontSize: 12 }}>(every run's trades and settings - the Backtest and Strategy performance views start empty)</Text>
          </Checkbox>
          <Checkbox checked={what.scannerRecord} onChange={(e) => setWhat((w) => ({ ...w, scannerRecord: e.target.checked }))}>
            Scanner record <Text type="secondary" style={{ fontSize: 12 }}>(the signals and live / paper option trades of the page and the server scanner)</Text>
          </Checkbox>
          <Checkbox checked={what.cache} onChange={(e) => setWhat((w) => ({ ...w, cache: e.target.checked }))}>
            Days the tuning jobs fetched <Text type="secondary" style={{ fontSize: 12 }}>(fetching them again costs Dhan calls - usually keep this)</Text>
          </Checkbox>
          <Alert type="warning" showIcon message="This cannot be undone. The settings already applied to the scanner and the tuning schedule are kept." />
        </Space>
      </Modal>
    </>
  )
}
