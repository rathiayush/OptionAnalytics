// The server's files, for the admin: the scanner log (CSV), the cached API data (the tuning's cache of the days it
// fetched, spot candles, expired options), the tuning's results / history and the settings / state files - listed,
// browsed, read (a CSV as a table, JSON indented) and downloaded. Read-only (GET /api/data-files - DataFilesService).
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Alert, Breadcrumb, Button, Card, Input, Space, Table, Tag, Tooltip, Typography } from 'antd'
import { DownloadOutlined, FileOutlined, FolderOutlined, ReloadOutlined } from '@ant-design/icons'
import { NavBar, useAuth } from './shared.jsx'
import { bytesText, parseCsv } from './dataFiles.js'

const { Title, Text } = Typography

const when = (t) => (t ? new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-')
const getJson = async (url) => {
  const res = await fetch(url)
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(body?.error ?? body?.detail ?? `HTTP ${res.status}`)
  return body
}
const fileUrl = (key, path, what) => `/api/data-files/${encodeURIComponent(key)}/${what}?${new URLSearchParams({ path: path ?? '' })}`

function FileView({ place, path }) {
  const [view, setView] = useState(null)
  const [error, setError] = useState(null)
  const [bytes, setBytes] = useState(256 * 1024)
  const [search, setSearch] = useState('')
  useEffect(() => {
    let off = false
    getJson(`${fileUrl(place.key, path, 'view')}&bytes=${bytes}`)
      .then((v) => { if (!off) { setView(v); setError(null) } })
      .catch((err) => { if (!off) setError(err.message) })
    return () => { off = true }
  }, [place.key, path, bytes])
  const table = useMemo(() => (view?.kind === 'csv' && view.text ? parseCsv(view.text, { partialLastLine: view.truncated }) : null), [view])
  const rows = useMemo(() => {
    if (!table) return []
    const q = search.trim().toLowerCase()
    return table.rows.map((r, i) => ({ key: i, ...Object.fromEntries(table.header.map((h, j) => [`c${j}`, r[j] ?? ''])) }))
      .filter((r) => !q || Object.values(r).some((v) => String(v).toLowerCase().includes(q)))
  }, [table, search])
  return (
    <Card size="small" title={<Space size={6} wrap><FileOutlined /><b>{view?.name ?? path.split('/').pop()}</b>{view?.gzip && <Tag>gzip - shown unzipped</Tag>}{view && <Text type="secondary" style={{ fontSize: 12 }}>{bytesText(view.bytes)} · {when(view.modifiedUtc)}</Text>}</Space>}
      extra={<Space size={8}>{view?.truncated && bytes < 2 * 1024 * 1024 && <Button size="small" onClick={() => setBytes(2 * 1024 * 1024)}>Show more (2 MB)</Button>}<Button size="small" icon={<DownloadOutlined />} href={fileUrl(place.key, path, 'download')}>Download</Button></Space>}>
      {error && <Alert type="error" showIcon message={`Not read: ${error}`} />}
      {!view && !error && <Text type="secondary">reading…</Text>}
      {view?.truncated && <Alert type="info" showIcon style={{ marginBottom: 8 }} message={`The first ${bytesText(bytes)} of it - download it for the whole file.`} />}
      {view?.kind === 'binary' && <Text type="secondary">Not a text file - download it to open it.</Text>}
      {table && (
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Input allowClear size="small" placeholder="Filter the rows" value={search} onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 320 }} aria-label="Filter rows" />
          <Text type="secondary" style={{ fontSize: 12 }}>{rows.length} of {table.rows.length} row(s){view.truncated ? ' read so far' : ''}</Text>
          <Table size="small" dataSource={rows} pagination={{ pageSize: 50, showSizeChanger: true, pageSizeOptions: [50, 100, 500] }} scroll={{ x: 'max-content' }}
            columns={table.header.map((h, j) => ({ title: h || `col ${j + 1}`, dataIndex: `c${j}`, key: `c${j}`, ellipsis: true, width: Math.min(260, Math.max(80, h.length * 9)) }))} aria-label="File rows" />
        </Space>
      )}
      {view && view.kind !== 'csv' && view.kind !== 'binary' && (
        <pre style={{ maxHeight: 560, overflow: 'auto', fontSize: 12, margin: 0, padding: 8, background: '#00000033', borderRadius: 4, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{view.text}</pre>
      )}
    </Card>
  )
}

export default function DataFilesPage() {
  const auth = useAuth()
  const isAdmin = auth?.user?.role === 'Admin'
  const location = useLocation()
  const navigate = useNavigate()
  const q = new URLSearchParams(location.search)
  const placeKey = q.get('place')
  const dir = q.get('path') ?? ''
  const file = q.get('file')
  const go = (patch) => {
    const next = new URLSearchParams({ ...(placeKey ? { place: placeKey } : {}), ...(dir ? { path: dir } : {}), ...(file ? { file } : {}) })
    for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') next.delete(k); else next.set(k, v) }
    navigate(`/data-files?${next}`)
  }

  const [places, setPlaces] = useState(null)
  const [entries, setEntries] = useState(null)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('')
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!isAdmin) return
    getJson('/api/data-files').then((b) => { setPlaces(b.places); setError(null) }).catch((err) => setError(err.message))
  }, [isAdmin, tick])
  const place = places?.find((p) => p.key === placeKey) ?? null
  useEffect(() => {
    if (!isAdmin || !placeKey) return
    let off = false
    getJson(`/api/data-files/${encodeURIComponent(placeKey)}?${new URLSearchParams({ path: dir })}`)
      .then((b) => { if (!off) { setEntries(b.entries); setError(null) } })
      .catch((err) => { if (!off) { setEntries([]); setError(err.message) } })
    return () => { off = true }
  }, [isAdmin, placeKey, dir, tick])

  const crumbs = dir ? dir.split('/') : []
  const shown = (entries ?? []).filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()))
  const size = (r) => `${bytesText(r.bytes)}${r.partial ? '+' : ''}`

  return (
    <div style={{ maxWidth: 1600, margin: '0 auto', padding: '24px 16px' }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>
        {!isAdmin && <Alert type="info" showIcon message="Sign in with the admin login to see the server's files." />}
        {isAdmin && (
          <Card size="small" title="Data files · what the server keeps" extra={<Button size="small" icon={<ReloadOutlined />} onClick={() => setTick((x) => x + 1)}>Refresh</Button>}>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Text type="secondary" style={{ fontSize: 12 }}>
                The scanner log CSVs, the cached API data (the tuning&apos;s cache of the days it fetched from Dhan, the spot candles, the expired options), the
                tuning&apos;s results and history, and the settings / state files. Read-only: open a folder, click a file to read it (a CSV as a table, JSON
                indented, a .gz unzipped) or download it. Files that could hold a secret are never shown.
              </Text>
              {error && !placeKey && <Alert type="error" showIcon message={`Not read: ${error}`} />}
              <Table size="small" rowKey="key" dataSource={places ?? []} loading={!places && !error} pagination={false} scroll={{ x: 900 }} aria-label="Data places"
                rowClassName={(r) => (r.key === placeKey ? 'ant-table-row-selected' : '')}
                columns={[
                  { title: 'Place', key: 'name', render: (_, r) => <Space direction="vertical" size={0}><Space size={6}>{r.isDirectory ? <FolderOutlined /> : <FileOutlined />}<b>{r.name}</b>{!r.exists && <Tag>not there yet</Tag>}</Space><Text type="secondary" style={{ fontSize: 11 }}>{r.what}</Text></Space> },
                  { title: 'On the server', dataIndex: 'path', width: 300, render: (p) => <Text code style={{ fontSize: 11 }}>{p}</Text> },
                  { title: 'Files', dataIndex: 'files', width: 80, render: (v, r) => `${v}${r.partial ? '+' : ''}` },
                  { title: 'Size', key: 'bytes', width: 100, render: (_, r) => size(r) },
                  { title: 'Newest', dataIndex: 'modifiedUtc', width: 130, render: when },
                  { title: '', key: 'open', width: 80, render: (_, r) => r.exists && <Button size="small" type={r.key === placeKey ? 'primary' : 'default'} onClick={() => go({ place: r.key, path: null, file: null })}>Open</Button> },
                ]} />
            </Space>
          </Card>
        )}
        {isAdmin && place && (
          <Card size="small"
            title={(
              <Breadcrumb items={[
                { title: <a onClick={() => go({ place: null, path: null, file: null })}>Data files</a> },
                { title: <a onClick={() => go({ path: null, file: null })}>{place.name}</a> },
                ...crumbs.map((c, i) => ({ title: <a onClick={() => go({ path: crumbs.slice(0, i + 1).join('/'), file: null })}>{c}</a> })),
              ]} />
            )}
            extra={place.isDirectory && <Input allowClear size="small" placeholder="Filter by name" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 220 }} aria-label="Filter files" />}>
            {error && <Alert type="error" showIcon message={`Not read: ${error}`} style={{ marginBottom: 8 }} />}
            {place.isDirectory && (
              <Table size="small" rowKey="path" dataSource={shown} loading={entries == null} pagination={{ pageSize: 100, hideOnSinglePage: true }} scroll={{ x: 700 }} aria-label="Folder entries"
                onRow={(r) => ({ onClick: () => (r.isDirectory ? go({ path: r.path, file: null }) : go({ file: r.path })), style: { cursor: 'pointer' } })}
                rowClassName={(r) => (r.path === file ? 'ant-table-row-selected' : '')}
                columns={[
                  { title: 'Name', key: 'name', render: (_, r) => <Space size={6}>{r.isDirectory ? <FolderOutlined /> : <FileOutlined />}<span>{r.name}</span></Space>, sorter: (a, b) => a.name.localeCompare(b.name) },
                  { title: <Tooltip title="Files inside (a folder: all of them, under it)">Files</Tooltip>, key: 'files', width: 90, render: (_, r) => (r.isDirectory ? `${r.files}${r.partial ? '+' : ''}` : '') },
                  { title: 'Size', key: 'bytes', width: 110, render: (_, r) => size(r), sorter: (a, b) => a.bytes - b.bytes },
                  { title: 'Changed', dataIndex: 'modifiedUtc', width: 140, render: when, sorter: (a, b) => Date.parse(a.modifiedUtc ?? 0) - Date.parse(b.modifiedUtc ?? 0), defaultSortOrder: null },
                ]} />
            )}
          </Card>
        )}
        {isAdmin && place && (!place.isDirectory || file) && <FileView key={`${place.key}:${file ?? ''}`} place={place} path={place.isDirectory ? file : ''} />}
      </Space>
    </div>
  )
}
