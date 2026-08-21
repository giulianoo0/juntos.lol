import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/** Leaves at once and settles: a box that eased in as well read as lag. */
const EASE_MOVE = 'cubic-bezier(.23, 1, .32, 1)'
const DEFAULT_DURATION_MS = 260

type Size = { width: number; height: number }
type Axis = 'both' | 'width'

export interface MorphingSizeOptions {
  durationMs?: number
  /** 'width' leaves the height alone, for a control that only grows sideways. */
  axis?: Axis
  /**
   * False lands the new size at once instead of travelling to it.
   *
   * A change is only worth watching where there is something left to watch it
   * happen to. Going back to a control the panel has already dissolved out of
   * is not that: the box would spend a third of a second closing on an empty
   * space, behind contents that finished swapping before it set off.
   */
  travel?: boolean
  /**
   * The element whose size the box takes. Given one, the box also follows it
   * growing or shrinking between key changes — an error appearing under a
   * form, a list arriving — instead of only at them.
   */
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
 * has after one.
 *
 * CSS cannot do this on its own whenever either end is an intrinsic size — a
 * box that hugs its contents, a button that hugs its label. An intrinsic size
 * is re-resolved against whatever is inside the element now, so by the time a
 * transition could start there is no old value left to start from and the
 * element simply snaps. Measuring before the change and animating to the
 * measured size after it gives both ends a real number.
 *
 * `key` is whatever identifies the change — a step name, a loading flag.
 * Nothing is left filled afterwards, so the element lands back on its own
 * stylesheet size and a later change is never measured against a pinned value.
 */
export function useMorphingSize(
  ref: RefObject<HTMLElement | null>,
  key: unknown,
  { durationMs = DEFAULT_DURATION_MS, axis = 'both', travel = true, contentRef }: MorphingSizeOptions = {},
) {
  // Where the element was last asked to stop. Kept separately because the
  // element itself, mid-travel, measures as a frame of the journey rather than
  // as anywhere it is going to end up.
  const settled = useRef<Size | null>(null)
  const travelling = useRef<Animation | null>(null)
  // The contents as they measured at the last settle, so a resize that is only
  // that settle rippling through can be told apart from the contents moving.
  const content = useRef<Size | null>(null)
  // Set when the contents move while the box is already travelling, so the
  // move is answered on arrival rather than dropped.
  const chasing = useRef(false)

  /**
   * Sends the element from wherever it is now to the size its own stylesheet
   * gives it.
   *
   * The target is always measured, never derived: the box's height is its
   * contents' only while its stylesheet lets it hug them, and deriving one
   * from the other is how a pill with a fixed height ends up animating to the
   * height of the label inside it and then snapping back. A measurement only
   * reads as the stylesheet size with nothing animating over it, so the travel
   * in flight is stopped first — and its last frame kept, so the element
   * carries on from where it had got to instead of restarting from a size it
   * has already left.
   */
  const settle = (element: HTMLElement, moving: Axis) => {
    const running = travelling.current?.playState === 'running'
    const from = running ? { width: element.offsetWidth, height: element.offsetHeight } : settled.current
    travelling.current?.cancel()
    travelling.current = null
    const to = { width: element.offsetWidth, height: element.offsetHeight }
    // Recorded either way: a change that lands at once is still where the next
    // travel has to start from.
    settled.current = to
    if (!travel || !from || !differs(from, to, moving)) return
    // Reduced motion means the size change lands at once rather than travelling.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const journey = element.animate(
      [keyframe(from, moving), keyframe(to, moving)],
      { duration: durationMs, easing: EASE_MOVE },
    )
    travelling.current = journey
    // Whatever moved while this was in flight is answered here, where the box
    // is somewhere real again and can be measured. Cancelling does not run
    // this, so a travel that was replaced leaves the follow to its replacement.
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
    // A delivery reporting the size the last settle already measured is that
    // settle arriving here a frame later, not the contents moving.
    if (seen && seen.width === pane.offsetWidth && seen.height === pane.offsetHeight) return
    remember(pane)
    settle(element, axis)
  }

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    // Runs before the browser paints the new contents, so the natural size is
    // there to be measured.
    settle(element, axis)
    remember(contentRef?.current ?? null)
    // settle closes over refs and options that are stable for a given element.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, key, axis, durationMs, travel])

  useEffect(() => {
    const element = ref.current
    const pane = contentRef?.current
    // jsdom has no ResizeObserver, and a test that renders this component
    // should not have to care that the box follows its contents.
    if (!element || !pane || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      // Nothing is measured while the box is travelling. A box that clips its
      // contents lays them out against the width it has at that instant, so
      // mid-travel every frame reshapes them and reports back here; answering
      // that would retarget the travel from wherever it had got to, once a
      // frame, and the box would crawl at its own contents' heels without ever
      // arriving. The delivery is not thrown away either — a step changing
      // while the panel is still moving is exactly when that would show — it
      // is deferred to the end of the travel, which is the next moment the box
      // measures as anywhere.
      if (travelling.current?.playState === 'running') { chasing.current = true; return }
      follow()
    })
    observer.observe(pane)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, contentRef, axis, durationMs, travel])
}
