import { useCallback, useEffect, useState, type ReactNode } from 'react'
import useEmblaCarousel from 'embla-carousel-react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

// A wheel tick in lines (Firefox with a plain mouse) or pages, scaled to
// pixels; sixteen a line is what the browsers themselves assume.
const LINE_PX = 16

interface CarouselProps {
  children: ReactNode
  className?: string
  prevLabel: string
  nextLabel: string
}

// The catalog's horizontal strip: Embla drives the scrolling (drag, snap
// containment, and the sideways wheel through the listener below — bare
// Embla ignores wheel events, and the viewport's overflow:hidden leaves no
// native fallback) and a pair of floating round buttons ride the edges, each
// appearing only while there is somewhere left to go.
export function Carousel({ children, className, prevLabel, nextLabel }: CarouselProps) {
  // slidesToScroll 'auto' makes the arrows page by whole views instead of
  // nudging one card at a time.
  const [viewportRef, embla] = useEmblaCarousel(
    { align: 'start', dragFree: true, containScroll: 'trimSnaps', slidesToScroll: 'auto' },
  )
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

  // Sideways wheel and trackpad swipes move the strip; vertical ones are the
  // page's and never touch it.
  //
  // This used to be embla-carousel-wheel-gestures, which binds a non-passive
  // `wheel` listener on every viewport so it can preventDefault a sideways
  // gesture. A non-passive listener means the browser cannot scroll until the
  // main thread has run the handler — for every tick over any row, vertical
  // ones included — and Firefox parks the scroll until content answers. With
  // five rows of forty posters, a React commit or a style flush in the way
  // turned a plain wheel scroll into a stutter. This listener is passive: the
  // browser scrolls the page on its own thread, and a sideways delta goes to
  // Embla's target the way a drag does. What the old preventDefault bought —
  // keeping a swipe over a strip from becoming the browser's back gesture —
  // is done in CSS with overscroll-behavior on the board's scrollers.
  useEffect(() => {
    if (!embla) return
    const engine = embla.internalEngine()
    const viewport = embla.rootNode()
    const onWheel = (event: WheelEvent) => {
      const { deltaX, deltaY } = event
      if (Math.abs(deltaX) <= Math.abs(deltaY)) return
      if (engine.dragHandler.pointerDown()) return
      const scale = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? engine.containerRect.width : 1
      const current = engine.target.get()
      // Clamped at the edges: the end of the strip is a stop, not a rubber
      // band pulling back after every over-eager swipe.
      const distance = engine.limit.constrain(current + engine.axis.direction(-deltaX * scale)) - current
      if (distance === 0) return
      // The same body a drag uses, so wheel and pointer feel alike.
      engine.scrollBody.useFriction(0.3).useDuration(0.75)
      engine.scrollTo.distance(distance, false)
    }
    viewport.addEventListener('wheel', onWheel, { passive: true })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [embla])

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
