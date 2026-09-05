/**
 * The player's log, kept as well as printed: the failure report copies the
 * last lines out, so a report from someone else's browser carries what the
 * player saw before it gave up, not just the room and the codecs.
 */
const KEEP = 80
const lines: string[] = []

export function plog(level: 'info' | 'warn' | 'error', ...parts: unknown[]): void {
  console[level]('[ss-player]', ...parts)
  const text = parts.map((part) => (typeof part === 'string' ? part : String(part))).join(' ')
  lines.push(`${new Date().toISOString()} ${level} ${text}`)
  if (lines.length > KEEP) lines.splice(0, lines.length - KEEP)
}

export function recentPlayerLog(): string[] {
  return [...lines]
}
