// THE TELEGRAM SIGNALS page's maths (asked for - "a page which will read the messages and show me how the price reacts after
// those signals ... the exact same messages that go from the code"): every Telegram message the app sent (the server's log,
// GET /api/telegram-log - or a Telegram Desktop export of the channel, imported on the page) read back as a SIGNAL - its
// index, its kind, its direction (+1 bullish / −1 bearish / 0 none) and its price where it names one - then the index's
// spot 1-minute bars after it: how far price moved 5 / 15 / 30 / 60 minutes later, in the signal's direction, and the best
// and worst it got in the hour. Nothing after a signal is used to read the signal itself; the reaction is, by design, what
// came after. `tests/telegram-signals.test.mjs`.

const MIN = 60_000
const IST_MS = 330 * MIN

export const HORIZONS = [5, 15, 30, 60]
export const REACTION_WINDOW = 60

/** The kinds of message, in the order the page lists them. `signal: false` - an exit / report / info: no direction. */
export const SIGNAL_KINDS = [
  { id: 'iceberg', label: '🧊 Iceberg' },
  { id: 'bigOrder', label: '🐋 Big order' },
  { id: 'highProb', label: '🎯 High probability' },
  { id: 'oiBreak', label: '🧱 OI S/R break' },
  { id: 'suddenWall', label: '🧱 Sudden OI wall' },
  { id: 'scanner', label: 'Scanner signal' },
  { id: 'paper', label: 'Scanner paper trade' },
  { id: 'strategy', label: 'Saved strategy entry' },
  { id: 'liveOrder', label: 'Live order' },
  { id: 'confluence', label: 'Confluence' },
  { id: 'divergence', label: 'OI divergence' },
  { id: 'profile', label: '📊 Profile level' },
  { id: 'price', label: '🔔 Price alert' },
  { id: 'trigger', label: 'Trigger' },
  { id: 'other', label: 'Other' },
  { id: 'exit', label: 'Exits, reports, info', signal: false },
]
export const KIND_LABEL = Object.fromEntries(SIGNAL_KINDS.map((k) => [k.id, k.label]))
/** The kinds the page shows by default - every one with a direction to measure. */
export const DEFAULT_KINDS = SIGNAL_KINDS.filter((k) => k.signal !== false && k.id !== 'other').map((k) => k.id)

const istDate = (ms) => new Date(ms + IST_MS).toISOString().slice(0, 10)

/** The index a message is about: named (BANKNIFTY before NIFTY - "\bNIFTY\b" never matches inside it), else guessed from a
 *  price in it (`guessed`). */
export function messageIndex(text) {
  const named = String(text ?? '').match(/\b(BANKNIFTY|SENSEX|NIFTY)\b/i)
  if (named) return { index: named[1].toUpperCase(), guessed: false }
  // A profile alert names its market (futures / spot), not the index: its price says which.
  for (const m of String(text ?? '').matchAll(/\b(\d{5})(?:\.\d+)?\b/g)) {
    const p = Number(m[1])
    if (p >= 15000 && p < 38000) return { index: 'NIFTY', guessed: true }
    if (p >= 38000 && p < 68000) return { index: 'BANKNIFTY', guessed: true }
    if (p >= 68000 && p < 120000) return { index: 'SENSEX', guessed: true }
  }
  return { index: null, guessed: false }
}

// An option trade's direction: buying a call / selling a put is bullish, buying a put / selling a call bearish.
function optionDir(text) {
  const m = String(text).match(/\b(BUY|SELL)\b[^\n]*?\b\d{4,6}\s*(CE|PE)\b/i)
  if (!m) return 0
  return (m[1].toUpperCase() === 'BUY' ? 1 : -1) * (m[2].toUpperCase() === 'CE' ? 1 : -1)
}
// The words a message says its side with.
function wordDir(text) {
  const t = String(text)
  if (/\bbullish\b/i.test(t)) return 1
  if (/\bbearish\b/i.test(t)) return -1
  if (/\bLONG\b/.test(t)) return 1
  if (/\bSHORT\b/.test(t)) return -1
  return optionDir(t)
}
const num = (v) => { const n = Number(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : null }

/**
 * A message read back as signals: [{ time (ms), index, guessed, kind, dir, price, text, server }] - usually one; a big
 * order message listing several prints gives one a print, each at its own time. `time` - when the message went (ms).
 */
export function parseMessage(rawText, time) {
  const raw = String(rawText ?? '').trim()
  const server = /^\[Server\]\s*/.test(raw)
  const text = raw.replace(/^\[Server\]\s*/, '')
  const { index, guessed } = messageIndex(text)
  const one = (kind, dir = 0, price = null, at = time) => [{ time: at, index, guessed, kind, dir, price, text: raw, server }]

  // Exits, reports, results - no direction to measure.
  if (/^(✅|❌|⚠️|⚪|🔬)/u.test(text) || /\b(Paper exit|LIVE exit|Target hit|Stop loss hit|Trailing SL hit|Time exit|square-off)\b/i.test(text)
    || /\bout of\b/i.test(text) || /\b(No trades today|Daily report|backtest done|Kill switch)\b/i.test(text)) return one('exit')
  if (/iceberg/i.test(text)) {
    const dir = /hidden\s+BUYER/i.test(text) ? 1 : /hidden\s+SELLER/i.test(text) ? -1 : 0
    return one('iceberg', dir, num(text.match(/\b(?:bid|offer)\s+([\d,.]+)/i)?.[1]))
  }
  if (/big orders?\b/i.test(text)) {
    const day = istDate(time)
    const prints = [...text.matchAll(/\b(BUY|SELL)\s+([\d,.]+)\s+lots?\s+@\s+([\d,.]+)(?:\s*·\s*(\d{2}):(\d{2}):(\d{2}))?/gi)]
    if (!prints.length) return one('bigOrder')
    return prints.map((m) => {
      const at = m[4] != null ? Date.parse(`${day}T${m[4]}:${m[5]}:${m[6]}+05:30`) : time
      return { time: Number.isFinite(at) ? at : time, index, guessed, kind: 'bigOrder', dir: m[1].toUpperCase() === 'BUY' ? 1 : -1, price: num(m[3]), text: raw, server, lots: num(m[2]) }
    })
  }
  const hp = text.match(/HIGH PROBABILITY\s+(BULLISH|BEARISH)/i)
  if (hp) return one('highProb', hp[1].toUpperCase() === 'BULLISH' ? 1 : -1)
  if (/Sudden OI wall/i.test(text)) return one('suddenWall', /\bsupport\b/i.test(text) ? 1 : /\bresistance\b/i.test(text) ? -1 : 0)
  if (/cumulative\s+Δ\s+broke/i.test(text) || /^🧱/u.test(text)) {
    const dir = /🟢/u.test(text) ? 1 : /🔴/u.test(text) ? -1 : wordDir(text)
    return one('oiBreak', dir)
  }
  if (/^\[Confluence\]/i.test(text)) return one('confluence', wordDir(text))
  if (/^\[OI divergence\]/i.test(text)) return one('divergence', wordDir(text))
  if (/Price alert/i.test(text)) return one('price', /\brose\b/i.test(text) ? 1 : /\bfell\b/i.test(text) ? -1 : 0, num(text.match(/\b(?:rose|fell) to\s+([\d,.]+)/i)?.[1]))
  if (/^📊/u.test(text)) {
    if (/\b(reached|entered)\b/i.test(text)) return one('profile', 0, num(text.match(/\b(?:futures|spot)\s+([\d,.]+)/i)?.[1]))
    return one('exit')
  }
  if (/LIVE order/i.test(text)) return one('liveOrder', optionDir(text))
  if (/^Paper\s+(BUY|SELL)\b/i.test(text)) return one('paper', optionDir(text))
  if (/^🟢/u.test(text) && optionDir(text)) return one('strategy', optionDir(text))
  if (/#\d+\s.+\b(LONG|SHORT)\b/.test(text)) return one('scanner', /\bLONG\b/.test(text) ? 1 : -1, num(text.match(/futures\s+([\d,.]+)/i)?.[1]))
  if (/^\[Trigger\]/i.test(text)) return one('trigger', wordDir(text))
  return one('other', wordDir(text))
}

/** A Telegram Desktop export of the channel ("Export chat history", JSON - result.json) as [{ time (ms), text }]: its
 *  service messages left out, a message's text pieces joined. */
export function parseTelegramExport(json) {
  const list = Array.isArray(json?.messages) ? json.messages : []
  const out = []
  for (const m of list) {
    if (m?.type && m.type !== 'message') continue
    const text = typeof m.text === 'string' ? m.text : Array.isArray(m.text) ? m.text.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('') : ''
    if (!text.trim()) continue
    const unix = Number(m.date_unixtime)
    // Without the unix time, the export's local time is read as IST (the app's clock).
    const time = Number.isFinite(unix) && unix > 0 ? unix * 1000 : Date.parse(`${m.date}+05:30`)
    if (Number.isFinite(time)) out.push({ time, text, status: 'sent' })
  }
  return out.sort((a, b) => a.time - b.time)
}

/** Every signal of a list of messages ([{ time (ms or ISO), text, status }]), oldest first. */
export function messagesToSignals(messages) {
  const out = []
  for (const m of messages ?? []) {
    const time = typeof m.time === 'number' ? m.time : Date.parse(m.time)
    if (!Number.isFinite(time)) continue
    for (const s of parseMessage(m.text, time)) out.push({ ...s, status: m.status ?? 'sent' })
  }
  return out.sort((a, b) => a.time - b.time)
}

/** The index's 1-minute bars as the reaction reads them: [{ t (ms, the minute's start), o, h, l, c }], oldest first. */
export const barsOf = (spotDay) => (spotDay?.bars ?? [])
  .map((b) => ({ t: Date.parse(b.time), o: b.open, h: b.high, l: b.low, c: b.close }))
  .filter((b) => Number.isFinite(b.t) && b.c > 0)
  .sort((a, b) => a.t - b.t)

/**
 * How price moved after a signal, on the index's 1-minute bars of its day: `base` = the price when it went (the close of
 * the last minute completed by then - else the open of its own minute); at each horizon h the close of the minute ending
 * h minutes after the signal's minute began (null while the data does not reach it); over the `window` (60 min) the
 * highest high and lowest low. `moves` are raw points; `signed` and `pct` are in the signal's direction (a bearish signal
 * that fell 20 points made +20); `best` / `worst` - the most it went its way / against it (MFE / MAE), points. A signal with
 * no direction: `signed` null, best / worst the most up / down. Null when there is no price at the signal.
 */
export function reaction(signal, bars, { horizons = HORIZONS, window = REACTION_WINDOW } = {}) {
  if (!bars?.length || !Number.isFinite(signal?.time)) return null
  const m0 = Math.floor(signal.time / MIN) * MIN
  let j = bars.findIndex((b) => b.t >= m0)
  if (j < 0) j = bars.length
  const prev = j > 0 ? bars[j - 1] : null
  const base = prev && prev.t + MIN <= signal.time && signal.time - prev.t <= 6 * MIN ? prev.c : bars[j]?.t === m0 ? bars[j].o : null
  if (!(base > 0)) return null
  const last = bars[bars.length - 1]
  const dir = signal.dir || 0
  const moves = {}, signed = {}, pct = {}
  for (const h of horizons) {
    const endT = m0 + (h - 1) * MIN
    if (last.t < endT) { moves[h] = null; signed[h] = null; pct[h] = null; continue }
    let k = -1
    for (let x = j; x < bars.length && bars[x].t <= endT; x++) k = x
    const v = k >= 0 ? bars[k].c : null
    moves[h] = v != null ? v - base : null
    signed[h] = v != null && dir ? dir * (v - base) : null
    pct[h] = v != null ? ((dir || 1) * (v - base) / base) * 100 : null
  }
  let hi = -Infinity, lo = Infinity
  for (let x = j; x < bars.length && bars[x].t < m0 + window * MIN; x++) { hi = Math.max(hi, bars[x].h); lo = Math.min(lo, bars[x].l) }
  const hasWindow = Number.isFinite(hi)
  const up = hasWindow ? hi - base : null, down = hasWindow ? base - lo : null
  return {
    base, moves, signed, pct,
    best: hasWindow ? (dir < 0 ? down : up) : null, worst: hasWindow ? (dir < 0 ? up : down) : null,
    complete: last.t >= m0 + (window - 1) * MIN,
  }
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)

/** Pearson's correlation of two equal-length lists; null under 3 pairs or when either does not vary. */
export function correlation(xs, ys) {
  const n = Math.min(xs.length, ys.length)
  if (n < 3) return null
  const mx = mean(xs.slice(0, n)), my = mean(ys.slice(0, n))
  let sxy = 0, sxx = 0, syy = 0
  for (let k = 0; k < n; k++) {
    const dx = xs[k] - mx, dy = ys[k] - my
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null
}

function summaryRow(list, kind, label, horizons) {
  const at = (h, f) => list.map((r) => f(r.reaction, h)).filter((v) => v != null && Number.isFinite(v))
  const out = { kind, label, signals: list.length, bullish: list.filter((r) => r.dir > 0).length, bearish: list.filter((r) => r.dir < 0).length }
  for (const h of horizons) {
    const pts = at(h, (x) => x.signed[h])
    out[`avgPct${h}`] = mean(at(h, (x) => x.pct[h]))
    out[`avgPts${h}`] = mean(pts)
    out[`hit${h}`] = pts.length ? (pts.filter((v) => v > 0).length / pts.length) * 100 : null
    out[`n${h}`] = pts.length
    // The signal's side (+1 / -1) against the raw move in % of the price: +1 = bullish ones always followed by the larger
    // rises, 0 = the side says nothing about what came next, - = the opposite. Needs both sides among the signals.
    const pairs = list.filter((r) => r.reaction.moves[h] != null && r.reaction.base > 0)
    out[`corr${h}`] = correlation(pairs.map((r) => r.dir), pairs.map((r) => (r.reaction.moves[h] / r.reaction.base) * 100))
  }
  out.avgBest = mean(list.map((r) => r.reaction.best).filter((v) => v != null))
  out.avgWorst = mean(list.map((r) => r.reaction.worst).filter((v) => v != null))
  return out
}

/** The page's summary: per kind, the signals with a direction and a reaction - how many (bullish / bearish), the average
 *  move in their direction at each horizon (in % of the price, so indices can be put together, and in points), how often
 *  they went their way, the CORRELATION of their side with the move that followed (`corr{h}`), and the average best /
 *  worst in the hour; with more than one kind, an "All signals" row (kind 'all') last. */
export function reactionSummary(rows, { horizons = HORIZONS } = {}) {
  const byKind = new Map()
  const all = []
  for (const r of rows) {
    if (!r.dir || !r.reaction) continue
    if (!byKind.has(r.kind)) byKind.set(r.kind, [])
    byKind.get(r.kind).push(r)
    all.push(r)
  }
  const out = SIGNAL_KINDS.filter((k) => byKind.has(k.id)).map((k) => summaryRow(byKind.get(k.id), k.id, k.label, horizons))
  if (out.length > 1) out.push(summaryRow(all, 'all', 'All signals', horizons))
  return out
}

/** The rows as CSV (a spreadsheet): time, index, kind, direction, price at the signal, the moves, best / worst, the text. */
export function reactionsCsv(rows, { horizons = HORIZONS } = {}) {
  const cell = (v) => {
    const s = v == null ? '' : String(v)
    const safe = /^[=+\-@\t]/.test(s) && !Number.isFinite(Number(s)) ? `'${s}` : s
    return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
  }
  const head = ['time_ist', 'index', 'kind', 'direction', 'status', 'price_at_signal', ...horizons.map((h) => `move_${h}m_pts`), ...horizons.map((h) => `signed_${h}m_pts`), 'best_60m_pts', 'worst_60m_pts', 'message']
  const r2 = (v) => (v == null || !Number.isFinite(v) ? '' : Math.round(v * 100) / 100)
  const lines = rows.map((r) => [
    new Date(r.time + IST_MS).toISOString().slice(0, 19).replace('T', ' '), r.index ?? '', r.kind, r.dir > 0 ? 'bullish' : r.dir < 0 ? 'bearish' : '', r.status ?? '',
    r2(r.reaction?.base), ...horizons.map((h) => r2(r.reaction?.moves?.[h])), ...horizons.map((h) => r2(r.reaction?.signed?.[h])), r2(r.reaction?.best), r2(r.reaction?.worst), r.text,
  ].map(cell).join(','))
  return [head.join(','), ...lines].join('\n')
}

/** The (index, IST date) pairs whose bars the signals need, as "INDEX|yyyy-mm-dd". */
export const dayKeysOf = (signals) => [...new Set(signals.filter((s) => s.index).map((s) => `${s.index}|${istDate(s.time)}`))]
export { istDate }
