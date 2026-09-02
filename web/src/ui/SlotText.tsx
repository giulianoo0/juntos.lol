import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'

/**
 * One line of text that changes by travelling. Keyed on `k`, not on the text:
 * a line with a number that ticks must not remount on every tick.
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
