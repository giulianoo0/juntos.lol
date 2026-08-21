// A real progressive blur: five stacked backdrop layers, each blurring twice
// as much as the one before and masked to end higher up, so the blur builds
// from nothing at the bottom edge to its full strength at the top. A single
// masked layer would fade a constant blur in and out — this ramps the blur
// radius itself, which is what stops the hard "glass slab" edge.
//
// Layer geometry and the tint alpha are sampled from easing curves rather
// than spaced evenly, so no band reads as a seam. The stops live in
// theme.css next to the rest of the header styling.
const LAYERS = 5

export function ProgressiveBlur({ className }: { className?: string }) {
  return (
    <div className={`progressive-blur ${className ?? ''}`} aria-hidden="true">
      {Array.from({ length: LAYERS }, (_, index) => <span key={index} />)}
    </div>
  )
}
