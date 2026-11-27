import { useMemo } from 'react'
import { Alert, Checkbox, Segmented, Typography } from 'antd'
import { DOWN_COLOR, UP_COLOR, usePersistedState } from './shared.jsx'
import { FoldText } from './FoldText.jsx'
import { LinesChart } from './StraddleCard.jsx'
import { optionFlowBuckets, optionFlowLines, lotsText } from './tickOptionFlow.js'
import { useOptionFlow, useOptionFlowDay } from './useOptionFlow.js'

const { Text } = Typography
const TIMEFRAMES = [1, 3, 5, 15]
const NET = '#4096ff'

/**
 * The Tick Flow page's OPTION CDV / OBV (asked for - "add tick flow ... this component by using TrueData option"): the dashboard's Option CDV & OBV card
 * (CE and PE lines), worked out from TrueData's OWN option ticks - every tick's quantity on the side of the quote before it (a real aggressor side), the
 * options ATM ± N of the index the page streams (the "Options of" pick above). Lots, cumulated from the day's first minute. Live and replayed.
 */
export function TickOptionFlowCard({ replay, index, replayDate, clockMs }) {
  const [tf, setTf] = usePersistedState('optionanalytics.tickFlow.optFlowTf', 1)
  const [showNet, setShowNet] = usePersistedState('optionanalytics.tickFlow.optFlowNet', false)
  const liveFlow = useOptionFlow(!replay)
  const dayFlow = useOptionFlowDay(index, replayDate, !!replay)
  const { live, optionTicks } = liveFlow
  const error = replay ? dayFlow.error : liveFlow.error
  const rows = replay ? dayFlow.rows : liveFlow.rows
  // A replayed day: only the minutes completed at the replay clock (nothing after it).
  const lines = useMemo(() => optionFlowLines(optionFlowBuckets(rows, tf, replay && clockMs != null ? { upToMs: clockMs } : {})), [rows, tf, replay, clockMs])
  const pack = (m) => [
    { id: `${m}-ce`, title: 'CE', color: UP_COLOR, data: lines[m].ce },
    { id: `${m}-pe`, title: 'PE', color: DOWN_COLOR, data: lines[m].pe },
    ...(showNet ? [{ id: `${m}-net`, title: 'Net', color: NET, data: lines[m].net, width: 1 }] : []),
  ]
  const head = (m, name) => (
    <div style={{ margin: '8px 0 2px', fontSize: 13 }}>
      <b>{name}</b>
      <span style={{ color: UP_COLOR, marginLeft: 8 }}>CE {lotsText(lines.last[m].ce)}</span>
      <span style={{ color: DOWN_COLOR, marginLeft: 8 }}>PE {lotsText(lines.last[m].pe)}</span>
      <span style={{ color: NET, marginLeft: 8 }}>Net {lotsText(lines.last[m].net)}</span>
      <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>lots</Text>
    </div>
  )
  if (!replay && (!live || !optionTicks)) return null
  const replayNotice = !replay ? null
    : dayFlow.error ? <Alert type="warning" showIcon style={{ marginBottom: 6 }} message={`Option CDV / OBV: ${dayFlow.error}`} />
      : dayFlow.answer?.state === 'failed' ? <Alert type="warning" showIcon style={{ marginBottom: 6 }} message="The day's option ticks could not be built" description={dayFlow.answer.error} />
        : !dayFlow.ready ? <Alert type="info" showIcon style={{ marginBottom: 6 }} message={`Loading the day's option ticks from TrueData… ${dayFlow.answer?.done ?? 0} of ${dayFlow.answer?.total ?? '?'} contracts`} description="One history call per option contract (the day's range ± 10 strikes) - a few minutes the first time; the day is kept on the server after." />
          : null
  return (
    <div style={{ margin: '12px 0' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 4 }}>
        <Text strong>{`Option CDV & OBV · ${index ?? ''} · TrueData ticks`}</Text>
        <Segmented size="small" value={tf} onChange={setTf} options={TIMEFRAMES.map((m) => ({ value: m, label: `${m}m` }))} />
        <Checkbox checked={showNet} onChange={(e) => setShowNet(e.target.checked)}>Net (CE − PE)</Checkbox>
      </div>
      {replayNotice}
      {!replay && error && <Alert type="warning" showIcon message={`Option flow: ${error}`} style={{ marginBottom: 6 }} />}
      {rows.length === 0 ? (replayNotice ? null : <Text type="secondary">{replay ? 'No option ticks at this clock yet.' : 'No option ticks yet - pick the index in "Options of" above and wait for the first minute.'}</Text>) : (
        <>
          {head('cdv', 'CDV (bought − sold)')}
          <LinesChart lines={pack('cdv')} dayKey={`tick-cdv-${index}-${tf}`} height={220} />
          {head('obv', 'OBV (volume by premium direction)')}
          <LinesChart lines={pack('obv')} dayKey={`tick-obv-${index}-${tf}`} height={220} />
        </>
      )}
      <FoldText id="tickFlow.optionFlow" label="how it is worked out" className="oa-note" style={{ marginTop: 4 }}>
        <Text type="secondary" style={{ fontSize: 11 }}>
          Every tick of every option streamed (ATM ± N, calls and puts) adds its quantity to the minute on the side of the quote before it - at / through the ask
          = bought, at / through the bid = sold, inside the spread the nearer half. CDV is bought − sold; OBV signs each option's minute volume by whether its
          premium rose or fell from the minute before. Both in lots, added over the strikes and cumulated from the day's first minute. A tick here is
          TrueData's snapshot about once a second, so a quantity is several trades at that snapshot's side. The window follows the ATM, so a strike that joins
          later counts from its first minute. This is TrueData's data only - not the dashboard's Dhan-based CDV. On a replayed day it is rebuilt from TrueData's tick history of every option contract in the day's range ± 10 strikes (a few minutes the first time, kept after) and cut at the replay clock. A read - no strategy, alert or order.
        </Text>
      </FoldText>
    </div>
  )
}
