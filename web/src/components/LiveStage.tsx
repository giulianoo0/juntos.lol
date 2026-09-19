import { Maximize, Minimize } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type * as Watch from '@moq/watch'
import type { Translator } from '../i18n/useT'
import { VolumeControl } from '../ui/VolumeControl'
import { loadStageVolume, saveStageVolume } from '../ui/stageVolume'
import { fetchScreenRelay, watchScreen, type ScreenRelay, type ScreenWatchStatus, type ScreenWatcher } from '../screenshare'

/** A subscription the relay turned away (the producer is not there yet) is tried again after this long. */
const RESUBSCRIBE_MS = 4000
/** One the relay accepted but that shows nothing yet gets this long before it is reopened. */
const LOADING_PATIENCE_MS = 20_000
/**
 * The producer paces the HLS segments it reads onto the media clock, but a
 * segment that comes late through the proxy still leaves a hole, and an older
 * jlocal sends them in bursts. This many seconds of buffer ride that out, and
 * past the ceiling playback skips ahead.
 */
const LIVE_LATENCY_MS = { min: 6_000, max: 15_000 }

/**
 * A YouTube live on the relay: the room's broadcast painted on a canvas, the
 * way a shared screen is. There is no timeline and no going back; the one
 * control is jumping to the edge, from the red badge as on YouTube — a fresh
 * subscription, since the relay hands a newcomer its newest group.
 */
// `Time.Milli` is a branded number; the cast keeps @moq/watch out of this chunk (screenshare loads it lazily).
function liveLatency(): Watch.Latency {
  return { min: LIVE_LATENCY_MS.min as Watch.Net.Time.Milli, max: LIVE_LATENCY_MS.max as Watch.Net.Time.Milli }
}

export function LiveStage({ roomId, memberId, capability, broadcast, title, t }: {
  roomId: string
  memberId: string
  capability: string
  broadcast: string
  title: string
  t: Translator
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const watcherRef = useRef<ScreenWatcher | null>(null)
  const relayRef = useRef<ScreenRelay | null>(null)
  const [status, setStatus] = useState<ScreenWatchStatus>('offline')
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(loadStageVolume)
  const [generation, setGeneration] = useState(0)
  const mutedRef = useRef(muted)
  mutedRef.current = muted
  const volumeRef = useRef(volume)
  volumeRef.current = volume

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
    void watchScreen(relay, broadcast, canvas, mutedRef.current, liveLatency(), volumeRef.current)
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
  useEffect(() => {
    watcherRef.current?.volume.set(volume)
    saveStageVolume(volume)
  }, [volume])

  // Only the media starts over: a fresh subscription to the catalog could wait many seconds for the producer's next copy.
  const goLive = useCallback(() => {
    if (watcherRef.current) watcherRef.current.jump()
    else setGeneration((n) => n + 1)
  }, [])

  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === stageRef.current)
    document.addEventListener('fullscreenchange', update)
    return () => document.removeEventListener('fullscreenchange', update)
  }, [])
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
      return
    }
    void stageRef.current?.requestFullscreen?.().catch(() => undefined)
  }, [])

  return (
    <div ref={stageRef} className={`player-wrap live-stage ${status === 'live' ? 'is-live' : ''}`} onDoubleClick={toggleFullscreen}>
      <canvas ref={canvasRef} role="img" aria-label={title} />
      {status !== 'live' ? <div className="live-waiting">{t('room.liveWaiting')}</div> : null}
      <div className="live-bar" onDoubleClick={(e) => e.stopPropagation()}>
        <div className="live-heading">
          <button type="button" className="live-badge" onClick={goLive} disabled={status !== 'live'} title={t('room.liveGoLive')} aria-label={t('room.liveGoLive')}>
            {t('room.liveBadge')}
          </button>
          <span className="live-title">{title}</span>
        </div>
        <span className="live-bar-spacer" />
        <VolumeControl volume={volume} muted={muted} onVolume={setVolume} onMuted={setMuted} t={t} />
        <button type="button" className="secondary-button live-button live-fullscreen" onClick={toggleFullscreen} aria-label={t(fullscreen ? 'room.exitFullscreen' : 'room.fullscreen')} title={t(fullscreen ? 'room.exitFullscreen' : 'room.fullscreen')}>
          {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
        </button>
      </div>
    </div>
  )
}
