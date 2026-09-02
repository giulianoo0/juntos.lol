interface StatusPillProps {
  status: 'connecting' | 'live' | 'buffering' | 'processing'
  label: string
}

export function StatusPill({ status, label }: StatusPillProps) {
  return <span className={`status-pill status-${status}`}>{label}</span>
}
