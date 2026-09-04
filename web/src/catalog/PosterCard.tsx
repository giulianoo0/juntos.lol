import { memo, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import { Film, Tv } from 'lucide-react'
import type { CatalogMeta } from './tmdb'
import { FadeImg } from './FadeImg'

export interface TitleOpen {
  meta: CatalogMeta
  rect?: DOMRect
}

interface PosterCardProps {
  meta: CatalogMeta
  onOpen: (open: TitleOpen) => void
}

export const PosterCard = memo(function PosterCard({ meta, onOpen }: PosterCardProps) {
  const artRef = useRef<HTMLSpanElement>(null)

  const open = (event: MouseEvent | KeyboardEvent) => {
    const pointer = 'detail' in event && event.detail > 0
    onOpen({ meta, rect: pointer ? artRef.current?.getBoundingClientRect() : undefined })
  }

  return (
    <button type="button" className="poster-card" onClick={open} aria-label={meta.name}>
      <span ref={artRef} className="poster-art">
        {meta.poster ? (
          <FadeImg src={meta.poster} alt="" loading="lazy" />
        ) : (
          meta.type === 'movie' ? <Film size={28} aria-hidden="true" /> : <Tv size={28} aria-hidden="true" />
        )}
      </span>
      <span className="poster-name">{meta.name}</span>
      <span className="poster-year">{meta.releaseInfo}</span>
    </button>
  )
})
