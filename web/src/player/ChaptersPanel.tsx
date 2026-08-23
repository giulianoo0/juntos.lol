import { useEffect, useState, type MutableRefObject } from 'react'
import { Lock, X } from 'lucide-react'
import type { RoomChapter } from '../types'
import type { Translator } from '../i18n/useT'

interface ChaptersPanelProps {
  chapters: RoomChapter[]
  open: boolean
  onClose: () => void
  /** Seeks the room. Absent for a viewer, who may look but not jump. */
  onSeek?: (seconds: number) => void
  videoRef: MutableRefObject<HTMLVideoElement | null>
  t: Translator
}

function formatTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

/**
 * The room's chapter list, docked where the chat sits — the two swap, never
 * stack. A chapter that starts past what has been prepared so far is shown
 * but locked: while the source is still arriving, jumping there would strand
 * the whole room on a position with no media under it.
 */
export function ChaptersPanel({ chapters, open, onClose, onSeek, videoRef, t }: ChaptersPanelProps) {
  // What is seekable and where playback is, sampled while the panel is open.
  // Polled rather than subscribed: both move constantly during a preview, and
  // once a second is exactly as alive as the lock icons need to be.
  const [now, setNow] = useState({ end: 0, at: 0 })
  useEffect(() => {
    if (!open) return
    const read = () => {
      const video = videoRef.current
      if (!video) return
      const seekable = video.seekable
      const end = seekable.length > 0 ? seekable.end(seekable.length - 1)
        : Number.isFinite(video.duration) ? video.duration : 0
      setNow({ end, at: video.currentTime })
    }
    read()
    const timer = window.setInterval(read, 1_000)
    return () => window.clearInterval(timer)
  }, [open, videoRef])

  return (
    <aside className={`chat-panel chat-docked chapters-panel ${open ? 'is-open' : ''}`}>
      <header>
        <h2>{t('chapters.title')}</h2>
        <button type="button" aria-label={t('chapters.close')} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </header>
      <ol className="chapters-list">
        {chapters.map((chapter, index) => {
          const start = chapter.startMs / 1000
          const label = chapter.title || `${t('player.chapter')} ${index + 1}`
          const current = now.at * 1000 >= chapter.startMs && now.at * 1000 < chapter.endMs
          const locked = start > Math.max(now.end - 1, 0)
          return (
            <li key={`${chapter.startMs}-${index}`}>
              <button
                type="button"
                className={`chapter-row ${current ? 'is-current' : ''}`}
                disabled={locked || !onSeek}
                title={locked ? t('chapters.locked') : undefined}
                onClick={() => onSeek?.(start)}
              >
                <span className="chapter-time">{formatTime(start)}</span>
                <span className="chapter-title">{label}</span>
                {locked ? <Lock size={13} aria-hidden="true" /> : null}
              </button>
            </li>
          )
        })}
      </ol>
    </aside>
  )
}
