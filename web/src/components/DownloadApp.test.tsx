import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DownloadApp, DownloadAppHost, openDownloadApp } from './DownloadApp'

describe('DownloadApp', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__
  })

  it('offers the app in a desktop browser', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    render(<DownloadApp />)
    expect(screen.getByRole('button')).toBeTruthy()
  })

  it('opens from anywhere on the page, like a locked YouTube pick does', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })))
    render(<DownloadAppHost />)
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => openDownloadApp())
    expect(await screen.findByRole('dialog')).toBeTruthy()
    vi.unstubAllGlobals()
  })

  it('is gone inside the app itself', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: vi.fn() }
    const { container } = render(<DownloadApp />)
    expect(container.innerHTML).toBe('')
  })
})
