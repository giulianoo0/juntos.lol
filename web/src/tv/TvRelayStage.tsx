import { Volume2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type * as Watch from '@moq/watch'
import { keepAskingForRelay } from '../call/moq'
import { useT } from '../i18n/useT'
import { fetchScreenRelay, screenPath, watchScreen, type ScreenRelay, type ScreenWatchStatus, type ScreenWatcher } from '../screenshare'
import { unlockAudio, useAudioLocked } from '../ui/audioUnlock'
import { Loading, Skeleton } from '../ui/Shimmer'
import styles from './tv.module.css'

/** A subscription the relay turned away (the producer is not there yet) is tried again after this long. */
const RESUBSCRIBE_MS = 4_000
/** One the relay accepted but that shows nothing yet gets this long before it is reopened. */
const LOADING_PATIENCE_MS = 20_000
/** The live's buffer, as on the web's LiveStage: late HLS segments through the proxy are ridden out. */
const LIVE_LATENCY_MS = { min: 6_000, max: 15_000 }

export type RelaySource = { kind: 'live'; broadcast: string } | { kind: 'screen'; ownerId: string }

/**
 * A live or someone's screen, painted from the relay; through the WebSocket
 * bridge when the TV's engine has no WebTransport (see call/moq). Only
 * watching: no controls of its own, the TV's mix sets the volume.
 */
export function TvRelayStage({ roomId, memberId, capability, relayEpoch = 0, source, title, volume }: {
  roomId: string
  memberId: string
  capability: string
  relayEpoch?: number
  source: RelaySource
  title: string
  volume: number
}) {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const watcherRef = useRef<ScreenWatcher | null>(null)
  const [relay, setRelay] = useState<ScreenRelay | null>(null)
  const [status, setStatus] = useState<ScreenWatchStatus>('offline')
  const [generation, setGeneration] = useState(0)
  const volumeRef = useRef(volume)
  volumeRef.current = volume

  useEffect(() => {
    if (!memberId || !capability) return
    return keepAskingForRelay(() => fetchScreenRelay(roomId, memberId, capability), setRelay, 'screenshare_disabled')
  }, [roomId, memberId, capability, relayEpoch])

  const path = !relay ? '' : source.kind === 'live' ? source.broadcast : screenPath(relay.base, source.ownerId)
  const live = source.kind === 'live'
  useEffect(() => {
    const canvas = canvasRef.current
    if (!relay || !canvas || !path) return
    let closed = false
    let unsubscribe: (() => void) | undefined
    let retry: ReturnType<typeof setTimeout> | null = null
    const again = (ms: number) => {
      if (retry !== null) clearTimeout(retry)
      retry = setTimeout(() => { retry = null; if (!closed) setGeneration((n) => n + 1) }, ms)
    }
    setStatus('loading')
    const latency = live ? { min: LIVE_LATENCY_MS.min as Watch.Net.Time.Milli, max: LIVE_LATENCY_MS.max as Watch.Net.Time.Milli } : undefined
    void watchScreen(relay, path, canvas, false, latency, volumeRef.current).then((watcher) => {
      if (closed) { watcher.close(); return }
      watcherRef.current = watcher
      const apply = (next: ScreenWatchStatus) => {
        setStatus(next)
        if (next === 'live') {
          if (retry !== null) { clearTimeout(retry); retry = null }
        } else again(next === 'offline' ? RESUBSCRIBE_MS : LOADING_PATIENCE_MS)
      }
      apply(watcher.status.peek())
      unsubscribe = watcher.status.subscribe(apply)
    }).catch(() => { if (!closed) again(RESUBSCRIBE_MS) })
    return () => {
      closed = true
      if (retry !== null) clearTimeout(retry)
      unsubscribe?.()
      watcherRef.current?.close()
      watcherRef.current = null
    }
  }, [relay, path, live, generation])

  useEffect(() => { watcherRef.current?.volume.set(volume) }, [volume])

  const soundLocked = useAudioLocked()
  return (
    <div className={styles.relayStage}>
      <canvas ref={canvasRef} role="img" aria-label={title} />
      {status !== 'live' ? (
        <Loading label={t('status.loading')} className={styles.relayWaiting}>
          <Skeleton width="100%" height="100%" />
        </Loading>
      ) : null}
      {status === 'live' && soundLocked && volume > 0 ? (
        <button type="button" className={styles.unlock} onClick={unlockAudio}>
          <Volume2 size={20} aria-hidden="true" />{t('room.tapForSound')}
        </button>
      ) : null}
    </div>
  )
}
