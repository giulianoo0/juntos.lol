import { useEffect, useState, type MutableRefObject } from 'react'
import NumberFlow from '@number-flow/react'
import { ArrowDown, ArrowUp } from 'lucide-react'
import type { TorrentStats } from '../torrent'
import type { RoomUploadProgress } from '../upload'
import type { Translator } from '../i18n/useT'

/**
 * What the running pipeline is actually doing, in the room header. A single
 * percentage meant nothing once seeks made the remux jump around the
 * timeline; what a viewer can act on is how fast the source is arriving and
 * how much playback is sitting on.
 */
export function PipelineChip({ swarm, progress, videoRef, t }: {
  swarm: TorrentStats | null
  progress: RoomUploadProgress
  videoRef: MutableRefObject<HTMLVideoElement | null>
  t: Translator
}) {
  // Contiguous seconds buffered ahead of the playhead, polled: the element
  // has no event that fires as the buffer drains.
  const [bufferSec, setBufferSec] = useState(0)
  useEffect(() => {
    const read = () => {
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
  return (
    <span className="upload-chip pipeline-chip">
      {swarm ? (
        <span className="pipeline-metric" title={t('home.swarmSpeed')}>
          <ArrowDown size={11} aria-hidden="true" />
          <NumberFlow value={round(swarm.downloadSpeed / 1_048_576, 1)} suffix=" MB/s" />
        </span>
      ) : (
        <span className="pipeline-metric" title={t('home.uploading')}>
          <ArrowUp size={11} aria-hidden="true" />
          <NumberFlow value={round(progress.bytesUploaded / 1_073_741_824, 2)} suffix=" GB" />
        </span>
      )}
      <span className="pipeline-dot" aria-hidden="true">·</span>
      <span className="pipeline-metric" title={t('room.bufferAhead')}>
        <NumberFlow value={bufferSec} suffix={` s ${t('room.bufferAheadShort')}`} />
      </span>
    </span>
  )
}

// NumberFlow animates between the values it is handed, so feeding it the raw
// float would roll every decimal place on every poll.
const round = (value: number, places: number): number => {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}
