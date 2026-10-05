// One way to say "something happened to a trade" on every page: a notification, a chime (up for a
// good outcome, down for a bad one) and - when asked - the server's Telegram chat. Used for paper and
// live trades alike: an order punched / placed, a stop-loss or target hit, an exit, a rejection.

import { notification } from 'antd'
import { chime, telegram } from './alerts.js'

const KIND = {
  entry: { type: 'info', good: true },
  exit: { type: 'info', good: true },
  target: { type: 'success', good: true },
  stopLoss: { type: 'error', good: false },
  rejected: { type: 'error', good: false },
  failed: { type: 'error', good: false },
}

/** kind: entry / exit / target / stopLoss / rejected / failed. `good` overrides the chime's direction
 *  (an exit in profit is good). `telegramText` goes to Telegram when given. `key` makes a repeat of the
 *  same event replace its notification instead of stacking another. */
export function notifyTrade({ kind = 'entry', title, text, good, sound = true, telegramText = null, key, duration = 10 }) {
  const meta = KIND[kind] ?? KIND.entry
  notification[meta.type]({ key, message: title, description: text, placement: 'topRight', duration })
  if (sound) chime(good ?? meta.good)
  if (telegramText) telegram(telegramText)
}

// Live trade events come with every live positions snapshot (the OI Replay panel's push, the strategy
// scanner's poll) - each is notified ONCE per browser, whichever page sees it first. On a page's first
// look only the last 2 minutes' events are news (older ones happened before it opened - Telegram had them).
const SEEN_KEY = 'optionanalytics.liveTradeEvents.seen.v1'
let seen = null
let primed = false
const today = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)
function loadSeen() {
  if (seen) return seen
  try {
    const stored = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}')
    seen = new Set(stored.day === today() ? stored.ids ?? [] : [])
  } catch { seen = new Set() }
  return seen
}
function saveSeen() {
  try { localStorage.setItem(SEEN_KEY, JSON.stringify({ day: today(), ids: [...seen].slice(-200) })) } catch { /* convenience only */ }
}

/** Notifies each live trade event (LivePositionsSnapshot.Events) not seen yet. Returns the new ones. */
export function notifyLiveTradeEvents(events, { sound = true } = {}) {
  if (!Array.isArray(events)) return []
  const ids = loadSeen()
  const fresh = events.filter((e) => e?.id && !ids.has(e.id))
  if (!fresh.length) { primed = true; return [] }
  for (const e of fresh) ids.add(e.id)
  saveSeen()
  // The first look: only what happened in the last 2 minutes is news.
  const news = primed ? fresh : fresh.filter((e) => Date.now() - new Date(e.atUtc).getTime() < 120_000)
  primed = true
  // Telegram: the server already sent each of these.
  for (const e of news) notifyTrade({ kind: e.kind, title: `LIVE · ${e.title}`, text: e.text, sound, key: `live-${e.id}`, duration: e.kind === 'stopLoss' || e.kind === 'rejected' ? 0 : 12 })
  return news
}

/** For tests: forget what was seen. */
export function resetLiveTradeEvents() { seen = new Set(); primed = false }
