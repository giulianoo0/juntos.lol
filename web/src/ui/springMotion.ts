import type { TargetAndTransition, Transition } from 'motion/react'

/** `--ease-spring-pop` and `--ease-spring-settle` as motion springs: what
    arrives bounces once, what leaves or moves settles without overshoot. */
export const SPRING_POP: Transition = { type: 'spring', bounce: 0.25, duration: 0.6 }
export const SPRING_SETTLE: Transition = { type: 'spring', bounce: 0, duration: 0.36 }

/** A tile that comes in grows from its centre out of a blur and leaves the
    same way; with reduced motion it only fades. */
export function tilePresence(reduced: boolean): {
  initial: TargetAndTransition
  animate: TargetAndTransition
  exit: TargetAndTransition
  transition: Transition
} {
  if (reduced) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1, transition: { duration: 0.16 } },
      exit: { opacity: 0, transition: { duration: 0.16 } },
      transition: { duration: 0 },
    }
  }
  return {
    initial: { opacity: 0, scale: 0, filter: 'blur(8px)' },
    animate: { opacity: 1, scale: 1, filter: 'blur(0px)', transition: SPRING_POP },
    exit: { opacity: 0, scale: 0, filter: 'blur(8px)', transition: SPRING_SETTLE },
    transition: { layout: SPRING_SETTLE },
  }
}

/** The stage in focus trading places: the new one settles out of a blur
    while the old one lifts away over it. */
export function focusPresence(reduced: boolean): {
  initial: TargetAndTransition
  animate: TargetAndTransition
  exit: TargetAndTransition
} {
  if (reduced) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1, transition: { duration: 0.16 } },
      exit: { opacity: 0, transition: { duration: 0.16 } },
    }
  }
  return {
    initial: { opacity: 0, scale: 0.94, filter: 'blur(12px)' },
    animate: { opacity: 1, scale: 1, filter: 'blur(0px)', transition: SPRING_POP },
    exit: { opacity: 0, scale: 1.03, filter: 'blur(12px)', transition: SPRING_SETTLE },
  }
}
