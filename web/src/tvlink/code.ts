/**
 * The TV's pairing code: 8 capitals and digits, shown `ABCD-EFGH`. The TV's
 * QR holds `https://juntos.lol/tv/vincular?c=CODE`, so any camera reaches
 * the same page that links it.
 */
const CODE = /^[A-Z0-9]{8}$/

/** The bare code out of what was typed (with or without the hyphen, any case); null when it is not one. */
export function linkCodeFrom(input: string): string | null {
  const candidate = input.trim().toUpperCase().replace('-', '')
  return CODE.test(candidate) ? candidate : null
}

/** What the field shows while typing: capitals and digits only, the hyphen after the fourth. */
export function formatCodeInput(typed: string): string {
  const raw = typed.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw
}

/** The code a scanned QR carries: the `c` of a /tv/vincular link, or a bare code. */
export function codeFromQr(text: string): string | null {
  const trimmed = text.trim()
  let url: URL | null = null
  try { url = new URL(trimmed) } catch { return linkCodeFrom(trimmed) }
  if (url.pathname.replace(/\/$/, '') !== '/tv/vincular') return null
  return linkCodeFrom(url.searchParams.get('c') ?? '')
}
