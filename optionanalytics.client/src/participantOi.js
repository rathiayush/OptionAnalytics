// NSE's participant-wise open interest as the GEX sign (gex.js `shares`). Who holds the other side of the option OI is
// not in the option chain, so GEX usually ASSUMES it: dealers long every call, short every put ("Standard"). NSE publishes
// what is actually held each evening - index option calls and puts LONG and SHORT by Client, DII, FII and Pro (proprietary
// desks) - the server's /api/oi-replay/participant-oi (NseParticipantOi): the latest day's file BEFORE the session, so
// nothing a session could not have known.
//
// The HEDGERS - the group taken as hedging its options with the index - are picked (`HEDGER_GROUPS`): the Pro desks (the
// default: market makers and prop books), Pro + FII, or everyone but the clients. Their SHARE of a side:
//   share = (their longs - their shorts) / all the open interest of that side      (-1 ... +1)
// and the dealers' OI of every call (put) is its OI x the call (put) share - where Standard uses +1 and -1. It is ONE
// number a side for all NSE index options together (every index, strike and expiry, in contracts): it says which way and
// how much the hedgers lean, not at which strike. So the walls and max gamma (gamma x OI, whoever holds it) do not move;
// the net GEX, its sign, the flip and each strike's GEX do - and the net is far smaller than Standard's, because the real
// books are close to balanced. SENSEX trades on BSE: NSE's file is a stand-in there.

export const HEDGER_GROUPS = [
  { value: 'pro', label: 'Pro desks', types: ['PRO'] },
  { value: 'proFii', label: 'Pro + FII', types: ['PRO', 'FII'] },
  { value: 'nonClient', label: 'All but clients', types: ['PRO', 'FII', 'DII'] },
]
export const HEDGER_DEFAULT = 'pro'
export const hedgerGroup = (value) => HEDGER_GROUPS.find((g) => g.value === value) ?? HEDGER_GROUPS[0]

/** The GEX signs a card can show. NSE's positions are NOT a sign to pick (four choices left the user unable to tell which
 *  to trust - "I do not know which to trust"): they are the third vote of the card's one verdict (`gexVerdict`). */
export const GEX_SIGNS = [
  { value: 'standard', label: 'Standard' },
  { value: 'buildup', label: 'OI build-up' },
]
/** The sign to show: the one picked, else Standard (a saved NSE sign from when they could be picked reads as Standard). */
export const gexSignOf = (days, picked) => (GEX_SIGNS.some((s) => s.value === picked) && days?.[picked] ? picked : 'standard')
export const gexSignOptions = () => GEX_SIGNS.map(({ value, label }) => ({ value, label }))

const regimeOf = (minute) => (minute && Number.isFinite(minute.net) && minute.net !== 0 ? (minute.net > 0 ? 'positive' : 'negative') : null)

/**
 * THE ONE VERDICT of a minute, from the three reads of who holds the gamma - `standard` and `buildup` (the assumed signs)
 * and `nse` (signed by NSE's real positions; null = no file): `{ regime ('positive' = range / pin day, 'negative' = trend /
 * fast day, null = unclear), confidence ('high' | 'medium' | 'none'), votes: [{ name, regime }], agree, of, text }`.
 * The rule: Standard and OI build-up must agree, or it is unclear (the card's rule before). NSE's positions then only
 * move the confidence: with them = high, against them = medium (smaller size), no file = medium.
 */
export function gexVerdict(standard, buildup, nse = null) {
  const votes = [{ name: 'Standard', regime: regimeOf(standard) }, { name: 'OI build-up', regime: regimeOf(buildup) }]
  if (nse) votes.push({ name: 'NSE positions', regime: regimeOf(nse) })
  const [a, b, c] = votes.map((v) => v.regime)
  const regime = a != null && a === b ? a : null
  const agree = regime ? votes.filter((v) => v.regime === regime).length : 0
  const confidence = !regime ? 'none' : c === regime ? 'high' : 'medium'
  const day = regime === 'positive' ? 'RANGE / PIN day - fade the walls, aim at the max gamma strike' : 'TREND / FAST day - trade with the break, do not fade it'
  const text = !regime
    ? 'UNCLEAR - Standard and OI build-up disagree: ignore the regime and the flip, trade the walls only'
    : c == null ? `${day} (Standard and OI build-up agree)`
      : c === regime ? `${day} (all 3 reads agree - high confidence)`
        : `${day} (2 of 3 - NSE's real positions lean the other way: smaller size)`
  return { regime, confidence, votes, agree, of: votes.length, text }
}

const rowOf = (day, type) => (day?.rows ?? []).find((r) => String(r.type ?? '').trim().toUpperCase() === type)

/**
 * The hedgers' share of the calls and of the puts from a day's file (`day` - { date, rows: [{ type, callLong, callShort,
 * putLong, putShort }] }): `{ call, put (each -1 ... +1, + = net long), date, group, callNet, putNet, callTotal, putTotal
 * (contracts) }`; null when the file has no positions for the group or no open interest.
 */
export function participantShares(day, group = HEDGER_DEFAULT) {
  const g = hedgerGroup(group)
  const rows = g.types.map((t) => rowOf(day, t)).filter(Boolean)
  if (rows.length !== g.types.length) return null
  const all = ['CLIENT', 'DII', 'FII', 'PRO'].map((t) => rowOf(day, t)).filter(Boolean)
  const sum = (list, key) => list.reduce((a, r) => a + (Number(r[key]) || 0), 0)
  const total = rowOf(day, 'TOTAL')
  const callTotal = Number(total?.callLong) > 0 ? Number(total.callLong) : sum(all, 'callLong')
  const putTotal = Number(total?.putLong) > 0 ? Number(total.putLong) : sum(all, 'putLong')
  if (!(callTotal > 0 && putTotal > 0)) return null
  const callNet = sum(rows, 'callLong') - sum(rows, 'callShort')
  const putNet = sum(rows, 'putLong') - sum(rows, 'putShort')
  const clamp = (v) => Math.max(-1, Math.min(1, v))
  return { call: clamp(callNet / callTotal), put: clamp(putNet / putTotal), date: day.date ?? null, group: g.value, callNet, putNet, callTotal, putTotal }
}

const pct = (v) => `${(Math.abs(v) * 100).toFixed(1)}%`
/** The shares in words: "Pro desks net LONG 1.5% of the calls, SHORT 0.8% of the puts". */
export function sharesText(shares) {
  if (!shares) return ''
  const side = (v, what) => (v === 0 ? `flat the ${what}` : `net ${v > 0 ? 'LONG' : 'SHORT'} ${pct(v)} of the ${what}`)
  return `${hedgerGroup(shares.group).label} ${side(shares.call, 'calls')}, ${side(shares.put, 'puts')}`
}
