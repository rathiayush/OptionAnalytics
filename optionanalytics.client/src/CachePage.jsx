import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Breadcrumb, Button, Card, Col, Popconfirm, Row, Segmented, Space, Statistic, Table, Tag, Typography, message } from 'antd'
import { ArrowUpOutlined, DeleteOutlined, DownloadOutlined, FileOutlined, FolderOutlined, HomeOutlined, ReloadOutlined } from '@ant-design/icons'
import { NavBar, useMediaQuery, usePersistedState } from './shared.jsx'
import { EVERYTHING_URL, countOf, crumbsOf, deleteText, deletedText, downloadText, downloadUrl, formatBytes, parentOf, sortEntries } from './cacheBrowser.js'

const { Title, Text } = Typography

// The admin CACHE page (asked for - "a page to see all the cache files and manage them; I can delete ... delete folder"):
// the server's data caches (GET /api/cache - CacheBrowser): the Dhan data cache, the Order Flow days, the Expired
// Backtest's CSVs - each with its size; open one and walk its folders, each with what is under it; delete a file, a
// folder and everything in it, or everything in a cache - each confirmed, with what it will remove. Everything here can be
// fetched again (the confirm says how); settings, strategies, preferences and logs are not caches and are not listed.
// DOWNLOAD (asked for - "give option to download whole data as zip"): a file as it is, a folder / a whole cache as one
// zip, or every cache in one zip - a zip confirmed first with its size; the server writes it as it reads (no copy on its
// disk), so the browser's own download shows it coming in.
// No timer: loaded on opening, after a delete and by Refresh.

const TIME = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })
const fmtTime = (iso) => (iso ? TIME.format(new Date(iso)) : '—')

async function api(url, options) {
  const r = await fetch(url, options)
  const text = await r.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { /* not JSON */ }
  if (!r.ok) throw new Error(body?.error ?? `HTTP ${r.status}`)
  return body
}
// A download the browser saves (the server answers it as an attachment) - the page stays where it is.
function startDownload(url) {
  const a = document.createElement('a')
  a.href = url
  a.download = ''
  document.body.appendChild(a)
  a.click()
  a.remove()
}
const listUrl = (root, path) => `/api/cache/${encodeURIComponent(root)}?path=${encodeURIComponent(path ?? '')}`
const deleteUrl = (root, path) => (path ? listUrl(root, path) : `/api/cache/${encodeURIComponent(root)}?all=true`)

export default function CachePage() {
  const narrow = useMediaQuery('(max-width: 768px)')
  const [roots, setRoots] = useState(null)
  const [rootsError, setRootsError] = useState(null)
  const [rootId, setRootId] = usePersistedState('optionanalytics.cache.root', 'dhan')
  const [path, setPath] = useState('')
  // The listing answered for (root|path|nonce) - kept on screen while the next loads; Refresh / a delete bumps the nonce.
  const [loaded, setLoaded] = useState({ key: null, listing: null, error: null })
  const [nonce, setNonce] = useState(0)
  const [busy, setBusy] = useState(null)
  const [sortBy, setSortBy] = usePersistedState('optionanalytics.cache.sort', 'name')

  const loadRoots = useCallback(() => api('/api/cache')
    .then((body) => { setRoots(body?.roots ?? []); setRootsError(null) })
    .catch((err) => setRootsError(err.message)), [])

  useEffect(() => { loadRoots() }, [loadRoots])
  // The cache open: the one picked - one not on this server falls back to the first kept on disk.
  const root = roots?.find((r) => r.id === rootId) ?? roots?.find((r) => r.exists) ?? roots?.[0] ?? null
  const rootOpen = root?.exists ? root.id : null
  const askKey = rootOpen ? `${rootOpen}|${path}|${nonce}` : null
  useEffect(() => {
    if (!rootOpen) return undefined
    let cancelled = false
    const key = `${rootOpen}|${path}|${nonce}`
    api(listUrl(rootOpen, path))
      .then((body) => { if (!cancelled) setLoaded({ key, listing: body, error: null }) })
      .catch((err) => { if (!cancelled) setLoaded({ key, listing: null, error: err.message }) })
    return () => { cancelled = true }
  }, [rootOpen, path, nonce])
  const loading = askKey != null && loaded.key !== askKey
  const listing = loaded.listing
  const listError = loaded.key === askKey ? loaded.error : null

  const open = (id, at = '') => { setRootId(id); setPath(at) }
  const refresh = () => { loadRoots(); setNonce((n) => n + 1) }
  const remove = async (entryPath, label) => {
    setBusy(entryPath || '*')
    try {
      const result = await api(deleteUrl(root.id, entryPath), { method: 'DELETE' })
      if (result?.failed > 0) message.warning(deletedText(result), 8)
      else message.success(`${label}: ${deletedText(result)}`)
    } catch (err) {
      message.error(err.message)
    } finally {
      setBusy(null)
      // A folder deleted while open: back to the folder above it.
      if (entryPath && (path === entryPath || path.startsWith(`${entryPath}/`))) setPath(parentOf(entryPath))
      loadRoots()
      setNonce((n) => n + 1)
    }
  }

  const entries = useMemo(() => sortEntries(listing?.entries, sortBy), [listing, sortBy])
  const deleteButton = (e) => (
    <Popconfirm title={deleteText(e)} description="It is fetched again the next time it is needed." okText="Delete" okButtonProps={{ danger: true }}
      onConfirm={() => remove(e.path, e.name)}>
      <Button size="small" danger type="text" icon={<DeleteOutlined />} loading={busy === e.path} aria-label={`Delete ${e.name}`} title={`Delete ${e.name}`} />
    </Popconfirm>
  )
  const downloadButton = (e) => (e.folder
    ? (
      <Popconfirm title={downloadText(e)} okText="Download" onConfirm={() => startDownload(downloadUrl(root.id, e.path))}>
        <Button size="small" type="text" icon={<DownloadOutlined />} aria-label={`Download ${e.name}`} title={`Download ${e.name} as a zip`} />
      </Popconfirm>
    )
    : <Button size="small" type="text" icon={<DownloadOutlined />} href={downloadUrl(root.id, e.path)} download aria-label={`Download ${e.name}`} title={`Download ${e.name}`} />)
  const nameCell = (e) => (
    <Space size={6} style={{ minWidth: 0 }}>
      {e.folder ? <FolderOutlined style={{ color: '#d4b106' }} /> : <FileOutlined style={{ opacity: 0.6 }} />}
      {e.folder
        ? <a onClick={() => setPath(e.path)} style={{ wordBreak: 'break-all' }}>{e.name}</a>
        : <Text style={{ wordBreak: 'break-all' }}>{e.name}</Text>}
    </Space>
  )
  const columns = [
    { title: 'Name', key: 'name', render: (_, e) => nameCell(e) },
    { title: 'What it is', dataIndex: 'about', key: 'about', render: (v) => (v ? <Text type="secondary" style={{ fontSize: 12 }}>{v}</Text> : null) },
    { title: 'Size', dataIndex: 'bytes', key: 'bytes', width: 100, align: 'right', render: (v) => formatBytes(v) },
    { title: 'Files', key: 'files', width: 90, align: 'right', render: (_, e) => (e.folder ? Number(e.files).toLocaleString('en-IN') : '') },
    { title: 'Last changed', dataIndex: 'modifiedUtc', key: 'modified', width: 170, render: (v) => <Text style={{ fontSize: 12 }}>{fmtTime(v)}</Text> },
    { title: '', key: 'actions', width: 80, align: 'center', render: (_, e) => <Space size={0}>{downloadButton(e)}{deleteButton(e)}</Space> },
  ]

  const rootCard = (r) => {
    const selected = r.id === root?.id
    return (
      <Col key={r.id} xs={24} sm={12} xl={6}>
        <Card size="small" hoverable={r.exists} onClick={() => r.exists && open(r.id)}
          style={{ height: '100%', borderColor: selected ? '#1677ff' : undefined, opacity: r.exists ? 1 : 0.6 }}
          title={<Space size={6}><span>{r.name}</span>{selected && <Tag color="blue" style={{ margin: 0 }}>open</Tag>}</Space>}>
          {r.exists
            ? (
              <Space direction="vertical" size={4} style={{ width: '100%' }}>
                <Space size={24} wrap>
                  <Statistic title="Size" value={formatBytes(r.totals.bytes)} />
                  <Statistic title="Files" value={Number(r.totals.files).toLocaleString('en-IN')} />
                </Space>
                <Text type="secondary" style={{ fontSize: 11 }}>Newest {fmtTime(r.totals.newestUtc)} · oldest {fmtTime(r.totals.oldestUtc)}</Text>
                <Text type="secondary" style={{ fontSize: 11, wordBreak: 'break-all' }}>{r.path}</Text>
                <span onClick={(ev) => ev.stopPropagation()}>
                  <Popconfirm title={downloadText({ name: r.name, folder: true, files: r.totals.files, bytes: r.totals.bytes })} okText="Download"
                    onConfirm={() => startDownload(downloadUrl(r.id, ''))} disabled={!r.totals.files}>
                    <Button size="small" icon={<DownloadOutlined />} disabled={!r.totals.files}>Download zip</Button>
                  </Popconfirm>
                </span>
              </Space>
            )
            : <Text type="secondary" style={{ fontSize: 12 }}>Not kept on disk on this server.</Text>}
        </Card>
      </Col>
    )
  }

  const trail = [
    { title: <a onClick={() => setPath('')}><HomeOutlined /> {root?.name ?? 'Cache'}</a> },
    ...crumbsOf(path).map((c, k, all) => ({ title: k === all.length - 1 ? <Text strong>{c.name}</Text> : <a onClick={() => setPath(c.path)}>{c.name}</a> })),
  ]
  const here = listing?.totals
  const everything = (roots ?? []).filter((r) => r.exists).reduce((a, r) => ({ files: a.files + r.totals.files, bytes: a.bytes + r.totals.bytes }), { files: 0, bytes: 0 })
  const emptyLabel = path ? `Delete this folder` : `Empty ${root?.name ?? 'this cache'}`

  // On a phone the actions go in the card's body, not its header: beside the title they squeezed it to nothing (the
  // folder's trail could not be seen or tapped).
  const topActions = (
    <Space size={6} wrap>
      <Popconfirm
        title={`Download EVERY cache as one zip - ${countOf(everything.files, 'file')}, ${formatBytes(everything.bytes)}?`}
        description="Each cache is its own folder in it. A big one takes a while - the browser shows it coming in."
        okText="Download" onConfirm={() => startDownload(EVERYTHING_URL)} disabled={!everything.files}>
        <Button size="small" icon={<DownloadOutlined />} disabled={!everything.files}>Download everything</Button>
      </Popconfirm>
      <Button size="small" icon={<ReloadOutlined />} onClick={refresh}>Refresh</Button>
    </Space>
  )
  const folderActions = root?.exists && (
    <Space size={6} wrap>
      {path && <Button size="small" icon={<ArrowUpOutlined />} onClick={() => setPath(parentOf(path))}>Up</Button>}
      <Popconfirm title={downloadText({ name: path ? crumbsOf(path).at(-1)?.name : root.name, folder: true, files: here?.files, bytes: here?.bytes })}
        okText="Download" onConfirm={() => startDownload(downloadUrl(root.id, path))} disabled={!here?.files}>
        <Button size="small" icon={<DownloadOutlined />} disabled={!here?.files}>Download zip</Button>
      </Popconfirm>
      <Popconfirm
        title={path ? deleteText({ name: crumbsOf(path).at(-1)?.name, folder: true, files: here?.files, bytes: here?.bytes }) : `Delete EVERYTHING in ${root.name} - ${countOf(here?.files, 'file')}, ${formatBytes(here?.bytes)}?`}
        description={path ? 'It is fetched again the next time it is needed.' : 'The folder stays, empty; every day in it is fetched again the next time it is needed.'}
        okText={path ? 'Delete' : 'Empty it'} okButtonProps={{ danger: true }} onConfirm={() => remove(path, path ? crumbsOf(path).at(-1)?.name : root.name)}
        disabled={!here?.files && !listing?.entries?.length}>
        <Button size="small" danger icon={<DeleteOutlined />} loading={busy === (path || '*')} disabled={!here?.files && !listing?.entries?.length}>{emptyLabel}</Button>
      </Popconfirm>
    </Space>
  )

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: narrow ? '16px 8px' : '24px 16px' }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space align="center" size={16} wrap>
          <Title level={3} style={{ margin: 0 }}>Option Analytics</Title>
          <NavBar />
        </Space>

        <Card size="small" title="Cache - the server's data caches" extra={narrow ? null : topActions}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {narrow && topActions}
            <Text type="secondary" style={{ fontSize: 12 }}>
              Everything here is data the server can fetch again - a day deleted is asked of Dhan (or NSE) again the next time it
              is needed. Settings, saved strategies, preferences and logs are not caches and are not listed.
            </Text>
            {rootsError && <Alert type="error" showIcon message={`Could not load the caches: ${rootsError}`} />}
            <Row gutter={[12, 12]}>{(roots ?? []).map(rootCard)}</Row>
            {root?.about && <Text type="secondary" style={{ fontSize: 12 }}>{root.about}</Text>}
          </Space>
        </Card>

        {root?.exists && (
          <Card size="small"
            title={<Breadcrumb items={trail} />}
            extra={narrow ? null : folderActions}>
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              {narrow && folderActions}
              <Space size={12} wrap>
                <Text style={{ fontSize: 12 }}>{here ? `${countOf(here.files, 'file')} · ${formatBytes(here.bytes)} in this folder` : ' '}</Text>
                <Segmented size="small" value={sortBy} onChange={setSortBy}
                  options={[{ value: 'name', label: 'Name' }, { value: 'bytes', label: 'Largest' }, { value: 'modified', label: 'Newest' }]} />
              </Space>
              {listError && <Alert type="error" showIcon message={listError} action={<Button size="small" onClick={() => setPath('')}>Back to the top</Button>} />}
              {listing?.truncated && <Alert type="info" showIcon message={`This folder has ${listing.truncated.toLocaleString('en-IN')} entries - the first ${listing.entries.length.toLocaleString('en-IN')} are listed.`} />}
              {narrow
                ? (
                  <div>
                    {!entries.length && !loading && <Text type="secondary" style={{ fontSize: 12 }}>Empty.</Text>}
                    {entries.map((e) => (
                      <div key={e.path} className="oa-bg-run">
                        <Space size={6} style={{ justifyContent: 'space-between', width: '100%' }}>
                          {nameCell(e)}
                          <Space size={0}>{downloadButton(e)}{deleteButton(e)}</Space>
                        </Space>
                        <Text style={{ fontSize: 12 }}>{formatBytes(e.bytes)}{e.folder ? ` · ${countOf(e.files, 'file')}` : ''} · {fmtTime(e.modifiedUtc)}</Text>
                        {e.about && <Text type="secondary" style={{ fontSize: 11 }}>{e.about}</Text>}
                      </div>
                    ))}
                  </div>
                )
                : (
                  <Table size="small" rowKey="path" columns={columns} dataSource={entries} loading={loading}
                    pagination={{ pageSize: 100, hideOnSinglePage: true, showSizeChanger: false }} tableLayout="fixed"
                    locale={{ emptyText: 'Empty.' }} />
                )}
            </Space>
          </Card>
        )}
      </Space>
    </div>
  )
}
