import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'

/** The composer's pill on screen when the message left it. */
export interface FlightOrigin {
  right: number
  bottom: number
  width: number
}

/** A send older than this never flies: the line arrived some other way. */
const STALE_MS = 1000

/* The flight's shape (lawcore `use-send-flight.ts`, from america.gov's
   chat): the line starts stretched to the pill's width less its button,
   squashed, blurred and centred on the pill's foot, so it rises from
   behind the composer, then settles. */
const PILL_INSET = 40
const SEND_GUTTER = 52
const START_SCALE_Y = 0.86
const MAX_SCALE_X = 3.4
const MAX_SHIFT_X = 220
const MAX_SHIFT_Y = 640
const START_BLUR = 14

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export function flightStart(origin: FlightOrigin, box: { right: number; width: number }) {
  return {
    scaleX: clamp(Math.max(origin.width - PILL_INSET, box.width) / box.width, 1, MAX_SCALE_X),
    shiftX: clamp(origin.right - SEND_GUTTER - box.right, -MAX_SHIFT_X, MAX_SHIFT_X),
  }
}

/** The blur holds 60% through the first 60% of the flight, then clears. */
export const blurAt = (t: number) => START_BLUR * (1 - (t < 0.6 ? (t / 0.6) * 0.4 : 0.4 + ((t - 0.6) / 0.4) * 0.6))

/** Reads `cubic-bezier(a, b, c, d)` into a progress function. */
export function parseEasing(value: string): (t: number) => number {
  const points = /cubic-bezier\(([^)]+)\)/.exec(value)?.[1]?.split(',').map((part) => parseFloat(part))
  if (points?.length !== 4 || points.some(Number.isNaN)) return (t) => t
  const [x1, y1, x2, y2] = points as [number, number, number, number]
  const bezier = (t: number, a: number, b: number) => 3 * a * t * (1 - t) ** 2 + 3 * b * t ** 2 * (1 - t) + t ** 3
  return (x) => {
    let low = 0
    let high = 1
    let t = x
    for (let step = 0; step < 20; step += 1) {
      const current = bezier(t, x1, x2)
      if (Math.abs(current - x) < 0.0005) break
      if (current < x) low = t
      else high = t
      t = (low + high) / 2
    }
    return bezier(t, y1, y2)
  }
}

const parseMs = (value: string) => {
  const number = parseFloat(value)
  return Number.isNaN(number) ? 0 : value.trim().endsWith('ms') ? number : number * 1000
}

/**
 * The sent message rises out of the composer into its place in the chat
 * (lawcore's "Mensagem enviada"): `launch` takes the pill's box at send;
 * when the viewer's own message lands (`lastOwnId` changes), its line
 * `[data-message-id] [data-flight]` starts behind the pill, as wide as it,
 * a little flat and blurred, and settles over `--duration-flight` along
 * `--ease-drawer`. The vertical offset is measured every frame against
 * where the line now sits, so a list that scrolls under it never fights
 * it. Other people's messages never fly. Reduced motion keeps a fade.
 */
export function useSendFlight(viewportRef: RefObject<HTMLElement | null>, lastOwnId: string | null) {
  const pendingRef = useRef<{ origin: FlightOrigin; at: number } | null>(null)
  const cancelRef = useRef<() => void>(() => undefined)

  const launch = useCallback((origin: FlightOrigin) => {
    pendingRef.current = { origin, at: performance.now() }
  }, [])

  useLayoutEffect(() => {
    const flight = pendingRef.current
    if (!flight || !lastOwnId) return
    pendingRef.current = null
    if (performance.now() - flight.at > STALE_MS) return

    const viewport = viewportRef.current
    const line = viewport?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(lastOwnId)}"] [data-flight]`)
    if (!viewport || !line) return
    const box = line.getBoundingClientRect()
    if (box.width < 4 || box.height < 4) return

    const style = getComputedStyle(viewport)
    cancelRef.current()

    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      line.animate([{ opacity: 0 }, { opacity: 1 }], {
        duration: parseMs(style.getPropertyValue('--duration-fast')) || 160,
        easing: style.getPropertyValue('--ease-out').trim() || 'ease-out',
      })
      return
    }

    const duration = parseMs(style.getPropertyValue('--duration-flight')) || 440
    const ease = parseEasing(style.getPropertyValue('--ease-drawer'))
    const { origin } = flight
    const { scaleX: scaleX0, shiftX: shiftX0 } = flightStart(origin, box)

    let shiftY = 0
    let scaleY = START_SCALE_Y
    let reach = Infinity
    let frame = 0
    const start = performance.now()

    const reset = () => {
      line.style.transform = ''
      line.style.filter = ''
      line.style.transformOrigin = ''
      line.style.willChange = ''
    }

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const progress = ease(t)
      const rest = 1 - progress
      const rect = line.getBoundingClientRect()
      const centre = rect.bottom - shiftY - rect.height / scaleY / 2
      let y = clamp(origin.bottom - centre, -MAX_SHIFT_Y, MAX_SHIFT_Y) * rest
      if (Math.abs(y) > reach) y = reach * Math.sign(y)
      reach = Math.abs(y)
      const sx = scaleX0 + (1 - scaleX0) * progress
      const sy = START_SCALE_Y + (1 - START_SCALE_Y) * progress
      line.style.transform = `translate3d(${(shiftX0 * rest).toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`
      line.style.filter = `blur(${blurAt(t).toFixed(2)}px)`
      shiftY = y
      scaleY = sy
      if (t >= 1) {
        reset()
        frame = 0
        return
      }
      frame = window.requestAnimationFrame(step)
    }

    line.style.transformOrigin = '100% 100%'
    line.style.willChange = 'transform, filter'
    step(start)
    cancelRef.current = () => {
      if (frame) window.cancelAnimationFrame(frame)
      frame = 0
      reset()
    }
  }, [lastOwnId, viewportRef])

  useLayoutEffect(() => () => cancelRef.current(), [])

  return { launch }
}
