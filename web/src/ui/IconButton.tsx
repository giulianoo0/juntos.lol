import type { ReactNode } from 'react'

/**
 * The label is always in the markup as the button's accessible name; only its
 * width is withheld, opening on hover.
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
