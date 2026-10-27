import { Children, forwardRef, type ButtonHTMLAttributes } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { DiaText } from './Shimmer'

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'icon'
export type ButtonSize = 'default' | 'small' | 'icon'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  asChild?: boolean
  /** Working: the words run the DiaShimmer (icons stay as they are) and the button holds still. */
  loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'default', asChild = false, loading = false, className = '', type, disabled, children, ...props },
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
      type={asChild ? undefined : type ?? 'button'}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      {...props}
    >
      {loading && !asChild
        ? Children.map(children, (child) => typeof child === 'string' || typeof child === 'number' ? <DiaText>{child}</DiaText> : child)
        : children}
    </Component>
  )
})
