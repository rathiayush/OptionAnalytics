// The admin CACHE page's pure parts (CachePage.jsx; the server's CacheBrowser / /api/cache): sizes in words, the folder
// trail, and what a delete is about to remove - so the confirm says exactly that.

/** Bytes as people read them: 0 B, 512 B, 1.5 KB, 12.3 MB, 4.07 GB (1024s). */
export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${Math.round(n)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let k = 0
  while (v >= 1024 && k < units.length - 1) { v /= 1024; k++ }
  return `${v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[k]}`
}

/** A count with its noun: 1 file, 2,345 files. */
export const countOf = (n, noun) => `${Number(n || 0).toLocaleString('en-IN')} ${noun}${Number(n) === 1 ? '' : 's'}`

/** The trail to a folder ('a/b/c' -> a, a/b, a/b/c), each with the path to open it. */
export function crumbsOf(path) {
  const parts = String(path ?? '').split('/').filter(Boolean)
  return parts.map((name, k) => ({ name, path: parts.slice(0, k + 1).join('/') }))
}

/** The folder above ('' at the top). */
export const parentOf = (path) => String(path ?? '').split('/').filter(Boolean).slice(0, -1).join('/')

/** What deleting an entry removes, in words - a file, or a folder with everything in it. */
export function deleteText(entry) {
  if (!entry) return ''
  return entry.folder
    ? `Delete the folder "${entry.name}" and everything in it - ${countOf(entry.files, 'file')}, ${formatBytes(entry.bytes)}?`
    : `Delete "${entry.name}" (${formatBytes(entry.bytes)})?`
}

/** What a delete did, for the message: "Deleted 12 files (3.4 MB)", and what could not be deleted. */
export function deletedText(result) {
  if (!result) return ''
  const done = `Deleted ${countOf(result.files, 'file')} (${formatBytes(result.bytes)})`
  return result.failed > 0 ? `${done} - ${countOf(result.failed, 'item')} could not be deleted: ${result.firstError ?? 'no reason given'}` : done
}

/** The listing's rows sorted: folders first, then by the column asked (name / bytes / modified), largest / newest first
 *  for size and time. */
export function sortEntries(entries, by = 'name') {
  const list = [...(entries ?? [])]
  const cmp = {
    name: (a, b) => a.name.localeCompare(b.name),
    bytes: (a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name),
    modified: (a, b) => String(b.modifiedUtc ?? '').localeCompare(String(a.modifiedUtc ?? '')) || a.name.localeCompare(b.name),
  }[by] ?? ((a, b) => a.name.localeCompare(b.name))
  return list.sort((a, b) => (a.folder === b.folder ? cmp(a, b) : a.folder ? -1 : 1))
}

/** Where a download comes from: a file as it is, a folder ('' = the whole cache) as one zip; every cache in one zip. */
export const downloadUrl = (root, path) => `/api/cache/${encodeURIComponent(root)}/download?path=${encodeURIComponent(path ?? '')}`
export const EVERYTHING_URL = '/api/cache/everything.zip'

/** What a download is about to fetch, in words - so a big zip is never a surprise. */
export function downloadText(entry) {
  if (!entry) return ''
  return entry.folder
    ? `Download "${entry.name}" as one zip - ${countOf(entry.files, 'file')}, ${formatBytes(entry.bytes)}?`
    : `Download "${entry.name}" (${formatBytes(entry.bytes)})?`
}
