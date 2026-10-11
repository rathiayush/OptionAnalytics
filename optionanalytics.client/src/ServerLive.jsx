// The server scanner's Paper / Live choice per index (ServerLiveService on the server): Live is for TODAY only - the
// next morning the index is back on paper until switched on again. While Live, every alert of the server scanner on
// that index places a real Dhan super order by itself (page open or not), within the index's limits: one open trade at
// a time, its max trades and max loss for the day, 09:15 - 14:45, and the account's daily loss limit / kill switch.
// Shown on the Trade settings page (every index) and the Order Flow page (the index on screen).
import { useEffect, useState } from 'react'
import { InputNumber, Modal, Segmented, Space, Tag, Tooltip, Typography, message } from 'antd'
import { UP_COLOR, DOWN_COLOR } from './shared.jsx'

const { Text } = Typography
const rupees = (v) => (v == null ? '-' : `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`)

/** Every index's server Live state, refreshed every 10 s; `set` switches one (after the caller confirmed). */
export function useServerLive() {
  const [list, setList] = useState(null)
  const load = () => fetch('/api/scanner-runner/live').then((r) => (r.ok ? r.json() : null)).then((x) => { if (Array.isArray(x)) setList(x) }).catch(() => {})
  useEffect(() => {
    load()
    const id = setInterval(load, 10_000)
    return () => clearInterval(id)
  }, [])
  const set = async (underlying, patch) => {
    const cur = list?.find((x) => x.underlying === underlying)
    const body = { live: patch.live ?? cur?.live ?? false, maxTrades: patch.maxTrades ?? cur?.maxTrades, maxLoss: patch.maxLoss ?? cur?.maxLoss }
    const res = await fetch(`/api/scanner-runner/live/${underlying}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const json = await res.json().catch(() => null)
    if (!res.ok) { message.error(json?.error ?? `HTTP ${res.status}`); return false }
    setList(json)
    return true
  }
  return { list, set, reload: load }
}

/** Asks before switching an index to Live; switching back to paper needs no confirming. */
export function confirmServerLive(underlying, st, onOk) {
  Modal.confirm({
    title: `Trade ${underlying} LIVE from the server today?`,
    content: `Every alert of the server scanner on ${underlying} will place a REAL Dhan super order by itself - with no page open - using ${underlying}'s Trade settings (lots, slippage, trailing) and the option SL / target its paper trade uses. One open trade at a time, at most ${st?.maxTrades ?? 5} trade(s) today, no new order after a ${rupees(st?.maxLoss ?? 10000)} loss on ${underlying}, none after 14:45; the account's daily loss limit still applies. Tomorrow it is back on paper.`,
    okText: `Yes, ${underlying} live today`, okButtonProps: { danger: true }, cancelText: 'Stay on paper',
    onOk,
  })
}

/** One index's Paper / Live (today) switch with its limits and today's live trades. `compact`: one line (Order Flow). */
export function ServerLiveSwitch({ underlying, st, isAdmin, set, compact = false }) {
  if (!st) return null
  const onMode = (v) => {
    if (v === 'paper') { set(underlying, { live: false }).then((ok) => ok && message.info(`${underlying}: the server scanner is on paper`)); return }
    confirmServerLive(underlying, st, () => set(underlying, { live: true }).then((ok) => ok && message.warning(`${underlying}: the server scanner trades LIVE today`)))
  }
  const pnl = <span style={{ color: st.pnlToday > 0 ? UP_COLOR : st.pnlToday < 0 ? DOWN_COLOR : undefined }}>{rupees(st.pnlToday)}</span>
  return (
    <Space wrap size={8} style={{ fontSize: 12 }}>
      <Segmented size="small" value={st.live ? 'live' : 'paper'} disabled={!isAdmin} onChange={onMode} aria-label={`${underlying} server trading`}
        options={[{ value: 'paper', label: 'Paper' }, { value: 'live', label: 'Live today' }]} />
      {st.live && <Tag color="error" style={{ margin: 0 }}>LIVE{st.armedUtc ? ` since ${new Date(st.armedUtc).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}` : ''}</Tag>}
      {!compact && (
        <>
          <Tooltip title="No new live order once this many live trades were placed on the index today">
            <Space size={4}><Text style={{ fontSize: 12 }}>max trades</Text>
              <InputNumber size="small" min={1} max={50} value={st.maxTrades} disabled={!isAdmin} style={{ width: 60 }} aria-label={`${underlying} max live trades`}
                onChange={(v) => v != null && v !== st.maxTrades && set(underlying, { maxTrades: v })} /></Space>
          </Tooltip>
          <Tooltip title="No new live order once the index's live trades lost this much today">
            <Space size={4}><Text style={{ fontSize: 12 }}>max loss ₹</Text>
              <InputNumber size="small" min={500} max={10000000} step={500} value={st.maxLoss} disabled={!isAdmin} style={{ width: 96 }} aria-label={`${underlying} max live loss`}
                onChange={(v) => v != null && v !== st.maxLoss && set(underlying, { maxLoss: v })} /></Space>
          </Tooltip>
        </>
      )}
      <Text type="secondary" style={{ fontSize: 12 }}>today: {st.tradesToday}/{st.maxTrades} live trade(s){st.openToday ? `, ${st.openToday} open` : ''} · {pnl}{compact ? ` (stop at -${rupees(st.maxLoss)})` : ''}</Text>
    </Space>
  )
}

/** Today's live trades of the server scanner on one index. */
export function ServerLiveTrades({ st }) {
  if (!st?.trades?.length) return null
  return (
    <div style={{ fontSize: 12 }}>
      {st.trades.map((t) => (
        <div key={t.key} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', borderBottom: '1px solid #ffffff0d', padding: '2px 0' }}>
          <Tag color="volcano" style={{ margin: 0, fontSize: 10 }}>LIVE</Tag>
          <span>{new Date(t.placedUtc).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}</span>
          <b>{t.contract}</b><span>x{t.lots}</span>
          <Text type="secondary" style={{ fontSize: 12 }}>{t.strategy}</Text>
          {t.exitedUtc ? <span>{t.exitReason ?? 'closed'} · <b style={{ color: (t.pnl ?? 0) >= 0 ? UP_COLOR : DOWN_COLOR }}>{rupees(t.pnl)}</b></span> : <Tag color="processing" style={{ margin: 0 }}>open</Tag>}
          {t.note && <Text type="warning" style={{ fontSize: 11 }}>{t.note}</Text>}
        </div>
      ))}
    </div>
  )
}
