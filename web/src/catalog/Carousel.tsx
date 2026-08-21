import { useCallback, useEffect, useState, type ReactNode } from 'react'
import useEmblaCarousel from 'embla-carousel-react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface CarouselProps {
  children: ReactNode
  className?: string
  prevLabel: string
  nextLabel: string
}

// The catalog's horizontal strip: Embla drives the scrolling (drag, wheel,
// snap containment) and a pair of floating round buttons ride the edges,
// each appearing only while there is somewhere left to go.
export function Carousel({ children, className, prevLabel, nextLabel }: CarouselProps) {
  // slidesToScroll 'auto' makes the arrows page by whole views instead of
  // nudging one card at a time.
  const [viewportRef, embla] = useEmblaCarousel({ align: 'start', dragFree: true, containScroll: 'trimSnaps', slidesToScroll: 'auto' })
  const [canPrev, setCanPrev] = useState(false)
  const [canNext, setCanNext] = useState(false)

  const refresh = useCallback(() => {
    if (!embla) return
    setCanPrev(embla.canScrollPrev())
    setCanNext(embla.canScrollNext())
  }, [embla])

  useEffect(() => {
    if (!embla) return
    refresh()
    embla.on('select', refresh)
    embla.on('reInit', refresh)
    embla.on('scroll', refresh)
    return () => {
      embla.off('select', refresh)
      embla.off('reInit', refresh)
      embla.off('scroll', refresh)
    }
  }, [embla, refresh])

  return (
    <div className={`carousel ${className ?? ''}`} data-can-prev={canPrev || undefined} data-can-next={canNext || undefined}>
      <div className="carousel-viewport" ref={viewportRef}>
        <div className="carousel-track">{children}</div>
      </div>
      {/* preventDefault on mousedown: a focused arrow inside a scrollable
          panel would make the browser scroll it into view — the "teleport". */}
      {canPrev ? (
        <button
          type="button"
          className="carousel-arrow carousel-arrow--prev"
          aria-label={prevLabel}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => embla?.scrollPrev()}
        >
          <ChevronLeft size={28} aria-hidden="true" />
        </button>
      ) : null}
      {canNext ? (
        <button
          type="button"
          className="carousel-arrow carousel-arrow--next"
          aria-label={nextLabel}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => embla?.scrollNext()}
        >
          <ChevronRight size={28} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  )
}
