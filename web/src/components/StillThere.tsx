import { useEffect, useState } from 'react'
import NumberFlow from '@number-flow/react'
import { Dialog, DialogContent } from '../ui/Dialog'
import type { Translator } from '../i18n/useT'

/**
 * Idle prompt whose countdown runs against the server's deadline, corrected by
 * the sync layer's offset, so every member watches the same clock. Any member
 * answering keeps the room open for everybody; dismissing it also answers.
 * It mounts inside the fullscreen element when there is one, since a portal to
 * the body would sit behind the player nobody can see past.
 */
function useFullscreenElement(): HTMLElement | null {
  const [element, setElement] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const read = () => setElement(document.fullscreenElement as HTMLElement | null)
    read()
    document.addEventListener('fullscreenchange', read)
    return () => document.removeEventListener('fullscreenchange', read)
  }, [])
  return element
}

export function StillThere({ deadlineMs, serverOffsetMs, onStay, onExpired, t }: {
  deadlineMs: number | null
  serverOffsetMs: number
  onStay: () => void
  onExpired: () => void
  t: Translator
}) {
  const [left, setLeft] = useState(0)
  const fullscreenElement = useFullscreenElement()

  useEffect(() => {
    if (deadlineMs === null) return
    let fired = false
    const read = () => {
      const remaining = Math.max(Math.ceil((deadlineMs - (Date.now() + serverOffsetMs)) / 1000), 0)
      setLeft(remaining)
      if (remaining === 0 && !fired) {
        fired = true
        onExpired()
      }
    }
    read()
    const timer = window.setInterval(read, 1000)
    return () => window.clearInterval(timer)
  }, [deadlineMs, serverOffsetMs, onExpired])

  return (
    <Dialog open={deadlineMs !== null} onOpenChange={(open) => { if (!open) onStay() }}>
      {deadlineMs !== null ? (
        <DialogContent
          className="still-there-dialog"
          container={fullscreenElement}
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
