import type { ReactNode } from 'react'

/**
 * An icon that says what it is when you reach for it.
 *
 * The label is always in the markup — it is the button's accessible name, and
 * hiding it from assistive technology to save a few pixels would be trading
 * the wrong thing away. It is the *width* that is withheld: the label's column
 * is a grid track that opens from 0fr to 1fr on hover, which interpolates
 * against the real text rather than a guessed maximum, so the reveal neither
 * overshoots nor stalls with nothing left to open.
 */
export function IconButton({ icon, label, className = '', ...rest }: {
  icon: ReactNode
  label: string
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`icon-button ${className}`.trim()} {...rest}>
      <span className="icon-button-glyph" aria-hidden="true">{icon}</span>
      <span className="icon-button-label"><span>{label}</span></span>
    </button>
  )
}
