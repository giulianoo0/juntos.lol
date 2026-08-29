import NumberFlow from '@number-flow/react'
import type { Translator } from '../i18n/useT'
import { SlotText } from '../ui/SlotText'

/**
 * The one line the wait overlay says, and how it changes.
 *
 * A wait passes through two different facts: there is no media here yet, and
 * then there is media and the buffer is being built from it. The line
 * travels from one to the other (see SlotText), and the second one shimmers
 * for as long as the buffer is filling — the seconds inside it roll rather
 * than cut, so a number counting down never looks like the text being
 * replaced again on every tick.
 */
export function WaitLabel({ secondsLeft, t }: { secondsLeft: number | null; t: Translator }) {
  const phase = secondsLeft === null ? 'preparing' : 'buffering'
  return (
    <span className="wait-label">
      <SlotText k={phase}>
        {phase === 'preparing' ? t('room.preparingPart') : (
          <>
            <span className="text-shimmer">{t('room.bufferingLead').trim()}</span>
            <NumberFlow value={secondsLeft ?? 0} suffix={t('room.bufferingTail')} />
          </>
        )}
      </SlotText>
    </span>
  )
}
