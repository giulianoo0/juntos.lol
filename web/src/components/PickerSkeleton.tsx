import { Loading, Skeleton } from '../ui/Shimmer'
import styles from './Picker.module.css'

const WIDTHS = ['72%', '58%', '66%', '48%']

/** The list of files or folders on its way: rows of an icon, a name, a size. */
export function RowsSkeleton({ label, rows = 4 }: { label: string; rows?: number }) {
  return (
    <Loading label={label} className={styles.list}>
      {WIDTHS.slice(0, rows).map((width) => (
        <span key={width} className={styles.skeletonRow}>
          <Skeleton width="1rem" height="1rem" round />
          <Skeleton width={width} height="0.8rem" />
          <Skeleton width="3rem" height="0.7rem" style={{ marginInlineStart: 'auto' }} />
        </span>
      ))}
    </Loading>
  )
}

/** The video on its way: a thumbnail, its title, its chips. */
export function SummarySkeleton({ label }: { label: string }) {
  return (
    <Loading label={label} className={styles.summary}>
      <Skeleton width="8rem" height="auto" style={{ flex: 'none', aspectRatio: '16 / 9' }} />
      <span className={styles.summaryText} style={{ flex: 1 }}>
        <Skeleton width="85%" height="0.9rem" />
        <Skeleton width="55%" height="0.9rem" />
        <span className={styles.chips}>
          <Skeleton width="3rem" height="1.25rem" round />
          <Skeleton width="2.5rem" height="1.25rem" round />
        </span>
      </span>
    </Loading>
  )
}
