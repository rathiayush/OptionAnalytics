import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Col, DatePicker, Input, Row, Segmented, Select, Space, Statistic, Switch, Table, Tag, Typography, message } from 'antd'
import { CopyOutlined, ReloadOutlined, SendOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { NavBar } from './shared.jsx'

const { Title, Text } = Typography

const IST_TIME = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })
const CATEGORY_COLOR = { Order: 'red', Data: 'blue', Quote: 'purple', NonTrading: 'default' }

// The System page (admin): "what is this server sending to Dhan, and why is it failing?"
//  - Dhan calls: every Dhan REST call of the last 15 minutes (GET /api/system/dhan-calls, DhanRestRateLimiter's call log) -
//    per endpoint, any request asked again and again (a loop), and each call with its body exactly as sent, Dhan's answer
//    and the likely cause of a failure;
//  - Try a request: send ONE Dhan data request (index candles for a day, an expired-option strike) and see exactly what
//    went and what Dhan said - to tell a bad request from a refusal on Dhan's side, and to hand Dhan support the request.
export default function SystemPage() {
  const [report, setReport] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [auto, setAuto] = useState(true)
  const [show, setShow] = useState('Failed')
  const [search, setSearch] = useState('')

  const load = useCallback(() => {
    fetch('/api/system/dhan-calls')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 403 ? 'Admin only.' : `HTTP ${r.status}`))))
      .then((d) => { setReport(d); setError(null) })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
    if (!auto) return undefined
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [auto, load])

  const calls = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (report?.recent ?? []).filter((c) => (show === 'All' || !c.success)
      && (!q || `${c.path} ${c.context} ${c.error ?? ''} ${c.body ?? ''}`.toLowerCase().includes(q)))
  }, [report, show, search])

  // The causes behind the failures, most frequent first - the quickest way to see what to fix.
  const causes = useMemo(() => {
    const counts = new Map()
    for (const c of report?.recent ?? []) if (!c.success) counts.set(c.diagnosis ?? c.error ?? 'unknown', (counts.get(c.diagnosis ?? c.error ?? 'unknown') ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [report])

  const columns = [
    { title: 'Time (IST)', dataIndex: 'at', width: 90, render: (t) => IST_TIME.format(new Date(t)) },
    { title: 'Kind', dataIndex: 'category', width: 100, render: (c) => <Tag color={CATEGORY_COLOR[c]}>{c}</Tag> },
    { title: 'Request', key: 'req', render: (_, c) => <span><Text code>{c.method} {c.path}</Text><br /><Text type="secondary" style={{ fontSize: 12 }}>{c.context}</Text></span> },
    {
      title: 'Answer', key: 'ans', width: 120,
      render: (_, c) => <span><Tag color={c.success ? 'green' : 'red'}>{c.success ? 'OK' : 'failed'}{c.status ? ` ${c.status}` : ''}</Tag><br /><Text type="secondary" style={{ fontSize: 12 }}>{c.durationMs} ms</Text></span>,
    },
    {
      title: 'Error / likely cause', key: 'err',
      render: (_, c) => (c.success ? null : (
        <span>
          <Text type="danger" style={{ fontSize: 12 }}>{c.error}</Text>
          {c.diagnosis && <><br /><Text strong style={{ fontSize: 12 }}>→ {c.diagnosis}</Text></>}
        </span>
      )),
    },
  ]

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>
        <TryDhanRequest />

        <Card
          title="Dhan calls - last 15 minutes"
          extra={(
            <Space wrap>
              <Space size={4}><Switch size="small" checked={auto} onChange={setAuto} /><Text type="secondary">every 5 s</Text></Space>
              <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => { setLoading(true); load() }}>Refresh</Button>
            </Space>
          )}
        >
          {error && <Alert type="error" showIcon message={`Could not load: ${error}`} style={{ marginBottom: 12 }} />}
          <Text type="secondary">
            Every request this server sent to Dhan&apos;s REST API (each attempt, retries included), with its body exactly as sent. A request
            asked again and again shows under Repeated - a loop. Dhan allows 5 data calls and 10 orders a second for the whole account.
          </Text>
          <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
            <Col xs={12} md={6}><Statistic title="Last minute" value={report?.lastMinute ?? '-'} /></Col>
            <Col xs={12} md={6}><Statistic title="Last 15 minutes" value={report?.last15Minutes ?? '-'} /></Col>
            <Col xs={12} md={6}><Statistic title="Failed" value={report?.failed ?? '-'} valueStyle={report?.failed ? { color: '#ff4d4f' } : undefined} /></Col>
            <Col xs={12} md={6}><Statistic title="Repeated 3+ times" value={report?.repeated?.length ?? '-'} valueStyle={report?.repeated?.length ? { color: '#faad14' } : undefined} /></Col>
          </Row>
        </Card>

        {causes.length > 0 && (
          <Card size="small" title="Why calls failed">
            <Space direction="vertical" style={{ width: '100%' }}>
              {causes.map(([cause, n]) => <Text key={cause}><Tag color="red">{n}×</Tag>{cause}</Text>)}
            </Space>
          </Card>
        )}

        <Card size="small" title="By endpoint">
          <Table
            size="small" rowKey={(e) => `${e.method} ${e.path}`} pagination={false} dataSource={report?.endpoints ?? []} scroll={{ x: true }}
            columns={[
              { title: 'Kind', dataIndex: 'category', render: (c) => <Tag color={CATEGORY_COLOR[c]}>{c}</Tag> },
              { title: 'Endpoint', key: 'ep', render: (_, e) => <Text code>{e.method} {e.path}</Text> },
              { title: 'Last minute', dataIndex: 'lastMinute', align: 'right' },
              { title: '15 min', dataIndex: 'last15Minutes', align: 'right' },
              { title: 'Failed', dataIndex: 'failed', align: 'right', render: (n) => (n ? <Text type="danger">{n}</Text> : 0) },
            ]}
          />
        </Card>

        {report?.repeated?.length > 0 && (
          <Card size="small" title="Repeated - the same request 3+ times (a loop?)">
            <Table
              size="small" rowKey="context" pagination={false} dataSource={report.repeated} scroll={{ x: true }}
              columns={[
                { title: 'Request', dataIndex: 'context' },
                { title: 'Times', dataIndex: 'times', align: 'right' },
                { title: 'Failed', dataIndex: 'failed', align: 'right', render: (n) => (n ? <Text type="danger">{n}</Text> : 0) },
                { title: 'Last error', dataIndex: 'lastError', render: (e) => <Text type="danger" style={{ fontSize: 12 }}>{e}</Text> },
                { title: 'Last', dataIndex: 'lastAt', render: (t) => IST_TIME.format(new Date(t)) },
              ]}
            />
          </Card>
        )}

        <Card
          size="small" title="Calls"
          extra={(
            <Space wrap>
              <Segmented size="small" value={show} onChange={setShow} options={['Failed', 'All']} />
              <Input.Search size="small" allowClear placeholder="path, strike, error..." onChange={(e) => setSearch(e.target.value)} style={{ width: 220 }} />
            </Space>
          )}
        >
          <Table
            size="small" rowKey={(c, i) => `${c.at}-${i}`} dataSource={calls} columns={columns} scroll={{ x: 900 }}
            pagination={{ pageSize: 50, showSizeChanger: false }}
            expandable={{
              rowExpandable: (c) => !!c.body,
              expandedRowRender: (c) => <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12 }}>{pretty(c.body)}</pre>,
            }}
            locale={{ emptyText: show === 'Failed' ? 'No failed calls in the last 15 minutes.' : 'No calls to Dhan in the last 15 minutes.' }}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>Expand a row to see the request body as sent (the account&apos;s client id masked).</Text>
        </Card>
      </Space>
    </div>
  )
}

// Index securities on Dhan (IDX_I) - the spot the OI Replay reads, and the underlying of the expired-option chain.
const INDICES = { NIFTY: { id: '13', fno: 'NSE_FNO' }, BANKNIFTY: { id: '25', fno: 'NSE_FNO' }, SENSEX: { id: '51', fno: 'BSE_FNO' } }

function presetBody(kind, index, date, strike, side, flag) {
  const d = date.format('YYYY-MM-DD')
  if (kind === 'intraday') {
    return { path: '/charts/intraday', body: { securityId: INDICES[index].id, exchangeSegment: 'IDX_I', instrument: 'INDEX', interval: '1', oi: false, fromDate: `${d} 09:15:00`, toDate: `${d} 15:30:00` } }
  }
  if (kind === 'historical') {
    return { path: '/charts/historical', body: { securityId: INDICES[index].id, exchangeSegment: 'IDX_I', instrument: 'INDEX', expiryCode: 0, oi: false, fromDate: d, toDate: date.add(1, 'day').format('YYYY-MM-DD') } }
  }
  return {
    path: '/charts/rollingoption',
    body: {
      exchangeSegment: INDICES[index].fno, interval: 1, securityId: INDICES[index].id, instrument: 'OPTIDX', expiryFlag: flag, expiryCode: 1, strike, drvOptionType: side,
      requiredData: ['open', 'high', 'low', 'close', 'iv', 'volume', 'strike', 'oi', 'spot'], fromDate: d, toDate: date.add(1, 'day').format('YYYY-MM-DD'),
    },
  }
}

// Send one Dhan data request as written (data endpoints only - never an order) and show what went and what came back.
function TryDhanRequest() {
  const [kind, setKind] = useState('intraday')
  const [index, setIndex] = useState('NIFTY')
  const [date, setDate] = useState(() => { let d = dayjs().subtract(1, 'day'); while (d.day() === 0 || d.day() === 6) d = d.subtract(1, 'day'); return d })
  const [strike, setStrike] = useState('ATM')
  const [side, setSide] = useState('CALL')
  const [flag, setFlag] = useState('WEEK')
  const preset = useMemo(() => presetBody(kind, index, date, strike, side, flag), [kind, index, date, strike, side, flag])
  const [text, setText] = useState(null)
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const bodyText = text ?? JSON.stringify(preset.body, null, 2)

  const send = () => {
    let body
    try { body = JSON.parse(bodyText) } catch { message.error('The body is not valid JSON.'); return }
    setBusy(true)
    fetch('/api/system/dhan-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: preset.path, body }) })
      .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error(r.status === 403 ? 'Admin only.' : (await r.text()) || `HTTP ${r.status}`))))
      .then(setResult)
      .catch((e) => setResult({ success: false, error: e.message, sent: JSON.stringify(body), at: new Date().toISOString() }))
      .finally(() => setBusy(false))
  }
  // What to paste to Dhan support - built on the click, from the answer shown.
  const copyForSupport = () => {
    const at = new Date(result.at)
    const text = [
      `Time: ${at.toISOString()} (${IST_TIME.format(at)} IST)`,
      `Request: POST https://api.dhan.co/v2${preset.path}`,
      `Body: ${result.sent}`,
      `Answer: HTTP ${result.status ?? '-'} ${result.success ? 'OK' : result.error}`,
    ].join('\n')
    navigator.clipboard?.writeText(text).then(() => message.success('Copied - paste it to Dhan support.'), () => message.error('Could not copy.'))
  }

  return (
    <Card title="Try a request" extra={<Text type="secondary">one Dhan data call, as written</Text>}>
      <Space wrap style={{ marginBottom: 12 }}>
        <Segmented value={kind} onChange={(v) => { setKind(v); setText(null) }}
          options={[{ value: 'intraday', label: 'Index 1-min' }, { value: 'historical', label: 'Index daily' }, { value: 'rolling', label: 'Expired option' }]} />
        <Select value={index} onChange={(v) => { setIndex(v); setText(null) }} style={{ width: 120 }} options={Object.keys(INDICES).map((k) => ({ value: k, label: k }))} />
        <DatePicker value={date} onChange={(v) => { if (v) { setDate(v); setText(null) } }} allowClear={false} />
        {kind === 'rolling' && (
          <>
            <Select value={strike} onChange={(v) => { setStrike(v); setText(null) }} style={{ width: 100 }}
              options={Array.from({ length: 21 }, (_, i) => i - 10).map((k) => ({ value: k === 0 ? 'ATM' : `ATM${k > 0 ? '+' : ''}${k}`, label: k === 0 ? 'ATM' : `ATM${k > 0 ? '+' : ''}${k}` }))} />
            <Segmented value={side} onChange={(v) => { setSide(v); setText(null) }} options={['CALL', 'PUT']} />
            <Segmented value={flag} onChange={(v) => { setFlag(v); setText(null) }} options={['WEEK', 'MONTH']} />
          </>
        )}
      </Space>
      <Text type="secondary" style={{ fontSize: 12 }}>POST {preset.path} - edit the body if you like:</Text>
      <Input.TextArea value={bodyText} onChange={(e) => setText(e.target.value)} autoSize={{ minRows: 6, maxRows: 16 }} style={{ fontFamily: 'monospace', fontSize: 12, marginTop: 4 }} />
      <Space style={{ marginTop: 8 }} wrap>
        <Button type="primary" icon={<SendOutlined />} loading={busy} onClick={send}>Send to Dhan</Button>
        {text !== null && <Button onClick={() => setText(null)}>Reset body</Button>}
      </Space>
      {result && (
        <div style={{ marginTop: 12 }}>
          <Alert
            type={result.success ? 'success' : 'error'} showIcon
            message={result.success ? `Dhan answered OK (HTTP ${result.status}, ${result.durationMs} ms)` : `Dhan refused it${result.status ? ` (HTTP ${result.status})` : ''}: ${result.error}`}
            description={result.diagnosis}
          />
          <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>Sent:</Text>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12 }}>{result.sent}</pre>
          {result.answer && (
            <>
              <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 8 }}>Answer (first 4,000 characters):</Text>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12, maxHeight: 240, overflow: 'auto' }}>{result.answer}</pre>
            </>
          )}
          <Button size="small" icon={<CopyOutlined />} style={{ marginTop: 8 }}
            onClick={copyForSupport}>
            Copy for Dhan support
          </Button>
        </div>
      )}
    </Card>
  )
}

function pretty(body) {
  try { return JSON.stringify(JSON.parse(body), null, 2) } catch { return body }
}
