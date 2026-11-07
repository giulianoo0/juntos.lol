import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionFrame } from './ExtensionFrame'
import type { ExtensionManifest } from './protocol'

const manifest: ExtensionManifest = {
  id: 'exemplo', name: 'Exemplo', version: '1.0.0', protocol: 1, entry: 'index.html',
  hosts: { connect: [], images: [], media: ['*.cdn-exemplo.net'] },
}
const extension = { id: 'exemplo', sub: 'lczfxd2q74zxknb5', version: 'f'.repeat(40), manifest }
const place = { base: 'santamagia.com', scheme: 'https' as const }
const origin = 'https://lczfxd2q74zxknb5.santamagia.com'
const play = { juntos: 1, type: 'play', title: 'Emma', ref: '15228', source: { kind: 'hls', url: 'https://sa-east-1.cdn-exemplo.net/a.m3u8' } }

function mount(onMessage = vi.fn()) {
  const view = render(<ExtensionFrame extension={extension} place={place} canPlay onMessage={onMessage} />)
  const frame = view.container.querySelector('iframe')!
  return { frame, onMessage }
}

const post = (data: unknown, init: { origin?: string; source?: MessageEventSource | null }) => act(() => {
  window.dispatchEvent(new MessageEvent('message', { data, origin: init.origin ?? origin, source: init.source ?? null }))
})

afterEach(() => { vi.restoreAllMocks() })

describe('iframe da extensão', () => {
  it('carrega a versão aprovada na origem da extensão, isolada', () => {
    const { frame } = mount()

    expect(frame).toHaveAttribute('src', `${origin}/@${'f'.repeat(40)}/index.html`)
    expect(frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups')
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(frame).toHaveAttribute('allow', '')
    expect(frame.getAttribute('sandbox')).not.toContain('top-navigation')
  })

  it('repassa a mensagem válida que vem do próprio iframe', () => {
    const { frame, onMessage } = mount()

    post(play, { source: frame.contentWindow })

    expect(onMessage).toHaveBeenCalledWith(play)
  })

  it('ignora mensagem de outra origem', () => {
    const { frame, onMessage } = mount()

    post(play, { origin: 'https://evil.santamagia.com', source: frame.contentWindow })

    expect(onMessage).not.toHaveBeenCalled()
  })

  it('ignora mensagem com a origem certa vinda de outra janela', () => {
    const { onMessage } = mount()

    post(play, { source: window })

    expect(onMessage).not.toHaveBeenCalled()
  })

  it('ignora mensagem que não passa no protocolo', () => {
    const { frame, onMessage } = mount()

    post({ ...play, source: { kind: 'hls', url: 'javascript:alert(1)' } }, { source: frame.contentWindow })

    expect(onMessage).not.toHaveBeenCalled()
  })

  it('responde ready com init só para a origem da extensão', () => {
    const { frame } = mount()
    const sent = vi.spyOn(frame.contentWindow!, 'postMessage')

    post({ juntos: 1, type: 'ready' }, { source: frame.contentWindow })

    expect(sent).toHaveBeenCalledWith(
      expect.objectContaining({ juntos: 1, type: 'init', canPlay: true, locale: expect.any(String), theme: expect.objectContaining({ mode: expect.any(String) }) }),
      origin,
    )
  })
})
