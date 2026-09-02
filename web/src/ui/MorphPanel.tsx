import { useRef, type ReactNode } from 'react'
import { useMorphingSize } from './useMorphingSize'

interface MorphPanelProps {
  sizeKey: unknown
  morphing: boolean
  travel?: boolean
  className?: string
  children: ReactNode
}

/**
 * Travels the box between the sizes its steps need and dissolves the contents
 * through a blur. The caller keeps the step machine (`useMorphingStep`).
 */
export function MorphPanel({ sizeKey, morphing, travel = true, className = '', children }: MorphPanelProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  useMorphingSize(boxRef, sizeKey, { contentRef: paneRef, travel })
  return (
    <div className={`morph-box ${className}`.trim()} ref={boxRef}>
      <div className="morph-pane morph-fade" ref={paneRef} data-morphing={morphing}>
        {children}
      </div>
    </div>
  )
}
