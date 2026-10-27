import { Dialog } from '@base-ui/react/dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import styles from './Modal.module.css'

/**
 * The "Novo contato" modal: solid, borderless, the float shadow, a big
 * radius, a title and nothing under it. It springs from the middle as the
 * popover springs from its trigger; on a phone it is a sheet from below.
 */
export function Modal({ open, onOpenChange, title, closeLabel, wide = false, children }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  closeLabel: string
  wide?: boolean
  children: ReactNode
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={styles.backdrop} />
        <Dialog.Popup className={styles.popup} data-wide={wide || undefined}>
          <div className={styles.head}>
            <Dialog.Title className={styles.title}>{title}</Dialog.Title>
            <Dialog.Close className={styles.close} aria-label={closeLabel} title={closeLabel}>
              <X size={16} aria-hidden="true" />
            </Dialog.Close>
          </div>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
