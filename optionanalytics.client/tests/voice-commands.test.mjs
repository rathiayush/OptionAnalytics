// OI Replay's VOICE COMMANDS (voiceCommands.js): what is said -> the one command the page carries out.
// Run: npm test (node --test) - see CLAUDE.md.
import { QUICK_VIEWS } from '../src/quickViews.js'
import {
  VOICE_CARDS, VOICE_MODES, VOICE_MODE_DEFAULT, VOICE_NEVER, VOICE_VIEWS, normalizeSpeech, parseVoiceCommand,
  isTouchScreen, pushToTalkKey, saidPhrase, voiceCommandText, voiceHelpLines, voiceHint, voiceModeOf, voiceSpeed,
} from '../src/voiceCommands.js'

let fails = 0
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${cond ? '' : ` ${extra}`}`); if (!cond) fails++ }
const json = (v) => JSON.stringify(v)
const is = (said, want) => check(`"${said}" -> ${json(want)}`, json(parseVoiceCommand(said)) === json(want), json(parseVoiceCommand(said)))

// 1. Normalising: number words to digits, punctuation out, "to" / "for" / "oh" left alone.
{
  check('"Go to Ten Thirty-five!" -> "go to 10 35"', normalizeSpeech('Go to Ten Thirty-five!') === 'go to 10 35', normalizeSpeech('Go to Ten Thirty-five!'))
  check('"to" is not 2', normalizeSpeech('go to nine fifteen') === 'go to 9 15', normalizeSpeech('go to nine fifteen'))
  check('"for" is not 4', normalizeSpeech('wait for it') === 'wait for it', normalizeSpeech('wait for it'))
  check('twenty five is one number', normalizeSpeech('twenty five') === '25', normalizeSpeech('twenty five'))
  check('thirty alone is 30', normalizeSpeech('thirty') === '30')
  check('a time keeps its colon', normalizeSpeech('go to 10:30') === 'go to 10:30')
  check('empty speech is empty', normalizeSpeech('  ...  ') === '', json(normalizeSpeech('  ...  ')))
  check('a phrase matches on whole words only', saidPhrase('restart the day', 'start') === false)
  check('...and matches when it is there', saidPhrase('please start the replay', 'start') === true)
  check('a two-word phrase matches in the middle', saidPhrase('now stop listening please', 'stop listening') === true)
}

// 2. Replay: start / stop / reset, said any number of ways and inside a longer sentence. They are NOT toggles.
{
  for (const s of ['start', 'play', 'start replay', 'start the replay', 'resume', 'okay now start the replay please']) is(s, { kind: 'play' })
  for (const s of ['stop', 'pause', 'stop replay', 'pause the replay', 'hold on']) is(s, { kind: 'pause' })
  for (const s of ['reset', 'reset replay', 'back to start', 'rewind']) is(s, { kind: 'reset' })
  check('"stop listening" is the microphone, not the replay', parseVoiceCommand('stop listening').kind === 'listenOff')
  check('"restart" is not "start"', parseVoiceCommand('restart') === null, json(parseVoiceCommand('restart')))
  check('nothing recognised is null', parseVoiceCommand('the weather is nice') === null, json(parseVoiceCommand('the weather is nice')))
}

// 3. The minute: a time, and steps forward / back.
{
  is('go to ten thirty', { kind: 'goto', hour: 10, minute: 30 })
  is('go to 10:30', { kind: 'goto', hour: 10, minute: 30 })
  is('jump to 1030', { kind: 'goto', hour: 10, minute: 30 })
  is('take me to nine fifteen', { kind: 'goto', hour: 9, minute: 15 })
  is('go to eleven', { kind: 'goto', hour: 11, minute: 0 })
  // The market is never open at 1 am, so 1 / 2 / 3 are the afternoon.
  is('go to 1 30', { kind: 'goto', hour: 13, minute: 30 })
  is('go to three', { kind: 'goto', hour: 15, minute: 0 })
  is('forward 5 minutes', { kind: 'skip', minutes: 5 })
  is('back 10 minutes', { kind: 'skip', minutes: -10 })
  is('next minute', { kind: 'skip', minutes: 1 })
  is('previous candle', { kind: 'skip', minutes: -1 })
  check('"go to" with no time is not a jump', parseVoiceCommand('go to') === null, json(parseVoiceCommand('go to')))
  check('a time out of the clock is not a jump', parseVoiceCommand('go to 99:99') === null, json(parseVoiceCommand('go to 99:99')))
}

// 4. Speed: absolute "N x" and faster / slower through the page's own speeds (ms a market minute - faster is smaller).
{
  is('speed 2x', { kind: 'speed', x: 2 })
  is('4 x', { kind: 'speed', x: 4 })
  is('faster', { kind: 'speed', step: 1 })
  is('slow down', { kind: 'speed', step: -1 })
  is('normal speed', { kind: 'speed', x: 1 })
  is('half speed', { kind: 'speed', x: 0.5 })
  const ms = [2000, 1000, 500, 250, 100]
  check('2x is 500 ms', voiceSpeed({ x: 2 }, ms, 1000) === 500, voiceSpeed({ x: 2 }, ms, 1000))
  check('half speed is 2000 ms', voiceSpeed({ x: 0.5 }, ms, 1000) === 2000, voiceSpeed({ x: 0.5 }, ms, 1000))
  check('faster from 1x is 2x', voiceSpeed({ step: 1 }, ms, 1000) === 500, voiceSpeed({ step: 1 }, ms, 1000))
  check('slower from 1x is 0.5x', voiceSpeed({ step: -1 }, ms, 1000) === 2000, voiceSpeed({ step: -1 }, ms, 1000))
  check('faster at the fastest changes nothing', voiceSpeed({ step: 1 }, ms, 100) === null, voiceSpeed({ step: 1 }, ms, 100))
  check('slower at the slowest changes nothing', voiceSpeed({ step: -1 }, ms, 2000) === null, voiceSpeed({ step: -1 }, ms, 2000))
  check('a speed the page is on but the list has not still steps', voiceSpeed({ step: 1 }, ms, 1500) === 500, voiceSpeed({ step: 1 }, ms, 1500))
}

// 5. The popups (quick views) and the cards with none.
{
  is('gex', { kind: 'view', view: 'gex' })
  is('open gamma exposure', { kind: 'view', view: 'gex' })
  is('show me the straddle', { kind: 'view', view: 'straddle' })
  is('futures', { kind: 'view', view: 'futures' })
  is('heat map', { kind: 'view', view: 'oiHeatmap' })
  is('day oi', { kind: 'view', view: 'dayOi' })
  is('option premium', { kind: 'view', view: 'premium' })
  is('oi charts', { kind: 'view', view: 'oiCharts' })
  is('option delta profile', { kind: 'view', view: 'optionDelta' })
  is('futures delta profile', { kind: 'view', view: 'futuresDelta' })
  is('delta profile', { kind: 'view', view: 'optionDelta' })
  check('every view said is one of the quick views', VOICE_VIEWS.every((v) => QUICK_VIEWS.some((q) => q.key === v.view)),
    json(VOICE_VIEWS.map((v) => v.view).filter((v) => !QUICK_VIEWS.some((q) => q.key === v))))
  check('every quick view can be said', QUICK_VIEWS.every((q) => VOICE_VIEWS.some((v) => v.view === q.key)),
    json(QUICK_VIEWS.map((q) => q.key).filter((k) => !VOICE_VIEWS.some((v) => v.view === k))))
  is('dealer hedging', { kind: 'card', card: 'dex', label: 'Dealer hedging (DEX)' })
  is('entry checklist', { kind: 'card', card: 'entryChecklist', label: 'Entry checklist' })
  // The longer phrase wins: "gex levels on spot" is the card, plain "gex" the popup.
  is('gex levels on spot', { kind: 'card', card: 'gexSpot', label: 'GEX levels on spot' })
  check('no card is also a quick view key', VOICE_CARDS.every((c) => !QUICK_VIEWS.some((q) => q.key === c.card)),
    json(VOICE_CARDS.map((c) => c.card).filter((c) => QUICK_VIEWS.some((q) => q.key === c))))
  for (const s of ['close', 'close popup', 'close the popup', 'hide']) is(s, { kind: 'close' })
}

// 6. The day shown.
{
  is('nifty', { kind: 'index', underlying: 'NIFTY' })
  is('banknifty', { kind: 'index', underlying: 'BANKNIFTY' })
  is('bank nifty', { kind: 'index', underlying: 'BANKNIFTY' })
  is('sensex', { kind: 'index', underlying: 'SENSEX' })
  is('go live', { kind: 'live' })
  check('"bank nifty" is not read as NIFTY', parseVoiceCommand('switch to bank nifty').underlying === 'BANKNIFTY')
}

// 7. IT NEVER TRADES. The panel can be opened; anything that sounds like an order is refused outright - no order, and
//    not even the index switch the sentence happens to name.
{
  is('open order panel', { kind: 'order' })
  is('trade panel', { kind: 'order' })
  is('close order panel', { kind: 'orderClose' })
  for (const s of ['buy one lot of nifty call', 'sell 25000 ce', 'punch a trade', 'place the order', 'square off everything', 'modify the stop']) {
    is(s, { kind: 'refused' })
  }
  const kinds = new Set()
  const phrases = [
    ...VOICE_VIEWS.flatMap((v) => v.say), ...VOICE_CARDS.flatMap((c) => c.say),
    'start', 'stop', 'pause', 'reset', 'faster', 'slower', '2x', 'go to 10 30', 'forward 5 minutes', 'close',
    'nifty', 'banknifty', 'sensex', 'go live', 'open order panel', 'close order panel', 'what can i say', 'stop listening',
  ]
  for (const s of phrases) { const c = parseVoiceCommand(s); if (c) kinds.add(c.kind) }
  const allowed = new Set(['play', 'pause', 'reset', 'speed', 'goto', 'skip', 'view', 'card', 'close', 'order', 'orderClose', 'index', 'live', 'help', 'listenOff'])
  check('no command does anything but read the page / move the replay / open the panel', [...kinds].every((k) => allowed.has(k)), json([...kinds]))
  check('nothing says "punch" / "place" / "buy" / "sell"', phrases.every((s) => !VOICE_NEVER.some((w) => saidPhrase(normalizeSpeech(s), w))),
    json(phrases.filter((s) => VOICE_NEVER.some((w) => saidPhrase(normalizeSpeech(s), w)))))
}

// 8. What the pill says it heard.
{
  check('play reads "start replay"', voiceCommandText({ kind: 'play' }) === 'start replay')
  check('a jump reads its time', voiceCommandText({ kind: 'goto', hour: 9, minute: 5 }) === 'go to 09:05', voiceCommandText({ kind: 'goto', hour: 9, minute: 5 }))
  check('a step reads its minutes', voiceCommandText({ kind: 'skip', minutes: -10 }) === 'back 10 min')
  check('a card reads its label', voiceCommandText({ kind: 'card', card: 'dex', label: 'Dealer hedging (DEX)' }) === 'show Dealer hedging (DEX)')
  check('a refusal says so', voiceCommandText({ kind: 'refused' }).includes('never placed'))
  check('nothing reads empty', voiceCommandText(null) === '')
  check('the help lists every group', voiceHelpLines().length >= 8 && voiceHelpLines().every((l) => typeof l === 'string' && l.length > 0))
}

// 9. PUSH TO TALK (asked for - "add ctrl then i should be able to speak it should not always hear us"): the microphone
//    opens on Ctrl down and shuts on Ctrl up; another key while it is held cancels, and nothing fires from a text box.
{
  const down = (key, extra = {}) => pushToTalkKey({ key, ...extra }, { down: true, ...extra })
  check('Ctrl down opens the microphone', down('Control') === 'start')
  check('Cmd down opens it too', down('Meta') === 'start')
  check('a held Ctrl repeating does nothing', pushToTalkKey({ key: 'Control', repeat: true }, { down: true, held: true }) === null)
  check('Ctrl down in a text box does nothing', pushToTalkKey({ key: 'Control' }, { down: true, typing: true }) === null)
  check('Ctrl up shuts it', pushToTalkKey({ key: 'Control' }, { down: false, held: true }) === 'stop')
  check('a stray Ctrl up with nothing open does nothing', pushToTalkKey({ key: 'Control' }, { down: false, held: false }) === null)
  check('Ctrl + C cancels it', pushToTalkKey({ key: 'c' }, { down: true, held: true }) === 'cancel')
  check('another key with no Ctrl held does nothing', pushToTalkKey({ key: 'c' }, { down: true, held: false }) === null)
  check('a letter released does nothing', pushToTalkKey({ key: 'c' }, { down: false, held: true }) === null)
  check('"hold" is the default mode', VOICE_MODE_DEFAULT === 'hold' && voiceModeOf(undefined) === 'hold' && voiceModeOf('nonsense') === 'hold')
  check('"always" is the only other one', voiceModeOf('always') === 'always' && VOICE_MODES.length === 2)
}

// 10. THE MIC BUTTON (a phone has no Ctrl key): what the pill says, and what counts as a touch screen.
{
  check('desktop, shut: hold Ctrl', voiceHint({ hold: true, touch: false }) === 'Hold Ctrl and speak')
  check('phone, shut: hold the mic button', voiceHint({ hold: true, touch: true }) === 'Hold the mic button and speak')
  check('asking beats everything', voiceHint({ asking: true, listening: true, last: 'x' }) === 'Allow the microphone in the browser prompt…')
  check('listening with nothing done yet', voiceHint({ listening: true }) === 'Listening…')
  check('listening shows the last command', voiceHint({ listening: true, last: 'open gex' }) === 'open gex')
  check('shut, the last command stays', voiceHint({ hold: true, last: 'close' }) === 'close')
  check('always mode, starting', voiceHint({ hold: false }) === 'Starting…')
  check('no hover = touch', isTouchScreen({ matchMedia: () => ({ matches: true }), innerWidth: 1600 }) === true)
  check('a narrow window = touch', isTouchScreen({ matchMedia: () => ({ matches: false }), innerWidth: 390 }) === true)
  check('a mouse on a wide window is not', isTouchScreen({ matchMedia: () => ({ matches: false }), innerWidth: 1600 }) === false)
  check('no window is not', isTouchScreen(null) === false)
}

console.log(fails ? `${fails} FAILED` : 'all passed')
process.exitCode = fails ? 1 : 0
