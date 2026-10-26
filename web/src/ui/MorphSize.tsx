import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import styles from './MorphSize.module.css'

/**
 * Follows what it holds in width and height on the spring's settle, and
 * lets a new `step` arrive through a short blur instead of popping in: the
 * popover that swaps its menu for a field, the pill whose words change.
 */
export function MorphSize({ step, axis = 'both', className = '', children }: {
  /** What is showing; a new value fades the content in again. */
  step: string
  axis?: 'both' | 'width' | 'height'
  className?: string
  children: ReactNode
}) {
  const inner = useRef<HTMLDivElement>(null)
  // The first content arrives with whatever opened it; only a change morphs.
  const firstStep = useRef(step)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)

  useLayoutEffect(() => {
    const node = inner.current
    if (!node) return undefined
    const measure = () => setSize({ width: node.offsetWidth, height: node.offsetHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const style = size ? {
    ...(axis !== 'height' ? { width: size.width } : {}),
    ...(axis !== 'width' ? { height: size.height } : {}),
  } : undefined

  return (
    <div className={`${styles.outer} ${className}`.trim()} data-axis={axis} style={style}>
      <div ref={inner} className={styles.inner} data-axis={axis}>
        <div key={step} className={styles.step} data-first={step === firstStep.current || undefined}>{children}</div>
      </div>
    </div>
  )
}
