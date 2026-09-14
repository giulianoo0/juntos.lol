import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { translate, type Translator } from '../i18n/useT'
import { DelayControl } from './DelayControl'

const t = Object.assign((key: string) => translate('pt-BR', key), {
  language: 'pt-BR' as const,
  setLanguage: vi.fn(),
}) as Translator

describe('DelayControl', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('steps a quarter second either way on a click', () => {
    const onChange = vi.fn()
    render(<DelayControl valueMs={0} onChange={onChange} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: /mais|later/i }))
    expect(onChange).toHaveBeenLastCalledWith(250)
    fireEvent.click(screen.getByRole('button', { name: /menos|sooner/i }))
    expect(onChange).toHaveBeenLastCalledWith(-250)
  })

  it('keeps stepping while the button is held', () => {
    const onChange = vi.fn()
    render(<DelayControl valueMs={0} onChange={onChange} t={t} />)
    const plus = screen.getByRole('button', { name: /mais|later/i })
    fireEvent.pointerDown(plus)
    act(() => { vi.advanceTimersByTime(1000) })
    const calls = onChange.mock.calls.length
    expect(calls).toBeGreaterThanOrEqual(4)
    expect(onChange).toHaveBeenLastCalledWith(calls * 250)
    fireEvent.pointerUp(plus)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(onChange.mock.calls.length).toBe(calls)
  })

  it('turns the number into a field on click and takes the typed seconds', () => {
    const onChange = vi.fn()
    render(<DelayControl valueMs={250} onChange={onChange} t={t} />)
    expect(screen.getByText('+0,25 s')).toBeInTheDocument()
    fireEvent.click(screen.getByText('+0,25 s'))
    const field = screen.getByRole('textbox')
    fireEvent.change(field, { target: { value: '1,5' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(onChange).toHaveBeenLastCalledWith(1500)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('drops the typed value on escape and on nonsense', () => {
    const onChange = vi.fn()
    render(<DelayControl valueMs={0} onChange={onChange} t={t} />)
    fireEvent.click(screen.getByText('0,00 s'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'abc' } })
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('0,00 s'))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })
})
