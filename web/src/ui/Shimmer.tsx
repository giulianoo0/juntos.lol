import type { CSSProperties, ReactNode } from 'react'
import styles from './Shimmer.module.css'

/** Words that are still working: the label itself, under the DiaShimmer. */
export function DiaText({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`${styles.dia} ${className}`.trim()}>{children}</span>
}

/** Content on its way: skeletons in its shape, named once for screen readers. */
export function Loading({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  )
}

/** A shimmering block holding the place of content that is on its way. */
export function Skeleton({ width, height = '1em', round = false, className = '', style }: {
  width?: CSSProperties['width']
  height?: CSSProperties['height']
  round?: boolean
  className?: string
  style?: CSSProperties
}) {
  return (
    <span
      aria-hidden="true"
      data-round={round || undefined}
      className={`${styles.skeleton} ${className}`.trim()}
      style={{ width, height, ...style }}
    />
  )
}
