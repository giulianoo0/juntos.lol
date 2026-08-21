import { describe, expect, it } from 'vitest'
import { parseManifest } from './manifest'

const valid = { id: 'torrentio', name: 'Torrentio', version: '1.0.0', hosts: ['torrentio.strem.fun'] }

describe('parseManifest', () => {
  it('accepts the minimum valid manifest and defaults updateUrl to null', () => {
    expect(parseManifest(valid)).toEqual({ ...valid, updateUrl: null })
  })

  it('keeps an https updateUrl', () => {
    const parsed = parseManifest({ ...valid, updateUrl: 'https://github.com/user/repo' })
    expect(parsed.updateUrl).toBe('https://github.com/user/repo')
  })

  it('rejects an id outside the allowed shape', () => {
    expect(() => parseManifest({ ...valid, id: 'Torrentio!' })).toThrow(/id/)
    expect(() => parseManifest({ ...valid, id: '' })).toThrow(/id/)
  })

  it('rejects an empty host list', () => {
    expect(() => parseManifest({ ...valid, hosts: [] })).toThrow(/hosts/)
  })

  it('rejects hosts carrying a scheme, a path or a port', () => {
    expect(() => parseManifest({ ...valid, hosts: ['https://a.com'] })).toThrow(/hosts/)
    expect(() => parseManifest({ ...valid, hosts: ['a.com/x'] })).toThrow(/hosts/)
    expect(() => parseManifest({ ...valid, hosts: ['a.com:8080'] })).toThrow(/hosts/)
  })

  it('rejects a host longer than a hostname can be, at the exact boundary', () => {
    const label = () => 'a'.repeat(63)
    const at253 = `${label()}.${label()}.${label()}.${'a'.repeat(61)}`
    expect(at253).toHaveLength(253)
    expect(parseManifest({ ...valid, hosts: [at253] }).hosts).toEqual([at253])
    expect(() => parseManifest({ ...valid, hosts: [`${at253}a`] })).toThrow(/hosts/)
  })

  it('rejects a label longer than DNS allows, which would never resolve', () => {
    expect(() => parseManifest({ ...valid, hosts: [`${'a'.repeat(64)}.com`] })).toThrow(/hosts/)
  })

  it('rejects an address wearing a hostname shape', () => {
    // The policy compares hostnames by equality and refuses literals, so an
    // address here is either dead on arrival or a hole. Neither should reach
    // the consent screen looking like a name.
    for (const host of ['1.2.3.4', '127.1', '0x7f.0x1', '1.2.3.04', '2130706433']) {
      expect(() => parseManifest({ ...valid, hosts: [host] })).toThrow(/hosts/)
    }
  })

  it('rejects a host the url parser would rewrite, because it could never match', () => {
    expect(() => parseManifest({ ...valid, hosts: ['a.com.'] })).toThrow(/hosts/)
  })

  it('lowercases hosts, which is what the exact-equality match depends on', () => {
    expect(parseManifest({ ...valid, hosts: ['TORRENTIO.Strem.FUN'] }).hosts).toEqual(['torrentio.strem.fun'])
  })

  it('collapses a repeated host instead of listing it twice', () => {
    expect(parseManifest({ ...valid, hosts: ['a.com', 'a.com'] }).hosts).toEqual(['a.com'])
  })

  it('caps how many hosts one plugin may ask for, and says so', () => {
    const many = Array.from({ length: 17 }, (_, index) => `h${index}.com`)
    expect(() => parseManifest({ ...valid, hosts: many })).toThrow(/at most 16/)
  })

  it('rejects entries that are not strings at all', () => {
    for (const hosts of [[null], [42], [{}], [['a.com']]]) {
      expect(() => parseManifest({ ...valid, hosts })).toThrow(/hosts/)
    }
  })

  it('rejects the holes of a sparse array rather than passing undefined through', () => {
    // Array.prototype.map skips holes, so a sparse list used to come back as
    // `[null, null]` — a hosts: string[] that is not one.
    expect(() => parseManifest({ ...valid, hosts: new Array<string>(3) })).toThrow(/hosts/)
  })

  it('validates the list it read, not one swapped in between reads', () => {
    const hostile = ['ok.com']
    Object.defineProperty(hostile, 'map', { value: () => ['evil.com'] })
    expect(parseManifest({ ...valid, hosts: hostile }).hosts).toEqual(['ok.com'])
  })

  it('rejects a single-label host, which could only be something on the local network', () => {
    expect(() => parseManifest({ ...valid, hosts: ['intranet'] })).toThrow(/hosts/)
  })

  it('rejects a non-https updateUrl', () => {
    for (const updateUrl of [
      'http://github.com/u/r', 'javascript:alert(1)', 'data:text/plain,x', 'file:///etc/passwd',
    ]) {
      expect(() => parseManifest({ ...valid, updateUrl })).toThrow(/updateUrl/)
    }
  })

  it('accepts an explicit null updateUrl the same as an absent one', () => {
    expect(parseManifest({ ...valid, updateUrl: null }).updateUrl).toBeNull()
  })

  it('stores one spelling of updateUrl, because it is the plugin identity', () => {
    // The registry key is a hash of this string and an update declaring a
    // different one is refused. Two spellings of one repository must not
    // become two plugins.
    for (const written of [
      'https://github.com/user/repo',
      'https://github.com/user/repo/',
      'HTTPS://GitHub.COM/user/repo',
      'https://github.com/user/repo#readme',
    ]) {
      expect(parseManifest({ ...valid, updateUrl: written }).updateUrl).toBe('https://github.com/user/repo')
    }
  })

  it('rejects credentials in updateUrl, which the auto-update would send unattended', () => {
    expect(() => parseManifest({ ...valid, updateUrl: 'https://user:pw@github.com/u/r' })).toThrow(/credentials/)
  })

  it('rejects a name carrying control characters, which could reorder the consent screen', () => {
    expect(() => parseManifest({ ...valid, name: 'Torrentio\u202E' })).toThrow(/name/)
  })

  it('caps the length of the fields it only ever displays', () => {
    expect(() => parseManifest({ ...valid, name: 'a'.repeat(65) })).toThrow(/name/)
    expect(() => parseManifest({ ...valid, version: 'a'.repeat(33) })).toThrow(/version/)
  })

  it('rejects missing fields and non-objects', () => {
    expect(() => parseManifest({ ...valid, name: undefined })).toThrow(/name/)
    expect(() => parseManifest(null)).toThrow(/manifest/)
    expect(() => parseManifest('nope')).toThrow(/manifest/)
  })
})
