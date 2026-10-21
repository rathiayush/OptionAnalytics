// Alert outputs shared by the strategy scanner and the Order Flow page's price alerts: a chime, the
// spoken words and the server's Telegram chat.

// A trade punched / placed (and a live trade's exit) to the server's Telegram chat - live view only.
// `key` (one trade event): the server sends a keyed message once a day, however many open pages report it.
export function telegram(text, key = null) {
  fetch('/api/alerts/telegram', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, key }) }).catch(() => {})
}
let audioCtx = null
export function unlockAudio() {
  try { audioCtx ??= new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume?.() } catch { /* no audio */ }
}
export function chime(up) {
  try {
    unlockAudio()
    const ctx = audioCtx
    const notes = up ? [660, 880, 1100] : [1100, 880, 660]
    notes.forEach((f, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const at = ctx.currentTime + i * 0.16
      osc.type = 'triangle'
      osc.frequency.value = f
      gain.gain.setValueAtTime(0.001, at)
      gain.gain.exponentialRampToValueAtTime(0.3, at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.15)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(at)
      osc.stop(at + 0.16)
    })
  } catch { /* audio blocked - the notification still shows */ }
}
export function speak(text) {
  try {
    if (!window.speechSynthesis) return
    const u = new SpeechSynthesisUtterance(text)
    u.rate = 1.05
    window.speechSynthesis.speak(u)
  } catch { /* no speech */ }
}

/** Which saved alerts the price `last` has reached: an 'above' alert at or over its level, a 'below'
 *  one at or under it. */
export function alertsHit(alerts, last) {
  if (!(last > 0)) return []
  return alerts.filter((a) => (a.dir === 'above' ? last >= a.price : last <= a.price))
}
