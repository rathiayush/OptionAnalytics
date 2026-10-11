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
    content: `Every alert of a strategy on ${underlying}'s live list will place a REAL Dhan super order by itself - with no page open - using ${underlying}'s Trade settings (lots, slippage, trailing) and the option SL / target its paper trade uses. One open trade at a time, at most ${st?.maxTrades ?? 5} trade(s) today, no new order after a ${rupees(st?.maxLoss ?? 10000)} loss on ${underlying}, none after 14:45; the account's daily loss limit still applies. Tomorrow it is back on paper.`,
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

/**
 * The live list per index (LiveListService): which strategies may place real orders when the index is Live today -
 * proven on that index after costs in the strategy tuning, and not losing in the server scanner's own live record -
 * with the numbers behind each, why it is on or off, and Add / Remove by hand.
 */
export function LiveListCard({ isAdmin }) {
  const [body, setBody] = useState(null)
  const [error, setError] = useState(null)
  const [index, setIndex] = useState('NIFTY')
  const [rules, setRules] = useState(null)
  const [showOff, setShowOff] = useState(false)
  const load = () => fetch('/api/scanner-runner/live-list').then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((b) => { setBody(b); setRules((cur) => cur ?? b.rules); setError(null) }).catch((e) => setError(e.message))
  useEffect(() => { load() }, [])
  const put = async (patch) => {
    const res = await fetch('/api/scanner-runner/live-list', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
    const json = await res.json().catch(() => null)
    if (!res.ok) { message.error(json?.error ?? `HTTP ${res.status}`); return }
    setBody(json)
    setRules(json.rules)
  }
  const list = body?.lists?.[index] ?? []
  const on = list.filter((e) => e.onList)
  const off = list.filter((e) => !e.onList)
  const pct = (v) => (v == null ? '-' : `${v}%`)
  const r2 = (v) => (v == null ? '-' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`)
  const row = (e) => (
    <div key={e.strategyId} style={{ borderTop: '1px solid #ffffff14', padding: '6px 0', fontSize: 12 }}>
      <Space wrap size={6}>
        {e.onList ? <Tag color="green" style={{ margin: 0 }}>live</Tag> : <Tag style={{ margin: 0 }}>paper</Tag>}
        <b>#{e.strategyNo} {e.strategy}</b>
        <Text type="secondary" style={{ fontSize: 12 }}>{e.measured}: {e.trades} trades · win {pct(e.winPct)} · <span style={{ color: e.avgR > 0 ? UP_COLOR : e.avgR < 0 ? DOWN_COLOR : undefined }}>{r2(e.avgR)}</span>/trade after {e.costPoints} pts costs</Text>
        {e.liveTrades > 0 && <Text type="secondary" style={{ fontSize: 12 }}>· live record {e.liveTrades} trades, win {pct(e.liveWinPct)}, <span style={{ color: e.liveNetPerLot > 0 ? UP_COLOR : DOWN_COLOR }}>{rupees(e.liveNetPerLot)}</span> a lot</Text>}
        {e.tuned && (
          <Tooltip title="The fine-tuned setting applied to this strategy on this index - it trades with it, so its record on the days it was never chosen on counts too">
            <Tag color={e.tunedProven ? 'blue' : 'default'} style={{ margin: 0 }}>
              fine-tuned: {e.tuned}{e.tunedTrades ? ` · ${e.tunedTrades} unseen trades ${e.tunedAvg >= 0 ? '+' : ''}${e.tunedAvg?.toFixed(2)}${e.tunedUnit === 'pts' ? ' pts' : 'R'} · won ${e.tunedPeriodsWon} of ${e.tunedPeriods} month(s)` : ''}
            </Tag>
          </Tooltip>
        )}
      </Space>
      <div><Text type={e.onList ? 'success' : 'secondary'} style={{ fontSize: 11 }}>{e.why}</Text></div>
      {isAdmin && (
        <Space size={4} style={{ marginTop: 2 }}>
          {!e.forcedIn && <a onClick={() => put({ underlying: index, strategyId: e.strategyId, mode: 'include' })}>Add by hand</a>}
          {!e.forcedOut && <a onClick={() => put({ underlying: index, strategyId: e.strategyId, mode: 'exclude' })} style={{ color: DOWN_COLOR }}>Remove by hand</a>}
          {(e.forcedIn || e.forcedOut) && <a onClick={() => put({ underlying: index, strategyId: e.strategyId, mode: 'auto' })}>Back to the rules</a>}
        </Space>
      )}
    </div>
  )
  const num = (key, props) => (
    <InputNumber size="small" value={rules?.[key]} disabled={!isAdmin} style={{ width: 70 }} onChange={(v) => v != null && setRules((r) => ({ ...r, [key]: v }))} aria-label={key} {...props} />
  )
  const changed = rules && body && JSON.stringify(rules) !== JSON.stringify(body.rules)
  return (
    <div>
      <Text type="secondary" style={{ fontSize: 12 }}>
        Only the strategies on an index&apos;s live list place real orders when it is Live; every other one still alerts and paper-trades, and earns its
        place as its record grows. On the list: enough strategy-tuning trades on that index, a positive average R after costs (2 x the slippage + the
        charges, on the option the index trades) and the win rate met - and, once the server scanner&apos;s own live record has enough trades, not losing
        there. A strategy with a fine-tuned setting applied on the index is also on the list when THAT setting is proven on the days it was never chosen on
        (made money, beat the strategy as written there, won in at least half the months, enough trades). When two fire together, the one higher on the list goes first. It is worked out again as new tuning runs and live trades come in.
      </Text>
      {error && <div><Text type="danger">{error}</Text></div>}
      {rules && (
        <Space wrap size={10} style={{ margin: '8px 0', fontSize: 12 }}>
          <Space size={4}><Text style={{ fontSize: 12 }}>min trades</Text>{num('minTrades', { min: 1, max: 1000 })}</Space>
          <Space size={4}><Text style={{ fontSize: 12 }}>min win %</Text>{num('minWinPct', { min: 0, max: 100 })}</Space>
          <Space size={4}><Tooltip title="Brokerage, STT and the rest as premium points per trade, on top of 2 x the index's slippage"><Text style={{ fontSize: 12 }}>charges pts</Text></Tooltip>{num('chargesPoints', { min: 0, max: 100, step: 0.5 })}</Space>
          <Space size={4}><Tooltip title="From this many closed live-record trades on, the live record decides"><Text style={{ fontSize: 12 }}>live record decides after</Text></Tooltip>{num('minLiveTrades', { min: 1, max: 1000 })}</Space>
          {isAdmin && changed && <a onClick={() => put({ rules })}>Save rules</a>}
        </Space>
      )}
      <div style={{ marginBottom: 6 }}>
        <Segmented size="small" value={index} onChange={setIndex} options={Object.keys(body?.lists ?? { NIFTY: 0, BANKNIFTY: 0, SENSEX: 0 }).map((u) => ({ value: u, label: `${u} (${(body?.lists?.[u] ?? []).filter((e) => e.onList).length})` }))} aria-label="Live list index" />
      </div>
      {body && !on.length && <Text type="warning" style={{ fontSize: 12 }}>Nothing on {index}&apos;s live list yet - Live today would place no order. Run more strategy tuning for {index}, or add a strategy by hand.</Text>}
      {on.map(row)}
      {off.length > 0 && <div style={{ marginTop: 6 }}><a onClick={() => setShowOff((v) => !v)}>{showOff ? 'Hide' : 'Show'} the {off.length} on paper and why</a></div>}
      {showOff && off.map(row)}
    </div>
  )
}
