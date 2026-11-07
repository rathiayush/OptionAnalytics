// OI Replay's "Σ 3 expiries" (asked for - "we are tracking 3 expiries ... cumulative delta combined ... the last expiry,
// current expiry + 1 and current expiry - these 3 sum ... when the check box is ticked everything works on these 3 expiry
// sum"): every OI read on the page - the OI totals' Δ and cumulative Δ, Day OI, Total OI, the heatmap, the walls, Market
// Read, the ladder, the OI alerts - reads the SUM of the nearest expiry's OI and the next two's at each strike and minute.
// The PREMIUMS cannot be added (each expiry has its own price), so a point keeps the nearest expiry's premium, IV and
// volume: the straddle, the premium charts, the paper trades, GEX (each expiry's own gamma) and the option CDV stay on the
// nearest expiry. Pure - the page passes its points, nothing is fetched here.
import { inMarketSession } from './marketSession.js'

/** The expiries added to the nearest (Dhan's rolling-option code / the live feed's chain): the next and the one after. */
export const SUMMED_EXPIRY_CODES = [2, 3]
export const liveFlagOfCode = (code) => `N${code}`

const msOf = (p) => (Number.isFinite(p?.ms) ? p.ms : new Date(p?.time).getTime())

function byStrike(points) {
  const map = new Map()
  for (const p of points ?? []) {
    const ms = msOf(p)
    if (!Number.isFinite(ms) || !inMarketSession(ms)) continue
    let list = map.get(p.strike)
    if (!list) map.set(p.strike, (list = []))
    list.push({ p, ms })
  }
  for (const list of map.values()) list.sort((a, b) => a.ms - b.ms)
  return map
}

/** `base` (the nearest expiry's CE or PE points - the run's, then live) with each point's OI the sum of its own and each of
 *  `extras` (the other expiries' points of the same side) at that strike, as of that point's time - an extra's last reading
 *  AT OR BEFORE it (carried on; never a later one). An expiry first read at a strike AFTER the nearest's first reading there
 *  (Dhan gives a past day's other expiries ATM±3 only, so spot moving brings strikes into their window during the day)
 *  counts from that reading by its CHANGE only, 0 before it - the page already counts a strike that joins the band late from
 *  its first reading, and counted in full, its whole OI would have read as OI ADDED in the Δ and cumulative Δ. One read from
 *  the strike's start counts in full. Strikes the nearest expiry does not have are left out (outside its band); a point with
 *  no OI keeps none. Every other field - premium, IV, volume - is the nearest's. `oiNearest` keeps the nearest's own OI. */
export function sumExpiryOi(base, extras) {
  const lists = (extras ?? []).filter((e) => e?.length)
  if (!lists.length) return base ?? []
  const extraByStrike = lists.map(byStrike)
  const out = []
  for (const [strike, rows] of byStrike(base)) {
    const startMs = rows[0].ms
    // Per expiry: its readings of this strike, a pointer into them, and how it counts (full / from its first reading).
    const others = extraByStrike.map((m) => {
      const list = m.get(strike) ?? []
      const first = list.find((r) => Number.isFinite(r.p.openInterest))
      return { list, i: -1, joinedLate: first ? first.ms > startMs : false, firstOi: first?.p.openInterest ?? null }
    })
    for (const { p, ms } of rows) {
      if (!Number.isFinite(p.openInterest)) { out.push({ ...p, ms }); continue }
      let sum = p.openInterest
      for (const o of others) {
        while (o.i + 1 < o.list.length && o.list[o.i + 1].ms <= ms) o.i++
        const reading = o.i >= 0 ? o.list[o.i].p.openInterest : null
        if (!Number.isFinite(reading)) continue
        sum += o.joinedLate ? reading - o.firstOi : reading
      }
      out.push({ ...p, ms, openInterest: sum, oiNearest: p.openInterest })
    }
  }
  return out
}

/** What the sum holds, for the controls' line: the expiries summed (their dates where known) and what is missing. `bands` -
 *  [{ code, state: 'loading' | 'ready' | 'error', expiry, error, dhanBandSteps, liveFrom }] for codes 2 and 3. */
export function expirySumText(nearestExpiry, bands, { live = false } = {}) {
  const day = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }) : null)
  const names = ['nearest', 'next', 'the one after']
  const parts = [`${day(nearestExpiry) ?? names[0]}`]
  const missing = []
  for (const b of bands ?? []) {
    const name = day(b.expiry) ?? names[b.code - 1] ?? `expiry ${b.code}`
    if (b.state === 'ready') parts.push(name)
    else if (b.state === 'loading') missing.push(`${names[b.code - 1]} loading…`)
    else missing.push(`${names[b.code - 1]} not loaded${b.error ? ` (${b.error})` : ''}`)
  }
  const ready = (bands ?? []).filter((b) => b.state === 'ready')
  const narrow = ready.filter((b) => b.dhanBandSteps != null)
  let window = ''
  if (narrow.length) {
    window = live
      ? ` - the next / far expiries ATM±${narrow[0].dhanBandSteps} before the live feed's own minutes (Dhan gives ATM±${narrow[0].dhanBandSteps} only for them)`
      : ` - the next / far expiries ATM±${narrow[0].dhanBandSteps} only (all Dhan gives for a past day of an expiry that is not the nearest)`
  }
  return `OI = ${parts.join(' + ')}${missing.length ? ` (${missing.join(', ')})` : ''}${window}`
}
