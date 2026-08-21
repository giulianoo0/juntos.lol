import { describe, expect, it } from 'vitest'
import { checkFetchUrl } from './policy'

const hosts = ['torrentio.strem.fun']
const self = 'https://ss.giuli.dev'

const deny = (url: string, declared: string[] = hosts) => {
  const result = checkFetchUrl(url, declared, self)
  if (result.ok) throw new Error(`expected ${url} to be denied`)
  return result.reason
}

describe('checkFetchUrl', () => {
  it('allows a declared host over https', () => {
    const result = checkFetchUrl('https://torrentio.strem.fun/stream/movie/tt1.json', hosts, self)
    expect(result.ok).toBe(true)
  })

  it('matches the host exactly, so a subdomain is not covered', () => {
    expect(deny('https://evil.torrentio.strem.fun/x')).toBe('host-not-declared')
    expect(deny('https://torrentio.strem.fun.evil.com/x')).toBe('host-not-declared')
  })

  it('refuses anything that is not https', () => {
    expect(deny('http://torrentio.strem.fun/x')).toBe('scheme')
    expect(deny('data:text/plain,hi')).toBe('scheme')
    expect(deny('file:///etc/passwd')).toBe('scheme')
    expect(deny('blob:https://torrentio.strem.fun/abc')).toBe('scheme')
  })

  it('refuses the application own origin even if someone declares it', () => {
    expect(checkFetchUrl('https://ss.giuli.dev/api/rooms', ['ss.giuli.dev'], self)).toEqual({
      ok: false, reason: 'self-origin',
    })
  })

  it('refuses loopback and literal addresses', () => {
    expect(deny('https://localhost/x')).toBe('private-host')
    expect(deny('https://127.0.0.1/x')).toBe('private-host')
    expect(deny('https://[::1]/x')).toBe('private-host')
    expect(deny('https://192.168.0.1/x')).toBe('private-host')
  })

  it('refuses a literal address even when it is a public one and was declared', () => {
    // An addon lives at a name. A plugin asking for a bare address is either
    // probing or being clever, and neither is worth allowing.
    expect(deny('https://93.184.216.34/x', ['93.184.216.34'])).toBe('private-host')
  })

  it('refuses a trailing dot, which is the same host to DNS and a different string here', () => {
    expect(deny('https://torrentio.strem.fun./x')).toBe('host-not-declared')
  })

  it('is not fooled by case, since a declared host is stored lowercase', () => {
    expect(checkFetchUrl('https://TORRENTIO.STREM.FUN/x', hosts, self).ok).toBe(true)
  })

  it('refuses credentials embedded in the url', () => {
    // https://torrentio.strem.fun@evil.com/ reads as the declared host and
    // resolves to evil.com. The URL parser gets this right, and this test is
    // here so a future rewrite that parses by hand cannot get it wrong.
    expect(deny('https://torrentio.strem.fun@evil.com/x')).toBe('host-not-declared')
  })

  it('refuses a value that is not a URL at all', () => {
    expect(deny('not a url')).toBe('invalid')
  })
})
