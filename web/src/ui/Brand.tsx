import { useEffect, useId, useRef, useState } from 'react'
import {
  CORAL,
  MARK_PLAY,
  MARK_STEM,
  MARK_VIEWBOX,
  STROKE_WIDTH,
  WORDMARK_DOT,
  WORDMARK_PLAY,
  WORDMARK_STROKES,
  WORDMARK_VIEWBOX,
} from './wordmarkPaths'

const SPEED = 1.05
const LIFT = 26
const POP = 150
const PLAY_POP = 240
const START = 220

const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
const BOUNCE = 'cubic-bezier(0.34, 1.56, 0.64, 1)'

const SEEN = 'juntos:written'

/**
 * Avaliado uma vez por carga da página, na importação do módulo: em StrictMode
 * uma checagem feita na montagem devolveria `false` no segundo mount.
 */
export const WRITES_ON_LOAD = ((): boolean => {
  if (typeof window === 'undefined') return false
  if (window.location.pathname.startsWith('/room/')) return false
  try {
    if (sessionStorage.getItem(SEEN)) return false
    sessionStorage.setItem(SEEN, '1')
  } catch {}
  return true
})()

const UNDRAWN: React.CSSProperties = { strokeDasharray: 1, strokeDashoffset: 1 }
const UNPLACED: React.CSSProperties = { opacity: 0, transformBox: 'fill-box', transformOrigin: 'center' }

/**
 * Roda uma vez só, guardada por um ref: a escrita é um evento da carga da
 * página, não do ciclo de vida do componente. Sem WAAPI ou com reduced motion,
 * chama `onWritten` de imediato.
 */
function useWriting(ref: React.RefObject<SVGSVGElement | null>, active: boolean, onWritten: () => void) {
  const started = useRef(false)

  useEffect(() => {
    const svg = ref.current
    if (!svg || !active || started.current) return

    const probe = svg.querySelector<SVGGeometryElement>('[data-stroke]')
    const drawable = typeof probe?.getTotalLength === 'function' && typeof svg.animate === 'function'
    if (!drawable || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      onWritten()
      return
    }
    started.current = true

    const running: Animation[] = []
    const pop = (node: Element, delay: number, duration: number, easing: string) =>
      running.push(node.animate(
        [{ opacity: 0, transform: 'scale(0.3)' }, { opacity: 1, transform: 'scale(1)' }],
        { delay, duration, easing, fill: 'both' },
      ))

    let t = START
    let opening = true
    for (const stroke of WORDMARK_STROKES) {
      const node = svg.querySelector<SVGPathElement>(`[data-stroke="${stroke.id}"]`)
      if (!node) continue
      if (!opening && !stroke.joined) t += LIFT
      opening = false

      const duration = Math.max(70, node.getTotalLength() / SPEED)
      running.push(node.animate(
        [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }],
        { delay: t, duration, easing: 'linear', fill: 'both' },
      ))

      if (stroke.id === 'j') {
        const dot = svg.querySelector('[data-dot]')
        if (dot) pop(dot, t + duration + 20, POP, EASE)
      }
      t += duration

      if (stroke.id === 's') {
        t += LIFT + 20
        const play = svg.querySelector('[data-play]')
        if (play) pop(play, t, PLAY_POP, BOUNCE)
        t += PLAY_POP * 0.5
      }
    }

    running[running.length - 1]?.finished.then(onWritten, () => undefined)
  }, [ref, active, onWritten])
}

function useShimmer(ref: React.RefObject<SVGRectElement | null>) {
  const running = useRef<Animation | null>(null)
  return useRef(() => {
    const node = ref.current
    if (!node || typeof node.animate !== 'function') return
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    running.current?.cancel()
    running.current = node.animate(
      [{ transform: 'translateX(0)' }, { transform: 'translateX(660px)' }],
      { duration: 900, easing: 'cubic-bezier(0.4, 0, 0.3, 1)', fill: 'none' },
    )
  }).current
}

/** O nome inteiro. Com `writing`, ele se escreve traço a traço ao montar. */
export function Wordmark({ className, writing = false }: { className?: string; writing?: boolean }) {
  const ref = useRef<SVGSVGElement>(null)
  const sheenRef = useRef<SVGRectElement>(null)
  const [hidden, setHidden] = useState(writing)
  const onWritten = useRef(() => setHidden(false)).current
  useWriting(ref, writing, onWritten)
  const shimmer = useShimmer(sheenRef)

  const uid = useId().replace(/:/g, '')
  const maskId = `jl-ink-${uid}`
  const sheenId = `jl-sheen-${uid}`

  return (
    <svg
      ref={ref}
      className={className}
      viewBox={WORDMARK_VIEWBOX}
      role="img"
      aria-label="juntos.lol"
      focusable="false"
      onPointerEnter={shimmer}
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x={-20} y={-92} width={480} height={132}>
          <g fill="none" stroke="#fff" strokeWidth={STROKE_WIDTH} strokeLinecap="round" strokeLinejoin="round">
            {WORDMARK_STROKES.map((stroke) => <path key={stroke.id} d={stroke.d} />)}
          </g>
          <circle cx={WORDMARK_DOT.cx} cy={WORDMARK_DOT.cy} r={WORDMARK_DOT.r} fill="#fff" />
          <path d={WORDMARK_PLAY} fill="#fff" stroke="#fff" strokeWidth={4} strokeLinejoin="round" />
        </mask>
        <linearGradient id={sheenId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor={CORAL} stopOpacity="0" />
          <stop offset="0.5" stopColor={CORAL} stopOpacity="1" />
          <stop offset="1" stopColor={CORAL} stopOpacity="0" />
        </linearGradient>
      </defs>

      <g fill="none" stroke="currentColor" strokeWidth={STROKE_WIDTH} strokeLinecap="round" strokeLinejoin="round">
        {WORDMARK_STROKES.map((stroke) => (
          <path key={stroke.id} data-stroke={stroke.id} d={stroke.d} pathLength={1} style={hidden ? UNDRAWN : undefined} />
        ))}
      </g>
      <circle data-dot cx={WORDMARK_DOT.cx} cy={WORDMARK_DOT.cy} r={WORDMARK_DOT.r} fill="currentColor" style={hidden ? UNPLACED : undefined} />
      <path data-play d={WORDMARK_PLAY} fill={CORAL} stroke={CORAL} strokeWidth={4} strokeLinejoin="round" style={hidden ? UNPLACED : undefined} />

      <g mask={`url(#${maskId})`} style={{ pointerEvents: 'none' }}>
        <g transform="rotate(14 200 -30)">
          <rect ref={sheenRef} x={-200} y={-230} width={110} height={400} fill={`url(#${sheenId})`} />
        </g>
      </g>
    </svg>
  )
}

/** A marca curta, para onde o nome inteiro não cabe. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox={MARK_VIEWBOX} role="img" aria-label="juntos.lol" focusable="false">
      <g transform="translate(-6,6)">
        <path d={MARK_STEM} fill="none" stroke="currentColor" strokeWidth={78} strokeLinecap="round" />
        <path d={MARK_PLAY} fill={CORAL} stroke={CORAL} strokeWidth={16} strokeLinejoin="round" />
      </g>
    </svg>
  )
}
