// Profile-level alerts: tell the trader when price reaches a level of the previous session's volume
// profile (POC, VAH, VAL, HVN) or market profile / TPO (POC, VAH, VAL), or enters one of their gaps - the
// volume profile's LVN gaps, the market profile's LVN gaps and single prints, thin stretches price tends to
// cross fast - and say so when the two profiles agree on the same price (a confluence), the stronger level.
//
// Pure: no clock, no storage. The page feeds it the price each tick and fires the notification for
// whatever it returns. Levels are the previous session's, so they never move and a hit means the same
// thing all day (today's developing profile moves under the price and would alert on its own drift).

import { profileGaps, tpoProfile } from './profiles.js'

const round2 = (v) => Math.round(v * 100) / 100

/** Levels from a volume profile (`vp`: poc / vah / val / hvn[] / lvn[], and its `rows`) and a TPO profile
 *  (`tpo`: poc / vah / val, and its `rows`). Levels within `tolerance` of each other are one level, at their
 *  average price; it is a confluence when the volume profile and the TPO profile both have a part in it.
 *  With the profiles' rows, their gaps too (profileGaps): zones { low, high } that alert on price entering
 *  them - each LVN is then its gap (without rows, a level at its price). Sorted by price. */
export function profileLevels(vp, tpo, tolerance) {
  const raw = []
  const add = (price, label) => { if (Number.isFinite(price) && price > 0) raw.push({ price, label }) }
  const gaps = profileGaps(vp, tpo, tolerance)
  if (vp) {
    add(vp.poc, 'VP POC'); add(vp.vah, 'VP VAH'); add(vp.val, 'VP VAL')
    for (const p of vp.hvn ?? []) add(p, 'VP HVN')
    if (!vp.rows?.length) for (const p of vp.lvn ?? []) add(p, 'VP LVN')
  }
  if (tpo) { add(tpo.poc, 'TPO POC'); add(tpo.vah, 'TPO VAH'); add(tpo.val, 'TPO VAL') }
  raw.sort((a, b) => a.price - b.price)
  const groups = []
  for (const item of raw) {
    const last = groups.at(-1)
    // Measured from the group's first price, so a long chain of levels does not snowball into one.
    if (last && item.price - last.prices[0] <= tolerance) { last.prices.push(item.price); last.labels.push(item.label) }
    else groups.push({ prices: [item.price], labels: [item.label] })
  }
  const confluence = (labels) => labels.some((l) => l.startsWith('VP')) && labels.some((l) => l.startsWith('TPO'))
  const levels = groups.map((g) => {
    const price = round2(g.prices.reduce((s, p) => s + p, 0) / g.prices.length)
    return {
      // id: the level's identity - it does not change when the level is moved onto spot (shiftLevels), so a
      // premium that ticks while price approaches never disarms it.
      id: `${g.labels.join('+')}@${price}`, key: String(price), price, low: price, high: price, labels: g.labels, confluence: confluence(g.labels),
    }
  })
  for (const z of gaps) {
    const low = round2(z.low)
    const high = round2(z.high)
    const price = round2((low + high) / 2)
    levels.push({ id: `${z.labels.join('+')}@${low}-${high}`, key: String(price), price, low, high, gap: high > low, labels: z.labels, confluence: confluence(z.labels) })
  }
  return levels.sort((a, b) => a.price - b.price)
}

/** The same levels moved by `offset` (futures -> spot: minus the futures' premium over spot) - same ids. */
export function shiftLevels(levels, offset) {
  return levels.map((l) => {
    const price = round2(l.price + offset)
    return { ...l, price, low: round2((l.low ?? l.price) + offset), high: round2((l.high ?? l.price) + offset), key: String(price) }
  })
}

/** The previous day's SPOT profiles as alert levels, labelled "Spot VP ..." / "Spot TPO ...": the server's
 *  volume profile (the POC / VAH / VAL / HVN / LVN lines drawn on the OI Replay charts - the strongest HVN;
 *  each LVN as its gap, from the server's `bins`) and the day's market profile from its one-minute `bars`
 *  (tpoProfile, rows of `tpoRow`): POC / VAH / VAL, LVN gaps and single prints. */
export function spotProfileLevels(spotVp, tpoRow) {
  if (!spotVp || !(spotVp.poc > 0)) return []
  const rows = (spotVp.bins ?? []).map((b) => ({ price: b.price, total: b.volume }))
  const vp = { poc: spotVp.poc, vah: spotVp.vah, val: spotVp.val, hvn: (spotVp.hvn ?? []).slice(0, 1), lvn: rows.length ? spotVp.lvn ?? [] : (spotVp.lvn ?? []).slice(0, 1), rows }
  const tpo = spotVp.bars?.length ? tpoProfile(spotVp.bars, tpoRow) : null
  const date = spotVp.profileDate ? String(spotVp.profileDate).slice(0, 10) : null
  return profileLevels(vp, tpo, tpoRow).map((l) => ({
    ...l, id: `spot:${l.id}`, labels: l.labels.map((x) => x.replace(/^(VP|TPO) /, 'Spot $1 ')), ...(date ? { date } : {}),
  }))
}

/** How close is "reached": half a TPO row, or 0.018% of the price if that is more (about 4 NIFTY points, 9
 *  BANKNIFTY, 13 SENSEX) - the index wicks to a level, it rarely prints it to the paisa. A level re-arms once
 *  price is four times that away. */
export function alertOptions(tpoRow, price) {
  const tolerance = Math.max((tpoRow || 5) / 2, (price > 0 ? price : 0) * 0.00018)
  return { tolerance, rearmDistance: 4 * tolerance }
}

/** Which levels price has just reached. `armed` is a Set of level ids that may alert and is updated in
 *  place: a hit disarms its level, and a level (re)arms once price is more than `rearmDistance` away
 *  from it - so opening the page next to a level, or hovering around one, does not alert over and
 *  over. A hit is price within `tolerance` of the level, or having crossed it since `previousPrice`. */
export function profileHits(levels, previousPrice, price, armed, { tolerance, rearmDistance }) {
  if (!(price > 0)) return []
  const hits = []
  for (const level of levels) {
    const id = level.id ?? level.key
    // A gap is a zone: inside it is distance 0, and jumping from one side of it to the other crosses it.
    const low = level.low ?? level.price
    const high = level.high ?? level.price
    const side = (p) => (p < low ? -1 : p > high ? 1 : 0)
    const distance = price < low ? low - price : price > high ? price - high : 0
    const crossed = previousPrice > 0 && side(previousPrice) * side(price) < 0
    if (armed.has(id)) {
      if (distance <= tolerance || crossed) { armed.delete(id); hits.push(level) }
    } else if (distance > rearmDistance) {
      armed.add(id)
    }
  }
  return hits
}

/** Where a level is: its price, or a gap's low-high. */
export const levelWhere = (level) => (level.gap ? `${level.low.toFixed(1)}-${level.high.toFixed(1)}` : level.price.toFixed(1))

/** The alert text: where price is, which level (or gap entered), and whether the two profiles agree on it. */
export function profileAlertText(level, price, market) {
  const kind = level.confluence ? 'volume + market profile confluence' : level.gap ? 'thin - price tends to move through fast' : 'profile level'
  return `${market} ${price.toFixed(1)} ${level.gap ? 'entered' : 'reached'} ${level.labels.join(' + ')} ${levelWhere(level)}${level.date ? ` (${level.date})` : ''} (${kind})`
}

/** Per-market memory for watchProfiles (which levels are armed, the last price seen). */
export const newProfileWatch = () => ({ futures: { armed: new Set(), previous: 0 }, spot: { armed: new Set(), previous: 0 } })

/**
 * One look at the prices: the levels each market has just reached - [{ market, level, price }]. `levels` -
 * { futures, spot } (spot: the spot profiles' own, else the futures levels less the premium - spotLevelsOf);
 * `prices` - { futures, spot }; `enabled` - { futures, spot }. A market switched off is still tracked, so
 * switching it on next to a level does not alert at once. Used by the Order Flow and OI Replay pages and the
 * server scanner alike.
 */
export function watchProfiles(state, { levels, prices, enabled = { futures: true, spot: true }, tpoRow }) {
  const out = []
  for (const market of ['futures', 'spot']) {
    const price = prices[market]
    const s = state[market]
    if (!(price > 0) || !s) continue
    const hits = profileHits(levels[market] ?? [], s.previous, price, s.armed, alertOptions(tpoRow, price))
    s.previous = price
    if (enabled[market] === false) continue
    for (const level of hits) out.push({ market, level, price })
  }
  return out
}

/** The spot levels: the spot's own previous-day profiles (spotProfileLevels); without them, the futures
 *  levels moved by the premium (when known) - not both, or every futures level would alert twice on spot. */
export function spotLevelsOf(futuresLevels, basis, spotOwn = []) {
  if (spotOwn.length) return spotOwn
  return Number.isFinite(basis) ? shiftLevels(futuresLevels, -basis) : []
}
