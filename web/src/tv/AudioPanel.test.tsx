import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AudioPanel } from './AudioPanel'

const people = [{ id: 'm1', name: 'Ana' }, { id: 'm2', name: 'Giu', avatar: 'fox.bowtie' }]

describe('AudioPanel', () => {
  it('mostra a mídia e cada pessoa, com o dono começando em 0', () => {
    render(<AudioPanel mix={{ media: 0.8, people: {} }} people={people} ownerId="m2" onChange={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('slider', { name: 'Mídia' })).toHaveValue('0.8')
    expect(screen.getByRole('slider', { name: 'Volume de Ana' })).toHaveValue('1')
    expect(screen.getByRole('slider', { name: 'Volume de Giu' })).toHaveValue('0')
  })

  it('mexer numa pessoa muda só ela no mix', () => {
    const onChange = vi.fn()
    render(<AudioPanel mix={{ media: 1, people: { m2: 0 } }} people={people} ownerId="m2" onChange={onChange} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('slider', { name: 'Volume de Ana' }), { target: { value: '0.4' } })
    expect(onChange).toHaveBeenCalledWith({ media: 1, people: { m2: 0, m1: 0.4 } })
  })

  it('mexer na mídia muda a mídia', () => {
    const onChange = vi.fn()
    render(<AudioPanel mix={{ media: 1, people: {} }} people={people} ownerId={null} onChange={onChange} onClose={vi.fn()} />)
    fireEvent.change(screen.getByRole('slider', { name: 'Mídia' }), { target: { value: '0.3' } })
    expect(onChange).toHaveBeenCalledWith({ media: 0.3, people: {} })
  })

  it('"Só a mídia" cala todo mundo', () => {
    const onChange = vi.fn()
    render(<AudioPanel mix={{ media: 0.5, people: { m1: 0.7 } }} people={people} ownerId="m2" onChange={onChange} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Só a mídia' }))
    expect(onChange).toHaveBeenCalledWith({ media: 0.5, people: { m1: 0, m2: 0 } })
  })

  it('abre com o foco na mídia, para o controle já mexer nela', () => {
    render(<AudioPanel mix={{ media: 1, people: {} }} people={people} ownerId={null} onChange={vi.fn()} onClose={vi.fn()} />)
    expect(screen.getByRole('slider', { name: 'Mídia' })).toHaveFocus()
  })
})
