import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ChevronDown } from 'lucide-react'

export interface DropdownOption {
  value: string
  label: ReactNode
  // Rendered right-aligned, opposite the label (e.g. how many sources match).
  detail?: ReactNode
}

interface DropdownProps {
  label: string
  value: string
  options: DropdownOption[]
  onChange: (value: string) => void
  // 'end' anchors the surface to the trigger's right edge, for dropdowns that
  // sit near the panel's right side and would otherwise get clipped.
  align?: 'start' | 'end'
}

// A player-settings-style morphing select: one continuous surface that is the
// pill trigger when shut and grows into the options panel when open — the
// container itself morphs (motion layout animation), nothing pops in beside
// it. An invisible copy of the trigger keeps the layout box while the real
// surface floats above it.
export function Dropdown({ label, value, options, onChange, align = 'start' }: DropdownProps) {
  const reduceMotion = useReducedMotion()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const selected = options.find((option) => option.value === value)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Capture phase, so the details panel underneath keeps its own Escape.
        event.stopPropagation()
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  const triggerRow = (
    <>
      <span className="dropdown-value">{selected?.label ?? label}</span>
      <ChevronDown size={14} aria-hidden="true" className={open ? 'is-open' : ''} />
    </>
  )

  return (
    <div ref={rootRef} className={`dropdown ${open ? 'is-open' : ''} ${align === 'end' ? 'dropdown--end' : ''}`}>
      {/* Spacer: reserves the shut pill's box so opening never reflows the row. */}
      <div className="dropdown-trigger dropdown-spacer" aria-hidden="true">{triggerRow}</div>
      <motion.div
        layout={!reduceMotion}
        className="dropdown-surface"
        style={{ borderRadius: 18 }}
        transition={{ duration: 0.24, ease: [0.77, 0, 0.175, 1] }}
      >
        <button
          type="button"
          className="dropdown-trigger dropdown-head"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={menuId}
          aria-label={label}
          onClick={() => setOpen((current) => !current)}
        >
          {triggerRow}
        </button>
        {open ? (
          <motion.ul
            id={menuId}
            role="listbox"
            aria-label={label}
            className="dropdown-menu"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1], delay: reduceMotion ? 0 : 0.08 }}
          >
            {options.map((option) => (
              <li key={option.value} role="option" aria-selected={option.value === value}>
                <button
                  type="button"
                  className={option.value === value ? 'is-selected' : ''}
                  onClick={() => { onChange(option.value); setOpen(false) }}
                >
                  <span className="dropdown-option-label">{option.label}</span>
                  {option.detail !== undefined ? <span className="dropdown-option-detail">{option.detail}</span> : null}
                </button>
              </li>
            ))}
          </motion.ul>
        ) : null}
      </motion.div>
    </div>
  )
}
