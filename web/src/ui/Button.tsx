import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Slot } from '@radix-ui/react-slot'

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'icon'
export type ButtonSize = 'default' | 'small' | 'icon'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  // Renders the child element instead of a <button>, for a link that should
  // look and behave like one.
  asChild?: boolean
}

// Button is the one control every surface uses, so the variants live here
// rather than as ad-hoc class names scattered across the pages. Styling stays
// in theme.css with the rest of the design tokens; what this adds is a single
// place to change what a button is.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'default', asChild = false, className = '', type, ...props },
  ref,
) {
  const Component = asChild ? Slot : 'button'
  const classes = [
    'ui-button',
    variant !== 'default' ? `ui-button--${variant}` : '',
    size !== 'default' ? `ui-button--${size}` : '',
    className,
  ].filter(Boolean).join(' ')
  return (
    <Component
      ref={ref}
      className={classes}
      // A button inside a form defaults to submitting it, which is almost
      // never what a control in this app means.
      type={asChild ? undefined : type ?? 'button'}
      {...props}
    />
  )
})
