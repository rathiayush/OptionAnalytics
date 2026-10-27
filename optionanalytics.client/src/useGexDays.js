import { useEffect, useMemo, useRef, useState } from 'react'
import { gexDay } from './gex.js'

const LIVE_EVERY_MS = 5000

// `value`, passed on at most every `ms` while `throttle` is on (live: the option points change with every tick, and a
// day's GEX takes a moment to work out) - at once otherwise.
function useThrottled(value, ms, throttle) {
  const [shown, setShown] = useState(value)
  const lastRef = useRef(0)
  useEffect(() => {
    const wait = throttle ? Math.max(0, lastRef.current + ms - Date.now()) : 0
    const id = setTimeout(() => { lastRef.current = Date.now(); setShown(value) }, wait)
    return () => clearTimeout(id)
  }, [value, ms, throttle])
  return shown
}

/**
 * The day's GEX under both signs - `{ standard, buildup }`, gexDay - worked out once on the page for the GEX card and the
 * entry checklist: every minute of the day (each uses only what was known at it), cut at the clock by each; live (`live`),
 * again at most every few seconds. Null while `enabled` is off (neither card shown).
 */
export function useGexDays(cePoints, pePoints, spotBars, { expiry = null, live = false, enabled = true } = {}) {
  const inputs = useMemo(() => ({ cePoints, pePoints, spotBars }), [cePoints, pePoints, spotBars])
  const shown = useThrottled(inputs, LIVE_EVERY_MS, live)
  return useMemo(() => (enabled ? {
    standard: gexDay(shown.cePoints, shown.pePoints, shown.spotBars, { sign: 'standard', expiry }),
    buildup: gexDay(shown.cePoints, shown.pePoints, shown.spotBars, { sign: 'buildup', expiry }),
  } : null), [shown, expiry, enabled])
}
