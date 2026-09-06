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

const DISPLAYS = [
  { id: '1', name: 'Main', width: 2560, height: 1440 },
  { id: '2', name: 'Side', width: 1920, height: 1080 },
]

/** Routes /health and /capabilities to the gate; the displays list answers from overrides. */
function stubFetch(displays: unknown, displaysOk = true): void {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const target = String(url)
    if (target.endsWith('/health')) return { ok: true, json: async () => ({ name: 'jlocal', version: 'v0.0.1' }) }
    if (target.endsWith('/capabilities')) return { ok: true, status: 200, json: async () => CAPS }
    if (target.endsWith('/capture/displays')) {
      return { ok: displaysOk, status: displaysOk ? 200 : 500, json: async () => displays }
    }
    return { ok: true, json: async () => ({}) }
  }))
}

async function openWithCaps(): Promise<void> {
  connectJLocal()
  await waitFor(() => expect(getJLocalSnapshot().connected).toBe(true))
  refreshJLocalCapabilities()
  await waitFor(() => expect(getCachedJLocalCapabilities()).not.toBeNull())
}

describe('jlocal screen modal displays', () => {
  beforeEach(() => {
    resetJLocalForTests()
    resetJLocalCapabilitiesForTests()
    localStorage.clear()
    vi.mocked(startJLocalScreenFeed).mockReset()
  })

  afterEach(() => vi.unstubAllGlobals())

  it('lists the app displays and confirms with the picked display and quality', async () => {
    stubFetch(DISPLAYS)
    await openWithCaps()
    const stream = {} as MediaStream
    const stop = vi.fn()
    vi.mocked(startJLocalScreenFeed).mockResolvedValue({ stream, stop })
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(<JLocalScreenModal open onOpenChange={onOpenChange} onUseBrowser={() => undefined} onConfirm={onConfirm} />)

    expect(await screen.findByText('Main · 2560×1440')).toBeInTheDocument()
    expect(screen.getByText('Side · 1920×1080')).toBeInTheDocument()
    // Video comes from the app; the browser path keeps system audio.
    expect(screen.getByText(/system audio|áudio do sistema/i)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText(/^(display|tela)$/i), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: /j local/i }))
    expect(vi.mocked(startJLocalScreenFeed)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(startJLocalScreenFeed)).toHaveBeenCalledWith('2', { width: 3840, height: 2160, fps: 30 })
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(stream, stop))
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows an inline error and the browser fallback when the feed fails to start', async () => {
    stubFetch(DISPLAYS)
    await openWithCaps()
    vi.mocked(startJLocalScreenFeed).mockRejectedValue(new Error('refused'))
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    const onUseBrowser = vi.fn()
    render(<JLocalScreenModal open onOpenChange={onOpenChange} onUseBrowser={onUseBrowser} onConfirm={onConfirm} />)

    expect(await screen.findByText('Main · 2560×1440')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /j local/i }))

    // Inline error, nothing thrown: the stream never reaches the parent and
    // the modal stays open with the browser fallback one click away.
    expect(await screen.findByText(/did not start|não começou/i)).toBeInTheDocument()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
    const fallback = screen.getByRole('button', { name: /navegador|browser/i })
    fireEvent.click(fallback)
    expect(onUseBrowser).toHaveBeenCalledTimes(1)
  })
})
