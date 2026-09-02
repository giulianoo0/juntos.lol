import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { Slot } from '@radix-ui/react-slot'

export type ButtonVariant = 'default' | 'primary' | 'ghost' | 'icon'
export type ButtonSize = 'default' | 'small' | 'icon'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  asChild?: boolean
}

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
      type={asChild ? undefined : type ?? 'button'}
      {...props}
    />
  )
})
