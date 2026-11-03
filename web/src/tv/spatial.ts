/**
 * Arrow keys moving focus across the screen by where things are, as a remote
 * expects, over the page's own buttons: the room's pieces need no wrapping.
 * An open dialog or menu keeps the focus inside it.
 */
export type Direction = 'up' | 'down' | 'left' | 'right'

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [data-tv-overlay]'

/** Off-axis distance weighs more than distance along it: a remote goes straight before it goes diagonal. */
const OFF_AXIS_WEIGHT = 2
const CENTER_WEIGHT = 0.25

const center = (box: Box) => ({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 })

/** How far apart two ranges are; 0 when they overlap. */
const rangeGap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, b0 - a1, a0 - b1)

/** The index of the box a press of `direction` lands on from `from`, or null at the edge. */
export function nearestInDirection(from: Box, boxes: Box[], direction: Direction): number | null {
  const origin = center(from)
  const horizontal = direction === 'left' || direction === 'right'
  const forward = direction === 'right' || direction === 'down' ? 1 : -1
  let best: number | null = null
  let bestScore = Number.POSITIVE_INFINITY
  boxes.forEach((box, index) => {
    if (box === from) return
    const middle = center(box)
    const along = horizontal ? (middle.x - origin.x) * forward : (middle.y - origin.y) * forward
    if (along <= 1) return
    const primary = horizontal
      ? Math.max(0, forward > 0 ? box.left - from.right : from.left - box.right)
      : Math.max(0, forward > 0 ? box.top - from.bottom : from.top - box.bottom)
    const gap = horizontal ? rangeGap(from.top, from.bottom, box.top, box.bottom) : rangeGap(from.left, from.right, box.left, box.right)
    const offCenter = horizontal ? Math.abs(middle.y - origin.y) : Math.abs(middle.x - origin.x)
    const score = primary + gap * OFF_AXIS_WEIGHT + offCenter * CENTER_WEIGHT
    if (score < bestScore) {
      bestScore = score
      best = index
    }
  })
  return best
}

function focusables(scope: ParentNode): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => {
    if ((element as HTMLButtonElement).disabled) return false
    if (element.closest('[inert], [aria-hidden="true"]')) return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  })
}

/** The dialog or menu on top, if one is open: the remote stays in it. */
export function openOverlay(): HTMLElement | null {
  const open = [...document.querySelectorAll<HTMLElement>(OVERLAY)].filter((element) => !element.closest('[inert]'))
  return open.at(-1) ?? null
}

const boxOf = (element: HTMLElement): Box => {
  const { left, top, right, bottom } = element.getBoundingClientRect()
  return { left, top, right, bottom }
}

/** Moves the focus one step; true when it moved. Nothing focused yet takes the top-left one. */
export function moveFocus(direction: Direction): boolean {
  const scope = openOverlay() ?? document
  const candidates = focusables(scope)
  if (candidates.length === 0) return false
  const active = document.activeElement instanceof HTMLElement && candidates.includes(document.activeElement) ? document.activeElement : null
  let next: HTMLElement | undefined
  if (!active) {
    next = [...candidates].sort((a, b) => boxOf(a).top - boxOf(b).top || boxOf(a).left - boxOf(b).left)[0]
  } else {
    const boxes = candidates.map(boxOf)
    const from = boxes[candidates.indexOf(active)]!
    const index = nearestInDirection(from, boxes, direction)
    next = index === null ? undefined : candidates[index]
  }
  if (!next) return false
  next.focus()
  next.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  return true
}
