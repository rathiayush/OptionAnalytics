import { useEffect, useState } from 'react'
import { Alert, Table, Typography } from 'antd'
import { POLL_HEADERS } from './shared.jsx'
import { FoldText } from './FoldText.jsx'

const { Text } = Typography
const fix = (v, d = 2) => (v == null ? '-' : Number(v).toFixed(d))

/** FEED CHECK: how often TrueData really sends (`GET /api/tick-flow/rate`, a page timer with POLL_HEADERS every 2 s) - per stream the messages today, the rate
 *  over the last 10 s / 60 s, the busiest second, how many seconds carried 1 / 2 / 3 / 4+ messages, the median gap and the server's verdict: tick by tick, or a
 *  snapshot about once a second. It answers "are we getting every trade?" with numbers. A read - nothing is placed. */
export function TickFeedCheckCard() {
  const [answer, setAnswer] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let stop = false
    let timer = null
    const load = async () => {
      try {
        const r = await fetch('/api/tick-flow/rate', { headers: POLL_HEADERS })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        const body = await r.json()
        if (!stop) { setAnswer(body); setError(null) }
      } catch (e) { if (!stop) setError(e.message) }
      if (!stop) timer = setTimeout(load, 2000)
    }
    load()
    return () => { stop = true; clearTimeout(timer) }
  }, [])

  const rates = Array.isArray(answer?.rates) ? answer.rates : []
  const columns = [
    { title: 'Stream', dataIndex: 'key', width: 190 },
    { title: 'Messages today', dataIndex: 'total', render: (v) => v.toLocaleString('en-IN') },
    { title: 'Last 10 s /s', dataIndex: 'perSecond10', render: (v) => fix(v, 1) },
    { title: 'Last 60 s /s', dataIndex: 'perSecond60', render: (v) => fix(v, 2) },
    { title: 'Day avg /s', dataIndex: 'perSecondSinceFirst', render: (v) => fix(v, 2) },
    { title: 'Busiest second', dataIndex: 'peakInASecond' },
    { title: 'Seconds with 1 / 2 / 3 / 4+', render: (_, r) => `${r.secondsWith1} / ${r.secondsWith2} / ${r.secondsWith3} / ${r.secondsWith4Plus}` },
    { title: 'Median gap', dataIndex: 'medianGapMs', render: (v) => (v == null ? '-' : v >= 1000 ? `${fix(v / 1000, 1)} s` : `${Math.round(v)} ms`) },
    { title: 'Within 100 ms', dataIndex: 'within100MsShare', render: (v) => (v == null ? '-' : `${Math.round(v * 100)}%`) },
  ]
  return (
    <div>
      {error && <Alert type="warning" showIcon message={`Feed check: ${error}`} />}
      {answer?.enabled === false && <Alert type="info" showIcon message="The TrueData live feed is off" />}
      {answer?.enabled && <Text type="secondary" style={{ fontSize: 12 }}>Feed state: {answer.state}</Text>}
      <Table size="small" pagination={false} rowKey="key" columns={columns} dataSource={rates} scroll={{ x: 'max-content' }}
        expandable={{ expandedRowRender: (r) => <Text style={{ fontSize: 12 }}>{r.verdict}</Text>, defaultExpandAllRows: true, expandIcon: () => null }}
        locale={{ emptyText: 'No message yet - the feed counts from its first tick (market hours).' }} />
      <FoldText id="tickFeedCheck.how" className="oa-note" summary="How to read this">
        <div style={{ fontSize: 12 }}>
          Every trade and quote message the server applies is counted by the second it ARRIVED. A feed that sends every trade shows seconds with several messages (the 2 / 3 / 4+ columns, many gaps under 100 ms); a snapshot feed shows almost every second with exactly one message and a median gap of a second or more. The verdict needs 60 messages. Nothing is placed or changed by reading it.
        </div>
      </FoldText>
    </div>
  )
}
