import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { caretToEndOnFocus } from './caret'

describe('caretToEndOnFocus', () => {
  beforeEach(() => { vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 1 }) })
  afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

  const field = (value: string) => {
    const input = document.createElement('input')
    input.value = value
    document.body.appendChild(input)
    input.focus()
    return input
  }

  it('collapses a whole-value selection to the end', () => {
    const input = field('giuli')
    input.setSelectionRange(0, 5)
    caretToEndOnFocus({ currentTarget: input } as never)
    expect([input.selectionStart, input.selectionEnd]).toEqual([5, 5])
  })

  it('leaves a partial selection and a caret alone', () => {
    const input = field('giuli')
    input.setSelectionRange(1, 3)
    caretToEndOnFocus({ currentTarget: input } as never)
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3])
    input.setSelectionRange(2, 2)
    caretToEndOnFocus({ currentTarget: input } as never)
    expect([input.selectionStart, input.selectionEnd]).toEqual([2, 2])
  })

  it('does nothing once focus has moved on', () => {
    const input = field('giuli')
    input.setSelectionRange(0, 5)
    input.blur()
    caretToEndOnFocus({ currentTarget: input } as never)
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5])
  })
})
