/**
 * The corridor a pointer is allowed to travel through on its way to a panel
 * that hangs off a control: from the point where the pointer left, a triangle
 * drawn to the near edge of the panel counts as still hovering.
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
  const negative = d1 < 0 || d2 < 0 || d3 < 0
  const positive = d1 > 0 || d2 > 0 || d3 > 0
  return !(negative && positive)
}

/** Whether `p` is within `panel` itself, edges included. */
export function inBox(p: Point, panel: Box): boolean {
  return p.x >= panel.left && p.x <= panel.right && p.y >= panel.top && p.y <= panel.bottom
}

/**
 * Whether a pointer at `p` is still on its way to `panel`, or already on it.
 * The panel's own box has to count: a pressed slider takes pointer capture and
 * fires leave on everything behind it.
 */
export function heading(p: Point, from: Point, panel: Box): boolean {
  if (inBox(p, panel)) return true
  const [a, b, c] = safeTriangle(from, panel)
  return inTriangle(p, a, b, c)
}
