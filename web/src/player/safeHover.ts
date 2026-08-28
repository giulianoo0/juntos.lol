/**
 * The corridor a pointer is allowed to travel through on its way to a panel
 * that hangs off a control.
 *
 * A panel that opens on hover and closes the instant the pointer leaves its
 * control is unusable whenever the two are not touching: the natural move is
 * diagonal — up and across towards the slider — and that path crosses the
 * gap between them, where neither is hovered. The panel disappears out from
 * under the very gesture reaching for it.
 *
 * The fix is the one every desktop menu has used for decades: from the point
 * where the pointer left, draw a triangle to the near edge of the panel, and
 * treat everything inside it as still hovering. A pointer heading for the
 * panel stays inside the triangle; one wandering off leaves it immediately,
 * so nothing lingers on screen that the person is not reaching for.
 */

export interface Point {
  x: number
  y: number
}

export interface Box {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * The triangle from `from` to the edge of `panel` facing it: the exit point
 * and the two corners of the nearest edge. A pointer inside this is on its
 * way to the panel.
 */
export function safeTriangle(from: Point, panel: Box): [Point, Point, Point] {
  // Which side the panel is on decides which of its edges the pointer will
  // arrive at, and so which pair of corners bounds the corridor.
  if (from.y >= panel.bottom) {
    return [from, { x: panel.left, y: panel.bottom }, { x: panel.right, y: panel.bottom }]
  }
  if (from.y <= panel.top) {
    return [from, { x: panel.left, y: panel.top }, { x: panel.right, y: panel.top }]
  }
  if (from.x >= panel.right) {
    return [from, { x: panel.right, y: panel.top }, { x: panel.right, y: panel.bottom }]
  }
  return [from, { x: panel.left, y: panel.top }, { x: panel.left, y: panel.bottom }]
}

function cross(a: Point, b: Point, p: Point): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
}

/** Whether `p` is inside the triangle abc, edges included. */
export function inTriangle(p: Point, a: Point, b: Point, c: Point): boolean {
  const d1 = cross(a, b, p)
  const d2 = cross(b, c, p)
  const d3 = cross(c, a, p)
  // One sign throughout means inside, whichever way round the corners were
  // given; a zero is a point sitting exactly on an edge, which counts.
  const negative = d1 < 0 || d2 < 0 || d3 < 0
  const positive = d1 > 0 || d2 > 0 || d3 > 0
  return !(negative && positive)
}

/** Whether a pointer at `p` is still on its way from `from` to `panel`. */
export function heading(p: Point, from: Point, panel: Box): boolean {
  const [a, b, c] = safeTriangle(from, panel)
  return inTriangle(p, a, b, c)
}
