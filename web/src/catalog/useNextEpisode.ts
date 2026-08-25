import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { fetchMeta, type MetaVideo } from './cinemeta'
import { resolveStreams } from '../plugins/resolve'
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
  // Held rather than depended on: the caller re-creates this function on every
  // render of the room, and the countdown below must not restart with it.
  // Written after the commit, never during the render — a render can be
  // thrown away, and a ref written by one that was is a lie.
  const onPlayRef = useRef(onPlay)
  useEffect(() => { onPlayRef.current = onPlay })

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
        const resolved = await resolveStreams({ type: 'series', id: now.metaId, season: next.season, episode: next.episode })
        // With nothing installed there is nothing to suggest, and it is the
        // same silence as finding no source: the invitation to install lives
        // on the details panel, not here.
        const streams = resolved.kind === 'streams' ? resolved.streams : []
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
      onPlayRef.current(pick)
      return
    }
    const timer = window.setTimeout(() => setSeconds((value) => value - 1), 1000)
    return () => window.clearTimeout(timer)
    // onPlay is read through a ref: it is re-created on every render of the
    // room, and depending on it re-armed this 1s timer often enough that the
    // countdown could sit still.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, seconds])

  const dismiss = useCallback(() => setPending(null), [])
  const playNow = useCallback(() => {
    if (!pending) return
    const pick = pending.pick
    setPending(null)
    onPlayRef.current(pick)
  }, [pending])

  return { pending, seconds, dismiss, playNow }
}
