import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Button, Card, Col, Descriptions, Input, Row, Segmented, Select, Space, Statistic, Switch, Table, Tag, Typography, message } from 'antd'
import { CopyOutlined, ReloadOutlined } from '@ant-design/icons'
import { NavBar } from './shared.jsx'

const { Title, Text } = Typography

const IST_TIME = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })
const CATEGORY_COLOR = { Order: 'red', Data: 'blue', Quote: 'purple', NonTrading: 'default' }
const WINDOWS = [{ value: 5, label: '5 min' }, { value: 15, label: '15 min' }, { value: 60, label: '1 hour' }]

// "What is this server sending to Dhan, and why is it failing?" - every Dhan REST call of the last hour (GET
// /api/system/dhan-calls, DhanRestRateLimiter's call log). Filter by result, kind, endpoint, HTTP status, Dhan error code,
// time and free text; each call opens to the payload exactly as sent, Dhan's answer exactly as it came, the error and a
// likely cause - and copies as one block for Dhan support. Admin only.
export default function DhanCallsPage() {
  const [report, setReport] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [auto, setAuto] = useState(true)
  const [result, setResult] = useState('Failed')
  const [kinds, setKinds] = useState([])
  const [paths, setPaths] = useState([])
  const [statuses, setStatuses] = useState([])
  const [codes, setCodes] = useState([])
  const [windowMin, setWindowMin] = useState(60)
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

  const all = useMemo(() => report?.recent ?? [], [report])
  // The choices each filter offers - what is actually in the log.
  const options = useMemo(() => {
    const uniq = (f) => [...new Set(all.map(f).filter((v) => v != null && v !== ''))].sort()
    return {
      kinds: uniq((c) => c.category),
      paths: uniq((c) => `${c.method} ${c.path}`),
      statuses: uniq((c) => String(c.status || 'no answer')),
      codes: uniq((c) => c.errorCode),
    }
  }, [all])

  const calls = useMemo(() => {
    const q = search.trim().toLowerCase()
    const since = report ? Math.max(...all.map((c) => new Date(c.at).getTime()), 0) - windowMin * 60_000 : 0
    return all.filter((c) => (result === 'All' || (result === 'Failed' ? !c.success : c.success))
      && new Date(c.at).getTime() >= since
      && (!kinds.length || kinds.includes(c.category))
      && (!paths.length || paths.includes(`${c.method} ${c.path}`))
      && (!statuses.length || statuses.includes(String(c.status || 'no answer')))
      && (!codes.length || codes.includes(c.errorCode))
      && (!q || `${c.path} ${c.context} ${c.error ?? ''} ${c.body ?? ''} ${c.response ?? ''}`.toLowerCase().includes(q)))
  }, [all, report, result, kinds, paths, statuses, codes, windowMin, search])

  // The causes behind the failures shown, most frequent first - the quickest way to see what to fix.
  const causes = useMemo(() => {
    const counts = new Map()
    for (const c of calls) if (!c.success) counts.set(c.diagnosis ?? c.error ?? 'unknown', (counts.get(c.diagnosis ?? c.error ?? 'unknown') ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [calls])

  const filtered = kinds.length || paths.length || statuses.length || codes.length || search || result !== 'Failed' || windowMin !== 60
  const clear = () => { setKinds([]); setPaths([]); setStatuses([]); setCodes([]); setSearch(''); setResult('Failed'); setWindowMin(60) }

  const columns = [
    { title: 'Time (IST)', dataIndex: 'at', width: 90, render: (t) => IST_TIME.format(new Date(t)) },
    { title: 'Kind', dataIndex: 'category', width: 100, render: (c) => <Tag color={CATEGORY_COLOR[c]}>{c}</Tag> },
    { title: 'Request', key: 'req', render: (_, c) => <span><Text code>{c.method} {c.path}</Text><br /><Text type="secondary" style={{ fontSize: 12 }}>{c.context}</Text></span> },
    {
      title: 'Answer', key: 'ans', width: 130,
      render: (_, c) => (
        <span>
          <Tag color={c.success ? 'green' : 'red'}>{c.success ? 'OK' : 'failed'}{c.status ? ` ${c.status}` : ''}</Tag>
          {c.errorCode && <Tag color="volcano">{c.errorCode}</Tag>}
          <br /><Text type="secondary" style={{ fontSize: 12 }}>{c.durationMs} ms</Text>
        </span>
      ),
    },
    { title: 'Error', key: 'err', render: (_, c) => (c.success ? null : <Text type="danger" style={{ fontSize: 12 }}>{c.error}</Text>) },
  ]

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={20} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>
        <Card
          title="Dhan calls - last hour"
          extra={(
            <Space wrap>
              <Space size={4}><Switch size="small" checked={auto} onChange={setAuto} /><Text type="secondary">every 5 s</Text></Space>
              <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={() => { setLoading(true); load() }}>Refresh</Button>
            </Space>
          )}
        >
          {error && <Alert type="error" showIcon message={`Could not load: ${error}`} style={{ marginBottom: 12 }} />}
          <Text type="secondary">
            Every request this server sent to Dhan&apos;s REST API (each attempt, retries included). Open a call to see the payload exactly as
            sent and Dhan&apos;s answer exactly as it came. Dhan allows 5 data calls and 10 orders a second for the whole account.
          </Text>
          <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
            <Col xs={12} md={6}><Statistic title="Last minute" value={report?.lastMinute ?? '-'} /></Col>
            <Col xs={12} md={6}><Statistic title="Last 15 minutes" value={report?.last15Minutes ?? '-'} /></Col>
            <Col xs={12} md={6}><Statistic title="Failed (hour)" value={report?.failed ?? '-'} valueStyle={report?.failed ? { color: '#ff4d4f' } : undefined} /></Col>
            <Col xs={12} md={6}><Statistic title="Repeated 3+ times" value={report?.repeated?.length ?? '-'} valueStyle={report?.repeated?.length ? { color: '#faad14' } : undefined} /></Col>
          </Row>
        </Card>

        <Card size="small" title="Filter" extra={filtered && <Button size="small" onClick={clear}>Clear filters</Button>}>
          <Space wrap>
            <Segmented value={result} onChange={setResult} options={['Failed', 'OK', 'All']} />
            <Segmented value={windowMin} onChange={setWindowMin} options={WINDOWS} />
            <Select mode="multiple" allowClear placeholder="Kind" value={kinds} onChange={setKinds} style={{ minWidth: 140 }} options={options.kinds.map((v) => ({ value: v, label: v }))} />
            <Select mode="multiple" allowClear placeholder="Endpoint" value={paths} onChange={setPaths} style={{ minWidth: 220 }} options={options.paths.map((v) => ({ value: v, label: v }))} />
            <Select mode="multiple" allowClear placeholder="HTTP status" value={statuses} onChange={setStatuses} style={{ minWidth: 130 }} options={options.statuses.map((v) => ({ value: v, label: v }))} />
            <Select mode="multiple" allowClear placeholder="Dhan error code" value={codes} onChange={setCodes} style={{ minWidth: 160 }} options={options.codes.map((v) => ({ value: v, label: v }))} />
            <Input.Search allowClear placeholder="strike, date, security id, error..." value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 260 }} />
          </Space>
        </Card>

        {causes.length > 0 && (
          <Card size="small" title="Why the calls shown failed">
            <Space direction="vertical" style={{ width: '100%' }}>
              {causes.map(([cause, n]) => <Text key={cause}><Tag color="red">{n}×</Tag>{cause}</Text>)}
            </Space>
          </Card>
        )}

        <Card size="small" title={`Calls (${calls.length})`}>
          <Table
            size="small" rowKey={(c, i) => `${c.at}-${i}`} dataSource={calls} columns={columns} scroll={{ x: 900 }}
            pagination={{ pageSize: 50, showSizeChanger: false }}
            expandable={{ expandedRowRender: (c) => <CallDetail call={c} /> }}
            locale={{ emptyText: result === 'Failed' && !filtered ? 'No failed calls in the last hour.' : 'No calls match the filters.' }}
          />
        </Card>

        <Card size="small" title="By endpoint">
          <Table
            size="small" rowKey={(e) => `${e.method} ${e.path}`} pagination={false} dataSource={report?.endpoints ?? []} scroll={{ x: true }}
            onRow={(e) => ({ onClick: () => setPaths([`${e.method} ${e.path}`]), style: { cursor: 'pointer' } })}
            columns={[
              { title: 'Kind', dataIndex: 'category', render: (c) => <Tag color={CATEGORY_COLOR[c]}>{c}</Tag> },
              { title: 'Endpoint', key: 'ep', render: (_, e) => <Text code>{e.method} {e.path}</Text> },
              { title: 'Last minute', dataIndex: 'lastMinute', align: 'right' },
              { title: '15 min', dataIndex: 'last15Minutes', align: 'right' },
              { title: 'Hour', dataIndex: 'lastHour', align: 'right' },
              { title: 'Failed', dataIndex: 'failed', align: 'right', render: (n) => (n ? <Text type="danger">{n}</Text> : 0) },
            ]}
          />
          <Text type="secondary" style={{ fontSize: 12 }}>Click an endpoint to show only its calls.</Text>
        </Card>

        {report?.repeated?.length > 0 && (
          <Card size="small" title="Repeated - the same request 3+ times (a loop?)">
            <Table
              size="small" rowKey="context" pagination={false} dataSource={report.repeated} scroll={{ x: true }}
              onRow={(r) => ({ onClick: () => { setSearch(r.context); setResult('All') }, style: { cursor: 'pointer' } })}
              columns={[
                { title: 'Request', dataIndex: 'context' },
                { title: 'Times', dataIndex: 'times', align: 'right' },
                { title: 'Failed', dataIndex: 'failed', align: 'right', render: (n) => (n ? <Text type="danger">{n}</Text> : 0) },
                { title: 'Last error', dataIndex: 'lastError', render: (e) => <Text type="danger" style={{ fontSize: 12 }}>{e}</Text> },
                { title: 'Last', dataIndex: 'lastAt', render: (t) => IST_TIME.format(new Date(t)) },
              ]}
            />
            <Text type="secondary" style={{ fontSize: 12 }}>Click a request to see every call of it.</Text>
          </Card>
        )}
      </Space>
    </div>
  )
}

// One call in full: what was sent, what Dhan answered, why it likely failed - and the lot as text for Dhan support.
function CallDetail({ call }) {
  const copy = () => {
    const text = [
      `Time: ${new Date(call.at).toISOString()} (${IST_TIME.format(new Date(call.at))} IST)`,
      `Request: ${call.method} https://api.dhan.co/v2${call.path}`,
      `Payload: ${call.body ?? '(none)'}`,
      `Answer: HTTP ${call.status || '-'} ${call.success ? 'OK' : ''}`,
      call.response ? `Dhan's response: ${call.response}` : `Error: ${call.error ?? ''}`,
    ].join('\n')
    navigator.clipboard?.writeText(text).then(() => message.success('Copied - paste it to Dhan support.'), () => message.error('Could not copy.'))
  }
  return (
    <Space direction="vertical" style={{ width: '100%' }} size={8}>
      <Descriptions size="small" column={{ xs: 1, md: 2 }} bordered>
        <Descriptions.Item label="Time">{IST_TIME.format(new Date(call.at))} IST ({new Date(call.at).toISOString()})</Descriptions.Item>
        <Descriptions.Item label="Took">{call.durationMs} ms</Descriptions.Item>
        <Descriptions.Item label="Request" span={2}><Text code>{call.method} https://api.dhan.co/v2{call.path}</Text></Descriptions.Item>
        <Descriptions.Item label="For" span={2}>{call.context}</Descriptions.Item>
        <Descriptions.Item label="HTTP status">{call.status || 'no answer'}</Descriptions.Item>
        <Descriptions.Item label="Dhan error code">{call.errorCode ?? '-'}</Descriptions.Item>
        {!call.success && <Descriptions.Item label="Error" span={2}><Text type="danger">{call.error}</Text></Descriptions.Item>}
        {call.diagnosis && <Descriptions.Item label="Likely cause" span={2}><Text strong>{call.diagnosis}</Text></Descriptions.Item>}
      </Descriptions>
      <div>
        <Text type="secondary" style={{ fontSize: 12 }}>Payload sent (the account&apos;s client id masked):</Text>
        <pre style={preStyle}>{pretty(call.body) ?? '(no body)'}</pre>
      </div>
      {!call.success && (
        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>Dhan&apos;s response, exactly as it came:</Text>
          <pre style={preStyle}>{pretty(call.response) ?? '(no response body)'}</pre>
        </div>
      )}
      <Button size="small" icon={<CopyOutlined />} onClick={copy}>Copy for Dhan support</Button>
    </Space>
  )
}

const preStyle = { margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 12, maxHeight: 280, overflow: 'auto', padding: 8, borderRadius: 6, background: 'rgba(127,127,127,0.08)' }

function pretty(body) {
  if (!body) return null
  try { return JSON.stringify(JSON.parse(body), null, 2) } catch { return body }
}
