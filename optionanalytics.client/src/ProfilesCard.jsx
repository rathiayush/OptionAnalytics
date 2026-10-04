import { Card, Empty, Space, Tag, Tooltip, Typography } from 'antd'
import { UP_COLOR, DOWN_COLOR, AXIS_COLOR } from './shared.jsx'

const { Text } = Typography
const fmt = (v) => (v == null ? '-' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 }))
const IB_LETTERS = new Set(['A', 'B'])

// Volume profile of the PREVIOUS session (POC, value area, high / low volume nodes) and the market
// (TPO) profile: the previous session's TPO value area and POC, and today's developing TPO profile
// with its initial balance (A + B, the first hour). Each letter is a 30-minute period that traded at
// that price.
export function ProfilesCard({ prevDate, prevVp, prevTpo, todayTpo, lastPrice, loading, estimatedPrev }) {
  const rows = todayTpo?.rows ? [...todayTpo.rows].reverse() : []
  const near = (row, level) => level != null && Math.abs(row.price - level) < todayTpo.rowSize / 2 + 1e-9
  return (
    <Card size="small" title={`Volume & market profile${prevDate ? ` · previous session ${prevDate}` : ''}`}>
      {loading && <Text type="secondary">Loading the previous session…</Text>}
      {!loading && !prevVp?.poc && <Text type="secondary" style={{ fontSize: 12 }}>No previous session found in the last week.</Text>}
      {prevVp?.poc != null && (
        <Space direction="vertical" size={4} style={{ width: '100%', fontSize: 12 }}>
          <div>
            <Text strong style={{ fontSize: 12 }}>Volume profile (previous session)</Text>{estimatedPrev && <Tag style={{ marginLeft: 6 }}>estimated</Tag>}
            <div>POC <b style={{ color: '#fadb14' }}>{fmt(prevVp.poc)}</b> · VAH <b>{fmt(prevVp.vah)}</b> · VAL <b>{fmt(prevVp.val)}</b></div>
            <div><span style={{ color: '#ffa940' }}>HVN</span> {prevVp.hvn?.length ? prevVp.hvn.map(fmt).join(', ') : '-'} · <span style={{ color: '#69c0ff' }}>LVN</span> {prevVp.lvn?.length ? prevVp.lvn.map(fmt).join(', ') : '-'}</div>
          </div>
          {prevTpo && (
            <div>
              <Text strong style={{ fontSize: 12 }}>Market profile (TPO)</Text>
              <div>Previous: POC <b>{fmt(prevTpo.poc)}</b> · VA <b>{fmt(prevTpo.val)}–{fmt(prevTpo.vah)}</b>{todayTpo?.ib && <> · Today IB <b>{fmt(todayTpo.ib.low)}–{fmt(todayTpo.ib.high)}</b></>}</div>
            </div>
          )}
        </Space>
      )}
      {rows.length === 0
        ? (!loading && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Today's TPO profile builds from the first 30-minute period." />)
        : (
          <div style={{ marginTop: 8, maxHeight: 360, overflowY: 'auto', fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 11.5, lineHeight: '15px' }} aria-label="Market profile">
            {rows.map((row) => {
              const inVa = row.price >= todayTpo.val && row.price <= todayTpo.vah
              const isPoc = row.price === todayTpo.poc
              const atPrice = lastPrice != null && Math.abs(row.price - lastPrice) < todayTpo.rowSize / 2 + 1e-9
              const marks = [
                near(row, prevVp?.poc) && ['pPOC', '#fadb14'], near(row, prevVp?.vah) && ['pVAH', '#9b8cff'], near(row, prevVp?.val) && ['pVAL', '#9b8cff'],
                near(row, prevTpo?.vah) && ['tVAH', '#b37feb'], near(row, prevTpo?.val) && ['tVAL', '#b37feb'],
                ...(prevVp?.hvn ?? []).filter((h) => near(row, h)).map(() => ['HVN', '#ffa940']), ...(prevVp?.lvn ?? []).filter((l) => near(row, l)).map(() => ['LVN', '#69c0ff']),
              ].filter(Boolean)
              return (
                <div key={row.price} style={{ display: 'flex', gap: 8, background: atPrice ? '#2b6cb055' : isPoc ? '#fadb1422' : undefined }}>
                  <span style={{ width: 70, textAlign: 'right', color: inVa ? '#d9dee5' : AXIS_COLOR }}>{fmt(row.price)}</span>
                  <span style={{ flex: 1, letterSpacing: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {[...row.letters].map((l, i) => (
                      <span key={i} style={{ color: isPoc ? '#fadb14' : IB_LETTERS.has(l) ? UP_COLOR : inVa ? '#c9d1d9' : '#6b7280', fontWeight: IB_LETTERS.has(l) || isPoc ? 700 : 400 }}>{l}</span>
                    ))}
                    {todayTpo.singles?.includes(row.price) && <Tooltip title="Single print - only one period traded here (a fast move, often revisited)"><span style={{ color: DOWN_COLOR, marginLeft: 4 }}>◂</span></Tooltip>}
                  </span>
                  <span>{marks.map(([label, color]) => <span key={label} style={{ color, marginLeft: 4, fontSize: 10 }}>{label}</span>)}</span>
                </div>
              )
            })}
          </div>
        )}
      <Text type="secondary" style={{ fontSize: 11 }}>
        Letters = 30-minute periods (A = 09:15) · <span style={{ color: UP_COLOR }}>A B</span> = initial balance · yellow = today&apos;s TPO POC · bright = value area ·
        pPOC / pVAH / pVAL / HVN / LVN = previous session volume profile · tVAH / tVAL = previous session TPO value area
      </Text>
    </Card>
  )
}
