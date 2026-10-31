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

  it('on an Android phone, downloads the apk with a beta mark once one is published', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([
      { tag_name: 'android', name: 'Android 0.1.0 beta', draft: false, prerelease: true, assets: [{ name: 'juntos.apk', browser_download_url: 'https://github.com/x/juntos.apk' }] },
    ])))
    render(<DownloadApp />)
    const link = await screen.findByRole('link', { name: 'Baixar o app' })
    expect(link.getAttribute('href')).toBe('https://github.com/x/juntos.apk')
    expect(link.textContent).toContain('beta')
    vi.unstubAllGlobals()
  })

  it('on an iPhone, offers nothing', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile')
    const { container } = render(<DownloadApp />)
    expect(container.innerHTML).toBe('')
  })

  it('is gone inside the app itself', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    ;(window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = { invoke: vi.fn() }
    const { container } = render(<DownloadApp />)
    expect(container.innerHTML).toBe('')
  })
})
