import { useCallback, useEffect, useRef, useState } from 'react'
import { VOICE_LANG, parseVoiceCommand, pushToTalkKey, voiceModeOf } from './voiceCommands.js'
import { isTypingField } from './quickViews.js'

// THE MICROPHONE for OI Replay's voice commands (voiceCommands.js does the reading, VoiceControl.jsx the pill).
// The browser's own SpeechRecognition - nothing of this app's is sent anywhere by us; the recognition itself is the
// BROWSER'S service (Chrome sends the audio to Google's speech service, Safari to Apple's), which is why the tick is
// OFF by default, is this browser's only (LOCAL_ONLY in prefsSync.js), and why 'hold' is the default mode.
//
// THE PERMISSION IS ASKED WHEN THE TICK IS TURNED ON (asked - "browser not asking for permission"): SpeechRecognition
// only asks on its first start(), and in push-to-talk that is the first Ctrl press - so nothing seemed to happen. Now
// ticking Voice asks at once (getUserMedia, tracks stopped straight away - only to get the browser's own prompt) and
// every way it can fail says so on the pill: blocked, no microphone, a page that is not https (the browser refuses the
// microphone there without a word), a browser with no speech recognition (Firefox, Brave).
//
// HOLD CTRL - PUSH TO TALK (asked for - "add ctrl then i should be able to speak it should not always hear us"): the
// recogniser is started on Ctrl DOWN and stopped on Ctrl UP, so the microphone is shut the rest of the time; another
// key pressed while Ctrl is held (Ctrl + C, Ctrl + V) cancels at once, and so do a lost window or a hidden tab - the
// mic is never left open. A Ctrl pressed again before the recogniser has finished stopping opens it again the moment
// it has (it used to be dropped - "nothing happens"). 'always' keeps the old behaviour: it listens while the tick is
// on and restarts after each silence (Chrome stops after a few seconds even with `continuous`).
//
// HOLD THE MIC BUTTON (asked for - a phone has no Ctrl key): `press()` / `release()` - the pill's round mic button
// calls them on pointer down / up and they take the very same path as Ctrl (open on press, stop on release; a lost
// window, a hidden tab or another key shuts it), so push to talk works with a finger too. Ready only once the
// microphone has been allowed.
//
// AS QUICK AS IT CAN BE (asked for - "it should ultra quick"): the command is taken from the INTERIM text, the moment
// the words are recognisable - not from the final result, which lands about a second after you stop speaking. Each
// utterance fires at most once (`fired`), so the final that follows is ignored, and while Ctrl is still down the next
// sentence can fire again.

const Recognition = () => (typeof window === 'undefined' ? null : window.SpeechRecognition || window.webkitSpeechRecognition || null)
/** 'always' mode: restart after an `end` / recoverable error - a moment, growing while they keep coming. */
const RESTART_MS = [250, 500, 1000, 2000, 4000]
const MAX_SILENT_RESTARTS = 12
/** The same text twice inside this is one command (the engine repeats a result now and then). */
const SAME_TEXT_MS = 1200

/** Ask the browser for the microphone now - its own permission prompt - and let go of it at once. Resolves to null
 *  when it is allowed, else the sentence the pill shows. */
async function askForMicrophone() {
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    return 'The browser only gives the microphone to https pages (or localhost) - open the app over https.'
  }
  const media = typeof navigator === 'undefined' ? null : navigator.mediaDevices
  if (!media?.getUserMedia) return null              // an old browser: SpeechRecognition's own start() will ask
  try {
    const stream = await media.getUserMedia({ audio: true })
    stream.getTracks().forEach((t) => t.stop())
    return null
  } catch (e) {
    const name = e?.name
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No microphone was found.'
    if (name === 'NotReadableError') return 'The microphone is in use by another app.'
    return 'The microphone is blocked - click the lock / camera icon in the address bar, allow the microphone for this site, then tick Voice again.'
  }
}

export function useVoiceCommands({ enabled, onCommand, lang = VOICE_LANG, mode = 'hold' }) {
  const [supported] = useState(() => Boolean(Recognition()))
  const [listening, setListening] = useState(false)      // the microphone is open right now
  const [asking, setAsking] = useState(false)            // waiting for the browser's permission prompt
  const [ready, setReady] = useState(false)              // push to talk is wired up (the microphone is allowed)
  const talk = useRef(null)                              // { press, release } while ready
  const [heard, setHeard] = useState('')                 // what the engine is hearing (interim), for the pill
  const [error, setError] = useState(null)
  const handler = useRef(onCommand)
  useEffect(() => { handler.current = onCommand })        // the latest, without rebuilding the recogniser mid-sentence
  const hold = voiceModeOf(mode) === 'hold'

  useEffect(() => {
    const Ctor = Recognition()
    if (!enabled || !Ctor) return undefined              // off: `listening` / `heard` are read as off below
    let stopped = false                                  // the effect is being torn down - do not restart
    let restarts = 0
    let timer = null
    let lastText = ''
    let lastAt = 0
    const fired = new Set()                              // result indexes already acted on (the interim beat the final)
    let ctrlDown = false
    let active = false                                   // started and not yet ended
    let want = false                                     // should be open
    let cleanup = () => {}
    const rec = new Ctor()
    rec.lang = lang
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 3

    const open = () => {
      want = true
      if (stopped || active) return                      // still stopping: onend opens it again
      fired.clear()
      try { rec.start(); active = true } catch { /* not ready yet - onend tries again */ }
    }
    const close = (abort = false) => {
      want = false
      if (timer) { clearTimeout(timer); timer = null }
      if (!active) return
      try { if (abort) rec.abort(); else rec.stop() } catch { /* never started */ }
    }
    const later = () => {
      if (stopped || hold || timer) return
      if (restarts >= MAX_SILENT_RESTARTS) {
        setError('The microphone keeps stopping - turn Voice off and on again.')
        return
      }
      const wait = RESTART_MS[Math.min(restarts, RESTART_MS.length - 1)]
      restarts += 1
      timer = setTimeout(() => { timer = null; open() }, wait)
    }

    rec.onstart = () => { if (!stopped) { setListening(true); setError(null) } }
    rec.onaudiostart = () => { restarts = 0 }
    rec.onend = () => {
      active = false
      if (stopped) return
      setListening(false)
      setHeard('')
      if (!want) return
      if (hold) open()                                   // Ctrl went down again while it was stopping
      else later()
    }
    rec.onerror = (e) => {
      if (stopped) return
      const kind = e?.error
      if (kind === 'not-allowed' || kind === 'service-not-allowed') {
        stopped = true
        setListening(false)
        setError('The microphone is blocked - click the lock icon in the address bar, allow the microphone for this site, then tick Voice again.')
        try { rec.abort() } catch { /* already gone */ }
        return
      }
      if (kind === 'audio-capture') { stopped = true; setListening(false); setError('No microphone was found.'); return }
      if (kind === 'network') setError('The browser\'s speech service could not be reached (it needs the internet) - trying again.')
      // 'no-speech' and 'aborted' are ordinary.
    }
    rec.onresult = (e) => {
      if (stopped) return
      restarts = 0
      setError(null)
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]
        const best = result[0]?.transcript ?? ''
        setHeard(best.trim())
        if (fired.has(i)) continue                       // this sentence already did something
        // The engine's alternatives in order - the first that is a command wins ("gex" is often heard as "jacks"
        // on the first guess and right on the second). Interim text counts: that is what makes it quick.
        let command = null
        for (let k = 0; k < result.length && !command; k++) command = parseVoiceCommand(result[k]?.transcript ?? '')
        if (!command) continue
        const now = Date.now()
        const text = best.trim().toLowerCase()
        if (text && text === lastText && now - lastAt < SAME_TEXT_MS && !result.isFinal) continue
        lastText = text
        lastAt = now
        fired.add(i)
        handler.current?.(command, best.trim())
      }
    }

    // Push to talk: the key listeners are the only thing running until Ctrl goes down.
    const onKeyDown = (e) => {
      const what = pushToTalkKey(e, { typing: isTypingField(e.target), down: true, held: ctrlDown })
      if (what === 'start') { ctrlDown = true; open() } else if (what === 'cancel') { ctrlDown = false; close(true) }
    }
    const onKeyUp = (e) => {
      const what = pushToTalkKey(e, { down: false, held: ctrlDown })
      if (what === 'stop') { ctrlDown = false; close(false) }   // stop(), not abort(): a sentence still being read is finished
    }
    const onAway = () => { if (ctrlDown) { ctrlDown = false; close(true) } }
    // The mic button: the same hold as Ctrl's.
    const press = () => { if (!ctrlDown) { ctrlDown = true; open() } }
    const release = () => { if (ctrlDown) { ctrlDown = false; close(false) } }

    // Ask for the microphone first (its prompt), then listen.
    setAsking(true)
    setError(null)
    askForMicrophone().then((problem) => {
      if (stopped) return
      setAsking(false)
      if (problem) { setError(problem); return }
      if (hold) {
        talk.current = { press, release }
        setReady(true)
        window.addEventListener('keydown', onKeyDown)
        window.addEventListener('keyup', onKeyUp)
        window.addEventListener('blur', onAway)
        document.addEventListener('visibilitychange', onAway)
        cleanup = () => {
          talk.current = null
          window.removeEventListener('keydown', onKeyDown)
          window.removeEventListener('keyup', onKeyUp)
          window.removeEventListener('blur', onAway)
          document.removeEventListener('visibilitychange', onAway)
        }
      } else {
        open()
      }
    })
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      cleanup()
      talk.current = null
      rec.onstart = null
      rec.onend = null
      rec.onerror = null
      rec.onresult = null
      rec.onaudiostart = null
      try { rec.abort() } catch { /* never started */ }
      setAsking(false)
      setReady(false)
    }
  }, [enabled, lang, hold])

  const clearError = useCallback(() => setError(null), [])
  const press = useCallback(() => talk.current?.press(), [])
  const release = useCallback(() => talk.current?.release(), [])
  // Read as off while the tick is off, whatever the last run left behind.
  return {
    supported, hold, asking: Boolean(enabled) && asking, listening: Boolean(enabled) && listening,
    heard: enabled ? heard : '', error: enabled ? error : null, clearError,
    ready: Boolean(enabled) && hold && ready, press, release,
  }
}
