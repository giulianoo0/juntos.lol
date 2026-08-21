import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { Play, X } from 'lucide-react'
import { useT } from '../i18n/useT'
import { fetchMeta, type MetaVideo } from './cinemeta'
import { fetchStreams } from './streams'
import { FadeImg } from './FadeImg'
import type { TitlePick } from './MetaDetails'
import type { StreamResolution } from './streams'

// What the room is currently playing, remembered by the tab that picked it
// from the catalog so the end of an episode can offer the next one.
export interface NowPlaying {
  metaId: string
  metaType: 'movie' | 'series'
  name: string
  poster: string
  season: number
  episode: number
  resolution: StreamResolution
}

const AUTOPLAY_SECONDS = 10

export function nowPlayingFromPick(pick: TitlePick): NowPlaying | null {
  if (pick.target.type !== 'series' || pick.target.season == null || pick.target.episode == null) return null
  return {
    metaId: pick.target.id,
    metaType: pick.target.type,
    name: pick.metaName,
    poster: pick.poster,
    season: pick.target.season,
    episode: pick.target.episode,
    resolution: pick.stream.resolution,
  }
}

export function nowPlayingKey(roomId: string): string {
  return `ss.now-playing.${roomId}`
}

interface PendingNext {
  video: MetaVideo
  pick: TitlePick
}

// Watches the room's video for its end; when the episode finishes and a next
// one exists with a playable stream, hands the caller a countdown card.
export function useNextEpisode(
  now: NowPlaying | null,
  videoRef: MutableRefObject<HTMLVideoElement | null>,
  enabled: boolean,
  onPlay: (pick: TitlePick) => void,
) {
  const [pending, setPending] = useState<PendingNext | null>(null)
  const [seconds, setSeconds] = useState(AUTOPLAY_SECONDS)
  const requestSeqRef = useRef(0)

  useEffect(() => {
    setPending(null)
    if (!enabled || !now) return
    const video = videoRef.current
    if (!video) return
    const seq = (requestSeqRef.current += 1)
    const onEnded = async () => {
      try {
        const detail = await fetchMeta(now.metaType, now.metaId)
        if (!detail || requestSeqRef.current !== seq) return
        const ordered = detail.videos
          .filter((candidate) => candidate.season > 0)
          .sort((a, b) => a.season - b.season || a.episode - b.episode)
        const index = ordered.findIndex((candidate) => candidate.season === now.season && candidate.episode === now.episode)
        const next = index >= 0 ? ordered[index + 1] : undefined
        if (!next) return
        const streams = await fetchStreams({ type: 'series', id: now.metaId, season: next.season, episode: next.episode })
        if (requestSeqRef.current !== seq || streams.length === 0) return
        // Keep the watching quality; fall back to the addon's own top pick.
        const stream = streams.find((candidate) => candidate.resolution === now.resolution) ?? streams[0]
        setSeconds(AUTOPLAY_SECONDS)
        setPending({
          video: next,
          pick: {
            stream,
            target: { type: 'series', id: now.metaId, season: next.season, episode: next.episode },
            displayName: `${now.name} S${String(next.season).padStart(2, '0')}E${String(next.episode).padStart(2, '0')}`,
            metaName: now.name,
            poster: now.poster,
          },
        })
      } catch {
        // No next episode is just the show being over; stay quiet.
      }
    }
    const listener = () => { void onEnded() }
    video.addEventListener('ended', listener)
    return () => {
      requestSeqRef.current += 1
      video.removeEventListener('ended', listener)
    }
  }, [enabled, now, videoRef])

  // The countdown only runs while a card is up; reaching zero plays.
  useEffect(() => {
    if (!pending) return
    if (seconds <= 0) {
      const pick = pending.pick
      setPending(null)
      onPlay(pick)
      return
    }
    const timer = window.setTimeout(() => setSeconds((value) => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [pending, seconds, onPlay])

  const dismiss = useCallback(() => setPending(null), [])
  const playNow = useCallback(() => {
    if (!pending) return
    const pick = pending.pick
    setPending(null)
    onPlay(pick)
  }, [pending, onPlay])

  return { pending, seconds, dismiss, playNow }
}

interface NextEpisodeCardProps {
  video: MetaVideo
  poster: string
  seconds: number
  onPlayNow: () => void
  onDismiss: () => void
}

// The floating bottom-right card. It lives inside the player wrap, so it is
// still there in fullscreen.
export function NextEpisodeCard({ video, poster, seconds, onPlayNow, onDismiss }: NextEpisodeCardProps) {
  const t = useT()
  const reduceMotion = useReducedMotion()
  return (
    <motion.div
      className="next-episode-card"
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, transform: 'translateY(12px)' }}
      animate={{ opacity: 1, transform: 'translateY(0px)' }}
      transition={{ duration: 0.25, ease: [0.23, 1, 0.32, 1] }}
      role="status"
    >
      {video.thumbnail || poster ? (
        <FadeImg className="next-episode-art" src={video.thumbnail || poster} alt="" />
      ) : null}
      <div className="next-episode-copy">
        <span className="next-episode-kicker">{t('next.upNext')}</span>
        <strong>E{video.episode} {video.name || ''}</strong>
        <span className="next-episode-count">{t('next.playingIn')} {seconds}s</span>
        <button type="button" className="next-episode-play" onClick={onPlayNow}>
          <Play size={12} aria-hidden="true" />{t('next.playNow')}
        </button>
      </div>
      <button type="button" className="dialog-close next-episode-dismiss" aria-label={t('next.cancel')} onClick={onDismiss}>
        <X size={13} aria-hidden="true" />
      </button>
    </motion.div>
  )
}
