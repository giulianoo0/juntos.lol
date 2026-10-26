import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'
import styles from './Field.module.css'

/** A rounded field. A visible `label` sits above it; without one the
    placeholder names it and `aria-label` must be given. */
export const Field = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & {
  label?: ReactNode
  /** A problem with what was typed, said under the field. */
  error?: string
  mono?: boolean
}>(function Field({ label, error, mono, className = '', id, ...rest }, ref) {
  const input = (
    <input
      ref={ref}
      id={id}
      className={`${styles.field} ${mono ? styles.mono : ''} ${className}`.trim()}
      aria-invalid={error ? true : undefined}
      {...rest}
    />
  )
  if (!label && !error) return input
  return (
    <label className={styles.wrap}>
      {label ? <span className={styles.label}>{label}</span> : null}
      {input}
      {error ? <span className={styles.error} role="alert">{error}</span> : null}
    </label>
  )
})
