import type { ReactNode } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'

// Wraps Radix so every modal in the app gets the same focus, Escape, overlay
// and scroll-lock behaviour.

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
  container,
}: {
  children: ReactNode
  className?: string
  title: ReactNode
  description?: ReactNode
  closeLabel?: string
  hideTitle?: boolean
  onCloseClick?: () => void
  /** Where the modal mounts; a fullscreen element, or it stays hidden behind it. */
  container?: HTMLElement | null
}) {
  return (
    <DialogPrimitive.Portal container={container ?? undefined}>
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
