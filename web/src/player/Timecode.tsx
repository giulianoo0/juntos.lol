import NumberFlow, { type Format } from '@number-flow/react'

/**
 * The clock under the scrub bar, digit by digit.
 *
 * A plain string swaps the whole label on every tick, which reads as a
 * flicker beside a bar that moves continuously. Each field is its own
 * animated number, so only the digits that changed roll over.
 */

// Minutes run past sixty rather than growing an hours field, which is what
// the bar has always shown; the seconds keep their leading zero.
const PLAIN: Format = { useGrouping: false }
const PADDED: Format = { minimumIntegerDigits: 2, useGrouping: false }

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
