import { useCallback, useEffect, useState, type ReactNode } from 'react'
import useEmblaCarousel from 'embla-carousel-react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

const LINE_PX = 16

interface CarouselProps {
  children: ReactNode
  className?: string
  prevLabel: string
  nextLabel: string
}

// The catalog's horizontal strip: Embla drives drag, snap and wheel, and a pair
// of floating arrows appear only while there is somewhere left to go.
export function Carousel({ children, className, prevLabel, nextLabel }: CarouselProps) {
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
      const distance = engine.limit.constrain(current + engine.axis.direction(-deltaX * scale)) - current
      if (distance === 0) return
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
