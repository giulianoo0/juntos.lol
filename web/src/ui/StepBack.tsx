import { ChevronLeft } from 'lucide-react'

/**
 * One way out of every step, sitting against the step's own title so the panel
 * spends no height on it.
 *
 * It retreats one step rather than closing the flow: a step that took work to
 * reach — a magnet typed out, a name filled in — should not be thrown away to
 * undo the step after it. The label is carried as the accessible name, since
 * a lone chevron says nothing to a screen reader.
 */
export function StepBack({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="stage-back" aria-label={label} title={label} onClick={onClick}>
      <ChevronLeft size={17} aria-hidden="true" />
    </button>
  )
}
