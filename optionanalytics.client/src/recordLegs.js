// The scanner record's "If bought / If sold" for signals kept before those were recorded with them: rebuilt from that
// day's OI (the same /api/oi-replay run the OI Replay page and the tuning read - stored on the server for a past day),
// with the same rule the live log uses (scannerCore.signalLegs: the ATM option bought and the ATM option sold at the
// signal's minute, held until its index trade exited), then saved into the log so each is worked out once.
import { buildOiContext } from './strategyEngine.js'
import { signalLegs } from './scannerCore.js'
import { expiryFlagOf } from './liveFeeds.js'

const istMs = (s) => (s ? Date.parse(`${String(s).replace(' ', 'T')}+05:30`) : null) // "yyyy-MM-dd HH:mm:ss" (IST) -> ms
const n = (v) => (v === '' || v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null)

/** A closed signal row of the log as a signal signalLegs reads (its side, minute, entry and exit); null when still open. */
export function signalFromRow(r) {
  const t = istMs(r?.time_ist)
  if (!Number.isFinite(t) || !r.status || r.status === 'open' || (r.side !== 'LONG' && r.side !== 'SHORT')) return null
  const exitAt = istMs(r.exit_time_ist)
  return { side: r.side, t, entry: n(r.entry), outcome: { status: r.status, exitAt: Number.isFinite(exitAt) ? exitAt : null, exitPrice: n(r.exit_price) } }
}

/** A signal row that has closed but has no If bought / If sold yet. */
export const needsLegs = (r) => !!signalFromRow(r) && n(r.buy_points) == null && n(r.sell_points) == null

/** The legs of `rows` (signal rows of ONE index and day) from that day's OI context `ctx`, as the log keeps them. */
export function legsFromContext(rows, ctx) {
  const out = []
  for (const r of rows) {
    const x = signalFromRow(r)
    if (!x || !ctx) continue
    const legs = signalLegs(x, ctx)
    if (legs.buyPoints == null && legs.sellPoints == null) continue
    out.push({
      key: r.key, buyOption: legs.buyOption ?? null, buyEntry: legs.buyEntry ?? null, buyExit: legs.buyExit ?? null, buyPoints: legs.buyPoints ?? null,
      sellOption: legs.sellOption ?? null, sellEntry: legs.sellEntry ?? null, sellExit: legs.sellExit ?? null, sellPoints: legs.sellPoints ?? null,
    })
  }
  return out
}

/** The day's OI run for an index and date (the replay: each minute read once it is over). */
export const recordRunUrl = (u, date) => `/api/oi-replay/${u}/run?${new URLSearchParams({ date, timeframeMinutes: '1', expiryFlag: expiryFlagOf(u) })}`

/**
 * Works out the legs of every row in `rows` that needs them, one index and day at a time (`fetchRun(u, date)` -> the run),
 * and returns { legs, failed: [{ underlying, date, reason }] }. `onProgress({ done, total, underlying, date })`.
 */
export async function fillRecordLegs(rows, { fetchRun, onProgress = () => {} }) {
  const groups = new Map()
  for (const r of rows.filter(needsLegs)) {
    const k = `${r.underlying}|${r.date}`
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(r)
  }
  const legs = []
  const failed = []
  let done = 0
  for (const [k, list] of groups) {
    const [underlying, date] = k.split('|')
    onProgress({ done, total: groups.size, underlying, date })
    try {
      const run = await fetchRun(underlying, date)
      if (!run?.success) throw new Error(run?.error ?? 'no option data for the day')
      const got = legsFromContext(list, buildOiContext(run, null, { live: false }))
      if (!got.length) throw new Error('no option premiums at those minutes')
      legs.push(...got)
    } catch (err) {
      failed.push({ underlying, date, reason: err.message })
    }
    done++
  }
  onProgress({ done, total: groups.size })
  return { legs, failed }
}
