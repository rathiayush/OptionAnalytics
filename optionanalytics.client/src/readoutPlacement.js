// Where a heatmap's hover / tap readout goes (position: fixed), kept on screen: beside the pointer on the side with more
// room, under it (above it near the bottom), wrapping within that room. With less than ~220 px on either side - a phone -
// it spans the screen instead. (It used to flip left with no width limit and ran off a phone's left edge.)
const READOUT_MIN_ROOM = 220

export function readoutPlacement(clientX, clientY, viewportWidth = window.innerWidth, viewportHeight = window.innerHeight) {
  const vertical = clientY > viewportHeight - 120 ? { bottom: viewportHeight - clientY + 14 } : { top: clientY + 14 }
  const toRight = clientX < viewportWidth / 2
  const room = toRight ? viewportWidth - clientX - 22 : clientX - 22
  if (room < READOUT_MIN_ROOM) return { left: 8, right: 8, ...vertical }
  return { ...(toRight ? { left: clientX + 14 } : { right: viewportWidth - clientX + 14 }), width: 'max-content', maxWidth: room, ...vertical }
}
