// OI Replay's LIVE "Σ 3 expiries" (asked for - "cumulative delta combined ... current expiry, current expiry + 1 and the
// month's last expiry - these 3 sum ... at every component level ... this feature will work only in live"): every OI read
// on the page - the OI totals' Δ and cumulative Δ, Day OI, Total OI, the heatmap, the walls, Market Read, the ladder, the
// OI alerts - reads the SUM of the current expiry's OI, the next expiry's and the monthly's at each strike and minute, and
// GEX adds each expiry's own (gex.js `chains`). The PREMIUMS cannot be added (each expiry has its own price), so a point
// keeps the current expiry's premium, IV and volume: the straddle, the premium charts, the paper trades and the option
// CDV stay on it. Pure - the page passes its points, nothing is fetched here.
import { inMarketSession } from './marketSession.js'

/** The expiries added to the current one, live: the NEXT (the live feed's N2 - the series' expiry code 2) and the MONTHLY
 *  (its MONTH chain - the MONTH series' code 1) - the monthly only when it is neither the current nor the next expiry (the
 *  month's last weeks; BANKNIFTY lists monthlies only): an expiry is never counted twice. `listed` = the expiries listed
 *  from today, nearest first (the page's N1, N2 ...); `month` = the monthly's date; `nearestFlag` = the series the current
 *  expiry is read from (WEEK, BANKNIFTY MONTH). */
export function summedExpiries(listed, month, nearestFlag) {
  const out = []
  if (!listed?.length) return out   // not loaded yet: whether the monthly is the current or the next is not known
  if (listed[1]) out.push({ key: 'N2', liveFlag: 'N2', expiryFlag: nearestFlag, expiryCode: 2, expiry: listed[1], name: 'next' })
  if (month && month !== listed[0] && month !== listed[1]) {
    out.push({ key: 'MONTH', liveFlag: 'MONTH', expiryFlag: 'MONTH', expiryCode: 1, expiry: month, name: 'monthly' })
  }
  return out
}

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

const dayText = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }) : null)
const hhmm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })

/** What the sum holds, for the controls' line: the expiries summed (their dates), what is still loading or missing, the
 *  monthly when it is already the current / next expiry, and the next expiry's ATM±3 before the live feed's own minutes.
 *  `bands` - summedExpiries' entries with { state: 'loading' | 'ready' | 'error', error, dhanBandSteps, liveFrom }. */
export function expirySumText(currentExpiry, bands, { month = null } = {}) {
  const parts = [`${dayText(currentExpiry) ?? 'current'} (current)`]
  const missing = []
  for (const b of bands ?? []) {
    const name = `${dayText(b.expiry) ?? b.name} (${b.name})`
    if (b.state === 'ready') parts.push(name)
    else if (b.state === 'loading') missing.push(`${b.name} loading…`)
    else missing.push(`${b.name} not loaded${b.error ? ` (${b.error})` : ''}`)
  }
  const notes = []
  if (month && !(bands ?? []).some((b) => b.key === 'MONTH')) notes.push(`the monthly (${dayText(month)}) is already ${month === currentExpiry ? 'the current' : 'the next'} expiry - counted once`)
  const narrow = (bands ?? []).filter((b) => b.state === 'ready' && b.dhanBandSteps != null && b.dhanBandSteps < 10)
  for (const b of narrow) notes.push(`the ${b.name} expiry ATM±${b.dhanBandSteps} before ${b.liveFrom ? hhmm(b.liveFrom) : 'the live feed'} (all Dhan gives for it; the live feed's ATM±10 ${b.liveFrom ? 'from then' : 'once it has it'})`)
  return `OI = ${parts.join(' + ')}${missing.length ? ` (${missing.join(', ')})` : ''}${notes.length ? ` - ${notes.join('; ')}` : ''}`
}
