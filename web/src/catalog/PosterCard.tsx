import { memo, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import { Film, Tv } from 'lucide-react'
import type { CatalogMeta } from './cinemeta'

export interface TitleOpen {
  meta: CatalogMeta
  // The poster's on-screen rect at click time, so the details panel can morph
  // out of it. Absent for keyboard/deep-link opens, which fade instead.
  rect?: DOMRect
}

interface PosterCardProps {
  meta: CatalogMeta
  onOpen: (open: TitleOpen) => void
}

// One poster in a row or grid. Motion here is CSS-only: a hover this frequent
// earns a near-imperceptible lift, not an animation.
export const PosterCard = memo(function PosterCard({ meta, onOpen }: PosterCardProps) {
  const artRef = useRef<HTMLSpanElement>(null)

  const open = (event: MouseEvent | KeyboardEvent) => {
    // Keyboard "clicks" report no coordinates; a morph from an unseen origin
    // reads as noise, so those open with a fade.
    const pointer = 'detail' in event && event.detail > 0
    onOpen({ meta, rect: pointer ? artRef.current?.getBoundingClientRect() : undefined })
  }

  return (
    <button type="button" className="poster-card" onClick={open} aria-label={meta.name}>
      <span ref={artRef} className="poster-art">
        {meta.poster ? (
          <img src={meta.poster} alt="" loading="lazy" />
        ) : (
          meta.type === 'movie' ? <Film size={28} aria-hidden="true" /> : <Tv size={28} aria-hidden="true" />
        )}
      </span>
      <span className="poster-name">{meta.name}</span>
      <span className="poster-year">{meta.releaseInfo}</span>
    </button>
  )
})
