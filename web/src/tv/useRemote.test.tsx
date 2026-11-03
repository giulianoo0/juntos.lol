import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRemote } from './useRemote'

const press = (key: string, keyCode = 0, target: EventTarget = document.body) => {
  const event = new KeyboardEvent('keydown', { key, keyCode, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

const handlers = () => ({ onBack: vi.fn(), onMenu: vi.fn(), onMedia: vi.fn() })

afterEach(() => { document.body.innerHTML = '' })

describe('useRemote', () => {
  it('Voltar sem nada aberto vai para a TV decidir (sair ou parar)', () => {
    const h = handlers()
    renderHook(() => useRemote(h))
    const event = press('XF86Back', 10009)
    expect(h.onBack).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('Voltar com um menu da página aberto fecha o menu com Escape, e não pergunta nada', () => {
    const h = handlers()
    renderHook(() => useRemote(h))
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const item = document.createElement('button')
    menu.append(item)
    document.body.append(menu)
    item.focus()
    const escapes: string[] = []
    item.addEventListener('keydown', (event) => escapes.push(event.key))
    press('GoBack', 461, item)
    expect(escapes).toContain('Escape')
    expect(h.onBack).not.toHaveBeenCalled()
  })

  it('Escape de verdade num menu aberto segue para o menu fechar sozinho', () => {
    const h = handlers()
    renderHook(() => useRemote(h))
    const menu = document.createElement('div')
    menu.setAttribute('role', 'dialog')
    document.body.append(menu)
    const event = press('Escape', 27)
    expect(event.defaultPrevented).toBe(false)
    expect(h.onBack).not.toHaveBeenCalled()
  })

  it('os painéis da própria TV fecham pelo Voltar dela', () => {
    const h = handlers()
    renderHook(() => useRemote(h))
    const panel = document.createElement('div')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('data-tv-overlay', '')
    document.body.append(panel)
    press('Escape', 27)
    expect(h.onBack).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['MediaPlayPause', 10252, 'playPause'],
    ['MediaPlay', 415, 'play'],
    ['MediaPause', 19, 'pause'],
    ['MediaFastForward', 417, 'forward'],
    ['MediaRewind', 412, 'rewind'],
  ])('%s vira mídia', (key, code, action) => {
    const h = handlers()
    renderHook(() => useRemote(h))
    press(key, code)
    expect(h.onMedia).toHaveBeenCalledWith(action)
  })

  it('a tecla vermelha abre o menu da TV', () => {
    const h = handlers()
    renderHook(() => useRemote(h))
    press('ColorF0Red', 403)
    expect(h.onMenu).toHaveBeenCalled()
  })

  it('as setas andam pelo foco e não chegam ao player', () => {
    const h = handlers()
    renderHook(() => useRemote(h))
    const button = document.createElement('button')
    button.getBoundingClientRect = () => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 10, x: 0, y: 0, toJSON: () => null })
    document.body.append(button)
    const event = press('ArrowDown', 40)
    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(button)
  })

  it('num controle deslizante, esquerda e direita mexem nele', () => {
    const h = handlers()
    renderHook(() => useRemote(h))
    const slider = document.createElement('input')
    slider.type = 'range'
    document.body.append(slider)
    slider.focus()
    expect(press('ArrowLeft', 37, slider).defaultPrevented).toBe(false)
  })

  it('para de ouvir quando sai da tela', () => {
    const h = handlers()
    const { unmount } = renderHook(() => useRemote(h))
    unmount()
    press('XF86Back', 10009)
    expect(h.onBack).not.toHaveBeenCalled()
  })
})
