// Helpers for the Data files page (DataFilesPage.jsx): sizes in words, and a CSV read into a header and rows.

/** 1536 -> "1.5 KB". */
export function bytesText(n) {
  const v = Number(n) || 0
  if (v < 1024) return `${v} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let x = v / 1024
  let i = 0
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++ }
  return `${x >= 100 ? Math.round(x) : x.toFixed(1)} ${units[i]}`
}

/** A CSV text -> { header, rows } (quoted fields, "" inside quotes, CRLF). `partialLastLine`: the text was cut off
 *  part-way, so its last line is dropped rather than shown half. */
export function parseCsv(text, { partialLastLine = false } = {}) {
  const records = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false
      } else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      records.push(row)
      row = []
      field = ''
    } else field += c
  }
  const ended = row.length === 0 && field === ''
  if (!ended) { row.push(field); if (!partialLastLine) records.push(row) } else if (partialLastLine && records.length > 1 && !/[\r\n]$/.test(text)) records.pop()
  const clean = records.filter((r) => !(r.length === 1 && r[0] === ''))
  return { header: clean[0] ?? [], rows: clean.slice(1) }
}
