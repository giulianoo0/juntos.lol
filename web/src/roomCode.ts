/**
 * Reading a room code out of whatever someone pasted.
 *
 * A link travels through chats that shorten it, mail that wraps it and phone
 * screens that turn it back into plain text, so what arrives is sometimes the
 * whole url, sometimes juntos.lol/room/XXXX with no scheme, and sometimes just
 * the code. All three name the same room and all three are accepted.
 *
 * Codes are capitals and digits, which is also what makes the lenient part
 * safe: lowercase can be raised without ambiguity, and anything left that is
 * not in the alphabet means this was not a room code at all.
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
