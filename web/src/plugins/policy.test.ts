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

  it('refuses the application own host on any port, not just the default one', () => {
    // origin carries the port and the allowlist does not. Comparing origins
    // would leave every other port on our own machine reachable.
    expect(deny('https://ss.giuli.dev:8443/api/rooms', ['ss.giuli.dev'])).toBe('self-origin')
    expect(deny('https://ss.giuli.dev:443/api/rooms', ['ss.giuli.dev'])).toBe('self-origin')
  })

  it('treats a trailing dot as the same host it is to DNS', () => {
    expect(deny('https://ss.giuli.dev./api/rooms', ['ss.giuli.dev'])).toBe('self-origin')
    expect(deny('https://localhost./x', ['localhost'])).toBe('private-host')
    // And the benign half: the declared host spelled the other way is allowed.
    expect(checkFetchUrl('https://torrentio.strem.fun./x', hosts, self).ok).toBe(true)
  })

  it('refuses every spelling of a literal address', () => {
    // The URL parser canonicalises all of these to 127.0.0.1 or 0.0.0.0
    // before the regex sees them. The test is here so that a rewrite which
    // parses by hand cannot quietly lose that.
    for (const url of [
      'https://0x7f.0.0.1/', 'https://2130706433/', 'https://127.1/',
      'https://0177.0.0.1/', 'https://0/', 'https://[::ffff:127.0.0.1]/',
      'https://0xc0.0xa8.0.1/',
    ]) {
      expect(deny(url, ['x.y'])).toBe('private-host')
    }
  })

  it('is not fooled by case in the origin it is told to protect', () => {
    expect(checkFetchUrl('https://ss.giuli.dev/api', ['ss.giuli.dev'], 'HTTPS://SS.GIULI.DEV')).toEqual({
      ok: false, reason: 'self-origin',
    })
  })

  it('refuses a host that only looks like the declared one because of userinfo', () => {
    expect(deny('https://torrentio.strem.fun@evil.com/x')).toBe('host-not-declared')
  })

  it('strips credentials before handing the url over', () => {
    // The page performs this fetch, and a userinfo pair becomes an
    // Authorization header the plugin was never granted.
    const result = checkFetchUrl('https://user:pass@torrentio.strem.fun/x', hosts, self)
    expect(result.ok && result.url.href).toBe('https://torrentio.strem.fun/x')
  })

  it('fails closed when it cannot tell what its own origin is', () => {
    const result = checkFetchUrl('https://torrentio.strem.fun/x', hosts, 'not an origin')
    expect(result).toEqual({ ok: false, reason: 'self-origin' })
  })

  it('refuses a value that is not a URL at all', () => {
    expect(deny('not a url')).toBe('invalid')
  })
})
