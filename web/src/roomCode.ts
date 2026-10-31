/**
 * Reads a room code out of a pasted url, a scheme-less juntos.lol/room/XXXX or
 * the bare code. Codes are capitals and digits, so lowercase is raised safely
 * and anything else left over means it was not a code.
 */
const CODE = /^[A-Z0-9]{8}$/

export function roomCodeFrom(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const withoutQuery = trimmed.split(/[?#]/)[0]
  const segments = withoutQuery.split('/').filter(Boolean)
  const last = segments[segments.length - 1] ?? ''
  const candidate = last.toUpperCase()
  return CODE.test(candidate) ? candidate : null
}
