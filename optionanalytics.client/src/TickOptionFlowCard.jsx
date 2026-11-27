import { useMemo } from 'react'
import { Alert, Checkbox, Segmented, Typography } from 'antd'
import { DOWN_COLOR, UP_COLOR, usePersistedState } from './shared.jsx'
import { FoldText } from './FoldText.jsx'
import { LinesChart } from './StraddleCard.jsx'
import { optionFlowBuckets, optionFlowLines, lotsText } from './tickOptionFlow.js'
import { useOptionFlow } from './useOptionFlow.js'

const { Text } = Typography
const TIMEFRAMES = [1, 3, 5, 15]
const NET = '#4096ff'

/**
 * The Tick Flow page's OPTION CDV / OBV (asked for - "add tick flow ... this component by using TrueData option"): the dashboard's Option CDV & OBV card
 * (CE and PE lines), worked out from TrueData's OWN option ticks - every tick's quantity on the side of the quote before it (a real aggressor side), the
 * options ATM ± N of the index the page streams (the "Options of" pick above). Lots, cumulated from the day's first minute. Live only.
 */
export function TickOptionFlowCard({ replay, index }) {
  const [tf, setTf] = usePersistedState('optionanalytics.tickFlow.optFlowTf', 1)
  const [showNet, setShowNet] = usePersistedState('optionanalytics.tickFlow.optFlowNet', false)
  const { rows, live, optionTicks, error } = useOptionFlow(!replay)
  const lines = useMemo(() => optionFlowLines(optionFlowBuckets(rows, tf)), [rows, tf])
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
  if (replay) return <Alert type="info" showIcon style={{ margin: '12px 0' }} message="Option CDV / OBV is live only" description="TrueData's tick history of every option for a past day is not built for this card (the big orders' replay keeps only the big ones). Switch to Live." />
  if (!live) return null
  if (!optionTicks) return null
  return (
    <div style={{ margin: '12px 0' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 4 }}>
        <Text strong>{`Option CDV & OBV · ${index ?? ''} · TrueData ticks`}</Text>
        <Segmented size="small" value={tf} onChange={setTf} options={TIMEFRAMES.map((m) => ({ value: m, label: `${m}m` }))} />
        <Checkbox checked={showNet} onChange={(e) => setShowNet(e.target.checked)}>Net (CE − PE)</Checkbox>
      </div>
      {error && <Alert type="warning" showIcon message={`Option flow: ${error}`} style={{ marginBottom: 6 }} />}
      {rows.length === 0 ? <Text type="secondary">No option ticks yet - pick the index in "Options of" above and wait for the first minute.</Text> : (
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
          later counts from its first minute. This is TrueData's data only - not the dashboard's Dhan-based CDV. A read - no strategy, alert or order.
        </Text>
      </FoldText>
    </div>
  )
}
