// Profile-level alerts: tell the trader when price reaches a level of the previous session's volume
// profile (POC, VAH, VAL, HVN, LVN) or market profile / TPO (POC, VAH, VAL) - and say so when the two
// profiles agree on the same price (a confluence), which is the stronger level.
//
// Pure: no clock, no storage. The page feeds it the price each tick and fires the notification for
// whatever it returns. Levels are the previous session's, so they never move and a hit means the same
// thing all day (today's developing profile moves under the price and would alert on its own drift).

const round2 = (v) => Math.round(v * 100) / 100

/** Levels from a volume profile (`vp`: poc / vah / val / hvn[] / lvn[]) and a TPO profile (`tpo`: poc /
 *  vah / val). Levels within `tolerance` of each other are one level, at their average price; it is a
 *  confluence when the volume profile and the TPO profile both have a part in it. Sorted by price. */
export function profileLevels(vp, tpo, tolerance) {
  const raw = []
  const add = (price, label) => { if (Number.isFinite(price) && price > 0) raw.push({ price, label }) }
  if (vp) {
    add(vp.poc, 'VP POC'); add(vp.vah, 'VP VAH'); add(vp.val, 'VP VAL')
    for (const p of vp.hvn ?? []) add(p, 'VP HVN')
    for (const p of vp.lvn ?? []) add(p, 'VP LVN')
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
  return groups.map((g) => {
    const price = round2(g.prices.reduce((s, p) => s + p, 0) / g.prices.length)
    return {
      key: String(price), price, labels: g.labels,
      confluence: g.labels.some((l) => l.startsWith('VP')) && g.labels.some((l) => l.startsWith('TPO')),
    }
  })
}

/** The same levels moved by `offset` (futures -> spot: minus the futures' premium over spot). */
export function shiftLevels(levels, offset) {
  return levels.map((l) => {
    const price = round2(l.price + offset)
    return { ...l, price, key: String(price) }
  })
}

/** Which levels price has just reached. `armed` is a Set of level keys that may alert and is updated in
 *  place: a hit disarms its level, and a level (re)arms once price is more than `rearmDistance` away
 *  from it - so opening the page next to a level, or hovering around one, does not alert over and
 *  over. A hit is price within `tolerance` of the level, or having crossed it since `previousPrice`. */
export function profileHits(levels, previousPrice, price, armed, { tolerance, rearmDistance }) {
  if (!(price > 0)) return []
  const hits = []
  for (const level of levels) {
    const distance = Math.abs(price - level.price)
    const crossed = previousPrice > 0 && (previousPrice - level.price) * (price - level.price) < 0
    if (armed.has(level.key)) {
      if (distance <= tolerance || crossed) { armed.delete(level.key); hits.push(level) }
    } else if (distance > rearmDistance) {
      armed.add(level.key)
    }
  }
  return hits
}

/** The alert text: where price is, which level, and whether the two profiles agree on it. */
export function profileAlertText(level, price, market) {
  const kind = level.confluence ? 'volume + market profile confluence' : 'profile level'
  return `${market} ${price.toFixed(1)} reached ${level.labels.join(' + ')} ${level.price.toFixed(1)} (${kind})`
}
