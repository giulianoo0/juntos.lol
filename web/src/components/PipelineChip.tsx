import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import NumberFlow from '@number-flow/react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import type { TorrentStats } from '../torrent'
import type { RoomUploadProgress } from '../upload'
import type { Translator } from '../i18n/useT'

/**
 * Shows the swarm's download speed while the source is still arriving, then
 * switches to the upload half of the pipeline once the swarm is done.
 */
export function PipelineChip({ swarm, progress, remote, videoRef, t }: {
  swarm: TorrentStats | null
  progress: RoomUploadProgress | null
  remote?: boolean
  videoRef: MutableRefObject<HTMLVideoElement | null>
  t: Translator
}) {
  const [bufferSec, setBufferSec] = useState(0)
  const [upSpeed, setUpSpeed] = useState(0)
  const uploadedRef = useRef(progress?.bytesUploaded ?? 0)
  uploadedRef.current = progress?.bytesUploaded ?? 0
  useEffect(() => {
    let lastBytes = uploadedRef.current
    let lastAt = Date.now()
    const read = () => {
      const now = Date.now()
      const elapsed = (now - lastAt) / 1000
      if (elapsed > 0) {
        setUpSpeed(Math.max(0, (uploadedRef.current - lastBytes) / elapsed))
        lastBytes = uploadedRef.current
        lastAt = now
      }
      const video = videoRef.current
      if (!video) return
      let ahead = 0
      for (let index = 0; index < video.buffered.length; index += 1) {
        if (video.buffered.start(index) > video.currentTime + 0.1 || video.currentTime > video.buffered.end(index)) continue
        ahead = video.buffered.end(index) - video.currentTime
        break
      }
      setBufferSec(Math.max(0, Math.round(ahead)))
    }
    read()
    const timer = window.setInterval(read, 1_000)
    return () => window.clearInterval(timer)
  }, [videoRef])
  const arriving = swarm !== null && (swarm.downloadSpeed > 0 || swarm.progress < 1)
  return (
    <span className="upload-chip pipeline-chip">
      {remote || progress !== null ? (
        <span
          className="pipeline-metric"
          title={remote ? t('room.pipelineRemote') : t('room.pipelineLocal')}
          style={{ fontWeight: 700, opacity: 0.8 }}
        >
          {remote ? 'R' : 'L'}
        </span>
      ) : null}
      {remote || progress !== null ? <span className="pipeline-dot" aria-hidden="true">·</span> : null}
      {arriving ? (
        <span className="pipeline-metric" title={t('home.swarmSpeed')}>
          <ArrowDown size={11} aria-hidden="true" />
          <NumberFlow value={round(swarm.downloadSpeed / 1_048_576, 1)} suffix=" MB/s" />
        </span>
      ) : progress === null ? null : upSpeed > 0 ? (
        <span className="pipeline-metric" title={t('room.uploadSpeed')}>
          <ArrowUp size={11} aria-hidden="true" />
          <NumberFlow value={round(upSpeed / 1_048_576, 1)} suffix=" MB/s" />
        </span>
      ) : (
        <span className="pipeline-metric" title={t('home.uploading')}>
          <ArrowUp size={11} aria-hidden="true" />
          <NumberFlow value={round(progress.bytesUploaded / 1_073_741_824, 2)} suffix=" GB" />
        </span>
      )}
      {arriving || progress !== null ? <span className="pipeline-dot" aria-hidden="true">·</span> : null}
      <span className="pipeline-metric" title={t('room.bufferAhead')}>
        <NumberFlow value={bufferSec} suffix={` s ${t('room.bufferAheadShort')}`} />
      </span>
    </span>
  )
}

const round = (value: number, places: number): number => {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}
