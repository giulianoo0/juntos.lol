import NumberFlow from '@number-flow/react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { Translator } from '../i18n/useT'

/**
 * The one line the wait overlay says, and how it changes.
 *
 * A wait passes through two different facts: there is no media here yet, and
 * then there is media and it is filling. Swapping the sentence in place made
 * those read as one flickering string. They travel instead, the old line
 * leaving upward as the new one arrives from below, so the change is legible
 * as a change: something finished and something else started.
 *
 * The seconds inside the second line roll rather than cut, which is what keeps
 * a number counting down from looking like the text being replaced again on
 * every tick.
 */
export function WaitLabel({ secondsLeft, t }: { secondsLeft: number | null; t: Translator }) {
  const still = useReducedMotion()
  // The key is the phase, not the text: a countdown must not remount its own
  // line every second, or the number would slide instead of roll.
  const phase = secondsLeft === null ? 'preparing' : 'buffering'
  const travel = still ? 0 : 14
  return (
    <span className="wait-label">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={phase}
          initial={{ y: travel, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -travel, opacity: 0 }}
          transition={{ duration: still ? 0 : 0.26, ease: [0.22, 0.61, 0.36, 1] }}
        >
          {phase === 'preparing' ? t('room.preparingPart') : (
            <>
              {t('room.bufferingLead')}
              <NumberFlow value={secondsLeft ?? 0} suffix={t('room.bufferingTail')} />
            </>
          )}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}
