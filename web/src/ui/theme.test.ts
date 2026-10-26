import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { applyTheme, useTheme } from './theme'

describe('theme', () => {
  afterEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
  })

  it('follows the system until a theme is chosen', () => {
    applyTheme()
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('puts the chosen theme on the root and keeps it for the next visit', () => {
    const { result } = renderHook(() => useTheme())
    act(() => { result.current.setTheme('light') })
    expect(document.documentElement.dataset.theme).toBe('light')
    document.documentElement.removeAttribute('data-theme')
    applyTheme()
    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('goes back to the system', () => {
    const { result } = renderHook(() => useTheme())
    act(() => { result.current.setTheme('dark') })
    act(() => { result.current.setTheme('system') })
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
    expect(result.current.theme).toBe('system')
  })
})
