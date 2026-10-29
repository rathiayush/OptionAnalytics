// Which alerts the OI Replay page raises - a pop-up, a chime and the voice - live AND while a past day is replayed,
// picked in its "Alerts" dropdown. By default the 🎯 high-probability signal and the CE / PE cumulative line's
// support / resistance breaks; the rest can be added. What the server sends to Telegram is not changed by this.

export const STORED_ALERT_TYPES = 'optionanalytics.oiReplay.alertTypes'

export const ALERT_TYPES = [
  {
    value: 'hp', label: '🎯 High probability',
    title: 'A CE, PE or Net cumulative-line break and the CE or PE OI at ATM ± 1 shifting the set % the same way, within the window (OI totals card).',
  },
  { value: 'ceBreak', label: 'CE S/R break', title: 'The CE cumulative OI line breaks its own support or resistance.' },
  { value: 'peBreak', label: 'PE S/R break', title: 'The PE cumulative OI line breaks its own support or resistance.' },
  { value: 'netBreak', label: 'Net S/R break', title: 'The Net (CE − PE) cumulative OI line breaks its own support or resistance.' },
  { value: 'oiShift', label: 'Big OI shift near ATM', title: 'A strike within ATM ± 3 shifts at least the set OI in one minute - a beep and a box above the spot chart.' },
  { value: 'zone', label: 'Premium / discount zone', title: 'Price moved 3 minutes but the nearest strike\'s OI held (the server\'s check) - live only.' },
]

export const DEFAULT_ALERT_TYPES = ['hp', 'ceBreak', 'peBreak']

/** The saved choice, kept to the alerts there are (in their order); nothing saved -> the default. An empty choice is
 *  kept: no alerts at all is a choice. */
export function reconcileAlertTypes(saved) {
  if (!Array.isArray(saved)) return DEFAULT_ALERT_TYPES
  return ALERT_TYPES.map((t) => t.value).filter((v) => saved.includes(v))
}

/** Only the breaks and 🎯 signals (stepOiBreakAlerts' result) the choice wants. The 🎯 watch itself always sees every
 *  break - a Net break can make a 🎯 signal without Net breaks being announced on their own. */
export function pickOiAlerts({ breaks = [], signals = [] }, types) {
  return {
    breaks: breaks.filter((b) => types.includes(`${b.side.key}Break`)),
    signals: types.includes('hp') ? signals : [],
  }
}
