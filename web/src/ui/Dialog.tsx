import type { ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

// Dialog wraps Radix so every modal in the app gets the same behaviour for
// free: focus moves in and comes back out, Escape and the overlay close it,
// the page behind stops scrolling and screen readers are told a dialog opened.
// The previous <dialog> elements had to be taught each of those by hand, and
// were not consistent about it.

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

export function DialogContent({
  children,
  className = '',
  title,
  description,
  closeLabel = 'Close',
  hideTitle = false,
  onCloseClick,
}: {
  children: ReactNode
  className?: string
  // Radix requires a title for the accessible name. Passing it here keeps a
  // dialog from ever shipping without one.
  title: ReactNode
  description?: ReactNode
  closeLabel?: string
  // For content that renders its own heading — one that changes as the dialog
  // advances through steps. The title still exists for assistive technology,
  // it just is not drawn twice.
  hideTitle?: boolean
  onCloseClick?: () => void
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="ui-dialog-overlay" />
      <DialogPrimitive.Content className={`ui-dialog ${className}`.trim()}>
        <div className="ui-dialog-body">
          <DialogPrimitive.Close asChild>
            <button className="dialog-close" aria-label={closeLabel} onClick={onCloseClick}>
              <X size={15} aria-hidden="true" />
            </button>
          </DialogPrimitive.Close>
          <DialogPrimitive.Title className={hideTitle ? 'sr-only' : 'ui-dialog-title'}>
            {title}
          </DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className={hideTitle ? 'sr-only' : 'ui-dialog-description'}>
              {description}
            </DialogPrimitive.Description>
          ) : null}
          {children}
        </div>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}
