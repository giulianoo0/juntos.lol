import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshSource } from './bridge'
import type { ExtensionManifest } from './protocol'

const manifest: ExtensionManifest = {
  id: 'exemplo', name: 'Exemplo', version: '1.0.0', protocol: 1, entry: 'index.html',
  hosts: { connect: [], images: [], media: ['*.cdn-exemplo.net'] },
}
const extension = { id: 'exemplo', sub: 'lczfxd2q74zxknb5', version: 'f'.repeat(40), manifest }
const place = { base: 'santamagia.com', scheme: 'https' as const }
const origin = 'https://lczfxd2q74zxknb5.santamagia.com'
const fresh = { kind: 'hls', url: 'https://sa-east-1.cdn-exemplo.net/new.m3u8' }

const frame = () => document.querySelector('iframe')!
const fromFrame = (data: unknown) => {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source: frame().contentWindow }))
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('pedir a fonte de novo à extensão', () => {
  it('abre a extensão escondida, pede refresh e devolve a fonte nova', async () => {
    const asking = refreshSource(extension, place, '15228')
    const sent = vi.spyOn(frame().contentWindow!, 'postMessage')
    expect(frame()).not.toBeVisible()

    fromFrame({ juntos: 1, type: 'ready' })
    const refresh = sent.mock.calls.map(([message]) => message as { type: string; nonce?: string; ref?: string }).find((message) => message.type === 'refresh')
    expect(refresh).toMatchObject({ juntos: 1, ref: '15228', nonce: expect.any(String) })
    expect(sent).toHaveBeenCalledWith(expect.objectContaining({ type: 'refresh' }), origin)

    fromFrame({ juntos: 1, type: 'refreshed', nonce: 'other', source: { kind: 'hls', url: 'https://sa-east-1.cdn-exemplo.net/old.m3u8' } })
    fromFrame({ juntos: 1, type: 'refreshed', nonce: refresh!.nonce, source: fresh })

    expect(await asking).toEqual(fresh)
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('desiste em 20 s sem resposta e tira o iframe', async () => {
    vi.useFakeTimers()
    const asking = refreshSource(extension, place, '15228')

    await vi.advanceTimersByTimeAsync(20_000)

    expect(await asking).toBeNull()
    expect(document.querySelector('iframe')).toBeNull()
  })

  it('devolve nada quando a extensão diz que não tem a fonte', async () => {
    const asking = refreshSource(extension, place, '15228')
    const sent = vi.spyOn(frame().contentWindow!, 'postMessage')
    fromFrame({ juntos: 1, type: 'ready' })
    const nonce = (sent.mock.calls.map(([message]) => message as { type: string; nonce: string }).find((message) => message.type === 'refresh'))!.nonce

    fromFrame({ juntos: 1, type: 'refreshed', nonce, source: null })

    expect(await asking).toBeNull()
  })
})
