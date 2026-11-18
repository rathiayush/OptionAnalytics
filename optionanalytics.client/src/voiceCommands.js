// VOICE COMMANDS for the OI Replay page (asked for - "integrate voice command to start replay stop replay and open any
// card in popup or anything on oi page"): spoken text -> ONE command the page carries out with its OWN handlers (the
// same ones the buttons call). This file is PURE - no browser API, no React - so every phrase is tested
// (tests/voice-commands.test.mjs); the microphone itself is useVoiceCommands.js and the pill VoiceControl.jsx.
//
// What it will NEVER do: place, modify or close an ORDER. 'order' only OPENS the Paper / Live order panel, which keeps
// its own confirm - a misheard word must never reach the market (the test holds it).
//
// Recognition is loose on purpose: a phrase MATCHES ANYWHERE in the transcript ("okay now start the replay please" =
// start), the longest phrase wins ("stop listening" before "stop", "option delta profile" before "delta profile"), and
// number words become digits ("go to ten thirty" = 10:30).

/** HOW IT LISTENS (asked for - "add ctrl then i should be able to speak it should not always hear us"):
 *  'hold' (the default) = PUSH TO TALK, the microphone is live ONLY while Ctrl is held down; 'always' = it listens
 *  the whole time Voice is ticked. */
export const VOICE_MODES = [
  { value: 'hold', label: 'Hold to talk', title: 'Push to talk: the microphone is live only while you hold Ctrl (or the round mic button - the way on a phone) - nothing is heard the rest of the time.' },
  { value: 'always', label: 'Always', title: 'The microphone listens the whole time Voice is ticked.' },
]
export const VOICE_MODE_DEFAULT = 'hold'
export const voiceModeOf = (value) => (VOICE_MODES.some((m) => m.value === value) ? value : VOICE_MODE_DEFAULT)

/** What a key event means for push to talk, so the rule is testable without a browser:
 *  'start' - Ctrl (or ⌘) went down on its own: open the microphone;
 *  'stop'  - it came up: close it;
 *  'cancel'- another key went down while it was held (Ctrl + C, Ctrl + V ...): close it, take nothing;
 *  null    - nothing to do (a repeat, a key typed in a box, any other key).
 *  `typing` is quickViews.isTypingField(e.target) - in a text box Ctrl + A / C / V stay the box's. */
export function pushToTalkKey(e, { typing = false, down = true, held = false } = {}) {
  const isCtrl = e?.key === 'Control' || e?.key === 'Meta'
  if (down) {
    if (e?.repeat) return null
    if (isCtrl) return typing ? null : 'start'
    return held ? 'cancel' : null
  }
  return isCtrl && held ? 'stop' : null
}

/** The recogniser's language. Indian English first - it hears "nifty", "banknifty" and Indian digits far better than
 *  en-US, which heard "nifty" as "nifty"/"knifty" about half the time. */
export const VOICE_LANG = 'en-IN'

// ---- normalising -----------------------------------------------------------------------------------

// "to", "too", "for" and "oh" are NOT numbers here, however often they are spoken as one: "go to ten thirty" has to
// stay "go to", not "go 2".
const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
}
const TENS = new Set([20, 30, 40, 50])

/** The transcript as plain lowercase words, numbers as digits: "Go to Ten Thirty-five!" -> "go to 10 35".
 *  A tens word followed by a unit is one number (twenty five = 25); "half" and "quarter" are left as words. */
export function normalizeSpeech(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9:.]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => /[a-z0-9]/.test(w))   // a stray ":" or "." of its own is not a word
  const out = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const n = NUMBER_WORDS[w]
    if (n == null) { out.push(w); continue }
    const next = NUMBER_WORDS[words[i + 1]]
    if (TENS.has(n) && next != null && next >= 1 && next <= 9) { out.push(String(n + next)); i++; continue }
    out.push(String(n))
  }
  return out.join(' ')
}

/** Whether `phrase` (already normalised) appears in `said` on whole-word boundaries - so "start" is not found inside
 *  "restart" and "oi" not inside "void". */
export function saidPhrase(said, phrase) {
  const words = said.split(' ')
  const want = phrase.split(' ')
  for (let i = 0; i + want.length <= words.length; i++) {
    let hit = true
    for (let k = 0; k < want.length; k++) if (words[i + k] !== want[k]) { hit = false; break }
    if (hit) return true
  }
  return false
}

// ---- what can be said ------------------------------------------------------------------------------

/** The quick views (quickViews.js keys) and what they are called out loud. The speech engine mishears some of them the
 *  same way every time, so the common mishearings are in the list ("jacks" / "geeks" for GEX, "straddled"). */
export const VOICE_VIEWS = [
  { view: 'optionDelta', say: ['option delta profile', 'option delta', 'delta profile option', 'option flow profile'] },
  { view: 'futuresDelta', say: ['futures delta profile', 'futures delta', 'future delta', 'delta profile futures', 'footprint profile'] },
  { view: 'oiHeatmap', say: ['oi heatmap', 'oi heat map', 'oi change heatmap', 'heatmap', 'heat map'] },
  { view: 'oiCharts', say: ['oi charts', 'oi totals charts', 'totals charts', 'oi chart'] },
  { view: 'dayOi', say: ['day oi', 'day o i', 'oi since open', 'day open interest', 'day oil'] },
  { view: 'premium', say: ['option premium', 'premium charts', 'premium chart', 'premium'] },
  { view: 'straddle', say: ['atm straddle', 'straddle', 'straddled', 'stradle'] },
  { view: 'futures', say: ['futures chart', 'futures', 'future chart'] },
  { view: 'gex', say: ['gex', 'gamma exposure', 'gamma', 'g e x', 'jacks', 'geeks', 'jex'] },
  // "delta profile" alone is the OPTION one (the first delta card on the page).
  { view: 'optionDelta', say: ['delta profile'] },
]

/** The page's cards that have no popup (SECTION_OPTIONS in OiReplayPage): the page SCROLLS to the card instead.
 *  `label` is what the pill says it did; a card hidden in "Sections shown" is reported as hidden, not opened. */
export const VOICE_CARDS = [
  { card: 'entryChecklist', label: 'Entry checklist', say: ['entry checklist', 'checklist'] },
  { card: 'marketRead', label: 'Market Read', say: ['market read'] },
  { card: 'topStats', label: 'Top stats', say: ['top stats', 'snapshot'] },
  { card: 'gexSpot', label: 'GEX levels on spot', say: ['gex levels on spot', 'gex levels', 'gex spot', 'gamma levels'] },
  { card: 'dex', label: 'Dealer hedging (DEX)', say: ['dealer hedging', 'dex', 'decks', 'delta exposure'] },
  { card: 'oiTotals', label: 'OI totals', say: ['oi totals', 'oi total'] },
  { card: 'optionFlow', label: 'Option CDV / OBV', say: ['option cdv', 'cdv', 'obv', 'option flow'] },
  { card: 'entryCharts', label: 'Fast entry charts', say: ['entry charts', 'fast entry charts', 'entry chart'] },
  { card: 'ladder', label: 'OI ladder', say: ['ladder', 'oi ladder', 'strike ladder'] },
]

const INDICES = [
  { underlying: 'BANKNIFTY', say: ['banknifty', 'bank nifty', 'bank nifty 50', 'bnf'] },
  { underlying: 'SENSEX', say: ['sensex', 'census', 'sen sex'] },
  { underlying: 'NIFTY', say: ['nifty', 'nifty 50', 'nifty fifty'] },
]

/** Every phrase that is a command, as { say, command }. Sorted longest-first when matched, so a short phrase inside a
 *  longer one ("stop" in "stop listening", "gex" in "gex levels") never wins. */
function phraseTable() {
  const rows = []
  const add = (say, command) => { for (const s of say) rows.push({ say: normalizeSpeech(s), command }) }

  // The microphone's own switch first - it must always be sayable, whatever else is open.
  add(['stop listening', 'voice off', 'mic off', 'microphone off', 'turn off voice', 'stop voice'], { kind: 'listenOff' })
  add(['what can i say', 'voice commands', 'voice help', 'show commands', 'list commands'], { kind: 'help' })

  // Replay. "start"/"go" play, "stop"/"pause" pause - never a toggle, so saying it twice is harmless.
  add(['start replay', 'play replay', 'resume replay', 'start the replay', 'play', 'start', 'resume', 'continue', 'go on'], { kind: 'play' })
  add(['stop replay', 'pause replay', 'stop the replay', 'pause the replay', 'pause', 'stop', 'hold on', 'wait'], { kind: 'pause' })
  add(['reset replay', 'reset the replay', 'start over', 'back to start', 'back to the start', 'reset', 'rewind'], { kind: 'reset' })

  // Speed. An exact "N x" is absolute; faster / slower step through the page's own speeds.
  add(['speed up', 'faster', 'speed faster', 'more speed'], { kind: 'speed', step: 1 })
  add(['slow down', 'slower', 'speed slower', 'less speed'], { kind: 'speed', step: -1 })
  add(['normal speed', 'full speed'], { kind: 'speed', x: 1 })
  add(['half speed'], { kind: 'speed', x: 0.5 })

  // The order panel - it OPENS the panel, which keeps its own confirm. Nothing here ever places a trade.
  add(['open order panel', 'order panel', 'open the order panel', 'order window', 'open order', 'trade panel'], { kind: 'order' })
  add(['close order panel', 'close the order panel', 'hide order panel'], { kind: 'orderClose' })

  // The popups and the cards.
  for (const v of VOICE_VIEWS) add(v.say, { kind: 'view', view: v.view })
  for (const c of VOICE_CARDS) add(c.say, { kind: 'card', card: c.card, label: c.label })
  add(['close popup', 'close the popup', 'close view', 'close card', 'close it', 'close this', 'close', 'hide'], { kind: 'close' })

  // The day shown.
  for (const i of INDICES) add(i.say, { kind: 'index', underlying: i.underlying })
  add(['go live', 'live mode', 'today live'], { kind: 'live' })

  return rows.sort((a, b) => b.say.split(' ').length - a.say.split(' ').length || b.say.length - a.say.length)
}
const PHRASES = phraseTable()

// ---- the time and minute steps ---------------------------------------------------------------------

/** The session's hours: a spoken 1 / 2 / 3 means 13 / 14 / 15 - the market is never open at 1 am, and "go to 1 30" on a
 *  replayed day is 13:30. */
const sessionHour = (h) => (h >= 1 && h <= 3 ? h + 12 : h)

/** "go to 10 30" / "jump to 10:30" / "go to 11" / "go to 1030" -> { hour, minute }, else null. */
function timeIn(said) {
  const colon = said.match(/\b(\d{1,2})[:.](\d{2})\b/)
  if (colon) return fitTime(Number(colon[1]), Number(colon[2]))
  const four = said.match(/\b(\d{3,4})\b/)
  if (four) {
    const n = Number(four[1])
    return fitTime(Math.floor(n / 100), n % 100)
  }
  const two = said.match(/\b(\d{1,2})\s+(\d{1,2})\b/)
  if (two) return fitTime(Number(two[1]), Number(two[2]))
  const one = said.match(/\b(\d{1,2})\b/)
  if (one) return fitTime(Number(one[1]), 0)
  return null
}
function fitTime(hour, minute) {
  const h = sessionHour(hour)
  if (!Number.isInteger(h) || !Number.isInteger(minute) || h < 0 || h > 23 || minute < 0 || minute > 59) return null
  return { hour: h, minute }
}

/** Words that make the whole transcript a refusal - voice never trades. */
export const VOICE_NEVER = ['buy', 'bye', 'sell', 'punch', 'place', 'square', 'squareoff', 'modify', 'exit the trade', 'book profit']

const GOTO = ['go to', 'goto', 'jump to', 'move to', 'skip to', 'take me to', 'show me'].map(normalizeSpeech)
const FORWARD = ['forward', 'ahead', 'next', 'advance', 'plus'].map(normalizeSpeech)
const BACK = ['back', 'backward', 'backwards', 'previous', 'minus', 'before'].map(normalizeSpeech)

// ---- the one public call ---------------------------------------------------------------------------

/** What was said, as a command the page can carry out - or null when nothing was recognised.
 *  Commands: { kind: 'play' | 'pause' | 'reset' | 'close' | 'order' | 'orderClose' | 'live' | 'help' | 'listenOff' },
 *  { kind: 'speed', x } / { kind: 'speed', step }, { kind: 'goto', hour, minute }, { kind: 'skip', minutes },
 *  { kind: 'view', view }, { kind: 'card', card, label }, { kind: 'index', underlying }. */
export function parseVoiceCommand(text) {
  const said = normalizeSpeech(text)
  if (!said) return null

  // ANYTHING that sounds like trading is REFUSED outright, command or not: a misheard sentence must never place,
  // modify or close a position, and it must not quietly switch the index either (so "buy nifty 25000 call" does
  // nothing at all). The order panel is opened by "open order panel", which says none of these words.
  if (VOICE_NEVER.some((w) => saidPhrase(said, w))) return { kind: 'refused' }

  // "go to 10:30" and "forward 5 minutes" are read before the phrase table: "go to" alone would otherwise be "go on".
  if (GOTO.some((p) => saidPhrase(said, p))) {
    const t = timeIn(said)
    if (t) return { kind: 'goto', ...t }
  }
  const step = said.match(/\b(\d{1,3})\s*(?:min|mins|minute|minutes|candle|candles|bar|bars)\b/)
  const oneStep = /\b(?:minute|candle|bar)\b/.test(said)
  if (FORWARD.some((p) => saidPhrase(said, p)) && (step || oneStep)) return { kind: 'skip', minutes: step ? Number(step[1]) : 1 }
  if (BACK.some((p) => saidPhrase(said, p)) && (step || oneStep)) return { kind: 'skip', minutes: -(step ? Number(step[1]) : 1) }

  // "speed 2x" / "2x" / "4 x".
  const times = said.match(/\b(\d{1,2})(?:\.(\d))?\s*x\b/)
  if (times) {
    const x = Number(times[2] ? `${times[1]}.${times[2]}` : times[1])
    if (x > 0 && x <= 100) return { kind: 'speed', x }
  }

  for (const row of PHRASES) if (saidPhrase(said, row.say)) return { ...row.command }
  return null
}

/** The speed the page should move to: `step` +1 faster / -1 slower through `msValues` (ms a market minute, so FASTER is
 *  a SMALLER number), or the ms for an absolute `x` (1x = 1000 ms). Null when nothing changes. */
export function voiceSpeed(command, msValues, current) {
  if (command?.x > 0) return Math.max(20, Math.round(1000 / command.x))
  if (!command?.step) return null
  const sorted = [...new Set(msValues)].sort((a, b) => b - a)            // slowest first
  const at = sorted.indexOf(current)
  const i = at === -1 ? sorted.findIndex((v) => v <= current) : at
  const next = (i === -1 ? sorted.length - 1 : i) + (command.step > 0 ? 1 : -1)
  if (next < 0 || next >= sorted.length) return null
  return sorted[next]
}

/** The command list shown in the pill's tooltip and the tick's - one line a group. */
export function voiceHelpLines() {
  return [
    'Replay: "start" · "stop" · "pause" · "reset"',
    'Speed: "faster" · "slower" · "2x" · "normal speed"',
    'Minute: "go to 10 30" · "forward 5 minutes" · "back 10 minutes"',
    'Popups: "GEX" · "straddle" · "futures" · "heatmap" · "day OI" · "premium" · "option delta profile" · "futures delta profile" · "OI charts"',
    'Cards: "entry checklist" · "dealer hedging" · "GEX levels on spot" · "market read" · "OI totals" · "option CDV" · "ladder"',
    'Close: "close" · "close popup"',
    'Day: "nifty" · "banknifty" · "sensex" · "go live"',
    'Order: "open order panel" (it only opens the panel - a trade still needs its own confirm)',
    'Voice: "what can I say" · "stop listening"',
  ]
}

/** What the pill says it did - short, so a glance confirms the right thing was heard. */
export function voiceCommandText(command) {
  if (!command) return ''
  switch (command.kind) {
    case 'play': return 'start replay'
    case 'pause': return 'pause replay'
    case 'reset': return 'reset replay'
    case 'speed': return command.x ? `speed ${command.x}x` : command.step > 0 ? 'faster' : 'slower'
    case 'goto': return `go to ${String(command.hour).padStart(2, '0')}:${String(command.minute).padStart(2, '0')}`
    case 'skip': return `${command.minutes > 0 ? 'forward' : 'back'} ${Math.abs(command.minutes)} min`
    case 'view': return `open ${command.view}`
    case 'card': return `show ${command.label ?? command.card}`
    case 'close': return 'close'
    case 'order': return 'open the order panel'
    case 'orderClose': return 'close the order panel'
    case 'index': return command.underlying
    case 'live': return 'go live'
    case 'help': return 'commands'
    case 'listenOff': return 'stop listening'
    case 'refused': return 'not by voice - an order is never placed or closed by voice'
    default: return command.kind
  }
}

/** What the pill says when it has nothing newer to say: how to speak. `touch` = a phone / tablet (no Ctrl key - the round
 *  mic button is held instead). */
export function voiceHint({ hold = true, touch = false, asking = false, listening = false, last = '' } = {}) {
  if (asking) return 'Allow the microphone in the browser prompt…'
  if (listening) return last || 'Listening…'
  if (last) return last
  if (!hold) return 'Starting…'
  return touch ? 'Hold the mic button and speak' : 'Hold Ctrl and speak'
}

/** Whether this is a touch screen: no hover (a phone / tablet) or a narrow window - the same test the quick views use. */
export function isTouchScreen(win = typeof window === 'undefined' ? null : window) {
  if (!win) return false
  try { if (win.matchMedia?.('(hover: none)').matches) return true } catch { /* no matchMedia */ }
  return (win.innerWidth ?? 9999) <= 768
}
