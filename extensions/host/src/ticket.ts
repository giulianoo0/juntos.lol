// The other half of internal/extension/ticket.go: a ticket lets one url
// through the media proxy until it expires. The proxy signs the segments of
// a playlist it rewrites with the playlist's own expiry.

const enc = new TextEncoder()

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

function b64url(bytes: ArrayBuffer): string {
  let bin = ''
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(text)) return null
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

const message = (sub: string, exp: string, url: string) => enc.encode(`juntos-media/1\n${sub}\n${exp}\n${url}`)

export async function signTicket(secret: string, sub: string, url: string, expUnix: number): Promise<string> {
  const exp = String(expUnix)
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), message(sub, exp, url))
  return `${exp}.${b64url(mac)}`
}

/** The ticket's expiry in unix seconds when it holds for `url`, null otherwise. */
export async function checkTicket(secret: string, sub: string, url: string, ticket: string | null, nowMs: number): Promise<number | null> {
  if (!secret || !ticket) return null
  const m = /^(\d{1,12})\.(.+)$/.exec(ticket)
  if (!m) return null
  const exp = Number(m[1])
  if (exp * 1000 <= nowMs) return null
  const mac = fromB64url(m[2])
  if (!mac) return null
  return await crypto.subtle.verify('HMAC', await hmacKey(secret), mac, message(sub, m[1], url)) ? exp : null
}
