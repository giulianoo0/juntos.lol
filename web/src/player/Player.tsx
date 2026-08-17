import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import type Hls from 'hls.js'
import type { RoomInfo } from '../types'
import type { Translator } from '../i18n/useT'

interface PlayerProps {
  room: RoomInfo
  isController: boolean
  videoRef: MutableRefObject<HTMLVideoElement | null>
  send: (type: string, payload?: Record<string, unknown>) => void
  t: Translator
}

export function Player({ room, isController, videoRef, send, t }: PlayerProps) {
  const hlsRef = useRef<Hls | null>(null)
  const [audioTracks, setAudioTracks] = useState<Array<{ name: string; lang?: string }>>([])
  const [subtitle, setSubtitle] = useState(-1)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const source = `/media/${encodeURIComponent(room.id)}/hls/master.m3u8`
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = source
      return
    }
    let disposed = false
    void import('hls.js').then(({ default: HlsClass }) => {
      if (disposed || !HlsClass.isSupported()) return
      const hls = new HlsClass()
      hlsRef.current = hls
      hls.loadSource(source)
      hls.attachMedia(video)
      hls.on(HlsClass.Events.MANIFEST_PARSED, () => setAudioTracks(hls.audioTracks))
      hls.on(HlsClass.Events.AUDIO_TRACKS_UPDATED, () => setAudioTracks(hls.audioTracks))
    })
    return () => {
      disposed = true
      hlsRef.current?.destroy()
      hlsRef.current = null
    }
  }, [room.id, videoRef])

  const togglePlay = () => {
    const video = videoRef.current
    if (!video || !isController) return
    send(video.paused ? 'play' : 'pause', {
      positionMs: Math.round(video.currentTime * 1000),
      rate: video.playbackRate,
    })
  }

  const seek = (seconds: number) => {
    const video = videoRef.current
    if (!video || !isController) return
    send('seek', { positionMs: Math.round(seconds * 1000) })
  }

  return (
    <div className="player-wrap raised">
      <video
        ref={videoRef}
        className="video"
        playsInline
        onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
        onDurationChange={(event) => setDuration(event.currentTarget.duration || 0)}
      >
        {(room.subtitleTracks ?? []).map((track, index) => (
          <track
            key={`${track.index}-${track.language}`}
            kind="subtitles"
            src={`/media/${encodeURIComponent(room.id)}/subs/sub_${index}_${safeLanguage(track.language)}.vtt`}
            srcLang={track.language || 'und'}
            label={track.title || track.language || `Subtitle ${index + 1}`}
          />
        ))}
      </video>
      <div className="player-controls raised">
        <button onClick={togglePlay} disabled={!isController}>{videoRef.current?.paused === false ? '❚❚' : '▶'}</button>
        <input
          aria-label="Seek"
          type="range"
          min="0"
          max={Math.max(duration, 1)}
          value={Math.min(currentTime, Math.max(duration, 1))}
          disabled={!isController}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <span className="timecode">{formatTime(currentTime)} / {formatTime(duration)}</span>
        {audioTracks.length > 1 ? (
          <label>{t('room.audio')}
            <select onChange={(event) => { if (hlsRef.current) hlsRef.current.audioTrack = Number(event.target.value) }}>
              {audioTracks.map((track, index) => <option key={`${track.name}-${index}`} value={index}>{track.name || track.lang || index + 1}</option>)}
            </select>
          </label>
        ) : null}
        {(room.subtitleTracks?.length ?? 0) > 0 ? (
          <label>{t('room.subtitles')}
            <select value={subtitle} onChange={(event) => {
              const next = Number(event.target.value)
              setSubtitle(next)
              const tracks = videoRef.current?.textTracks
              if (tracks) for (let index = 0; index < tracks.length; index += 1) tracks[index].mode = index === next ? 'showing' : 'hidden'
            }}>
              <option value={-1}>{t('room.off')}</option>
              {(room.subtitleTracks ?? []).map((track, index) => <option key={track.index} value={index}>{track.title || track.language || index + 1}</option>)}
            </select>
          </label>
        ) : null}
        {!isController ? <span className="viewer-note">{t('room.viewer')}</span> : null}
      </div>
      {room.bitmapSubsSkipped > 0 ? <span className="notice-chip">{t('room.bitmapSkipped')}</span> : null}
    </div>
  )
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '0:00'
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
}

function safeLanguage(language: string): string {
  return language && language.length <= 35 && /^[A-Za-z0-9_-]+$/.test(language) ? language : 'und'
}
