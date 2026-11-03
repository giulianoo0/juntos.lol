import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installPointer } from './pointer'

let uninstall: () => void

beforeEach(() => { uninstall = installPointer() })
afterEach(() => {
  uninstall()
  document.body.innerHTML = ''
  delete document.documentElement.dataset.pointer
})

const move = (target: Element, x: number, y: number) => target.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }))

describe('installPointer', () => {
  it('o ponteiro mexendo esconde o foco das setas, e uma tecla o traz de volta', () => {
    move(document.body, 10, 10)
    expect(document.documentElement.dataset.pointer).toBe('')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    expect(document.documentElement.dataset.pointer).toBeUndefined()
  })

  it('passar o ponteiro sobre um botão o foca', () => {
    const button = document.createElement('button')
    const icon = document.createElement('span')
    button.append(icon)
    document.body.append(button)
    move(icon, 5, 5)
    expect(document.activeElement).toBe(button)
  })

  it('o OK com o ponteiro na tela não aperta o botão duas vezes (webOS manda Enter e clique)', () => {
    const button = document.createElement('button')
    const clicked = vi.fn()
    button.addEventListener('click', clicked)
    document.body.append(button)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13 }))
    button.click()
    button.click()
    expect(clicked).toHaveBeenCalledTimes(1)
  })
})
