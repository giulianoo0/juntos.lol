import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Segmented } from './Segmented'

const options = [{ value: 'chat', label: 'Chat' }, { value: 'people', label: 'Pessoas' }] as const

describe('Segmented', () => {
  it('marks the chosen segment and reports a click on another', () => {
    const onChange = vi.fn()
    render(<Segmented label="Painel" options={options} value="chat" onChange={onChange} />)
    expect(screen.getByRole('radio', { name: 'Chat' })).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByRole('radio', { name: 'Pessoas' }))
    expect(onChange).toHaveBeenCalledWith('people')
  })

  it('moves the choice with the arrow keys, as a radio group', () => {
    const onChange = vi.fn()
    render(<Segmented label="Painel" options={options} value="chat" onChange={onChange} />)
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Chat' }), { key: 'ArrowRight' })
    expect(onChange).toHaveBeenCalledWith('people')
  })

  it('keeps only the chosen segment in the tab order', () => {
    render(<Segmented label="Painel" options={options} value="people" onChange={() => undefined} />)
    expect(screen.getByRole('radio', { name: 'Chat' })).toHaveAttribute('tabindex', '-1')
    expect(screen.getByRole('radio', { name: 'Pessoas' })).toHaveAttribute('tabindex', '0')
  })
})
