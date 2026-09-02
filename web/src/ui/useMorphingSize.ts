import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

const EASE_MOVE = 'cubic-bezier(.23, 1, .32, 1)'
const DEFAULT_DURATION_MS = 260

type Size = { width: number; height: number }
type Axis = 'both' | 'width'

export interface MorphingSizeOptions {
  durationMs?: number
  axis?: Axis
  travel?: boolean
  contentRef?: RefObject<HTMLElement | null>
}

function differs(from: Size, to: Size, axis: Axis): boolean {
  if (axis === 'width') return from.width !== to.width
  return from.width !== to.width || from.height !== to.height
}

function keyframe(size: Size, axis: Axis): Keyframe {
  if (axis === 'width') return { width: `${size.width}px` }
  return { width: `${size.width}px`, height: `${size.height}px` }
}

/**
 * Travels an element between the size it had before a change and the size it
 * has after one, measuring both ends so intrinsic sizes have a real number to
 * animate from. `key` is whatever identifies the change; nothing is left
 * filled afterwards, so the element lands back on its stylesheet size.
 */
export function useMorphingSize(
  ref: RefObject<HTMLElement | null>,
  key: unknown,
  { durationMs = DEFAULT_DURATION_MS, axis = 'both', travel = true, contentRef }: MorphingSizeOptions = {},
) {
  const settled = useRef<Size | null>(null)
  const travelling = useRef<Animation | null>(null)
  const content = useRef<Size | null>(null)
  const chasing = useRef(false)

  /**
   * Sends the element to the size its own stylesheet gives it, always measured
   * rather than derived. A travel in flight is cancelled first, its last frame
   * kept as the new starting point.
   */
  const settle = (element: HTMLElement, moving: Axis) => {
    const running = travelling.current?.playState === 'running'
    const from = running ? { width: element.offsetWidth, height: element.offsetHeight } : settled.current
    travelling.current?.cancel()
    travelling.current = null
    const to = { width: element.offsetWidth, height: element.offsetHeight }
    settled.current = to
    if (!travel || !from || !differs(from, to, moving)) return
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const journey = element.animate(
      [keyframe(from, moving), keyframe(to, moving)],
      { duration: durationMs, easing: EASE_MOVE },
    )
    travelling.current = journey
    journey.onfinish = () => { if (chasing.current) follow() }
  }

  const remember = (element: HTMLElement | null) => {
    content.current = element ? { width: element.offsetWidth, height: element.offsetHeight } : null
  }

  /** Takes the box to whatever its contents have just made it, if they moved at all. */
  const follow = () => {
    const element = ref.current
    const pane = contentRef?.current
    if (!element || !pane) return
    chasing.current = false
    const seen = content.current
    if (seen && seen.width === pane.offsetWidth && seen.height === pane.offsetHeight) return
    remember(pane)
    settle(element, axis)
  }

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    settle(element, axis)
    remember(contentRef?.current ?? null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, key, axis, durationMs, travel])

  useEffect(() => {
    const element = ref.current
    const pane = contentRef?.current
    if (!element || !pane || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (travelling.current?.playState === 'running') { chasing.current = true; return }
      follow()
    })
    observer.observe(pane)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, contentRef, axis, durationMs, travel])
}
