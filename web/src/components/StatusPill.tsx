interface StatusPillProps {
  status: 'connecting' | 'live' | 'buffering' | 'processing'
  label: string
}

/**
 * The room's connection, as a word.
 *
 * It used to carry a coloured dot as well, which said exactly what the colour
 * of the word already said. What a wait actually needs is a sign that anything
 * is still happening, and that lives in the word itself: connecting shimmers,
 * everything settled simply holds its colour.
 */
export function StatusPill({ status, label }: StatusPillProps) {
  return <span className={`status-pill status-${status}`}>{label}</span>
}
