import { type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ChevronDown } from 'lucide-react'
import { MorphingMenu } from '../ui/MorphingMenu'
import { MORPH_EASE, OPEN_DURATION } from '../ui/morphTokens'

/** ≤40ms stagger for the first rows; the rest arrive with the panel. */
const STAGGER_STEP = 0.04
const STAGGERED_ITEMS = 8

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
  // 'end' anchors the panel to the trigger's right edge, for dropdowns that
  // sit near the panel's right side and would otherwise get clipped.
  align?: 'start' | 'end'
}

// A morphing select on the app's one menu surface (MorphingMenu): the pill
// trigger itself grows into the options panel and retracts into the pill
// again, contents choreographed so neither end ever shows stretched.
export function Dropdown({ label, value, options, onChange, align = 'start' }: DropdownProps) {
  const reduceMotion = useReducedMotion()
  const selected = options.find((option) => option.value === value)
  return (
    <MorphingMenu
      align={align}
      haspopup="listbox"
      ariaLabel={label}
      triggerClassName="dropdown-pill"
      trigger={(open) => (
        <>
          <span className="dropdown-value">{selected?.label ?? label}</span>
          <ChevronDown size={14} aria-hidden="true" className={open ? 'is-open' : ''} />
        </>
      )}
    >
      {(close) => (
        <ul role="listbox" aria-label={label} className="dropdown-menu">
          {options.map((option, index) => {
            const row = (
              <>
                <span className="dropdown-option-label">{option.label}</span>
                {option.detail !== undefined ? <span className="dropdown-option-detail">{option.detail}</span> : null}
              </>
            )
            return (
              <li key={option.value} role="option" aria-selected={option.value === value}>
                <button
                  type="button"
                  className={option.value === value ? 'is-selected' : ''}
                  onClick={() => { onChange(option.value); close(true) }}
                >
                  {!reduceMotion && index < STAGGERED_ITEMS ? (
                    <motion.span
                      className="dropdown-option-row"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: OPEN_DURATION, ease: MORPH_EASE, delay: index * STAGGER_STEP }}
                    >
                      {row}
                    </motion.span>
                  ) : (
                    <span className="dropdown-option-row">{row}</span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </MorphingMenu>
  )
}
