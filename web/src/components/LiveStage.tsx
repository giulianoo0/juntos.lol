import { useCallback, useEffect, useRef, useState } from 'react'
import type { Translator } from '../i18n/useT'
import { fetchScreenRelay, watchScreen, type ScreenRelay, type ScreenWatchStatus, type ScreenWatcher } from '../screenshare'

/** A subscription the relay turned away (the producer is not there yet) is tried again after this long. */
const RESUBSCRIBE_MS = 4000
/** One the relay accepted but that shows nothing yet gets this long before it is reopened. */
const LOADING_PATIENCE_MS = 20_000

/**
 * A YouTube live on the relay: the room's broadcast painted on a canvas, the
 * way a shared screen is. There is no timeline and no going back; the one
 * control is jumping to the edge, which is a fresh subscription — the relay
 * hands a newcomer its newest group.
 */
export function LiveStage({ roomId, memberId, capability, broadcast, title, t }: {
  roomId: string
  memberId: string
  capability: string
  broadcast: string
  title: string
  t: Translator
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const watcherRef = useRef<ScreenWatcher | null>(null)
  const relayRef = useRef<ScreenRelay | null>(null)
  const [status, setStatus] = useState<ScreenWatchStatus>('offline')
  const [muted, setMuted] = useState(false)
  const [generation, setGeneration] = useState(0)
  const mutedRef = useRef(muted)
  mutedRef.current = muted

  useEffect(() => {
    if (!memberId || !capability) return
    let disposed = false
    void fetchScreenRelay(roomId, memberId, capability)
      .then((relay) => { if (!disposed) { relayRef.current = relay; setGeneration((n) => n + 1) } })
      .catch(() => undefined)
    return () => { disposed = true }
  }, [roomId, memberId, capability])

  useEffect(() => {
    const relay = relayRef.current
    const canvas = canvasRef.current
    if (!relay || !canvas) return
    let closed = false
    let unsubscribe: (() => void) | undefined
    let retry: ReturnType<typeof setTimeout> | null = null
    setStatus('loading')
    void watchScreen(relay, broadcast, canvas, mutedRef.current)
      .then((watcher) => {
        if (closed) { watcher.close(); return }
        watcherRef.current = watcher
        const apply = (next: ScreenWatchStatus) => {
          setStatus(next)
          if (retry !== null) {
            clearTimeout(retry)
            retry = null
          }
          if (next !== 'live') {
            retry = setTimeout(() => { retry = null; if (!closed) setGeneration((n) => n + 1) }, next === 'offline' ? RESUBSCRIBE_MS : LOADING_PATIENCE_MS)
          }
        }
        apply(watcher.status.peek())
        unsubscribe = watcher.status.subscribe(apply)
      })
      .catch(() => {
        if (!closed) retry = setTimeout(() => { retry = null; if (!closed) setGeneration((n) => n + 1) }, RESUBSCRIBE_MS)
      })
    return () => {
      closed = true
      if (retry !== null) clearTimeout(retry)
      unsubscribe?.()
      watcherRef.current?.close()
      watcherRef.current = null
    }
  }, [broadcast, generation])

  useEffect(() => { watcherRef.current?.muted.set(muted) }, [muted])

  const goLive = useCallback(() => setGeneration((n) => n + 1), [])

  return (
    <div className={`player-wrap live-stage ${status === 'live' ? 'is-live' : ''}`}>
      <canvas ref={canvasRef} role="img" aria-label={title} />
      {status !== 'live' ? <div className="live-waiting">{t('room.liveWaiting')}</div> : null}
      <div className="live-bar">
        <span className="live-badge">{t('room.liveBadge')}</span>
        <span className="live-title">{title}</span>
        <span className="live-bar-spacer" />
        <button type="button" className="secondary-button live-button" onClick={() => setMuted((m) => !m)}>
          {t(muted ? 'room.liveUnmute' : 'room.liveMute')}
        </button>
        <button type="button" className="primary-button live-button" onClick={goLive} disabled={status !== 'live'}>
          {t('room.liveGoLive')}
        </button>
      </div>
    </div>
  )
}
