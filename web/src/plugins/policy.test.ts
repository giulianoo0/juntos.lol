import { describe, expect, it } from 'vitest'
import { checkFetchUrl } from './policy'

const hosts = ['streams.example.com']
const self = 'https://ss.giuli.dev'

const deny = (url: string, declared: string[] = hosts) => {
  const result = checkFetchUrl(url, declared, self)
  if (result.ok) throw new Error(`expected ${url} to be denied`)
  return result.reason
}

describe('checkFetchUrl', () => {
  it('allows a declared host over https', () => {
    const result = checkFetchUrl('https://streams.example.com/stream/movie/tt1.json', hosts, self)
    expect(result.ok).toBe(true)
  })

  it('matches the host exactly, so a subdomain is not covered', () => {
    expect(deny('https://evil.streams.example.com/x')).toBe('host-not-declared')
    expect(deny('https://streams.example.com.evil.com/x')).toBe('host-not-declared')
  })

  it('refuses anything that is not https', () => {
    expect(deny('http://streams.example.com/x')).toBe('scheme')
    expect(deny('data:text/plain,hi')).toBe('scheme')
    expect(deny('file:///etc/passwd')).toBe('scheme')
    expect(deny('blob:https://streams.example.com/abc')).toBe('scheme')
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
    expect(deny('https://93.184.216.34/x', ['93.184.216.34'])).toBe('private-host')
  })

  it('refuses the application own host on any port, not just the default one', () => {
    expect(deny('https://ss.giuli.dev:8443/api/rooms', ['ss.giuli.dev'])).toBe('self-origin')
    expect(deny('https://ss.giuli.dev:443/api/rooms', ['ss.giuli.dev'])).toBe('self-origin')
  })

  it('treats a trailing dot as the same host it is to DNS', () => {
    expect(deny('https://ss.giuli.dev./api/rooms', ['ss.giuli.dev'])).toBe('self-origin')
    expect(deny('https://localhost./x', ['localhost'])).toBe('private-host')
    expect(checkFetchUrl('https://streams.example.com./x', hosts, self).ok).toBe(true)
  })

  it('refuses every spelling of a literal address', () => {
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
    expect(deny('https://streams.example.com@evil.com/x')).toBe('host-not-declared')
  })

  it('strips credentials before handing the url over', () => {
    const result = checkFetchUrl('https://user:pass@streams.example.com/x', hosts, self)
    expect(result.ok && result.url.href).toBe('https://streams.example.com/x')
  })

  it('fails closed when it cannot tell what its own origin is', () => {
    const result = checkFetchUrl('https://streams.example.com/x', hosts, 'not an origin')
    expect(result).toEqual({ ok: false, reason: 'self-origin' })
  })

  it('refuses a value that is not a URL at all', () => {
    expect(deny('not a url')).toBe('invalid')
  })
})
