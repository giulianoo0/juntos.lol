import { Popover } from '@base-ui-components/react/popover'
import { useRef, useState, type ReactNode } from 'react'
import { springPopupClass, springPositionerClass } from './springPresence'

interface MorphingMenuProps {
  trigger: (open: boolean) => ReactNode
  children: (close: (returnFocus?: boolean) => void) => ReactNode
  align?: 'start' | 'end'
  minWidth?: number
  haspopup: 'menu' | 'listbox'
  ariaLabel?: string
  triggerClassName?: string
  panelClassName?: string
  onOpen?: () => void
  openOn?: 'click' | 'contextmenu'
}

/**
 * The old menu's interface over the spring popover, for the screens that
 * still call it (the screen stage, the catalog's dropdowns, the old room):
 * every menu opens with the one physics. New code uses `SpringPopover`.
 */
export function MorphingMenu({
  trigger,
  children,
  align = 'start',
  minWidth = 230,
  haspopup,
  ariaLabel,
  triggerClassName = '',
  panelClassName = '',
  onOpen,
  openOn = 'click',
}: MorphingMenuProps) {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const change = (next: boolean) => {
    if (next && !open) onOpen?.()
    setOpen(next)
  }
  const close = (returnFocus = false) => {
    setOpen(false)
    if (returnFocus) triggerRef.current?.focus({ preventScroll: true })
  }
  const triggerProps = {
    className: `morph-menu-trigger ${triggerClassName}`.trim(),
    'aria-label': ariaLabel,
    'aria-haspopup': haspopup,
  }
  const row = <span className="morph-menu-trigger-row">{trigger(open)}</span>

  return (
    <Popover.Root open={open} onOpenChange={change}>
      {openOn === 'click' ? (
        <Popover.Trigger ref={triggerRef} {...triggerProps}>{row}</Popover.Trigger>
      ) : (
        <button
          ref={triggerRef}
          type="button"
          aria-expanded={open}
          {...triggerProps}
          onContextMenu={(event) => { event.preventDefault(); change(true) }}
        >
          {row}
        </button>
      )}
      <Popover.Portal>
        <Popover.Positioner anchor={triggerRef} side="bottom" align={align} sideOffset={8} collisionPadding={16} className={springPositionerClass}>
          <Popover.Popup className={`${springPopupClass} ${panelClassName}`.trim()} style={{ width: 'auto', minWidth }}>
            {children(close)}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  )
}
