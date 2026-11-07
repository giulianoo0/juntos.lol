import { describe, expect, it } from 'vitest'
import { extensionPlace } from './publicConfig'

const ids = { turnstileSiteKey: '', discordAppId: '' }

describe('extensionPlace', () => {
  it('leva a origem dos repositórios junto com o lugar das extensões', () => {
    expect(extensionPlace({ ...ids, extensionBase: 'localhost:8787', extensionScheme: 'http', extensionRaw: 'http://127.0.0.1:8797' }))
      .toEqual({ base: 'localhost:8787', scheme: 'http', raw: 'http://127.0.0.1:8797' })
  })

  it('aceita origem com caminho, como um servidor local em /raw', () => {
    expect(extensionPlace({ ...ids, extensionBase: 'localhost:8787', extensionScheme: 'http', extensionRaw: 'http://127.0.0.1:9000/raw' })?.raw).toBe('http://127.0.0.1:9000/raw')
  })

  it.each(['javascript:alert(1)', 'https://a.com/x?y', 'https://a.com?x', 'https://a.com/../x', ''])('ignora a origem %j', (raw) => {
    expect(extensionPlace({ ...ids, extensionBase: 'santamagia.com', extensionScheme: 'https', extensionRaw: raw }))
      .toEqual({ base: 'santamagia.com', scheme: 'https' })
  })

  it('sem base ou com esquema estranho fica com o de produção', () => {
    expect(extensionPlace({ ...ids, extensionScheme: 'https' })).toBeUndefined()
    expect(extensionPlace({ ...ids, extensionBase: 'santamagia.com', extensionScheme: 'ftp' })).toBeUndefined()
  })
})
