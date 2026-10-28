import styles from './Spinner.module.css'

/** Waiting on something that is not this button's own work. */
export function Spinner({ size = '1em' }: { size?: string }) {
  return <span className={styles.spinner} style={{ width: size, height: size }} aria-hidden="true" />
}
