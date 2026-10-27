import { useId } from 'react'
import { useMediaQuery } from '../../ui/useMediaQuery'

/* The old juntos lettering, one stroke per letter; the play arrow is the "." */
const STROKES = [
  'M 12 -42 L 12 0 A 12 12 0 0 1 0 12',
  'M 34 -42 L 34 -18 A 18 18 0 0 0 70 -18',
  'M 70 -42 L 70 -6',
  'M 92 -42 L 92 -6',
  'M 92 -24 A 18 18 0 0 1 128 -24 L 128 -6',
  'M 161 -62 L 161 -6',
  'M 150 -42 L 172 -42',
  'M 213 -43.5 A 19 19.5 0 1 1 212.98 -43.5',
  'M 277.93 -37.1 A 12 10.5 0 1 0 266 -25.5 A 12 10.5 0 1 1 254.88 -11.07',
  'M 336 -68 L 336 -6',
  'M 377 -43.5 A 19 19.5 0 1 1 376.98 -43.5',
  'M 418 -68 L 418 -6',
]
const ARROW = 'M 299 -33 L 313 -24 L 299 -15 Z'
const VIEW = '-8 -80 440 108'

function Letters({ ink }: { ink: string }) {
  return (
    <>
      <g fill="none" stroke={ink} strokeWidth={12} strokeLinecap="round" strokeLinejoin="round">
        {STROKES.map((d) => <path key={d} d={d} />)}
      </g>
      <circle cx="12" cy="-58" r="6.5" fill={ink} />
    </>
  )
}

/** "juntos.lol" in the corner. */
export function SmallWordmark({ className }: { className?: string }) {
  return (
    <svg viewBox={VIEW} className={className} role="img" aria-label="juntos.lol">
      <Letters ink="currentColor" />
      <path d={ARROW} fill="var(--brand)" />
    </svg>
  )
}

/**
 * The big lettering with the Dia shimmer of the maintenance page: a band of
 * color sweeping left to right through the letters. Reduced motion: still.
 */
export function HeroWordmark({ className, sweepClassName, morphed = false }: {
  className?: string
  /** Arrived through the logo's morph: skips its own entrance. */
  morphed?: boolean
  /** On the colour band, to show it only on hover (the header's logo). */
  sweepClassName?: string
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)')
  return (
    <svg viewBox={VIEW} className={className} data-morphed={morphed || undefined} role="img" aria-label="juntos.lol">
      <defs>
        <mask id={`${id}-mask`} maskUnits="userSpaceOnUse" x="-8" y="-80" width="440" height="108">
          <Letters ink="#fff" />
        </mask>
        <linearGradient id={`${id}-dia`} gradientUnits="userSpaceOnUse" x1="-888" y1="-142" x2="432" y2="90">
          <stop offset="0" stopColor="#000" stopOpacity="0" />
          <stop offset=".38" stopColor="#000" stopOpacity="0" />
          <stop offset=".44" stopColor="#c679c4" />
          <stop offset=".47" stopColor="#fa3d1d" />
          <stop offset=".50" stopColor="#ffb005" />
          <stop offset=".53" stopColor="#e1e1fe" />
          <stop offset=".56" stopColor="#0358f7" />
          <stop offset=".62" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity="0" />
          {reduced ? null : (
            <animateTransform attributeName="gradientTransform" type="translate" from="0 0" to="880 0" dur="2.6s" repeatCount="indefinite" />
          )}
        </linearGradient>
      </defs>
      <g mask={`url(#${id}-mask)`}>
        <rect x="-8" y="-80" width="440" height="108" fill="currentColor" />
        {reduced ? null : <rect className={sweepClassName} x="-8" y="-80" width="440" height="108" fill={`url(#${id}-dia)`} />}
      </g>
      <path d={ARROW} fill="var(--brand)" />
    </svg>
  )
}
