// The page alerts' switches - pop-up, chime, spoken words, Telegram - read by the Order Flow page's sudden OI walls
// and profile / price alerts and OI Replay's OI break and zone alerts. They lived on the strategy scanner's card
// (removed on request) and keep its localStorage key, so what a browser had set still holds; they are shown now by
// AlertSwitches.jsx on the Order Flow page. A missing switch reads as on.

export const ALERT_SWITCHES_KEY = 'optionanalytics.strategyScanner.settings'

/** The switches as saved: { alerts, sound, voice, telegram } (and whatever else an old save held). */
export function readAlertSwitches() {
  try {
    const saved = JSON.parse(localStorage.getItem(ALERT_SWITCHES_KEY))
    return saved && typeof saved === 'object' ? saved : {}
  } catch {
    return {}
  }
}

/** The four switches with their defaults (all on). */
export function alertSwitches(saved = readAlertSwitches()) {
  return {
    alerts: saved.alerts !== false,
    sound: saved.sound !== false,
    voice: saved.voice !== false,
    telegram: saved.telegram !== false,
  }
}
