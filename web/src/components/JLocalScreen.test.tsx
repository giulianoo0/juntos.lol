import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JLocalScreenModal } from './JLocalScreen'
import { startJLocalScreenFeed } from '../jlocal/screenFeed'
import { getCachedJLocalCapabilities, refreshJLocalCapabilities, resetJLocalCapabilitiesForTests } from '../jlocal/capabilities'
import { connectJLocal, getJLocalSnapshot, resetJLocalForTests } from '../jlocal/status'
vi.mock('../jlocal/screenFeed', () => ({ startJLocalScreenFeed: vi.fn() }))

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
  { id: 7, name: 'Figma — Design', width: 1728, height: 1117 },
  { id: 9, name: 'Terminal', width: 1440, height: 900 },
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
    // Quality dropdowns sit below the cards; 4K is the ceiling here.
    expect(screen.getByRole('button', { name: '4K' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('radio', { name: /Side/ }))
    fireEvent.click(screen.getByRole('button', { name: /sharing|compartilhar/i }))
    expect(vi.mocked(startJLocalScreenFeed)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(startJLocalScreenFeed)).toHaveBeenCalledWith(
      { kind: 'display', id: '2' },
      { width: 3840, height: 2160, fps: 30 },
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
    // Back and forth: the list loads on first open only.
    fireEvent.click(screen.getByRole('tab', { name: /Displays|Telas/i }))
    fireEvent.click(screen.getByRole('tab', { name: /^Apps$/i }))
    expect(windowsCalls()).toBe(1)

    fireEvent.click(screen.getByRole('radio', { name: /Terminal/ }))
    fireEvent.click(screen.getByRole('button', { name: /sharing|compartilhar/i }))
    expect(vi.mocked(startJLocalScreenFeed)).toHaveBeenCalledWith(
      { kind: 'window', id: '9' },
      { width: 3840, height: 2160, fps: 30 },
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
    vi.mocked(startJLocalScreenFeed).mockRejectedValue(new Error('refused'))
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
})
