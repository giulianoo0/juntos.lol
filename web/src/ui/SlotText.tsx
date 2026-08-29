import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'

/**
 * One line of text that changes by travelling: the old line leaves upward
 * and the new one arrives from below, blurred at the seam so the eye reads
 * one thing becoming another instead of two strings swapped. For status
 * lines that pass through stages — a room being prepared, a buffer being
 * built — where a cut would flicker and a crossfade would smear.
 *
 * Keyed on `k`, not on the text: a line with a number that ticks must not
 * remount on every tick, or the number slides instead of rolling.
 */
export function SlotText({ k, block = false, children }: { k: string; block?: boolean; children: ReactNode }) {
  const still = useReducedMotion()
  const travel = (dir: 1 | -1) => (still ? 'none' : `translateY(${dir * 100}%)`)
  const soft = still ? 'blur(0px)' : 'blur(5px)'
  return (
    <span className={`slot-text${block ? ' is-block' : ''}`}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={k}
          initial={{ transform: travel(1), opacity: 0, filter: soft }}
          // The filter is cleared once landed: a blur of zero is still a
          // filter, and text painted through a background clip (the shimmer)
          // renders cropped inside one.
          animate={{ transform: 'translateY(0%)', opacity: 1, filter: 'blur(0px)', transitionEnd: { filter: 'none' } }}
          exit={{ transform: travel(-1), opacity: 0, filter: soft }}
          transition={{ duration: still ? 0.12 : 0.32, ease: [0.16, 1, 0.3, 1] }}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}
