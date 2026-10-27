import type { CSSProperties } from 'react'
import styles from './PillSlider.module.css'

/**
 * A thick dark pill filled up to the value, with a short light stroke for
 * the thumb. It is the browser's own range underneath: keys, focus and
 * dragging stay native.
 */
export function PillSlider({ label, value, min = 0, max = 1, step = 0.01, valueText, onChange }: {
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  /** What a screen reader says for the value ("80%"). */
  valueText?: string
  onChange: (value: number) => void
}) {
  const ratio = max > min ? (Math.min(Math.max(value, min), max) - min) / (max - min) : 0
  return (
    <input
      type="range"
      className={styles.slider}
      aria-label={label}
      aria-valuetext={valueText}
      min={min}
      max={max}
      step={step}
      value={value}
      style={{ '--ratio': ratio } as CSSProperties}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  )
}
