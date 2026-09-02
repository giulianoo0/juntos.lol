import NumberFlow from '@number-flow/react'
import type { Translator } from '../i18n/useT'
import { SlotText } from '../ui/SlotText'

/**
 * The one line the wait overlay says: it travels from "no media here yet" to
 * "the buffer is filling" (see SlotText), shimmering while it fills, with
 * rolling seconds so a countdown never reads as the text being replaced.
 */
export function WaitLabel({ secondsLeft, t }: { secondsLeft: number | null; t: Translator }) {
  const phase = secondsLeft === null ? 'preparing' : 'buffering'
  return (
    <span className="wait-label">
      <SlotText k={phase}>
        {phase === 'preparing' ? t('room.preparingPart') : (
          <>
            <span>{t('room.playerBufferingLead').trim()}</span>
            <NumberFlow value={secondsLeft ?? 0} suffix={t('room.playerBufferingTail')} />
          </>
        )}
      </SlotText>
    </span>
  )
}
