import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type TransitionEvent } from 'react'
import styles from './SpringPopover.module.css'

/** When the settle never reports its end (a background tab, a test):
    `--duration-spring-settle` and a little more. */
const SETTLE_FALLBACK_MS = 420

export interface SpringPresence<T extends HTMLElement> {
  /** Render the popup while this is true: from the opening to the settle. */
  present: boolean
  ref: RefObject<T>
  /** Spread on the popup (it carries the `spring` class). */
  props: {
    'data-ending-style': '' | undefined
    // React 18 drops a boolean `inert`; the empty string is the attribute.
    inert: '' | undefined
    onTransitionEnd: (event: TransitionEvent<T>) => void
  }
}

/**
 * Base UI's `data-starting-style` / `data-ending-style` for a popup of its
 * own (the person's menu, a tile's card): it mounts closed, springs open on
 * the next frame and stays mounted, inert, until it has settled back. The
 * popup carries `springClass` and its own `--transform-origin`.
 */
export function useSpringPresence<T extends HTMLElement>(open: boolean, identity?: string | null): SpringPresence<T> {
  const ref = useRef<T>(null)
  const [present, setPresent] = useState(open)
  if (open && !present) setPresent(true)
  const ending = present && !open

  // Born closed: the closed style is computed once (the forced layout), then
  // dropped, and the spring runs from there.
  useLayoutEffect(() => {
    const popup = ref.current
    if (!present || !popup || ending) return
    popup.setAttribute('data-starting-style', '')
    void popup.offsetWidth
    popup.removeAttribute('data-starting-style')
    // `ending` only gates: a popup reopened mid-settle continues from where it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present, identity])

  useEffect(() => {
    if (!ending) return undefined
    const timer = window.setTimeout(() => setPresent(false), SETTLE_FALLBACK_MS)
    return () => window.clearTimeout(timer)
  }, [ending])

  return {
    present,
    ref,
    props: {
      'data-ending-style': ending ? '' : undefined,
      inert: ending ? '' : undefined,
      onTransitionEnd: (event) => {
        if (!ending || event.target !== event.currentTarget) return
        // `scale` with the spring; `opacity` with reduced motion.
        if (event.propertyName === 'scale' || event.propertyName === 'opacity') setPresent(false)
      },
    },
  }
}

/** The spring alone, for a popup with a look of its own. */
export const springClass = styles.spring
/** The popover's own panel and positioner, for a popover built by hand. */
export const springPopupClass = styles.popup
export const springPositionerClass = styles.positioner
