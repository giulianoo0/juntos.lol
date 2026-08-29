import { useEffect, useState } from 'react'
import NumberFlow from '@number-flow/react'
import { Dialog, DialogContent } from '../ui/Dialog'
import type { Translator } from '../i18n/useT'

/**
 * The question a room puts to itself when nothing has happened for a while.
 *
 * A tab left open is indistinguishable from someone watching, from the
 * server's side: both hold a socket, a worker's torrent and a bucket's worth
 * of segments. Rather than guess, the room asks, and closes only if nobody
 * answers. One person saying they are here answers for everybody.
 *
 * The countdown runs against the server's own deadline, corrected by the
 * offset the sync layer already measures, so every member watches the same
 * clock rather than one that started when their tab happened to hear about it.
 */
export function StillThere({ deadlineMs, serverOffsetMs, onStay, onExpired, t }: {
  deadlineMs: number | null
  serverOffsetMs: number
  onStay: () => void
  /** The countdown reached zero with nobody answering. */
  onExpired: () => void
  t: Translator
}) {
  const [left, setLeft] = useState(0)

  useEffect(() => {
    if (deadlineMs === null) return
    let fired = false
    const read = () => {
      const remaining = Math.max(Math.ceil((deadlineMs - (Date.now() + serverOffsetMs)) / 1000), 0)
      setLeft(remaining)
      // Zero is the answer nobody gave. The room does not always close on
      // its own at this point — a host still preparing keeps it alive on the
      // server — so a dialog stuck at zero was what people saw. The person is
      // taken out here, and told why.
      if (remaining === 0 && !fired) {
        fired = true
        onExpired()
      }
    }
    read()
    const timer = window.setInterval(read, 1000)
    return () => window.clearInterval(timer)
  }, [deadlineMs, serverOffsetMs, onExpired])

  // Answering is the only thing this asks for, so the close affordance answers
  // too: dismissing it is a person saying they are there by acting at all.
  return (
    <Dialog open={deadlineMs !== null} onOpenChange={(open) => { if (!open) onStay() }}>
      {deadlineMs !== null ? (
        <DialogContent
          className="still-there-dialog"
          closeLabel={t('room.stillHere')}
          title={t('room.stillThereTitle')}
          description={t('room.stillThereGuide')}
        >
          <p className="still-there-count">
            <NumberFlow value={left} suffix={t('room.stillThereUnit')} />
          </p>
          <button type="button" className="primary-button" autoFocus onClick={onStay}>
            {t('room.stillHere')}
          </button>
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
