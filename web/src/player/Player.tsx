import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
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
  const playerRef = useRef<HTMLDivElement>(null)
  const hlsRef = useRef<Hls | null>(null)
  const playRequestedRef = useRef(false)
  const playAttemptRef = useRef(false)
  const controlsTimerRef = useRef<number | null>(null)
  const [audioTracks, setAudioTracks] = useState<Array<{ name: string; lang?: string }>>([])
  const [subtitle, setSubtitle] = useState(-1)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)

  const revealControls = useCallback((autoHide = true) => {
    if (controlsTimerRef.current !== null) window.clearTimeout(controlsTimerRef.current)
    setControlsVisible(true)
    if (!autoHide) return
    controlsTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false)
    }, 2500)
  }, [])

  useEffect(() => {
    if (playing) revealControls()
    else revealControls(false)
    return () => {
      if (controlsTimerRef.current !== null) window.clearTimeout(controlsTimerRef.current)
    }
  }, [playing, revealControls])

  useEffect(() => {
    const updateFullscreen = () => setFullscreen(document.fullscreenElement === playerRef.current)
    document.addEventListener('fullscreenchange', updateFullscreen)
    return () => document.removeEventListener('fullscreenchange', updateFullscreen)
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const source = `/media/${encodeURIComponent(room.id)}/hls/master.m3u8`
    let disposed = false
    void import('hls.js').then(({ default: HlsClass, ErrorTypes }) => {
      if (disposed) return
      if (HlsClass.isSupported()) {
        // Progressive uploads are EVENT playlists. Native HLS commonly joins
        // those at the live edge and waits for the next uploaded segment;
        // hls.js lets an episode reliably start at its beginning instead.
        const hls = new HlsClass({ startPosition: 0 })
        hlsRef.current = hls
        hls.on(HlsClass.Events.MEDIA_ATTACHED, () => hls.loadSource(source))
        hls.on(HlsClass.Events.MANIFEST_PARSED, () => setAudioTracks(hls.audioTracks))
        hls.on(HlsClass.Events.AUDIO_TRACKS_UPDATED, () => setAudioTracks(hls.audioTracks))
        hls.on(HlsClass.Events.ERROR, (_event, data) => {
          if (!data.fatal) return
          if (data.type === ErrorTypes.NETWORK_ERROR) hls.startLoad()
          else if (data.type === ErrorTypes.MEDIA_ERROR) hls.recoverMediaError()
        })
        hls.attachMedia(video)
        return
      }
      if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = source
    })
    return () => {
      disposed = true
      hlsRef.current?.destroy()
      hlsRef.current = null
    }
  }, [room.id, videoRef])

  const attemptPlay = () => {
    const video = videoRef.current
    if (!video || !playRequestedRef.current || playAttemptRef.current) return
    playAttemptRef.current = true
    void video.play().then(() => {
      playAttemptRef.current = false
      if (!playRequestedRef.current) return
      playRequestedRef.current = false
      if (isController) {
        send('play', {
          positionMs: Math.round(video.currentTime * 1000),
          rate: video.playbackRate,
        })
      }
    }).catch(() => {
      // A click can land while hls.js is still attaching the MediaSource.
      // Keep the intent and retry from the next canplay event.
      playAttemptRef.current = false
    })
  }

  const togglePlay = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      // Calling play inside the click preserves browser user activation. A
      // WebSocket round trip first would make browsers reject audible autoplay.
      playRequestedRef.current = true
      attemptPlay()
      return
    }
    playRequestedRef.current = false
    video.pause()
    if (isController) {
      send('pause', {
        positionMs: Math.round(video.currentTime * 1000),
        rate: video.playbackRate,
      })
    }
  }

  const seek = (seconds: number) => {
    const video = videoRef.current
    if (!video || !isController) return
    send('seek', { positionMs: Math.round(seconds * 1000) })
  }

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined)
      return
    }
    const request = playerRef.current?.requestFullscreen?.()
    void request?.catch(() => undefined)
  }

  return (
    <div
      ref={playerRef}
      className={`player-wrap ${playing && !controlsVisible ? 'controls-hidden' : ''}`}
      onPointerMove={() => revealControls(playing)}
      onPointerDown={() => revealControls(playing)}
      onFocusCapture={() => revealControls(false)}
      onBlurCapture={() => revealControls(playing)}
    >
      <video
        ref={videoRef}
        className="video"
        playsInline
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onCanPlay={() => attemptPlay()}
        onTimeUpdate={(event) => {
          setCurrentTime(event.currentTarget.currentTime)
          setDuration(playableDuration(event.currentTarget))
        }}
        onDurationChange={(event) => setDuration(playableDuration(event.currentTarget))}
        onLoadedMetadata={(event) => setDuration(playableDuration(event.currentTarget))}
        onProgress={(event) => setDuration(playableDuration(event.currentTarget))}
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
        <button
          aria-label={t(playing ? 'room.pause' : 'room.play')}
          onClick={togglePlay}
          onPointerUp={(event) => event.currentTarget.blur()}
        >{playing ? '❚❚' : '▶'}</button>
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
        <button
          className="fullscreen-button"
          aria-label={t(fullscreen ? 'room.exitFullscreen' : 'room.fullscreen')}
          title={t(fullscreen ? 'room.exitFullscreen' : 'room.fullscreen')}
          onClick={toggleFullscreen}
        >⛶</button>
        {!isController ? (
          <span className="viewer-note">{t('room.viewer')}</span>
        ) : null}
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

function playableDuration(video: HTMLVideoElement): number {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration
  if (video.seekable.length > 0) return video.seekable.end(video.seekable.length - 1)
  if (video.buffered.length > 0) return video.buffered.end(video.buffered.length - 1)
  return 0
}

function safeLanguage(language: string): string {
  return language && language.length <= 35 && /^[A-Za-z0-9_-]+$/.test(language) ? language : 'und'
}
