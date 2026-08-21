import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/** Matches --ease-move: something travelling on screen eases at both ends. */
const EASE_MOVE = 'cubic-bezier(.77, 0, .175, 1)'
const DEFAULT_DURATION_MS = 320

type Size = { width: number; height: number }
type Axis = 'both' | 'width' | 'height'

export interface MorphingSizeOptions {
  durationMs?: number
  /** 'width' leaves the height alone, for a control that only grows sideways. */
  axis?: 'both' | 'width'
  /**
   * The element whose height the box takes. Given one, the box also follows it
   * growing or shrinking between key changes — an error appearing under a
   * form, a list arriving — instead of only at them.
   */
  contentRef?: RefObject<HTMLElement | null>
}

/** The element's own vertical trim, which its content height sits inside. */
function verticalChrome(element: HTMLElement): number {
  const style = getComputedStyle(element)
  return parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)
    + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
}

function differs(from: Size, to: Size, axis: Axis): boolean {
  if (axis === 'width') return from.width !== to.width
  if (axis === 'height') return from.height !== to.height
  return from.width !== to.width || from.height !== to.height
}

function keyframe(size: Size, axis: Axis): Keyframe {
  if (axis === 'width') return { width: `${size.width}px` }
  if (axis === 'height') return { height: `${size.height}px` }
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
  { durationMs = DEFAULT_DURATION_MS, axis = 'both', contentRef }: MorphingSizeOptions = {},
) {
  // Where the element was last asked to stop. Kept separately because the
  // element itself, mid-travel, measures as a frame of the journey rather than
  // as anywhere it is going to end up.
  const settled = useRef<Size | null>(null)
  const travelling = useRef<Animation | null>(null)

  /**
   * A change arriving while the element is still moving retargets it from
   * wherever it currently is, rather than being dropped or restarted from a
   * position it has already left.
   */
  const travel = (element: HTMLElement, to: Size, moving: Axis) => {
    const from = settled.current
    settled.current = to
    if (!from || !differs(from, to, moving)) return
    // Reduced motion means the size change lands at once rather than travelling.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    // Read before cancelling: afterwards the element measures as its CSS size.
    const start = travelling.current?.playState === 'running'
      ? { width: element.offsetWidth, height: element.offsetHeight }
      : from
    travelling.current?.cancel()
    travelling.current = element.animate(
      [keyframe(start, moving), keyframe(to, moving)],
      { duration: durationMs, easing: EASE_MOVE },
    )
  }

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    // Runs before the browser paints the new contents, so the natural size is
    // there to be measured — but only once any travel in flight is stopped.
    const moving = travelling.current?.playState === 'running'
      ? { width: element.offsetWidth, height: element.offsetHeight }
      : null
    travelling.current?.cancel()
    travelling.current = null
    if (moving) settled.current = moving
    travel(element, { width: element.offsetWidth, height: element.offsetHeight }, axis)
    // travel closes over refs and options that are stable for a given element.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, key, axis, durationMs])

  useEffect(() => {
    const element = ref.current
    const content = contentRef?.current
    // jsdom has no ResizeObserver, and a test that renders this component
    // should not have to care that the box follows its contents.
    if (!element || !content || typeof ResizeObserver === 'undefined') return
    let first = true
    const observer = new ResizeObserver(() => {
      // The first delivery is the size the element already has.
      if (first) { first = false; return }
      // Taken from the contents, never from the box: during a key change the
      // box is mid-travel, and this delivery is only that change rippling
      // through — it resolves to the same target and falls out as a no-op.
      const width = settled.current?.width ?? element.offsetWidth
      travel(element, { width, height: content.offsetHeight + verticalChrome(element) }, 'height')
    })
    observer.observe(content)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, contentRef, durationMs])
}
