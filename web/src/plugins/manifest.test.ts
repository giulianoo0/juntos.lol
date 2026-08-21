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

  it('rejects a host longer than a hostname can be', () => {
    expect(() => parseManifest({ ...valid, hosts: [`${'a'.repeat(250)}.com`] })).toThrow(/hosts/)
  })

  it('rejects a single-label host, which could only be something on the local network', () => {
    expect(() => parseManifest({ ...valid, hosts: ['intranet'] })).toThrow(/hosts/)
  })

  it('rejects a non-https updateUrl', () => {
    expect(() => parseManifest({ ...valid, updateUrl: 'http://github.com/u/r' })).toThrow(/updateUrl/)
  })

  it('rejects missing fields and non-objects', () => {
    expect(() => parseManifest({ ...valid, name: undefined })).toThrow(/name/)
    expect(() => parseManifest(null)).toThrow(/manifest/)
    expect(() => parseManifest('nope')).toThrow(/manifest/)
  })
})
