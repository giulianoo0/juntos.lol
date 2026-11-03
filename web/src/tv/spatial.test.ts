import { afterEach, describe, expect, it } from 'vitest'
import { moveFocus, nearestInDirection, type Box } from './spatial'

const box = (left: number, top: number, width = 100, height = 60): Box => ({ left, top, right: left + width, bottom: top + height })

describe('nearestInDirection', () => {
  const row = [box(0, 0), box(200, 0), box(400, 0)]

  it('anda para o vizinho mais perto na direção pedida', () => {
    expect(nearestInDirection(row[0], row, 'right')).toBe(1)
    expect(nearestInDirection(row[2], row, 'left')).toBe(1)
  })

  it('não sai da borda: nada além dela', () => {
    expect(nearestInDirection(row[2], row, 'right')).toBeNull()
    expect(nearestInDirection(row[0], row, 'up')).toBeNull()
  })

  it('prefere o que está alinhado ao que está perto mas na diagonal', () => {
    const from = box(0, 0)
    const candidates = [from, box(150, 90), box(0, 220)]
    expect(nearestInDirection(from, candidates, 'down')).toBe(2)
  })

  it('desce para o botão largo embaixo mesmo sem estar centrado', () => {
    const from = box(400, 0)
    const candidates = [from, box(0, 200, 600, 60)]
    expect(nearestInDirection(from, candidates, 'down')).toBe(1)
  })
})

describe('moveFocus', () => {
  afterEach(() => { document.body.innerHTML = '' })

  const place = (element: HTMLElement, rect: Box) => {
    element.getBoundingClientRect = () => ({ ...rect, x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top, toJSON: () => rect })
  }

  const buttons = (...names: string[]) => names.map((name) => {
    const button = document.createElement('button')
    button.textContent = name
    document.body.append(button)
    return button
  })

  it('leva o foco ao botão da direita', () => {
    const [a, b] = buttons('a', 'b')
    place(a, box(0, 0))
    place(b, box(200, 0))
    a.focus()
    expect(moveFocus('right')).toBe(true)
    expect(document.activeElement).toBe(b)
  })

  it('sem nada focado, a primeira seta foca o primeiro botão', () => {
    const [a, b] = buttons('a', 'b')
    place(a, box(0, 0))
    place(b, box(200, 0))
    moveFocus('down')
    expect(document.activeElement).toBe(a)
  })

  it('com um diálogo aberto, o foco não sai dele', () => {
    const [outside] = buttons('fora')
    place(outside, box(0, 200))
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const inside = document.createElement('button')
    const below = document.createElement('button')
    dialog.append(inside, below)
    document.body.append(dialog)
    place(inside, box(0, 0))
    place(below, box(0, 400))
    inside.focus()
    moveFocus('down')
    expect(document.activeElement).toBe(below)
  })

  it('pula o que está desativado ou dentro de inert', () => {
    const [a, off, b] = buttons('a', 'off', 'b')
    off.disabled = true
    const hidden = document.createElement('div')
    hidden.setAttribute('inert', '')
    const ghost = document.createElement('button')
    hidden.append(ghost)
    document.body.append(hidden)
    place(a, box(0, 0))
    place(off, box(150, 0))
    place(ghost, box(160, 0))
    place(b, box(400, 0))
    a.focus()
    moveFocus('right')
    expect(document.activeElement).toBe(b)
  })
})
