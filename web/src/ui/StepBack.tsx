import { ChevronLeft } from 'lucide-react'

export function StepBack({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="stage-back" aria-label={label} title={label} onClick={onClick}>
      <ChevronLeft size={17} aria-hidden="true" />
    </button>
  )
}
