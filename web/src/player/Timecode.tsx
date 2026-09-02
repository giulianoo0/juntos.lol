import NumberFlow, { type Format } from '@number-flow/react'

const PLAIN: Format = { useGrouping: false }
const PADDED: Format = { minimumIntegerDigits: 2, useGrouping: false }

/**
 * The clock under the scrub bar: each field is its own animated number, so
 * only the digits that changed roll over. Minutes run past sixty rather than
 * growing an hours field.
 */
export function Timecode({ seconds }: { seconds: number }) {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return (
    <span className="timecode-clock">
      <NumberFlow value={Math.floor(total / 60)} format={PLAIN} />
      <span className="timecode-colon">:</span>
      <NumberFlow value={total % 60} format={PADDED} />
    </span>
  )
}
