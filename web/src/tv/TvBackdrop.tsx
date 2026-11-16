import styles from './TvBackdrop.module.css'

const SHAPES = ['circle', 'square', 'pill', 'ring', 'dot'] as const

/**
 * The TV's ground: a faint grid of dots and a few big shapes that drift and
 * slowly pass from one color to the next. Only opacity, transform and a
 * background color move, which old TVs keep up with.
 */
export function TvBackdrop() {
  return (
    <div className={styles.backdrop} aria-hidden="true">
      {SHAPES.map((shape) => <span key={shape} className={styles.shape} data-shape={shape} />)}
      <div className={styles.texture} />
    </div>
  )
}
