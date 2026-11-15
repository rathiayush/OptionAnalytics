import { useCallback, useEffect, useState } from 'react'
import { cachedDay, loadFuturesDay, loadOptionDay, optionDayKey, walkPastSessions } from './deltaProfileDays.js'

const NONE = []
const IDLE = { loading: false, sessions: NONE, error: null }

/**
 * The `count` sessions before `dateKey` of `kind` ('options' - of the `flag` series - or 'futures'), oldest first, as they
 * come in: { loading, sessions [{ date, items, candles }], error: { date, message } | null, retry }. `count` 0 = none.
 * OI Replay's delta profile cards and the Profiles page's "Delta" tick read it.
 */
export function usePastDeltaSessions(kind, underlying, dateKey, count, flag = '') {
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((a) => a + 1), [])
  const want = count > 0 && underlying && dateKey ? `${kind}|${underlying}|${flag}|${dateKey}|${count}|${attempt}` : null
  const [state, setState] = useState({ key: null, ...IDLE })
  useEffect(() => {
    if (!want) return undefined
    let cancelled = false
    // Until the walk's first session the hook answers "loading" for this key (state.key differs) - nothing to set here.
    const load = kind === 'options'
      ? (date) => cachedDay(optionDayKey(underlying, flag, date), () => loadOptionDay(underlying, date, flag))
      : (date) => cachedDay(`futures|${underlying}|${date}`, () => loadFuturesDay(underlying, date))
    walkPastSessions(dateKey, count, load, {
      cancelled: () => cancelled,
      onSession: (sessions) => { if (!cancelled) setState({ key: want, loading: true, sessions, error: null }) },
    }).then(({ sessions, error }) => { if (!cancelled) setState({ key: want, loading: false, sessions, error }) })
    return () => { cancelled = true }
  }, [want]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!want) return { ...IDLE, retry }
  return state.key === want ? { loading: state.loading, sessions: state.sessions, error: state.error, retry } : { loading: true, sessions: NONE, error: null, retry }
}

