import { describe, expect, it, vi } from 'vitest'
import { extensionRelay } from './relay'

const place = { base: 'ext.example', scheme: 'https' as const }

describe('extensionRelay', () => {
  it('pede ao juntos um ticket para a url e lê pelo proxy da extensão com ele', async () => {
    const get = vi.fn(async () => Response.json({ ticket: '1794100000.abc' }))
    const relay = extensionRelay('abcdefghijklmnop', place, get)

    const url = await relay.via('https://cdn.example.com/a b.mp4')

    expect(get).toHaveBeenCalledWith('/api/extensions/media-ticket', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ sub: 'abcdefghijklmnop', url: 'https://cdn.example.com/a b.mp4' }),
    }))
    expect(url).toBe(`https://abcdefghijklmnop.ext.example/_juntos/media?u=${encodeURIComponent('https://cdn.example.com/a b.mp4')}&t=1794100000.abc`)
    expect(relay.owns(url)).toBe(true)
    expect(relay.owns('https://cdn.example.com/a.mp4')).toBe(false)
  })

  it('falha quando o juntos recusa o ticket', async () => {
    const relay = extensionRelay('abcdefghijklmnop', place, async () => Response.json({ error: 'human_required' }, { status: 403 }))
    await expect(relay.via('https://cdn.example.com/a.mp4')).rejects.toThrow('403')
  })
})
