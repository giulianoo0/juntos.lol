import { useRef, type ReactNode } from 'react'
import { useMorphingSize } from './useMorphingSize'

interface MorphPanelProps {
  /** Identifies the step on show. A change travels the panel to its new size. */
  sizeKey: unknown
  /** True while the outgoing step is dissolving, which is what the blur hangs off. */
  morphing: boolean
  className?: string
  children: ReactNode
}

/**
 * One surface that changes what it is showing, rather than a series of
 * surfaces replacing each other.
 *
 * It owns the two halves that make a swap read as one object reforming: the
 * box travels between the sizes its steps need, measured rather than guessed,
 * and the contents dissolve through a blur instead of cutting. It also follows
 * its own contents growing between steps — an error appearing under a form, a
 * list arriving — so nothing inside it ever snaps the panel to a new height.
 *
 * Callers keep the step machine (`useMorphingStep`) so they can decide what
 * each step renders; this only draws the panel around it.
 */
export function MorphPanel({ sizeKey, morphing, className = '', children }: MorphPanelProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  useMorphingSize(boxRef, sizeKey, { contentRef: paneRef })
  return (
    <div className={`morph-box ${className}`.trim()} ref={boxRef}>
      <div className="morph-pane morph-fade" ref={paneRef} data-morphing={morphing}>
        {children}
      </div>
    </div>
  )
}
