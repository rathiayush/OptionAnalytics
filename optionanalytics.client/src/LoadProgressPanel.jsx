import { useEffect, useRef } from 'react'
import { Progress, Space, Tag, Typography } from 'antd'

const { Text } = Typography

const LEVEL_COLOR = { ok: '#3ddc84', warn: '#faad14', error: '#ff5c5c', info: undefined }

/** The load's progress: a bar (series done of the total), the counts (Dhan calls, from disk, rate limits, retries,
 *  failures) and the running log - every Dhan call going out, coming back, rate-limited, retried or failing. */
export function LoadProgressPanel({ progress, height = 220 }) {
  const logRef = useRef(null)
  const entries = progress?.entries ?? []
  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [entries.length])

  if (!progress) return <Text type="secondary" style={{ fontSize: 12 }}>Waiting for the server to start…</Text>
  const total = progress.total || 0
  const percent = total > 0 ? Math.min(100, Math.round((progress.done / total) * 100)) : 0
  const status = progress.error ? 'exception' : progress.finished ? 'success' : 'active'
  return (
    <div style={{ width: '100%' }}>
      <Progress percent={percent} size="small" status={status} format={() => `${progress.done}/${total}`} />
      <Space size={[4, 4]} wrap style={{ marginBottom: 6 }}>
        <Text style={{ fontSize: 12 }}>{progress.finished ? (progress.error ? 'Failed' : 'Done') : progress.stage} · {progress.elapsedSeconds}s</Text>
        <Tag color="blue">Dhan calls {progress.dhanCalls}</Tag>
        <Tag color="green">from disk {progress.fromDisk}</Tag>
        {/* Days Dhan sent now, written to the server's disk cache - the next load of them reads the disk. */}
        {progress.savedToDisk > 0 && <Tag color="cyan">saved to disk {progress.savedToDisk}</Tag>}
        {progress.diskErrors > 0 && <Tag color="red">disk write failed {progress.diskErrors}</Tag>}
        {progress.rateLimited > 0 && <Tag color="orange">rate-limited {progress.rateLimited}</Tag>}
        {progress.retries > 0 && <Tag color="gold">retries {progress.retries}</Tag>}
        {progress.failed > 0 && <Tag color="red">failed {progress.failed}</Tag>}
      </Space>
      <div
        ref={logRef}
        style={{
          maxHeight: height, overflowY: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11,
          lineHeight: 1.45, background: '#00000040', borderRadius: 4, padding: '4px 8px', wordBreak: 'break-word',
        }}
      >
        {entries.length === 0 && <div style={{ opacity: 0.6 }}>No steps yet…</div>}
        {entries.map((e, i) => (
          <div key={i} style={{ color: LEVEL_COLOR[e.level] }}>
            <span style={{ opacity: 0.55 }}>[{Number(e.at).toFixed(1)}s]</span> {e.text}
          </div>
        ))}
      </div>
    </div>
  )
}
