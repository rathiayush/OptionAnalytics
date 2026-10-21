// The last guard before a line series' setData: lightweight-charts' production build does not check that times are
// strictly ascending, and a repeated or out-of-order time is accepted - then the next mouse-over (crosshair hit test)
// fails to find that bar and throws "Value is null", taking the whole page down. Sorts by time, keeps the LAST point of
// a repeated time (the newer reading), and drops points without a finite value. The dashboard has its own copy
// (App.jsx sanitizeSeries) for the same reason.
export function sanitizeLine(points) {
  if (!points?.length) return []
  const sorted = points.filter((p) => p && Number.isFinite(p.time) && Number.isFinite(p.value)).sort((a, b) => a.time - b.time)
  const out = []
  for (const p of sorted) {
    if (out.length && out[out.length - 1].time === p.time) out[out.length - 1] = p
    else out.push(p)
  }
  return out
}
