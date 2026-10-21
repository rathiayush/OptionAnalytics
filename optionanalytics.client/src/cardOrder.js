// A page's saved card order reconciled with the cards it has now (useCardOrder): ids no longer on the page are
// dropped, and a card added since the order was saved goes where the page puts it by default - right after the card
// that precedes it in the default order (at the top when it is first) - not at the very end, where a new card on a
// long page is easy to miss.
export function reconcileCardOrder(storedOrder, cardIds) {
  const known = new Set(cardIds)
  const order = (Array.isArray(storedOrder) ? storedOrder : []).filter((id, i, all) => known.has(id) && all.indexOf(id) === i)
  cardIds.forEach((id, index) => {
    if (order.includes(id)) return
    let at = 0
    for (let j = index - 1; j >= 0; j--) {
      const before = order.indexOf(cardIds[j])
      if (before >= 0) { at = before + 1; break }
    }
    order.splice(at, 0, id)
  })
  return order
}
