import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JLocalScreenModal, JLocalScreenPanel, appAvatarHue, appAvatarLetter } from './JLocalScreen'
import { startJLocalScreenFeed } from '../jlocal/screenFeed'
import { getCachedJLocalCapabilities, refreshJLocalCapabilities, resetJLocalCapabilitiesForTests } from '../jlocal/capabilities'
import { connectJLocal, getJLocalSnapshot, resetJLocalForTests } from '../jlocal/status'
vi.mock('../jlocal/screenFeed', () => ({ startJLocalScreenFeed: vi.fn() }))
describe('app avatars', () => {
  it('uses the owning app initial, falling back to the title', () => {
    expect(appAvatarLetter('#anuncios | juntos.lol - Discord', 'Discord')).toBe('D')
    expect(appAvatarLetter('Window 7', '')).toBe('W')
  })

  it('hashes deterministically into a hue', () => {
    expect(appAvatarHue('Discord')).toBe(appAvatarHue('Discord'))
    expect(appAvatarHue('Discord')).toBeGreaterThanOrEqual(0)
    expect(appAvatarHue('Discord')).toBeLessThan(360)
  })
})

const CAPS = {
  name: 'jlocal',
  version: 'v0.0.1',
  capabilities: {
    screen: { available: false, capture: true, maxWidth: 3840, maxHeight: 2160, maxFps: 60 },
    audio: { appList: false },
    torrent: { available: false },
  },
}

// Real app shape: numeric ids inside the {displays} / {windows} envelopes.
const DISPLAYS = { displays: [
  { id: 1, name: 'Main', width: 2560, height: 1440 },
  { id: 2, name: 'Side', width: 1920, height: 1080 },
] }

const WINDOWS = { windows: [
  { id: 7, name: 'Figma — Design', app: 'Figma', icon: 'data:image/png;base64,iVBORw0KGgo=', width: 1728, height: 1117 },
  { id: 9, name: 'Terminal', app: 'Ghostty', icon: '', width: 1440, height: 900 },
] }

/** Routes /health and /capabilities to the gate; the capture lists answer from overrides. */
function stubFetch(displays: unknown, windows: unknown = WINDOWS): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const target = String(url)
    if (target.endsWith('/health')) return { ok: true, json: async () => ({ name: 'jlocal', version: 'v0.0.1' }) }
    if (target.endsWith('/capabilities')) return { ok: true, status: 200, json: async () => CAPS }
    if (target.endsWith('/capture/displays')) return { ok: true, status: 200, json: async () => displays }
    if (target.endsWith('/capture/windows')) return { ok: true, status: 200, json: async () => windows }
    return { ok: true, json: async () => ({}) }
  }))
}

async function openWithCaps(): Promise<void> {
  connectJLocal()
  await waitFor(() => expect(getJLocalSnapshot().connected).toBe(true))
  refreshJLocalCapabilities()
  await waitFor(() => expect(getCachedJLocalCapabilities()).not.toBeNull())
}

function windowsCalls(): number {
  return vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/capture/windows')).length
}

describe('jlocal screen modal displays', () => {
  beforeEach(() => {
    resetJLocalForTests()
    resetJLocalCapabilitiesForTests()
    localStorage.clear()
    vi.mocked(startJLocalScreenFeed).mockReset()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('lists the app displays as cards and confirms with the picked display and quality', async () => {
    stubFetch(DISPLAYS)
    await openWithCaps()
    const stream = {} as MediaStream
    const stop = vi.fn()
    vi.mocked(startJLocalScreenFeed).mockResolvedValue({ stream, stop })
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(<JLocalScreenModal open onOpenChange={onOpenChange} onUseBrowser={() => undefined} onConfirm={onConfirm} />)

    expect(await screen.findByRole('radio', { name: /Main/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Side/ })).toBeInTheDocument()
    expect(screen.getByText('2560×1440')).toBeInTheDocument()
    // Resolution defaults to the ceiling: presets upscale Discord-style.
    expect(screen.getByRole('button', { name: '4K' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: /Side/ }))
    fireEvent.click(screen.getByRole('button', { name: /sharing|compartilhar/i }))
    expect(vi.mocked(startJLocalScreenFeed)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(startJLocalScreenFeed)).toHaveBeenCalledWith(
      { kind: 'display', id: '2' },
      // No audio.capture in these caps: the toggle stays hidden, audio off.
      { width: 3840, height: 2160, fps: 30, audio: false },
    )
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(stream, stop))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('fetches the windows once and confirms with the picked window', async () => {
    stubFetch(DISPLAYS)
    await openWithCaps()
    const stream = {} as MediaStream
    const stop = vi.fn()
    vi.mocked(startJLocalScreenFeed).mockResolvedValue({ stream, stop })
    const onConfirm = vi.fn()
    render(<JLocalScreenModal open onOpenChange={() => undefined} onUseBrowser={() => undefined} onConfirm={onConfirm} />)
    expect(await screen.findByRole('radio', { name: /Main/ })).toBeInTheDocument()
    expect(windowsCalls()).toBe(0)

    fireEvent.click(screen.getByRole('tab', { name: /^Apps$/i }))
    expect(await screen.findByRole('radio', { name: /Figma/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /Terminal/ })).toBeInTheDocument()
    // Real icon for Figma, letter avatar for icon-less Terminal.
    const figma = screen.getByRole('radio', { name: /Figma/ })
    expect(figma.querySelector('img.jscreen-app-icon')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
    expect(screen.getByRole('radio', { name: /Terminal/ }).querySelector('.jscreen-app-icon')?.textContent).toBe('G')
    // Back and forth: the list loads on first open only.
    fireEvent.click(screen.getByRole('tab', { name: /Displays|Telas/i }))
    fireEvent.click(screen.getByRole('tab', { name: /^Apps$/i }))
    expect(windowsCalls()).toBe(1)

    fireEvent.click(screen.getByRole('radio', { name: /Terminal/ }))
    fireEvent.click(screen.getByRole('button', { name: /sharing|compartilhar/i }))
    expect(vi.mocked(startJLocalScreenFeed)).toHaveBeenCalledWith(
      { kind: 'window', id: '9' },
      { width: 3840, height: 2160, fps: 30, audio: false },
    )
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(stream, stop))
  })

  it('offers the full frame-rate range in the fps dropdown', async () => {
    stubFetch(DISPLAYS)
    await openWithCaps()
    render(<JLocalScreenModal open onOpenChange={() => undefined} onUseBrowser={() => undefined} onConfirm={() => undefined} />)
    expect(await screen.findByRole('radio', { name: /Main/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '30 fps' }))
    for (const rate of ['24 fps', '30 fps', '48 fps', '60 fps']) {
      expect(await screen.findByRole('option', { name: rate })).toBeInTheDocument()
    }
  })

  it('shows a permission hint and the browser fallback when the feed fails to start', async () => {
    stubFetch(DISPLAYS)
    await openWithCaps()
    vi.mocked(startJLocalScreenFeed).mockRejectedValue(new Error('jlocal-capture-permission'))
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    const onUseBrowser = vi.fn()
    render(<JLocalScreenModal open onOpenChange={onOpenChange} onUseBrowser={onUseBrowser} onConfirm={onConfirm} />)

    expect(await screen.findByRole('radio', { name: /Main/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /sharing|compartilhar/i }))

    // Inline error, nothing thrown: the stream never reaches the parent and
    // the modal stays open with the browser fallback one click away.
    expect(await screen.findByText(/Screen Recording|Gravação de Tela/i)).toBeInTheDocument()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
    const fallback = screen.getByRole('button', { name: /navegador|browser/i })
    fireEvent.click(fallback)
    expect(onUseBrowser).toHaveBeenCalledTimes(1)
  })
  it('shows the server reason verbatim when the request is refused', async () => {
    stubFetch(DISPLAYS)
    await openWithCaps()
    vi.mocked(startJLocalScreenFeed).mockRejectedValue(
      new Error('jlocal-capture-failed: requested 2560x1440 exceeds display 1 size 1512x982'),
    )
    render(<JLocalScreenModal open onOpenChange={() => undefined} onUseBrowser={() => undefined} onConfirm={() => undefined} />)

    expect(await screen.findByRole('radio', { name: /Main/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /sharing|compartilhar/i }))
    expect(await screen.findByText(/requested 2560x1440 exceeds display 1 size 1512x982/)).toBeInTheDocument()
  })
})

describe('jlocal screen panel', () => {
  beforeEach(() => {
    resetJLocalForTests()
    resetJLocalCapabilitiesForTests()
    localStorage.clear()
    vi.mocked(startJLocalScreenFeed).mockReset()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('renders no Dialog, title, guide, or close affordance', async () => {
    stubFetch(DISPLAYS)
    await openWithCaps()
    render(<JLocalScreenPanel onConfirm={() => undefined} onUseBrowser={() => undefined} onExit={() => undefined} />)

    expect(await screen.findByRole('radio', { name: /Main/ })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.queryByText(/full quality|qualidade máxima/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/straight to the room|direto para a sala/i)).not.toBeInTheDocument()
  })

  it('selects a card by mouse click and enables confirm with that target', async () => {
    stubFetch(DISPLAYS)
    await openWithCaps()
    const stream = {} as MediaStream
    const stop = vi.fn()
    vi.mocked(startJLocalScreenFeed).mockResolvedValue({ stream, stop })
    const onConfirm = vi.fn()
    render(<JLocalScreenPanel onConfirm={onConfirm} onUseBrowser={() => undefined} onExit={() => undefined} />)

    const main = await screen.findByRole('radio', { name: /Main/ })
    const side = screen.getByRole('radio', { name: /Side/ })
    // First display is auto-selected; clicking the other card moves it.
    expect(main).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(side)
    expect(side).toHaveAttribute('aria-checked', 'true')
    expect(main).toHaveAttribute('aria-checked', 'false')

    const confirm = screen.getByRole('button', { name: /sharing|compartilhar/i })
    expect(confirm).toBeEnabled()
    // Browser fallback (ghost) comes first, confirm (primary) last.
    const fallback = screen.getByRole('button', { name: /navegador|browser/i })
    expect(fallback.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(confirm)
    expect(vi.mocked(startJLocalScreenFeed)).toHaveBeenCalledWith(
      { kind: 'display', id: '2' },
      { width: 3840, height: 2160, fps: 30, audio: false },
    )
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(stream, stop))
  })
  it('shows a sound toggle with audio caps and passes it to the feed', async () => {
    const audioCaps = {
      ...CAPS,
      capabilities: { ...CAPS.capabilities, audio: { appList: false, capture: true } },
    }
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const target = String(url)
      if (target.endsWith('/health')) return { ok: true, json: async () => ({ name: 'jlocal', version: 'v0.0.1' }) }
      if (target.endsWith('/capabilities')) return { ok: true, status: 200, json: async () => audioCaps }
      if (target.endsWith('/capture/displays')) return { ok: true, status: 200, json: async () => DISPLAYS }
      if (target.endsWith('/capture/windows')) return { ok: true, status: 200, json: async () => WINDOWS }
      return { ok: true, json: async () => ({}) }
    }))
    await openWithCaps()
    const stream = { getAudioTracks: () => [] } as unknown as MediaStream
    vi.mocked(startJLocalScreenFeed).mockResolvedValue({ stream, stop: vi.fn() })
    render(<JLocalScreenPanel onConfirm={() => undefined} onUseBrowser={() => undefined} onExit={() => undefined} />)
    expect(await screen.findByRole('radio', { name: /Main/ })).toBeInTheDocument()
    // Default on: confirm asks the feed for system audio.
    const toggle = screen.getByRole('checkbox', { name: /system audio|áudio do sistema/i })
    expect(toggle).toBeChecked()
    fireEvent.click(screen.getByRole('button', { name: /sharing|compartilhar/i }))
    await waitFor(() => expect(vi.mocked(startJLocalScreenFeed)).toHaveBeenCalledWith(
      { kind: 'display', id: '1' },
      expect.objectContaining({ audio: true }),
    ))
    // Flipping off persists mode none and the next confirm goes video-only.
    fireEvent.click(toggle)
    expect(toggle).not.toBeChecked()
    await waitFor(() => expect(
      vi.mocked(fetch).mock.calls.some(([url, init]) =>
        String(url).endsWith('/audio/mode') && String((init as RequestInit)?.body).includes('"none"'),
      ),
    ).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: /sharing|compartilhar/i }))
    await waitFor(() => expect(vi.mocked(startJLocalScreenFeed)).toHaveBeenLastCalledWith(
      { kind: 'display', id: '1' },
      expect.objectContaining({ audio: false }),
    ))
  })
  it('selects an fps option on click and feeds it to confirm', async () => {
    stubFetch(DISPLAYS)
    await openWithCaps()
    const stream = {} as MediaStream
    const stop = vi.fn()
    vi.mocked(startJLocalScreenFeed).mockResolvedValue({ stream, stop })
    const onConfirm = vi.fn()
    render(<JLocalScreenPanel onConfirm={onConfirm} onUseBrowser={() => undefined} onExit={() => undefined} />)
    expect(await screen.findByRole('radio', { name: /Main/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '30 fps' }))
    const option = await screen.findByRole('option', { name: '60 fps' })
    fireEvent.click(option.querySelector('button') ?? option)
    // The trigger now shows 60 fps (exited menu nodes linger under jsdom,
    // so match any of the same-named buttons for the assertion).
    expect(screen.getAllByRole('button', { name: '60 fps' }).length).toBeGreaterThanOrEqual(1)
    fireEvent.click(screen.getByRole('button', { name: /sharing|compartilhar/i }))
    expect(vi.mocked(startJLocalScreenFeed)).toHaveBeenLastCalledWith(
      { kind: 'display', id: '1' },
      expect.objectContaining({ fps: 60 }),
    )
  })
  it('closes an open quality dropdown on outside pointer press', async () => {
    stubFetch(DISPLAYS)
    await openWithCaps()
    render(<JLocalScreenPanel onConfirm={() => undefined} onUseBrowser={() => undefined} onExit={() => undefined} />)
    expect(await screen.findByRole('radio', { name: /Main/ })).toBeInTheDocument()

    const trigger = screen.getByRole('button', { name: '30 fps' })
    fireEvent.click(trigger)
    expect(await screen.findByRole('option', { name: '60 fps' })).toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    // Closed is the trigger's expanded state: the exit choreography keeps
    // nodes mounted briefly in a real browser and forever under jsdom, where
    // motion's animation clock never advances, so removal is not asserted.
    fireEvent.pointerDown(document.body)
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'))
  })

  it('closes an open quality dropdown on Escape', async () => {
    stubFetch(DISPLAYS)
    await openWithCaps()
    render(<JLocalScreenPanel onConfirm={() => undefined} onUseBrowser={() => undefined} onExit={() => undefined} />)
    expect(await screen.findByRole('radio', { name: /Main/ })).toBeInTheDocument()

    const trigger = screen.getByRole('button', { name: '30 fps' })
    fireEvent.click(trigger)
    expect(await screen.findByRole('option', { name: '60 fps' })).toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'true')

    fireEvent.keyDown(document.body, { key: 'Escape' })
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'))
  })

  it('preloads display snapshots offscreen and swaps without a gap at preview width', async () => {
    const preloads: Array<{ url: string; fireLoad: () => void; fireError: () => void }> = []
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      currentSrc = ''
      set src(url: string) {
        this.currentSrc = url
        preloads.push({ url, fireLoad: () => this.onload?.(), fireError: () => this.onerror?.() })
      }
      get src() { return this.currentSrc }
    })
    stubFetch(DISPLAYS)
    await openWithCaps()
    render(<JLocalScreenPanel onConfirm={() => undefined} onUseBrowser={() => undefined} onExit={() => undefined} />)
    expect(await screen.findByRole('radio', { name: /Main/ })).toBeInTheDocument()

    // First poll fires on mount: preview width, no visible frame yet.
    expect(preloads.length).toBeGreaterThanOrEqual(1)
    expect(preloads[0]?.url).toContain('display_id=1')
    expect(preloads[0]?.url).toContain('width=640')
    expect(document.querySelector('.jscreen-preview')).toBeNull()
    expect(document.querySelector('.jscreen-preview-shimmer')).not.toBeNull()
    // Frame lands offscreen → visible img appears with the preloaded src and
    // the shimmer leaves together: never a gap, never a void.
    preloads[0]?.fireLoad()
    await waitFor(() => expect(document.querySelector('.jscreen-preview')?.getAttribute('src')).toBe(preloads[0]?.url))
    expect(document.querySelector('.jscreen-preview-shimmer')).toBeNull()
    // Later polls preload without touching the visible frame until loaded.
    await waitFor(() => expect(preloads.length).toBeGreaterThanOrEqual(3), { timeout: 3000 })
    expect(document.querySelector('.jscreen-preview')?.getAttribute('src')).toBe(preloads[0]?.url)
    preloads[2]?.fireLoad()
    await waitFor(() => expect(document.querySelector('.jscreen-preview')?.getAttribute('src')).toBe(preloads[2]?.url))
  })

  it('previews the picked window on the Apps tab', async () => {
    const preloads: Array<{ url: string; fireLoad: () => void }> = []
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      currentSrc = ''
      set src(url: string) {
        this.currentSrc = url
        preloads.push({ url, fireLoad: () => this.onload?.() })
      }
      get src() { return this.currentSrc }
    })
    stubFetch(DISPLAYS)
    await openWithCaps()
    render(<JLocalScreenPanel onConfirm={() => undefined} onUseBrowser={() => undefined} onExit={() => undefined} />)
    expect(await screen.findByRole('radio', { name: /Main/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: /^Apps$/i }))
    expect(await screen.findByRole('radio', { name: /Terminal/ })).toBeInTheDocument()
    // First window is auto-selected; picking another remounts the preview.
    expect(preloads.some((preload) => preload.url.includes('window_id=7'))).toBe(true)
    fireEvent.click(screen.getByRole('radio', { name: /Terminal/ }))
    const picked = preloads.find((preload) => preload.url.includes('window_id=9'))
    expect(picked?.url).toContain('width=640')
    picked?.fireLoad()
    await waitFor(() => expect(document.querySelector('.jscreen-preview')?.getAttribute('src')).toBe(picked?.url))
  })

  it('shows the permission hint in the pane on 503', async () => {
    const preloads: Array<{ fireError: () => void }> = []
    vi.stubGlobal('Image', class {
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      currentSrc = ''
      set src(_url: string) {
        this.currentSrc = _url
        preloads.push({ fireError: () => this.onerror?.() })
      }
      get src() { return this.currentSrc }
    })
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const target = String(url)
      if (target.endsWith('/health')) return { ok: true, json: async () => ({ name: 'jlocal', version: 'v0.0.1' }) }
      if (target.endsWith('/capabilities')) return { ok: true, status: 200, json: async () => CAPS }
      if (target.endsWith('/capture/displays')) return { ok: true, status: 200, json: async () => DISPLAYS }
      if (target.includes('/capture/snapshot')) return { ok: false, status: 503 }
      return { ok: true, json: async () => ({}) }
    }))
    await openWithCaps()
    render(<JLocalScreenPanel onConfirm={() => undefined} onUseBrowser={() => undefined} onExit={() => undefined} />)
    expect(await screen.findByRole('radio', { name: /Main/ })).toBeInTheDocument()

    expect(preloads.length).toBeGreaterThanOrEqual(1)
    preloads[0]?.fireError()
    expect(await screen.findByText(/Screen Recording|Gravação de Tela/i)).toBeInTheDocument()
    expect(document.querySelector('.jscreen-preview-pane img')).toBeNull()
  })
})
