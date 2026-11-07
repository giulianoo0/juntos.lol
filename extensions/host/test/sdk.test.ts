// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installJuntos } from '../src/sdk'

const ORIGINS = ['https://juntos.lol', 'http://localhost:5173']
const theme = { mode: 'light' as const, vars: { '--bg': '#fff', '--accent': 'rgb(1 2 3)' } }
const init = { juntos: 1, type: 'init', theme, locale: 'pt-BR', canPlay: true }

function setup(ancestor?: string) {
  const posted: { data: unknown; origin: string }[] = []
  const parent = { postMessage: (data: unknown, origin: string) => posted.push({ data, origin }) }
  const target = new EventTarget()
  const win = {
    parent,
    document,
    location: { ancestorOrigins: ancestor ? [ancestor] : [] },
    addEventListener: target.addEventListener.bind(target),
  }
  const sdk = installJuntos(win as never, ORIGINS)
  const send = (data: unknown, origin = 'https://juntos.lol', source: unknown = parent) =>
    target.dispatchEvent(Object.assign(new Event('message'), { data, origin, source }))
  return { sdk, send, posted, parent }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  document.documentElement.removeAttribute('style')
  document.documentElement.removeAttribute('data-theme')
})

describe('SDK', () => {
  it('recebe o init do juntos e aplica o tema no :root', () => {
    const { sdk, send } = setup()
    const cb = vi.fn()
    sdk.onInit(cb)
    send(init)
    expect(cb).toHaveBeenCalledWith(init)
    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#fff')
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('entrega o init a quem se inscreve depois', () => {
    const { sdk, send } = setup()
    send(init)
    const cb = vi.fn()
    sdk.onInit(cb)
    expect(cb).toHaveBeenCalledWith(init)
  })

  it('ignora mensagem de origem fora da lista', () => {
    const { sdk, send } = setup()
    const cb = vi.fn()
    sdk.onInit(cb)
    send(init, 'https://evil.com')
    expect(cb).not.toHaveBeenCalled()
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })

  it('ignora mensagem que não vem do parent', () => {
    const { sdk, send } = setup()
    const cb = vi.fn()
    sdk.onInit(cb)
    send(init, 'https://juntos.lol', {})
    expect(cb).not.toHaveBeenCalled()
  })

  it('ignora versão de protocolo diferente e formato errado', () => {
    const { sdk, send } = setup()
    const cb = vi.fn()
    sdk.onInit(cb)
    send({ ...init, juntos: 2 })
    send('init')
    send({ ...init, theme: { mode: 'roxo', vars: {} } })
    expect(cb).not.toHaveBeenCalled()
  })

  it('não aplica variáveis de tema hostis', () => {
    const { send } = setup()
    send({
      ...init,
      theme: { mode: 'dark', vars: { '--ok': 'red', color: 'blue', '--x;y': 'red', '--bad': 'red;}body{', '--long': 'a'.repeat(65) } },
    })
    const s = document.documentElement.style
    expect(s.getPropertyValue('--ok')).toBe('red')
    expect(s.getPropertyValue('color')).toBe('')
    expect(s.getPropertyValue('--bad')).toBe('')
    expect(s.getPropertyValue('--long')).toBe('')
  })

  it('onTheme recebe o tema novo', () => {
    const { sdk, send } = setup()
    const cb = vi.fn()
    sdk.onTheme(cb)
    send({ juntos: 1, type: 'theme', theme: { mode: 'dark', vars: {} } })
    expect(cb).toHaveBeenCalledWith({ mode: 'dark', vars: {} })
    expect(document.documentElement.dataset.theme).toBe('dark')
  })

  it('antes do init manda para a origem do ancestral se estiver na lista', () => {
    const { sdk, posted } = setup('http://localhost:5173')
    sdk.ready()
    expect(posted).toEqual([{ data: { juntos: 1, type: 'ready' }, origin: 'http://localhost:5173' }])
  })

  it('sem ancestral conhecido, tenta cada origem da lista', () => {
    const { sdk, posted } = setup()
    sdk.ready()
    expect(posted.map((p) => p.origin)).toEqual(ORIGINS)
  })

  it('depois do init fala só com a origem que mandou o init', () => {
    const { sdk, send, posted } = setup()
    send(init, 'http://localhost:5173')
    const source = { kind: 'hls' as const, url: 'https://a.cdn.exemplo.dev/p.m3u8' }
    sdk.play({ title: 'Ep', ref: '15228', source })
    sdk.toast('oi')
    sdk.close()
    expect(posted).toEqual([
      { data: { juntos: 1, type: 'play', title: 'Ep', ref: '15228', source }, origin: 'http://localhost:5173' },
      { data: { juntos: 1, type: 'toast', text: 'oi' }, origin: 'http://localhost:5173' },
      { data: { juntos: 1, type: 'close' }, origin: 'http://localhost:5173' },
    ])
  })

  it('responde refresh com a fonte nova', async () => {
    const { sdk, send, posted } = setup()
    send(init)
    const source = { kind: 'hls' as const, url: 'https://a.cdn.exemplo.dev/p.m3u8' }
    const cb = vi.fn(async () => source)
    sdk.onRefresh(cb)
    send({ juntos: 1, type: 'refresh', nonce: 'n1', ref: '15228' })
    await flush()
    expect(cb).toHaveBeenCalledWith('15228')
    expect(posted).toContainEqual({ data: { juntos: 1, type: 'refreshed', nonce: 'n1', source }, origin: 'https://juntos.lol' })
  })

  it('refresh que falha responde fonte nula', async () => {
    const { sdk, send, posted } = setup()
    send(init)
    sdk.onRefresh(async () => {
      throw new Error('x')
    })
    send({ juntos: 1, type: 'refresh', nonce: 'n2', ref: '1' })
    await flush()
    expect(posted).toContainEqual({ data: { juntos: 1, type: 'refreshed', nonce: 'n2', source: null }, origin: 'https://juntos.lol' })
  })
})
