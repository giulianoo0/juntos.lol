import type { CSSProperties, ReactNode } from 'react'
import styles from './Shimmer.module.css'

/** Words that are still working: the label itself, under the DiaShimmer. */
export function DiaText({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`${styles.dia} ${className}`.trim()}>{children}</span>
}

/** An icon that is still working: its stroke walks the DiaShimmer's colours. */
export function DiaGlyph({ children }: { children: ReactNode }) {
  return <span className={styles.diaGlyph}>{children}</span>
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
