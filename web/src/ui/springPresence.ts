import styles from './SpringPopover.module.css'

/** The popover's own panel and positioner, for a popover built by hand. */
export const springPopupClass = styles.popup
export const springPositionerClass = styles.positioner
/** A row of the panel, its mark, label and rule, for rows built by hand (a context menu's items). */
export const springRowClasses = { row: styles.row, mark: styles.mark, label: styles.label, rule: styles.rule }
