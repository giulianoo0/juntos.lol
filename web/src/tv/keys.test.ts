import { describe, expect, it, vi } from 'vitest'
import { exitTvApp, registerTvKeys, shellPlatform, tvKeyAction, type TvKeyAction } from './keys'

const press = (key: string, keyCode = 0) => ({ key, keyCode })

describe('tvKeyAction', () => {
  it.each<[string, { key: string; keyCode: number }, TvKeyAction]>([
    ['seta para cima', press('ArrowUp', 38), 'up'],
    ['seta para baixo', press('ArrowDown', 40), 'down'],
    ['seta para a esquerda', press('ArrowLeft', 37), 'left'],
    ['seta para a direita', press('ArrowRight', 39), 'right'],
    ['OK do controle', press('Enter', 13), 'enter'],
    ['Voltar do Tizen', press('XF86Back', 10009), 'back'],
    ['Voltar do webOS', press('GoBack', 461), 'back'],
    ['Escape no navegador', press('Escape', 27), 'back'],
    ['Backspace no navegador', press('Backspace', 8), 'back'],
    ['play/pause do Tizen', press('MediaPlayPause', 10252), 'playPause'],
    ['play/pause sem código', press('MediaPlayPause'), 'playPause'],
    ['play', press('MediaPlay', 415), 'play'],
    ['pause', press('MediaPause', 19), 'pause'],
    ['avançar', press('MediaFastForward', 417), 'forward'],
    ['voltar na mídia', press('MediaRewind', 412), 'rewind'],
    ['tecla vermelha', press('ColorF0Red', 403), 'menu'],
    ['menu de contexto', press('ContextMenu', 93), 'menu'],
    ['info do controle', press('Info', 457), 'menu'],
  ])('%s', (_, event, action) => {
    expect(tvKeyAction(event)).toBe(action)
  })

  it('deixa passar o que não é do controle', () => {
    expect(tvKeyAction(press('a', 65))).toBeNull()
  })
})

describe('registerTvKeys', () => {
  it('pede ao Tizen as teclas de mídia e a vermelha', () => {
    const registerKey = vi.fn()
    registerTvKeys({ tizen: { tvinputdevice: { registerKey } } })
    expect(registerKey.mock.calls.map(([name]) => name)).toEqual(
      expect.arrayContaining(['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaFastForward', 'MediaRewind', 'ColorF0Red']),
    )
  })

  it('segue quando o Tizen recusa uma tecla ou nem existe', () => {
    const registerKey = vi.fn((name: string) => { if (name === 'MediaPlay') throw new Error('unsupported') })
    expect(() => registerTvKeys({ tizen: { tvinputdevice: { registerKey } } })).not.toThrow()
    expect(registerKey).toHaveBeenCalledWith('MediaRewind')
    expect(() => registerTvKeys({})).not.toThrow()
  })
})

describe('exitTvApp', () => {
  it('fecha pelo Tizen quando ele existe', () => {
    const exit = vi.fn()
    const close = vi.fn()
    exitTvApp({ tizen: { application: { getCurrentApplication: () => ({ exit }) } }, close })
    expect(exit).toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('dentro da casca do Samsung, pede a ela para sair', () => {
    const postMessage = vi.fn()
    const close = vi.fn()
    exitTvApp({ close, parent: { postMessage } }, 'tizen')
    expect(postMessage).toHaveBeenCalledWith({ type: 'juntos-tv:exit' }, '*')
    expect(close).not.toHaveBeenCalled()
  })

  it('no webOS e no navegador fecha a janela', () => {
    const close = vi.fn()
    exitTvApp({ close }, 'webos')
    expect(close).toHaveBeenCalled()
  })
})

describe('shellPlatform', () => {
  it('a casca diz a plataforma; sem ela, o navegador a revela', () => {
    expect(shellPlatform({ type: 'juntos-tv:shell', platform: 'tizen', keys: [] }, '')).toBe('tizen')
    expect(shellPlatform(null, 'Mozilla/5.0 (Web0S; Linux/SmartTV) Chrome/94')).toBe('webos')
    expect(shellPlatform(null, 'Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) Chrome/94')).toBe('tizen')
    expect(shellPlatform(null, 'Mozilla/5.0 (Macintosh) Chrome/140')).toBe('browser')
    expect(shellPlatform({ type: 'outra coisa' }, 'Mozilla/5.0 (Macintosh)')).toBe('browser')
  })
})
