import { useMemo } from 'react'
import { Alert, Checkbox, InputNumber, Segmented, Typography } from 'antd'
import { usePersistedState } from './shared.jsx'
import { FoldText } from './FoldText.jsx'
import { TickProfileChart } from './TickProfileChart.jsx'
import { usePastTickDays } from './usePastTickDays.js'
import { aggregateTickBars, msOf } from './tickFlowMath.js'
import { cdvObvProfilesOf, futuresRowsOf, optionProfilesOf, profileLevels, readOf } from './tickDeltaProfile.js'

const { Text } = Typography
const GREEN = '#26a69a'
const RED = '#ef5350'
const ROW_CHOICES = { NIFTY: [1, 2, 5, 10, 25, 50], BANKNIFTY: [5, 10, 20, 50, 100] }
const TIMEFRAMES = [1, 3, 5, 15]
const MAX_DAYS = 5
const isMultiple = (v, base) => base > 0 && Math.abs(v / base - Math.round(v / base)) < 1e-9
const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)

// The kinds of profile card (asked for - OI Replay's candle + profile layout on TrueData's data): each is a list of columns on the same price rows.
const KINDS = {
  options: {
    title: 'Option delta profile on spot', needsOptions: true,
    columns: [
      { key: 'vol', title: 'VOLUME', kind: 'volume' },
      { key: 'oi', title: 'CE − PE OI', kind: 'delta', bullishNegative: true },
      { key: 'net', title: 'NET CE − PE', kind: 'delta' },
      { key: 'total', title: 'TOTAL OI − NET', kind: 'delta', bullishNegative: true },
    ],
    how: [
      ['VOLUME', "the big option orders' lots traded at the row"],
      ['CE − PE OI', 'call OI added less put OI added - negative = puts written = a floor = bullish (green), positive = calls written = a ceiling = bearish (red)'],
      ['NET CE − PE', 'option flow: calls bought / puts sold +, calls sold / puts bought − - positive = bullish'],
      ['TOTAL OI − NET', "the OI's CE − PE less the flow's net, scaled to the OI's size - negative = bullish"],
    ],
  },
  cdv: {
    title: 'Option CDV / OBV profile', needsOptions: true, side: true,
    columns: [
      { key: 'vol', title: 'VOLUME', kind: 'volume' },
      { key: 'cdv', title: 'CDV', kind: 'delta' },
      { key: 'obv', title: 'OBV', kind: 'delta' },
    ],
    how: [
      ['CDV', 'the aggressor delta of the option orders: lots bought at the ask less lots sold at the bid'],
      ['OBV', "each order's lots signed by whether the option's premium rose (+) or fell (−) from its tick before"],
      ['Side', 'Net (CE − PE) flips a put (a put bought is bearish); CE or PE alone is that option on its own'],
    ],
  },
  futures: {
    title: 'Futures delta profile', needsOptions: false,
    columns: [
      { key: 'vol', title: 'VOLUME', kind: 'volume' },
      { key: 'delta', title: 'DELTA', kind: 'delta' },
    ],
    how: [
      ['VOLUME', "the near futures' lots traded at each price row (the footprint's rows)"],
      ['DELTA', 'buy − sell at the row, in lots - green buyers ahead, red sellers ahead'],
    ],
  },
}

/**
 * One PROFILE CARD of the Tick Flow page: candles with the profile columns beside them (TickProfileChart). `kind` picks the columns. The day is the page's own
 * (`orders` = the big option orders after the card's filters, up to the replay clock; `dayBars` = the futures' 1-minute bars at the page's row size; `priceBars`
 * their closes); with "Previous day" ticked the card also loads the N sessions before it from the server (usePastTickDays - kept on the server's disk) and
 * adds them up price by price, "+ current day" keeping or leaving the day itself out. Nothing here places an order or feeds a strategy.
 */
export function TickProfileCard({ kind, index, orders, dayBars, priceBars, lotSize, pageRow, refine, replayDate }) {
  const spec = KINDS[kind]
  const key = `optionanalytics.tickFlow.profile.${kind}`
  const [tf, setTf] = usePersistedState(`${key}.tf`, 5)
  const [rowSizes, setRowSizes] = usePersistedState('optionanalytics.tickFlow.profileRows', {})
  const [side, setSide] = usePersistedState('optionanalytics.tickFlow.cdvObvSide', 'net')
  const [prev, setPrev] = usePersistedState(`${key}.prev`, false)
  const [days, setDays] = usePersistedState(`${key}.days`, 1)
  const [withToday, setWithToday] = usePersistedState(`${key}.withToday`, true)

  const base = (ROW_CHOICES[index] ?? ROW_CHOICES.NIFTY)
  // The day's rows are the page's; a row size is offered when it is a whole number of them (a finer day cannot be split).
  const choices = useMemo(() => { const c = base.filter((v) => v >= pageRow && isMultiple(v, pageRow)); return c.length ? c : [pageRow] }, [base, pageRow])
  const rowSize = choices.includes(rowSizes?.[index]) ? rowSizes[index] : choices.find((v) => v >= 5) ?? choices.at(-1)
  const dayShown = replayDate ?? istToday()

  const past = usePastTickDays({ index, date: dayShown, days, enabled: !!prev, withOptions: spec.needsOptions })
  const sessions = useMemo(() => {
    const out = past.sessions.map((s) => ({ orders: refine ? refine(s.orders) : s.orders, bars: s.bars, lotSize: s.lotSize }))
    if (!prev || withToday) out.push({ orders, bars: spec.needsOptions ? priceBars : dayBars, lotSize })
    return out
  }, [past.sessions, prev, withToday, orders, priceBars, dayBars, lotSize, refine, spec.needsOptions])

  const profile = useMemo(() => {
    if (kind === 'options') return optionProfilesOf(sessions, rowSize)
    if (kind === 'cdv') return cdvObvProfilesOf(sessions, rowSize, side)
    return futuresRowsOf(sessions, rowSize)
  }, [kind, sessions, rowSize, side])

  // Candles: the day's own; with none yet (before the open) the newest session loaded stands in.
  const candles = useMemo(() => {
    const source = dayBars?.length ? dayBars : past.sessions[0]?.bars ?? []
    return aggregateTickBars(source, tf).map((b) => ({ time: msOf(b.time), open: b.open, high: b.high, low: b.low, close: b.close }))
  }, [dayBars, past.sessions, tf])

  const levels = useMemo(() => profileLevels(profile.rows.map((r) => ({ price: r.price, vol: r.vol }))), [profile.rows])
  const reads = spec.columns.filter((c) => c.kind === 'delta').map((c) => {
    const total = profile[c.key] ?? profile.rows.reduce((s, r) => s + (r[c.key] ?? 0), 0)
    const bullish = c.bullishNegative ? total < 0 : total > 0
    return { c, total, word: total ? (bullish ? 'bullish' : 'bearish') : 'neutral', bullish }
  })
  const sessionsText = prev
    ? `${past.sessions.length} previous session${past.sessions.length === 1 ? '' : 's'}${withToday ? ' + the day' : ''}`
    : 'the day so far'

  return (
    <div style={{ margin: '12px 0' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 6 }}>
        <Text strong>{spec.title}</Text>
        <Segmented size="small" value={tf} onChange={setTf} options={TIMEFRAMES.map((v) => ({ value: v, label: `${v}m` }))} />
        <Segmented size="small" value={rowSize} onChange={(v) => setRowSizes({ ...(rowSizes ?? {}), [index]: v })} options={choices.map((v) => ({ value: v, label: `${v} pt` }))} />
        {spec.side && <Segmented size="small" value={side} onChange={setSide} options={[{ value: 'net', label: 'Net CE − PE' }, { value: 'ce', label: 'CE' }, { value: 'pe', label: 'PE' }]} />}
        <Checkbox checked={prev} onChange={(e) => setPrev(e.target.checked)}>Previous day</Checkbox>
        {prev && <><Text type="secondary" style={{ fontSize: 12 }}>Days</Text><InputNumber size="small" min={1} max={MAX_DAYS} value={days} onChange={(v) => setDays(Math.min(MAX_DAYS, Math.max(1, Math.round(v || 1))))} style={{ width: 56 }} />
          <Checkbox checked={withToday} onChange={(e) => setWithToday(e.target.checked)}>+ current day</Checkbox></>}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 12, marginBottom: 4 }}>
        <Text type="secondary">{sessionsText}</Text>
        {reads.map(({ c, total, word, bullish }) => (
          <Text key={c.key} style={{ fontSize: 12 }}>{c.title}: <b style={{ color: word === 'neutral' ? undefined : bullish ? GREEN : RED }}>{Math.round(total).toLocaleString('en-IN')} lots · {word}</b></Text>
        ))}
        {levels.poc != null && <Text type="secondary">POC {levels.poc} · VAH {levels.vah} · VAL {levels.val}</Text>}
      </div>
      {prev && past.status === 'loading' && <Alert type="info" showIcon style={{ marginBottom: 6 }} message={past.note} description={spec.needsOptions ? 'The first load of a day builds its option ticks from TrueData (a few minutes) - it is kept on the server after.' : undefined} />}
      {prev && past.status === 'error' && <Alert type="warning" showIcon style={{ marginBottom: 6 }} message={`Previous days: ${past.error}`} description="The walk stopped here; untick and tick Previous day to try again." />}
      {prev && past.status === 'done' && past.note && <Text type="secondary" style={{ fontSize: 12 }}>{past.note}</Text>}
      {profile.rows.length === 0
        ? <div><Text type="secondary">{spec.needsOptions ? 'No big option order with a futures price yet.' : 'No futures trades yet.'}</Text></div>
        : <TickProfileChart candles={candles} rows={profile.rows} rowSize={rowSize} columns={spec.columns} />}
      <FoldText id={`tickProfile.${kind}.how`} className="oa-note" summary="How this profile is worked out - and what it cannot tell">
        <div style={{ fontSize: 12 }}>
          {spec.how.map(([k, v]) => <div key={k}><b>{k}</b> - {v}.</div>)}
          <div>Rows are {rowSize} points of the near futures' price (TrueData has no index feed); the biggest buying rows are tagged B1 / B2 and the biggest selling S1 / S2, the volume column's POC amber with its value area (70%) and VAH / VAL. The option columns count only the big orders the filters above let through - a profile of the big orders, not of every contract that traded. Previous sessions come from the server (kept on its disk once built; TrueData's tick history keeps only the last days of the trial). Up to the replay clock on a replayed day. A read - no signal, alert or order.</div>
        </div>
      </FoldText>
    </div>
  )
}
