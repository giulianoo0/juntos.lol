const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

export async function subFor(id: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`juntos-ext:${id}`)))
  let out = ''
  let bits = 0
  let value = 0
  for (const byte of digest) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5 && out.length < 16) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
    if (out.length === 16) break
  }
  return out
}
