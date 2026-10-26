import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import styles from './Segmented.module.css'

export interface SegmentOption<T extends string> {
  value: T
  label: string
  /** A quiet count after the label ("Pessoas 6"). */
  badge?: ReactNode
}

/**
 * A choice among a few, all in view: segments on a track, the chosen one a
 * chip that slides to it on `--ease-slide` (at once from the keyboard, on
 * the first paint and with reduced motion).
 */
export function Segmented<T extends string>({ label, options, value, onChange, className = '' }: {
  label: string
  options: readonly SegmentOption<T>[]
  /** Nothing chosen (a pin elsewhere): no chip. */
  value: T | null
  onChange: (value: T) => void
  className?: string
}) {
  const trackRef = useRef<HTMLDivElement>(null)
  const chipRef = useRef<HTMLSpanElement>(null)
  const placed = useRef(false)

  useLayoutEffect(() => {
    const track = trackRef.current
    const chip = chipRef.current
    if (!track || !chip) return undefined
    const place = (instant: boolean) => {
      const target = track.querySelector<HTMLElement>('[aria-checked="true"]')
      if (!target) {
        chip.style.setProperty('--chip-width', '0px')
        return
      }
      if (instant) chip.dataset.instant = ''
      else delete chip.dataset.instant
      chip.style.setProperty('--chip-left', `${target.offsetLeft}px`)
      chip.style.setProperty('--chip-width', `${target.offsetWidth}px`)
    }
    place(!placed.current || track.matches(':has(:focus-visible)'))
    placed.current = true
    const observer = new ResizeObserver(() => place(true))
    observer.observe(track)
    return () => observer.disconnect()
  }, [value])

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (!step) return
    event.preventDefault()
    const index = options.findIndex((option) => option.value === value)
    const next = options[(index + step + options.length) % options.length]
    if (!next) return
    onChange(next.value)
    trackRef.current?.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus()
  }

  return (
    <div ref={trackRef} role="radiogroup" aria-label={label} className={`${styles.track} ${className}`.trim()}>
      <span ref={chipRef} className={styles.chip} aria-hidden="true" />
      {options.map((option, index) => {
        const chosen = option.value === value
        const reachable = chosen || (index === 0 && !options.some((other) => other.value === value))
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={chosen}
            tabIndex={reachable ? 0 : -1}
            data-value={option.value}
            className={styles.segment}
            onClick={() => onChange(option.value)}
            onKeyDown={onKeyDown}
          >
            {option.label}
            {option.badge !== undefined ? <span className={styles.badge}>{option.badge}</span> : null}
          </button>
        )
      })}
    </div>
  )
}
