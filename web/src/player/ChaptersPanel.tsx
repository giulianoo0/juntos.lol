import { useEffect, useState, type MutableRefObject } from 'react'
import { X } from 'lucide-react'
import type { RoomChapter } from '../types'
import type { Translator } from '../i18n/useT'

interface ChaptersPanelProps {
  chapters: RoomChapter[]
  open: boolean
  onClose: () => void
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
 * stack. Every chapter is jumpable: the pipeline restarts wherever the room
 * points, so nothing here waits on what has been prepared.
 */
export function ChaptersPanel({ chapters, open, onClose, onSeek, videoRef, t }: ChaptersPanelProps) {
  const [nowAt, setNowAt] = useState(0)
  useEffect(() => {
    if (!open) return
    const read = () => {
      const video = videoRef.current
      if (video) setNowAt(video.currentTime)
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
          const current = nowAt * 1000 >= chapter.startMs && nowAt * 1000 < chapter.endMs
          return (
            <li key={`${chapter.startMs}-${index}`}>
              <button
                type="button"
                className={`chapter-row ${current ? 'is-current' : ''}`}
                disabled={!onSeek}
                onClick={() => onSeek?.(start)}
              >
                <span className="chapter-time">{formatTime(start)}</span>
                <span className="chapter-title">{label}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </aside>
  )
}
