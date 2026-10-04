import { useEffect, useMemo, useState } from 'react'
import { buildOiContext } from './strategyEngine.js'

const MIN = 60_000

/** The day's options and futures OI (and option premiums) - the same data OI Replay loads - for the
 *  Order Flow page: the order flow read, the strategy scanner and its option trades. Live: refreshed
 *  every 2 minutes (OI moves slowly; the strategies read 10-45 minute changes). */
export function useDayOi(underlying, date, isReplay) {
  // The run is kept with the request it answers, so a new day / underlying never shows the old one.
  const requestKey = `${underlying}:${date}:${isReplay ? 'replay' : 'live'}`
  const [loaded, setLoaded] = useState(null)
  const run = loaded?.key === requestKey ? loaded.run : null
  const [error, setError] = useState(null)
  const [expiryDate, setExpiryDate] = useState(null)
  useEffect(() => {
    if (!date) return undefined
    let cancelled = false
    const key = `${underlying}:${date}:${isReplay ? 'replay' : 'live'}`
    const flag = underlying === 'BANKNIFTY' ? 'MONTH' : 'WEEK'
    const load = () => {
      const params = new URLSearchParams({ date, timeframeMinutes: '1', expiryFlag: flag, ...(isReplay ? {} : { forceLive: 'true' }) })
      fetch(`/api/oi-replay/${underlying}/run?${params}`)
        .then((r) => r.json())
        .then((body) => {
          if (cancelled) return
          if (!body?.success) { setError(body?.error ?? 'OI data unavailable'); return }
          setLoaded({ key, run: body })
          setError(null)
        })
        .catch((err) => { if (!cancelled) setError(err.message) })
    }
    load()
    fetch(`/api/oi-replay/${underlying}/expiries`).then((r) => r.json()).then((b) => {
      if (!cancelled) setExpiryDate(underlying === 'BANKNIFTY' ? b?.month ?? null : b?.week ?? null)
    }).catch(() => {})
    const id = isReplay ? null : setInterval(load, 2 * MIN)
    return () => { cancelled = true; if (id) clearInterval(id) }
  }, [underlying, date, isReplay])
  const oi = useMemo(() => buildOiContext(run, expiryDate), [run, expiryDate])
  return { oi, error }
}
