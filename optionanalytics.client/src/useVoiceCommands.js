import { useCallback, useEffect, useRef, useState } from 'react'
import { VOICE_LANG, parseVoiceCommand } from './voiceCommands.js'

// THE MICROPHONE for OI Replay's voice commands (voiceCommands.js does the reading, VoiceControl.jsx the pill).
// The browser's own SpeechRecognition - nothing of this app's is sent anywhere by us; the recognition itself is the
// BROWSER'S service (Chrome sends the audio to Google's speech service, Safari to Apple's), which is why it is OFF by
// default, the tick is this browser's only (LOCAL_ONLY in prefsSync.js) and the mic runs only while it is on.
//
// Chrome stops listening after a few seconds of silence even with `continuous`, so every `end` while we still want to
// listen starts it again; a run of ends with nothing in between (a tab that lost the mic) backs off and finally stops
// with a message instead of spinning. `onCommand` is read from a ref, so the recogniser is not rebuilt as the page
// re-renders (rebuilding it mid-sentence loses the sentence).

const Recognition = () => (typeof window === 'undefined' ? null : window.SpeechRecognition || window.webkitSpeechRecognition || null)
/** Restart after an `end` / recoverable error: a moment, growing while they keep coming. */
const RESTART_MS = [250, 500, 1000, 2000, 4000]
/** This many ends with no speech in between and it gives up (the pill says so). */
const MAX_SILENT_RESTARTS = 12
/** The same final transcript twice inside this is one command (the engine repeats a result now and then). */
const SAME_TEXT_MS = 1200

export function useVoiceCommands({ enabled, onCommand, lang = VOICE_LANG }) {
  const [supported] = useState(() => Boolean(Recognition()))
  const [listening, setListening] = useState(false)
  const [heard, setHeard] = useState('')            // what the engine is hearing now (interim), for the pill
  const [error, setError] = useState(null)
  const handler = useRef(onCommand)
  useEffect(() => { handler.current = onCommand })     // the latest, without rebuilding the recogniser mid-sentence

  useEffect(() => {
    const Ctor = Recognition()
    if (!enabled || !Ctor) return undefined           // off: `listening` / `heard` are read as off below
    let stopped = false                              // the effect is being torn down - do not restart
    let restarts = 0
    let timer = null
    let lastText = ''
    let lastAt = 0
    const rec = new Ctor()
    rec.lang = lang
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 3

    const start = () => {
      if (stopped) return
      try { rec.start() } catch { /* already started - its own onend restarts it */ }
    }
    const later = () => {
      if (stopped || timer) return
      if (restarts >= MAX_SILENT_RESTARTS) {
        setListening(false)
        setError('The microphone keeps stopping - turn Voice off and on again.')
        return
      }
      const wait = RESTART_MS[Math.min(restarts, RESTART_MS.length - 1)]
      restarts += 1
      timer = setTimeout(() => { timer = null; start() }, wait)
    }

    rec.onstart = () => { if (!stopped) { setListening(true); setError(null) } }
    rec.onaudiostart = () => { restarts = 0 }
    rec.onend = () => { if (!stopped) { setListening(false); later() } }
    rec.onerror = (e) => {
      if (stopped) return
      const kind = e?.error
      if (kind === 'not-allowed' || kind === 'service-not-allowed') {
        stopped = true
        setListening(false)
        setError('The microphone is blocked - allow it for this site in the browser, then turn Voice on again.')
        try { rec.abort() } catch { /* already gone */ }
        return
      }
      if (kind === 'audio-capture') { stopped = true; setListening(false); setError('No microphone was found.'); return }
      if (kind === 'network') setError('The browser\'s speech service could not be reached - trying again.')
      // 'no-speech' and 'aborted' are ordinary: onend restarts.
    }
    rec.onresult = (e) => {
      if (stopped) return
      restarts = 0
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]
        const best = result[0]?.transcript ?? ''
        setHeard(best.trim())
        if (!result.isFinal) continue
        const now = Date.now()
        const text = best.trim().toLowerCase()
        if (text && text === lastText && now - lastAt < SAME_TEXT_MS) continue
        lastText = text
        lastAt = now
        // The engine's alternatives in order - the first one that is a command wins ("gex" is often heard as "jacks"
        // on the first guess and right on the second).
        let command = null
        for (let k = 0; k < result.length && !command; k++) command = parseVoiceCommand(result[k]?.transcript ?? '')
        if (command) handler.current?.(command, best.trim())
      }
    }

    start()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      rec.onstart = null
      rec.onend = null
      rec.onerror = null
      rec.onresult = null
      rec.onaudiostart = null
      try { rec.abort() } catch { /* never started */ }
    }
  }, [enabled, lang])

  const clearError = useCallback(() => setError(null), [])
  // Read as off while the tick is off, whatever the last run left behind.
  return { supported, listening: Boolean(enabled) && listening, heard: enabled ? heard : '', error: enabled ? error : null, clearError }
}
