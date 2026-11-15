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
 * again at most every few seconds. Null while `enabled` is off (neither card shown). `chains`: other expiries added in
 * (OI Replay's live "Σ 3 expiries" - [{ cePoints, pePoints, expiry }], gexDay's `chains`), each with its own gamma.
 * `shares`: NSE's participant positions ({ call, put } - participantOi.js): with them the day is ALSO worked out signed by
 * them - `participant` (as held) and `participantBuildup` (from them, then the OI changes read by their IV).
 */
export function useGexDays(cePoints, pePoints, spotBars, { expiry = null, live = false, enabled = true, chains = null, shares = null } = {}) {
  const inputs = useMemo(() => ({ cePoints, pePoints, spotBars, chains }), [cePoints, pePoints, spotBars, chains])
  const shown = useThrottled(inputs, LIVE_EVERY_MS, live)
  const call = Number.isFinite(shares?.call) ? shares.call : null
  const put = Number.isFinite(shares?.put) ? shares.put : null
  return useMemo(() => (enabled ? {
    standard: gexDay(shown.cePoints, shown.pePoints, shown.spotBars, { sign: 'standard', expiry, chains: shown.chains ?? [] }),
    buildup: gexDay(shown.cePoints, shown.pePoints, shown.spotBars, { sign: 'buildup', expiry, chains: shown.chains ?? [] }),
    ...(call != null && put != null ? {
      participant: gexDay(shown.cePoints, shown.pePoints, shown.spotBars, { sign: 'standard', expiry, chains: shown.chains ?? [], shares: { call, put } }),
      participantBuildup: gexDay(shown.cePoints, shown.pePoints, shown.spotBars, { sign: 'buildup', expiry, chains: shown.chains ?? [], shares: { call, put } }),
    } : {}),
  } : null), [shown, expiry, enabled, call, put])
}
